// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Staff user management (CLAUDE.md §12): admin creates staff accounts with a temporary
 * password (forced change on first login), can change a colleague's role, disable them
 * (revokes live sessions on the next request via getSession's status re-check) and reset
 * passwords (which signs that account out — see `resetPassword`). Admin-only; never returns
 * password hashes; audited.
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
import { users, guardianUsers, userSchools, sessions } from '../db/schema';
import { rid } from '../db/ids';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../auth/passwords';
import { usernameTaken } from '../auth/usernames';
import { hashToken } from '../auth/sessions';
import { fabricConfigured } from '../config';
import { audit } from '../audit';
import { setUserSchools } from '../schools';
import { ALERT_EVENTS, isAlertEvent } from '../alerts';
import { isCountryCode } from '../settings';

const USERNAME = z.string().trim().min(1).max(64);
const TEMP_PW = z.string().min(MIN_PASSWORD_LENGTH).max(200);
/** The roles this screen may hand out. Not `parent` — see the note above. */
const STAFF_ROLE = z.enum(['admin', 'finance']);
/** Free text, like every other number in this app: a number typed by an office is not a form to
 *  validate, and whatsapp/numbers.ts is the one place that decides whether it can be dialled. */
const PHONE = z.string().trim().max(40);
const COUNTRY = z.string().trim().max(5);
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
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        role: users.role,
        status: users.status,
        mustChangePassword: users.mustChangePassword,
        phone: users.phone,
        phoneCountry: users.phoneCountry,
        waEvents: users.waEvents,
      })
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
    return rows.map((u) => ({ ...u, waEvents: (u.waEvents ?? []).filter(isAlertEvent), schoolIds: limits.get(u.id) ?? [] }));
  }),

  /**
   * A staff member's WhatsApp number, and which alerts they want on it (0.50.0).
   *
   * Staff carried no phone number until now, deliberately — "the app never contacts staff by phone, so
   * holding one would be personal data collected for no purpose" (§9). The purpose now exists: a
   * declined card at nine on a Sunday evening reaches a treasurer's phone and does not reach their
   * inbox. It stays entirely opt-in per person: no number and no events by default, and clearing the
   * number is the off switch.
   *
   * Admin-only, like the alert recipient list beside it and for the same reason — subscribing somebody
   * is a standing grant of information about families.
   */
  setContact: adminProcedure
    .input(z.object({ userId: z.string(), phone: PHONE.optional(), phoneCountry: COUNTRY.optional(), waEvents: z.array(z.enum(ALERT_EVENTS)).max(ALERT_EVENTS.length).optional() }))
    .mutation(({ ctx, input }) => {
      const u = requireStaffUser(input.userId);
      const patch: Partial<typeof users.$inferInsert> = { updatedAt: now() };
      if (input.phone !== undefined) patch.phone = input.phone || null;
      if (input.phoneCountry !== undefined) {
        if (input.phoneCountry && !isCountryCode(input.phoneCountry)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'A country code looks like +1 or +44.' });
        patch.phoneCountry = input.phoneCountry || null;
      }
      if (input.waEvents !== undefined) patch.waEvents = input.waEvents;
      db.update(users).set(patch).where(eq(users.id, u.id)).run();
      // Which fields changed and how many alerts — never the number itself (§14).
      audit(auditActor(ctx), 'staff.setContact', { entity: 'user', entityId: u.id, detail: { keys: Object.keys(input).filter((k) => k !== 'userId'), events: input.waEvents?.length } });
      return { ok: true as const };
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
      // Case-INSENSITIVELY, because that is how signing in matches (auth/usernames.ts). Comparing
      // exactly let `Office` and `office` both exist, and only the first of them could ever be signed
      // into — a second admin account that silently did not work.
      if (usernameTaken(db, input.username)) {
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

  /**
   * Reset a colleague's password — AND SIGN THAT ACCOUNT OUT (§12, §14).
   *
   * The revocation was missing until 0.51.0, and this was the only one of the three password-writing
   * paths without it: `auth.changePassword` deletes the account's other sessions and `auth.resetConfirm`
   * signs it out everywhere, while this wrote the new hash and nothing else. Nothing else evicted it
   * either — `getSession` re-checks the account's status and live role on every request but never the
   * password — so an existing cookie kept working for the rest of its 12-hour life. That is the wrong
   * behavior for the gesture: an admin typing a new password for somebody is acting because the old one
   * should stop working, and often because the account looks compromised. `mustChangePassword` is no
   * substitute; it steers the honest user's browser and does not gate the API.
   *
   * `keep` rather than `resetConfirm`'s unconditional delete, because unlike `setRole` and `setStatus`
   * this procedure has no self guard and the UI offers it on every row including the caller's own — so a
   * blanket delete would log an admin out of the tab they are standing in, which is exactly what
   * `changePassword`'s `keep` exists to prevent. Resetting somebody ELSE'S password spares nothing.
   */
  resetPassword: adminProcedure.input(z.object({ userId: z.string(), tempPassword: TEMP_PW })).mutation(async ({ ctx, input }) => {
    const u = requireStaffUser(input.userId);
    const passwordHash = await hashPassword(input.tempPassword); // hash BEFORE the txn (no await inside)
    const keep = u.id === ctx.session?.userId && ctx.token ? hashToken(ctx.token) : null;
    db.transaction((tx) => {
      tx.update(users).set({ passwordHash, mustChangePassword: true, updatedAt: now() }).where(eq(users.id, u.id)).run();
      tx.delete(sessions)
        .where(keep ? and(eq(sessions.userId, u.id), ne(sessions.tokenHash, keep)) : eq(sessions.userId, u.id))
        .run();
    });
    audit(auditActor(ctx), 'staff.resetPassword', { entity: 'user', entityId: input.userId });
    return { ok: true as const };
  }),
});
