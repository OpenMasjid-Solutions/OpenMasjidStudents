// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Changing your own password signs out your OTHER sessions [OMS-005].
 *
 * `resetConfirm` has always done this ("sign out everywhere (§14)") because a reset is what you do
 * when you have lost control of an account. `changePassword` did not — so the one action a worried
 * parent actually knows how to take, from inside the app, left a stolen session cookie working for the
 * remainder of its 12-hour TTL. There is no session list and no "sign out everywhere" button, so a
 * password change is the ONLY revocation gesture available to a user; it has to mean something.
 *
 * The current session must survive, or a user changing their password would be logged out of the tab
 * they are standing in — which is why this cannot simply reuse resetConfirm's delete-all.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshApp, makeCtx } from './harness';
import { users, sessions } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let sessionsMod: typeof import('../src/auth/sessions');
const OLD = 'correct-horse-battery';
const NEW = 'new-horse-battery-staple';
const lan = () => app.appRouter.createCaller(makeCtx({ origin: 'lan' }).ctx);

beforeAll(async () => {
  app = await freshApp();
  sessionsMod = await import('../src/auth/sessions');
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [sessions, users]) db.delete(t).run();
});

/** An admin plus three live sessions for them: the one we will call from, and two "other devices". */
async function adminWithSessions() {
  await lan().auth.setup({ username: 'admin', password: OLD });
  const user = app.dbmod.db.select().from(users).where(eq(users.username, 'admin')).get()!;
  // setup() already minted one session; add three of our own so the counts are unambiguous.
  const mine = sessionsMod.createSession({ userId: user.id, role: 'admin', source: 'local', username: 'admin' });
  const phone = sessionsMod.createSession({ userId: user.id, role: 'admin', source: 'local', username: 'admin' });
  const laptop = sessionsMod.createSession({ userId: user.id, role: 'admin', source: 'local', username: 'admin' });
  return { user, mine: mine.token, phone: phone.token, laptop: laptop.token };
}

/** A caller authenticated as this session token, the way a real request would be. */
const asToken = (token: string, role: 'admin' | 'parent' = 'admin') =>
  app.appRouter.createCaller(
    makeCtx({ origin: 'lan', token, session: sessionsMod.getSession(token) }).ctx,
  );

describe('changePassword revokes other sessions [OMS-005]', () => {
  it('kills the user’s other sessions and keeps the caller’s own', async () => {
    const { user, mine, phone, laptop } = await adminWithSessions();
    expect(sessionsMod.getSession(phone)).not.toBeNull();
    expect(sessionsMod.getSession(laptop)).not.toBeNull();

    await asToken(mine).auth.changePassword({ currentPassword: OLD, newPassword: NEW });

    // The borrowed phone and the laptop are done.
    expect(sessionsMod.getSession(phone)).toBeNull();
    expect(sessionsMod.getSession(laptop)).toBeNull();
    // The tab they are standing in still works — they are not logged out mid-action.
    expect(sessionsMod.getSession(mine)).not.toBeNull();
    // And exactly one session row is left for them (setup()'s is gone too — it is an "other").
    expect(app.dbmod.db.select().from(sessions).where(eq(sessions.userId, user.id)).all()).toHaveLength(1);
  });

  it('actually changed the password (the new one works, the old one does not)', async () => {
    const { mine } = await adminWithSessions();
    await asToken(mine).auth.changePassword({ currentPassword: OLD, newPassword: NEW });

    await expect(lan().auth.login({ username: 'admin', password: OLD })).rejects.toThrow(/Incorrect username or password/);
    await expect(lan().auth.login({ username: 'admin', password: NEW })).resolves.toMatchObject({ ok: true, role: 'admin' });
  });

  it('a wrong current password changes nothing and revokes nothing', async () => {
    const { user, mine, phone } = await adminWithSessions();

    await expect(asToken(mine).auth.changePassword({ currentPassword: 'not-my-password', newPassword: NEW })).rejects.toThrow(
      /current password is incorrect/,
    );

    // No collateral: a failed attempt must not be a way to log someone else's devices out.
    expect(sessionsMod.getSession(phone)).not.toBeNull();
    expect(sessionsMod.getSession(mine)).not.toBeNull();
    expect(app.dbmod.db.select().from(sessions).where(eq(sessions.userId, user.id)).all()).toHaveLength(4);
    await expect(lan().auth.login({ username: 'admin', password: OLD })).resolves.toMatchObject({ ok: true });
  });

  it('leaves ANOTHER user’s sessions alone', async () => {
    const { mine } = await adminWithSessions();
    // A second account with its own live session — scoping is by userId, so this must be untouched.
    const ts = new Date();
    app.dbmod.db
      .insert(users)
      .values({ id: 'usr_other', username: 'parent@example.test', email: 'parent@example.test', passwordHash: 'x', role: 'parent', status: 'active', mustChangePassword: false, displayName: 'Parent', createdAt: ts, updatedAt: ts })
      .run();
    const theirs = sessionsMod.createSession({ userId: 'usr_other', role: 'parent', source: 'local', username: 'parent@example.test' });

    await asToken(mine).auth.changePassword({ currentPassword: OLD, newPassword: NEW });

    expect(sessionsMod.getSession(theirs.token)).not.toBeNull();
  });

  it('an SSO session (no local user row) is refused, and revokes nothing', async () => {
    const { user, phone } = await adminWithSessions();
    // An OpenMasjidOS SSO session has no userId, so there is no local password to change.
    const sso = sessionsMod.createSession({ role: 'admin', source: 'sso', username: 'platform-admin' });

    await expect(asToken(sso.token).auth.changePassword({ currentPassword: OLD, newPassword: NEW })).rejects.toThrow(
      /no local password/,
    );

    expect(sessionsMod.getSession(phone)).not.toBeNull();
    expect(app.dbmod.db.select().from(sessions).where(eq(sessions.userId, user.id)).all()).toHaveLength(4);
  });
});
