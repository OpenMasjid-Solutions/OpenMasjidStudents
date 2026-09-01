// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Fee-plan CADENCE and the per-student amount OVERRIDE (billing/invoices.ts).
 *
 * Before this slice `fee_plans.cadence` was stored and never read, so a `one_time` plan re-billed
 * every single period — a live over-billing bug. These tests pin the corrected semantics:
 *
 *   monthly    → bills on a `month` period, never on a `term` period
 *   per_term   → bills on a `term` period, never on a `month` period
 *   one_time   → bills exactly ONCE, ever, on whichever period comes first
 *
 * plus: the effective amount is `override ?? plan.amount`, and voiding an invoice makes a
 * one-time fee billable again (its line no longer counts).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { paymentAllocations, payments, charges, invoiceItems, invoices, chargeItems, studentFees, feePlans, students, classes, courses, families, terms, schoolYears, users, auditLog } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
const caller = (role: Role, opts: { origin?: 'lan' | 'tunnel' } = {}) =>
  app.appRouter.createCaller(makeCtx({ origin: opts.origin ?? 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => { app = await freshApp(); });
beforeEach(() => {
  const { db } = app.dbmod;
  // Child-before-parent: every FK on the money/roster path is RESTRICT.
  for (const t of [paymentAllocations, payments, charges, invoiceItems, invoices, chargeItems, studentFees, feePlans, students, classes, courses, families, terms, schoolYears, users, auditLog]) db.delete(t).run();
});

/** One family, one student, on a plan of the given cadence. */
async function seed(cadence: 'monthly' | 'per_term' | 'one_time', amountCents = 5000, overrideAmountCents?: number) {
  const admin = caller('admin');
  const fam = await admin.people.familyCreate({ name: 'Ismail' });
  const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents, cadence });
  const s = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id, overrideAmountCents });
  return { admin, familyId: fam.id, studentId: s.id, planId: plan.id };
}

const totalOf = async (admin: ReturnType<typeof caller>, familyId: string, periodKey: string) => {
  const inv = (await admin.billing.familyBilling({ familyId })).invoices.find((i) => i.periodKey === periodKey);
  return inv ? inv.totalCents : null;
};

describe('cadence gates which periods a plan bills on', () => {
  it('a monthly plan bills every month period and NOTHING on a term period', async () => {
    const { admin, familyId } = await seed('monthly');
    await admin.billing.generateFamily({ familyId, periodKey: '2026-07', label: 'Jul' });
    await admin.billing.generateFamily({ familyId, periodKey: '2026-08', label: 'Aug' });
    expect(await totalOf(admin, familyId, '2026-07')).toBe(5000);
    expect(await totalOf(admin, familyId, '2026-08')).toBe(5000);
    // A term period has no monthly line to draw, so no invoice is created at all.
    const term = await admin.billing.generateFamily({ familyId, periodKey: 'T1', label: 'Term 1', periodKind: 'term' });
    expect(term.created).toBe(0);
    expect(await totalOf(admin, familyId, 'T1')).toBeNull();
  });

  it('a per-term plan bills a term period and NOTHING on a month period', async () => {
    const { admin, familyId } = await seed('per_term', 20000);
    const month = await admin.billing.generateFamily({ familyId, periodKey: '2026-07', label: 'Jul' });
    expect(month.created).toBe(0);
    const term = await admin.billing.generateFamily({ familyId, periodKey: 'T1', label: 'Term 1', periodKind: 'term' });
    expect(term.created).toBe(1);
    expect(await totalOf(admin, familyId, 'T1')).toBe(20000);
  });

  it('a one-time plan bills ONCE and never again — the old bug was re-billing every period', async () => {
    const { admin, familyId } = await seed('one_time', 15000);
    await admin.billing.generateFamily({ familyId, periodKey: '2026-07', label: 'Jul' });
    expect(await totalOf(admin, familyId, '2026-07')).toBe(15000);
    // Second period: already billed, so there is nothing to invoice.
    const second = await admin.billing.generateFamily({ familyId, periodKey: '2026-08', label: 'Aug' });
    expect(second.created).toBe(0);
    expect(await totalOf(admin, familyId, '2026-08')).toBeNull();
    const third = await admin.billing.generateFamily({ familyId, periodKey: 'T1', label: 'Term 1', periodKind: 'term' });
    expect(third.created).toBe(0);
  });

  /**
   * A VOIDED MONTH CAN BE BILLED AGAIN, and the charge that was on it comes back with it (0.51.0).
   *
   * Two defects met here. `invoices` is UNIQUE(student, period_key) and `generateForStudent` returned
   * early on ANY existing row, so a voided invoice kept the slot for good: after an office voided a bill
   * to correct it, that child could never be billed for that month again — not by hand, not by the
   * nightly job — and the only feedback was "Generated 0 invoice(s)", which reads like there was nothing
   * to bill. Voiding is how an office fixes a wrong bill, so it has to be something they can come back
   * from.
   *
   * And a CHARGE on the voided bill stayed marked `invoiced` against it: never re-billed, never owed,
   * invisible. A book fee voided along with February's tuition simply stopped being money. The existing
   * test above proves a one-time FEE PLAN becomes billable again; a charge is the line that was not
   * getting the same rule.
   */
  it('bills a voided month again rather than blocking it forever', async () => {
    const { admin, familyId } = await seed('monthly', 20000);
    await admin.billing.generateFamily({ familyId, periodKey: '2026-07', label: 'Jul' });
    const invId = (await admin.billing.familyBilling({ familyId })).invoices[0].id;
    await admin.billing.voidInvoice({ id: invId });

    // The SAME period, which used to be unbillable for good.
    const again = await admin.billing.generateFamily({ familyId, periodKey: '2026-07', label: 'Jul' });
    expect(again.created).toBe(1);
    expect(await totalOf(admin, familyId, '2026-07')).toBe(20000);
    // One invoice for the month, not a live one beside a void one.
    const rows = (await admin.billing.familyBilling({ familyId })).invoices.filter((i) => i.label === 'Jul');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).not.toBe('void');
  });

  it('hands back a charge that was on a voided bill, so it is owed again', async () => {
    const { admin, familyId } = await seed('monthly', 20000);
    const students = (await admin.billing.familyBilling({ familyId })).students;
    await admin.billing.chargeAdd({ studentId: students[0].id, source: { kind: 'custom', label: 'Book fee', amountCents: 5000 }, periodKey: '2026-07', bill: 'period' });
    await admin.billing.generateFamily({ familyId, periodKey: '2026-07', label: 'Jul' });
    expect(await totalOf(admin, familyId, '2026-07')).toBe(25000); // tuition + the book fee

    const invId = (await admin.billing.familyBilling({ familyId })).invoices.find((i) => i.label === 'Jul')!.id;
    const voided = await admin.billing.voidInvoice({ id: invId });
    expect(voided.chargesReleased).toBe(1); // it says so, rather than dropping it silently

    // Regenerating the month picks the charge back up — it is still owed.
    await admin.billing.generateFamily({ familyId, periodKey: '2026-07', label: 'Jul' });
    expect(await totalOf(admin, familyId, '2026-07')).toBe(25000);
  });

  it('voiding the invoice makes a one-time fee billable again (its line stops counting)', async () => {
    const { admin, familyId } = await seed('one_time', 15000);
    await admin.billing.generateFamily({ familyId, periodKey: '2026-07', label: 'Jul' });
    const invId = (await admin.billing.familyBilling({ familyId })).invoices[0].id;
    await admin.billing.voidInvoice({ id: invId });
    const again = await admin.billing.generateFamily({ familyId, periodKey: '2026-08', label: 'Aug' });
    expect(again.created).toBe(1);
    expect(await totalOf(admin, familyId, '2026-08')).toBe(15000);
  });
});

describe('per-student amount override', () => {
  it('bills the override instead of the plan amount, without a second plan', async () => {
    const { admin, familyId } = await seed('monthly', 5000, 35000);
    await admin.billing.generateFamily({ familyId, periodKey: '2026-07', label: 'Jul' });
    expect(await totalOf(admin, familyId, '2026-07')).toBe(35000);
  });

  it('a ZERO override bills nothing for that student while keeping them on the plan', async () => {
    const { admin, familyId } = await seed('monthly', 5000, 0);
    const gen = await admin.billing.generateFamily({ familyId, periodKey: '2026-07', label: 'Jul' });
    expect(gen.created).toBe(0); // the only line was zero, so there is no invoice
    // The assignment still exists — the student is on a plan, just at no charge.
    const fees = await admin.billing.familyFees({ familyId });
    expect(fees[0].feePlanId).toBeTruthy();
    expect(fees[0].effectiveAmountCents).toBe(0);
  });

  it('setFeeOverride changes the amount, and clearing it falls back to the plan', async () => {
    const { admin, familyId } = await seed('monthly', 5000);
    const feeId = (await admin.billing.familyFees({ familyId }))[0].feeId!;
    await admin.billing.setFeeOverride({ id: feeId, overrideAmountCents: 7000, note: 'ACH' });
    let fees = await admin.billing.familyFees({ familyId });
    expect(fees[0].effectiveAmountCents).toBe(7000);
    expect(fees[0].note).toBe('ACH');
    await admin.billing.generateFamily({ familyId, periodKey: '2026-07', label: 'Jul' });
    expect(await totalOf(admin, familyId, '2026-07')).toBe(7000);
    // Clearing the override (explicit null) restores the plan's amount.
    await admin.billing.setFeeOverride({ id: feeId, overrideAmountCents: null });
    fees = await admin.billing.familyFees({ familyId });
    expect(fees[0].effectiveAmountCents).toBe(5000);
  });

  it('assignFee on a plan the student already has updates the override instead of duplicating', async () => {
    const { admin, familyId, studentId, planId } = await seed('monthly', 5000);
    await admin.billing.assignFee({ studentId, feePlanId: planId, overrideAmountCents: 9000 });
    const fees = await admin.billing.familyFees({ familyId });
    expect(fees).toHaveLength(1); // still one assignment, not two
    expect(fees[0].effectiveAmountCents).toBe(9000);
  });
});
