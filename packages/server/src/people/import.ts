// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * CSV student import. The browser parses the file and maps its columns onto the canonical fields
 * below (the dialog auto-matches, then the admin confirms), so the server only ever sees clean
 * JSON rows — no multipart, no file on disk.
 *
 * Two phases on purpose:
 *   `validateRows` → a dry run that resolves every family / class / fee plan and reports per-row
 *                    problems, so the dialog can show them BEFORE anything is written.
 *   `commitRows`   → re-validates and writes EVERYTHING IN ONE TRANSACTION. All-or-nothing: a
 *                    half-imported roster of billing records is worse than a rejected file.
 *
 * Names are matched case- and whitespace-insensitively against existing records. Classes and fee
 * plans are never auto-created from a spreadsheet — a typo would silently mint "Hifz 1 " next to
 * "Hifz 1" — so an unknown name is a row error the admin resolves in the dialog. Families ARE
 * created on demand, because that is how siblings group.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db';
import type { Tx } from '../billing/ledger';
import { families, students, guardians, guardianFamilies, feePlans, studentFees, classes, courses } from '../db/schema';
import { rid } from '../db/ids';
import { generateUniqueStudentCode } from '../billing/studentCodes';
import { displayName } from './names';
import { familyLabel } from './household';

/** The canonical import fields. The web dialog fetches this to build the blank template AND to
 *  auto-match incoming headers, so there is exactly one source of truth for the column set.
 *
 *  THERE IS DELIBERATELY NO ID FIELD. Student IDs are always minted by this app: an ID pays tuition,
 *  so it must be unique per install and derived from the child's own given name, neither of which a
 *  spreadsheet can guarantee. A file that carries an "ID" column has nothing to map it to, so it is
 *  ignored; the dialog lists ignored columns rather than dropping them silently.
 *
 *  THERE IS ALSO NO FAMILY COLUMN. An import gives every row its own household, and siblings are
 *  linked afterwards on the student's record (`people.studentLinkSiblings`). Grouping from a
 *  spreadsheet sounded helpful and was not: matching on a surname marries unrelated children who
 *  happen to share one, matching on a typed group key means the office maintains a second name for
 *  something it never names anywhere else, and either way a mistake is buried in a 200-row file
 *  instead of visible on a record. Linking two children takes one click and is unambiguous, so the
 *  import does the part a spreadsheet is good at and leaves the judgement to a person. */
export const IMPORT_FIELDS = [
  { key: 'fullName', label: 'Full name', required: true, aliases: ['name', 'full name', 'fullname', 'student', 'student name', 'first name', 'child', 'child name'] },
  { key: 'dob', label: 'Date of birth', required: false, aliases: ['dob', 'birthdate', 'date of birth', 'birth date'] },
  { key: 'className', label: 'Class', required: false, aliases: ['class', 'section', 'level', 'grade'] },
  { key: 'courseName', label: 'Course', required: false, aliases: ['course', 'program', 'programme'] },
  { key: 'feePlanName', label: 'Fee plan', required: false, aliases: ['fee plan', 'plan', 'tuition plan'] },
  { key: 'amount', label: 'Amount', required: false, aliases: ['amount', 'paying', 'fee', 'tuition', 'monthly'] },
  { key: 'guardianName', label: 'Guardian name', required: false, aliases: ['guardian', 'parent', 'father', 'mother', 'guardian name'] },
  { key: 'guardianPhone', label: 'Guardian phone', required: false, aliases: ['phone', 'mobile', 'cell', 'guardian phone', 'contact'] },
  { key: 'guardianEmail', label: 'Guardian email', required: false, aliases: ['email', 'guardian email', 'e-mail'] },
  { key: 'note', label: 'Note', required: false, aliases: ['note', 'notes', 'comment'] },
] as const;

export type ImportFieldKey = (typeof IMPORT_FIELDS)[number]['key'];

export interface ImportRow {
  fullName?: string;
  dob?: string;
  className?: string;
  courseName?: string;
  feePlanName?: string;
  amount?: string;
  guardianName?: string;
  guardianPhone?: string;
  guardianEmail?: string;
  note?: string;
}

export interface RowResult {
  row: number; // 0-based index into the submitted array
  ok: boolean;
  errors: string[];
  /** What the row resolved to, for the dialog's preview. */
  resolved: {
    fullName: string;
    className: string | null;
    feePlanName: string | null;
    amountCents: number | null;
    guardianName: string | null;
  } | null;
}

export interface ValidateResult {
  rows: RowResult[];
  okCount: number;
  errorCount: number;
}

const norm = (v: string | undefined | null): string => (v ?? '').trim();
const key = (v: string | undefined | null): string => norm(v).toLowerCase().replace(/\s+/g, ' ');

/** "$350", "350", "350.00", "1,250.50" → cents. `null` = absent, `'bad'` = unparseable. */
export function parseAmountCents(v: string | undefined): number | null | 'bad' {
  const s = norm(v).replace(/[$,\s]/g, '');
  if (s === '') return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return 'bad';
  return Math.round(parseFloat(s) * 100);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Everything the validator needs, read once so a 500-row import is not 500× the queries. */
function lookups(tx: Tx) {
  const plans = tx.select({ id: feePlans.id, name: feePlans.name }).from(feePlans).where(eq(feePlans.status, 'active')).all();
  const cls = tx.select({ id: classes.id, name: classes.name, courseId: classes.courseId }).from(classes).where(eq(classes.status, 'active')).all();
  const crs = tx.select({ id: courses.id, name: courses.name }).from(courses).where(eq(courses.status, 'active')).all();
  // No family lookup: an import never matches an existing household, it always makes a new one.
  return {
    planByName: new Map(plans.map((p) => [key(p.name), p.id])),
    classes: cls,
    courseById: new Map(crs.map((c) => [c.id, c.name])),
    courseByName: new Map(crs.map((c) => [key(c.name), c.id])),
  };
}

/** Resolve a class by name, optionally scoped to a course name. Returns the id, or a reason. */
function resolveClass(L: ReturnType<typeof lookups>, className: string, courseName: string): { id: string } | { error: string } {
  const matches = L.classes.filter((c) => key(c.name) === key(className));
  if (matches.length === 0) return { error: `Class "${className}" does not exist — create it first, or clear the column.` };
  if (!courseName) {
    if (matches.length > 1) {
      const where = matches.map((m) => L.courseById.get(m.courseId) ?? '?').join(', ');
      return { error: `Class "${className}" exists in more than one course (${where}) — add a Course column.` };
    }
    return { id: matches[0].id };
  }
  const courseId = L.courseByName.get(key(courseName));
  if (!courseId) return { error: `Course "${courseName}" does not exist.` };
  const scoped = matches.find((m) => m.courseId === courseId);
  if (!scoped) return { error: `Class "${className}" is not in course "${courseName}".` };
  return { id: scoped.id };
}

/** Dry run: resolve every row and collect problems. Writes nothing. */
export function validateRows(rows: ImportRow[], opts: { defaultFeePlanId?: string | null }): ValidateResult {
  const L = lookups(db);
  const defaultPlanOk = opts.defaultFeePlanId ? !!db.select({ id: feePlans.id }).from(feePlans).where(eq(feePlans.id, opts.defaultFeePlanId)).get() : false;
  const out: RowResult[] = [];

  rows.forEach((r, i) => {
    const errors: string[] = [];
    const fullName = norm(r.fullName);
    if (!fullName) errors.push('Name is required.');

    const dob = norm(r.dob);
    if (dob && !ISO_DATE.test(dob)) errors.push(`Date of birth "${dob}" must be YYYY-MM-DD.`);

    let className: string | null = null;
    const rawClass = norm(r.className);
    if (rawClass) {
      const res = resolveClass(L, rawClass, norm(r.courseName));
      if ('error' in res) errors.push(res.error);
      else className = rawClass;
    }

    let feePlanName: string | null = null;
    const rawPlan = norm(r.feePlanName);
    if (rawPlan) {
      if (!L.planByName.has(key(rawPlan))) errors.push(`Fee plan "${rawPlan}" does not exist — create it first, or pick a default plan.`);
      else feePlanName = rawPlan;
    } else if (defaultPlanOk) {
      feePlanName = null; // the default plan is used; nothing to show per row
    } else {
      errors.push('No fee plan: add a Fee plan column, or choose a default plan for the import.');
    }

    const amt = parseAmountCents(r.amount);
    if (amt === 'bad') errors.push(`Amount "${norm(r.amount)}" is not a number.`);

    const guardianEmail = norm(r.guardianEmail);
    if (guardianEmail && !guardianEmail.includes('@')) errors.push(`Guardian email "${guardianEmail}" is not an email address.`);

    out.push({
      row: i,
      ok: errors.length === 0,
      errors,
      resolved: errors.length
        ? null
        : {
            fullName,
            className,
            feePlanName,
            amountCents: amt === 'bad' ? null : amt,
            guardianName: norm(r.guardianName) || null,
          },
    });
  });

  return {
    rows: out,
    okCount: out.filter((r) => r.ok).length,
    errorCount: out.filter((r) => !r.ok).length,
  };
}

export interface CommitResult {
  created: number;
  familiesCreated: number;
  guardiansCreated: number;
  /** The generated Student IDs, so the admin can print them straight after an import. `studentId` is
   *  the internal row id; `studentCode` is the ID a parent types (never logged or audited — §14). */
  students: { row: number; studentId: string; fullName: string; studentCode: string }[];
}

/** Commit an import. Re-validates first and THROWS if anything is wrong, so the whole file either
 *  lands or does not — no partial roster. */
export function commitRows(rows: ImportRow[], opts: { defaultFeePlanId?: string | null }): CommitResult {
  const check = validateRows(rows, opts);
  if (check.errorCount > 0) throw new Error('invalid_rows');

  const result: CommitResult = { created: 0, familiesCreated: 0, guardiansCreated: 0, students: [] };
  const ts = new Date();

  const touchedFamilies = new Set<string>();

  db.transaction((tx) => {
    const L = lookups(tx);

    rows.forEach((r, i) => {
      const fullName = displayName(norm(r.fullName));

      // ONE HOUSEHOLD PER ROW. An import never guesses that two children are siblings; the office
      // links them afterwards, where the decision is visible and reversible. The stored name is a
      // placeholder overwritten by the derived label below.
      const familyId = rid('fam');
      tx.insert(families).values({ id: familyId, name: 'Family', status: 'active', createdAt: ts, updatedAt: ts }).run();
      result.familiesCreated++;
      touchedFamilies.add(familyId);

      const rawClass = norm(r.className);
      let classId: string | null = null;
      if (rawClass) {
        const res = resolveClass(L, rawClass, norm(r.courseName));
        if (!('error' in res)) classId = res.id;
      }

      const rawPlan = norm(r.feePlanName);
      const feePlanId = rawPlan ? L.planByName.get(key(rawPlan))! : opts.defaultFeePlanId!;
      const amt = parseAmountCents(r.amount);
      const overrideAmountCents = amt === 'bad' || amt === null ? null : amt;

      const studentId = rid('stu');
      // The kiosk ID is always generated here and never taken from the spreadsheet — an imported ID
      // could collide with an existing child's or be chosen to impersonate one.
      const studentCode = generateUniqueStudentCode(fullName);
      const dob = norm(r.dob);
      tx.insert(students)
        .values({
          id: studentId,
          familyId,
          fullName,
          dob: dob || null,
          status: 'active',
          notes: norm(r.note) || null,
          classId,
          studentCode,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
      tx.insert(studentFees).values({ id: rid('stf'), studentId, feePlanId, overrideAmountCents, note: null, createdAt: ts, updatedAt: ts }).run();

      // One household per row means one guardian per row — there is no cross-row dedupe to do. Two
      // rows naming the same parent get a guardian record each; linking the children afterwards
      // merges the households, and the duplicate is then visible on one record where it can be
      // removed. That is a better place for it than a silent match inside the import.
      const gName = norm(r.guardianName);
      if (gName) {
        const gid = rid('grd');
        tx.insert(guardians).values({ id: gid, name: gName, phone: norm(r.guardianPhone) || null, email: norm(r.guardianEmail) || null, createdAt: ts, updatedAt: ts }).run();
        tx.insert(guardianFamilies).values({ guardianId: gid, familyId, relation: null, isEmergencyContact: false, createdAt: ts }).run();
        result.guardiansCreated++;
      }

      result.created++;
      result.students.push({ row: i, studentId, fullName, studentCode });
    });

    // Each new household takes the label derived from its child, so an imported record reads exactly
    // like one added through the UI instead of keeping the placeholder above.
    for (const familyId of touchedFamilies) {
      tx.update(families).set({ name: familyLabel(familyId, tx), updatedAt: ts }).where(eq(families.id, familyId)).run();
    }
  });

  return result;
}
