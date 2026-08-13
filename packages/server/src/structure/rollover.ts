// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Rolling the madrasah over into a new school year (0.48.0).
 *
 * WHAT "ACTIVATE" USED TO DO: flip `school_years.is_current` from one row to another. That one boolean
 * drives six things — the year view's columns, the Generate form's month list, the nightly auto-invoice,
 * the bill-from list, the mid-year wizard and the parents' My-year tab — and NOTHING else. It moved no
 * child, changed no price, closed no class. So a madrasah pressed a button, the page looked the same, and
 * everyone was still in last year's class being billed last year's amount.
 *
 * A rollover is really four decisions, and this module is the one place that knows them:
 *
 *  1. WHERE EACH CLASS GOES. Courses and classes are NOT year-scoped in this schema — a class is a
 *     standing group, not a per-year record — so a rollover moves STUDENTS between existing classes
 *     rather than recreating anything. Each class either stays as it is, moves its children up into
 *     another class, or graduates. Guessed from the class order within a course (`Hifz 1` → `Hifz 2`,
 *     last one graduates) and then corrected by the office, per class or per individual child.
 *  2. WHO IS LEAVING. A graduating class proposes its children as leavers; the office ticks the list, and
 *     ticked children are WITHDRAWN — which stops future billing and keeps the record and the history
 *     (§9: withdrawn, never deleted). Nothing is withdrawn that was not ticked.
 *  3. WHAT THE FEES ARE. Plan amounts may be raised, one by one, and that is all: the plans themselves
 *     carry over and PER-STUDENT OVERRIDES ARE KEPT. An override is how a sibling rate or a bursary is
 *     expressed (§9), and those are agreements with a family rather than properties of a year — clearing
 *     them would quietly re-bill a hardship case at full price.
 *  4. WHAT IS STILL OWED. Nothing at all happens to it. Last year's unpaid invoices are unpaid invoices;
 *     they are per student, immutable, and already carry over by simply existing. The rollover only makes
 *     sure the office has SEEN the figure before moving on, which is the one thing a button-press could
 *     never do.
 *
 * TERMS are the exception to "nothing is year-scoped": `terms.school_year_id` means a new year starts with
 * none, and a `per_term` fee plan silently bills nothing without them. So the closing year's term names are
 * offered for the new one, with any dates shifted a year on.
 *
 * EVERYTHING IS ONE TRANSACTION. A rollover half-applied — children moved but the year not flipped, or
 * fees raised and the leavers still active — is worse than one refused, and there is no undo for it.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { classes, courses, feePlans, schoolYears, studentFees, students, terms, families } from '../db/schema';
import { rid } from '../db/ids';
import { familyBalance } from '../billing/ledger';
import { schoolIdForClass } from '../schools';

/** Where a class's children go. `stay` is the no-op; `graduate` proposes them as leavers. */
export type ClassDestination = { kind: 'stay' } | { kind: 'move'; toClassId: string } | { kind: 'graduate' };

export interface RolloverClass {
  id: string;
  name: string;
  courseId: string;
  courseName: string;
  studentCount: number;
  /** What we think happens to it — the office's starting point, not a decision. */
  suggested: ClassDestination;
  /** The children in it, so one of them can be sent somewhere else than the rest. */
  students: { id: string; fullName: string }[];
}

export interface RolloverPlan {
  /** The year being closed, if there is a current one. */
  closing: { id: string; label: string; startYear: number | null; startMonth: number; endMonth: number } | null;
  /** A suggested label and span for the year being opened — the closing one, a year on. */
  suggestedYear: { label: string; startYear: number; startMonth: number; endMonth: number };
  classes: RolloverClass[];
  /** Every class, for the destination dropdowns. */
  allClasses: { id: string; name: string; courseName: string }[];
  plans: { id: string; name: string; amountCents: number; cadence: string; studentCount: number }[];
  /** The closing year's terms, offered for the new one. */
  termNames: { name: string; startDate: string | null; endDate: string | null }[];
  /** What is still owed, as a figure the office has to look at before moving on. */
  owing: { families: number; totalCents: number; top: { familyId: string; label: string; owedCents: number }[] };
}

/** Add a year to an ISO date, keeping the month and day. Null passes through. */
function yearLater(iso: string | null): string | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  return `${Number(iso.slice(0, 4)) + 1}${iso.slice(4)}`;
}

/**
 * Everything the wizard needs to show, and nothing it does not.
 *
 * The class suggestion is the only clever part: within a course, classes sorted the way the office sorted
 * them, each maps to the next and the last graduates. That is the shape of every madrasah's year list
 * (Oola → Thaniya → Thalitha), and where it is wrong the office changes one dropdown rather than ten.
 */
export function rolloverPlan(schoolId: string | null): RolloverPlan {
  const closing =
    db
      .select()
      .from(schoolYears)
      .where(schoolId ? and(eq(schoolYears.isCurrent, true), eq(schoolYears.schoolId, schoolId)) : eq(schoolYears.isCurrent, true))
      .get() ?? null;

  const courseRows = db
    .select()
    .from(courses)
    .where(schoolId ? and(eq(courses.status, 'active'), eq(courses.schoolId, schoolId)) : eq(courses.status, 'active'))
    .orderBy(asc(courses.sortOrder), asc(courses.name))
    .all();
  const courseIds = courseRows.map((c) => c.id);
  const classRows = courseIds.length
    ? db
        .select()
        .from(classes)
        .where(and(eq(classes.status, 'active'), inArray(classes.courseId, courseIds)))
        .orderBy(asc(classes.sortOrder), asc(classes.name))
        .all()
    : [];

  const kids = db
    .select({ id: students.id, fullName: students.fullName, classId: students.classId })
    .from(students)
    .where(eq(students.status, 'active'))
    .orderBy(asc(students.fullName))
    .all();
  const byClass = new Map<string, { id: string; fullName: string }[]>();
  for (const k of kids) {
    if (!k.classId) continue;
    const list = byClass.get(k.classId);
    if (list) list.push({ id: k.id, fullName: k.fullName });
    else byClass.set(k.classId, [{ id: k.id, fullName: k.fullName }]);
  }

  const courseName = new Map(courseRows.map((c) => [c.id, c.name]));
  const out: RolloverClass[] = classRows.map((k) => {
    const siblings = classRows.filter((x) => x.courseId === k.courseId);
    const at = siblings.findIndex((x) => x.id === k.id);
    const next = siblings[at + 1];
    return {
      id: k.id,
      name: k.name,
      courseId: k.courseId,
      courseName: courseName.get(k.courseId) ?? '',
      studentCount: (byClass.get(k.id) ?? []).length,
      suggested: next ? { kind: 'move', toClassId: next.id } : { kind: 'graduate' },
      students: byClass.get(k.id) ?? [],
    };
  });

  const planRows = db.select().from(feePlans).where(eq(feePlans.status, 'active')).orderBy(asc(feePlans.name)).all();
  // How many children are on each plan, so a price change is never made blind to who it lands on.
  const planCounts = new Map<string, number>();
  for (const r of db.select({ feePlanId: studentFees.feePlanId }).from(studentFees).all()) {
    planCounts.set(r.feePlanId, (planCounts.get(r.feePlanId) ?? 0) + 1);
  }

  // Who still owes. Derived, like every balance in this app — nothing is read from a stored total.
  const owingRows = db
    .select({ id: families.id, name: families.name })
    .from(families)
    .where(eq(families.status, 'active'))
    .all()
    .map((f) => ({ familyId: f.id, label: f.name, owedCents: familyBalance(f.id).owedCents }))
    .filter((f) => f.owedCents > 0)
    .sort((a, b) => b.owedCents - a.owedCents);

  return {
    closing: closing
      ? { id: closing.id, label: closing.label, startYear: closing.startYear, startMonth: closing.startMonth, endMonth: closing.endMonth }
      : null,
    suggestedYear: suggestNextYear(closing),
    classes: out,
    allClasses: classRows.map((k) => ({ id: k.id, name: k.name, courseName: courseName.get(k.courseId) ?? '' })),
    plans: planRows.map((p) => ({ id: p.id, name: p.name, amountCents: p.amountCents, cadence: p.cadence, studentCount: planCounts.get(p.id) ?? 0 })),
    termNames: closing
      ? db
          .select()
          .from(terms)
          .where(eq(terms.schoolYearId, closing.id))
          .orderBy(asc(terms.sortOrder), asc(terms.name))
          .all()
          .map((t) => ({ name: t.name, startDate: yearLater(t.startDate), endDate: yearLater(t.endDate) }))
      : [],
    owing: {
      families: owingRows.length,
      totalCents: owingRows.reduce((s, f) => s + f.owedCents, 0),
      top: owingRows.slice(0, 10),
    },
  };
}

/** The next year's label and span, a year on from the one closing. */
function suggestNextYear(closing: { label: string; startYear: number | null; startMonth: number; endMonth: number } | null): RolloverPlan['suggestedYear'] {
  const thisYear = new Date().getUTCFullYear();
  if (!closing || closing.startYear == null) {
    return { label: `${thisYear}–${String(thisYear + 1).slice(-2)}`, startYear: thisYear, startMonth: 9, endMonth: 6 };
  }
  const startYear = closing.startYear + 1;
  // Bump the years inside whatever the office called it — "2026–27" becomes "2027–28" — and fall back to a
  // plain span when the label is not a pair of years, rather than inventing a naming scheme.
  const label = /(\d{4})\D+(\d{2,4})/.test(closing.label)
    ? closing.label.replace(/(\d{4})(\D+)(\d{2,4})/, (_m, a: string, sep: string, b: string) =>
        `${Number(a) + 1}${sep}${b.length === 2 ? String(Number(b) + 1).padStart(2, '0') : String(Number(b) + 1)}`,
      )
    : `${startYear}–${String(startYear + 1).slice(-2)}`;
  return { label, startYear, startMonth: closing.startMonth, endMonth: closing.endMonth };
}

export interface RolloverInput {
  /** An existing year to make current, or the details of one to create. */
  year: { id: string } | { label: string; startYear: number; startMonth: number; endMonth: number; schoolId?: string | null };
  /** Per class, where its children go. Classes absent from this map are left alone. */
  classMoves: Record<string, ClassDestination>;
  /** Per student, overriding their class's destination. */
  studentMoves: Record<string, ClassDestination>;
  /** Students to withdraw. Only these; a graduating class proposes, it does not decide. */
  withdraw: string[];
  /** New amounts, in cents, for the plans the office chose to change. */
  planAmounts: Record<string, number>;
  /** Term names to create for the new year. */
  termsToCreate: { name: string; startDate: string | null; endDate: string | null }[];
}

export interface RolloverResult {
  yearId: string;
  moved: number;
  graduated: number;
  withdrawn: number;
  plansChanged: number;
  termsCreated: number;
}

/**
 * Apply the rollover. ONE transaction — see the header.
 *
 * Order matters in one place: students are moved before anyone is withdrawn, so a child who is both moved
 * up and then ticked as leaving ends up withdrawn rather than half-processed.
 */
export function commitRollover(input: RolloverInput): RolloverResult {
  return db.transaction((tx) => {
    const ts = new Date();

    // ── The year itself ────────────────────────────────────────────────────────
    let yearId: string;
    let schoolId: string | null;
    if ('id' in input.year) {
      const y = tx.select().from(schoolYears).where(eq(schoolYears.id, input.year.id)).get();
      if (!y) throw new Error('school_year_not_found');
      yearId = y.id;
      schoolId = y.schoolId;
    } else {
      yearId = rid('syr');
      schoolId = input.year.schoolId ?? null;
      tx.insert(schoolYears)
        .values({
          id: yearId,
          schoolId,
          label: input.year.label,
          startYear: input.year.startYear,
          startMonth: input.year.startMonth,
          endMonth: input.year.endMonth,
          isCurrent: false,
          status: 'active',
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
    }

    // ── Move the students ──────────────────────────────────────────────────────
    // Resolved per CHILD: their own instruction if they have one, else their class's.
    const kids = tx
      .select({ id: students.id, classId: students.classId })
      .from(students)
      .where(eq(students.status, 'active'))
      .all();
    let moved = 0;
    let graduated = 0;
    for (const k of kids) {
      const own = input.studentMoves[k.id];
      const byClass = k.classId ? input.classMoves[k.classId] : undefined;
      const dest = own ?? byClass;
      if (!dest || dest.kind === 'stay') continue;
      if (dest.kind === 'graduate') {
        // Graduating only takes them OUT of the class — whether they leave is the withdraw list's job,
        // because a class finishing and a child leaving are not the same fact.
        tx.update(students).set({ classId: null, updatedAt: ts }).where(eq(students.id, k.id)).run();
        graduated++;
        continue;
      }
      // The class decides the school (0.47.0), so moving between schools moves the child with it.
      const toSchool = schoolIdForClass(dest.toClassId);
      tx.update(students)
        .set({ classId: dest.toClassId, ...(toSchool ? { schoolId: toSchool } : {}), updatedAt: ts })
        .where(eq(students.id, k.id))
        .run();
      moved++;
    }

    // ── Withdraw the leavers ───────────────────────────────────────────────────
    let withdrawn = 0;
    for (const id of new Set(input.withdraw)) {
      const r = tx.update(students).set({ status: 'withdrawn', updatedAt: ts }).where(eq(students.id, id)).run();
      if (r.changes) withdrawn++;
    }

    // ── Fees ──────────────────────────────────────────────────────────────────
    // Amounts only. Per-student overrides are deliberately untouched: an override is an agreement with a
    // family, not a property of the year (§9).
    let plansChanged = 0;
    for (const [id, amountCents] of Object.entries(input.planAmounts)) {
      const plan = tx.select({ amountCents: feePlans.amountCents }).from(feePlans).where(eq(feePlans.id, id)).get();
      if (!plan || plan.amountCents === amountCents) continue;
      tx.update(feePlans).set({ amountCents, updatedAt: ts }).where(eq(feePlans.id, id)).run();
      plansChanged++;
    }

    // ── Terms for the new year ─────────────────────────────────────────────────
    let termsCreated = 0;
    input.termsToCreate.forEach((t, i) => {
      const exists = tx.select({ id: terms.id }).from(terms).where(and(eq(terms.schoolYearId, yearId), eq(terms.name, t.name))).get();
      if (exists) return;
      tx.insert(terms)
        .values({ id: rid('trm'), schoolYearId: yearId, name: t.name, startDate: t.startDate, endDate: t.endDate, sortOrder: i, createdAt: ts, updatedAt: ts })
        .run();
      termsCreated++;
    });

    // ── Make it the current year, LAST ─────────────────────────────────────────
    // At most one current year per school (§9), so the flag is cleared across the school first.
    if (schoolId) tx.update(schoolYears).set({ isCurrent: false, updatedAt: ts }).where(eq(schoolYears.schoolId, schoolId)).run();
    else tx.update(schoolYears).set({ isCurrent: false, updatedAt: ts }).run();
    tx.update(schoolYears).set({ isCurrent: true, updatedAt: ts }).where(eq(schoolYears.id, yearId)).run();

    return { yearId, moved, graduated, withdrawn, plansChanged, termsCreated };
  });
}
