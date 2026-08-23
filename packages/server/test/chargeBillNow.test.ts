// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * BILLING A ONE-OFF CHARGE ON ITS OWN, RIGHT AWAY (0.51.0-dev.10) — now the default.
 *
 * The gap it closes: a book fee added in the middle of August was payable only once somebody generated
 * August's tuition. An office that had not billed the month yet had to either generate the whole month
 * early — committing every child's tuition — or tell the parent to wait.
 *
 * THE HAZARD IS WHY THIS IS NOT SIMPLY "MAKE AN INVOICE", and it is the test that matters most below.
 * `invoices` is UNIQUE on (student, period_key), and `generateForStudent` returns early when an invoice
 * for that period already exists. So an immediate invoice keyed `2026-08` would BE that student's August
 * invoice, and the real August tuition run would silently skip them — a family billed for a book and
 * never for their tuition, with a bill on screen to make it look like it worked. Hence a per-charge key
 * (`charge-<id>`) that is unique by construction and not month-shaped.
 *
 * The second guard is that the charge flips to `invoiced` in the same transaction, and generation only
 * ever picks up `pending` charges — so no later run can bill it again.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { paymentAllocations, payments, charges, invoiceItems, invoices, chargeItems, studentFees, feePlans, students, classes, courses, families, terms, schoolYears, users, auditLog } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
const caller = (role: Role) => app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp();
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, charges, invoiceItems, invoices, chargeItems, studentFees, feePlans, students, classes, courses, families, terms, schoolYears, users, auditLog]) db.delete(t).run();
});

/** A family with one student on a $50 monthly plan. */
async function seed() {
  const admin = caller('admin');
  const fam = await admin.people.familyCreate({ name: 'Ismail' });
  const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
  const s = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });
  return { admin, familyId: fam.id, studentId: s.id, planId: plan.id };
}

const today = () => new Date().toISOString().slice(0, 10);

describe('a charge billed on its own', () => {
  it('becomes a bill of its own, payable now, without generating the month', async () => {
    const { admin, studentId, familyId } = await seed();
    const r = await admin.billing.chargeAdd({ studentId, source: { kind: 'custom', label: 'Book fee', amountCents: 5000 } });
    expect(r.billedNow).toBe(true);
    expect(r.invoiceId).toBeTruthy();

    const bill = await admin.billing.familyBilling({ familyId });
    // ONE invoice, holding just the charge — no tuition committed on the way past.
    expect(bill.invoices).toHaveLength(1);
    expect(bill.invoices[0].label).toBe('Book fee');
    expect(bill.balance.owedCents).toBe(5000);
    // Due today: that is what makes it visible to autopay and to the past-due chase.
    expect(bill.invoices[0].dueDate).toBe(today());
  });

  it('is the DEFAULT, so an office that says nothing still gets a payable bill', async () => {
    const { admin, studentId } = await seed();
    const r = await admin.billing.chargeAdd({ studentId, source: { kind: 'custom', label: 'Trip', amountCents: 1500 } });
    expect(r.billedNow).toBe(true);
  });

  /** THE ONE THAT MATTERS — see the file header. Both bills must exist. */
  it('does not consume the month, so tuition still generates afterwards', async () => {
    const { admin, studentId, familyId } = await seed();
    await admin.billing.chargeAdd({ studentId, source: { kind: 'custom', label: 'Book fee', amountCents: 5000 } });

    const gen = await admin.billing.generatePeriod({ periodKey: '2026-08', label: 'Aug 2026' });
    expect(gen.created).toBeGreaterThan(0);

    const bill = await admin.billing.familyBilling({ familyId });
    expect(bill.invoices).toHaveLength(2);
    expect(bill.invoices.some((i) => i.periodKey === '2026-08')).toBe(true);
    // $50 book fee + $50 tuition. Neither swallowed the other.
    expect(bill.balance.owedCents).toBe(10_000);
  });

  it('is never picked up again by a later generation', async () => {
    const { admin, studentId } = await seed();
    await admin.billing.chargeAdd({ studentId, source: { kind: 'custom', label: 'Book fee', amountCents: 5000 } });
    await admin.billing.generatePeriod({ periodKey: '2026-08', label: 'Aug 2026' });
    await admin.billing.generatePeriod({ periodKey: '2026-09', label: 'Sep 2026' });

    expect(app.dbmod.db.select().from(invoiceItems).all().filter((i) => i.description === 'Book fee')).toHaveLength(1);
    const row = app.dbmod.db.select().from(charges).all()[0];
    expect(row.status).toBe('invoiced');
    // Billed on its own belongs to no period. A stored month here would read as "not billed yet".
    expect(row.periodKey).toBeNull();
  });

  it('settles like any other bill', async () => {
    const { admin, studentId, familyId } = await seed();
    const r = await admin.billing.chargeAdd({ studentId, source: { kind: 'custom', label: 'Uniform', amountCents: 2000 } });
    await admin.billing.recordManualPayment({ studentId, amountCents: 2000, channel: 'cash', occurredAt: today() });
    const bill = await admin.billing.familyBilling({ familyId });
    expect(bill.balance.owedCents).toBe(0);
    expect(bill.invoices.find((i) => i.id === r.invoiceId)?.status).toBe('paid');
  });

  it('comes out of a credit the family is already sitting on', async () => {
    const { admin, studentId, familyId } = await seed();
    // Paid ahead with nothing owed yet — the money sits as this child's credit.
    await admin.billing.recordManualPayment({ studentId, amountCents: 5000, channel: 'cash', occurredAt: '2026-08-01' });
    expect((await admin.billing.familyBilling({ familyId })).balance.creditCents).toBe(5000);

    await admin.billing.chargeAdd({ studentId, source: { kind: 'custom', label: 'Book fee', amountCents: 5000 } });
    const bill = await admin.billing.familyBilling({ familyId });
    expect(bill.balance.owedCents).toBe(0);
    expect(bill.balance.creditCents).toBe(0);
  });

  it('bills each child their own, not one shared bill', async () => {
    const { admin, studentId } = await seed();
    const fam2 = await admin.people.familyCreate({ name: 'Farooqi' });
    const plans = await admin.billing.feePlanList();
    const s2 = await admin.people.studentCreate({ familyId: fam2.id, fullName: 'Aisha Farooqi', feePlanId: plans[0].id });

    const r = await admin.billing.chargeAddBulk({
      source: { kind: 'custom', label: 'Trip', amountCents: 1000 },
      target: { kind: 'students', studentIds: [studentId, s2.id] },
    });
    expect(r.created).toBe(2);
    expect(r.billed).toBe(2);
    // Two separate invoices, one per child — bills are per student (§9), so a shared one is not a thing.
    expect(app.dbmod.db.select().from(invoices).all()).toHaveLength(2);
  });

  /**
   * …and `all` is deliberately NOT accepted here, even though the shared resolver understands it
   * (structure/audience.ts). One click that writes to every family is a different proposition from one
   * click that CHARGES every student, and this is the boundary that keeps them apart.
   */
  it('will not charge the entire school in one call', async () => {
    const { admin } = await seed();
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately sending what the message path accepts
      admin.billing.chargeAddBulk({ source: { kind: 'custom', label: 'Trip', amountCents: 1000 }, target: { kind: 'all' } as any }),
    ).rejects.toThrow();
  });
});

describe('what it refuses', () => {
  /**
   * A CREDIT CANNOT BE A BILL OF ITS OWN. Its whole purpose is to reduce something, and alone it would be
   * an invoice with a negative balance — not payable, and nothing the allocator has a sensible answer
   * for. It falls back to the period rather than failing outright: the office chose an amount and a
   * target, and refusing the whole action over a default they never picked is the worse behavior.
   */
  it('puts a credit on the period instead of billing it alone', async () => {
    const { admin, studentId, familyId } = await seed();
    await admin.billing.generatePeriod({ periodKey: '2026-08', label: 'Aug 2026' });
    const r = await admin.billing.chargeAdd({ studentId, source: { kind: 'custom', label: 'Bursary', amountCents: -2000 }, periodKey: '2026-08' });
    expect(r.billedNow).toBe(false);
    expect(r.attached).toBe(true);

    const bill = await admin.billing.familyBilling({ familyId });
    // August's invoice, reduced — not a second negative one.
    expect(bill.invoices).toHaveLength(1);
    expect(bill.balance.owedCents).toBe(3000);
  });

  /** The minted key is reserved, for the same reason `carry-in` is: an office naming it by hand could
   *  land a whole period's run on top of a single charge's own invoice. */
  it('reserves the period key it mints', async () => {
    const { admin } = await seed();
    await expect(admin.billing.generatePeriod({ periodKey: 'charge-chg_abc', label: 'Nope' })).rejects.toThrow();
  });
});

describe('the period option is still there', () => {
  it('waits as pending when the month has not been generated', async () => {
    const { admin, studentId, familyId } = await seed();
    const r = await admin.billing.chargeAdd({ bill: 'period', studentId, source: { kind: 'custom', label: 'Book fee', amountCents: 5000 }, periodKey: '2026-08' });
    expect(r.billedNow).toBe(false);
    expect(r.attached).toBe(false);
    expect((await admin.billing.familyBilling({ familyId })).invoices).toHaveLength(0);

    // …and lands when that month is billed, on the same invoice as the tuition.
    await admin.billing.generatePeriod({ periodKey: '2026-08', label: 'Aug 2026' });
    const bill = await admin.billing.familyBilling({ familyId });
    expect(bill.invoices).toHaveLength(1);
    expect(bill.balance.owedCents).toBe(10_000);
  });

  it('lands on an already-open invoice for that month', async () => {
    const { admin, studentId, familyId } = await seed();
    await admin.billing.generatePeriod({ periodKey: '2026-08', label: 'Aug 2026' });
    const r = await admin.billing.chargeAdd({ bill: 'period', studentId, source: { kind: 'custom', label: 'Book fee', amountCents: 5000 }, periodKey: '2026-08' });
    expect(r.attached).toBe(true);
    expect(r.billedNow).toBe(false);
    const bill = await admin.billing.familyBilling({ familyId });
    expect(bill.invoices).toHaveLength(1);
    expect(bill.balance.owedCents).toBe(10_000);
  });
});
