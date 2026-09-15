// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * WHAT STILL POINTS AT THIS SCHOOL, OR THIS YEAR — the one place that answers it (§16).
 *
 * `schoolDelete` and `schoolYearDelete` refuse while anything references the row, and say what is in
 * the way. That refusal was a hand-written list of counts inside each procedure, and 0.52.0-dev.9
 * showed exactly how that decays: Phase 2 added `inquiries.school_id` and `inquiries.school_year_id`
 * and `readmissions.school_year_id`, all `ON DELETE restrict`, and neither list was revisited. A
 * masjid that assigned one inquiry to a second school could then never delete that school — the
 * friendly CONFLICT was skipped, SQLite raised `FOREIGN KEY constraint failed`, and the admin was
 * shown "Something went wrong at our end", which §18 forbids and which names nothing they could act
 * on.
 *
 * So the lists live here, next to each other, with the rule stated once:
 *
 *   **ADDING A `RESTRICT` REFERENCE TO `schools` OR `school_years` MEANS ADDING A COUNT HERE.**
 *
 * Phase 3 will add `enrollments`, `sessions` and `closure_days` pointing at a year, and Phases 4–5
 * more again — which is the reason this is a module and not two more inline lists.
 *
 * The counts are labeled rather than raw so the message an office reads is built from the same data
 * the screen's warning is, and the two cannot drift apart.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { courses, inquiries, readmissions, schoolYears, students } from '../db/schema';

export interface Blocker {
  /** What it is, in the words an office would use. Pluralized by the caller with the count. */
  label: string;
  count: number;
}

const count = (rows: unknown[]): number => rows.length;

/**
 * Everything that would stop a school being deleted.
 *
 * `terms` are not here: they hang off a year, and a year is already counted. Nothing else in the
 * schema references `schools` with RESTRICT — `user_schools` is CASCADE, which is correct, because a
 * staff restriction naming a school that no longer exists is meaningless rather than precious.
 */
export function schoolBlockers(schoolId: string): Blocker[] {
  return [
    { label: 'student', count: count(db.select({ id: students.id }).from(students).where(eq(students.schoolId, schoolId)).all()) },
    { label: 'course', count: count(db.select({ id: courses.id }).from(courses).where(eq(courses.schoolId, schoolId)).all()) },
    { label: 'school year', count: count(db.select({ id: schoolYears.id }).from(schoolYears).where(eq(schoolYears.schoolId, schoolId)).all()) },
    // 0.52.0 (§4a Phase 2). The office assigns a school while reviewing an inquiry, so this is
    // reachable on an install with no students, no courses and no years at all — which is precisely
    // the "I added this school by mistake" case the delete exists for.
    { label: 'admissions inquiry', count: count(db.select({ id: inquiries.id }).from(inquiries).where(eq(inquiries.schoolId, schoolId)).all()) },
  ].filter((b) => b.count > 0);
}

/**
 * Everything that would stop a school YEAR being deleted.
 *
 * `terms` are deliberately absent: `schoolYearDelete` removes them with the year, because they are
 * that year's own structure and nothing else points at them. Everything here is something that
 * belongs to somebody ELSE and merely names the year.
 */
export function schoolYearBlockers(schoolYearId: string): Blocker[] {
  return [
    // A re-admission IS about a particular year; deleting the year under it would leave a record of
    // a decision about nothing.
    { label: 're-admission', count: count(db.select({ id: readmissions.id }).from(readmissions).where(eq(readmissions.schoolYearId, schoolYearId)).all()) },
    { label: 'admissions inquiry', count: count(db.select({ id: inquiries.id }).from(inquiries).where(eq(inquiries.schoolYearId, schoolYearId)).all()) },
  ].filter((b) => b.count > 0);
}

/** "2 students, 1 admissions inquiry" — the half of the sentence that names what is in the way. */
export function describeBlockers(blockers: Blocker[]): string {
  return blockers.map((b) => `${b.count} ${b.label}${b.count === 1 ? '' : 's'}`).join(', ');
}

/** The counts as a map, for a screen that wants to warn before the click rather than after it. */
export function blockerCounts(blockers: Blocker[]): Record<string, number> {
  return Object.fromEntries(blockers.map((b) => [b.label, b.count]));
}
