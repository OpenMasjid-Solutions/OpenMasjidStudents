// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Permanent delete, alongside archive — for the mistakes an office actually makes (a course added
 * twice, a fee plan with a typo, a year entered wrong).
 *
 * The line each of these draws is the same one §9 draws: CONFIGURATION can be deleted, MONEY HISTORY
 * cannot. A fee plan that has appeared on an invoice is part of what that invoice says it was for,
 * so it archives; one that has never been billed is just a wrong row. Courses and classes carry no
 * money at all, so the only thing they must not do is strand the students placed in them.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { paymentAllocations, payments, charges, chargeItems, invoiceItems, invoices, studentFees, feePlans, students, families, classes, courses, terms, schoolYears } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
const caller = (role: Role, origin: 'lan' | 'tunnel' = 'lan') =>
  app.appRouter.createCaller(makeCtx({ origin, session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => { app = await freshApp(); });
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, charges, chargeItems, invoiceItems, invoices, studentFees, feePlans, students, classes, courses, terms, schoolYears, families]) db.delete(t).run();
});

describe('courses and classes', () => {
  it('deletes a course with its classes and unplaces the students, rather than stranding them', async () => {
    const admin = caller('admin');
    const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 35000, cadence: 'monthly' });
    const course = await admin.structure.courseCreate({ name: 'Hifz' });
    const cls = await admin.structure.classCreate({ courseId: course.id, name: 'Hifz 1' });
    const s = await admin.people.studentAdd({ fullName: 'Yusuf Ismail', feePlanId: plan.id, classId: cls.id });

    // The office is told what it is about to do BEFORE clicking.
    expect(await admin.structure.courseDeletable({ id: course.id })).toEqual({ classes: 1, students: 1 });

    expect(await admin.structure.courseDelete({ id: course.id })).toMatchObject({ removedClasses: 1, unplaced: 1 });
    expect(await admin.structure.courseTree()).toHaveLength(0);
    // The child is still here, just unplaced — deleting a grouping must never delete people.
    const roster = await admin.structure.studentsByClass();
    expect(roster.map((r) => ({ id: r.id, classId: r.classId }))).toEqual([{ id: s.id, classId: null }]);
  });

  it('deletes a single class and unplaces only its own students', async () => {
    const admin = caller('admin');
    const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 35000, cadence: 'monthly' });
    const course = await admin.structure.courseCreate({ name: 'Hifz' });
    const one = await admin.structure.classCreate({ courseId: course.id, name: 'Hifz 1' });
    const two = await admin.structure.classCreate({ courseId: course.id, name: 'Hifz 2' });
    await admin.people.studentAdd({ fullName: 'Yusuf Ismail', feePlanId: plan.id, classId: one.id });
    const stays = await admin.people.studentAdd({ fullName: 'Maryam Ismail', feePlanId: plan.id, classId: two.id });

    expect(await admin.structure.classDelete({ id: one.id })).toMatchObject({ unplaced: 1 });
    const roster = await admin.structure.studentsByClass();
    expect(roster.find((r) => r.id === stays.id)!.classId).toBe(two.id);
  });

  it('is admin-only and LAN-only', async () => {
    const admin = caller('admin');
    const course = await admin.structure.courseCreate({ name: 'Hifz' });
    await expect(caller('finance').structure.courseDelete({ id: course.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller('admin', 'tunnel').structure.courseDelete({ id: course.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('school years', () => {
  it('deletes a year and its terms, but refuses the current one', async () => {
    const admin = caller('admin');
    const y = await admin.structure.schoolYearCreate({ label: '2026-27', startYear: 2026, startMonth: 4, endMonth: 3, makeCurrent: true });
    await admin.structure.termCreate({ schoolYearId: y.id, name: 'Term 1' });
    await expect(admin.structure.schoolYearDelete({ id: y.id })).rejects.toMatchObject({ code: 'CONFLICT' });

    const other = await admin.structure.schoolYearCreate({ label: '2027-28', startYear: 2027, startMonth: 4, endMonth: 3, makeCurrent: true });
    expect(await admin.structure.schoolYearDelete({ id: y.id })).toMatchObject({ removedTerms: 1 });
    expect((await admin.structure.schoolYearList()).map((x) => x.id)).toEqual([other.id]);
  });
});

describe('fee plans', () => {
  it('deletes an unbilled plan with its student assignments', async () => {
    const admin = caller('admin');
    const plan = await admin.billing.feePlanCreate({ name: 'Typo plan', amountCents: 35000, cadence: 'monthly' });
    await admin.people.studentAdd({ fullName: 'Yusuf Ismail', feePlanId: plan.id });

    expect(await admin.billing.feePlanDeletable({ id: plan.id })).toMatchObject({ deletable: true, invoiceLines: 0, assignedStudents: 1 });
    expect(await admin.billing.feePlanDelete({ id: plan.id })).toMatchObject({ unassigned: 1 });
    expect(await admin.billing.feePlanList()).toHaveLength(0);
  });

  it('refuses once the plan has been billed — that invoice must keep meaning what it said', async () => {
    const admin = caller('admin');
    const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 35000, cadence: 'monthly' });
    const s = await admin.people.studentAdd({ fullName: 'Yusuf Ismail', feePlanId: plan.id });
    await admin.billing.generateFamily({ familyId: s.familyId, periodKey: '2026-07', label: 'Jul' });

    expect(await admin.billing.feePlanDeletable({ id: plan.id })).toMatchObject({ deletable: false, invoiceLines: 1 });
    await expect(admin.billing.feePlanDelete({ id: plan.id })).rejects.toMatchObject({ code: 'CONFLICT' });
    // Archiving is still the way out, and it leaves the invoice untouched.
    await admin.billing.feePlanArchive({ id: plan.id });
    expect((await admin.billing.studentBilling({ studentId: s.id })).invoices[0].totalCents).toBe(35000);
  });
});

describe('charge items', () => {
  it('deletes an unused item and refuses one that has been charged', async () => {
    const admin = caller('admin');
    const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 35000, cadence: 'monthly' });
    const s = await admin.people.studentAdd({ fullName: 'Yusuf Ismail', feePlanId: plan.id });
    const unused = await admin.billing.chargeItemCreate({ name: 'Unused', defaultAmountCents: 500 });
    const used = await admin.billing.chargeItemCreate({ name: 'Books', defaultAmountCents: 10000 });
    await admin.billing.chargeAdd({ studentId: s.id, source: { kind: 'item', chargeItemId: used.id } });

    await admin.billing.chargeItemDelete({ id: unused.id });
    await expect(admin.billing.chargeItemDelete({ id: used.id })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await admin.billing.chargeItemList()).map((i) => i.name)).toEqual(['Books']);
  });
});
