// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * THE DEFECTS AN ADVERSARIAL REVIEW OF PHASE 2 FOUND (0.52.0-dev.10).
 *
 * Every test here failed before its fix. They are grouped in one file because they share a cause
 * rather than a subsystem: **new foreign keys and new settings were added without revisiting the code
 * that already depended on there being fewer of them.**
 *
 *  - `schools` and `school_years` gained `RESTRICT` references from `inquiries` and `readmissions`,
 *    and the two delete procedures kept refusing on their old hand-written lists — so a raw
 *    `FOREIGN KEY constraint failed` reached an admin as "Something went wrong at our end", which
 *    §18 forbids, naming nothing they could act on.
 *  - a rule about ONE field decided the fate of two others in `applyDiff`.
 *  - a list arriving from a browser was trusted not to repeat itself.
 *  - a year belongs to one school, and "everyone" did not.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshApp, makeCtx } from './harness';
import { charges, families, feePlans, guardianFamilies, guardians, inquiries, inquiryEvents, readmissions, schoolYears, schools, studentFees, students, auditLog, settings } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let schoolsMod: typeof import('../src/schools');
let readmission: typeof import('../src/admissions/readmission');
let transition: typeof import('../src/admissions/transition');

const caller = (role: Role) =>
  app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp();
  schoolsMod = await import('../src/schools');
  readmission = await import('../src/admissions/readmission');
  transition = await import('../src/admissions/transition');
});

beforeEach(() => {
  const { db } = app.dbmod;
  // FK order, child-first. `student_fees` has to go before `students` — every student created here
  // carries one, because a child on no plan is invisible to invoice generation (`people/create.ts`).
  for (const t of [inquiryEvents, inquiries, readmissions, charges, studentFees, students, guardianFamilies, guardians, families, feePlans, schoolYears, auditLog]) db.delete(t).run();
  db.delete(schools).run();
  db.delete(settings).where(eq(settings.key, 'admissions')).run();
  schoolsMod.ensureDefaultSchool();
});

describe('deleting a school that admissions points at', () => {
  it('is refused with a sentence naming the inquiry, not a 500', async () => {
    const admin = caller('admin');
    // A second school, added to see how it looks. No students, no courses, no years — which is
    // exactly the "I typed it wrong, delete it" case the procedure exists for.
    const { id } = await admin.structure.schoolCreate({ name: 'Evening Hifz' });
    const inq = await admin.admissions.officeAdd({ childName: 'A Child', parentName: 'A Parent', email: 'p@example.org' });
    await admin.admissions.assign({ id: inq.id as string, schoolId: id });

    // Before the fix this raised SQLITE_CONSTRAINT and reached the admin as "Something went wrong at
    // our end" — with nothing on any screen naming the one inquiry pinning the school.
    await expect(admin.structure.schoolDelete({ id })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('admissions inquiry'),
    });
    expect(app.dbmod.db.select().from(schools).all()).toHaveLength(2);

    // ...and the way out actually works: clear the school on the inquiry, then delete.
    await admin.admissions.assign({ id: inq.id as string, schoolId: null });
    await expect(admin.structure.schoolDelete({ id })).resolves.toEqual({ ok: true });
    expect(app.dbmod.db.select().from(schools).all()).toHaveLength(1);
  });

  it('still deletes a school nothing points at', async () => {
    // The control. A refusal that fires for everything is not a guard, it is a broken delete.
    const admin = caller('admin');
    const { id } = await admin.structure.schoolCreate({ name: 'Briefly Considered' });
    await expect(admin.structure.schoolDelete({ id })).resolves.toEqual({ ok: true });
  });

  it('warns on the screen with the same list it refuses on', async () => {
    const admin = caller('admin');
    const { id } = await admin.structure.schoolCreate({ name: 'Evening Hifz' });
    const inq = await admin.admissions.officeAdd({ childName: 'A Child', parentName: 'A Parent', email: 'p2@example.org' });
    await admin.admissions.assign({ id: inq.id as string, schoolId: id });
    const usage = await admin.structure.schoolUsage({ id });
    // Built from `structure/blockers.ts` — the same function the refusal uses, so the warning before
    // the click and the error after it cannot name different things.
    expect(usage.blockers['admissions inquiry']).toBe(1);
  });
});

describe('deleting a school year that admissions points at', () => {
  it('is refused with a sentence naming the re-admissions', async () => {
    const admin = caller('admin');
    const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
    await admin.people.studentAdd({ fullName: 'Yusuf Ismail', feePlanId: plan.id });
    const school = app.dbmod.db.select().from(schools).all()[0];
    const current = await admin.structure.schoolYearCreate({ label: '2026–2027', startYear: 2026, startMonth: 9, endMonth: 6, schoolId: school.id, makeCurrent: true });
    const next = await admin.structure.schoolYearCreate({ label: '2027–2028', startYear: 2027, startMonth: 9, endMonth: 6, schoolId: school.id });
    await admin.admissions.readmissionOpen({ schoolYearId: next.id, target: { kind: 'all' } });

    await expect(admin.structure.schoolYearDelete({ id: next.id })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('re-admission'),
    });
    // The control: a year with nothing against it still deletes.
    const spare = await admin.structure.schoolYearCreate({ label: '2028–2029', startYear: 2028, startMonth: 9, endMonth: 6, schoolId: school.id });
    await expect(admin.structure.schoolYearDelete({ id: spare.id })).resolves.toMatchObject({ ok: true });
    void current;
  });
});

describe('the re-admission diff', () => {
  it('does not discard a phone change because the name box came back empty', async () => {
    // The rule is that a guardian's NAME may not be emptied. The first cut enforced it by skipping
    // the whole guardian update — so a family that cleared the name and fixed their phone number in
    // the same submission had the phone number silently thrown away, and the office's diff said it
    // had been applied.
    const admin = caller('admin');
    const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
    const s = await admin.people.studentAdd({ fullName: 'Yusuf Ismail', feePlanId: plan.id });
    const famId = app.dbmod.db.select().from(students).where(eq(students.id, s.id)).get()!.familyId;
    await admin.people.guardianCreate({ familyId: famId, name: 'Ibrahim Ismail', phone: '07700 900123', email: 'ibrahim@example.org' });
    const school = app.dbmod.db.select().from(schools).all()[0];
    const year = await admin.structure.schoolYearCreate({ label: '2027–2028', startYear: 2027, startMonth: 9, endMonth: 6, schoolId: school.id });
    await admin.admissions.readmissionOpen({ schoolYearId: year.id, target: { kind: 'all' } });
    const r = app.dbmod.db.select().from(readmissions).all()[0];

    await admin.admissions.readmissionSubmitFor({ id: r.id, returning: true, fields: { guardianName: '', guardianPhone: '07700 900999' } });
    await admin.admissions.readmissionApprove({ id: r.id });

    const g = app.dbmod.db.select().from(guardians).all()[0];
    expect(g.phone).toBe('07700 900999'); // the change that was not about the name survived
    expect(g.name).toBe('Ibrahim Ismail'); // ...and the name was not emptied
  });
});

describe('the waitlist queue', () => {
  it('survives a reorder list that names the same row twice', async () => {
    // The list arrives from a browser. A repeated id was numbered twice — the second write winning,
    // the reported count wrong, and every row after it shifted by one, which is the hole in the queue
    // the function exists to prevent.
    const admin = caller('admin');
    const ids: string[] = [];
    for (const n of ['One Child', 'Two Child', 'Three Child']) {
      const inq = await admin.admissions.officeAdd({ childName: n, parentName: `${n} Parent`, email: `${n.split(' ')[0]}@example.org` });
      await admin.admissions.transition({ id: inq.id as string, to: 'waitlisted' });
      ids.push(inq.id as string);
    }
    const r = await admin.admissions.waitlistReorder({ ids: [ids[2], ids[2], ids[0]] });
    expect(r.count).toBe(3);
    const positions = ids.map((id) => app.dbmod.db.select().from(inquiries).where(eq(inquiries.id, id)).get()!.waitlistPosition);
    // Three rows, positions 1..3, each used exactly once.
    expect([...positions].sort()).toEqual([1, 2, 3]);
    expect(new Set(positions).size).toBe(3);
    void transition;
  });
});

describe('re-admission and the school a year belongs to', () => {
  it('does not put another school’s children on this year’s list', async () => {
    // `resolveAudience` applies no school scope, and is right not to — that is its documented
    // contract. But a YEAR belongs to one school, so "ask everyone about the maktab's 2027 year"
    // must not reach the hifz school's roster. A madrasah running two programs on different
    // calendars is the entire reason `schools` exists.
    const admin = caller('admin');
    const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
    const maktab = app.dbmod.db.select().from(schools).all()[0];
    const hifz = await admin.structure.schoolCreate({ name: 'Hifz School' });

    const a = await admin.people.studentAdd({ fullName: 'Maktab Child', feePlanId: plan.id });
    const b = await admin.people.studentAdd({ fullName: 'Hifz Child', feePlanId: plan.id });
    await admin.structure.setStudentSchool({ studentId: b.id, schoolId: hifz.id });

    const year = await admin.structure.schoolYearCreate({ label: '2027–2028', startYear: 2027, startMonth: 9, endMonth: 6, schoolId: maktab.id });
    const r = await admin.admissions.readmissionOpen({ schoolYearId: year.id, target: { kind: 'all' } });

    expect(r.created).toBe(1);
    const opened = app.dbmod.db.select().from(readmissions).all();
    expect(opened.map((x) => x.studentId)).toEqual([a.id]);

    // The control: the hifz school's own year reaches its own child.
    const hifzYear = await admin.structure.schoolYearCreate({ label: '2027–2028 Hifz', startYear: 2027, startMonth: 9, endMonth: 6, schoolId: hifz.id });
    const r2 = await admin.admissions.readmissionOpen({ schoolYearId: hifzYear.id, target: { kind: 'all' } });
    expect(r2.created).toBe(1);
    void readmission;
  });
});

describe('the enrollment fee an office can actually set', () => {
  it('is written by the one editor of a school year, and 0 is stored as no fee', async () => {
    // The columns shipped in dev.7 and nothing wrote them until dev.10 — the whole fee mechanism was
    // unreachable from any screen. `schoolYearUpdate` is the one editor of that row, so it is where
    // they belong rather than in a second writer in the admissions router (§16).
    const admin = caller('admin');
    const school = app.dbmod.db.select().from(schools).all()[0];
    const year = await admin.structure.schoolYearCreate({ label: '2027–2028', startYear: 2027, startMonth: 9, endMonth: 6, schoolId: school.id });
    const read = () => app.dbmod.db.select().from(schoolYears).where(eq(schoolYears.id, year.id)).get()!;

    expect(read().admissionFeeCents).toBeNull(); // a new year charges nothing until somebody says so
    await admin.structure.schoolYearUpdate({ id: year.id, admissionFeeCents: 2500, readmissionFeeCents: 1000 });
    expect(read().admissionFeeCents).toBe(2500);
    expect(read().readmissionFeeCents).toBe(1000);

    // 0 and null both mean "nothing to charge", and one of them looks like a configured price of
    // nothing on a screen. Stored as null so an empty box reads back empty.
    await admin.structure.schoolYearUpdate({ id: year.id, admissionFeeCents: 0 });
    expect(read().admissionFeeCents).toBeNull();
    await admin.structure.schoolYearUpdate({ id: year.id, readmissionFeeCents: null });
    expect(read().readmissionFeeCents).toBeNull();
  });
});
