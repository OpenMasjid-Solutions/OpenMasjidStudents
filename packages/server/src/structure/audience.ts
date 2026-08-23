// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * WHO A BULK ACTION IS AIMED AT — the one place that turns "a course / a class / these students /
 * everyone" into a set of student ids (0.51.0).
 *
 * This was `resolveTarget` inside trpc/billing.ts, reached only by the two mass-apply procedures. The
 * onboarding message needs the same question answered, and re-deriving "which students are in this
 * course" beside it is exactly the two-places-one-rule shape that produces this codebase's real bugs
 * (§16) — the more so here, because the two callers would drift on the part that matters most: whether
 * a WITHDRAWN child is included.
 *
 * ALWAYS ACTIVE STUDENTS ONLY, whatever the shape of the target. A stale selection in a browser tab must
 * not be able to bill a child who has left, or write to the family of one; and an id list is re-checked
 * against the roster rather than trusted, because it arrived from a client.
 *
 * `all` IS DELIBERATELY NOT OFFERED TO BILLING. The resolver understands it, and `BULK_TARGET` in
 * trpc/billing.ts does not accept it — a one-click "charge every student in the school" is a different
 * thing from a one-click "write to every family", and the difference is that one of them moves money. The
 * split lives at the two zod boundaries rather than here, so there is still exactly one resolver and each
 * caller declares what it is willing to be asked for.
 *
 * SCHOOL SCOPE is not applied here, matching what `resolveTarget` has always done: the callers' own
 * procedures are where a staff account's school restriction is resolved (schools/index.ts), and the
 * targets that can carry one — a course, a class — are already inside a single school by construction
 * (§9). `all` is the one that reaches across, which is a further reason billing does not take it.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { classes, students } from '../db/schema';

/** The shapes a caller may accept. Compose the union each boundary actually wants — see the header on
 *  why billing takes a narrower one than the onboarding message does. */
export const AUDIENCE_ALL = z.object({ kind: z.literal('all') });
export const AUDIENCE_COURSE = z.object({ kind: z.literal('course'), courseId: z.string().min(1).max(64) });
export const AUDIENCE_CLASS = z.object({ kind: z.literal('class'), classId: z.string().min(1).max(64) });
export const AUDIENCE_STUDENTS = z.object({
  kind: z.literal('students'),
  // Bounded: this arrives from a browser and is turned into a query. A madrasah's whole roster is well
  // inside this, and `all` is the way to say "everyone" anyway.
  studentIds: z.array(z.string().min(1).max(64)).min(1).max(2000),
});

/** Everything, including `all` — what a message-sending boundary accepts. */
export const AUDIENCE = z.discriminatedUnion('kind', [AUDIENCE_ALL, AUDIENCE_COURSE, AUDIENCE_CLASS, AUDIENCE_STUDENTS]);
export type Audience = z.infer<typeof AUDIENCE>;

/** The active students an audience names. Empty is a legitimate answer — an empty class, a selection of
 *  children who have all since been withdrawn — and every caller has to cope with it. */
export function resolveAudience(target: Audience): string[] {
  if (target.kind === 'all') {
    return db.select({ id: students.id }).from(students).where(eq(students.status, 'active')).all().map((r) => r.id);
  }
  if (target.kind === 'students') {
    // Keep only ids that are real AND active — a stale UI selection must not reach a child who has left.
    const live = new Set(
      db
        .select({ id: students.id })
        .from(students)
        .where(and(eq(students.status, 'active'), inArray(students.id, target.studentIds)))
        .all()
        .map((r) => r.id),
    );
    return target.studentIds.filter((id) => live.has(id));
  }
  if (target.kind === 'class') {
    return db
      .select({ id: students.id })
      .from(students)
      .where(and(eq(students.classId, target.classId), eq(students.status, 'active')))
      .all()
      .map((r) => r.id);
  }
  return db
    .select({ id: students.id })
    .from(students)
    .innerJoin(classes, eq(classes.id, students.classId))
    .where(and(eq(classes.courseId, target.courseId), eq(students.status, 'active')))
    .all()
    .map((r) => r.id);
}

/**
 * The HOUSEHOLDS an audience reaches, in a stable order.
 *
 * This is the function that makes "picking a child picks their siblings" true rather than a UI courtesy.
 * Guardians attach to the household, not the student (§9), so a message aimed at Yusuf is a message to
 * the adults who also pay for Maryam — there is no way to write to one child's parents and not the
 * other's, and pretending otherwise in the interface would be a lie about what the send does. The browser
 * ticks siblings so the office can SEE it; this is where it is actually enforced.
 *
 * Deduplicated, so selecting three siblings is one message and not three.
 */
export function householdsFor(studentIds: string[]): string[] {
  if (!studentIds.length) return [];
  const rows = db
    .select({ familyId: students.familyId })
    .from(students)
    .where(and(inArray(students.id, studentIds), eq(students.status, 'active')))
    .all();
  return [...new Set(rows.map((r) => r.familyId))];
}
