// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Auth router (CLAUDE.md §12, §14): session state, first-run admin setup, password
 * login, logout, and the OpenMasjidOS SSO fast-path. Origin policy is enforced HERE
 * for the public login/setup mutations and in trpc.ts middleware for every protected
 * call. Errors are friendly + generic: over the tunnel there is no username, role, or
 * password oracle — an unknown user, an inactive user, and an admin (LAN-only) all
 * produce the SAME response, timed constant by verifying against a decoy hash.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { randomBytes } from 'node:crypto';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { router, publicProcedure, protectedProcedure, adminOrFinanceProcedure, auditActor } from './trpc';
import { db } from '../db';
import { users, guardians, guardianUsers, guardianFamilies, students, invites, passwordResets, sessions, type Role } from '../db/schema';
import { rid } from '../db/ids';
import { hashPassword, verifyPassword, dummyHash, MIN_PASSWORD_LENGTH } from '../auth/passwords';
import { createSession, destroySession, cookieOptions, COOKIE, COOKIE_PATH, SSO_SESSION_TTL_MS, hashToken } from '../auth/sessions';
import { probePlatformSession } from '../fabric/platform';
import { alertStaff } from '../alerts';
import { fabricConfigured, config } from '../config';
import { clientIp } from '../security/origin';
import { loginLimiter, inviteAcceptLimiter, resetRequestLimiter, resetConfirmLimiter, registerLimiter, codeLookupLimiter } from '../security/rateLimit';
import { audit } from '../audit';
import { mintInvite, portalBase } from '../auth/invites';
import { normalizeStudentCode } from '../billing/studentCodes';
import { sendInvite, sendReset, mailAvailable } from '../mail/notify';
import { getSelfRegistrationEnabled } from '../settings';

const USERNAME = z.string().trim().min(1).max(254); // fits a full email (parent portal logins)
const PASSWORD = z.string().min(1).max(200);
const ID = z.string().min(1).max(64);
const TOKEN = z.string().min(1).max(200);
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour (§12) — matches the reset email copy

function hasAnyUser(): boolean {
  return !!db.select({ id: users.id }).from(users).limit(1).get();
}

export const authRouter = router({
  /** Who am I? Also performs the LAN-only SSO upgrade when embedded in OpenMasjidOS. */
  session: publicProcedure.query(async ({ ctx }) => {
    if (ctx.session) {
      // A LAN-minted admin cookie presented over the tunnel is inert (§12.4).
      if (ctx.session.role === 'admin' && ctx.origin === 'tunnel') {
        return { authenticated: false as const, setupRequired: false, origin: ctx.origin, adminBlocked: true };
      }
      // Surface the forced-password-change flag so the UI can gate (staff temp passwords).
      let mustChangePassword = false;
      if (ctx.session.userId) {
        const u = db.select({ m: users.mustChangePassword }).from(users).where(eq(users.id, ctx.session.userId)).get();
        mustChangePassword = !!u?.m;
      }
      return {
        authenticated: true as const,
        origin: ctx.origin,
        setupRequired: false,
        user: { role: ctx.session.role, username: ctx.session.username ?? undefined, source: ctx.session.source, mustChangePassword },
      };
    }

    // SSO fast-path — LAN only, only when the platform has wired us in.
    if (fabricConfigured() && ctx.origin === 'lan') {
      const probe = await probePlatformSession(ctx.req.headers.cookie);
      if (probe.username) {
        const { token } = createSession({ role: 'admin', source: 'sso', username: probe.username, ttlMs: SSO_SESSION_TTL_MS });
        ctx.res.setCookie(COOKIE, token, cookieOptions(ctx.https, SSO_SESSION_TTL_MS));
        return {
          authenticated: true as const,
          origin: ctx.origin,
          setupRequired: false,
          user: { role: 'admin' as Role, username: probe.username, source: 'sso' as const, mustChangePassword: false },
        };
      }
    }

    // `setupRequired` IS answered over the tunnel, deliberately, and it is the one place this app
    // trades a bit of install state for usability. The web shell reads it with the origin to show
    // `SetupOnLanNotice` ("Set up the admin account from a device on the masjid's own Wi-Fi — for
    // safety, the first admin can't be created over the internet") instead of a login form nobody can
    // use yet. Reviewed in the 2026-08-04 audit (OMS-008) and kept: the only thing it tells an
    // internet visitor is that first-run has not happened, and `setup` refuses every non-LAN origin
    // regardless, so there is nothing to act on — whereas the notice is the difference between an
    // admin understanding what to do next and staring at a rejected login. §14's "no install-state
    // oracle" applies to the setup mutation's own error text, which stays uniform.
    return { authenticated: false as const, origin: ctx.origin, setupRequired: !hasAnyUser() };
  }),

  /** First-run: create the single admin account. LAN only, and only when empty. */
  setup: publicProcedure
    .input(z.object({ username: USERNAME, password: z.string().min(MIN_PASSWORD_LENGTH).max(200) }))
    .mutation(async ({ ctx, input }) => {
      // Origin FIRST — over the tunnel this always returns the same message whether or
      // not the app is set up yet (no install-state oracle to the internet, §14).
      if (ctx.origin !== 'lan') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Set up the admin account on the masjid network.' });
      }
      const now = new Date();
      const id = rid('usr');
      const passwordHash = await hashPassword(input.password); // hash BEFORE the txn (no await inside it)
      // Atomic check-and-insert closes the first-run race (two concurrent setups can't
      // both create an admin) — the UNIQUE username constraint wouldn't catch differing names.
      const created = db.transaction((tx) => {
        if (tx.select({ id: users.id }).from(users).limit(1).get()) return false;
        tx.insert(users)
          .values({
            id,
            username: input.username,
            passwordHash,
            role: 'admin',
            status: 'active',
            mustChangePassword: false,
            displayName: input.username,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        return true;
      });
      if (!created) throw new TRPCError({ code: 'CONFLICT', message: 'This app is already set up.' });
      const { token } = createSession({ userId: id, role: 'admin', source: 'local', username: input.username });
      ctx.res.setCookie(COOKIE, token, cookieOptions(ctx.https));
      return { ok: true as const };
    }),

  /** Password login. Rate-limited on the real client IP; constant-time; generic errors. */
  login: publicProcedure
    .input(z.object({ username: USERNAME, password: PASSWORD }))
    .mutation(async ({ ctx, input }) => {
      const key = clientIp(ctx.req);
      const wait = loginLimiter.retryAfterMs(key);
      if (wait > 0) {
        throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: `Too many attempts. Try again in ${Math.ceil(wait / 1000)}s.` });
      }

      // Case-insensitive match: parent accounts store the guardian email lowercased, and phone
      // keyboards auto-capitalize — so a case-sensitive lookup would lock legitimate users out.
      // Works for existing mixed-case admin/staff usernames too (compared via lower()).
      const uname = input.username.trim().toLowerCase();
      const user = db.select().from(users).where(sql`lower(${users.username}) = ${uname}`).get();
      const isTunnel = ctx.origin === 'tunnel';
      // A login can legitimately succeed here only for an active account that isn't an
      // admin signing in over the tunnel. Every other case still runs a verify against a
      // decoy hash (constant time) and returns the SAME generic error — no username/role/
      // password oracle over the internet.
      const canAuthHere = !!user && user.status === 'active' && !(user.role === 'admin' && isTunnel);
      const target = canAuthHere ? user!.passwordHash : await dummyHash();
      const passwordOk = await verifyPassword(target, input.password);
      if (!canAuthHere || !passwordOk) {
        loginLimiter.fail(key);
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Incorrect username or password.' });
      }

      loginLimiter.succeed(key);
      const { token } = createSession({ userId: user!.id, role: user!.role, source: 'local', username: user!.username });
      ctx.res.setCookie(COOKIE, token, cookieOptions(ctx.https));
      return { ok: true as const, role: user!.role, mustChangePassword: user!.mustChangePassword };
    }),

  logout: publicProcedure.mutation(({ ctx }) => {
    destroySession(ctx.token);
    ctx.res.clearCookie(COOKIE, { path: COOKIE_PATH }); // must match the Path the cookie was set with (RFC 6265)
    return { ok: true as const };
  }),

  /**
   * Change your own password (also used for the forced change on a staff temp password).
   *
   * SIGNS OUT EVERY OTHER SESSION, keeping the caller's own. `resetConfirm` below has always done this
   * ("sign out everywhere") because a reset is what you do when you have lost control of an account —
   * but a password CHANGE is the same gesture reached from inside the app, and it is the only
   * revocation a user can actually perform: there is no session list and no "sign out everywhere"
   * button. Leaving other sessions live meant a parent who signed in on a borrowed phone, then changed
   * their password from home precisely because they were worried, left that cookie working for the rest
   * of its 12-hour TTL.
   *
   * The current token is spared deliberately — revoking it would log the user out of the tab they are
   * standing in the moment they succeed, which reads as the change having failed.
   */
  changePassword: protectedProcedure
    .input(z.object({ currentPassword: PASSWORD, newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.userId;
      if (!userId) throw new TRPCError({ code: 'BAD_REQUEST', message: 'There is no local password to change for this session.' });
      const user = db.select().from(users).where(eq(users.id, userId)).get();
      if (!user || !(await verifyPassword(user.passwordHash, input.currentPassword))) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Your current password is incorrect.' });
      }
      const passwordHash = await hashPassword(input.newPassword); // hash BEFORE the txn (no await inside)
      const keep = ctx.token ? hashToken(ctx.token) : null;
      db.transaction((tx) => {
        tx.update(users).set({ passwordHash, mustChangePassword: false, updatedAt: new Date() }).where(eq(users.id, userId)).run();
        // Scoped to THIS user, so nobody else is disturbed; `keep` spares the caller's own cookie.
        tx.delete(sessions)
          .where(keep ? and(eq(sessions.userId, userId), ne(sessions.tokenHash, keep)) : eq(sessions.userId, userId))
          .run();
      });
      audit(auditActor(ctx), 'password.change', { entity: 'user', entityId: userId });
      return { ok: true as const };
    }),

  // ── Parent portal: invites (CLAUDE.md §12) ──────────────────────────────────
  /** finance/admin creates a one-time portal invite for a guardian. Returns the link to share —
   *  emailed once SMTP lands; for now the office copies/prints it. The guardian needs an email
   *  (it becomes their portal login) and must not already have an account. */
  inviteCreate: adminOrFinanceProcedure.input(z.object({ guardianId: ID })).mutation(async ({ ctx, input }) => {
    const r = mintInvite(input.guardianId, ctx.session.userId ?? null);
    if (!r.ok) {
      const msg =
        r.reason === 'guardian_not_found'
          ? 'Guardian not found.'
          : r.reason === 'no_email'
            ? 'Add an email for this guardian before inviting them to the portal.'
            : r.reason === 'already_account'
              ? 'This guardian already has a portal account.'
              : 'That email is already used by another account.';
      throw new TRPCError({ code: r.reason === 'guardian_not_found' ? 'NOT_FOUND' : r.reason === 'no_email' ? 'BAD_REQUEST' : 'CONFLICT', message: msg });
    }
    audit(auditActor(ctx), 'invite.create', { entity: 'guardian', entityId: input.guardianId });
    // Email the link when we can; ALWAYS return the link too, so the office can copy/print it (and so
    // a failed send never blocks the invite) — graceful degradation, §4/§12. `mailSkipped` tells the
    // UI *why* nothing was sent, so "no public URL yet" stops being an invisible failure.
    const mail = await sendInvite(r.email, r.url, r.guardianName);
    audit(auditActor(ctx), 'invite.mail', { entity: 'guardian', entityId: input.guardianId, detail: { emailed: mail.sent, skipped: mail.skipped ?? null } });
    return { token: r.token, url: r.url, email: r.email, guardianName: r.guardianName, emailed: mail.sent, mailSkipped: mail.skipped ?? null };
  }),

  /**
   * Send a password reset to a guardian who already HAS a portal account — the office-initiated
   * counterpart to the parent-initiated `resetRequest`.
   *
   * Unlike `resetRequest` this is deliberately NOT generic: the caller is authenticated staff looking
   * at that guardian's record, so there is no account to enumerate, and a real error ("they have no
   * account yet — send an invite instead") is far more useful than a silent success. Also returns the
   * link so the office can read it out when mail isn't working.
   */
  sendGuardianReset: adminOrFinanceProcedure.input(z.object({ guardianId: ID })).mutation(async ({ ctx, input }) => {
    const g = db.select({ id: guardians.id, name: guardians.name, email: guardians.email }).from(guardians).where(eq(guardians.id, input.guardianId)).get();
    if (!g) throw new TRPCError({ code: 'NOT_FOUND', message: 'Guardian not found.' });
    const link = db.select({ userId: guardianUsers.userId }).from(guardianUsers).where(eq(guardianUsers.guardianId, g.id)).get();
    if (!link) throw new TRPCError({ code: 'BAD_REQUEST', message: 'This guardian has no portal account yet — send them an invite instead.' });
    const user = db.select({ id: users.id, username: users.username, email: users.email, status: users.status }).from(users).where(eq(users.id, link.userId)).get();
    if (!user || user.status !== 'active') throw new TRPCError({ code: 'BAD_REQUEST', message: 'That portal account is disabled.' });

    const token = randomBytes(32).toString('base64url');
    const ts = new Date();
    db.insert(passwordResets).values({ id: rid('pwr'), tokenHash: hashToken(token), userId: user.id, createdAt: ts, expiresAt: new Date(ts.getTime() + RESET_TTL_MS) }).run();
    const url = `${portalBase()}/family/reset?token=${token}`;
    const to = user.email && user.email.includes('@') ? user.email : user.username;
    const mail = await sendReset(to, url);
    audit(auditActor(ctx), 'password.reset.staff', { entity: 'user', entityId: user.id, detail: { guardianId: g.id, emailed: mail.sent, skipped: mail.skipped ?? null } });
    return { url, email: to, guardianName: g.name, emailed: mail.sent, mailSkipped: mail.skipped ?? null };
  }),

  /** Look up a pending invite (for the accept page to greet the guardian). Uniform invalid
   *  response — tokens are 256-bit, so there is nothing to enumerate. */
  inviteInfo: publicProcedure.input(z.object({ token: TOKEN })).query(({ input }) => {
    const inv = db.select().from(invites).where(and(eq(invites.tokenHash, hashToken(input.token)), isNull(invites.usedAt))).get();
    if (!inv || inv.expiresAt.getTime() <= Date.now()) return { valid: false as const };
    const g = db.select({ name: guardians.name, email: guardians.email }).from(guardians).where(eq(guardians.id, inv.guardianId)).get();
    if (!g) return { valid: false as const };
    // The address is echoed back so the page can say what they will sign in WITH. A parent has no
    // username of their own — it IS their email (see inviteAccept, which sets both to it) — and a
    // sign-in form asking for a "username" is the moment that catches them out. Only reachable with
    // the invite token, which was sent to that very address.
    return { valid: true as const, guardianName: g.name, email: (g.email ?? '').trim().toLowerCase() };
  }),

  /** Accept a portal invite: set a password → create the parent account + guardian link → sign in.
   *  Rate-limited per IP; single-use is re-checked inside the transaction to close the race. */
  inviteAccept: publicProcedure
    .input(z.object({ token: TOKEN, password: z.string().min(MIN_PASSWORD_LENGTH).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const key = clientIp(ctx.req);
      const wait = inviteAcceptLimiter.retryAfterMs(key);
      if (wait > 0) throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: `Too many attempts. Try again in ${Math.ceil(wait / 1000)}s.` });

      const inv = db.select().from(invites).where(and(eq(invites.tokenHash, hashToken(input.token)), isNull(invites.usedAt))).get();
      const g = inv ? db.select().from(guardians).where(eq(guardians.id, inv.guardianId)).get() : null;
      const email = (g?.email ?? '').trim().toLowerCase();
      const valid =
        !!inv &&
        inv.expiresAt.getTime() > Date.now() &&
        !!g &&
        !!email &&
        !db.select({ userId: guardianUsers.userId }).from(guardianUsers).where(eq(guardianUsers.guardianId, g.id)).get() &&
        !db.select({ id: users.id }).from(users).where(eq(users.username, email)).get();
      if (!valid) {
        inviteAcceptLimiter.fail(key);
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'This invite link is invalid or has already been used. Ask the office for a new one.' });
      }

      const passwordHash = await hashPassword(input.password); // hash BEFORE the txn (no await inside)
      const userId = rid('usr');
      const ts = new Date();
      const created = db.transaction((tx) => {
        // Re-check single-use + uniqueness atomically (closes a double-accept race).
        const live = tx.select({ usedAt: invites.usedAt }).from(invites).where(eq(invites.id, inv!.id)).get();
        if (!live || live.usedAt) return false;
        if (tx.select({ userId: guardianUsers.userId }).from(guardianUsers).where(eq(guardianUsers.guardianId, g!.id)).get()) return false;
        if (tx.select({ id: users.id }).from(users).where(eq(users.username, email)).get()) return false;
        tx.insert(users).values({ id: userId, username: email, email, passwordHash, role: 'parent', status: 'active', mustChangePassword: false, displayName: g!.name, createdAt: ts, updatedAt: ts }).run();
        tx.insert(guardianUsers).values({ guardianId: g!.id, userId, createdAt: ts }).run();
        tx.update(invites).set({ usedAt: ts }).where(eq(invites.id, inv!.id)).run();
        return true;
      });
      if (!created) {
        inviteAcceptLimiter.fail(key);
        throw new TRPCError({ code: 'CONFLICT', message: 'This invite could not be completed. Ask the office for a new one.' });
      }
      inviteAcceptLimiter.succeed(key);
      audit({ userId, role: 'parent', name: g!.name }, 'invite.accept', { entity: 'guardian', entityId: g!.id });
      const { token } = createSession({ userId, role: 'parent', source: 'local', username: email });
      ctx.res.setCookie(COOKIE, token, cookieOptions(ctx.https));
      return { ok: true as const, role: 'parent' as Role };
    }),

  /** Request a password reset (§12). ALWAYS returns { ok: true } — no account-enumeration oracle (§14):
   *  whether or not the email matches, the response + timing are the same. A link is only actually sent
   *  when it matches an ACTIVE account AND email is set up with an absolute base URL. Rate-limited per
   *  IP against inbox bombing. Works for any role, but only ever emails the account's own address; the
   *  reset itself never mints an admin session (admin still logs in LAN-only). */
  resetRequest: publicProcedure.input(z.object({ email: USERNAME })).mutation(async ({ ctx, input }) => {
    if (!resetRequestLimiter.allow(clientIp(ctx.req))) throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Too many requests. Please try again in a little while.' });
    const email = input.email.trim().toLowerCase();
    // Resolve the target DETERMINISTICALLY: the UNIQUE username first (case-insensitive, matching
    // login), then the (non-unique, nullable) email column only when it identifies EXACTLY ONE active
    // user. An ambiguous email match — or none — resets nothing, so a username⇄email collision can
    // never reset the wrong account (§14). The response stays generic regardless.
    let user = db
      .select({ id: users.id, email: users.email, username: users.username })
      .from(users)
      .where(and(eq(users.status, 'active'), sql`lower(${users.username}) = ${email}`))
      .get();
    if (!user) {
      const byEmail = db
        .select({ id: users.id, email: users.email, username: users.username })
        .from(users)
        .where(and(eq(users.status, 'active'), eq(sql`lower(coalesce(${users.email}, ''))`, email)))
        .all();
      if (byEmail.length === 1) user = byEmail[0];
    }
    // Only mint a token when we can actually deliver it (some mail transport + an absolute link) —
    // otherwise the office handles the reset and no un-deliverable token is left stranded. Response
    // stays generic either way.
    if (user && mailAvailable() && portalBase()) {
      const token = randomBytes(32).toString('base64url');
      const ts = new Date();
      db.insert(passwordResets).values({ id: rid('pwr'), tokenHash: hashToken(token), userId: user.id, createdAt: ts, expiresAt: new Date(ts.getTime() + RESET_TTL_MS) }).run();
      const to = user.email && user.email.includes('@') ? user.email : user.username;
      // Deliberately NOT awaited: the response must take the same time whether or not the account
      // exists, or it becomes an account-enumeration oracle. The delivery OUTCOME is audited from the
      // callback instead, so a suppressed reset leaves a trail — on a default install with no public
      // URL every reset is silently dropped, and that used to be invisible.
      void sendReset(to, `${portalBase()}/family/reset?token=${token}`).then((mail) => {
        audit({ userId: user.id, role: null, name: null }, 'password.reset.mail', { entity: 'user', entityId: user.id, detail: { emailed: mail.sent, skipped: mail.skipped ?? null } });
      });
      audit({ userId: user.id, role: null, name: null }, 'password.reset.request', { entity: 'user', entityId: user.id });
    }
    return { ok: true as const };
  }),

  /** Is a reset token still valid (for the reset page to enable the form)? Uniform on invalid. */
  resetInfo: publicProcedure.input(z.object({ token: TOKEN })).query(({ input }) => {
    const r = db.select({ expiresAt: passwordResets.expiresAt }).from(passwordResets).where(and(eq(passwordResets.tokenHash, hashToken(input.token)), isNull(passwordResets.usedAt))).get();
    return { valid: !!r && r.expiresAt.getTime() > Date.now() };
  }),

  /** Complete a reset: set the new password, single-use (re-checked in the txn), and sign the user out
   *  everywhere (kill existing sessions). Does NOT auto-login — they sign in fresh (so admin stays
   *  LAN-only). Rate-limited per IP. */
  resetConfirm: publicProcedure
    .input(z.object({ token: TOKEN, password: z.string().min(MIN_PASSWORD_LENGTH).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const key = clientIp(ctx.req);
      const wait = resetConfirmLimiter.retryAfterMs(key);
      if (wait > 0) throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: `Too many attempts. Try again in ${Math.ceil(wait / 1000)}s.` });
      const r = db.select().from(passwordResets).where(and(eq(passwordResets.tokenHash, hashToken(input.token)), isNull(passwordResets.usedAt))).get();
      if (!r || r.expiresAt.getTime() <= Date.now()) {
        resetConfirmLimiter.fail(key);
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'This reset link is invalid or has expired. Please request a new one.' });
      }
      const passwordHash = await hashPassword(input.password); // hash BEFORE the txn (no await inside)
      const ts = new Date();
      const ok = db.transaction((tx) => {
        const live = tx.select({ usedAt: passwordResets.usedAt }).from(passwordResets).where(eq(passwordResets.id, r.id)).get();
        if (!live || live.usedAt) return false; // re-check single-use atomically (double-submit race)
        tx.update(users).set({ passwordHash, mustChangePassword: false, updatedAt: ts }).where(eq(users.id, r.userId)).run();
        tx.update(passwordResets).set({ usedAt: ts }).where(eq(passwordResets.id, r.id)).run();
        tx.delete(sessions).where(eq(sessions.userId, r.userId)).run(); // sign out everywhere (§14)
        return true;
      });
      if (!ok) {
        resetConfirmLimiter.fail(key);
        throw new TRPCError({ code: 'CONFLICT', message: 'This reset link was already used. Please request a new one.' });
      }
      resetConfirmLimiter.succeed(key);
      audit({ userId: r.userId, role: null, name: null }, 'password.reset.confirm', { entity: 'user', entityId: r.userId });
      return { ok: true as const };
    }),

  /** Whether the self-registration door is open (for the /family/register page to show the form vs a
   *  notice). Public. Requires the admin toggle ON, SMTP configured, and an absolute base (the verify
   *  link is emailed). */
  registerConfig: publicProcedure.query(() => ({ available: getSelfRegistrationEnabled() && mailAvailable() && !!portalBase() })),

  /** Self-registration door 2 (§12): a parent proves they belong by a child's Student ID + a guardian
   *  email ALREADY on file for that child's family. Two independent facts, and the email is the one
   *  that matters — the ID alone can only ever *pay* (§11.2), so minting an ACCOUNT off it would be a
   *  real escalation; requiring an on-file address means the invite can only ever land in an inbox the
   *  office already recorded. ALWAYS returns { ok: true } — never an oracle about which part matched
   *  (§14) — and is throttled per IP AND per code (codeLookupLimiter, the same bucket the Fabric
   *  lookup uses, so probing IDs here instead is not a way around it). */
  register: publicProcedure
    .input(z.object({ studentCode: z.string().trim().min(1).max(32), email: USERNAME }))
    .mutation(async ({ ctx, input }) => {
      if (!registerLimiter.allow(clientIp(ctx.req))) throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Too many attempts. Please try again in a little while.' });
      // Door closed (toggle off / no mail transport / no public URL) → behave exactly like a non-match.
      if (!getSelfRegistrationEnabled() || !mailAvailable() || !portalBase()) return { ok: true as const };
      const code = normalizeStudentCode(input.studentCode);
      const email = input.email.trim().toLowerCase();
      // A locked code behaves as a non-match (no signal it's otherwise valid).
      if (!code || codeLookupLimiter.retryAfterMs(code) > 0) return { ok: true as const };
      const student = db.select({ familyId: students.familyId, status: students.status }).from(students).where(eq(students.studentCode, code)).get();
      // The email must belong to a guardian ON THE SAME family.
      const guardian = student && student.status === 'active'
        ? db
            .select({ id: guardians.id })
            .from(guardians)
            .innerJoin(guardianFamilies, eq(guardianFamilies.guardianId, guardians.id))
            .where(and(eq(guardianFamilies.familyId, student.familyId), eq(sql`lower(coalesce(${guardians.email}, ''))`, email)))
            .get()
        : undefined;
      if (!guardian) {
        const wasLocked = codeLookupLimiter.retryAfterMs(code) > 0;
        codeLookupLimiter.fail(code);
        // An alert (email-capable), not a webhook-only notification — see fabric/provider.ts.
        if (!wasLocked && codeLookupLimiter.retryAfterMs(code) > 0) {
          void alertStaff('lookup-lockout', {
            title: 'A Student ID was locked',
            text: 'One student’s ID was locked for an hour after repeated failed attempts at parent sign-up. If no parent is stuck, someone may be guessing IDs.',
            publicText: 'A self-registration Student ID lookup was locked after repeated failed attempts.',
          });
        }
        return { ok: true as const }; // generic — no enumeration (§14)
      }
      codeLookupLimiter.succeed(code);
      // Mint + email a portal invite for the matched guardian (the verify link = the invite link). If
      // that guardian already has an account (mintInvite !ok), we simply send nothing — still generic.
      // The send is FIRE-AND-FORGET (not awaited) so a full match doesn't take observably longer than
      // a non-match — otherwise the mail round-trip is a timing oracle that leaks a valid ID + email
      // pair (§14). Mirrors resetRequest. The invite row is already minted synchronously above.
      const inv = mintInvite(guardian.id, null);
      if (inv.ok) {
        audit({ userId: null, role: null, name: null }, 'self_register.invite', { entity: 'guardian', entityId: guardian.id });
        void sendInvite(inv.email, inv.url, inv.guardianName);
      }
      return { ok: true as const };
    }),
});
