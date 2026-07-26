// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The kiosk flow over the Fabric: type a student ID → confirm the name → enter the PIN → see the
 * family and its siblings → pay for any of them.
 *
 * The load-bearing rule these tests exist to hold: **a student ID is not a secret.** Its letters come
 * from the child's first name and it is printed on statements, so `identify` may confirm a name and
 * nothing else — no balance, no invoices, no siblings, not even the family id. Releasing anything
 * payable still requires the PIN through `lookup` (§11.2, §14). If someone later "helpfully" adds a
 * balance to the identify response, these tests fail.
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

/** One family, two children, one open invoice. Returns both children's codes + pins. */
async function seed() {
  const admin = caller('admin');
  const fam = await admin.people.familyCreate({ name: 'Ismail' });
  const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
  const a = await admin.people.studentCreate({ familyId: fam.id, firstName: 'Yusuf', lastName: 'Ismail', feePlanId: plan.id });
  const b = await admin.people.studentCreate({ familyId: fam.id, firstName: 'Maryam', lastName: 'Ismail', feePlanId: plan.id });
  await admin.billing.generatePeriod({ periodKey: '2026-07', label: 'Tuition — Jul 2026' });
  const rows = app.dbmod.db.select().from(students).all();
  const ra = rows.find((r) => r.id === a.id)!;
  const rb = rows.find((r) => r.id === b.id)!;
  return { famId: fam.id, a: { id: a.id, code: ra.studentCode!, pin: ra.pin }, b: { id: b.id, code: rb.studentCode!, pin: rb.pin } };
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
    const r = await post('identify', { v: 1, studentCode: s.a.code });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ v: 1, found: true, student: { studentCode: s.a.code, firstName: 'Yusuf', lastInitial: 'I' } });
  });

  it('accepts what a parent actually types — lowercase, spaces, a hyphen', async () => {
    const s = await seed();
    const messy = `${s.a.code.slice(0, 3).toLowerCase()}-${s.a.code.slice(3)}`;
    const r = await post('identify', { v: 1, studentCode: messy });
    expect((r.body as { found: boolean }).found).toBe(true);
  });

  // The invariant. A code is guessable; it must not be a key to the family's money.
  it('leaks NOTHING payable — no balance, invoices, siblings, family id or full last name', async () => {
    const s = await seed();
    const r = await post('identify', { v: 1, studentCode: s.a.code });
    const flat = JSON.stringify(r.body);
    for (const forbidden of ['balance', 'Cents', 'openInvoices', 'family', 'Ismail', 'pin']) {
      expect(flat).not.toContain(forbidden);
    }
    expect(Object.keys((r.body as { student: object }).student).sort()).toEqual(['firstName', 'lastInitial', 'studentCode']);
  });

  it('is uniformly not-found for an unknown code, a withdrawn child, and a blank', async () => {
    const s = await seed();
    const admin = caller('admin');
    await admin.people.studentUpdate({ id: s.b.id, status: 'withdrawn' });
    for (const code of ['ZZZ9999', s.b.code, '   ']) {
      const r = await post('identify', { v: 1, studentCode: code });
      expect(r.body).toEqual({ v: 1, found: false });
    }
  });

  it('answers not-found when the admin has switched external tuition payments off', async () => {
    const s = await seed();
    await caller('admin').settings.set({ externalPayments: false });
    expect((await post('identify', { v: 1, studentCode: s.a.code })).body).toEqual({ v: 1, found: false });
  });

  it('locks a code after repeated failures, then stays uniform', async () => {
    await seed();
    // 6 failures is the cap (harder than the PIN's 10 — a code is far more guessable).
    for (let i = 0; i < 8; i++) {
      const r = await post('identify', { v: 1, studentCode: 'QQQ0001' });
      expect(r.body).toEqual({ v: 1, found: false });
    }
    // A locked code answers identically to a wrong one — no signal it exists.
    expect((await post('identify', { v: 1, studentCode: 'QQQ0001' })).body).toEqual({ v: 1, found: false });
  });

  it('still refuses without the platform secret, and over the tunnel', async () => {
    const s = await seed();
    expect((await post('identify', { v: 1, studentCode: s.a.code }, { secret: 'wrong' })).status).toBe(401);
    expect((await post('identify', { v: 1, studentCode: s.a.code }, { tunnel: true })).status).toBe(404);
  });
});

describe('lookup by studentCode + PIN — the paying step', () => {
  it('resolves the family and lists every sibling with their own code', async () => {
    const s = await seed();
    const r = await post('lookup', { v: 1, studentCode: s.a.code, pin: s.a.pin });
    const body = r.body as { found: boolean; matchedStudent: { id: string }; family: { students: { studentId: string; studentCode: string; firstName: string; lastInitial: string }[]; balanceCents: number } };
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

  it('refuses a valid code with the WRONG pin — and with a SIBLING’s pin', async () => {
    const s = await seed();
    expect((await post('lookup', { v: 1, studentCode: s.a.code, pin: '000000' })).body).toEqual({ v: 1, found: false });
    // The sibling's PIN is a real PIN in this install; pairing it with the wrong code must not match.
    expect((await post('lookup', { v: 1, studentCode: s.a.code, pin: s.b.pin })).body).toEqual({ v: 1, found: false });
  });

  it('requires a pin, and requires one of name / studentCode', async () => {
    const s = await seed();
    expect((await post('lookup', { v: 1, studentCode: s.a.code })).status).toBe(400);
    expect((await post('lookup', { v: 1, pin: s.a.pin })).status).toBe(400);
  });

  // Back-compat: Donations and Kiosk already ship the name+pin call.
  it('still works exactly as before with name + pin', async () => {
    const s = await seed();
    const r = await post('lookup', { v: 1, name: 'Yusuf Ismail', pin: s.a.pin });
    expect((r.body as { found: boolean; matchedStudent: { id: string } }).found).toBe(true);
    expect((r.body as { matchedStudent: { id: string } }).matchedStudent.id).toBe(s.a.id);
  });

  it('pays for a sibling using the id from the sibling list, no second lookup needed', async () => {
    const s = await seed();
    const look = (await post('lookup', { v: 1, studentCode: s.a.code, pin: s.a.pin })).body as { family: { id: string; students: { studentId: string; firstName: string }[] } };
    const sibling = look.family.students.find((k) => k.firstName === 'Maryam')!;
    const rec = await post('record-payment', {
      v: 1,
      idempotencyKey: 'pi_sibling_1',
      familyId: look.family.id,
      studentId: sibling.studentId,
      amountCents: 2500,
      currency: 'usd',
      channel: 'kiosk',
      occurredAt: '2026-07-15T18:03:22Z',
    });
    expect(rec.body).toMatchObject({ v: 1, recorded: true, duplicate: false });
    // Replay is still idempotent.
    const again = await post('record-payment', { v: 1, idempotencyKey: 'pi_sibling_1', familyId: look.family.id, amountCents: 2500, channel: 'kiosk', occurredAt: '2026-07-15T18:03:22Z' });
    expect(again.body).toMatchObject({ recorded: true, duplicate: true });
  });
});
