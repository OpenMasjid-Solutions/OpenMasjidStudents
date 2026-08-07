// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Structure: the schools, each one's school year (+ optional terms), and the course → class grouping
 * beneath it.
 *
 * This is ORGANISATIONAL ONLY. Courses and classes label students for the directory, the year
 * view, and mass fee/charge apply. They carry no teachers, attendance, grades, or capacity —
 * that scope was removed at v0.35.0 and stays out (CLAUDE.md §4 ❌). Terms exist purely so a
 * madrasah that bills per term can have `fee_plans.cadence = 'per_term'` mean something.
 *
 * SCHOOL SCOPING (0.47.0). Years and courses belong to a school; students are filed under one. Every
 * read here is filtered through `resolveSchoolScope`, so a restricted staff account cannot see another
 * school's structure even by asking for it directly, and every write checks `canAccessSchool` first.
 * Money is NOT scoped anywhere — see schools/index.ts for why the household deliberately spans schools.
 *
 * Roles: writes are admin (config, LAN-only by the origin policy); reads are admin | finance,
 * because finance needs the grouping to render the directory and the year view.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { router, adminProcedure, adminOrFinanceProcedure, auditActor } from './trpc';
import { db } from '../db';
import { schoolYears, schools, terms, courses, classes, students, families } from '../db/schema';
import { rid } from '../db/ids';
import { audit } from '../audit';
import { canAccessSchool, defaultSchoolId, listSchools, newSchoolId, nextSchoolSortOrder, resolveSchoolScope, schoolCounts, schoolIdForClass, visibleSchoolIds } from '../schools';

const ID = z.string().min(1).max(64);
const NAME = z.string().trim().min(1).max(120);
const MONTH = z.number().int().min(1).max(12);
const YEAR = z.number().int().min(2000).max(2200);
const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const SORT = z.number().int().min(0).max(9999);
const now = () => new Date();

/** The caller's own user id — SSO admins have none, which `schools/index.ts` reads as unrestricted. */
const uid = (ctx: { session?: { userId?: string | null } | null }): string | null => ctx.session?.userId ?? null;

/** Refuse a write aimed at a school this account may not touch. Reads narrow silently; writes do not,
 *  because a write that quietly landed somewhere else would be worse than an error. */
function assertSchool(ctx: { session?: { userId?: string | null } | null }, schoolId: string): string {
  if (!canAccessSchool(uid(ctx), schoolId)) throw new TRPCError({ code: 'FORBIDDEN', message: 'You don’t have access to that school.' });
  return schoolId;
}

/** The school a write should land in when the caller didn't name one: their first visible school. */
function fallbackSchool(ctx: { session?: { userId?: string | null } | null }): string {
  const id = visibleSchoolIds(uid(ctx))[0] ?? defaultSchoolId();
  if (!id) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Add a school first.' });
  return id;
}

function requireSchoolYear(id: string) {
  const y = db.select().from(schoolYears).where(eq(schoolYears.id, id)).get();
  if (!y) throw new TRPCError({ code: 'NOT_FOUND', message: 'School year not found.' });
  return y;
}
function requireCourse(id: string) {
  const c = db.select().from(courses).where(eq(courses.id, id)).get();
  if (!c) throw new TRPCError({ code: 'NOT_FOUND', message: 'Course not found.' });
  return c;
}
function requireClass(id: string) {
  const c = db.select().from(classes).where(eq(classes.id, id)).get();
  if (!c) throw new TRPCError({ code: 'NOT_FOUND', message: 'Class not found.' });
  return c;
}

export const structureRouter = router({
  // ── Schools (0.47.0) ────────────────────────────────────────────────────────
  /**
   * The schools this account may see, with the one the UI should open on.
   *
   * `restricted` tells the UI whether to bother showing a switcher at all: a masjid with one school —
   * the overwhelmingly common case — should never see the concept.
   */
  schoolList: adminOrFinanceProcedure.query(({ ctx }) => {
    const allowed = new Set(visibleSchoolIds(uid(ctx)));
    const all = listSchools().filter((s) => allowed.has(s.id));
    return { schools: all, defaultId: all[0]?.id ?? null, multi: all.length > 1 };
  }),

  /** Active students per school — the dashboard tiles. Finance sees it too; it is a headcount, not
   *  money, and finance already reads the directory those numbers come from. */
  schoolCounts: adminOrFinanceProcedure.query(({ ctx }) => schoolCounts(uid(ctx))),

  schoolCreate: adminProcedure.input(z.object({ name: NAME, sortOrder: SORT.optional() })).mutation(({ ctx, input }) => {
    if (db.select({ id: schools.id }).from(schools).where(eq(schools.name, input.name)).get()) {
      throw new TRPCError({ code: 'CONFLICT', message: 'There is already a school with that name.' });
    }
    const id = newSchoolId();
    const ts = now();
    // Appended, not dropped in at 0: the FIRST school in the order is the default one, so a new
    // school sharing a sortOrder could reorder itself ahead of it on a name tie-break and silently steal
    // that role (schools/index.ts).
    db.insert(schools).values({ id, name: input.name, sortOrder: input.sortOrder ?? nextSchoolSortOrder(), status: 'active', createdAt: ts, updatedAt: ts }).run();
    audit(auditActor(ctx), 'school.create', { entity: 'school', entityId: id });
    return { id };
  }),

  schoolUpdate: adminProcedure.input(z.object({ id: ID, name: NAME.optional(), sortOrder: SORT.optional() })).mutation(({ ctx, input }) => {
    assertSchool(ctx, input.id);
    if (!db.select({ id: schools.id }).from(schools).where(eq(schools.id, input.id)).get()) throw new TRPCError({ code: 'NOT_FOUND', message: 'School not found.' });
    const patch: Partial<typeof schools.$inferInsert> = { updatedAt: now() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
    db.update(schools).set(patch).where(eq(schools.id, input.id)).run();
    audit(auditActor(ctx), 'school.update', { entity: 'school', entityId: input.id });
    return { ok: true as const };
  }),

  /** What archiving or deleting this school would take with it — so the UI warns before the click. */
  schoolUsage: adminProcedure.input(z.object({ id: ID })).query(({ ctx, input }) => {
    assertSchool(ctx, input.id);
    return {
      students: db.select({ id: students.id }).from(students).where(eq(students.schoolId, input.id)).all().length,
      courses: db.select({ id: courses.id }).from(courses).where(eq(courses.schoolId, input.id)).all().length,
      years: db.select({ id: schoolYears.id }).from(schoolYears).where(eq(schoolYears.schoolId, input.id)).all().length,
      /** The last one standing cannot go: every student has to be filed somewhere. */
      isLast: listSchools().length <= 1,
    };
  }),

  /** Archive a school. Its students, years and courses stay exactly as they are — this only takes it
   *  out of the switcher, and un-archiving is a straight status flip. */
  schoolArchive: adminProcedure.input(z.object({ id: ID })).mutation(({ ctx, input }) => {
    assertSchool(ctx, input.id);
    if (listSchools().length <= 1) throw new TRPCError({ code: 'CONFLICT', message: 'This is the only school — add another one first.' });
    db.update(schools).set({ status: 'archived', updatedAt: now() }).where(eq(schools.id, input.id)).run();
    audit(auditActor(ctx), 'school.archive', { entity: 'school', entityId: input.id });
    return { ok: true as const };
  }),

  /**
   * Delete a school outright — the "I typed it wrong" case.
   *
   * Refused while anything still points at it. Students, courses and years are NOT reassigned
   * silently: which school a child attends is a real fact about them, and moving thirty children
   * because someone pressed delete is not a decision this should make on their behalf.
   */
  schoolDelete: adminProcedure.input(z.object({ id: ID })).mutation(({ ctx, input }) => {
    assertSchool(ctx, input.id);
    if (listSchools().length <= 1) throw new TRPCError({ code: 'CONFLICT', message: 'This is the only school — add another one first.' });
    const kids = db.select({ id: students.id }).from(students).where(eq(students.schoolId, input.id)).all().length;
    const crs = db.select({ id: courses.id }).from(courses).where(eq(courses.schoolId, input.id)).all().length;
    const yrs = db.select({ id: schoolYears.id }).from(schoolYears).where(eq(schoolYears.schoolId, input.id)).all().length;
    if (kids || crs || yrs) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: `Move or remove this school’s ${[kids && `${kids} student(s)`, crs && `${crs} course(s)`, yrs && `${yrs} school year(s)`].filter(Boolean).join(', ')} first, or archive it instead.`,
      });
    }
    db.delete(schools).where(eq(schools.id, input.id)).run();
    audit(auditActor(ctx), 'school.delete', { entity: 'school', entityId: input.id });
    return { ok: true as const };
  }),

  /** Move a student to another school. Their class is cleared, because a class belongs to the school
   *  they just left — leaving it set would file them in two places at once. */
  setStudentSchool: adminProcedure.input(z.object({ studentId: ID, schoolId: ID })).mutation(({ ctx, input }) => {
    assertSchool(ctx, input.schoolId);
    if (!db.select({ id: students.id }).from(students).where(eq(students.id, input.studentId)).get()) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Student not found.' });
    }
    db.update(students).set({ schoolId: input.schoolId, classId: null, updatedAt: now() }).where(eq(students.id, input.studentId)).run();
    audit(auditActor(ctx), 'student.setSchool', { entity: 'student', entityId: input.studentId, detail: { schoolId: input.schoolId } });
    return { ok: true as const };
  }),

  // ── School year ─────────────────────────────────────────────────────────────
  /** Every school year for the school in scope, current first. `startMonth`/`endMonth` are 1-12; when
   *  `endMonth` is <= `startMonth` the year wraps into the next calendar year (e.g. Apr → Mar). */
  schoolYearList: adminOrFinanceProcedure.input(z.object({ schoolId: ID.optional() }).optional()).query(({ ctx, input }) => {
    const scope = resolveSchoolScope(uid(ctx), input?.schoolId);
    return db
      .select()
      .from(schoolYears)
      .where(inArray(schoolYears.schoolId, scope.ids))
      .orderBy(asc(schoolYears.status), asc(schoolYears.label))
      .all();
  }),

  schoolYearCreate: adminProcedure
    .input(z.object({ schoolId: ID.optional(), label: NAME, startYear: YEAR, startMonth: MONTH, endMonth: MONTH, makeCurrent: z.boolean().optional() }))
    .mutation(({ ctx, input }) => {
      const schoolId = input.schoolId ? assertSchool(ctx, input.schoolId) : fallbackSchool(ctx);
      const id = rid('syr');
      const ts = now();
      db.transaction((tx) => {
        // The first year created FOR THIS SCHOOL becomes current, so a school is never left without
        // one (which would leave its year view with nothing to show). "Current" is per school from
        // 0.47.0 — two schools on different calendars each need one.
        const first = !tx.select({ id: schoolYears.id }).from(schoolYears).where(eq(schoolYears.schoolId, schoolId)).get();
        const current = input.makeCurrent ?? first;
        if (current) tx.update(schoolYears).set({ isCurrent: false, updatedAt: ts }).where(eq(schoolYears.schoolId, schoolId)).run();
        tx.insert(schoolYears)
          .values({ id, schoolId, label: input.label, startYear: input.startYear, startMonth: input.startMonth, endMonth: input.endMonth, isCurrent: current, status: 'active', createdAt: ts, updatedAt: ts })
          .run();
      });
      audit(auditActor(ctx), 'schoolYear.create', { entity: 'schoolYear', entityId: id, detail: { schoolId, startYear: input.startYear, startMonth: input.startMonth, endMonth: input.endMonth } });
      return { id };
    }),

  schoolYearUpdate: adminProcedure
    .input(z.object({ id: ID, label: NAME.optional(), startYear: YEAR.optional(), startMonth: MONTH.optional(), endMonth: MONTH.optional() }))
    .mutation(({ ctx, input }) => {
      requireSchoolYear(input.id);
      const patch: Partial<typeof schoolYears.$inferInsert> = { updatedAt: now() };
      if (input.label !== undefined) patch.label = input.label;
      if (input.startYear !== undefined) patch.startYear = input.startYear;
      if (input.startMonth !== undefined) patch.startMonth = input.startMonth;
      if (input.endMonth !== undefined) patch.endMonth = input.endMonth;
      db.update(schoolYears).set(patch).where(eq(schoolYears.id, input.id)).run();
      audit(auditActor(ctx), 'schoolYear.update', { entity: 'schoolYear', entityId: input.id });
      return { ok: true as const };
    }),

  /** Exactly one year is current PER SCHOOL; setting one clears that school's others in the same
   *  transaction. Scoping the clear is the whole change from 0.47.0 — an unscoped one would switch
   *  the maktab's current year off every time somebody set the hifz programme's. */
  schoolYearSetCurrent: adminProcedure.input(z.object({ id: ID })).mutation(({ ctx, input }) => {
    const y = requireSchoolYear(input.id);
    if (y.schoolId) assertSchool(ctx, y.schoolId);
    const ts = now();
    db.transaction((tx) => {
      if (y.schoolId) tx.update(schoolYears).set({ isCurrent: false, updatedAt: ts }).where(eq(schoolYears.schoolId, y.schoolId)).run();
      tx.update(schoolYears).set({ isCurrent: true, updatedAt: ts }).where(eq(schoolYears.id, input.id)).run();
    });
    audit(auditActor(ctx), 'schoolYear.setCurrent', { entity: 'schoolYear', entityId: input.id, detail: { schoolId: y.schoolId } });
    return { ok: true as const };
  }),

  schoolYearArchive: adminProcedure.input(z.object({ id: ID })).mutation(({ ctx, input }) => {
    const y = requireSchoolYear(input.id);
    if (y.isCurrent) throw new TRPCError({ code: 'CONFLICT', message: 'Make another year current before archiving this one.' });
    db.update(schoolYears).set({ status: 'archived', updatedAt: now() }).where(eq(schoolYears.id, input.id)).run();
    audit(auditActor(ctx), 'schoolYear.archive', { entity: 'schoolYear', entityId: input.id });
    return { ok: true as const };
  }),

  /**
   * Delete a school year outright — the "I typed it wrong" case, as opposed to archiving a year that
   * really happened. Its terms go with it (they are that year's own structure and nothing else
   * points at them).
   *
   * A year holds no money: invoices key off a `YYYY-MM` period string, not a year row, so removing
   * one cannot orphan a bill. What it CAN do is change which months the grid shows, so the current
   * year is refused — make another current first, exactly as archiving requires.
   */
  schoolYearDelete: adminProcedure.input(z.object({ id: ID })).mutation(({ ctx, input }) => {
    const y = requireSchoolYear(input.id);
    if (y.isCurrent) throw new TRPCError({ code: 'CONFLICT', message: 'Make another year current before deleting this one.' });
    let removedTerms = 0;
    db.transaction((tx) => {
      removedTerms = tx.delete(terms).where(eq(terms.schoolYearId, input.id)).run().changes;
      tx.delete(schoolYears).where(eq(schoolYears.id, input.id)).run();
    });
    audit(auditActor(ctx), 'schoolYear.delete', { entity: 'schoolYear', entityId: input.id, detail: { removedTerms } });
    return { ok: true as const, removedTerms };
  }),

  // ── Terms (optional — only for per-term tuition) ─────────────────────────────
  termList: adminOrFinanceProcedure.input(z.object({ schoolYearId: ID })).query(({ input }) =>
    db.select().from(terms).where(eq(terms.schoolYearId, input.schoolYearId)).orderBy(asc(terms.sortOrder), asc(terms.name)).all(),
  ),

  termCreate: adminProcedure
    .input(z.object({ schoolYearId: ID, name: NAME, startDate: ISO_DATE.optional(), endDate: ISO_DATE.optional(), sortOrder: SORT.optional() }))
    .mutation(({ ctx, input }) => {
      requireSchoolYear(input.schoolYearId);
      if (input.startDate && input.endDate && input.endDate < input.startDate) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'The term ends before it starts.' });
      }
      const id = rid('trm');
      const ts = now();
      db.insert(terms)
        .values({ id, schoolYearId: input.schoolYearId, name: input.name, startDate: input.startDate ?? null, endDate: input.endDate ?? null, sortOrder: input.sortOrder ?? 0, createdAt: ts, updatedAt: ts })
        .run();
      audit(auditActor(ctx), 'term.create', { entity: 'term', entityId: id, detail: { schoolYearId: input.schoolYearId } });
      return { id };
    }),

  termUpdate: adminProcedure
    .input(z.object({ id: ID, name: NAME.optional(), startDate: z.union([ISO_DATE, z.literal('')]).optional(), endDate: z.union([ISO_DATE, z.literal('')]).optional(), sortOrder: SORT.optional() }))
    .mutation(({ ctx, input }) => {
      if (!db.select({ id: terms.id }).from(terms).where(eq(terms.id, input.id)).get()) throw new TRPCError({ code: 'NOT_FOUND', message: 'Term not found.' });
      const patch: Partial<typeof terms.$inferInsert> = { updatedAt: now() };
      if (input.name !== undefined) patch.name = input.name;
      if (input.startDate !== undefined) patch.startDate = input.startDate || null;
      if (input.endDate !== undefined) patch.endDate = input.endDate || null;
      if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
      db.update(terms).set(patch).where(eq(terms.id, input.id)).run();
      audit(auditActor(ctx), 'term.update', { entity: 'term', entityId: input.id });
      return { ok: true as const };
    }),

  /** Terms carry no money of their own (invoices key off `periodKey`), so a term is safe to
   *  delete outright — unlike anything on the ledger. */
  termDelete: adminProcedure.input(z.object({ id: ID })).mutation(({ ctx, input }) => {
    db.delete(terms).where(eq(terms.id, input.id)).run();
    audit(auditActor(ctx), 'term.delete', { entity: 'term', entityId: input.id });
    return { ok: true as const };
  }),

  // ── Courses → classes ───────────────────────────────────────────────────────
  /** Active courses with their classes and a live student count — the shape the Students tab
   *  and the year view both group by. Scoped to the school in view (0.47.0). */
  courseTree: adminOrFinanceProcedure.input(z.object({ schoolId: ID.optional() }).optional()).query(({ ctx, input }) => {
    const scope = resolveSchoolScope(uid(ctx), input?.schoolId);
    const cs = db
      .select()
      .from(courses)
      .where(and(eq(courses.status, 'active'), inArray(courses.schoolId, scope.ids)))
      .orderBy(asc(courses.sortOrder), asc(courses.name))
      .all();
    const cls = db.select().from(classes).where(eq(classes.status, 'active')).orderBy(asc(classes.sortOrder), asc(classes.name)).all();
    const counts = new Map<string, number>();
    for (const r of db.select({ classId: students.classId }).from(students).where(eq(students.status, 'active')).all()) {
      if (r.classId) counts.set(r.classId, (counts.get(r.classId) ?? 0) + 1);
    }
    return cs.map((c) => ({
      id: c.id,
      name: c.name,
      sortOrder: c.sortOrder,
      classes: cls.filter((k) => k.courseId === c.id).map((k) => ({ id: k.id, name: k.name, sortOrder: k.sortOrder, studentCount: counts.get(k.id) ?? 0 })),
    }));
  }),

  courseCreate: adminProcedure.input(z.object({ schoolId: ID.optional(), name: NAME, sortOrder: SORT.optional() })).mutation(({ ctx, input }) => {
    const schoolId = input.schoolId ? assertSchool(ctx, input.schoolId) : fallbackSchool(ctx);
    // Unique per school now, not per install — so the clash to report is a name already used in THIS
    // school, and the same name in another one is perfectly fine.
    if (db.select({ id: courses.id }).from(courses).where(and(eq(courses.schoolId, schoolId), eq(courses.name, input.name))).get()) {
      throw new TRPCError({ code: 'CONFLICT', message: 'There is already a course with that name in this school.' });
    }
    const id = rid('crs');
    const ts = now();
    db.insert(courses).values({ id, schoolId, name: input.name, sortOrder: input.sortOrder ?? 0, status: 'active', createdAt: ts, updatedAt: ts }).run();
    audit(auditActor(ctx), 'course.create', { entity: 'course', entityId: id, detail: { schoolId } });
    return { id };
  }),

  courseUpdate: adminProcedure.input(z.object({ id: ID, name: NAME.optional(), sortOrder: SORT.optional() })).mutation(({ ctx, input }) => {
    requireCourse(input.id);
    const patch: Partial<typeof courses.$inferInsert> = { updatedAt: now() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
    db.update(courses).set(patch).where(eq(courses.id, input.id)).run();
    audit(auditActor(ctx), 'course.update', { entity: 'course', entityId: input.id });
    return { ok: true as const };
  }),

  /** Archive, never delete: classes (and through them, students) reference the course. */
  courseArchive: adminProcedure.input(z.object({ id: ID })).mutation(({ ctx, input }) => {
    requireCourse(input.id);
    const ts = now();
    db.transaction((tx) => {
      tx.update(courses).set({ status: 'archived', updatedAt: ts }).where(eq(courses.id, input.id)).run();
      tx.update(classes).set({ status: 'archived', updatedAt: ts }).where(eq(classes.courseId, input.id)).run();
    });
    audit(auditActor(ctx), 'course.archive', { entity: 'course', entityId: input.id });
    return { ok: true as const };
  }),

  /**
   * Delete a course and its classes for good — for one added by mistake, where archiving just leaves
   * clutter behind a toggle.
   *
   * Courses and classes are GROUPING, not money: no invoice, payment or charge references either, so
   * nothing in the ledger can be orphaned by this. The one live reference is `students.class_id`
   * (RESTRICT), so the students in those classes are unplaced first — the same thing archiving does,
   * and the reason a delete cannot simply be a `DELETE`.
   *
   * Reported back so the caller can say "3 students are now unplaced" rather than have it happen
   * silently; `courseDeletable` lets the UI warn BEFORE the click.
   */
  courseDeletable: adminProcedure.input(z.object({ id: ID })).query(({ input }) => {
    requireCourse(input.id);
    const classIds = db.select({ id: classes.id }).from(classes).where(eq(classes.courseId, input.id)).all().map((c) => c.id);
    return {
      classes: classIds.length,
      students: classIds.length ? db.select({ id: students.id }).from(students).where(inArray(students.classId, classIds)).all().length : 0,
    };
  }),

  courseDelete: adminProcedure.input(z.object({ id: ID })).mutation(({ ctx, input }) => {
    requireCourse(input.id);
    let unplaced = 0;
    let removedClasses = 0;
    db.transaction((tx) => {
      const classIds = tx.select({ id: classes.id }).from(classes).where(eq(classes.courseId, input.id)).all().map((c) => c.id);
      if (classIds.length) {
        unplaced = tx.update(students).set({ classId: null, updatedAt: now() }).where(inArray(students.classId, classIds)).run().changes;
        removedClasses = tx.delete(classes).where(eq(classes.courseId, input.id)).run().changes;
      }
      tx.delete(courses).where(eq(courses.id, input.id)).run();
    });
    audit(auditActor(ctx), 'course.delete', { entity: 'course', entityId: input.id, detail: { removedClasses, unplaced } });
    return { ok: true as const, removedClasses, unplaced };
  }),

  classCreate: adminProcedure.input(z.object({ courseId: ID, name: NAME, sortOrder: SORT.optional() })).mutation(({ ctx, input }) => {
    requireCourse(input.courseId);
    const id = rid('cls');
    const ts = now();
    db.insert(classes).values({ id, courseId: input.courseId, name: input.name, sortOrder: input.sortOrder ?? 0, status: 'active', createdAt: ts, updatedAt: ts }).run();
    audit(auditActor(ctx), 'class.create', { entity: 'class', entityId: id, detail: { courseId: input.courseId } });
    return { id };
  }),

  classUpdate: adminProcedure.input(z.object({ id: ID, name: NAME.optional(), sortOrder: SORT.optional() })).mutation(({ ctx, input }) => {
    requireClass(input.id);
    const patch: Partial<typeof classes.$inferInsert> = { updatedAt: now() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
    db.update(classes).set(patch).where(eq(classes.id, input.id)).run();
    audit(auditActor(ctx), 'class.update', { entity: 'class', entityId: input.id });
    return { ok: true as const };
  }),

  /** Archiving a class unplaces its students rather than stranding them in a hidden class —
   *  `students.class_id` is RESTRICT, so it must be cleared before the class can ever be dropped. */
  classArchive: adminProcedure.input(z.object({ id: ID })).mutation(({ ctx, input }) => {
    requireClass(input.id);
    const ts = now();
    let unplaced = 0;
    db.transaction((tx) => {
      unplaced = tx.update(students).set({ classId: null, updatedAt: ts }).where(eq(students.classId, input.id)).run().changes;
      tx.update(classes).set({ status: 'archived', updatedAt: ts }).where(eq(classes.id, input.id)).run();
    });
    audit(auditActor(ctx), 'class.archive', { entity: 'class', entityId: input.id, detail: { unplaced } });
    return { ok: true as const, unplaced };
  }),

  /** Delete one class for good, unplacing its students first (see `courseDelete` for why that is
   *  required and why no money can be orphaned). */
  classDelete: adminProcedure.input(z.object({ id: ID })).mutation(({ ctx, input }) => {
    requireClass(input.id);
    let unplaced = 0;
    db.transaction((tx) => {
      unplaced = tx.update(students).set({ classId: null, updatedAt: now() }).where(eq(students.classId, input.id)).run().changes;
      tx.delete(classes).where(eq(classes.id, input.id)).run();
    });
    audit(auditActor(ctx), 'class.delete', { entity: 'class', entityId: input.id, detail: { unplaced } });
    return { ok: true as const, unplaced };
  }),

  /** Place (or unplace, with `classId: null`) a student. Admin-only, like the rest of the roster. */
  setStudentClass: adminProcedure.input(z.object({ studentId: ID, classId: ID.nullable() })).mutation(({ ctx, input }) => {
    if (!db.select({ id: students.id }).from(students).where(eq(students.id, input.studentId)).get()) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Student not found.' });
    }
    // Placing a child in a class MOVES them to that class's school. A class belongs to exactly one
    // school, so the alternative is a child filed under the maktab while sitting in a hifz class —
    // which every scoped list would then disagree about.
    let schoolId: string | null = null;
    if (input.classId) {
      const k = requireClass(input.classId);
      if (k.status !== 'active') throw new TRPCError({ code: 'CONFLICT', message: 'That class is archived.' });
      schoolId = schoolIdForClass(input.classId);
      if (schoolId) assertSchool(ctx, schoolId);
    }
    db.update(students)
      .set({ classId: input.classId, ...(schoolId ? { schoolId } : {}), updatedAt: now() })
      .where(eq(students.id, input.studentId))
      .run();
    audit(auditActor(ctx), 'student.setClass', { entity: 'student', entityId: input.studentId, detail: { classId: input.classId, schoolId } });
    return { ok: true as const };
  }),

  /**
   * Place MANY students into one class at once — the enrol-a-whole-class action.
   *
   * The per-student dropdown on the roster is the right tool for one correction and the wrong tool for
   * September: putting thirty children into Hifz 1 meant thirty trips through a dropdown. This takes the
   * class and the list, in ONE transaction, so a half-finished enrolment cannot happen.
   *
   * Withdrawn students are skipped rather than refused: a stale browser tab can easily hold a child who
   * left this morning, and failing the whole action over one of them would be the wrong trade. The
   * response says how many were actually placed so the UI can be honest about it.
   */
  setStudentClassBulk: adminProcedure
    .input(z.object({ studentIds: z.array(ID).min(1).max(2000), classId: ID.nullable() }))
    .mutation(({ ctx, input }) => {
      let schoolId: string | null = null;
      if (input.classId) {
        const k = requireClass(input.classId);
        if (k.status !== 'active') throw new TRPCError({ code: 'CONFLICT', message: 'That class is archived.' });
        schoolId = schoolIdForClass(input.classId);
        if (schoolId) assertSchool(ctx, schoolId);
      }
      const live = new Set(
        db
          .select({ id: students.id })
          .from(students)
          .where(and(inArray(students.id, input.studentIds), eq(students.status, 'active')))
          .all()
          .map((r) => r.id),
      );
      const ids = input.studentIds.filter((id) => live.has(id));
      if (!ids.length) return { ok: true as const, placed: 0, skipped: input.studentIds.length };
      const ts = now();
      db.transaction((tx) => {
        tx.update(students)
          .set({ classId: input.classId, ...(schoolId ? { schoolId } : {}), updatedAt: ts })
          .where(inArray(students.id, ids))
          .run();
      });
      // One audit entry with the count, not thirty rows: this was one decision by one person.
      audit(auditActor(ctx), 'student.setClassBulk', { entity: 'class', entityId: input.classId ?? 'none', detail: { classId: input.classId, schoolId, placed: ids.length } });
      return { ok: true as const, placed: ids.length, skipped: input.studentIds.length - ids.length };
    }),

  /** Students grouped by course → class for the Students tab, with the unplaced bucket last.
   *  Scoped to the school in view (0.47.0) — including the unplaced ones, which is why the filter is
   *  on `students.school_id` rather than on the course join. */
  studentsByClass: adminOrFinanceProcedure.input(z.object({ includeWithdrawn: z.boolean().optional(), schoolId: ID.optional() }).optional()).query(({ ctx, input }) => {
    const scope = resolveSchoolScope(uid(ctx), input?.schoolId);
    const rows = db
      .select({
        id: students.id,
        fullName: students.fullName,
        status: students.status,
        /** For the Age column. Sent as the stored 'YYYY-MM-DD' and turned into years in the browser,
         *  because "how old are they today" depends on the reader's date, not the server's. */
        dob: students.dob,
        familyId: students.familyId,
        familyName: families.name,
        classId: students.classId,
        className: classes.name,
        courseId: courses.id,
        courseName: courses.name,
        schoolId: students.schoolId,
      })
      .from(students)
      .innerJoin(families, eq(families.id, students.familyId))
      .leftJoin(classes, eq(classes.id, students.classId))
      .leftJoin(courses, eq(courses.id, classes.courseId))
      .where(and(inArray(students.schoolId, scope.ids), input?.includeWithdrawn ? undefined : eq(students.status, 'active')))
      .orderBy(asc(courses.sortOrder), asc(courses.name), asc(classes.sortOrder), asc(classes.name), asc(students.fullName))
      .all();
    return rows;
  }),
});
