// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * STARTING MID-YEAR (0.43.0) — the go-live step a madrasa runs once, in February, for a Sep–Jun year.
 *
 * The test that earns its keep is `preview equals commit`: the office is shown every parent's resulting
 * balance and then commits, so if those two numbers could differ the whole screen is a lie. They are
 * one derivation (billing/carryIn.ts) and this pins that.
 *
 * The rest are the ways a mid-year start goes wrong in real life:
 *  - the months before go-live must never be generated afterwards, or the carried-in arrears get billed
 *    a second time and the second copy looks just as legitimate as the first;
 *  - a carried-in debt must be paid off BEFORE the current month, which is what the past due date on the
 *    artifact is for;
 *  - money paid ahead must be absorbed by the months generated later, not left sitting as credit;
 *  - running it twice must not double anything.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { paymentAllocations, payments, charges, invoiceItems, invoices, chargeItems, studentFees, feePlans, students, classes, courses, families, terms, schoolYears, settings, users, auditLog } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
const caller = (role: Role) => app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp();
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, charges, invoiceItems, invoices, chargeItems, studentFees, feePlans, students, classes, courses, families, terms, schoolYears, settings, users, auditLog]) db.delete(t).run();
});

/** A Sep 2026 – Jun 2027 year, and three children on $50/month in two households. */
async function seedYear() {
  const admin = caller('admin');
  await admin.structure.schoolYearCreate({ label: '2026–27', startYear: 2026, startMonth: 9, endMonth: 6, isCurrent: true });
  const plan = await admin.billing.feePlanCreate({ name: 'Monthly tuition', amountCents: 5000, cadence: 'monthly' });
  const ismail = await admin.people.familyCreate({ name: 'Ismail' });
  const farooqi = await admin.people.familyCreate({ name: 'Farooqi' });
  const yusuf = await admin.people.studentCreate({ familyId: ismail.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });
  const maryam = await admin.people.studentCreate({ familyId: ismail.id, fullName: 'Maryam Ismail', feePlanId: plan.id });
  const bilal = await admin.people.studentCreate({ familyId: farooqi.id, fullName: 'Bilal Farooqi', feePlanId: plan.id });
  return { admin, ismail: ismail.id, farooqi: farooqi.id, yusuf: yusuf.id, maryam: maryam.id, bilal: bilal.id };
}

const GO_LIVE = '2027-02';

describe('the go-live step derives what each child carries in', () => {
  it('turns "paid through" into arrears, credit, or nothing at all', async () => {
    const { admin, yusuf, maryam, bilal } = await seedYear();
    const plan = await admin.billing.midYearPreview({
      goLivePeriod: GO_LIVE,
      rows: [
        { studentId: yusuf, paidThrough: '2027-01' }, // square
        { studentId: maryam, paidThrough: '2026-11' }, // owes Dec + Jan
        { studentId: bilal, paidThrough: '2027-06' }, // paid the rest of the year up front
      ],
    });
    const of = (id: string) => plan.students.find((s) => s.studentId === id)!;

    expect(of(yusuf)).toMatchObject({ kind: 'square', amountCents: 0 });
    expect(of(maryam)).toMatchObject({ kind: 'owes', amountCents: 10000, monthCount: 2 });
    expect(of(bilal)).toMatchObject({ kind: 'ahead', amountCents: 25000, monthCount: 5 }); // Feb–Jun
  });

  it('takes the office’s own figure over the derived one', async () => {
    const { admin, maryam } = await seedYear();
    const plan = await admin.billing.midYearPreview({
      goLivePeriod: GO_LIVE,
      rows: [{ studentId: maryam, paidThrough: '2026-11', amountOverrideCents: 7500, kindOverride: 'owes' }],
    });
    expect(plan.students.find((s) => s.studentId === maryam)).toMatchObject({ kind: 'owes', amountCents: 7500, derivedFrom: 'override' });
  });

  /** A household is what a parent reads, and one adult pays for all of them, so a child in credit nets
   *  against a sibling in arrears rather than being shown as two separate problems. */
  it('nets a household’s children into one figure', async () => {
    const { admin, ismail, yusuf, maryam } = await seedYear();
    const plan = await admin.billing.midYearPreview({
      goLivePeriod: GO_LIVE,
      rows: [
        { studentId: maryam, paidThrough: '2026-11' }, // owes 10000
        { studentId: yusuf, paidThrough: '2027-03' }, // 2 months ahead = 10000
      ],
    });
    expect(plan.families.find((f) => f.familyId === ismail)).toMatchObject({ owedCents: 0, creditCents: 0 });
  });
});

describe('committing it', () => {
  /** THE test. Whatever the preview said each parent would see is what they see. */
  it('every balance matches the preview exactly', async () => {
    const { admin, yusuf, maryam, bilal } = await seedYear();
    const rows = [
      { studentId: yusuf, paidThrough: '2027-01' },
      { studentId: maryam, paidThrough: '2026-11' },
      { studentId: bilal, paidThrough: '2027-06' },
    ];
    const preview = await admin.billing.midYearPreview({ goLivePeriod: GO_LIVE, rows });

    await admin.billing.midYearCommit({ goLivePeriod: GO_LIVE, rows });

    for (const p of preview.students) {
      const after = (await admin.billing.studentBilling({ studentId: p.studentId })).balance;
      expect({ owed: after.owedCents, credit: after.creditCents }).toEqual({ owed: p.afterOwedCents, credit: p.afterCreditCents });
    }
  });

  it('writes a readable, dated bill for arrears and a dated payment for money paid ahead', async () => {
    const { admin, maryam, bilal } = await seedYear();
    await admin.billing.midYearCommit({
      goLivePeriod: GO_LIVE,
      asOf: '2027-02-01',
      rows: [{ studentId: maryam, paidThrough: '2026-11' }, { studentId: bilal, paidThrough: '2027-06' }],
    });

    const arrears = (await admin.billing.studentBilling({ studentId: maryam })).invoices;
    expect(arrears).toHaveLength(1);
    expect(arrears[0]).toMatchObject({ label: 'Balance carried forward', periodKey: 'carry-in', totalCents: 10000 });
    // Dated BEFORE go-live, so it sorts ahead of every month this app will generate and autopay sees it.
    expect(arrears[0].dueDate).toBe('2027-01-01');

    const ahead = (await admin.billing.studentBilling({ studentId: bilal })).payments;
    expect(ahead).toHaveLength(1);
    expect(ahead[0]).toMatchObject({ amountCents: 25000, channel: 'carry_in' });
  });

  it('is idempotent — running it again writes nothing more', async () => {
    const { admin, maryam, bilal } = await seedYear();
    const rows = [{ studentId: maryam, paidThrough: '2026-11' }, { studentId: bilal, paidThrough: '2027-06' }];
    const first = await admin.billing.midYearCommit({ goLivePeriod: GO_LIVE, rows });
    expect(first).toMatchObject({ owed: 1, ahead: 1 });

    const again = await admin.billing.midYearCommit({ goLivePeriod: GO_LIVE, rows });
    expect(again).toMatchObject({ owed: 0, ahead: 0, skipped: 2 });
    expect((await admin.billing.studentBilling({ studentId: maryam })).balance.owedCents).toBe(10000);
    expect((await admin.billing.studentBilling({ studentId: bilal })).balance.creditCents).toBe(25000);
  });

  it('is admin-only — finance runs the billing, but not this', async () => {
    const { yusuf } = await seedYear();
    await expect(caller('finance').billing.midYearCommit({ goLivePeriod: GO_LIVE, rows: [{ studentId: yusuf, paidThrough: '2026-11' }] })).rejects.toThrow(/don’t have access/);
  });
});

describe('the months before go-live are closed off', () => {
  it('refuses to generate a month the carried-in figure already covers', async () => {
    const { admin, ismail, yusuf } = await seedYear();
    await admin.billing.midYearCommit({ goLivePeriod: GO_LIVE, rows: [{ studentId: yusuf, paidThrough: '2026-11' }] });

    await expect(admin.billing.generatePeriod({ periodKey: '2026-12', label: 'Tuition — Dec 2026' })).rejects.toThrow(/bills from 2027-02/);
    await expect(admin.billing.generateFamily({ familyId: ismail, periodKey: '2027-01', label: 'Tuition — Jan 2027' })).rejects.toThrow(/bills from 2027-02/);
    // February onwards is exactly what it is for.
    expect((await admin.billing.generatePeriod({ periodKey: GO_LIVE, label: 'Tuition — Feb 2027' })).created).toBeGreaterThan(0);
  });

  /**
   * The floor only ever moves BACK. The wizard defaults to the current month, so running it again in May
   * for a newly-enrolled child would otherwise push the floor to May and start refusing February, March
   * and April — months this install has already billed.
   */
  it('a second run never moves the billing floor forward', async () => {
    const { admin, yusuf, maryam } = await seedYear();
    await admin.billing.midYearCommit({ goLivePeriod: '2027-02', rows: [{ studentId: yusuf, paidThrough: '2026-11' }] });
    const later = await admin.billing.midYearCommit({ goLivePeriod: '2027-05', rows: [{ studentId: maryam, paidThrough: '2027-04' }] });

    expect(later.startPeriod).toBe('2027-02');
    expect((await admin.billing.midYearStatus()).startPeriod).toBe('2027-02');
    // March is still billable, which is the whole point.
    expect((await admin.billing.generatePeriod({ periodKey: '2027-03', label: 'Tuition — Mar 2027' })).created).toBeGreaterThan(0);
  });

  /** A child who left in December still owes December. Dropping them from the roster would mean the one
   *  figure this screen exists to record could not be recorded for them. */
  it('includes a withdrawn child, marked', async () => {
    const { admin, yusuf } = await seedYear();
    await admin.people.studentUpdate({ id: yusuf, status: 'withdrawn' });

    const plan = await admin.billing.midYearPreview({ goLivePeriod: GO_LIVE, rows: [{ studentId: yusuf, paidThrough: '2026-11' }] });
    const row = plan.students.find((s) => s.studentId === yusuf);
    expect(row).toMatchObject({ withdrawn: true, kind: 'owes', amountCents: 10000 });

    await admin.billing.midYearCommit({ goLivePeriod: GO_LIVE, rows: [{ studentId: yusuf, paidThrough: '2026-11' }] });
    expect((await admin.billing.studentBilling({ studentId: yusuf })).balance.owedCents).toBe(10000);
  });

  it('an admin can re-open it deliberately', async () => {
    const { admin, yusuf } = await seedYear();
    await admin.billing.midYearCommit({ goLivePeriod: GO_LIVE, rows: [{ studentId: yusuf, paidThrough: '2026-11' }] });
    await admin.billing.midYearClearFloor();
    expect((await admin.billing.generatePeriod({ periodKey: '2026-12', label: 'Tuition — Dec 2026' })).created).toBeGreaterThan(0);
  });

  /** The other half of the double-billing problem, and the older one: an unpadded month is a DIFFERENT
   *  period key, so `2027-2` would raise a second February invoice for every child. */
  it('refuses a month written without its leading zero', async () => {
    const { admin } = await seedYear();
    await expect(admin.billing.generatePeriod({ periodKey: '2027-2', label: 'Tuition — Feb 2027' })).rejects.toThrow(/leading zero/);
    await expect(admin.billing.generatePeriod({ periodKey: 'carry-in', label: 'Sneaky' })).rejects.toThrow(/reserved/);
  });
});

describe('the carried-in figures behave like real money', () => {
  it('arrears are cleared before the current month', async () => {
    const { admin, ismail, yusuf } = await seedYear();
    await admin.billing.midYearCommit({ goLivePeriod: GO_LIVE, rows: [{ studentId: yusuf, paidThrough: '2026-11' }] });
    await admin.billing.generateFamily({ familyId: ismail, periodKey: GO_LIVE, label: 'Tuition — Feb 2027', dueDate: '2027-02-01' });

    // $100 arrears + $50 February. Pay $100: the arrears must be what goes.
    await admin.billing.recordManualPayment({ studentId: yusuf, amountCents: 10000, channel: 'cash', occurredAt: '2027-02-03' });
    const invs = (await admin.billing.studentBilling({ studentId: yusuf })).invoices;
    expect(invs.find((i) => i.periodKey === 'carry-in')).toMatchObject({ status: 'paid' });
    expect(invs.find((i) => i.periodKey === GO_LIVE)).toMatchObject({ status: 'open' });
  });

  it('money paid ahead is absorbed by the months generated afterwards', async () => {
    const { admin, farooqi, bilal } = await seedYear();
    await admin.billing.midYearCommit({ goLivePeriod: GO_LIVE, rows: [{ studentId: bilal, paidThrough: '2027-04' }] }); // Feb–Apr = $150

    await admin.billing.generateFamily({ familyId: farooqi, periodKey: GO_LIVE, label: 'Tuition — Feb 2027', dueDate: '2027-02-01' });
    await admin.billing.generateFamily({ familyId: farooqi, periodKey: '2027-03', label: 'Tuition — Mar 2027', dueDate: '2027-03-01' });

    const b = await admin.billing.studentBilling({ studentId: bilal });
    expect(b.invoices.every((i) => i.status === 'paid')).toBe(true);
    expect(b.balance.creditCents).toBe(5000); // April's month still in hand
  });
});
