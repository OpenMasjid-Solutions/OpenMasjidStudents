// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Schools (0.47.0) — the ONE place that knows which schools exist and which of them a given staff
 * account may see.
 *
 * WHY THIS IS NOT MULTI-TENANCY. CLAUDE.md §4 rules out multi-tenant anything, and this does not
 * breach it: one install is still one masjid, and schools share every setting, every staff account,
 * every fee plan, the Stripe account and the alert list. What a school scopes is deliberately just two
 * things — the school YEAR (a maktab on Sep→Jun beside a hifz program running year-round) and the
 * COURSE tree under it (so "Level 1" can name a room in each). A masjid that runs one school never has
 * to think about any of this.
 *
 * THE HOUSEHOLD IS NEVER SCOPED, and that is the whole design. A family with one child in the maktab
 * and another in hifz is ONE family: one balance, one portal login, one printed sheet, one card charge.
 * So nothing on the money path (families, invoices, payments, allocations, autopay) carries a school
 * id, and no query here filters money. Scoping a bill by school would mean a parent paying the masjid
 * twice, which is the opposite of what this app is for.
 *
 * ACCESS. `user_schools` is an opt-in RESTRICTION, not a grant: no rows means all schools. That
 * default is load-bearing rather than lazy — an install that adds a second school must not silently
 * lock existing staff out of it, and the single-school masjid must never see the concept. It also
 * cannot widen anything: a finance account restricted to one school still sees only what finance sees,
 * and admin is still LAN-only (§12.4). Role first, school second, always.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
import { classes, courses, schoolYears, schools, students, userSchools } from '../db/schema';
import { rid } from '../db/ids';
import { getSchoolName } from '../settings';
import { makeLog } from '../logger';

const log = makeLog('schools');

/**
 * The id migration 0032 gives the first school. Referenced here so `ensureDefaultSchool()` can adopt
 * the row the migration made instead of creating a second one beside it.
 */
export const DEFAULT_SCHOOL_ID = 'sch_default';

export type SchoolRow = { id: string; name: string; sortOrder: number; status: 'active' | 'archived' };

/**
 * Active schools, in the order the tabs show them: the admin's own `sortOrder`, then CREATION ORDER.
 *
 * The tiebreak is creation, deliberately not name. Alphabetical ordering would mean adding a second
 * school could silently change which one is "first" — and since `defaultSchoolId()` is the first one,
 * that would repoint every student created without an explicit school. A masjid adding "Hifz
 * program" beside its existing maktab must not find new children landing in the new school because
 * H sorts before M.
 */
export function listSchools(includeArchived = false): SchoolRow[] {
  return db
    .select({ id: schools.id, name: schools.name, sortOrder: schools.sortOrder, status: schools.status })
    .from(schools)
    .where(includeArchived ? undefined : eq(schools.status, 'active'))
    .orderBy(asc(schools.sortOrder), asc(schools.createdAt), asc(schools.name))
    .all();
}

/**
 * Where a NEW school goes in the order: last (0.48.0).
 *
 * This exists because the first row of this list is the default school — the one every unscoped student,
 * year and course belongs to — so what decides the order decides that. Ordering ends in a name tie-break,
 * and with every school sharing `sortOrder: 0` a second school created in the same MILLISECOND as the
 * first would be sorted by name: "Hifz program" beats "Main school", and adding it would silently move
 * the default. That is the exact bug 0.47.0 fixed, coming back through the tie-break rather than through
 * the primary sort. CI found it; a fast machine is all it takes.
 *
 * Appending removes the tie instead of re-ranking it, so the answer no longer depends on a clock, and
 * "the first school stays the default when you add a second" holds by construction.
 */
export function nextSchoolSortOrder(): number {
  const rows = db.select({ sortOrder: schools.sortOrder }).from(schools).all();
  return rows.reduce((max, r) => Math.max(max, r.sortOrder ?? 0), 0) + 1;
}

/**
 * The school everything unscoped belongs to — the first active one.
 *
 * Ordered rather than "whichever row comes back": an install with two schools must resolve this the
 * same way on every call, or a student created without an explicit school would land somewhere
 * different depending on query planning.
 */
export function defaultSchoolId(): string | null {
  return listSchools()[0]?.id ?? null;
}

/**
 * Make sure there is at least one school and that nothing is left unscoped. Runs at boot, after
 * migrations, and is a no-op on the second call.
 *
 * The migration already does both halves for an install that had data. This exists for the two cases
 * SQL could not cover: a BRAND-NEW database, where the migration's INSERT ran before the admin had
 * typed a school name and so named it "Main school"; and any row that reached the table between the
 * migration and now with a null school (nothing should, but a null here would quietly vanish from
 * every scoped list, which is a bad way to find out).
 *
 * Never throws — a failure here must not stop the server starting, and the next boot retries.
 */
export function ensureDefaultSchool(): string | null {
  try {
    let id = defaultSchoolId();
    if (!id) {
      const ts = new Date();
      id = DEFAULT_SCHOOL_ID;
      // The masjid's own name if it has been set, so the first tab reads like the school rather than
      // like a placeholder. `getSchoolName()` falls back on its own when the setting is empty.
      db.insert(schools).values({ id, name: getSchoolName(), sortOrder: 0, status: 'active', createdAt: ts, updatedAt: ts }).run();
      log.info('created the first school', { id });
    }
    const fixed = {
      years: db.update(schoolYears).set({ schoolId: id, updatedAt: new Date() }).where(isNull(schoolYears.schoolId)).run().changes,
      courses: db.update(courses).set({ schoolId: id, updatedAt: new Date() }).where(isNull(courses.schoolId)).run().changes,
      students: db.update(students).set({ schoolId: id, updatedAt: new Date() }).where(isNull(students.schoolId)).run().changes,
    };
    if (fixed.years || fixed.courses || fixed.students) log.info('assigned unscoped rows to a school', fixed);
    return id;
  } catch (e) {
    log.error('could not ensure a default school', { error: (e as Error).message });
    return null;
  }
}

/**
 * Which schools this account may see. `null`/absent userId (an OpenMasjidOS SSO admin, which has no
 * local user row) means all of them — the platform vouched for them as an admin on the LAN.
 *
 * Returns ids only, so callers filter with `inArray` and never have to know about the empty-means-all
 * rule themselves.
 */
export function visibleSchoolIds(userId: string | null | undefined): string[] {
  const all = listSchools().map((s) => s.id);
  if (!userId) return all;
  const picked = db.select({ schoolId: userSchools.schoolId }).from(userSchools).where(eq(userSchools.userId, userId)).all().map((r) => r.schoolId);
  if (!picked.length) return all; // unrestricted — the default
  // Intersected with the live list so an archived school (or one deleted from under the restriction)
  // cannot come back through this table.
  const live = new Set(all);
  return picked.filter((id) => live.has(id));
}

/** Is this account restricted at all? Used by the UI to say "all schools" instead of listing them. */
export function isSchoolRestricted(userId: string | null | undefined): boolean {
  if (!userId) return false;
  return db.select({ schoolId: userSchools.schoolId }).from(userSchools).where(eq(userSchools.userId, userId)).all().length > 0;
}

/** Replace an account's school restriction. An EMPTY list clears it — back to all schools. */
export function setUserSchools(userId: string, schoolIds: string[]): void {
  const ts = new Date();
  const live = new Set(listSchools(true).map((s) => s.id));
  const ids = [...new Set(schoolIds)].filter((id) => live.has(id));
  db.transaction((tx) => {
    tx.delete(userSchools).where(eq(userSchools.userId, userId)).run();
    for (const schoolId of ids) tx.insert(userSchools).values({ userId, schoolId, createdAt: ts }).run();
  });
}

/**
 * Resolve the school filter for a request: the one the caller asked for when they may see it, or all
 * the ones they may see.
 *
 * Returning a LIST for both cases is deliberate — a caller that forgets the "all schools" case still
 * gets a correctly restricted query rather than an unfiltered one. Asking for a school outside the
 * restriction yields that account's own list rather than an error: the usual cause is a stale browser
 * tab or a bookmark from before the restriction, and silently showing what they may see beats an error
 * page (they gain nothing they could not already see).
 */
export function resolveSchoolScope(userId: string | null | undefined, requested?: string | null): { ids: string[]; requested: string | null } {
  const allowed = visibleSchoolIds(userId);
  if (requested && allowed.includes(requested)) return { ids: [requested], requested };
  return { ids: allowed, requested: null };
}

/** May this account touch this school at all? The write-side counterpart of the scope above. */
export function canAccessSchool(userId: string | null | undefined, schoolId: string): boolean {
  return visibleSchoolIds(userId).includes(schoolId);
}

/** The school a class belongs to, via its course. Placing a child in a class moves them to it. */
export function schoolIdForClass(classId: string): string | null {
  return (
    db
      .select({ schoolId: courses.schoolId })
      .from(classes)
      .innerJoin(courses, eq(courses.id, classes.courseId))
      .where(eq(classes.id, classId))
      .get()?.schoolId ?? null
  );
}

/**
 * Per-school student counts for the dashboard tile.
 *
 * Active children only — a withdrawn child still owes money (which is why the ledger counts them) but
 * "how many students does the maktab have" is a question about who is actually attending.
 */
export function schoolCounts(userId: string | null | undefined): { id: string; name: string; students: number }[] {
  const allowed = visibleSchoolIds(userId);
  if (!allowed.length) return [];
  const counts = new Map<string, number>();
  for (const r of db
    .select({ schoolId: students.schoolId, n: sql<number>`count(*)` })
    .from(students)
    .where(and(eq(students.status, 'active'), inArray(students.schoolId, allowed)))
    .groupBy(students.schoolId)
    .all()) {
    if (r.schoolId) counts.set(r.schoolId, Number(r.n));
  }
  return listSchools()
    .filter((s) => allowed.includes(s.id))
    .map((s) => ({ id: s.id, name: s.name, students: counts.get(s.id) ?? 0 }));
}

/** A fresh school id. Kept here so the prefix is consistent with the rest of the app's ids. */
export function newSchoolId(): string {
  return rid('sch');
}
