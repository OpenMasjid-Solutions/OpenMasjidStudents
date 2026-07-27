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

/** The canonical import fields. The web dialog fetches this to build the blank template AND to
 *  auto-match incoming headers, so there is exactly one source of truth for the column set.
 *
 *  THERE IS DELIBERATELY NO ID FIELD. Student IDs are always minted by this app: an ID pays tuition,
 *  so it must be unique per install and derived from the child's own first name, neither of which a
 *  spreadsheet can guarantee. A file that carries an "ID" column has nothing to map it to, so it is
 *  ignored; the dialog lists ignored columns rather than dropping them silently. */
export const IMPORT_FIELDS = [
  { key: 'firstName', label: 'First name', required: true, aliases: ['first', 'first name', 'firstname', 'given name', 'name'] },
  { key: 'lastName', label: 'Last name', required: true, aliases: ['last', 'last name', 'lastname', 'surname', 'family name'] },
  { key: 'familyName', label: 'Family', required: false, aliases: ['family', 'household', 'family label'] },
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
  firstName?: string;
  lastName?: string;
  familyName?: string;
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
    firstName: string;
    lastName: string;
    familyName: string;
    familyExists: boolean;
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
  /** Families that would be created (deduped) — the dialog shows this as the sibling grouping. */
  newFamilies: string[];
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
  const fams = tx.select({ id: families.id, name: families.name }).from(families).all();
  const plans = tx.select({ id: feePlans.id, name: feePlans.name }).from(feePlans).where(eq(feePlans.status, 'active')).all();
  const cls = tx.select({ id: classes.id, name: classes.name, courseId: classes.courseId }).from(classes).where(eq(classes.status, 'active')).all();
  const crs = tx.select({ id: courses.id, name: courses.name }).from(courses).where(eq(courses.status, 'active')).all();
  return {
    familyByName: new Map(fams.map((f) => [key(f.name), f.id])),
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
  // Family names invented by this import, so two sibling rows agree on one new family.
  const pendingFamilies = new Set<string>();
  const out: RowResult[] = [];

  rows.forEach((r, i) => {
    const errors: string[] = [];
    const firstName = norm(r.firstName);
    const lastName = norm(r.lastName);
    if (!firstName) errors.push('First name is required.');
    if (!lastName) errors.push('Last name is required.');

    const familyName = norm(r.familyName) || (lastName ? `${lastName} family` : '');
    const familyExists = !!familyName && L.familyByName.has(key(familyName));
    if (familyName && !familyExists) pendingFamilies.add(familyName);

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
            firstName,
            lastName,
            familyName,
            familyExists,
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
    newFamilies: [...pendingFamilies].sort(),
  };
}

export interface CommitResult {
  created: number;
  familiesCreated: number;
  guardiansCreated: number;
  /** The generated Student IDs, so the admin can print them straight after an import. `studentId` is
   *  the internal row id; `studentCode` is the ID a parent types (never logged or audited — §14). */
  students: { row: number; studentId: string; firstName: string; lastName: string; studentCode: string }[];
}

/** Commit an import. Re-validates first and THROWS if anything is wrong, so the whole file either
 *  lands or does not — no partial roster. */
export function commitRows(rows: ImportRow[], opts: { defaultFeePlanId?: string | null }): CommitResult {
  const check = validateRows(rows, opts);
  if (check.errorCount > 0) throw new Error('invalid_rows');

  const result: CommitResult = { created: 0, familiesCreated: 0, guardiansCreated: 0, students: [] };
  const ts = new Date();

  db.transaction((tx) => {
    const L = lookups(tx);
    // Guardians already on a family, so a repeated parent across sibling rows is linked once.
    const guardianOnFamily = new Map<string, string>(); // `${familyId}|${guardianKey}` → guardianId
    for (const g of tx.select({ id: guardians.id, name: guardians.name, familyId: guardianFamilies.familyId }).from(guardianFamilies).innerJoin(guardians, eq(guardians.id, guardianFamilies.guardianId)).all()) {
      guardianOnFamily.set(`${g.familyId}|${key(g.name)}`, g.id);
    }

    rows.forEach((r, i) => {
      const firstName = norm(r.firstName);
      const lastName = norm(r.lastName);
      const familyName = norm(r.familyName) || `${lastName} family`;

      let familyId = L.familyByName.get(key(familyName));
      if (!familyId) {
        familyId = rid('fam');
        tx.insert(families).values({ id: familyId, name: familyName, status: 'active', createdAt: ts, updatedAt: ts }).run();
        L.familyByName.set(key(familyName), familyId);
        result.familiesCreated++;
      }

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
      const studentCode = generateUniqueStudentCode(firstName);
      const dob = norm(r.dob);
      tx.insert(students)
        .values({
          id: studentId,
          familyId,
          firstName,
          lastName,
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

      const gName = norm(r.guardianName);
      if (gName) {
        const gk = `${familyId}|${key(gName)}`;
        if (!guardianOnFamily.has(gk)) {
          const gid = rid('grd');
          tx.insert(guardians).values({ id: gid, name: gName, phone: norm(r.guardianPhone) || null, email: norm(r.guardianEmail) || null, createdAt: ts, updatedAt: ts }).run();
          tx.insert(guardianFamilies).values({ guardianId: gid, familyId, relation: null, isEmergencyContact: false, createdAt: ts }).run();
          guardianOnFamily.set(gk, gid);
          result.guardiansCreated++;
        }
      }

      result.created++;
      result.students.push({ row: i, studentId, firstName, lastName, studentCode });
    });
  });

  return result;
}
