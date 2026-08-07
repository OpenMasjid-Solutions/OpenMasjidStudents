// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Student import. The browser reads the file — a CSV or a .xlsx — and maps its columns onto the
 * canonical fields below (the dialog auto-matches, then the admin confirms), so the server only ever
 * sees clean JSON rows: no multipart, no file on disk holding minors' details.
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
 *
 * ONE STUDENT IS NOT ALWAYS ONE ROW (0.48.0). Exports name the child once and then give each further
 * adult a row of their own, with the student columns left empty — see `mergeRows`.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import type { Tx } from '../billing/ledger';
import { families, students, guardians, guardianFamilies, emergencyContacts, feePlans, studentFees, classes, courses } from '../db/schema';
import { rid } from '../db/ids';
import { generateUniqueStudentCode } from '../billing/studentCodes';
import { displayName } from './names';
import { familyLabel } from './household';
import { defaultSchoolId, schoolIdForClass } from '../schools';
import { DATE_FORMAT_SAMPLES, getDateFormat, parseDateInput, type DateFormat } from '../settings/dates';

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
 *  import does the part a spreadsheet is good at and leaves the judgement to a person.
 *
 *  The aliases are the headers real exports use, not the ones we would have chosen — "Birthday",
 *  "Homeroom" and "Relationship" are all QuickSchools' words, and matching them is the difference
 *  between an office confirming a mapping and an office building one by hand. */
export const IMPORT_FIELDS = [
  { key: 'fullName', label: 'Full name', required: true, aliases: ['name', 'full name', 'fullname', 'student', 'student name', 'first name', 'child', 'child name'] },
  { key: 'dob', label: 'Date of birth', required: false, aliases: ['dob', 'birthdate', 'birthday', 'date of birth', 'birth date'] },
  { key: 'className', label: 'Class', required: false, aliases: ['class', 'section', 'level', 'grade', 'homeroom'] },
  { key: 'courseName', label: 'Course', required: false, aliases: ['course', 'program', 'programme'] },
  { key: 'feePlanName', label: 'Fee plan', required: false, aliases: ['fee plan', 'plan', 'tuition plan'] },
  { key: 'amount', label: 'Amount', required: false, aliases: ['amount', 'paying', 'fee', 'tuition', 'monthly'] },
  { key: 'guardianName', label: 'Guardian name', required: false, aliases: ['guardian', 'parent', 'father', 'mother', 'guardian name'] },
  { key: 'guardianRelation', label: 'Relationship', required: false, aliases: ['relationship', 'relation', 'guardian relationship', 'parent relationship'] },
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
  guardianRelation?: string;
  guardianPhone?: string;
  guardianEmail?: string;
  note?: string;
}

/** A person from one row's guardian columns, and which file row they came from. */
export interface ImportContact {
  name: string;
  relation: string;
  phone: string;
  email: string;
  /** Index in the submitted array — the same row a nameless continuation row occupied. */
  row: number;
}

/** Where an imported contact is filed: as one of the household's guardians (they appear on the
 *  family record, can be invited to the parent portal, and are who the office rings about money), or
 *  as an emergency contact (a name and a number, and nothing else). */
export type ContactPlacement = 'guardian' | 'emergency';

/** The office's answer, once per distinct relation label (keyed by `key()`). */
export type Placements = Record<string, ContactPlacement>;

export interface ResolvedContact extends ImportContact {
  placement: ContactPlacement;
  /** True when the office was asked about this relation rather than it being plainly a parent. */
  asked: boolean;
}

export interface RowResult {
  row: number; // 0-based index into the submitted array — the row that carried the name
  /** Every submitted row that makes up this student, the named one first. More than one when
   *  nameless rows were folded in (`mergeRows`). */
  sourceRows: number[];
  ok: boolean;
  errors: string[];
  /** The people these rows named, and where each will be filed. Present even for a failed row: when
   *  something is wrong, seeing how the rows were grouped is most of the explanation. */
  contacts: ResolvedContact[];
  /** What the row resolved to, for the dialog's preview. */
  resolved: {
    fullName: string;
    className: string | null;
    feePlanName: string | null;
    amountCents: number | null;
  } | null;
}

export interface ValidateResult {
  rows: RowResult[];
  okCount: number;
  errorCount: number;
  /** How many file rows were folded into the student above them. */
  mergedCount: number;
  /** The relation labels the office still has to place — spelled as the file spelled them, with how
   *  many people carry each, so the question is asked once per label instead of once per person. */
  askRelations: { key: string; label: string; count: number }[];
}

const norm = (v: string | undefined | null): string => (v ?? '').trim();
const key = (v: string | undefined | null): string => norm(v).toLowerCase().replace(/\s+/g, ' ');

/** A submitted row index as the line the office sees in their file: 1-based, with the header first.
 *  Both readers (CSV and XLSX) treat the first non-empty row as the header, so this holds for both. */
const fileLine = (row: number): number => row + 2;

/** As long as a relation may be, matching the guardian form's own limit (trpc/people.ts RELATION).
 *  It is also the bound on a placement key, since that key IS the label out of the file. */
const MAX_RELATION = 60;

/** "$350", "350", "350.00", "1,250.50" → cents. `null` = absent, `'bad'` = unparseable. */
export function parseAmountCents(v: string | undefined): number | null | 'bad' {
  const s = norm(v).replace(/[$,\s]/g, '');
  if (s === '') return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return 'bad';
  return Math.round(parseFloat(s) * 100);
}

/**
 * A spreadsheet's date column, read in the format this masjid uses (0.47.0).
 *
 * Was ISO-only, which meant an office exporting from their old system had to reformat a column by hand
 * before every import — and reformatting a date column in a spreadsheet is exactly where 03/04 quietly
 * becomes the wrong day. `parseDateInput` accepts the configured order, always accepts ISO, and lets
 * the numbers settle it when they can (settings/dates.ts).
 */
function importDob(raw: string | undefined, fmt: DateFormat): { iso: string | null; bad: boolean } {
  const s = norm(raw);
  if (!s) return { iso: null, bad: false };
  const iso = parseDateInput(s, fmt);
  return { iso, bad: iso === null };
}

// ── Contacts ───────────────────────────────────────────────────────────────────
/**
 * Relations the import files as a parent without asking anybody.
 *
 * Deliberately narrower than people/relations.ts' classifier. That one is generous on purpose — it
 * decides which COLUMN a phone number prints in, where a loose guess costs nothing — and it matches on
 * the first word only, so it reads "Mother in law" as the mother. Here the answer decides whether
 * somebody is recorded as a parent of a child, so only an unambiguous whole word counts and everything
 * else is put to the office once.
 */
const PARENT_RELATIONS = new Map<string, 'father' | 'mother'>([
  ...(['father', 'dad', 'daddy', 'baba', 'abu', 'abbu', 'abba', 'abi', 'walid', 'papa'] as const).map((w) => [w, 'father'] as const),
  ...(['mother', 'mom', 'mum', 'mummy', 'mama', 'umm', 'ummi', 'ummu', 'ammi', 'amma', 'walida'] as const).map((w) => [w, 'mother'] as const),
]);

/**
 * Does the office have to say where this person goes?
 *
 * A father or a mother is a parent, so nobody is asked. A BLANK relation stays a guardian without a
 * question: it is not evidence of anything, it is what every guardian column meant before there was a
 * relation column at all, and a file with no Relationship column would otherwise open with a question
 * about every single row.
 */
export function needsPlacement(relation: string): boolean {
  const k = key(relation);
  return k !== '' && !PARENT_RELATIONS.has(k);
}

/**
 * Where one child's adults are filed. Per CHILD, not per contact, because the answer depends on who
 * else is on that child's rows (0.48.0).
 *
 * A CHILD WITH NO FATHER OR MOTHER LISTED KEEPS EVERY ADULT AS A GUARDIAN, whatever the office said
 * about that relationship. An aunt may be an emergency contact for a child whose parents are on file;
 * for a child whose only listed adult IS the aunt, filing her as an emergency contact leaves the
 * household with nobody — nobody to invite to the parent portal, nobody the office may ring about
 * tuition, and a family sheet that prints "no parent or guardian details on file". The answer to
 * "guardian or emergency contact?" only makes sense as "as well as the parents", so where there are no
 * parents it does not apply.
 *
 * The same function serves the preview and the commit, so what the office is shown is what is written.
 */
function resolveContacts(list: ImportContact[], placements: Placements): ResolvedContact[] {
  const hasParent = list.some((c) => PARENT_RELATIONS.has(key(c.relation)));
  return list.map((c) => ({
    ...c,
    // An unanswered label defaults to guardian too: these came out of a guardian column, and losing a
    // parent's phone number because a question went unanswered is the worse of the two failures.
    placement: !hasParent || !needsPlacement(c.relation) ? 'guardian' : placements[key(c.relation)] ?? 'guardian',
    // Not asked about when the child has no parent — the answer could not change anything, and a
    // question whose answer is ignored is worse than no question.
    asked: hasParent && needsPlacement(c.relation),
  }));
}

/** How a guardian's relation is STORED: the canonical code when the word is one the guardian form
 *  itself offers, else exactly what the file said. Free text is expected in this column and always
 *  has been; normalising the obvious cases just makes an imported record read like a typed one. */
function storedRelation(relation: string): string | null {
  const k = key(relation);
  if (!k) return null;
  return PARENT_RELATIONS.get(k) ?? (k === 'relative' || k === 'other' ? k : norm(relation));
}

function rowContact(r: ImportRow, row: number): ImportContact | null {
  const c = { name: norm(r.guardianName), relation: norm(r.guardianRelation), phone: norm(r.guardianPhone), email: norm(r.guardianEmail), row };
  return c.name || c.relation || c.phone || c.email ? c : null;
}

/** Anything at all in a row's mapped columns. A row with nothing in them is a spacer, and a
 *  spreadsheet is full of those. */
const rowHasData = (r: ImportRow): boolean => Object.values(r).some((v) => norm(v) !== '');

/** Anything that describes a STUDENT rather than one of their adults. A continuation row has none of
 *  these — which is how a child whose name was simply left out is told apart from extra contact
 *  details for the child above. */
const rowHasStudentData = (r: ImportRow): boolean =>
  [r.dob, r.className, r.courseName, r.feePlanName, r.amount, r.note].some((v) => norm(v) !== '');

/** One student, and every file row that describes them. */
export interface MergedRow {
  row: number;
  sourceRows: number[];
  fields: ImportRow;
  contacts: ImportContact[];
}

/** A nameless row that cannot be folded into anything, and why — so the office is told which of the
 *  two mistakes they made rather than just that a row was rejected. */
export interface StrayRow {
  row: number;
  reason: 'noStudentAbove' | 'looksLikeAStudent';
}

/**
 * Fold every nameless row into the student above it (0.48.0).
 *
 * This is the shape a real export has. QuickSchools writes the child once and then gives each further
 * adult a row of their own, with the student columns empty — so a child with a father, a mother and two
 * relatives occupies four lines, only the first of which has a name in it. Read row-by-row that is
 * three rejected rows and a child who lost three quarters of their contact details.
 *
 * Consecutive nameless rows all attach to the same student, because they are all still describing that
 * one child; the run ends at the next name. A nameless row's STUDENT columns are ignored — they cannot
 * belong to anybody — and the preview shows the grouping, so the office confirms what was merged
 * rather than taking it on trust.
 *
 * TWO nameless rows are NOT folded, and the distinction is the whole safety of this: one before any
 * named row has no student to belong to, and one carrying student columns (a class, an amount, a date
 * of birth) is a CHILD whose name was left out, not extra details for the child above. Both are
 * reported. Folding either would lose a person in a way nobody could see afterwards, which is the
 * failure this feature could plausibly introduce and must not.
 */
export function mergeRows(rows: ImportRow[]): { merged: MergedRow[]; strays: StrayRow[] } {
  const merged: MergedRow[] = [];
  const strays: StrayRow[] = [];
  rows.forEach((r, i) => {
    if (norm(r.fullName)) {
      const contact = rowContact(r, i);
      merged.push({ row: i, sourceRows: [i], fields: r, contacts: contact ? [contact] : [] });
      return;
    }
    if (!rowHasData(r)) return; // a spacer row means nothing, in either direction
    const owner = merged[merged.length - 1];
    if (rowHasStudentData(r)) {
      strays.push({ row: i, reason: 'looksLikeAStudent' });
      return;
    }
    if (!owner) {
      strays.push({ row: i, reason: 'noStudentAbove' });
      return;
    }
    owner.sourceRows.push(i);
    const contact = rowContact(r, i);
    if (contact) owner.contacts.push(contact);
  });
  return { merged, strays };
}

/** One person per name within a household, keeping the first spelling and filling in whatever the
 *  later rows added. An export that repeats a parent for each child in a block is a real shape, and
 *  two identical guardian records in one household is noise the office then has to tidy. Nameless
 *  contacts are never merged — each one is its own problem, reported below. */
function dedupeContacts(list: ImportContact[]): ImportContact[] {
  const byName = new Map<string, ImportContact>();
  const out: ImportContact[] = [];
  for (const c of list) {
    const k = key(c.name);
    if (!k) {
      out.push(c);
      continue;
    }
    const seen = byName.get(k);
    if (!seen) {
      const copy = { ...c };
      byName.set(k, copy);
      out.push(copy);
      continue;
    }
    seen.relation ||= c.relation;
    seen.phone ||= c.phone;
    seen.email ||= c.email;
  }
  return out;
}

// ── Lookups ────────────────────────────────────────────────────────────────────
/** Everything the validator needs, read once so a 500-row import is not 500× the queries.
 *
 *  Courses (and through them classes) are narrowed to the school being imported into (0.47.0).
 *  Without that, "Level 1" existing in two schools would make every row using it ambiguous — the
 *  file would be rejected with a message about a course the person importing has never heard of. */
function lookups(tx: Tx, schoolId?: string | null) {
  const plans = tx.select({ id: feePlans.id, name: feePlans.name }).from(feePlans).where(eq(feePlans.status, 'active')).all();
  const crs = tx
    .select({ id: courses.id, name: courses.name })
    .from(courses)
    .where(schoolId ? and(eq(courses.status, 'active'), eq(courses.schoolId, schoolId)) : eq(courses.status, 'active'))
    .all();
  const courseIds = new Set(crs.map((c) => c.id));
  const cls = tx
    .select({ id: classes.id, name: classes.name, courseId: classes.courseId })
    .from(classes)
    .where(eq(classes.status, 'active'))
    .all()
    .filter((c) => courseIds.has(c.courseId));
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

export interface ImportOpts {
  defaultFeePlanId?: string | null;
  schoolId?: string | null;
  /** Where each unrecognised relation label goes, keyed by the lowercased label. */
  placements?: Placements;
}

/** Dry run: resolve every row and collect problems. Writes nothing. */
export function validateRows(rows: ImportRow[], opts: ImportOpts): ValidateResult {
  const L = lookups(db, opts.schoolId ?? defaultSchoolId());
  // Read once for the file: the format is an install setting, not a per-row one.
  const fmt = getDateFormat();
  const placements = opts.placements ?? {};
  const defaultPlanOk = opts.defaultFeePlanId ? !!db.select({ id: feePlans.id }).from(feePlans).where(eq(feePlans.id, opts.defaultFeePlanId)).get() : false;
  const { merged, strays } = mergeRows(rows);
  const out: RowResult[] = [];
  const asked = new Map<string, { key: string; label: string; count: number }>();

  for (const s of strays) {
    const why =
      s.reason === 'looksLikeAStudent'
        ? 'it has a class, a date of birth or an amount on it. If this is a student, add their name; if it is another adult for the student above, clear those columns.'
        : 'there is no student above it for its details to belong to.';
    out.push({ row: s.row, sourceRows: [s.row], ok: false, errors: [`Row ${fileLine(s.row)} has no name and ${why}`], contacts: [], resolved: null });
  }

  for (const m of merged) {
    const r = m.fields;
    const errors: string[] = [];
    const fullName = norm(r.fullName);

    const dob = importDob(r.dob, fmt);
    if (dob.bad) errors.push(`Date of birth "${norm(r.dob)}" isn’t a date we can read — use ${DATE_FORMAT_SAMPLES[fmt]} or 2026-03-04.`);

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

    const contacts = resolveContacts(dedupeContacts(m.contacts), placements);
    for (const c of contacts) {
      // A phone number with nobody attached to it cannot be filed, and dropping it silently would
      // lose the one detail the office cares most about. Which row it came from changes the advice:
      // on the child's own line the guardian columns are half-filled, on a folded line the whole row is.
      if (!c.name) {
        errors.push(
          c.row === m.row
            ? 'There is a guardian phone or email here with no guardian name — add the name, or clear those columns.'
            : `Row ${fileLine(c.row)} has contact details but no name — add the name, or clear that row.`,
        );
      }
      if (c.email && !c.email.includes('@')) errors.push(`Guardian email "${c.email}" is not an email address.`);
      // The same cap the guardian form has. Reported as a row problem rather than left to trip the
      // request boundary, where it would come back as one opaque failure about the whole file.
      if (c.relation.length > MAX_RELATION) errors.push(`Relationship "${c.relation.slice(0, 20)}…" is too long — ${MAX_RELATION} characters at most.`);
      if (!c.asked || c.relation.length > MAX_RELATION) continue;
      const k = key(c.relation);
      const seen = asked.get(k);
      if (seen) seen.count++;
      else asked.set(k, { key: k, label: norm(c.relation), count: 1 });
    }

    out.push({
      row: m.row,
      sourceRows: m.sourceRows,
      ok: errors.length === 0,
      errors,
      contacts,
      resolved: errors.length ? null : { fullName, className, feePlanName, amountCents: amt === 'bad' ? null : amt },
    });
  }

  out.sort((a, b) => a.row - b.row);
  return {
    rows: out,
    okCount: out.filter((r) => r.ok).length,
    errorCount: out.filter((r) => !r.ok).length,
    mergedCount: merged.reduce((n, m) => n + m.sourceRows.length - 1, 0),
    askRelations: [...asked.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
  };
}

export interface CommitResult {
  created: number;
  familiesCreated: number;
  guardiansCreated: number;
  /** Emergency contacts created from rows the office placed there (0.48.0). */
  contactsCreated: number;
  /** How many file rows were folded into the student above them. */
  mergedCount: number;
  /** The generated Student IDs, so the admin can print them straight after an import. `studentId` is
   *  the internal row id; `studentCode` is the ID a parent types (never logged or audited — §14). */
  students: { row: number; studentId: string; fullName: string; studentCode: string }[];
}

/** Commit an import. Re-validates first and THROWS if anything is wrong, so the whole file either
 *  lands or does not — no partial roster. */
export function commitRows(rows: ImportRow[], opts: ImportOpts): CommitResult {
  const check = validateRows(rows, opts);
  if (check.errorCount > 0) throw new Error('invalid_rows');
  const placements = opts.placements ?? {};
  // Which school these children join (0.47.0). Resolved ONCE for the file rather than per row: an
  // import is one roster for one school, and the class column can still move an individual row to
  // its class's school below. Falling back to the default school matters — a child left unscoped
  // would be filed nowhere and disappear from every scoped list, which is a silent way to lose a
  // whole import.
  const fileSchoolId = opts.schoolId ?? defaultSchoolId();

  const result: CommitResult = { created: 0, familiesCreated: 0, guardiansCreated: 0, contactsCreated: 0, mergedCount: check.mergedCount, students: [] };
  const ts = new Date();

  const touchedFamilies = new Set<string>();

  db.transaction((tx) => {
    const L = lookups(tx, fileSchoolId);

    for (const m of mergeRows(rows).merged) {
      const r = m.fields;
      const fullName = displayName(norm(r.fullName));

      // ONE HOUSEHOLD PER STUDENT. An import never guesses that two children are siblings; the office
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
      // A named class wins over the file's school: the class belongs to exactly one school, and
      // filing the child anywhere else would put them outside their own class in every scoped view.
      const schoolId = (classId ? schoolIdForClass(classId) : null) ?? fileSchoolId;

      const rawPlan = norm(r.feePlanName);
      const feePlanId = rawPlan ? L.planByName.get(key(rawPlan))! : opts.defaultFeePlanId!;
      const amt = parseAmountCents(r.amount);
      const overrideAmountCents = amt === 'bad' || amt === null ? null : amt;

      const studentId = rid('stu');
      // The kiosk ID is always generated here and never taken from the spreadsheet — an imported ID
      // could collide with an existing child's or be chosen to impersonate one.
      const studentCode = generateUniqueStudentCode(fullName);
      // Normalised to ISO on the way in — storage is always ISO whatever the office types (dates.ts).
      const dob = importDob(r.dob, getDateFormat()).iso;
      tx.insert(students)
        .values({
          id: studentId,
          familyId,
          fullName,
          dob,
          status: 'active',
          notes: norm(r.note) || null,
          schoolId,
          classId,
          studentCode,
          createdAt: ts,
          updatedAt: ts,
        })
        .run();
      tx.insert(studentFees).values({ id: rid('stf'), studentId, feePlanId, overrideAmountCents, note: null, createdAt: ts, updatedAt: ts }).run();

      // Every adult the child's rows named, filed where the office said. There is no cross-STUDENT
      // dedupe: two children's blocks naming the same parent get a guardian record each, because
      // they are in separate households until somebody links the children — and that link is what
      // merges the duplicate, on a record where it is visible and can be removed.
      for (const c of resolveContacts(dedupeContacts(m.contacts), placements)) {
        if (c.placement === 'emergency') {
          // An emergency contact keeps a name, a number and what they are to the child. There is no
          // email column on one, by design — they are who you ring, not who you bill or invite.
          tx.insert(emergencyContacts)
            .values({ id: rid('ec'), familyId, name: c.name, phone: c.phone || null, relation: norm(c.relation) || null, createdAt: ts, updatedAt: ts })
            .run();
          result.contactsCreated++;
          continue;
        }
        const gid = rid('grd');
        tx.insert(guardians).values({ id: gid, name: c.name, phone: c.phone || null, email: c.email || null, createdAt: ts, updatedAt: ts }).run();
        tx.insert(guardianFamilies).values({ guardianId: gid, familyId, relation: storedRelation(c.relation), isEmergencyContact: false, createdAt: ts }).run();
        result.guardiansCreated++;
      }

      result.created++;
      result.students.push({ row: m.row, studentId, fullName, studentCode });
    }

    // Each new household takes the label derived from its child, so an imported record reads exactly
    // like one added through the UI instead of keeping the placeholder above.
    for (const familyId of touchedFamilies) {
      tx.update(families).set({ name: familyLabel(familyId, tx), updatedAt: ts }).where(eq(families.id, familyId)).run();
    }
  });

  return result;
}
