// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * A student who joins part-way through the year (0.48.0).
 *
 * Adding a child used to bill nothing, and `generateForPeriod` bills whoever is active WHEN IT RUNS — so a
 * child added in February was billed from the next run and every month already generated silently skipped
 * them. Right for a child who started in February, wrong for one attending since October, and nothing said
 * which had happened.
 *
 * What is worth pinning is the three decisions, because each is a way to get somebody's money wrong:
 *
 *  1. ONE INVOICE PER MONTH. The year view is a column per month reading real invoices, so a combined
 *     catch-up would leave those squares looking never-billed.
 *  2. ONE DUE DATE, TODAY. Dating October's invoice in October makes the family five months overdue the
 *     instant their child is added — and the past-due job would then email them about it.
 *  3. MONTHS FROM THE SCHOOL YEAR, never the calendar: a madrasah teaching Sep–Jun must not be handed a
 *     July invoice just because July lies between the start month and today.
 *
 * Plus the two ways it must refuse: before the billing floor (§9 — those arrears are already carried in),
 * and idempotently, since re-running must never double-bill.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, guardianFamilies, guardians, students, classes, courses, families, schoolYears, settings, users, auditLog } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let join: typeof import('../src/billing/joinMidYear');
let settingsMod: typeof import('../src/settings');

const caller = (role: Role) =>
  app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp();
  join = await import('../src/billing/joinMidYear');
  settingsMod = await import('../src/settings');
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, guardianFamilies, guardians, students, classes, courses, families, schoolYears, settings, users, auditLog]) db.delete(t).run();
});

/** A Sep→Jun school year (so July and August are NOT taught months) and a monthly plan. */
async function base() {
  const admin = caller('admin');
  await admin.structure.schoolYearCreate({ label: '2026–27', startYear: 2026, startMonth: 9, endMonth: 6, makeCurrent: true });
  const plan = await admin.billing.feePlanCreate({ name: 'Monthly tuition', amountCents: 20000, cadence: 'monthly' });
  return { admin, planId: plan.id };
}

const FEB = new Date('2027-02-10T00:00:00Z');
/** Every invoice, oldest period first. */
const invoiceRows = () =>
  app.dbmod.db.select().from(invoices).all().sort((a, b) => (a.periodKey ?? '').localeCompare(b.periodKey ?? ''));

describe('billFromMonths — what the dropdown offers', () => {
  it('is the school year up to this month, and never a future one', async () => {
    await base();
    const months = join.billFromMonths(null, FEB).map((m) => m.periodKey);
    expect(months).toEqual(['2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02']);
    // March onward is absent: there is nothing to create for a month that has not happened, and offering
    // it would look like a promise to start then that nothing enforces.
    expect(months.some((m) => m > '2027-02')).toBe(false);
  });

  it('stops at the month this install started billing from', async () => {
    const { admin } = await base();
    settingsMod.setBillingStartPeriod('2026-11');
    expect(join.billFromMonths(null, FEB).map((m) => m.periodKey)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
  });

  /**
   * The field was HIDDEN on exactly the install most likely to need it. `billFromMonths` returned an empty
   * list with no school year configured, the add form hides the dropdown on an empty list, and a brand-new
   * install has no school year — so the one office adding a roster for the first time could not find the
   * feature at all. It falls back to recent calendar months, as the Generate form always has.
   */
  it('falls back to recent months when no school year is set up, rather than vanishing', () => {
    const months = join.billFromMonths(null, FEB).map((m) => m.periodKey);
    expect(months.length).toBeGreaterThan(0);
    expect(months[months.length - 1]).toBe('2027-02'); // ends with the current month
    expect(months.some((m) => m > '2027-02')).toBe(false); // still never the future
    // A year back, oldest first — enough for any mid-year catch-up.
    expect(months[0]).toBe('2026-03');
  });

  it('honours the billing floor in the fallback too', () => {
    settingsMod.setBillingStartPeriod('2027-01');
    expect(join.billFromMonths(null, FEB).map((m) => m.periodKey)).toEqual(['2027-01', '2027-02']);
    settingsMod.setBillingStartPeriod(null);
  });

  it('bills over calendar months when there is no school year to define them', async () => {
    const admin = caller('admin');
    const plan = await admin.billing.feePlanCreate({ name: 'Monthly tuition', amountCents: 20000, cadence: 'monthly' });
    const stu = await admin.people.studentAdd({ fullName: 'No Year Yet', feePlanId: plan.id });
    const r = join.billStudentFrom(stu.id, '2026-12', FEB);
    expect(r.periods).toEqual(['2026-12', '2027-01', '2027-02']);
  });
});

describe('billing a student from a past month', () => {
  it('creates one invoice per month, from then to now', async () => {
    const { admin, planId } = await base();
    const stu = await admin.people.studentAdd({ fullName: 'Late Joiner', feePlanId: planId });

    const r = join.billStudentFrom(stu.id, '2026-10', FEB);
    expect(r.created).toBe(5);
    expect(r.periods).toEqual(['2026-10', '2026-11', '2026-12', '2027-01', '2027-02']);
    // One invoice per month, each carrying that month's own tuition — not one lump.
    const rows = invoiceRows();
    expect(rows.map((i) => i.periodKey)).toEqual(['2026-10', '2026-11', '2026-12', '2027-01', '2027-02']);
    expect(rows.every((i) => i.status === 'open')).toBe(true);
    const bal = await admin.billing.studentBilling({ studentId: stu.id });
    expect(bal.balance.owedCents).toBe(5 * 20000);
  });

  it('dates every catch-up month TODAY, not in its own month', async () => {
    const { admin, planId } = await base();
    const stu = await admin.people.studentAdd({ fullName: 'Late Joiner', feePlanId: planId });
    join.billStudentFrom(stu.id, '2026-10', FEB);
    // All one date, and that date is today — so the family is owed-now rather than five months overdue,
    // and the past-due job does not chase them for a bill they have only just been given.
    expect([...new Set(invoiceRows().map((i) => i.dueDate))]).toEqual(['2027-02-10']);
  });

  it('names each month from the madrasah’s own label wording', async () => {
    const { admin, planId } = await base();
    await admin.billing.generatePeriod({ periodKey: '2026-09', labelTemplate: 'Maktab fees — [month] [year]' });
    const stu = await admin.people.studentAdd({ fullName: 'Late Joiner', feePlanId: planId });
    join.billStudentFrom(stu.id, '2026-12', FEB);
    expect(invoiceRows().filter((i) => i.periodKey === '2026-12')[0].label).toBe('Maktab fees — December 2026');
  });

  it('never bills a month the madrasah does not teach', async () => {
    const { admin, planId } = await base();
    const stu = await admin.people.studentAdd({ fullName: 'Late Joiner', feePlanId: planId });
    // A year that ran to June, asked for a catch-up in the following September: July and August are not
    // months of any school year, so they must not appear between them.
    const r = join.billStudentFrom(stu.id, '2026-09', new Date('2027-09-05T00:00:00Z'));
    expect(r.periods).not.toContain('2027-07');
    expect(r.periods).not.toContain('2027-08');
    expect(r.periods[r.periods.length - 1]).toBe('2027-06'); // the year's last taught month
  });

  it('refuses a month before the billing floor rather than double-charging carried-in arrears', async () => {
    const { admin, planId } = await base();
    settingsMod.setBillingStartPeriod('2026-12');
    const stu = await admin.people.studentAdd({ fullName: 'Late Joiner', feePlanId: planId });
    expect(join.billStudentFrom(stu.id, '2026-10', FEB)).toMatchObject({ created: 0, reason: 'before_floor' });
    expect(invoiceRows()).toHaveLength(0);
  });

  it('is idempotent — running it twice bills nothing more', async () => {
    const { admin, planId } = await base();
    const stu = await admin.people.studentAdd({ fullName: 'Late Joiner', feePlanId: planId });
    expect(join.billStudentFrom(stu.id, '2026-11', FEB).created).toBe(4);
    expect(join.billStudentFrom(stu.id, '2026-11', FEB).created).toBe(0);
    expect(invoiceRows()).toHaveLength(4);
  });

  it('fills only the gaps when some of the range is already billed', async () => {
    const { admin, planId } = await base();
    const stu = await admin.people.studentAdd({ fullName: 'Late Joiner', feePlanId: planId });
    // January was already generated for everybody; the catch-up must not create a second January.
    await admin.billing.generatePeriod({ periodKey: '2027-01' });
    expect(join.billStudentFrom(stu.id, '2026-12', FEB).periods).toEqual(['2026-12', '2027-02']);
    expect(invoiceRows().map((i) => i.periodKey)).toEqual(['2026-12', '2027-01', '2027-02']);
  });

  it('says so when there is no monthly amount to charge', async () => {
    const { admin } = await base();
    const termly = await admin.billing.feePlanCreate({ name: 'Per term', amountCents: 60000, cadence: 'per_term' });
    const stu = await admin.people.studentAdd({ fullName: 'Termly Only', feePlanId: termly.id });
    // A per-term plan has no monthly line, so `generateForStudent` correctly writes no empty invoices —
    // and this reports that rather than a silent success.
    expect(join.billStudentFrom(stu.id, '2026-10', FEB)).toMatchObject({ created: 0, reason: 'nothing_to_bill' });
    expect(invoiceRows()).toHaveLength(0);
  });

  it('refuses a future month and a period key that is not a month', async () => {
    const { admin, planId } = await base();
    const stu = await admin.people.studentAdd({ fullName: 'Late Joiner', feePlanId: planId });
    expect(join.billStudentFrom(stu.id, '2027-05', FEB)).toMatchObject({ created: 0, reason: 'future' });
    expect(join.billStudentFrom(stu.id, 'carry-in', FEB)).toMatchObject({ created: 0, reason: 'not_a_month' });
  });
});

/**
 * The router path, which uses the REAL clock — so these build a school year that contains today rather
 * than the fixed February above, and drive the months off `billFromMonths` itself. That makes them a
 * stronger check than a hard-coded range: the dropdown the office sees and the backfill it triggers are
 * asserted to agree.
 */
describe('the add-student form’s own path', () => {
  /** A calendar-year school year for the current year, so today is always one of its months. */
  async function thisYear() {
    const admin = caller('admin');
    await admin.structure.schoolYearCreate({ label: 'Now', startYear: new Date().getUTCFullYear(), startMonth: 1, endMonth: 12, makeCurrent: true });
    const plan = await admin.billing.feePlanCreate({ name: 'Monthly tuition', amountCents: 20000, cadence: 'monthly' });
    const months = (await admin.billing.billFromMonths()).months.map((m) => m.periodKey);
    return { admin, planId: plan.id, months };
  }

  it('bills nothing when no month is chosen — the default', async () => {
    const { admin, planId } = await thisYear();
    const r = await admin.people.studentAdd({ fullName: 'Fresh Start', feePlanId: planId });
    expect(r.billed).toBeUndefined();
    expect(invoiceRows()).toHaveLength(0);
  });

  it('backfills every month from the chosen one to now, and reports what it did', async () => {
    const { admin, planId, months } = await thisYear();
    const r = await admin.people.studentAdd({ fullName: 'Late Joiner', feePlanId: planId, billFromPeriod: months[0] });
    // The dropdown's own list is exactly what gets billed — no gaps, no extras.
    expect(r.billed?.periods).toEqual(months);
    expect(r.billed?.created).toBe(months.length);
    // Audited as a billing event, since it created invoices.
    expect(app.dbmod.db.select().from(auditLog).all().some((a) => a.action === 'invoice.backfillStudent')).toBe(true);
  });

  it('does the same for a child added into an existing household, and bills only them', async () => {
    const { admin, planId, months } = await thisYear();
    const first = await admin.people.studentAdd({ fullName: 'Big Sister', feePlanId: planId });
    const last = months[months.length - 1];
    const r = await admin.people.studentCreate({ familyId: first.familyId, fullName: 'Little Brother', feePlanId: planId, billFromPeriod: last });
    expect(r.billed?.periods).toEqual([last]);
    // The sister is untouched: a catch-up is one child's history, not the household's.
    expect(new Set(invoiceRows().map((i) => i.studentId)).size).toBe(1);
  });

  it('leaves the student added even when the catch-up bills nothing', async () => {
    const { admin, planId, months } = await thisYear();
    // A floor above every offered month, so the catch-up is refused outright.
    settingsMod.setBillingStartPeriod('2999-01');
    const r = await admin.people.studentAdd({ fullName: 'Refused Catchup', feePlanId: planId, billFromPeriod: months[0] });
    // The child exists — a refused backfill must not roll back the person the office just added.
    expect(r.id).toBeTruthy();
    expect(r.billed).toMatchObject({ created: 0, reason: 'before_floor' });
    expect(app.dbmod.db.select().from(students).all()).toHaveLength(1);
    expect(invoiceRows()).toHaveLength(0);
    settingsMod.setBillingStartPeriod(null);
  });

  it('is offered to finance as well — they add students too', async () => {
    await thisYear();
    await expect(caller('finance').billing.billFromMonths()).resolves.toBeTruthy();
    await expect(caller('parent').billing.billFromMonths()).rejects.toThrow();
  });
});
