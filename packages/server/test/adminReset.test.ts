// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * FROM OUTSIDE, AN ADMIN IS THE PLATFORM'S TWO-STEP SIGN-IN OR NOBODY — including by password reset
 * (CLAUDE.md §12.4). The admin password is never CHECKED over the tunnel (`auth.test.ts`), and first-run
 * setup is refused there; this file is the third door. The only link base a reset email can carry is
 * the PUBLIC address, so an emailed admin reset always opened through the internet and set the admin
 * password on the strength of a mailbox alone. Finance and parents sign in from outside with their own
 * passwords by design (§5), so their resets are the positive control in every test.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshApp, makeCtx } from './harness';
import { users, passwordResets, sessions } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let hashToken: (t: string) => string;
const realFetch = globalThis.fetch;
const NEWPW = 'new-horse-battery-staple';
const caller = (origin: 'lan' | 'tunnel') => app.appRouter.createCaller(makeCtx({ origin, peer: origin === 'tunnel' ? '127.0.0.1' : '10.0.0.5' }).ctx);

beforeAll(async () => {
  // A public URL and a mail transport: the conditions under which a reset link is actually sent.
  app = await freshApp({ fabric: true, publicUrl: 'https://masjid.test/students' });
  ({ hashToken } = await import('../src/auth/sessions'));
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ sent: true }) })) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [passwordResets, sessions, users]) db.delete(t).run();
  const ts = new Date();
  for (const [id, role] of [['usr_admin', 'admin'], ['usr_fin', 'finance']] as const) {
    db.insert(users).values({ id, username: role, email: `${role}@masjid.test`, passwordHash: 'x', role, status: 'active', mustChangePassword: false, createdAt: ts, updatedAt: ts }).run();
  }
});

const resetsFor = (userId: string) => app.dbmod.db.select().from(passwordResets).where(eq(passwordResets.userId, userId)).all();
function insertReset(userId: string, token: string) {
  const ts = new Date();
  app.dbmod.db.insert(passwordResets).values({ id: 'pwr_' + token, tokenHash: hashToken(token), userId, createdAt: ts, expiresAt: new Date(ts.getTime() + 3_600_000) }).run();
}

describe('an admin password reset', () => {
  it('is never emailed — finance’s still is — and the answer is the same either way', async () => {
    for (const origin of ['lan', 'tunnel'] as const) {
      expect(await caller(origin).auth.resetRequest({ email: 'admin@masjid.test' })).toEqual({ ok: true });
      expect(await caller(origin).auth.resetRequest({ email: 'finance@masjid.test' })).toEqual({ ok: true });
    }
    expect(resetsFor('usr_admin')).toHaveLength(0);
    expect(resetsFor('usr_fin')).toHaveLength(2);
  });

  it('cannot be completed over the tunnel, and the link is left unspent', async () => {
    insertReset('usr_admin', 'adm');
    await expect(caller('tunnel').auth.resetConfirm({ token: 'adm', password: NEWPW })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('OpenMasjidOS dashboard'),
    });
    expect(resetsFor('usr_admin')[0].usedAt).toBeNull();
    // The LAN is unchanged: the same link works there.
    expect(await caller('lan').auth.resetConfirm({ token: 'adm', password: NEWPW })).toEqual({ ok: true });
  });

  it('finance resets over the tunnel as before', async () => {
    insertReset('usr_fin', 'fin');
    expect(await caller('tunnel').auth.resetConfirm({ token: 'fin', password: NEWPW })).toEqual({ ok: true });
  });
});
