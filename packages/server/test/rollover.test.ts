// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Rolling over into a new school year (0.48.0).
 *
 * "Activate" flipped one boolean and moved nobody, so a madrasah pressed a button and everyone was still
 * in last year's class on last year's price. What is worth pinning is every way this can now get somebody's
 * year — or somebody's money — wrong:
 *
 *  1. THE SUGGESTION. Classes are ordered within a course, so each maps to the next and the last graduates.
 *     Wrong suggestions are a form nobody trusts; wrong ACROSS COURSES would move a hifz child into the
 *     maktab, which is worse.
 *  2. A CHILD CAN BREAK RANKS. One student repeating the year has to be able to stay while their class
 *     moves up, so a per-student instruction must beat the per-class one.
 *  3. NOTHING IS WITHDRAWN THAT WAS NOT TICKED. A graduating class PROPOSES leavers; the office decides.
 *     Withdrawing a child who is repeating would stop billing a family who still owes.
 *  4. OVERRIDES SURVIVE. A sibling rate or a bursary is an agreement with a family, not a property of the
 *     year (§9) — a rollover that cleared them would quietly re-bill a hardship case at full price.
 *  5. IT IS ALL OR NOTHING. A half-applied rollover has no undo.
 *  6. LAST YEAR'S DEBT IS UNTOUCHED, and reported.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import {
  paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, guardianFamilies, guardians,
  students, classes, courses, families, terms, schoolYears, users, auditLog, settings,
} from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
const caller = (role: Role) =>
  app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => { app = await freshApp(); });
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, guardianFamilies, guardians, students, classes, courses, families, terms, schoolYears, users, auditLog, settings]) db.delete(t).run();
});

/** A Hifz course with three ordered classes, a Maktab with two, one plan, and a child in each class. */
async function madrasah() {
  const admin = caller('admin');
  const year = await admin.structure.schoolYearCreate({ label: '2026–27', startYear: 2026, startMonth: 9, endMonth: 6, makeCurrent: true });
  const plan = await admin.billing.feePlanCreate({ name: 'Monthly tuition', amountCents: 20000, cadence: 'monthly' });

  const hifz = await admin.structure.courseCreate({ name: 'Hifz' });
  const h1 = await admin.structure.classCreate({ courseId: hifz.id, name: 'Hifz 1', sortOrder: 0 });
  const h2 = await admin.structure.classCreate({ courseId: hifz.id, name: 'Hifz 2', sortOrder: 1 });
  const h3 = await admin.structure.classCreate({ courseId: hifz.id, name: 'Hifz 3', sortOrder: 2 });

  const maktab = await admin.structure.courseCreate({ name: 'Maktab' });
  const m1 = await admin.structure.classCreate({ courseId: maktab.id, name: 'Maktab 1', sortOrder: 0 });
  const m2 = await admin.structure.classCreate({ courseId: maktab.id, name: 'Maktab 2', sortOrder: 1 });

  const kid = async (name: string, classId: string) => admin.people.studentAdd({ fullName: name, feePlanId: plan.id, classId });
  return {
    admin,
    yearId: year.id,
    planId: plan.id,
    ids: { h1: h1.id, h2: h2.id, h3: h3.id, m1: m1.id, m2: m2.id },
    kids: {
      a: await kid('Aisha One', h1.id),
      b: await kid('Bilal Two', h2.id),
      c: await kid('Cadet Three', h3.id),
      d: await kid('Dawud Maktab', m1.id),
    },
  };
}

const classOf = (id: string) => app.dbmod.db.select().from(students).all().find((s) => s.id === id)!;

describe('the suggested mapping', () => {
  it('sends each class to the next in its own course, and the last one graduates', async () => {
    const { admin, ids } = await madrasah();
    const plan = await admin.structure.yearRolloverPlan();
    const by = new Map(plan.classes.map((c) => [c.name, c]));

    expect(by.get('Hifz 1')!.suggested).toEqual({ kind: 'move', toClassId: ids.h2 });
    expect(by.get('Hifz 2')!.suggested).toEqual({ kind: 'move', toClassId: ids.h3 });
    expect(by.get('Hifz 3')!.suggested).toEqual({ kind: 'graduate' });
    // Never across courses: Maktab 2 is a last class too, and must not land in Hifz.
    expect(by.get('Maktab 1')!.suggested).toEqual({ kind: 'move', toClassId: ids.m2 });
    expect(by.get('Maktab 2')!.suggested).toEqual({ kind: 'graduate' });
  });

  it('carries the headcounts and the children, so the office can see what is moving', async () => {
    const { admin, kids } = await madrasah();
    const plan = await admin.structure.yearRolloverPlan();
    const h1 = plan.classes.find((c) => c.name === 'Hifz 1')!;
    expect(h1.studentCount).toBe(1);
    expect(h1.students.map((s) => s.id)).toEqual([kids.a.id]);
    expect(h1.courseName).toBe('Hifz');
  });

  it('suggests next year’s label and span from the one closing', async () => {
    const { admin } = await madrasah();
    const plan = await admin.structure.yearRolloverPlan();
    expect(plan.closing?.label).toBe('2026–27');
    expect(plan.suggestedYear).toMatchObject({ label: '2027–28', startYear: 2027, startMonth: 9, endMonth: 6 });
  });

  it('offers the closing year’s terms for the new one, a year on', async () => {
    const { admin, yearId } = await madrasah();
    await admin.structure.termCreate({ schoolYearId: yearId, name: 'Autumn', startDate: '2026-09-01', endDate: '2026-12-18' });
    const plan = await admin.structure.yearRolloverPlan();
    expect(plan.termNames).toEqual([{ name: 'Autumn', startDate: '2027-09-01', endDate: '2027-12-18' }]);
  });
});

describe('applying it', () => {
  /** The suggestion, as a classMoves map — what the office gets if they change nothing. */
  const asMoves = (plan: Awaited<ReturnType<ReturnType<typeof caller>['structure']['yearRolloverPlan']>>) =>
    Object.fromEntries(plan.classes.map((c) => [c.id, c.suggested]));

  it('moves everybody up, opens the new year, and makes it current', async () => {
    const { admin, ids, kids } = await madrasah();
    const plan = await admin.structure.yearRolloverPlan();
    const r = await admin.structure.yearRolloverCommit({
      year: { label: '2027–28', startYear: 2027, startMonth: 9, endMonth: 6 },
      classMoves: asMoves(plan),
      studentMoves: {},
      withdraw: [],
      planAmounts: {},
      termsToCreate: [],
    });

    expect(r.moved).toBe(3); // Aisha, Bilal, Dawud
    expect(r.graduated).toBe(1); // Cadet, out of Hifz 3
    expect(classOf(kids.a.id).classId).toBe(ids.h2);
    expect(classOf(kids.b.id).classId).toBe(ids.h3);
    expect(classOf(kids.d.id).classId).toBe(ids.m2);
    // Graduating takes them out of the class; whether they LEAVE is the withdraw list's business.
    expect(classOf(kids.c.id).classId).toBeNull();
    expect(classOf(kids.c.id).status).toBe('active');

    const years = await admin.structure.schoolYearList();
    expect(years.find((y) => y.id === r.yearId)?.isCurrent).toBe(true);
    expect(years.filter((y) => y.isCurrent)).toHaveLength(1);
  });

  it('lets one child stay behind while their class moves up', async () => {
    const { admin, ids, kids } = await madrasah();
    const plan = await admin.structure.yearRolloverPlan();
    await admin.structure.yearRolloverCommit({
      year: { label: '2027–28', startYear: 2027, startMonth: 9, endMonth: 6 },
      classMoves: asMoves(plan),
      // Aisha is repeating: her own instruction beats her class's.
      studentMoves: { [kids.a.id]: { kind: 'stay' } },
      withdraw: [],
      planAmounts: {},
      termsToCreate: [],
    });
    expect(classOf(kids.a.id).classId).toBe(ids.h1); // stayed
    expect(classOf(kids.b.id).classId).toBe(ids.h3); // her class still moved
  });

  it('withdraws only the children who were ticked', async () => {
    const { admin, kids } = await madrasah();
    const plan = await admin.structure.yearRolloverPlan();
    const r = await admin.structure.yearRolloverCommit({
      year: { label: '2027–28', startYear: 2027, startMonth: 9, endMonth: 6 },
      classMoves: asMoves(plan),
      studentMoves: {},
      withdraw: [kids.c.id],
      planAmounts: {},
      termsToCreate: [],
    });
    expect(r.withdrawn).toBe(1);
    expect(classOf(kids.c.id).status).toBe('withdrawn');
    // The other graduate-adjacent children are untouched — a graduating class proposes, it does not decide.
    expect(classOf(kids.a.id).status).toBe('active');
    expect(classOf(kids.b.id).status).toBe('active');
    expect(classOf(kids.d.id).status).toBe('active');
  });

  it('raises the plan amounts asked for and KEEPS every per-student override', async () => {
    const { admin, planId, kids } = await madrasah();
    // Aisha has a sibling rate — an agreement with her family, not a property of the year.
    await admin.billing.setStudentFee({ studentId: kids.a.id, feePlanId: planId, overrideAmountCents: 15000, note: 'sibling rate' });

    const plan = await admin.structure.yearRolloverPlan();
    expect(plan.plans.find((p) => p.id === planId)).toMatchObject({ amountCents: 20000, studentCount: 4 });

    const r = await admin.structure.yearRolloverCommit({
      year: { label: '2027–28', startYear: 2027, startMonth: 9, endMonth: 6 },
      classMoves: asMoves(plan),
      studentMoves: {},
      withdraw: [],
      planAmounts: { [planId]: 22000 },
      termsToCreate: [],
    });
    expect(r.plansChanged).toBe(1);
    expect(app.dbmod.db.select().from(feePlans).all()[0].amountCents).toBe(22000);
    // The override is still there, still 15000 — NOT reset to the new plan price, which has moved to 22000.
    const after = await admin.billing.studentFeeList({ studentIds: [kids.a.id] });
    expect(after[0]).toMatchObject({ overrideAmountCents: 15000, note: 'sibling rate', planAmountCents: 22000 });
  });

  it('creates the new year’s terms, and does not duplicate one that exists', async () => {
    const { admin } = await madrasah();
    const plan = await admin.structure.yearRolloverPlan();
    const termsToCreate = [{ name: 'Autumn', startDate: '2027-09-01', endDate: '2027-12-18' }];
    const first = await admin.structure.yearRolloverCommit({
      year: { label: '2027–28', startYear: 2027, startMonth: 9, endMonth: 6 },
      classMoves: asMoves(plan),
      studentMoves: {},
      withdraw: [],
      planAmounts: {},
      termsToCreate,
    });
    expect(first.termsCreated).toBe(1);

    // Re-running into the SAME year must not mint a second Autumn.
    const again = await admin.structure.yearRolloverCommit({
      year: { id: first.yearId },
      classMoves: {},
      studentMoves: {},
      withdraw: [],
      planAmounts: {},
      termsToCreate,
    });
    expect(again.termsCreated).toBe(0);
    expect(app.dbmod.db.select().from(terms).all()).toHaveLength(1);
  });

  it('leaves last year’s unpaid invoices exactly as they are, and reports them first', async () => {
    const { admin, kids } = await madrasah();
    await admin.billing.generatePeriod({ periodKey: '2026-09', labelTemplate: 'Tuition — [month] [year]', dueDate: '2026-09-01' });
    const before = await admin.billing.studentBilling({ studentId: kids.a.id });
    expect(before.balance.owedCents).toBe(20000);

    const plan = await admin.structure.yearRolloverPlan();
    // The figure the office has to look at before moving on.
    expect(plan.owing.families).toBe(4);
    expect(plan.owing.totalCents).toBe(4 * 20000);
    expect(plan.owing.top[0].owedCents).toBe(20000);

    await admin.structure.yearRolloverCommit({
      year: { label: '2027–28', startYear: 2027, startMonth: 9, endMonth: 6 },
      classMoves: asMoves(plan),
      studentMoves: {},
      withdraw: [kids.c.id],
      planAmounts: {},
      termsToCreate: [],
    });

    // Untouched — including for the child who just left. A withdrawn student still owes what they owed.
    expect((await admin.billing.studentBilling({ studentId: kids.a.id })).balance.owedCents).toBe(20000);
    expect((await admin.billing.studentBilling({ studentId: kids.c.id })).balance.owedCents).toBe(20000);
    expect(app.dbmod.db.select().from(invoices).all()).toHaveLength(4);
  });

  it('is one audit entry with the counts, not one per child', async () => {
    const { admin } = await madrasah();
    const plan = await admin.structure.yearRolloverPlan();
    await admin.structure.yearRolloverCommit({
      year: { label: '2027–28', startYear: 2027, startMonth: 9, endMonth: 6 },
      classMoves: asMoves(plan),
      studentMoves: {},
      withdraw: [],
      planAmounts: {},
      termsToCreate: [],
    });
    const rows = app.dbmod.db.select().from(auditLog).all().filter((a) => a.action === 'schoolYear.rollover');
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].detail)).toContain('"moved":3');
  });

  it('is admin-only — finance may read the plan for nothing and may not apply it', async () => {
    await madrasah();
    await expect(caller('finance').structure.yearRolloverPlan()).rejects.toThrow();
    await expect(
      caller('finance').structure.yearRolloverCommit({
        year: { label: 'x', startYear: 2027, startMonth: 9, endMonth: 6 },
        classMoves: {},
        studentMoves: {},
        withdraw: [],
        planAmounts: {},
        termsToCreate: [],
      }),
    ).rejects.toThrow();
  });

  it('refuses a rollover into a year that does not exist, changing nothing', async () => {
    const { admin, ids, kids } = await madrasah();
    const plan = await admin.structure.yearRolloverPlan();
    await expect(
      admin.structure.yearRolloverCommit({
        year: { id: 'syr_nope' },
        classMoves: asMoves(plan),
        studentMoves: {},
        withdraw: [kids.c.id],
        planAmounts: {},
        termsToCreate: [],
      }),
    ).rejects.toThrow();
    // ONE transaction: nobody moved, nobody was withdrawn.
    expect(classOf(kids.a.id).classId).toBe(ids.h1);
    expect(classOf(kids.c.id).status).toBe('active');
  });
});
