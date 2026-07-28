// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Paying AHEAD: a lump sum that covers months not yet billed, and what happens when a one-off charge
 * lands on a family sitting on that advance balance.
 *
 * These run through the real routers rather than the ledger alone, because the bug they pin down was
 * exactly a gap BETWEEN the two: the balance was always right (it is derived), but an invoice's
 * status comes from `payment_allocations`, and money paid before an invoice existed was never
 * attached to it afterwards. The office saw "paid" on the account and unpaid months in the year
 * grid at the same time.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { paymentAllocations, payments, charges, chargeItems, invoiceItems, invoices, studentFees, feePlans, students, families } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
const caller = (role: Role) =>
  app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => { app = await freshApp(); });
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, charges, chargeItems, invoiceItems, invoices, studentFees, feePlans, students, families]) db.delete(t).run();
});

/** One child on a $350/month plan — the shape the reported bug used. */
async function child() {
  const admin = caller('admin');
  const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 35000, cadence: 'monthly' });
  const s = await admin.people.studentAdd({ fullName: 'Yusuf Ismail', feePlanId: plan.id });
  return { admin, studentId: s.id, familyId: s.familyId, planId: plan.id };
}

const MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07'];

/** Generate one month's invoice for the whole school. */
const bill = (admin: ReturnType<typeof caller>, periodKey: string) =>
  admin.billing.generatePeriod({ periodKey, label: periodKey, dueDate: `${periodKey}-01` });

/** Each month's invoice status for one child, in month order — what the year grid draws. */
async function months(admin: ReturnType<typeof caller>, studentId: string) {
  const b = await admin.billing.studentBilling({ studentId });
  return MONTHS.map((p) => b.invoices.find((i) => i.periodKey === p)?.status ?? 'none');
}

describe('a lump sum covers every month it pays for', () => {
  it('marks ALL four consecutive months paid, not just the first and last', async () => {
    const { admin, studentId } = await child();
    for (const m of MONTHS) await bill(admin, m);

    // $1,400 against a $350/month fee = exactly four months.
    await admin.billing.recordManualPayment({ studentId, amountCents: 140000, channel: 'cash', occurredAt: '2026-04-02' });

    expect(await months(admin, studentId)).toEqual(['paid', 'paid', 'paid', 'paid']);
    expect((await admin.billing.studentBilling({ studentId })).balance.owedCents).toBe(0);
  });

  it('covers months billed AFTER the money arrived — the advance-payment case', async () => {
    const { admin, studentId } = await child();
    // Only April exists when the parent pays for four months up front.
    await bill(admin, '2026-04');
    await admin.billing.recordManualPayment({ studentId, amountCents: 140000, channel: 'cash', occurredAt: '2026-04-02' });
    expect(await months(admin, studentId)).toEqual(['paid', 'none', 'none', 'none']);
    // …and $1,050 is sitting as credit, not attached to anything yet.
    expect((await admin.billing.studentBilling({ studentId })).balance.creditCents).toBe(105000);

    // As each later month is generated it is settled on the spot, with no second payment.
    for (const m of MONTHS.slice(1)) await bill(admin, m);
    expect(await months(admin, studentId)).toEqual(['paid', 'paid', 'paid', 'paid']);
    expect((await admin.billing.studentBilling({ studentId })).balance.balanceCents).toBe(0);
  });

  it('leaves the month it only partly covers as partially paid, not skipped', async () => {
    const { admin, studentId } = await child();
    for (const m of MONTHS) await bill(admin, m);
    // Two and a half months' worth.
    await admin.billing.recordManualPayment({ studentId, amountCents: 87500, channel: 'zelle', occurredAt: '2026-04-02' });
    expect(await months(admin, studentId)).toEqual(['paid', 'paid', 'partially_paid', 'open']);
  });
});

describe('money can be taken when nothing is due', () => {
  it('accepts a payment against a student with no invoices at all, and holds it as credit', async () => {
    const { admin, studentId } = await child();
    const before = await admin.billing.studentBilling({ studentId });
    expect(before.balance.owedCents).toBe(0);
    expect(before.invoices).toHaveLength(0);

    await admin.billing.recordManualPayment({ studentId, amountCents: 70000, channel: 'cash', occurredAt: '2026-03-20' });

    const after = await admin.billing.studentBilling({ studentId });
    expect(after.balance.creditCents).toBe(70000);
    // And it is real money the next bills consume, not a number parked somewhere.
    await bill(admin, '2026-04');
    await bill(admin, '2026-05');
    expect(await months(admin, studentId)).toEqual(['paid', 'paid', 'none', 'none']);
  });
});

describe('a one-off charge comes out of the advance balance first', () => {
  it('takes the charge from the advance and hands the shortfall back to the last covered month', async () => {
    const { admin, studentId } = await child();
    // Paid four months up front, all four billed and ticked.
    for (const m of MONTHS) await bill(admin, m);
    await admin.billing.recordManualPayment({ studentId, amountCents: 140000, channel: 'cash', occurredAt: '2026-04-02' });
    expect(await months(admin, studentId)).toEqual(['paid', 'paid', 'paid', 'paid']);

    // A $100 book fee on the April invoice. There is no spare money, so it has to come from
    // somewhere — and it comes off the NEWEST covered month, leaving the older ones settled.
    const item = await admin.billing.chargeItemCreate({ name: 'Books', defaultAmountCents: 10000 });
    await admin.billing.chargeAdd({ studentId, source: { kind: 'item', chargeItemId: item.id }, periodKey: '2026-04' });

    const after = await months(admin, studentId);
    expect(after.slice(0, 3)).toEqual(['paid', 'paid', 'paid']);
    expect(after[3]).toBe('partially_paid'); // July is now short by the charge
    // The family owes exactly the charge — nothing has been invented or lost.
    const b = await admin.billing.studentBilling({ studentId });
    expect(b.balance.owedCents).toBe(10000);
    expect(b.invoices.find((i) => i.periodKey === '2026-04')!.totalCents).toBe(45000);
  });

  it('is absorbed silently when the advance is big enough to swallow it', async () => {
    const { admin, studentId } = await child();
    for (const m of MONTHS) await bill(admin, m);
    // A month's worth more than the four bills.
    await admin.billing.recordManualPayment({ studentId, amountCents: 175000, channel: 'cash', occurredAt: '2026-04-02' });
    expect((await admin.billing.studentBilling({ studentId })).balance.creditCents).toBe(35000);

    const item = await admin.billing.chargeItemCreate({ name: 'Books', defaultAmountCents: 10000 });
    await admin.billing.chargeAdd({ studentId, source: { kind: 'item', chargeItemId: item.id }, periodKey: '2026-04' });

    // Every month stays paid and the credit simply shrinks — the parent is told nothing, correctly.
    expect(await months(admin, studentId)).toEqual(['paid', 'paid', 'paid', 'paid']);
    expect((await admin.billing.studentBilling({ studentId })).balance.creditCents).toBe(25000);
  });

  it('does not touch a sibling’s advance balance to pay one child’s charge', async () => {
    const { admin, studentId, planId } = await child();
    const sib = await admin.people.studentAdd({ fullName: 'Maryam Ismail', feePlanId: planId, linkToStudentId: studentId });
    await bill(admin, '2026-04');
    // Only Maryam pays ahead.
    await admin.billing.recordManualPayment({ studentId: sib.id, amountCents: 105000, channel: 'cash', occurredAt: '2026-04-02' });

    const item = await admin.billing.chargeItemCreate({ name: 'Books', defaultAmountCents: 10000 });
    await admin.billing.chargeAdd({ studentId, source: { kind: 'item', chargeItemId: item.id }, periodKey: '2026-04' });

    // Yusuf owes his own April tuition plus the charge; Maryam's credit is untouched. Bills are per
    // child, so one child's money must never quietly settle another's.
    expect((await admin.billing.studentBilling({ studentId })).balance.owedCents).toBe(45000);
    expect((await admin.billing.studentBilling({ studentId: sib.id })).balance.creditCents).toBe(70000);
  });
});
