// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * A distributed password spray against ONE account (§14: "per-IP and per-account", 0.48.0 — found by audit).
 *
 * WHAT WAS MISSING. Login was throttled per client IP only. That stops one machine hammering, and nothing
 * else: finance and parent accounts are reachable over the Cloudflare tunnel, a parent's username IS their
 * email address, and a hundred hosts making eight attempts each never trips a per-IP counter. §14 has
 * always required both halves; only one was there.
 *
 * These tests own the trade-off as much as the rule. The per-account bucket is keyed on a value the caller
 * supplies, so it is deliberately loose (25 in 15 minutes) — tight enough that guessing a password is
 * hopeless, loose enough that it is not a way to lock a named admin out of their own office. And it counts
 * failures on the SUPPLIED name whether or not that account exists, so it cannot be used to find out which
 * names are real.
 *
 * Own file so the limiter singletons start empty — vitest gives each test file its own module registry.
 * Within the file they persist (there is no reset, deliberately: a limiter you can clear from a request is
 * not a limiter), so each test sprays a DIFFERENT name.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { users, sessions } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
const STRONG = 'a-strong-passphrase-123';

beforeAll(async () => {
  app = await freshApp();
});
beforeEach(async () => {
  app.dbmod.db.delete(sessions).run();
  app.dbmod.db.delete(users).run();
  await app.appRouter.createCaller(makeCtx({ origin: 'lan' }).ctx).auth.setup({ username: 'admin', password: STRONG });
});

/** One attempt, from its own client IP — i.e. what a botnet looks like. */
function attempt(username: string, password: string, peer: string) {
  return app.appRouter.createCaller(makeCtx({ origin: 'lan', peer }).ctx).auth.login({ username, password });
}

/** A finance account with a known password, so a test has a login of its own to prove still works. */
async function staff(username: string) {
  const adminId = app.dbmod.db.select().from(users).all()[0].id;
  const admin = app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role: 'admin', source: 'local', username: 'admin', userId: adminId } }).ctx);
  await admin.staff.create({ username, role: 'finance', tempPassword: STRONG });
}

describe('login throttling per account', () => {
  it('caps what the whole internet may try against one name', async () => {
    // Every attempt from a DIFFERENT address, so the per-IP limiter is never near its own threshold.
    for (let i = 0; i < 25; i++) {
      await expect(attempt('admin', `guess-number-${i}`, `spray-${i}`)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
    // A fresh address, and still refused — this is the half that did not exist.
    await expect(attempt('admin', 'guess-number-25', 'spray-fresh')).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  it('locks the NAME, not the machine — another account from the same addresses still works', async () => {
    await staff('bilal');
    // A spray at one name, spread over 25 addresses.
    for (let i = 0; i < 25; i++) {
      await expect(attempt('ghost@example.org', `guess-${i}`, `shared-peer-${i}`)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
    await expect(attempt('ghost@example.org', 'guess-25', 'shared-peer-0')).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    // The office's own login still works — from one of the very addresses that was just spraying.
    await expect(attempt('bilal', STRONG, 'shared-peer-0')).resolves.toMatchObject({ ok: true, role: 'finance' });
  });

  it('is not an enumeration oracle — an unknown name locks the same way', async () => {
    // If only real accounts could be locked, the lockout itself would answer "does this account exist?".
    for (let i = 0; i < 25; i++) {
      await expect(attempt('nobody@example.org', `guess-${i}`, `unknown-${i}`)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
    await expect(attempt('nobody@example.org', 'guess-25', 'unknown-fresh')).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  it('forgets the failures as soon as the real person signs in', async () => {
    // The case that matters for a volunteer who cannot remember which password they set: mistyping it
    // several times must not leave them a few attempts from being locked out for a quarter of an hour.
    await staff('ustadha');
    for (let i = 0; i < 20; i++) {
      await expect(attempt('ustadha', `mistyped-${i}`, `honest-${i}`)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
    await expect(attempt('ustadha', STRONG, 'honest-real')).resolves.toMatchObject({ ok: true });
    // Back to a clean slate: twenty more mistakes must not tip a counter that was nearly full.
    for (let i = 0; i < 20; i++) {
      await expect(attempt('ustadha', `mistyped-again-${i}`, `honest2-${i}`)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
    await expect(attempt('ustadha', STRONG, 'honest-real-2')).resolves.toMatchObject({ ok: true });
  });

  it('tells the office when a real account is being ground — once, not per attempt', async () => {
    /**
     * The 2026-08-04 audit's own recommendation (OMS-010(b)): an alert catches the attack and creates no
     * denial of service. It is here ALONGSIDE the cap rather than instead of it — see the comment in
     * `auth.ts`. Only on the transition into blocked, and only for a name that exists, so a spray over
     * invented usernames cannot be turned into a mail flood.
     */
    await staff('watched');
    const alerts = await import('../src/alerts');
    const seen: string[] = [];
    const spy = vi.spyOn(alerts, 'alertStaff').mockImplementation(async (event) => {
      seen.push(event);
    });
    try {
      for (let i = 0; i < 30; i++) {
        await expect(attempt('watched', `guess-${i}`, `watched-${i}`)).rejects.toBeTruthy();
      }
      expect(seen.filter((e) => e === 'login-blocked')).toHaveLength(1);

      // An invented name locks the same way (no oracle) but raises nothing — there is no account to warn about.
      seen.length = 0;
      for (let i = 0; i < 30; i++) {
        await expect(attempt('invented@example.org', `guess-${i}`, `invented-${i}`)).rejects.toBeTruthy();
      }
      expect(seen).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('still counts per IP as well, so one machine is stopped much sooner', async () => {
    // The two limiters are independent: eight from one address is enough on its own, well before the
    // account bucket is anywhere near full.
    for (let i = 0; i < 8; i++) {
      await expect(attempt('anybody@example.org', `guess-${i}`, 'one-machine')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
    await expect(attempt('someone-else@example.org', 'whatever-value', 'one-machine')).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });
});
