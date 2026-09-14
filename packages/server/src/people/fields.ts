// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * THE STUDENT FIELD REGISTRY — the one place that decides what a student field is (0.52.0).
 *
 * CLAUDE.md §4a Phase 1, §5's medical wall, §9, §16.
 *
 * Three separate questions, answered here and nowhere else, because answering them in three places is
 * how a field an office switched off reaches a CSV export anyway:
 *
 *   1. **Does it exist?**  `STUDENT_FIELDS` is the catalog. Fixed in code — a masjid cannot define its
 *      own (§4 ❌ custom student fields), it can only turn these on and off.
 *   2. **Did the office switch it off?**  `enabledFieldKeys()`, from one settings row.
 *   3. **May this role see it?**  `readableBy` on each spec.
 *
 * ── THE DEFAULT IS THE DANGEROUS WAY ROUND, WHICH IS WHY THIS FILE EXISTS ───
 *
 * `people.familyGet` is an `adminOrFinanceProcedure` that selected the whole `students` row, and the
 * finance shell renders the SAME `FamilyDetail` component the admin shell does — its `readOnly` prop is
 * cosmetic, every occurrence of it wraps a button. So adding a medical column to the table would have
 * handed it to finance **with no code change at all**, and §5's walls would have been broken by an
 * ALTER TABLE. A wall that depends on nobody adding a column is not a wall.
 *
 * The fix is that a role gets an EXPLICIT column list and the query fetches only those columns — the
 * data never leaves the database rather than being fetched and then stripped. A field nobody listed is
 * visible to nobody. That is the opposite of the old default and it is the whole point.
 *
 * The pattern is `settings/index.ts`'s `YEAR_VIEW_COLUMNS`, whose comment gives the reason in one line:
 * "filter against the allow-list so a stale/hand-edited row can never widen what is exposed."
 *
 * ── What is NOT in here ─────────────────────────────────────────────────────
 *
 * `fullName`, `dob`, `status`, `schoolId`, `classId` and `studentCode` are the billing record that
 * predates this (§4a: "a billing record, not a student record"). They are structural — the Student ID
 * is a payment credential, the class is the roster, the status drives every money path — so they are
 * not switchable and they are not listed here. This registry governs the fields Phase 1 ADDED.
 */
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { families, students, type Role } from '../db/schema';
import { getSetting, setSetting, SETTING_KEYS } from '../settings';

/** A field's kind, which is all the UI needs to render and validate it. */
export type StudentFieldKind = 'text' | 'longtext' | 'date' | 'flag';

/**
 * WHO the field is about — and this is a data-model decision, not a layout one (0.52.0-dev.4).
 *
 * `student` lives on `students`; `household` lives on `families`. Address, nationality and languages
 * started on the student and were moved, on Hasan's correction, for the same reason guardians and
 * emergency contacts have always been on the household (§9): a family shares them, so holding them per
 * child means three copies that drift, and an office correcting an address has to remember how many
 * children are on the record. The child-level exception that would have justified per-student — a
 * sibling living elsewhere — is rare enough to be a note, and notes now have a home.
 */
export type FieldScope = 'student' | 'household';

/**
 * How sensitive the field is. `medical` is the §14 amendment and carries every condition attached to
 * it: admin only, off until an office turns it on, never parent-facing, never in a log or an alert.
 */
export type StudentFieldSensitivity = 'ordinary' | 'medical';

export interface StudentFieldSpec {
  readonly key: StudentFieldKey;
  /** The column it lives in — on `students` or on `families`, per `scope`. */
  readonly column: string;
  readonly scope: FieldScope;
  readonly kind: StudentFieldKind;
  /**
   * The column header in a spreadsheet, and what the import auto-matcher recognizes.
   *
   * English literals, like `IMPORT_FIELDS` beside them and for the same reason: this is the header of
   * a FILE, not a label on a screen, and it has to match what the matcher looks for whatever language
   * the office's browser is in. The screen labels are i18n (`record.field.*`) and are a different
   * question about the same field.
   */
  readonly label: string;
  readonly aliases: readonly string[];
  readonly sensitivity: StudentFieldSensitivity;
  /**
   * Which roles may READ it. WRITING is admin-only for every field without exception — the procedures
   * are `adminProcedure`, so there is no per-field write rule to get wrong.
   *
   * `parent` appears nowhere and must not: the portal shows a family their balance and their bills,
   * not the office's record of their child.
   */
  readonly readableBy: readonly Role[];
  /** On unless the office says otherwise. Medical fields are off (§14). */
  readonly onByDefault: boolean;
}

export type StudentFieldKey =
  | 'admittedOn'
  | 'withdrawnOn'
  | 'withdrawalReason'
  | 'address'
  | 'priorSchool'
  | 'priorHifz'
  | 'languages'
  | 'nationality'
  | 'medicalNotes'
  | 'allergies'
  | 'medicalConsent';

const STAFF: readonly Role[] = ['admin', 'finance'];
const ADMIN_ONLY: readonly Role[] = ['admin'];

/**
 * The catalog. ORDER IS THE UI ORDER — the record screen and the Settings panel both read it, so the
 * two cannot drift into different orders and there is nothing to keep in step by hand.
 */
export const STUDENT_FIELDS: readonly StudentFieldSpec[] = [
  // ── About the CHILD ─────────────────────────────────────────────────────────
  { key: 'admittedOn', column: 'admittedOn', scope: 'student', kind: 'date', sensitivity: 'ordinary', readableBy: STAFF, onByDefault: true, label: 'Date of admission', aliases: ['admitted', 'date of admission', 'admission date', 'joined', 'start date', 'enrolled'] },
  { key: 'withdrawnOn', column: 'withdrawnOn', scope: 'student', kind: 'date', sensitivity: 'ordinary', readableBy: STAFF, onByDefault: true, label: 'Date of withdrawal', aliases: ['withdrawn', 'date of withdrawal', 'left', 'leaving date', 'end date'] },
  { key: 'withdrawalReason', column: 'withdrawalReason', scope: 'student', kind: 'text', sensitivity: 'ordinary', readableBy: STAFF, onByDefault: true, label: 'Reason for leaving', aliases: ['reason for leaving', 'withdrawal reason', 'why left'] },
  { key: 'priorSchool', column: 'priorSchool', scope: 'student', kind: 'text', sensitivity: 'ordinary', readableBy: STAFF, onByDefault: true, label: 'Previous school', aliases: ['previous school', 'prior school', 'previous madrasah', 'last school', 'former school'] },
  { key: 'priorHifz', column: 'priorHifz', scope: 'student', kind: 'text', sensitivity: 'ordinary', readableBy: STAFF, onByDefault: true, label: 'Hifz on arrival', aliases: ['hifz on arrival', 'hifz', 'memorization', 'juz memorized', 'quran progress'] },
  // ── The §14 amendment. Admin only, and off on every install until an office asks for them. ──
  { key: 'medicalNotes', column: 'medicalNotes', scope: 'student', kind: 'longtext', sensitivity: 'medical', readableBy: ADMIN_ONLY, onByDefault: false, label: 'Medical notes', aliases: ['medical notes', 'medical', 'health notes', 'conditions'] },
  { key: 'allergies', column: 'allergies', scope: 'student', kind: 'longtext', sensitivity: 'medical', readableBy: ADMIN_ONLY, onByDefault: false, label: 'Allergies', aliases: ['allergies', 'allergy'] },
  { key: 'medicalConsent', column: 'medicalConsent', scope: 'student', kind: 'flag', sensitivity: 'medical', readableBy: ADMIN_ONLY, onByDefault: false, label: 'Emergency medical consent', aliases: ['medical consent', 'emergency medical consent', 'consent'] },

  // ── About the HOUSEHOLD ─────────────────────────────────────────────────────
  // Moved here from the student on Hasan's correction (0.52.0-dev.4). A family shares an address, a
  // nationality and the languages spoken at home; holding them per child meant three copies that
  // drift and an office that has to remember how many children are on the record. Same rule as
  // guardians and emergency contacts (§9) — and linking a sibling is what makes them apply.
  { key: 'address', column: 'address', scope: 'household', kind: 'longtext', sensitivity: 'ordinary', readableBy: STAFF, onByDefault: true, label: 'Address', aliases: ['address', 'home address', 'street', 'postal address'] },
  { key: 'languages', column: 'languages', scope: 'household', kind: 'text', sensitivity: 'ordinary', readableBy: STAFF, onByDefault: true, label: 'Languages spoken', aliases: ['languages', 'languages spoken', 'language', 'home language', 'mother tongue'] },
  { key: 'nationality', column: 'nationality', scope: 'household', kind: 'text', sensitivity: 'ordinary', readableBy: STAFF, onByDefault: true, label: 'Nationality', aliases: ['nationality', 'citizenship', 'country'] },
];

const BY_KEY = new Map(STUDENT_FIELDS.map((f) => [f.key, f]));

export function studentField(key: string): StudentFieldSpec | undefined {
  return BY_KEY.get(key as StudentFieldKey);
}

export const STUDENT_FIELD_KEYS: readonly StudentFieldKey[] = STUDENT_FIELDS.map((f) => f.key);

/**
 * Which fields the office has switched on.
 *
 * Absent setting → the defaults (`onByDefault`). Once a list is stored it is the whole truth, so a
 * field this app adds in a LATER release is off until an office turns it on — the safe direction for a
 * screen holding children's data, and the same direction the medical default already goes.
 *
 * Filtered against the catalog on read, so a hand-edited or stale settings row can never name a field
 * that no longer exists nor widen what is exposed.
 */
export function enabledFieldKeys(): StudentFieldKey[] {
  const raw = getSetting(SETTING_KEYS.studentFields);
  if (!raw) return STUDENT_FIELDS.filter((f) => f.onByDefault).map((f) => f.key);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return STUDENT_FIELDS.filter((f) => f.onByDefault).map((f) => f.key);
    const on = new Set(parsed.filter((k): k is StudentFieldKey => typeof k === 'string' && BY_KEY.has(k as StudentFieldKey)));
    // Catalog order, not the stored order: the UI reads this and the order is the catalog's decision.
    return STUDENT_FIELDS.filter((f) => on.has(f.key)).map((f) => f.key);
  } catch {
    return STUDENT_FIELDS.filter((f) => f.onByDefault).map((f) => f.key);
  }
}

export function setEnabledFieldKeys(keys: StudentFieldKey[]): void {
  const on = new Set(keys.filter((k) => BY_KEY.has(k)));
  setSetting(SETTING_KEYS.studentFields, JSON.stringify(STUDENT_FIELDS.filter((f) => on.has(f.key)).map((f) => f.key)));
}

/**
 * The fields this role may actually see right now — enabled AND readable by them.
 *
 * Both halves, always, in this one function. Asking "is it on?" and "may they see it?" separately is
 * how one of the two gets forgotten at a call site.
 */
export function visibleFields(role: Role, scope?: FieldScope): StudentFieldSpec[] {
  const on = new Set(enabledFieldKeys());
  return STUDENT_FIELDS.filter((f) => on.has(f.key) && f.readableBy.includes(role) && (scope === undefined || f.scope === scope));
}

/**
 * The Drizzle column map to SELECT for this role: the core student record plus whatever extended
 * fields they may see.
 *
 * Returned as columns rather than as a filter applied afterwards, deliberately — a medical note a role
 * may not see is never read out of the database at all, so it cannot be logged by accident on the way
 * through, and a mistake here fails as a missing property rather than as a silent leak.
 */
export function studentColumnsFor(role: Role): Record<string, SQLiteColumn> {
  const cols: Record<string, SQLiteColumn> = {
    id: students.id,
    familyId: students.familyId,
    fullName: students.fullName,
    dob: students.dob,
    status: students.status,
    schoolId: students.schoolId,
    classId: students.classId,
    studentCode: students.studentCode,
    createdAt: students.createdAt,
    updatedAt: students.updatedAt,
  };
  for (const f of visibleFields(role, 'student')) cols[f.key] = (students as unknown as Record<string, SQLiteColumn>)[f.column];
  return cols;
}

/**
 * The same, for the HOUSEHOLD — the core family row plus whatever household-scoped fields this role
 * may see. `familyGet` and the record screen both go through it, so the two cannot disagree about
 * whether finance sees an address.
 */
export function familyColumnsFor(role: Role): Record<string, SQLiteColumn> {
  const cols: Record<string, SQLiteColumn> = {
    id: families.id,
    name: families.name,
    notes: families.notes,
    status: families.status,
    stripeCustomerId: families.stripeCustomerId,
    createdAt: families.createdAt,
    updatedAt: families.updatedAt,
  };
  for (const f of visibleFields(role, 'household')) cols[f.key] = (families as unknown as Record<string, SQLiteColumn>)[f.column];
  return cols;
}

/**
 * Keep only the extended fields this role may see, for a row that has already been read.
 *
 * `studentColumnsFor` is the preferred door and this is the back one: use it where a row arrives from
 * somewhere that cannot choose its own columns. It never adds a key that was not there.
 */
export function pickVisibleFields(row: Record<string, unknown>, role: Role): Record<string, unknown> {
  const allowed = new Set<string>(visibleFields(role).map((f) => f.key));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (BY_KEY.has(k as StudentFieldKey) && !allowed.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Does this install hold any medical data at all?
 *
 * Used by Settings to warn before a medical field is switched OFF: turning it off hides the field, it
 * does not erase what is in it, and an office deserves to be told which of those two it is getting.
 */
export const MEDICAL_FIELD_KEYS: readonly StudentFieldKey[] = STUDENT_FIELDS.filter((f) => f.sensitivity === 'medical').map((f) => f.key);

/**
 * The extended fields as SPREADSHEET columns, for the import template and the data export.
 *
 * Only the ones an office has switched on and this role may see — so a template never carries a
 * column for a field that is off, and an export never carries a medical column to somebody who
 * cannot see it on screen either. Shape matches `IMPORT_FIELDS` so the dialog treats both alike.
 */
export function importFieldsFor(role: Role): { key: StudentFieldKey; label: string; required: false; aliases: string[]; scope: FieldScope; kind: StudentFieldKind; column: string }[] {
  return visibleFields(role).map((f) => ({ key: f.key, label: f.label, required: false as const, aliases: [...f.aliases], scope: f.scope, kind: f.kind, column: f.column }));
}
