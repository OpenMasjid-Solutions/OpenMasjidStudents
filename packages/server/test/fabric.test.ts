// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The Fabric provider contract (CLAUDE.md §11) — students/billing at v2. Verifies the transport gates
 * (constant-time secret; tunnel-origin refused) and the methods: info, the Student-ID lookup (uniform
 * found:false with no last-name/DOB leak, per-code lockout), the idempotent record-payment (through
 * the ledger), and check. Driven through a real Fastify instance via inject.
 *
 * The kiosk-facing half of the contract — identify, the shared lockout, v1 back-compat — lives in
 * fabricIdentify.test.ts.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { freshApp, makeCtx } from './harness';
import { students, families, invoices, payments, paymentAllocations, invoiceItems, studentFees, feePlans } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let http: FastifyInstance;
const SECRET = 'test-secret'; // freshApp({fabric:true}) sets OPENMASJID_APP_SECRET to this
const caller = (role: Role) => app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp({ fabric: true });
  const { registerFabricProvider } = await import('../src/fabric/provider'); // AFTER env is set
  http = Fastify();
  registerFabricProvider(http);
  await http.ready();
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, students, families]) db.delete(t).run();
});

const call = (method: string, body: unknown, opts: { secret?: string | null; tunnel?: boolean } = {}) =>
  http.inject({
    method: 'POST',
    url: `/fabric/billing/${method}`,
    headers: {
      'content-type': 'application/json',
      ...(opts.secret === null ? {} : { 'x-openmasjid-app-secret': opts.secret ?? SECRET }),
      ...(opts.tunnel ? { 'cf-ray': 'test' } : {}),
    },
    payload: JSON.stringify(body),
  });

/** Seed a family with a student + a fee + an open invoice; returns the ids and the Student ID. */
async function seed() {
  const admin = caller('admin');
  const fam = await admin.people.familyCreate({ name: 'Ismail family' });
  const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
  const s = await admin.people.studentCreate({ familyId: fam.id, firstName: 'Yusuf', lastName: 'Ismail', feePlanId: plan.id });
  // Sara exists only to prove `lookup` returns siblings. studentCreate requires a plan, so she
  // carries the same one with a ZERO override — she bills nothing, and the family balance the
  // assertions below check stays exactly Yusuf's $50.
  await admin.people.studentCreate({ familyId: fam.id, firstName: 'Sara', lastName: 'Ismail', feePlanId: plan.id, overrideAmountCents: 0 });
  await admin.billing.generateFamily({ familyId: fam.id, periodKey: '2026-07', label: 'Tuition — Jul 2026', dueDate: '2026-07-01' });
  return { familyId: fam.id, studentId: s.id, code: s.studentCode };
}

describe('transport gates (§11.1)', () => {
  it('401 without/with a wrong secret; refuses tunnel-origin even with the right secret', async () => {
    expect((await call('info', { v: 2 }, { secret: null })).statusCode).toBe(401);
    expect((await call('info', { v: 2 }, { secret: 'wrong' })).statusCode).toBe(401);
    expect((await call('info', { v: 2 }, { tunnel: true })).statusCode).toBe(404);
    expect((await call('info', { v: 2 })).statusCode).toBe(200);
  });
});

describe('info (§11.2)', () => {
  it('returns v:2 + school + currency + enabled', async () => {
    const r = await call('info', { v: 2 });
    expect(r.json()).toMatchObject({ v: 2, enabled: true, currency: 'usd' });
    expect(typeof r.json().schoolName).toBe('string');
  });
});

describe('lookup (§11.2)', () => {
  it('resolves a Student ID → family + balance; no full last names or DOB', async () => {
    const { familyId, studentId, code } = await seed();
    const r = (await call('lookup', { v: 2, studentCode: code })).json();
    expect(r).toMatchObject({ v: 2, found: true, matchedStudent: { id: studentId } });
    expect(r.family.id).toBe(familyId);
    expect(r.family.balanceCents).toBe(5000);
    expect(r.family.openInvoices).toHaveLength(1);
    // Only first name + last initial — never a full last name. Each sibling also carries their own
    // ids so a kiosk can pay for a sibling without the parent typing their ID; the NAME minimisation
    // is what this assertion guards, so check it field-by-field.
    expect(r.family.students.map((k: { firstName: string; lastInitial: string }) => ({ firstName: k.firstName, lastInitial: k.lastInitial }))).toEqual(
      expect.arrayContaining([
        { firstName: 'Yusuf', lastInitial: 'I' },
        { firstName: 'Sara', lastInitial: 'I' },
      ]),
    );
    // Each sibling entry exposes exactly these five fields and nothing more — `balanceCents` is new
    // at v2 so a kiosk can show what each child owes.
    for (const k of r.family.students) expect(Object.keys(k).sort()).toEqual(['balanceCents', 'firstName', 'lastInitial', 'studentCode', 'studentId']);
    expect(JSON.stringify(r)).not.toContain('Ismail"'); // no bare "Ismail" last-name value in the payload
  });

  it('accepts the ID as typed — lowercase and punctuation are normalised away', async () => {
    const { code } = await seed();
    expect((await call('lookup', { v: 2, studentCode: `${code.slice(0, 3).toLowerCase()} ${code.slice(3)}` })).json().found).toBe(true);
  });

  it('an unknown ID gives a bare found:false', async () => {
    await seed();
    expect((await call('lookup', { v: 2, studentCode: 'ZZZ0000' })).json()).toEqual({ v: 2, found: false });
  });

  it('per-code lockout: after 6 failed lookups that ID is locked', async () => {
    await seed();
    for (let i = 0; i < 6; i++) await call('lookup', { v: 2, studentCode: 'WWW1111' });
    expect((await call('lookup', { v: 2, studentCode: 'WWW1111' })).json()).toEqual({ v: 2, found: false }); // locked
  });
});

describe('record-payment + check (§11.3/§11.4)', () => {
  it('records once, is idempotent on replay, and check finds it', async () => {
    const { familyId } = await seed();
    const body = { v: 2, idempotencyKey: 'pi_TEST123', familyId, amountCents: 3000, channel: 'donations-web', occurredAt: '2026-07-15T18:03:22Z' };
    const first = (await call('record-payment', body)).json();
    expect(first).toMatchObject({ v: 2, recorded: true, duplicate: false });
    const replay = (await call('record-payment', body)).json();
    expect(replay).toMatchObject({ recorded: true, duplicate: true, paymentId: first.paymentId });
    // The ledger applied it: balance dropped 5000 → 2000.
    expect((await caller('admin').billing.familyBilling({ familyId })).balance.owedCents).toBe(2000);
    // check.
    expect((await call('check', { v: 2, idempotencyKey: 'pi_TEST123' })).json()).toMatchObject({ v: 2, recorded: true, paymentId: first.paymentId });
    expect((await call('check', { v: 2, idempotencyKey: 'nope' })).json()).toEqual({ v: 2, recorded: false });
  });

  it('unknown family → 404 family_not_found', async () => {
    const r = await call('record-payment', { v: 2, idempotencyKey: 'k', familyId: 'fam_nope', amountCents: 100, channel: 'kiosk' });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('family_not_found');
  });
});
