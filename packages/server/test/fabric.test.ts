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
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { freshApp, makeCtx } from './harness';
import { students, families, invoices, payments, paymentAllocations, invoiceItems, studentFees, feePlans, charges, chargeItems } from '../src/db/schema';
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
  // Order matters: `charges` points at the invoice line it became, so it goes before invoice_items.
  for (const t of [paymentAllocations, payments, charges, chargeItems, invoiceItems, invoices, studentFees, feePlans, students, families]) db.delete(t).run();
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
  const s = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });
  // Sara exists only to prove `lookup` returns siblings. studentCreate requires a plan, so she
  // carries the same one with a ZERO override — she bills nothing, and the family balance the
  // assertions below check stays exactly Yusuf's $50.
  await admin.people.studentCreate({ familyId: fam.id, fullName: 'Sara Ismail', feePlanId: plan.id, overrideAmountCents: 0 });
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

  it('tells a consumer that paying ahead is allowed, and the floor to put on its amount field', async () => {
    // Without this a kiosk has no way to tell "nothing due" from "cannot pay here", so it greys out
    // the amount field on a zero balance — refusing money the school wants (a parent paying a term up
    // front). Asserted because it is a promise to three other repos, not an implementation detail.
    const r = (await call('info', { v: 2 })).json();
    expect(r.allowAdvance).toBe(true);
    expect(r.minAmountCents).toBe(100);
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
    // ids so a kiosk can pay for a sibling without the parent typing their ID; the NAME minimization
    // is what this assertion guards, so check it field-by-field.
    expect(r.family.students.map((k: { firstName: string; lastInitial: string }) => ({ firstName: k.firstName, lastInitial: k.lastInitial }))).toEqual(
      expect.arrayContaining([
        { firstName: 'Yusuf', lastInitial: 'I' },
        { firstName: 'Sara', lastInitial: 'I' },
      ]),
    );
    // Each sibling entry exposes exactly these six fields and nothing more — `balanceCents` and
    // `creditCents` so a kiosk can show what each child owes, or has already paid ahead.
    for (const k of r.family.students) expect(Object.keys(k).sort()).toEqual(['balanceCents', 'creditCents', 'firstName', 'lastInitial', 'studentCode', 'studentId']);
    expect(JSON.stringify(r)).not.toContain('Ismail"'); // no bare "Ismail" last-name value in the payload
  });

  it('reports a credit, so "paid ahead" cannot read as "nothing to see here"', async () => {
    const { familyId, studentId, code } = await seed(); // one $50 invoice
    // Pay $80 against a $50 bill: $50 settles it, $30 is credit against the next one.
    await caller('admin').billing.recordManualPayment({ studentId, amountCents: 8000, channel: 'cash', occurredAt: '2026-07-10' });

    const r = (await call('lookup', { v: 2, studentCode: code })).json();
    expect(r.family.balanceCents).toBe(0);
    expect(r.family.creditCents).toBe(3000);
    expect(r.matchedStudent).toMatchObject({ id: studentId, balanceCents: 0, creditCents: 3000 });
    // Per child too — with one bill each, the household total cannot say which child is ahead.
    expect(r.family.students.find((k: { studentId: string }) => k.studentId === studentId)).toMatchObject({ balanceCents: 0, creditCents: 3000 });
    // The two are complementary: never both non-zero, so a consumer shows one or the other.
    for (const k of r.family.students) expect(Math.min(k.balanceCents, k.creditCents)).toBe(0);
    // A settled invoice is no longer "open", so the credit is the ONLY signal left that money is on
    // the account — which is exactly why it has to be on the wire.
    expect(r.family.openInvoices).toHaveLength(0);
    expect((await caller('admin').billing.familyBilling({ familyId })).balance.creditCents).toBe(3000);
  });

  /**
   * ITEMISED BILLS (0.43.0, additive). A kiosk used to get "Tuition — Jul 2026 · $250" and had no choice
   * but to make the parent accept the whole thing, even when $50 of it was a book fee. `items` is what
   * lets it list the two separately — and the arithmetic promise (the items add up to the invoice) is
   * what lets it sum whatever the parent ticks without a special case.
   */
  it('breaks each open invoice into its lines, which add up to the invoice', async () => {
    const admin = caller('admin');
    const fam = await admin.people.familyCreate({ name: 'Ismail family' });
    const plan = await admin.billing.feePlanCreate({ name: 'Monthly tuition', amountCents: 20000, cadence: 'monthly' });
    const s = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });
    await admin.billing.chargeAdd({ bill: 'period', studentId: s.id, source: { kind: 'custom', label: 'Book fee', amountCents: 5000 }, periodKey: '2026-07' });
    await admin.billing.generateFamily({ familyId: fam.id, periodKey: '2026-07', label: 'Tuition — Jul 2026', dueDate: '2026-07-01' });

    const inv = (await call('lookup', { v: 2, studentCode: s.studentCode })).json().family.openInvoices[0];
    expect(inv.items.map((i: { label: string; kind: string; balanceCents: number }) => [i.label, i.kind, i.balanceCents])).toEqual([
      ['Monthly tuition', 'tuition', 20000],
      ['Book fee', 'charge', 5000],
    ]);
    expect(inv.items.reduce((t: number, i: { balanceCents: number }) => t + i.balanceCents, 0)).toBe(inv.balanceCents);
    // Exactly these fields per line, so a consumer knows what it may rely on.
    for (const i of inv.items) expect(Object.keys(i).sort()).toEqual(['amountCents', 'balanceCents', 'id', 'kind', 'label']);
  });

  it('accepts the ID as typed — lowercase and punctuation are normalized away', async () => {
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

  it('takes money at the kiosk when NOTHING is due, and holds it as that child’s credit', async () => {
    // The paying-ahead case, end to end through the contract: a parent hands over a term's tuition in
    // Ramadan, before a single invoice for it exists. The consumer's own UI decides whether to offer
    // the amount field (see `info.allowAdvance`) — this proves the money lands correctly when it does.
    const admin = caller('admin');
    const fam = await admin.people.familyCreate({ name: 'Ismail family' });
    const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
    const s = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });
    expect((await admin.billing.familyBilling({ familyId: fam.id })).balance.owedCents).toBe(0);

    const r = (await call('record-payment', { v: 2, idempotencyKey: 'pi_AHEAD', familyId: fam.id, amountCents: 15000, channel: 'kiosk' })).json();
    expect(r).toMatchObject({ recorded: true, duplicate: false });
    // Credit on the child, not a number parked on the household — and the next bills consume it.
    expect((await admin.billing.studentBilling({ studentId: s.id })).balance.creditCents).toBe(15000);
    await admin.billing.generateFamily({ familyId: fam.id, periodKey: '2026-08', label: 'Tuition — Aug 2026', dueDate: '2026-08-01' });
    const after = await admin.billing.studentBilling({ studentId: s.id });
    expect(after.invoices[0].status).toBe('paid');
    expect(after.balance.creditCents).toBe(10000);
  });

  it('unknown family → 404 family_not_found', async () => {
    const r = await call('record-payment', { v: 2, idempotencyKey: 'k', familyId: 'fam_nope', amountCents: 100, channel: 'kiosk' });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('family_not_found');
  });

  /**
   * A mismatched `currency` is WARNED ABOUT, never refused [OMS-015].
   *
   * The field has been in the contract since v1 and this app has never read it — amounts are integer
   * cents rendered in the school's own currency, so "eur" against a usd install records EUR 150.00 as
   * $150.00. Refusing it is not an option on this path: Stripe has already taken the card by the time
   * we are called, so a 422 would strand a real charge and leave a consumer outbox retrying into a
   * deterministic failure forever. It also cannot change shape unilaterally — four repos share this
   * contract (see docs/audit/ACTION_REQUIRED.md).
   *
   * So the guarantee to pin is that the money still lands. The log line is the visibility.
   */
  it('records the money even when the currency does not match, and says so in the log', async () => {
    const { familyId } = await seed();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await call('record-payment', { v: 2, idempotencyKey: 'pi_EUR', familyId, amountCents: 3000, currency: 'eur', channel: 'kiosk' });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ recorded: true, duplicate: false });
      // Money is never lost over a currency label: the ledger applied it (5000 → 2000).
      expect((await caller('admin').billing.familyBilling({ familyId })).balance.owedCents).toBe(2000);
      expect(warn.mock.calls.flat().join(' ')).toMatch(/currency does not match/);
    } finally {
      warn.mockRestore();
    }
  });

  it('says nothing when the currency matches', async () => {
    const { familyId } = await seed();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // 'USD' — the check is case-insensitive, so the school's own currency in caps is not a mismatch.
      const r = await call('record-payment', { v: 2, idempotencyKey: 'pi_USD', familyId, amountCents: 1000, currency: 'USD', channel: 'kiosk' });
      expect(r.statusCode).toBe(200);
      expect(warn.mock.calls.flat().join(' ')).not.toMatch(/currency does not match/);
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * PAYING ONE LINE (0.43.0). A parent at the kiosk ticks the book fee and nothing else.
   *
   * The oldest-due-first house rule would have put that money on the tuition; the instruction is what
   * overrides it, and the second half of this test is the part that matters — generating the next month
   * recomputes every allocation, and the book fee must STILL read as settled afterwards.
   */
  it('honors a parent’s choice of lines, and it survives the next month', async () => {
    const admin = caller('admin');
    const fam = await admin.people.familyCreate({ name: 'Ismail family' });
    const plan = await admin.billing.feePlanCreate({ name: 'Monthly tuition', amountCents: 20000, cadence: 'monthly' });
    const s = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });
    await admin.billing.chargeAdd({ bill: 'period', studentId: s.id, source: { kind: 'custom', label: 'Book fee', amountCents: 5000 }, periodKey: '2026-07' });
    await admin.billing.generateFamily({ familyId: fam.id, periodKey: '2026-07', label: 'Tuition — Jul 2026', dueDate: '2026-07-01' });

    const items = (await call('lookup', { v: 2, studentCode: s.studentCode })).json().family.openInvoices[0].items;
    const book = items.find((i: { label: string }) => i.label === 'Book fee');
    const r = await call('record-payment', { v: 2, idempotencyKey: 'pi_BOOK', familyId: fam.id, amountCents: 5000, channel: 'kiosk', lines: [{ itemId: book.id, amountCents: 5000 }] });
    expect(r.json()).toMatchObject({ recorded: true, duplicate: false });

    await admin.billing.generateFamily({ familyId: fam.id, periodKey: '2026-08', label: 'Tuition — Aug 2026', dueDate: '2026-08-01' });
    const after = (await call('lookup', { v: 2, studentCode: s.studentCode })).json().family.openInvoices;
    const july = after.find((i: { label: string }) => i.label === 'Tuition — Jul 2026');
    // The book fee is still LISTED — a part-paid bill should say what is already dealt with — but it is
    // settled, and the tuition it would otherwise have been swallowed by is untouched.
    expect(july.items.map((i: { label: string; balanceCents: number }) => [i.label, i.balanceCents])).toEqual([
      ['Monthly tuition', 20000],
      ['Book fee', 0],
    ]);
    expect(july.balanceCents).toBe(20000);
  });

  it('refuses lines that do not add up, or that belong to another family', async () => {
    const admin = caller('admin');
    const { familyId } = await seed();
    const other = await admin.people.familyCreate({ name: 'Farooqi family' });
    const plan = await admin.billing.feePlanCreate({ name: 'Tuition B', amountCents: 5000, cadence: 'monthly' });
    const theirs = await admin.people.studentCreate({ familyId: other.id, fullName: 'Bilal Farooqi', feePlanId: plan.id });
    await admin.billing.generateFamily({ familyId: other.id, periodKey: '2026-07', label: 'Tuition — Jul 2026', dueDate: '2026-07-01' });
    const theirLine = (await admin.billing.studentPayables({ studentId: theirs.id })).lines[0];

    const mismatch = await call('record-payment', { v: 2, idempotencyKey: 'pi_SUM', familyId, amountCents: 9999, channel: 'kiosk', lines: [{ itemId: theirLine.itemId, amountCents: 5000 }] });
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json().error.code).toBe('invalid_allocation');

    // A line belonging to a DIFFERENT household must never be payable through this family's session.
    const crossFamily = await call('record-payment', { v: 2, idempotencyKey: 'pi_CROSS', familyId, amountCents: 5000, channel: 'kiosk', lines: [{ itemId: theirLine.itemId, amountCents: 5000 }] });
    expect(crossFamily.statusCode).toBe(422);
    expect((await admin.billing.studentBilling({ studentId: theirs.id })).balance.owedCents).toBe(5000);
  });

  /**
   * Stripe has already taken the card by the time record-payment runs, so an allocation the bills cannot
   * absorb must never cost a recorded payment. It is a HINT: direct what fits, and the rest is ordinary
   * money on that child (credit, if there is nothing left to pay). Refusing would leave a captured charge
   * unrecorded and the consumer's outbox retrying the same 422 forever.
   */
  it('records the money when an allocation asks for more than the bill can absorb', async () => {
    const admin = caller('admin');
    const { familyId, studentId } = await seed(); // one $50 July invoice
    const july = (await admin.billing.studentBilling({ studentId })).invoices[0];
    // The office takes $50 in cash between the kiosk's lookup and its record-payment.
    await admin.billing.recordManualPayment({ studentId, amountCents: 5000, channel: 'cash', occurredAt: '2026-07-10' });

    const r = await call('record-payment', { v: 2, idempotencyKey: 'pi_RESIDUE', familyId, amountCents: 5000, channel: 'kiosk', allocations: [{ invoiceId: july.id, amountCents: 5000 }] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ recorded: true, duplicate: false });
    // Nothing left to pay, so it is held as that child's credit — money is never lost.
    expect((await admin.billing.studentBilling({ studentId })).balance.creditCents).toBe(5000);
  });

  /** A consumer that builds `students[]` one entry per OPEN INVOICE sends the same child twice. Each row
   *  is keyed by child, so without merging the second is swallowed as a replay of the first — half a real
   *  charge dropped while the response says it was recorded. */
  it('merges two entries for the same child instead of dropping one', async () => {
    const admin = caller('admin');
    const { familyId, studentId } = await seed();
    await admin.billing.generateFamily({ familyId, periodKey: '2026-08', label: 'Tuition — Aug 2026', dueDate: '2026-08-01' });

    const r = await call('record-payment', {
      v: 2,
      idempotencyKey: 'pi_DUPE',
      familyId,
      amountCents: 10000,
      channel: 'kiosk',
      students: [{ studentId, amountCents: 5000 }, { studentId, amountCents: 5000 }],
    });
    expect(r.json()).toMatchObject({ recorded: true, duplicate: false });
    // The WHOLE $100 landed: both July and August are settled.
    const invs = (await admin.billing.studentBilling({ studentId })).invoices;
    expect(invs.every((i) => i.status === 'paid')).toBe(true);
    expect((await admin.billing.studentBilling({ studentId })).balance.owedCents).toBe(0);
  });

  /** `allocations` has been in the contract since v1 and was parsed and then thrown away until 0.43.0 —
   *  a consumer asking for a specific invoice silently got oldest-due-first instead. */
  it('honors invoice-level allocations, which used to be ignored', async () => {
    const admin = caller('admin');
    const { familyId, studentId } = await seed(); // one $50 July invoice
    await admin.billing.generateFamily({ familyId, periodKey: '2026-08', label: 'Tuition — Aug 2026', dueDate: '2026-08-01' });
    const august = (await admin.billing.studentBilling({ studentId })).invoices.find((i) => i.periodKey === '2026-08')!;

    await call('record-payment', { v: 2, idempotencyKey: 'pi_ALLOC', familyId, amountCents: 5000, channel: 'donations-web', allocations: [{ invoiceId: august.id, amountCents: 5000 }] });

    const invs = (await admin.billing.studentBilling({ studentId })).invoices;
    expect(invs.find((i) => i.periodKey === '2026-08')).toMatchObject({ status: 'paid' });
    expect(invs.find((i) => i.periodKey === '2026-07')).toMatchObject({ status: 'open' }); // older, deliberately untouched
  });
});
