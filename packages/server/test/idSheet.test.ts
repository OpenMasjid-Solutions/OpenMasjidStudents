// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The printable Student ID sheet (people/idSheet.ts).
 *
 * It exists because the import's Print button called `window.print()` on a floating window, so the
 * browser printed the app — the page behind it, the window chrome, and 39 children over five sheets of
 * paper. This is a real document instead.
 *
 * What is worth pinning: WHO APPEARS ON IT. A roster sheet that silently omits a child is worse than no
 * sheet, so the two ways that could happen are tested directly — the school filter, and a child with no
 * school on their record. The route's access wall is covered in statementRoute.test.ts, which is where
 * the other printables' walls are.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, ne } from 'drizzle-orm';
import { freshApp, makeCtx } from './harness';
import { studentFees, feePlans, students, classes, courses, families, schoolYears, userSchools, schools, users } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let idSheet: typeof import('../src/people/idSheet');

const caller = (role: Role) =>
  app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp();
  idSheet = await import('../src/people/idSheet');
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [studentFees, feePlans, students, classes, courses, families, schoolYears, userSchools, users]) db.delete(t).run();
  // The DEFAULT school stays — it is created at boot and everything is filed under it. Anything a test
  // added goes, so `multi` is false again for the next one; leaving them would make each test's answer
  // depend on the order the file ran in.
  db.delete(schools).where(ne(schools.id, 'sch_default')).run();
});

/** A roster: two classes in one course, plus a child with no class. */
async function roster() {
  const admin = caller('admin');
  const plan = await admin.billing.feePlanCreate({ name: 'Monthly', amountCents: 10000, cadence: 'monthly' });
  const course = await admin.structure.courseCreate({ name: 'Maktab' });
  const oola = await admin.structure.classCreate({ courseId: course.id, name: 'Oola' });
  const thaania = await admin.structure.classCreate({ courseId: course.id, name: 'Thaania' });
  await admin.people.importCommit({
    defaultFeePlanId: plan.id,
    rows: [
      { fullName: 'Zayd Omar', className: 'Oola' },
      { fullName: 'Abrar Aadi', className: 'Oola' },
      { fullName: 'Bilal Farooqi', className: 'Thaania' },
      { fullName: 'Nobody Placed' },
    ],
  });
  return { admin, oola: oola.id, thaania: thaania.id };
}

const unrestricted = { allowed: [] as string[], restricted: false };

describe('who is on the sheet', () => {
  it('groups by class, with the unplaced children last', async () => {
    await roster();
    const d = idSheet.collectIdSheet([]);
    expect(d.groups.map((g) => g.label)).toEqual(['Maktab — Oola', 'Maktab — Thaania', 'Not in a class yet']);
    // Alphabetical inside a class, which is how a name is looked up.
    expect(d.groups[0].children.map((c) => c.fullName)).toEqual(['Abrar Aadi', 'Zayd Omar']);
    expect(d.total).toBe(4);
    expect(d.missing).toBe(0);
  });

  /**
   * The classes come out in the COURSE TREE's order, not alphabetically by their label. Real madrasa
   * class names sort badly: "Khaamisa (5th Year)" beats "Oola (1st Year)" alphabetically, so an
   * alphabetical sheet opens on the fifth years, which is not the order anybody arranged.
   */
  it('follows the order the office arranged its classes in', async () => {
    const admin = caller('admin');
    const plan = await admin.billing.feePlanCreate({ name: 'Monthly', amountCents: 10000, cadence: 'monthly' });
    const course = await admin.structure.courseCreate({ name: 'Maktab' });
    const named = ['Oola (1st Year)', 'Thaania (2nd Year)', 'Thaalitha (3rd Year)', 'Khaamisa (5th Year)'];
    for (const [i, name] of named.entries()) await admin.structure.classCreate({ courseId: course.id, name, sortOrder: i + 1 });
    await admin.people.importCommit({
      defaultFeePlanId: plan.id,
      rows: named.map((className, i) => ({ fullName: `Child ${i}`, className })),
    });
    expect(idSheet.collectIdSheet([]).groups.map((g) => g.label)).toEqual(named.map((n) => `Maktab — ${n}`));
  });

  it('lists the active roster only — a child who left would make the class counts wrong', async () => {
    const { admin } = await roster();
    const zayd = (await admin.people.directory()).flatMap((f) => f.students).find((s) => s.fullName === 'Zayd Omar')!;
    await admin.people.studentUpdate({ id: zayd.id, status: 'withdrawn' });
    const d = idSheet.collectIdSheet([]);
    expect(d.total).toBe(3);
    expect(d.groups.find((g) => g.label === 'Maktab — Oola')!.children.map((c) => c.fullName)).toEqual(['Abrar Aadi']);
  });

  /**
   * The one that matters most. `visibleSchoolIds` returns EVERY school for an unrestricted account, so
   * the tempting implementation filters `school_id IN (every school)` — which silently drops a child
   * whose school_id is null, and a roster sheet missing a child is exactly the failure to avoid.
   */
  it('includes a child with no school on their record when nothing is being narrowed', async () => {
    const { admin } = await roster();
    const { db } = app.dbmod;
    const bilal = (await admin.people.directory()).flatMap((f) => f.students).find((s) => s.fullName === 'Bilal Farooqi')!;
    db.update(students).set({ schoolId: null }).where(eq(students.id, bilal.id)).run();

    // An unrestricted reader gets no school filter at all, so a null lands on the sheet like any other.
    const html = idSheet.buildIdSheetHtml('all', unrestricted)!;
    expect(html).toContain('Bilal Farooqi');
  });

  it('says so rather than printing a blank when an ID is somehow missing', async () => {
    await roster();
    const { db } = app.dbmod;
    db.update(students).set({ studentCode: null }).run();
    const d = idSheet.collectIdSheet([]);
    expect(d.missing).toBe(d.total);
    expect(idSheet.buildIdSheetHtml('all', unrestricted)!).toContain('no Student ID on record');
  });
});

describe('the sheet itself', () => {
  it('prints every child’s ID, two to a row, on the masjid’s letterhead', async () => {
    const { admin } = await roster();
    await admin.settings.set({ schoolName: 'An-Noor Weekend School' });
    const codes = app.dbmod.db.select({ code: students.studentCode }).from(students).all().map((s) => s.code!);
    expect(codes).toHaveLength(4);

    const html = idSheet.buildIdSheetHtml('all', unrestricted)!;
    for (const code of codes) expect(html).toContain(code);
    expect(html).toContain('An-Noor Weekend School');
    // Two children per printed row is the toner budget — four cells, so two name+ID pairs.
    expect(html).toMatch(/<th>Name<\/th><th class="idcol">Student ID<\/th><th>Name<\/th><th class="idcol">Student ID<\/th>/);
    // It is office paperwork, and says so: a Student ID is the whole credential on the payment path.
    // ASCII apostrophe, matching the other server-rendered sheets (statements.ts, onboardingSheet.ts).
    expect(html).toContain("please don't pin this up in public");
  });

  it('escapes a name rather than letting it reach the page as markup', async () => {
    const { admin } = await roster();
    await admin.people.studentAdd({ fullName: '<script>alert(1)</script>', feePlanId: (await admin.billing.feePlanList())[0].id });
    const html = idSheet.buildIdSheetHtml('all', unrestricted)!;
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('school scope', () => {
  it('shows one school’s roster when a school is asked for', async () => {
    const { admin } = await roster();
    const hifz = await admin.structure.schoolCreate({ name: 'Hifz programme' });
    const other = await admin.structure.courseCreate({ name: 'Hifz', schoolId: hifz.id });
    await admin.structure.classCreate({ courseId: other.id, name: 'Group A' });
    await admin.people.importCommit({
      defaultFeePlanId: (await admin.billing.feePlanList())[0].id,
      schoolId: hifz.id,
      rows: [{ fullName: 'Hafiza Child', className: 'Group A' }],
    });

    const hifzOnly = idSheet.buildIdSheetHtml(hifz.id, unrestricted)!;
    expect(hifzOnly).toContain('Hafiza Child');
    expect(hifzOnly).not.toContain('Abrar Aadi');
    // …and the school is named, because with more than one there is something to disambiguate.
    expect(hifzOnly).toContain('Hifz programme');

    const everyone = idSheet.buildIdSheetHtml('all', unrestricted)!;
    expect(everyone).toContain('Hafiza Child');
    expect(everyone).toContain('Abrar Aadi');
  });

  /** A restriction narrows a view; it must not be widenable by editing a URL. */
  it('refuses a school the reader is not allowed, and narrows "all" to the ones they are', async () => {
    const { admin } = await roster();
    const hifz = await admin.structure.schoolCreate({ name: 'Hifz programme' });
    const restricted = { allowed: [hifz.id], restricted: true };

    // The default school holds the roster above; this reader may only see the hifz programme.
    const defaultSchool = (await admin.structure.schoolList()).schools.find((s) => s.id !== hifz.id)!;
    expect(idSheet.buildIdSheetHtml(defaultSchool.id, restricted)).toBeNull();

    const asAll = idSheet.buildIdSheetHtml('all', restricted)!;
    expect(asAll).not.toContain('Abrar Aadi');
    expect(asAll).toContain('Hifz programme');
  });
});
