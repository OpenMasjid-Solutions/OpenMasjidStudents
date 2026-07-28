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
 *   - removing the LAST active admin (by demotion or by disabling). Admin is the only role that
 *     can reach settings, and it is LAN-only, so there is no remote way back in.
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
import { users, guardianUsers } from '../db/schema';
import { rid } from '../db/ids';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../auth/passwords';
import { audit } from '../audit';

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
  list: adminProcedure.query(() =>
    db
      .select({ id: users.id, username: users.username, displayName: users.displayName, role: users.role, status: users.status, mustChangePassword: users.mustChangePassword })
      .from(users)
      .where(inArray(users.role, ['admin', 'finance']))
      .orderBy(users.role, users.username)
      .all(),
  ),

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
    // LAN-only, so there would be no way back in remotely.
    if (u.role === 'admin' && input.role !== 'admin' && otherActiveAdmins(u.id) === 0) {
      throw new TRPCError({ code: 'CONFLICT', message: 'This is the only admin left. Make someone else an admin first.' });
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
    if (u.role === 'admin' && input.status === 'disabled' && otherActiveAdmins(u.id) === 0) {
      throw new TRPCError({ code: 'CONFLICT', message: 'This is the only admin left. Make someone else an admin first.' });
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
