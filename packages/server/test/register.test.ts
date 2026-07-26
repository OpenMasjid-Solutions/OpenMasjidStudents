// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Parent self-registration (CLAUDE.md §12 door 2 / §14): child name + PIN + an on-file guardian email,
 * all matching the SAME family, emails that guardian a portal invite. The response is ALWAYS generic
 * (no enumeration); only a full match mints an invite. Requires the admin toggle + SMTP + a public URL.
 * The public URL is set before freshApp (config reads it) and restored after — no leak to other files.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshApp, makeCtx } from './harness';
import { invites, guardianUsers, guardians, guardianFamilies, students, families, sessions, users, settings, studentFees, feePlans } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let settingsMod: typeof import('../src/settings');
const admin = () => app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role: 'admin' as Role, source: 'local', username: 'admin', userId: 'usr_admin' } }).ctx);
const pub = (peer = '127.0.0.1') => app.appRouter.createCaller(makeCtx({ origin: 'lan', peer }).ctx);
const inviteCount = () => app.dbmod.db.select().from(invites).all().length;

beforeAll(async () => {
  // The door needs a mail transport AND an absolute public URL. There is no SMTP any more — email is
  // the platform's job — so `fabric: true` is what opens it. The send itself fails (nothing is
  // listening on platform.test), which is fine: the invite is still minted, which is what these
  // tests are about.
  app = await freshApp({ fabric: true, publicUrl: 'https://masjid.test/students' });
  settingsMod = await import('../src/settings');
});
afterAll(() => {
  delete process.env.OPENMASJID_PUBLIC_URL;
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [invites, guardianUsers, guardians, guardianFamilies, studentFees, feePlans, students, families, sessions, users, settings]) db.delete(t).run();
});

/** A family with a student (known PIN) + a guardian with an on-file email. */
async function scenario() {
  const a = admin();
  const fam = await a.people.familyCreate({ name: 'Ismail' });
  const plan = await a.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
  const s = await a.people.studentCreate({ familyId: fam.id, firstName: 'Yusuf', lastName: 'Ismail', feePlanId: plan.id });
  await a.people.guardianCreate({ familyId: fam.id, name: 'Abu Yusuf', email: 'Abu@Example.com' });
  return { pin: s.pin };
}

describe('registerConfig', () => {
  it('is available with the toggle on + SMTP + a public URL, and reflects the toggle', async () => {
    await scenario();
    expect(await pub().auth.registerConfig()).toEqual({ available: true });
    await admin().settings.set({ selfRegistration: false });
    expect(await pub().auth.registerConfig()).toEqual({ available: false });
  });
});

describe('register (name + PIN + on-file email)', () => {
  it('a full match mints a portal invite (email case-insensitive); response is generic', async () => {
    const { pin } = await scenario();
    expect(await pub().auth.register({ childName: 'yusuf', pin, email: 'abu@example.com' })).toEqual({ ok: true });
    expect(inviteCount()).toBe(1);
  });

  it('a wrong child name mints nothing', async () => {
    const { pin } = await scenario();
    expect(await pub().auth.register({ childName: 'Bilal', pin, email: 'abu@example.com' })).toEqual({ ok: true });
    expect(inviteCount()).toBe(0);
  });

  it('an email not on file for that family mints nothing', async () => {
    const { pin } = await scenario();
    expect(await pub().auth.register({ childName: 'Yusuf', pin, email: 'stranger@example.com' })).toEqual({ ok: true });
    expect(inviteCount()).toBe(0);
  });

  it('a wrong PIN mints nothing', async () => {
    await scenario();
    expect(await pub().auth.register({ childName: 'Yusuf', pin: '000000', email: 'abu@example.com' })).toEqual({ ok: true });
    expect(inviteCount()).toBe(0);
  });

  it('mints nothing when self-registration is turned off (even on a full match)', async () => {
    const { pin } = await scenario();
    await admin().settings.set({ selfRegistration: false });
    expect(await pub().auth.register({ childName: 'Yusuf', pin, email: 'abu@example.com' })).toEqual({ ok: true });
    expect(inviteCount()).toBe(0);
  });

  it('throttles per IP (the 9th attempt from one IP is refused)', async () => {
    const { pin } = await scenario();
    const p = pub('9.9.9.9');
    for (let i = 0; i < 8; i++) await p.auth.register({ childName: 'nope', pin: '111111', email: 'x@y.z' });
    await expect(p.auth.register({ childName: 'nope', pin: '111111', email: 'x@y.z' })).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });
});
