// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The kiosk / donation-site flow over the Fabric at contract v2: type a student ID → confirm the name
 * → see the balance and siblings → pay for any of them. There is no PIN anywhere in it.
 *
 * The rules these tests exist to hold:
 *   1. `identify` confirms a NAME and nothing else — no balance, no invoices, no siblings, not even the
 *      family id. That thinness is what makes it safe to answer before the parent has confirmed
 *      anything, so if someone later "helpfully" adds a balance to it, these fail.
 *   2. Both code endpoints share ONE lockout bucket, so sweeping IDs through whichever answers faster
 *      gains nothing. With no secret behind the ID, that limiter is the whole defence (§11.2, §14).
 *   3. A v1 request still works for info / record-payment / check — an un-upgraded Donations or Kiosk
 *      build must not lose its money path just because `lookup` changed shape.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { freshApp, makeCtx } from './harness';
import { families, students, feePlans, studentFees, invoices, invoiceItems, payments, paymentAllocations, settings } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let http: FastifyInstance;

const SECRET = 'test-secret'; // freshApp({fabric:true}) sets OPENMASJID_APP_SECRET to this
const caller = (role: Role) => app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

/** POST a Fabric method the way the OS broker would, with our own secret as the platform proof. */
async function post(method: string, body: unknown, opts: { secret?: string; tunnel?: boolean } = {}) {
  const res = await http.inject({
    method: 'POST',
    url: `/fabric/billing/${method}`,
    payload: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      'x-openmasjid-app-secret': opts.secret ?? SECRET,
      ...(opts.tunnel ? { 'cf-ray': 'test' } : {}),
    },
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

/** One family, two children, one open invoice. Returns both children's Student IDs. */
async function seed() {
  const admin = caller('admin');
  const fam = await admin.people.familyCreate({ name: 'Ismail' });
  const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
  const a = await admin.people.studentCreate({ familyId: fam.id, firstName: 'Yusuf', lastName: 'Ismail', feePlanId: plan.id });
  const b = await admin.people.studentCreate({ familyId: fam.id, firstName: 'Maryam', lastName: 'Ismail', feePlanId: plan.id });
  await admin.billing.generatePeriod({ periodKey: '2026-07', label: 'Tuition — Jul 2026' });
  return { famId: fam.id, a: { id: a.id, code: a.studentCode }, b: { id: b.id, code: b.studentCode } };
}

beforeAll(async () => {
  app = await freshApp({ fabric: true });
  const { registerFabricProvider } = await import('../src/fabric/provider'); // AFTER env is set
  http = Fastify();
  registerFabricProvider(http);
  await http.ready();
});

beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, students, families, settings]) db.delete(t).run();
});

describe('identify — confirm the name, and nothing more', () => {
  it('returns the matched child’s first name and last initial', async () => {
    const s = await seed();
    const r = await post('identify', { v: 2, studentCode: s.a.code });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ v: 2, found: true, student: { studentCode: s.a.code, firstName: 'Yusuf', lastInitial: 'I' } });
  });

  it('accepts what a parent actually types — lowercase, spaces, a hyphen', async () => {
    const s = await seed();
    const messy = `${s.a.code.slice(0, 3).toLowerCase()}-${s.a.code.slice(3)}`;
    const r = await post('identify', { v: 2, studentCode: messy });
    expect((r.body as { found: boolean }).found).toBe(true);
  });

  // The invariant. A code is guessable; it must not be a key to the family's money.
  it('leaks NOTHING payable — no balance, invoices, siblings, family id or full last name', async () => {
    const s = await seed();
    const r = await post('identify', { v: 2, studentCode: s.a.code });
    const flat = JSON.stringify(r.body);
    for (const forbidden of ['balance', 'Cents', 'openInvoices', 'family', 'Ismail']) {
      expect(flat).not.toContain(forbidden);
    }
    expect(Object.keys((r.body as { student: object }).student).sort()).toEqual(['firstName', 'lastInitial', 'studentCode']);
  });

  it('is uniformly not-found for an unknown code, a withdrawn child, and a blank', async () => {
    const s = await seed();
    const admin = caller('admin');
    await admin.people.studentUpdate({ id: s.b.id, status: 'withdrawn' });
    for (const code of ['ZZZ9999', s.b.code, '   ']) {
      const r = await post('identify', { v: 2, studentCode: code });
      expect(r.body).toEqual({ v: 2, found: false });
    }
  });

  it('answers not-found when the admin has switched external tuition payments off', async () => {
    const s = await seed();
    await caller('admin').settings.set({ externalPayments: false });
    expect((await post('identify', { v: 2, studentCode: s.a.code })).body).toEqual({ v: 2, found: false });
  });

  it('locks a code after repeated failures, then stays uniform', async () => {
    await seed();
    // 6 failures is the cap. With no PIN behind the ID this limiter is the only thing standing between
    // a script and the ~10k codes per name prefix.
    for (let i = 0; i < 8; i++) {
      const r = await post('identify', { v: 2, studentCode: 'QQQ0001' });
      expect(r.body).toEqual({ v: 2, found: false });
    }
    // A locked code answers identically to a wrong one — no signal it exists.
    expect((await post('identify', { v: 2, studentCode: 'QQQ0001' })).body).toEqual({ v: 2, found: false });
  });

  it('still refuses without the platform secret, and over the tunnel', async () => {
    const s = await seed();
    expect((await post('identify', { v: 2, studentCode: s.a.code }, { secret: 'wrong' })).status).toBe(401);
    expect((await post('identify', { v: 2, studentCode: s.a.code }, { tunnel: true })).status).toBe(404);
  });
});

describe('lookup by studentCode — the paying step', () => {
  it('resolves the family and lists every sibling with their own code', async () => {
    const s = await seed();
    const r = await post('lookup', { v: 2, studentCode: s.a.code });
    const body = r.body as { v: number; found: boolean; matchedStudent: { id: string }; family: { students: { studentId: string; studentCode: string; firstName: string; lastInitial: string }[]; balanceCents: number } };
    expect(body.v).toBe(2);
    expect(body.found).toBe(true);
    expect(body.matchedStudent.id).toBe(s.a.id);
    // Both children, so the kiosk can offer the sibling WITHOUT the parent typing their ID.
    const names = body.family.students.map((k) => k.firstName).sort();
    expect(names).toEqual(['Maryam', 'Yusuf']);
    const sib = body.family.students.find((k) => k.firstName === 'Maryam')!;
    expect(sib.studentId).toBe(s.b.id);
    expect(sib.studentCode).toBe(s.b.code);
    expect(sib.lastInitial).toBe('I'); // initial only, never the full last name
    expect(body.family.balanceCents).toBeGreaterThan(0);
  });

  it('requires a studentCode — the v1 name+PIN body is refused outright', async () => {
    const s = await seed();
    expect((await post('lookup', { v: 2 })).status).toBe(400);
    // What a not-yet-updated Donations build would send. It cannot silently half-work.
    expect((await post('lookup', { v: 1, name: 'Yusuf Ismail', pin: '482913' })).status).toBe(400);
    // Nor can a caller smuggle the old shape past by adding a code they do have.
    expect((await post('lookup', { v: 2, studentCode: 'ZZZ9999', pin: '482913' })).body).toEqual({ v: 2, found: false });
  });

  it('is uniformly not-found for an unknown code, a withdrawn child, and when tuition is off', async () => {
    const s = await seed();
    await caller('admin').people.studentUpdate({ id: s.b.id, status: 'withdrawn' });
    expect((await post('lookup', { v: 2, studentCode: 'ZZZ9998' })).body).toEqual({ v: 2, found: false });
    expect((await post('lookup', { v: 2, studentCode: s.b.code })).body).toEqual({ v: 2, found: false });
    await caller('admin').settings.set({ externalPayments: false });
    expect((await post('lookup', { v: 2, studentCode: s.a.code })).body).toEqual({ v: 2, found: false });
  });

  // Rule 2: one bucket. Failing on `identify` must lock the same code on `lookup`.
  it('shares its lockout with identify — failures on one lock the other', async () => {
    const s = await seed();
    for (let i = 0; i < 6; i++) await post('identify', { v: 2, studentCode: 'RRR0002' });
    // A DIFFERENT endpoint, the same bad code: still locked.
    expect((await post('lookup', { v: 2, studentCode: 'RRR0002' })).body).toEqual({ v: 2, found: false });
    // And the reverse: burning a real code on lookup locks it for identify too.
    for (let i = 0; i < 6; i++) await post('lookup', { v: 2, studentCode: 'RRR0003' });
    expect((await post('identify', { v: 2, studentCode: 'RRR0003' })).body).toEqual({ v: 2, found: false });
    // The genuine code is untouched by all of that — lockout is per code, not global.
    expect((await post('lookup', { v: 2, studentCode: s.a.code })).body).toMatchObject({ found: true });
  });

  it('pays for a sibling using the id from the sibling list, no second lookup needed', async () => {
    const s = await seed();
    const look = (await post('lookup', { v: 2, studentCode: s.a.code })).body as { family: { id: string; students: { studentId: string; firstName: string }[] } };
    const sibling = look.family.students.find((k) => k.firstName === 'Maryam')!;
    const rec = await post('record-payment', {
      v: 2,
      idempotencyKey: 'pi_sibling_1',
      familyId: look.family.id,
      studentId: sibling.studentId,
      amountCents: 2500,
      currency: 'usd',
      channel: 'kiosk',
      occurredAt: '2026-07-15T18:03:22Z',
    });
    expect(rec.body).toMatchObject({ v: 2, recorded: true, duplicate: false });
    // Replay is still idempotent.
    const again = await post('record-payment', { v: 2, idempotencyKey: 'pi_sibling_1', familyId: look.family.id, amountCents: 2500, channel: 'kiosk', occurredAt: '2026-07-15T18:03:22Z' });
    expect(again.body).toMatchObject({ recorded: true, duplicate: true });
  });
});

// Rule 3. `lookup` is the only method whose shape changed, so everything else must keep serving a
// consumer that hasn't shipped its v2 update — losing record-payment would lose real money.
describe('v1 requests still work where the shape did not change', () => {
  it('accepts v: 1 on info, record-payment and check, answering v: 2', async () => {
    const s = await seed();
    expect((await post('info', { v: 1 })).body).toMatchObject({ v: 2, enabled: true });

    const rec = await post('record-payment', { v: 1, idempotencyKey: 'pi_v1_caller', familyId: s.famId, amountCents: 1000, channel: 'donations-web' });
    expect(rec.body).toMatchObject({ v: 2, recorded: true, duplicate: false });

    expect((await post('check', { v: 1, idempotencyKey: 'pi_v1_caller' })).body).toMatchObject({ v: 2, recorded: true });
    expect((await post('check', { v: 1, idempotencyKey: 'pi_never' })).body).toEqual({ v: 2, recorded: false });
  });

  it('refuses a version it does not know at all', async () => {
    await seed();
    expect((await post('info', { v: 3 })).status).toBe(400);
  });
});
