// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * WHAT A YEAR OF FEES COMES TO, and what a mid-year joiner's FIRST MONTH comes to (0.51.0-dev.11).
 *
 * Two features, one conversation: an office at an enrollment desk being asked "what will this cost us for
 * the year?" and "they're starting on the 15th, so what about this month?".
 *
 * The projection's whole risk is quoting a figure the app will not actually charge, and there are three
 * ways to do that:
 *
 *  1. **Twelve months instead of the year's months.** A madrasah running September to June bills ten, so
 *     twelve overstates every quote by a fifth. This is the one an office would never catch — the number
 *     looks plausible either way.
 *  2. **The plan's list price instead of this child's.** A sibling on an agreed rate would be quoted the
 *     price the office had already agreed not to charge them.
 *  3. **Counting a per-term fee on a year with no terms**, which the generator would never bill at all.
 *
 * And it must never be mistaken for money: it writes nothing, and a balance stays `invoiced − paid`.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { paymentAllocations, payments, charges, invoiceItems, invoices, chargeItems, studentFees, feePlans, students, classes, courses, families, terms, schoolYears, users, auditLog } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let join: typeof import('../src/billing/joinMidYear');
const caller = (role: Role) => app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp();
  join = await import('../src/billing/joinMidYear');
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, charges, invoiceItems, invoices, chargeItems, studentFees, feePlans, students, classes, courses, families, terms, schoolYears, users, auditLog]) db.delete(t).run();
});

/** A school year running September to June — ten taught months, which is the point. */
async function seedYear(admin: ReturnType<typeof caller>) {
  return admin.structure.schoolYearCreate({ label: '2026–27', startYear: 2026, startMonth: 9, endMonth: 6, makeCurrent: true });
}

async function seed(opts: { monthly?: number; perTerm?: number; oneTime?: number; override?: number } = {}) {
  const admin = caller('admin');
  await seedYear(admin);
  const fam = await admin.people.familyCreate({ name: 'Ismail' });
  const monthly = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: opts.monthly ?? 10_000, cadence: 'monthly' });
  const s = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: monthly.id, ...(opts.override ? { overrideAmountCents: opts.override } : {}) });
  if (opts.perTerm) {
    const p = await admin.billing.feePlanCreate({ name: 'Books', amountCents: opts.perTerm, cadence: 'per_term' });
    await admin.billing.assignFee({ studentId: s.id, feePlanId: p.id });
  }
  if (opts.oneTime) {
    const p = await admin.billing.feePlanCreate({ name: 'Registration', amountCents: opts.oneTime, cadence: 'one_time' });
    await admin.billing.assignFee({ studentId: s.id, feePlanId: p.id });
  }
  return { admin, familyId: fam.id, studentId: s.id, monthlyPlanId: monthly.id };
}

describe('the full-year quote', () => {
  /** Ten months, not twelve — the school year decides, never the calendar. */
  it('multiplies a monthly plan by the months this madrasah actually teaches', async () => {
    const { admin, studentId } = await seed({ monthly: 10_000 });
    const r = await admin.billing.yearTotal({ studentId });
    expect(r.year?.months).toBe(10);
    expect(r.totalCents).toBe(100_000);
    expect(r.lines[0]).toMatchObject({ cadence: 'monthly', times: 10, amountCents: 10_000 });
  });

  /** What this CHILD is charged, not what the plan lists — a sibling rate is an override (§9). */
  it('quotes the per-student override, not the plan price', async () => {
    const { admin, studentId } = await seed({ monthly: 10_000, override: 6000 });
    const r = await admin.billing.yearTotal({ studentId });
    expect(r.totalCents).toBe(60_000);
  });

  it('counts a per-term plan once per term', async () => {
    const { admin, studentId } = await seed({ monthly: 10_000, perTerm: 5000 });
    const year = app.dbmod.db.select().from(schoolYears).all()[0];
    const ts = new Date();
    for (const name of ['Autumn', 'Spring', 'Summer']) {
      app.dbmod.db.insert(terms).values({ id: `trm_${name}`, schoolYearId: year.id, name, startDate: null, endDate: null, sortOrder: 0, createdAt: ts, updatedAt: ts }).run();
    }
    const r = await admin.billing.yearTotal({ studentId });
    expect(r.year?.terms).toBe(3);
    // $1,000 tuition + 3 × $50 books.
    expect(r.totalCents).toBe(115_000);
  });

  /**
   * …and NOT at all when the year has no terms configured. `generateForStudent` only writes a per-term
   * line on a term period, so a madrasah with no terms is never billed one — quoting it would be a figure
   * the app will not charge.
   */
  it('does not quote a per-term fee on a year with no terms', async () => {
    const { admin, studentId } = await seed({ monthly: 10_000, perTerm: 5000 });
    const r = await admin.billing.yearTotal({ studentId });
    expect(r.year?.terms).toBe(0);
    expect(r.totalCents).toBe(100_000);
  });

  it('counts a one-time fee once, and stops counting it once it has been billed', async () => {
    const { admin, studentId } = await seed({ monthly: 10_000, oneTime: 2500 });
    expect((await admin.billing.yearTotal({ studentId })).totalCents).toBe(102_500);

    // Bill a month: the one-time plan goes on it and is then no longer part of what the year will cost.
    await admin.billing.generatePeriod({ periodKey: '2026-09', label: 'Sep 2026' });
    expect((await admin.billing.yearTotal({ studentId })).totalCents).toBe(100_000);
  });

  /** A child starting in February does not owe September to January. */
  it('narrows the monthly count from a start month', async () => {
    const { admin, studentId } = await seed({ monthly: 10_000 });
    const r = await admin.billing.yearTotal({ studentId, fromPeriod: '2027-02' });
    // Feb, Mar, Apr, May, Jun — five months of a Sep–Jun year.
    expect(r.monthsCounted).toBe(5);
    expect(r.fromTotalCents).toBe(50_000);
    // The full year is still reported, so an office can quote both without doing either sum.
    expect(r.totalCents).toBe(100_000);
  });

  /** Actionable rather than a zero that reads like an answer. */
  it('says the year is missing rather than quoting nothing', async () => {
    const admin = caller('admin');
    const fam = await admin.people.familyCreate({ name: 'Ismail' });
    const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 10_000, cadence: 'monthly' });
    const s = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf', feePlanId: plan.id });
    const r = await admin.billing.yearTotal({ studentId: s.id });
    expect(r.year).toBeNull();
    expect(r.totalCents).toBe(0);
  });

  /** THE INVARIANT: a quote is not money. */
  it('writes nothing at all — it is a quote, not a bill', async () => {
    const { admin, studentId, familyId } = await seed({ monthly: 10_000 });
    await admin.billing.yearTotal({ studentId });
    expect(app.dbmod.db.select().from(invoices).all()).toHaveLength(0);
    expect(app.dbmod.db.select().from(charges).all()).toHaveLength(0);
    expect((await admin.billing.familyBilling({ familyId })).balance.owedCents).toBe(0);
  });
});

/**
 * THESE CALL `billStudentFrom` DIRECTLY, with an injected date, and that is deliberate.
 *
 * Going through `studentCreate` looked cleaner and was worthless: the fixture year runs September 2026 to
 * June 2027, `billFromMonths` offers no month later than the one we are actually in, and so on any real
 * date before September 2026 the catch-up bills NOTHING. The first draft of these three tests handled that
 * with `if (!sep) return`, which meant they passed by doing nothing — and would have kept passing with the
 * feature deleted. A test whose result depends on the day it runs is not a test.
 *
 * `now` is a parameter precisely so this is checkable. October 15th of the fixture year puts September in
 * the past, so the catch-up genuinely creates it and the adjustment genuinely lands.
 */
describe('the first month of a mid-year joiner', () => {
  const IN_OCTOBER = new Date('2026-10-15T00:00:00Z');

  async function joiner(firstMonthCents: number | null) {
    const admin = caller('admin');
    await seedYear(admin);
    const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 10_000, cadence: 'monthly' });
    const fam = await admin.people.familyCreate({ name: 'Ismail' });
    const s = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });
    const r = join.billStudentFrom(s.id, '2026-09', IN_OCTOBER, { firstMonthCents });
    const bill = await admin.billing.familyBilling({ familyId: fam.id });
    const sep = bill.invoices.find((i) => i.periodKey === '2026-09');
    const linesOn = (invoiceId: string) => app.dbmod.db.select().from(invoiceItems).all().filter((i) => i.invoiceId === invoiceId);
    return { admin, familyId: fam.id, result: r, bill, sep, linesOn };
  }

  /** The catch-up itself is 0.48.0; what is new is being able to say what that first month comes to. */
  it('brings the first month to the agreed figure, leaving the rest at the plan amount', async () => {
    const { result, bill, sep, linesOn } = await joiner(6000);
    // September AND October were created — the catch-up is real, which is what the old version never checked.
    expect(result.created).toBe(2);
    expect(result.firstMonthAdjusted).toBe(true);
    expect(sep).toBeTruthy();
    expect(sep!.totalCents).toBe(6000);

    // As its own line, so a parent can see WHY it differs rather than wondering.
    const lines = linesOn(sep!.id);
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.description === 'Joined part-way through the month' && l.amountCents === -4000)).toBe(true);

    // …and ONLY the first month. October is the full amount.
    const oct = bill.invoices.find((i) => i.periodKey === '2026-10');
    expect(oct?.totalCents).toBe(10_000);
    expect(linesOn(oct!.id)).toHaveLength(1);
  });

  it('writes no adjustment line when the agreed figure is the normal one', async () => {
    const { result, sep, linesOn } = await joiner(10_000);
    expect(result.firstMonthAdjusted).toBe(false);
    expect(sep!.totalCents).toBe(10_000);
    expect(linesOn(sep!.id)).toHaveLength(1);
  });

  /** Works upward too — an office may agree MORE than the plan for a first month. */
  it('adjusts upward when the agreed figure is higher', async () => {
    const { sep, linesOn } = await joiner(12_000);
    expect(sep!.totalCents).toBe(12_000);
    expect(linesOn(sep!.id).some((l) => l.description === 'First month adjustment' && l.amountCents === 2000)).toBe(true);
  });

  it('does nothing at all when no figure was named', async () => {
    const { result, sep, linesOn } = await joiner(null);
    expect(result.firstMonthAdjusted).toBe(false);
    expect(sep!.totalCents).toBe(10_000);
    expect(linesOn(sep!.id)).toHaveLength(1);
  });

  /** Re-running the catch-up must not adjust it twice — the guard is that the month has to be one THIS
   *  call created, and the second run creates nothing. */
  it('cannot adjust the same first month twice', async () => {
    const { admin, familyId, sep } = await joiner(6000);
    const studentId = app.dbmod.db.select().from(students).all()[0].id;
    const again = join.billStudentFrom(studentId, '2026-09', IN_OCTOBER, { firstMonthCents: 6000 });
    expect(again.created).toBe(0);
    expect(again.firstMonthAdjusted).toBeFalsy();
    const after = await admin.billing.familyBilling({ familyId });
    expect(after.invoices.find((i) => i.id === sep!.id)?.totalCents).toBe(6000);
  });
});
