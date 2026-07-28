// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Structure: the school year (+ optional terms) and the course → class grouping.
 *
 * This is ORGANISATIONAL ONLY. Courses and classes label students for the directory, the year
 * view, and mass fee/charge apply. They carry no teachers, attendance, grades, or capacity —
 * that scope was removed at v0.35.0 and stays out (CLAUDE.md §4 ❌). Terms exist purely so a
 * madrasah that bills per term can have `fee_plans.cadence = 'per_term'` mean something.
 *
 * Roles: writes are admin (config, LAN-only by the origin policy); reads are admin | finance,
 * because finance needs the grouping to render the directory and the year view.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { router, adminProcedure, adminOrFinanceProcedure, auditActor } from './trpc';
import { db } from '../db';
import { schoolYears, terms, courses, classes, students, families } from '../db/schema';
import { rid } from '../db/ids';
import { audit } from '../audit';

const ID = z.string().min(1).max(64);
const NAME = z.string().trim().min(1).max(120);
const MONTH = z.number().int().min(1).max(12);
const YEAR = z.number().int().min(2000).max(2200);
const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const SORT = z.number().int().min(0).max(9999);
const now = () => new Date();

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
  // ── School year ─────────────────────────────────────────────────────────────
  /** Every school year, current first. `startMonth`/`endMonth` are 1-12; when `endMonth` is
   *  <= `startMonth` the year wraps into the next calendar year (e.g. Apr → Mar). */
  schoolYearList: adminOrFinanceProcedure.query(() =>
    db.select().from(schoolYears).orderBy(asc(schoolYears.status), asc(schoolYears.label)).all(),
  ),

  schoolYearCreate: adminProcedure
    .input(z.object({ label: NAME, startYear: YEAR, startMonth: MONTH, endMonth: MONTH, makeCurrent: z.boolean().optional() }))
    .mutation(({ ctx, input }) => {
      const id = rid('syr');
      const ts = now();
      db.transaction((tx) => {
        // The very first year created becomes current, so a fresh install is never left with
        // no current year (which would leave the year view with nothing to show).
        const first = !tx.select({ id: schoolYears.id }).from(schoolYears).get();
        const current = input.makeCurrent ?? first;
        if (current) tx.update(schoolYears).set({ isCurrent: false, updatedAt: ts }).run();
        tx.insert(schoolYears)
          .values({ id, label: input.label, startYear: input.startYear, startMonth: input.startMonth, endMonth: input.endMonth, isCurrent: current, status: 'active', createdAt: ts, updatedAt: ts })
          .run();
      });
      audit(auditActor(ctx), 'schoolYear.create', { entity: 'schoolYear', entityId: id, detail: { startYear: input.startYear, startMonth: input.startMonth, endMonth: input.endMonth } });
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

  /** Exactly one year is current; setting one clears the rest in the same transaction. */
  schoolYearSetCurrent: adminProcedure.input(z.object({ id: ID })).mutation(({ ctx, input }) => {
    requireSchoolYear(input.id);
    const ts = now();
    db.transaction((tx) => {
      tx.update(schoolYears).set({ isCurrent: false, updatedAt: ts }).run();
      tx.update(schoolYears).set({ isCurrent: true, updatedAt: ts }).where(eq(schoolYears.id, input.id)).run();
    });
    audit(auditActor(ctx), 'schoolYear.setCurrent', { entity: 'schoolYear', entityId: input.id });
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
   *  and the year view both group by. */
  courseTree: adminOrFinanceProcedure.query(() => {
    const cs = db.select().from(courses).where(eq(courses.status, 'active')).orderBy(asc(courses.sortOrder), asc(courses.name)).all();
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

  courseCreate: adminProcedure.input(z.object({ name: NAME, sortOrder: SORT.optional() })).mutation(({ ctx, input }) => {
    const id = rid('crs');
    const ts = now();
    db.insert(courses).values({ id, name: input.name, sortOrder: input.sortOrder ?? 0, status: 'active', createdAt: ts, updatedAt: ts }).run();
    audit(auditActor(ctx), 'course.create', { entity: 'course', entityId: id });
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
    if (input.classId) {
      const k = requireClass(input.classId);
      if (k.status !== 'active') throw new TRPCError({ code: 'CONFLICT', message: 'That class is archived.' });
    }
    db.update(students).set({ classId: input.classId, updatedAt: now() }).where(eq(students.id, input.studentId)).run();
    audit(auditActor(ctx), 'student.setClass', { entity: 'student', entityId: input.studentId, detail: { classId: input.classId } });
    return { ok: true as const };
  }),

  /** Students grouped by course → class for the Students tab, with the unplaced bucket last. */
  studentsByClass: adminOrFinanceProcedure.input(z.object({ includeWithdrawn: z.boolean().optional() }).optional()).query(({ input }) => {
    const rows = db
      .select({
        id: students.id,
        fullName: students.fullName,
        status: students.status,
        familyId: students.familyId,
        familyName: families.name,
        classId: students.classId,
        className: classes.name,
        courseId: courses.id,
        courseName: courses.name,
      })
      .from(students)
      .innerJoin(families, eq(families.id, students.familyId))
      .leftJoin(classes, eq(classes.id, students.classId))
      .leftJoin(courses, eq(courses.id, classes.courseId))
      .where(input?.includeWithdrawn ? undefined : eq(students.status, 'active'))
      .orderBy(asc(courses.sortOrder), asc(courses.name), asc(classes.sortOrder), asc(classes.name), asc(students.fullName))
      .all();
    return rows;
  }),
});
