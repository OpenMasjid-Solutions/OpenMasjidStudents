// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Parent self-registration (CLAUDE.md §12 door 2 / §14): a child's Student ID + an on-file guardian
 * email, both belonging to the SAME family, emails that guardian a portal invite. The email half is
 * load-bearing, not decoration — a Student ID on its own can only *pay* (§11.2), so minting an account
 * from one would be an escalation; requiring an address the office already recorded means the invite
 * can only ever land in an inbox the school chose.
 *
 * The response is ALWAYS generic (no enumeration); only a full match mints an invite. Requires the
 * admin toggle + a mail transport + a public URL. The public URL is set before freshApp (config reads
 * it) and restored after — no leak to other files.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { invites, guardianUsers, guardians, guardianFamilies, students, families, sessions, users, settings, studentFees, feePlans } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
const admin = () => app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role: 'admin' as Role, source: 'local', username: 'admin', userId: 'usr_admin' } }).ctx);
const pub = (peer = '127.0.0.1') => app.appRouter.createCaller(makeCtx({ origin: 'lan', peer }).ctx);
const inviteCount = () => app.dbmod.db.select().from(invites).all().length;

beforeAll(async () => {
  // The door needs a mail transport AND an absolute public URL. There is no SMTP any more — email is
  // the platform's job — so `fabric: true` is what opens it. The send itself fails (nothing is
  // listening on platform.test), which is fine: the invite is still minted, which is what these
  // tests are about.
  app = await freshApp({ fabric: true, publicUrl: 'https://masjid.test/students' });
});
afterAll(() => {
  delete process.env.OPENMASJID_PUBLIC_URL;
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [invites, guardianUsers, guardians, guardianFamilies, studentFees, feePlans, students, families, sessions, users, settings]) db.delete(t).run();
});

/** A family with a student (known Student ID) + a guardian with an on-file email. */
async function scenario() {
  const a = admin();
  const fam = await a.people.familyCreate({ name: 'Ismail' });
  const plan = await a.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
  const s = await a.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });
  await a.people.guardianCreate({ familyId: fam.id, name: 'Abu Yusuf', email: 'Abu@Example.com' });
  return { studentCode: s.studentCode };
}

describe('registerConfig', () => {
  it('is available with the toggle on + a mail transport + a public URL, and reflects the toggle', async () => {
    await scenario();
    expect(await pub().auth.registerConfig()).toEqual({ available: true });
    await admin().settings.set({ selfRegistration: false });
    expect(await pub().auth.registerConfig()).toEqual({ available: false });
  });
});

describe('register (Student ID + on-file email)', () => {
  it('a full match mints a portal invite (ID and email both case-insensitive); response is generic', async () => {
    const { studentCode } = await scenario();
    expect(await pub().auth.register({ studentCode: studentCode.toLowerCase(), email: 'abu@example.com' })).toEqual({ ok: true });
    expect(inviteCount()).toBe(1);
  });

  it('an email not on file for that family mints nothing', async () => {
    const { studentCode } = await scenario();
    expect(await pub().auth.register({ studentCode, email: 'stranger@example.com' })).toEqual({ ok: true });
    expect(inviteCount()).toBe(0);
  });

  it('a wrong Student ID mints nothing, even with a real on-file email', async () => {
    await scenario();
    expect(await pub().auth.register({ studentCode: 'ZZZ9999', email: 'abu@example.com' })).toEqual({ ok: true });
    expect(inviteCount()).toBe(0);
  });

  it('mints nothing when self-registration is turned off (even on a full match)', async () => {
    const { studentCode } = await scenario();
    await admin().settings.set({ selfRegistration: false });
    expect(await pub().auth.register({ studentCode, email: 'abu@example.com' })).toEqual({ ok: true });
    expect(inviteCount()).toBe(0);
  });

  it('throttles per IP (the 9th attempt from one IP is refused)', async () => {
    await scenario();
    const p = pub('9.9.9.9');
    for (let i = 0; i < 8; i++) await p.auth.register({ studentCode: 'QQQ1111', email: 'x@y.z' });
    await expect(p.auth.register({ studentCode: 'QQQ1111', email: 'x@y.z' })).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  /** Per-CODE lockout, on top of the per-IP cap: this door shares `codeLookupLimiter` with the Fabric
   *  lookup, so someone rotating IPs to grind one child's ID still runs into the same wall. */
  it('locks a Student ID after repeated failures, so a later correct email mints nothing', async () => {
    const { studentCode } = await scenario();
    for (let i = 0; i < 6; i++) await pub(`10.0.0.${i}`).auth.register({ studentCode, email: 'wrong@example.com' });
    expect(inviteCount()).toBe(0);
    // Now the RIGHT email, from a fresh IP — the code itself is locked, so still nothing.
    expect(await pub('10.0.1.1').auth.register({ studentCode, email: 'abu@example.com' })).toEqual({ ok: true });
    expect(inviteCount()).toBe(0);
  });
});
