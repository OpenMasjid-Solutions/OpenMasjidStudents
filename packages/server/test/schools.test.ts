// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Multiple schools in one masjid (0.47.0).
 *
 * The two halves worth pinning are opposites, and getting either backwards breaks a real madrasah:
 *
 *   WHAT IS SCOPED — the school year and the course tree, and therefore which children appear in a
 *   list. Two schools on different calendars each need their own current year, and "Level 1" has to be
 *   allowed to name a room in each.
 *
 *   WHAT IS NOT — the HOUSEHOLD. A family with one child in the maktab and another in hifz is one
 *   family with one balance, one portal login and one printed sheet. Every test below that touches a
 *   sibling pair exists to stop a future change from quietly scoping money by school, which would ask
 *   a parent to pay the masjid twice.
 *
 * Staff restriction is tested as what it is: a way to narrow a working view, never a way to change
 * what a role may do.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshApp, makeCtx } from './harness';
import {
  auditLog, charges, classes, courses, families, feePlans, invoiceItems, invoices,
  paymentAllocations, payments, schoolYears, schools, students, studentFees, userSchools, users,
} from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
/** Loaded dynamically for the same reason the harness does it: config reads env at import time. */
let schoolsMod: typeof import('../src/schools');
const caller = (role: Role, userId = `usr_${role}`, origin: 'lan' | 'tunnel' = 'lan') =>
  app.appRouter.createCaller(makeCtx({ origin, session: { role, source: 'local', username: role, userId } }).ctx);

beforeAll(async () => {
  app = await freshApp();
  schoolsMod = await import('../src/schools');
});
beforeEach(() => {
  const { db } = app.dbmod;
  // Dependency order, because every money FK is ON DELETE RESTRICT (§9): allocations → payments →
  // invoice lines → invoices → charges, and only then the students they all point at.
  for (const t of [
    paymentAllocations, payments, invoiceItems, invoices, charges,
    userSchools, studentFees, students, classes, courses, schoolYears, feePlans, families, auditLog,
  ]) {
    db.delete(t).run();
  }
  db.delete(users).run();
  // Back to exactly one school between tests, so each starts from the single-school install that the
  // overwhelming majority of masajid actually run.
  db.delete(schools).run();
  schoolsMod.ensureDefaultSchool();
});

/** The install as it exists the moment migration 0032 has run: one school, everything under it. */
function theOneSchool(): string {
  const { db } = app.dbmod;
  return db.select().from(schools).all()[0].id;
}

describe('the default school', () => {
  it('exists after migration, so a single-school masjid never meets the concept', async () => {
    const admin = caller('admin');
    const { schools: list, multi } = await admin.structure.schoolList();
    expect(list).toHaveLength(1);
    // `multi` is what the UI hangs the whole switcher off — false here means no tabs are drawn.
    expect(multi).toBe(false);
  });

  it('files a student created without a school under it, rather than leaving them unscoped', async () => {
    const admin = caller('admin');
    const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 35000, cadence: 'monthly' });
    const kid = await admin.people.studentAdd({ fullName: 'Yusuf Ismail', feePlanId: plan.id });

    const { db } = app.dbmod;
    expect(db.select().from(students).where(eq(students.id, kid.id)).get()!.schoolId).toBe(theOneSchool());
    // The real consequence of an unscoped row: it would vanish from every scoped list.
    expect(await admin.structure.studentsByClass({})).toHaveLength(1);
  });
});

describe('two schools', () => {
  async function twoSchools() {
    const admin = caller('admin');
    const maktab = theOneSchool();
    const hifz = (await admin.structure.schoolCreate({ name: 'Hifz programme' })).id;
    return { admin, maktab, hifz };
  }

  it('each keeps its own current school year — setting one does not unset the other', async () => {
    const { admin, maktab, hifz } = await twoSchools();
    const a = await admin.structure.schoolYearCreate({ schoolId: maktab, label: '2026–27', startYear: 2026, startMonth: 9, endMonth: 6 });
    const b = await admin.structure.schoolYearCreate({ schoolId: hifz, label: '1448', startYear: 2026, startMonth: 1, endMonth: 12 });

    const { db } = app.dbmod;
    const current = db.select().from(schoolYears).all().filter((y) => y.isCurrent);
    // Both, not one: an unscoped "clear the others" is exactly the bug this guards.
    expect(current.map((y) => y.id).sort()).toEqual([a.id, b.id].sort());

    // And flipping one school's year still leaves the other school's alone.
    const a2 = await admin.structure.schoolYearCreate({ schoolId: maktab, label: '2027–28', startYear: 2027, startMonth: 9, endMonth: 6, makeCurrent: true });
    const after = db.select().from(schoolYears).all();
    expect(after.find((y) => y.id === a2.id)!.isCurrent).toBe(true);
    expect(after.find((y) => y.id === a.id)!.isCurrent).toBe(false);
    expect(after.find((y) => y.id === b.id)!.isCurrent).toBe(true);
  });

  it('lets the same course name exist in both, but not twice in one', async () => {
    const { admin, maktab, hifz } = await twoSchools();
    await admin.structure.courseCreate({ schoolId: maktab, name: 'Level 1' });
    // The whole reason the unique index moved to (school_id, name).
    await expect(admin.structure.courseCreate({ schoolId: hifz, name: 'Level 1' })).resolves.toBeTruthy();
    await expect(admin.structure.courseCreate({ schoolId: maktab, name: 'Level 1' })).rejects.toThrow(/already a course with that name/i);
  });

  it('shows each school only its own courses and students', async () => {
    const { admin, maktab, hifz } = await twoSchools();
    const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 35000, cadence: 'monthly' });
    const mCourse = await admin.structure.courseCreate({ schoolId: maktab, name: 'Maktab' });
    const mClass = await admin.structure.classCreate({ courseId: mCourse.id, name: 'Year 3' });
    const hCourse = await admin.structure.courseCreate({ schoolId: hifz, name: 'Hifz' });
    const hClass = await admin.structure.classCreate({ courseId: hCourse.id, name: 'Juz 1' });

    const inMaktab = await admin.people.studentAdd({ fullName: 'Yusuf Ismail', feePlanId: plan.id, classId: mClass.id });
    const inHifz = await admin.people.studentAdd({ fullName: 'Bilal Farooqi', feePlanId: plan.id, classId: hClass.id });

    expect((await admin.structure.courseTree({ schoolId: maktab })).map((c) => c.name)).toEqual(['Maktab']);
    expect((await admin.structure.courseTree({ schoolId: hifz })).map((c) => c.name)).toEqual(['Hifz']);
    expect((await admin.structure.studentsByClass({ schoolId: maktab })).map((s) => s.id)).toEqual([inMaktab.id]);
    expect((await admin.structure.studentsByClass({ schoolId: hifz })).map((s) => s.id)).toEqual([inHifz.id]);
    // With no filter an unrestricted admin still sees everyone — the switcher narrows, it does not hide.
    expect(await admin.structure.studentsByClass({})).toHaveLength(2);
  });

  it('moves a child to the school of the class they are placed in', async () => {
    const { admin, maktab, hifz } = await twoSchools();
    const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 35000, cadence: 'monthly' });
    const hCourse = await admin.structure.courseCreate({ schoolId: hifz, name: 'Hifz' });
    const hClass = await admin.structure.classCreate({ courseId: hCourse.id, name: 'Juz 1' });

    // Created with no class, so they land in the first school...
    const kid = await admin.people.studentAdd({ fullName: 'Yusuf Ismail', feePlanId: plan.id });
    const { db } = app.dbmod;
    expect(db.select().from(students).where(eq(students.id, kid.id)).get()!.schoolId).toBe(maktab);

    // ...and placing them in a hifz class must move them, or they would sit outside their own class
    // in every scoped view.
    await admin.structure.setStudentClass({ studentId: kid.id, classId: hClass.id });
    expect(db.select().from(students).where(eq(students.id, kid.id)).get()!.schoolId).toBe(hifz);
  });

  it('counts students per school for the dashboard', async () => {
    const { admin, maktab, hifz } = await twoSchools();
    const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 35000, cadence: 'monthly' });
    await admin.people.studentAdd({ fullName: 'Yusuf Ismail', feePlanId: plan.id, schoolId: maktab });
    await admin.people.studentAdd({ fullName: 'Maryam Ismail', feePlanId: plan.id, schoolId: maktab });
    await admin.people.studentAdd({ fullName: 'Bilal Farooqi', feePlanId: plan.id, schoolId: hifz });

    const counts = await admin.structure.schoolCounts();
    expect(Object.fromEntries(counts.map((c) => [c.id, c.students]))).toEqual({ [maktab]: 2, [hifz]: 1 });
  });
});

describe('a household spans schools', () => {
  it('keeps siblings in different schools on ONE family with ONE balance', async () => {
    const admin = caller('admin');
    const maktab = theOneSchool();
    const hifz = (await admin.structure.schoolCreate({ name: 'Hifz programme' })).id;
    const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 10000, cadence: 'monthly' });

    const yusuf = await admin.people.studentAdd({ fullName: 'Yusuf Ismail', feePlanId: plan.id, schoolId: maktab });
    // Linking a sibling must NOT drag them into the first child's school — different schools in one
    // household is the case this whole feature exists for.
    const maryam = await admin.people.studentAdd({ fullName: 'Maryam Ismail', feePlanId: plan.id, schoolId: hifz, linkToStudentId: yusuf.id });
    expect(maryam.familyId).toBe(yusuf.familyId);

    const { db } = app.dbmod;
    expect(db.select().from(students).where(eq(students.id, maryam.id)).get()!.schoolId).toBe(hifz);

    // One bill run, one household balance covering both children — money is never scoped by school.
    // Generation takes no school either: it bills every active child, whichever school they attend.
    await admin.billing.generatePeriod({ periodKey: '2026-09', label: 'Tuition — Sep 2026' });
    const billing = await admin.billing.familyBilling({ familyId: yusuf.familyId });
    expect(billing.balance.owedCents).toBe(20000);

    // And the directory shows the household WHOLE from either school's view, because a filtered
    // subset of children beside a full balance would not add up.
    for (const schoolId of [maktab, hifz]) {
      const dir = await admin.people.directory({ schoolId });
      const fam = dir.find((f) => f.id === yusuf.familyId)!;
      expect(fam.students.map((s) => s.id).sort()).toEqual([yusuf.id, maryam.id].sort());
    }
  });
});

describe('staff school access', () => {
  /** A real user row — `user_schools` has a foreign key, and the restriction is looked up by user id. */
  async function staffUser(username: string, role: 'admin' | 'finance' = 'finance') {
    const admin = caller('admin');
    return (await admin.staff.create({ username, role, tempPassword: 'a-long-temp-password' })).id;
  }

  it('defaults to every school, so adding a second one locks nobody out', async () => {
    const admin = caller('admin');
    const hifz = (await admin.structure.schoolCreate({ name: 'Hifz programme' })).id;
    const id = await staffUser('aisha');

    const list = await caller('finance', id).structure.schoolList();
    expect(list.schools).toHaveLength(2);
    expect(list.schools.map((s) => s.id)).toContain(hifz);
  });

  it('narrows the view when set, and clears back to all when emptied', async () => {
    const admin = caller('admin');
    const maktab = theOneSchool();
    const hifz = (await admin.structure.schoolCreate({ name: 'Hifz programme' })).id;
    const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 35000, cadence: 'monthly' });
    await admin.people.studentAdd({ fullName: 'Yusuf Ismail', feePlanId: plan.id, schoolId: maktab });
    await admin.people.studentAdd({ fullName: 'Bilal Farooqi', feePlanId: plan.id, schoolId: hifz });

    const id = await staffUser('aisha');
    await admin.staff.setSchools({ userId: id, schoolIds: [hifz] });
    const restricted = caller('finance', id);
    expect((await restricted.structure.schoolList()).schools.map((s) => s.id)).toEqual([hifz]);
    expect((await restricted.structure.studentsByClass({})).map((s) => s.fullName)).toEqual(['Bilal Farooqi']);

    // Asking for a school outside the restriction shows what they MAY see rather than erroring — the
    // usual cause is a stale tab, and they gain nothing they could not already reach.
    expect((await restricted.structure.studentsByClass({ schoolId: maktab })).map((s) => s.fullName)).toEqual(['Bilal Farooqi']);

    await admin.staff.setSchools({ userId: id, schoolIds: [] });
    expect((await restricted.structure.schoolList()).schools).toHaveLength(2);
  });

  it('refuses a write aimed at a school outside the restriction', async () => {
    const admin = caller('admin');
    const maktab = theOneSchool();
    const hifz = (await admin.structure.schoolCreate({ name: 'Hifz programme' })).id;
    const id = await staffUser('umar', 'admin');
    await admin.staff.setSchools({ userId: id, schoolIds: [hifz] });

    // Reads narrow silently; a WRITE must not land somewhere the caller cannot see.
    await expect(caller('admin', id).structure.courseCreate({ schoolId: maktab, name: 'Maktab' })).rejects.toThrow(/access to that school/i);
  });

  it('does not let a school restriction widen what a role may do', async () => {
    const admin = caller('admin');
    const id = await staffUser('aisha');
    await admin.staff.setSchools({ userId: id, schoolIds: [theOneSchool()] });
    // Still finance: role is checked first, school second, always.
    await expect(caller('finance', id).structure.courseCreate({ name: 'Anything' })).rejects.toThrow();
  });

  it('refuses to change your own school access', async () => {
    const admin = caller('admin');
    const id = await staffUser('umar', 'admin');
    await expect(caller('admin', id).staff.setSchools({ userId: id, schoolIds: [] })).rejects.toThrow(/your own school access/i);
  });
});

describe('removing a school', () => {
  it('refuses to remove the last one', async () => {
    const admin = caller('admin');
    await expect(admin.structure.schoolDelete({ id: theOneSchool() })).rejects.toThrow(/only school/i);
    await expect(admin.structure.schoolArchive({ id: theOneSchool() })).rejects.toThrow(/only school/i);
  });

  it('refuses to delete one that still has students, and says what is in the way', async () => {
    const admin = caller('admin');
    const hifz = (await admin.structure.schoolCreate({ name: 'Hifz programme' })).id;
    const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 35000, cadence: 'monthly' });
    await admin.people.studentAdd({ fullName: 'Bilal Farooqi', feePlanId: plan.id, schoolId: hifz });

    await expect(admin.structure.schoolDelete({ id: hifz })).rejects.toThrow(/1 student/);
    // Archiving is the way out, and it leaves the children exactly where they are.
    await expect(admin.structure.schoolArchive({ id: hifz })).resolves.toBeTruthy();
    const { db } = app.dbmod;
    expect(db.select().from(students).all().every((s) => s.schoolId === hifz)).toBe(true);
  });

  it('deletes an empty one', async () => {
    const admin = caller('admin');
    const spare = (await admin.structure.schoolCreate({ name: 'Typo' })).id;
    await expect(admin.structure.schoolDelete({ id: spare })).resolves.toBeTruthy();
    expect((await admin.structure.schoolList()).schools).toHaveLength(1);
  });
});
