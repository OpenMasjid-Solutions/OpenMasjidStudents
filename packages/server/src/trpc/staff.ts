// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Staff user management (CLAUDE.md §12): admin creates staff accounts with a temporary
 * password (forced change on first login), can change a colleague's role, disable them
 * (revokes live sessions on the next request via getSession's status re-check) and reset
 * passwords. Admin-only; never returns password hashes; audited.
 *
 * A role change needs no session surgery: `getSession` re-reads the backing user on EVERY
 * request and returns the LIVE role, never the copy frozen on the session row
 * (auth/sessions.ts) — so a demotion bites immediately, including mid-session.
 *
 * Two things this deliberately refuses, because both are one-click ways to brick an install:
 *   - removing the LAST active admin (by demotion or by disabling) — but ONLY on a standalone install.
 *     Installed through OpenMasjidOS there is always another door in (SSO on the LAN mints an admin
 *     session with no app account at all), so the rule protects nothing there and only stops an admin
 *     tidying up. See `hasPlatformAdminDoor` (0.48.0).
 *   - changing your OWN role. It would drop your admin rights mid-session, and there is no
 *     legitimate reason to do it to yourself rather than from another admin account.
 *
 * `parent` is not a staff role and is not offered here: a parent's authority comes from their
 * `guardian_users` link, so minting one from this screen would create an account that can see
 * nothing — and converting a parent to admin would be a privilege-escalation path.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { router, adminProcedure, auditActor } from './trpc';
import { db } from '../db';
import { users, guardianUsers, userSchools } from '../db/schema';
import { rid } from '../db/ids';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../auth/passwords';
import { fabricConfigured } from '../config';
import { audit } from '../audit';
import { setUserSchools } from '../schools';

const USERNAME = z.string().trim().min(1).max(64);
const TEMP_PW = z.string().min(MIN_PASSWORD_LENGTH).max(200);
/** The roles this screen may hand out. Not `parent` — see the note above. */
const STAFF_ROLE = z.enum(['admin', 'finance']);
const now = () => new Date();

/** How many active admins exist besides `exceptUserId`. Guards the lockout cases. */
function otherActiveAdmins(exceptUserId: string): number {
  return db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.status, 'active'), ne(users.id, exceptUserId)))
    .all().length;
}

/**
 * Is there a way back in that does NOT depend on a local admin account? (0.48.0)
 *
 * The "you cannot remove the last admin" rule exists for one reason: there would be nobody able to reach
 * Settings again, and admin sign-in is LAN-only (§12.4), so there is no remote way back. That reasoning
 * is sound — but only on a STANDALONE install.
 *
 * When this app is installed through OpenMasjidOS there is always another door: the platform's own admin
 * opens the app from its dashboard on the masjid network and the SSO fast-path mints an admin session
 * (§12), with no app account involved at all. On such an install the rule is not protecting anything; it
 * is just refusing to let an admin tidy up a staff account they no longer want. Which is exactly what
 * was reported.
 *
 * So the guard now asks whether a way back actually exists, rather than assuming it does not.
 */
function hasPlatformAdminDoor(): boolean {
  return fabricConfigured();
}

/** Why the last admin may not be removed, when they may not. Says what would break and what to do. */
const LAST_ADMIN_MESSAGE =
  'This is the only admin left, and this app is not connected to OpenMasjidOS — so removing it would leave no way to reach the admin screens. Make someone else an admin first.';

/** A staff row that is not secretly a parent account. */
function requireStaffUser(userId: string) {
  const u = db.select({ id: users.id, role: users.role, status: users.status, username: users.username }).from(users).where(eq(users.id, userId)).get();
  if (!u) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found.' });
  if (u.role === 'parent') throw new TRPCError({ code: 'FORBIDDEN', message: 'That is a parent account — manage it from the family’s record.' });
  // Belt and braces: a linked guardian means a portal account regardless of the role column.
  if (db.select({ userId: guardianUsers.userId }).from(guardianUsers).where(eq(guardianUsers.userId, userId)).get()) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'That account belongs to a parent — manage it from the family’s record.' });
  }
  return u;
}

export const staffRouter = router({
  /** Every STAFF account — admins as well as finance, so an admin can see and change who is what.
   *  Parent accounts are excluded by role; they belong to a family, not to this screen. */
  list: adminProcedure.query(() => {
    const rows = db
      .select({ id: users.id, username: users.username, displayName: users.displayName, role: users.role, status: users.status, mustChangePassword: users.mustChangePassword })
      .from(users)
      .where(inArray(users.role, ['admin', 'finance']))
      .orderBy(users.role, users.username)
      .all();
    // Which schools each account is limited to (0.47.0). An EMPTY list means all of them — see
    // schools/index.ts for why that default is the safe one — and the UI says "All schools" for it
    // rather than showing an empty set that reads like "none".
    const limits = new Map<string, string[]>();
    for (const r of db.select({ userId: userSchools.userId, schoolId: userSchools.schoolId }).from(userSchools).all()) {
      limits.set(r.userId, [...(limits.get(r.userId) ?? []), r.schoolId]);
    }
    return rows.map((u) => ({ ...u, schoolIds: limits.get(u.id) ?? [] }));
  }),

  /**
   * Limit an account to certain schools, or clear the limit by passing an empty list.
   *
   * This narrows a working view; it never widens authority. A finance account limited to one school
   * still sees exactly what finance sees, and an admin is still LAN-only (§12.4) — role is checked
   * first on every procedure, school second.
   *
   * Your own account is refused for the same reason as a self role change: locking yourself out of a
   * school mid-session is a mistake with no undo from where you would then be standing.
   */
  setSchools: adminProcedure.input(z.object({ userId: z.string(), schoolIds: z.array(z.string().trim().max(64)).max(100) })).mutation(({ ctx, input }) => {
    const u = requireStaffUser(input.userId);
    if (u.id === ctx.session?.userId) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'You can’t change your own school access — ask another admin to do it.' });
    }
    setUserSchools(u.id, input.schoolIds);
    audit(auditActor(ctx), 'staff.setSchools', { entity: 'user', entityId: u.id, detail: { count: input.schoolIds.length } });
    return { ok: true as const };
  }),

  create: adminProcedure
    .input(z.object({ username: USERNAME, displayName: z.string().trim().max(120).optional(), role: STAFF_ROLE, tempPassword: TEMP_PW }))
    .mutation(async ({ ctx, input }) => {
      if (db.select({ id: users.id }).from(users).where(eq(users.username, input.username)).get()) {
        throw new TRPCError({ code: 'CONFLICT', message: 'That username is already taken.' });
      }
      const id = rid('usr');
      const ts = now();
      db.insert(users)
        .values({ id, username: input.username, passwordHash: await hashPassword(input.tempPassword), role: input.role, status: 'active', displayName: input.displayName?.trim() || input.username, mustChangePassword: true, createdAt: ts, updatedAt: ts })
        .run();
      audit(auditActor(ctx), 'staff.create', { entity: 'user', entityId: id, detail: { role: input.role, username: input.username } });
      return { id };
    }),

  /**
   * Change a colleague between admin and finance.
   *
   * Takes effect at once — `getSession` reads the live role per request — so a demoted finance
   * manager loses the admin screens on their very next click, with no logout needed.
   */
  setRole: adminProcedure.input(z.object({ userId: z.string(), role: STAFF_ROLE })).mutation(({ ctx, input }) => {
    const u = requireStaffUser(input.userId);
    if (u.id === ctx.session?.userId) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'You can’t change your own role — ask another admin to do it.' });
    }
    if (u.role === input.role) return { ok: true as const };
    // Demoting the last admin would leave nobody able to reach settings, and admin sign-in is
    // LAN-only — UNLESS the platform can still let one in (see hasPlatformAdminDoor).
    if (u.role === 'admin' && input.role !== 'admin' && otherActiveAdmins(u.id) === 0 && !hasPlatformAdminDoor()) {
      throw new TRPCError({ code: 'CONFLICT', message: LAST_ADMIN_MESSAGE });
    }
    db.update(users).set({ role: input.role, updatedAt: now() }).where(eq(users.id, u.id)).run();
    audit(auditActor(ctx), 'staff.setRole', { entity: 'user', entityId: u.id, detail: { from: u.role, to: input.role } });
    return { ok: true as const };
  }),

  setStatus: adminProcedure.input(z.object({ userId: z.string(), status: z.enum(['active', 'disabled']) })).mutation(({ ctx, input }) => {
    const u = requireStaffUser(input.userId);
    if (u.id === ctx.session?.userId && input.status === 'disabled') {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'You can’t disable your own account.' });
    }
    // Admins used to be undisablable outright. Now that an admin can create other admins, the rule
    // that actually matters is narrower and stricter where it counts: never disable the LAST one.
    if (u.role === 'admin' && input.status === 'disabled' && otherActiveAdmins(u.id) === 0 && !hasPlatformAdminDoor()) {
      throw new TRPCError({ code: 'CONFLICT', message: LAST_ADMIN_MESSAGE });
    }
    db.update(users).set({ status: input.status, updatedAt: now() }).where(eq(users.id, u.id)).run();
    audit(auditActor(ctx), 'staff.setStatus', { entity: 'user', entityId: input.userId, detail: { status: input.status } });
    return { ok: true as const };
  }),

  resetPassword: adminProcedure.input(z.object({ userId: z.string(), tempPassword: TEMP_PW })).mutation(async ({ ctx, input }) => {
    const u = requireStaffUser(input.userId);
    db.update(users).set({ passwordHash: await hashPassword(input.tempPassword), mustChangePassword: true, updatedAt: now() }).where(eq(users.id, u.id)).run();
    audit(auditActor(ctx), 'staff.resetPassword', { entity: 'user', entityId: input.userId });
    return { ok: true as const };
  }),
});
