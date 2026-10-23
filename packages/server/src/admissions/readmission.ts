// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * RE-ADMISSION — a returning child, not a second trip through the funnel (0.52.0-dev.9).
 *
 * CLAUDE.md §4a Phase 2, docs/ADMISSIONS.md §5. The child, the household and the guardians already
 * exist; what is being collected is "is anything different, and are you coming back?". So there is no
 * inquiry, no conversion and no new Student ID — **the Student ID never changes and is never
 * re-minted**, and this module's entire relationship with the student is that it points at one.
 *
 * ── WHAT COMES BACK IS A DIFF, NOT A BLIND OVERWRITE ────────────────────────
 *
 * The form is PRE-FILLED from the current record, so most of what a family sends back is exactly what
 * was already there. Writing all of it would touch every row every year, make `updated_at` meaningless
 * and bury the two fields that actually changed in three hundred that did not. So `diffSubmission`
 * compares field by field and **only changed fields are written** — the same rule the importer's
 * update path follows, for the same reason, and the same discipline docs/ADMISSIONS.md §5 asks for:
 * validate twice, preview exactly what commit will do, and prove it with a test that runs both over
 * the same input and asserts they agree.
 *
 * (The importer's TYPES deliberately do not transfer. `RowResult` carries no "before", is per-row
 * atomic and commits all-or-nothing; a re-admission diff is one entity, field-level, applied
 * selectively. What transfers is the discipline, not the code.)
 *
 * ── IDEMPOTENCY IS THE UNIQUE INDEX, BECAUSE OF HOW THIS IS USED ────────────
 *
 * The normal mode of use is "open it for three hundred families, twice, because the first press
 * looked slow". `readmissions` is UNIQUE on (student, year), opening is an upsert that leaves an
 * existing row alone, and the re-enrollment fee is keyed `readmission:<student>:<year>` in the UNIQUE
 * `charges.source_key`. Pressing any button here twice is a no-op, not a duplicate.
 *
 * ── `lapsed` IS AN ACTION, NEVER AN INFERENCE ───────────────────────────────
 *
 * A family that never answers BECOMES lapsed, by the office's action or a dated sweep. Deriving it at
 * read time from "pending and old" would make the screen disagree with itself between two refreshes
 * and would silently un-lapse a family the moment somebody edited the deadline (§9).
 */
import { TRPCError } from '@trpc/server';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { rid } from '../db/ids';
import {
  admissionLinks,
  families,
  feePlans,
  guardianFamilies,
  guardians,
  readmissions,
  schoolYears,
  studentFees,
  students,
  type Readmission,
  type ReadmissionState,
} from '../db/schema';
import { audit, type AuditActor } from '../audit';
import { isIsoDay } from '../settings/dates';
import { ADMISSION_LINK_TTL_MS, hashToken, mintToken, tokenState } from '../auth/tokens';
import { portalBase } from '../auth/invites';
import { resolveAudience, type Audience } from '../structure/audience';
import { raiseEnrollmentFee, type FeeResult } from './fees';

type Tx = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete'>;

/** What a family may change on the form. A FIXED set, like the public inquiry's (decision 9) — a
 *  configurable form filled in from outside the office is a configurable attack surface, and this one
 *  writes to records that already exist. */
export const READMISSION_FIELDS = ['address', 'languages', 'nationality', 'guardianName', 'guardianPhone', 'guardianEmail'] as const;
export type ReadmissionField = (typeof READMISSION_FIELDS)[number];

export const READMISSION_CAPS: Record<ReadmissionField, number> = {
  address: 300,
  languages: 120,
  nationality: 120,
  guardianName: 160,
  guardianPhone: 40,
  guardianEmail: 200,
};

export interface FieldDiff {
  field: ReadmissionField;
  from: string;
  to: string;
}

/** Everything the form shows, and everything a diff is measured against. */
export interface CurrentRecord {
  studentId: string;
  fullName: string;
  studentCode: string | null;
  familyId: string;
  /** Household-scoped, because that is where they live (§9, 0.52.0-dev.4). */
  address: string;
  languages: string;
  nationality: string;
  /** The household's first guardian — the one a form asks a family to confirm. */
  guardianId: string | null;
  guardianName: string;
  guardianPhone: string;
  guardianEmail: string;
  /** Pre-filled so the office RECONFIRMS rather than carries forward silently (decision 10). */
  feePlanId: string | null;
  feePlanName: string | null;
  overrideAmountCents: number | null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function currentRecord(studentId: string, tx: Tx = db): CurrentRecord | undefined {
  const s = tx
    .select({ id: students.id, fullName: students.fullName, studentCode: students.studentCode, familyId: students.familyId })
    .from(students)
    .where(eq(students.id, studentId))
    .get();
  if (!s) return undefined;
  const fam = tx.select({ address: families.address, languages: families.languages, nationality: families.nationality }).from(families).where(eq(families.id, s.familyId)).get();
  const g = tx
    .select({ id: guardians.id, name: guardians.name, phone: guardians.phone, email: guardians.email })
    .from(guardianFamilies)
    .innerJoin(guardians, eq(guardians.id, guardianFamilies.guardianId))
    .where(eq(guardianFamilies.familyId, s.familyId))
    .get();
  const fee = tx
    .select({ planId: studentFees.feePlanId, override: studentFees.overrideAmountCents, name: feePlans.name })
    .from(studentFees)
    .innerJoin(feePlans, eq(feePlans.id, studentFees.feePlanId))
    .where(eq(studentFees.studentId, studentId))
    .get();
  return {
    studentId: s.id,
    fullName: s.fullName,
    studentCode: s.studentCode,
    familyId: s.familyId,
    address: str(fam?.address),
    languages: str(fam?.languages),
    nationality: str(fam?.nationality),
    guardianId: g?.id ?? null,
    guardianName: str(g?.name),
    guardianPhone: str(g?.phone),
    guardianEmail: str(g?.email),
    feePlanId: fee?.planId ?? null,
    feePlanName: fee?.name ?? null,
    overrideAmountCents: fee?.override ?? null,
  };
}

/**
 * What this submission would actually change.
 *
 * An ABSENT field means "the family did not touch this box", which is different from an empty one:
 * the form is pre-filled, so a box cleared on purpose is a real instruction to clear, while a field
 * missing from the payload means the form never carried it. Both are common — an office submitting on
 * a family's behalf sends only what they asked to change — so conflating them would either wipe
 * untouched fields or refuse to clear one somebody deliberately emptied.
 *
 * Pure, and the single source of truth for both the preview and the commit (§16): `applyDiff` takes
 * what this returns rather than recomputing it, which is what makes "preview and commit agree" a
 * property of the code and not a hope.
 */
export function diffSubmission(current: CurrentRecord, payload: Record<string, unknown> | null | undefined): FieldDiff[] {
  if (!payload) return [];
  const out: FieldDiff[] = [];
  for (const field of READMISSION_FIELDS) {
    if (!(field in payload)) continue; // never sent — not the same as sent empty
    const to = str(payload[field]).slice(0, READMISSION_CAPS[field]);
    const from = str(current[field]);
    if (to === from) continue; // repeating what was already there writes nothing
    out.push({ field, from, to });
  }
  return out;
}

/** Apply exactly the changes named, and nothing else. */
export function applyDiff(tx: Tx, current: CurrentRecord, changes: FieldDiff[], at: Date): void {
  if (!changes.length) return;
  const household: Record<string, string | null> = {};
  const guardian: Record<string, string | null> = {};
  for (const c of changes) {
    if (c.field === 'address' || c.field === 'languages' || c.field === 'nationality') household[c.field] = c.to || null;
    // A guardian's NAME may not be emptied — a nameless adult on a household is worse than a stale
    // one, and the form asks for it. Dropped from the patch rather than used to reject the whole
    // update: the first cut skipped the guardian row entirely when the name came back blank, which
    // silently discarded a phone number and an email address changed in the SAME submission. A rule
    // about one field must not decide the fate of the other two.
    if (c.field === 'guardianName' && c.to) guardian.name = c.to;
    if (c.field === 'guardianPhone') guardian.phone = c.to || null;
    if (c.field === 'guardianEmail') guardian.email = c.to ? c.to.toLowerCase() : null;
  }
  if (Object.keys(household).length) {
    tx.update(families).set({ ...household, updatedAt: at }).where(eq(families.id, current.familyId)).run();
  }
  // A household with no guardian row yet has nothing to update; the office adds one from the family's
  // record. Writing a guardian here would be inventing a person from a form nobody has approved.
  if (Object.keys(guardian).length && current.guardianId) {
    tx.update(guardians).set({ ...guardian, updatedAt: at }).where(eq(guardians.id, current.guardianId)).run();
  }
}

// ── Opening a year's re-admissions ──────────────────────────────────────────

export interface OpenResult {
  /** Rows created by THIS call. A second press reports 0, which is success. */
  created: number;
  /** Children already on the list for this year, left exactly as they were. */
  existing: number;
  /** Withdrawn children in the selection, excluded and counted so the office can see it happened. */
  skippedWithdrawn: number;
}

/**
 * Open re-admission for a cohort.
 *
 * **Reuses `structure/audience.ts`** — the ONE resolver that already answers "which students does
 * this bulk action name" for mass fee apply and the onboarding send. A third audience resolver is the
 * bug (§16), and it would drift on the part that matters most: `resolveAudience` returns ACTIVE
 * students only, which is exactly the spec's "withdrawn students are excluded" and is enforced there
 * rather than remembered here.
 */
export function openReadmissions(target: Audience, schoolYearId: string, actor: AuditActor, at = new Date()): OpenResult {
  const year = db.select({ id: schoolYears.id, schoolId: schoolYears.schoolId }).from(schoolYears).where(eq(schoolYears.id, schoolYearId)).get();
  if (!year) throw new TRPCError({ code: 'NOT_FOUND', message: 'That school year no longer exists.' });

  const wanted = target.kind === 'students' ? target.studentIds : [];
  const resolved = resolveAudience(target);

  /**
   * A YEAR BELONGS TO ONE SCHOOL, so its re-admissions do too.
   *
   * `resolveAudience` deliberately applies no school scope — its header says so, and it is right,
   * because a course and a class are inside one school by construction and `all` is the one shape
   * that reaches across. For mass fee apply and the onboarding send that is fine. Here it is not:
   * "ask everyone about the maktab's 2027 year" would put the hifz school's children on the maktab's
   * list, and a madrasah running two programs on different calendars is the entire reason `schools`
   * exists (§9). So the audience answers WHO, and the year answers WHICH SCHOOL, and this is where
   * the two meet rather than inside the shared resolver.
   *
   * A year with no school (a row that predates 0.47.0 and has not been backfilled) scopes nothing,
   * which is the same answer the rest of the app gives for those rows.
   */
  const ids = year.schoolId
    ? resolved.filter((id) => {
        const s = db.select({ schoolId: students.schoolId }).from(students).where(eq(students.id, id)).get();
        return !s?.schoolId || s.schoolId === year.schoolId;
      })
    : resolved;
  const skippedWithdrawn = Math.max(0, wanted.length - resolved.length);

  const already = new Set(
    ids.length
      ? db
          .select({ studentId: readmissions.studentId })
          .from(readmissions)
          .where(and(eq(readmissions.schoolYearId, schoolYearId), inArray(readmissions.studentId, ids)))
          .all()
          .map((r) => r.studentId)
      : [],
  );

  let created = 0;
  db.transaction((tx) => {
    for (const studentId of ids) {
      if (already.has(studentId)) continue;
      tx.insert(readmissions)
        .values({ id: rid('rdm'), studentId, schoolYearId, state: 'pending', feeWaived: false, createdAt: at, updatedAt: at })
        .run();
      created += 1;
    }
  });

  audit(actor, 'readmission.open', { entity: 'schoolYear', entityId: schoolYearId, detail: { created, existing: already.size, kind: target.kind } });
  return { created, existing: already.size, skippedWithdrawn };
}

// ── The family's link ───────────────────────────────────────────────────────

/**
 * Mint a one-time link for one re-admission.
 *
 * Through `auth/tokens.ts`, the one place a link token is made — the raw token exists only in the
 * returned URL, and only its SHA-256 hash is stored (§14). **Email or print only, never WhatsApp**: a
 * token link is auth-critical, and a number can be banned overnight (§14, docs/ADMISSIONS.md §6).
 */
export function mintReadmissionLink(readmissionId: string, createdByUserId: string | null, at = new Date()): { token: string; url: string } {
  const row = db.select().from(readmissions).where(eq(readmissions.id, readmissionId)).get();
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That re-admission no longer exists.' });
  const { token, tokenHash } = mintToken();
  db.insert(admissionLinks)
    .values({
      id: rid('adl'),
      tokenHash,
      kind: 'readmission',
      inquiryId: null,
      readmissionId,
      createdByUserId,
      createdAt: at,
      expiresAt: new Date(at.getTime() + ADMISSION_LINK_TTL_MS),
    })
    .run();
  const base = portalBase();
  return { token, url: base ? `${base}/public/readmission?token=${token}` : '' };
}

export type LinkLookup =
  | { ok: true; readmission: Readmission; current: CurrentRecord; linkId: string }
  | { ok: false; reason: 'unknown' | 'expired' | 'used' | 'closed' };

/**
 * Resolve a token to the form behind it.
 *
 * Says WHICH failure it is, unlike the public inquiry form's deliberate uniformity — and the
 * difference is principled rather than inconsistent. There is nothing to enumerate here: a 256-bit
 * token is not guessable, so its holder learning that their link has already been used tells nobody
 * anything they did not already have. A family staring at "not found" when the real answer is "you
 * already sent this" is a phone call to the office.
 */
export function readmissionByToken(token: string, now = new Date()): LinkLookup {
  const link = db.select().from(admissionLinks).where(and(eq(admissionLinks.tokenHash, hashToken(token)), eq(admissionLinks.kind, 'readmission'))).get();
  const state = tokenState(link, now);
  if (state !== 'ok' || !link?.readmissionId) return { ok: false, reason: state === 'ok' ? 'unknown' : state };
  const row = db.select().from(readmissions).where(eq(readmissions.id, link.readmissionId)).get();
  if (!row) return { ok: false, reason: 'unknown' };
  // A family who already answered, or whom the office has finished with, gets told rather than
  // silently allowed to overwrite a record somebody has since approved.
  if (row.state === 'approved' || row.state === 'enrolled' || row.state === 'not_returning') return { ok: false, reason: 'closed' };
  const current = currentRecord(row.studentId);
  if (!current) return { ok: false, reason: 'unknown' };
  return { ok: true, readmission: row, current, linkId: link.id };
}

/**
 * The family's answer.
 *
 * Stored INERT on the row and applied to nothing: the office reviews the diff and approves it. That
 * is the whole shape of §4's "not an edit — a proposal the office reviews as a diff before anything
 * is written" (§4's parent-edit exception), and it is why this writes `submitted_payload` and a state
 * rather than touching `families` or `guardians`.
 */
export function submitReadmission(
  token: string,
  payload: Record<string, unknown>,
  opts: { returning: boolean; actor: AuditActor; at?: Date },
): { ok: boolean; reason?: string } {
  const at = opts.at ?? new Date();
  const found = readmissionByToken(token, at);
  if (!found.ok) return { ok: false, reason: found.reason };

  const changes = diffSubmission(found.current, payload);
  const kept: Record<string, string> = {};
  for (const c of changes) kept[c.field] = c.to;

  db.transaction((tx) => {
    tx.update(readmissions)
      .set({
        state: opts.returning ? ('submitted' as ReadmissionState) : ('not_returning' as ReadmissionState),
        submittedPayload: kept,
        submittedAt: at,
        updatedAt: at,
      })
      .where(eq(readmissions.id, found.readmission.id))
      .run();
    // Single use, marked in the same transaction as the answer it carried.
    tx.update(admissionLinks).set({ usedAt: at }).where(eq(admissionLinks.id, found.linkId)).run();
  });

  // Ids and counts. Nothing a family typed reaches the trail (§14) — the values are on the row the
  // office reads, which is where they belong.
  audit(opts.actor, 'readmission.submit', {
    entity: 'readmission',
    entityId: found.readmission.id,
    detail: { returning: opts.returning, changed: changes.length },
  });
  return { ok: true };
}

// ── The office's review ─────────────────────────────────────────────────────

export interface ReviewRow {
  readmission: Readmission;
  current: CurrentRecord;
  changes: FieldDiff[];
}

/** What approving WOULD write — the preview, computed by the same `diffSubmission` the commit uses. */
export function reviewReadmission(readmissionId: string): ReviewRow {
  const row = db.select().from(readmissions).where(eq(readmissions.id, readmissionId)).get();
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That re-admission no longer exists.' });
  const current = currentRecord(row.studentId);
  if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'That student no longer exists.' });
  return { readmission: row, current, changes: diffSubmission(current, row.submittedPayload) };
}

export interface ApproveInput {
  readmissionId: string;
  /** Reconfirmed per child, pre-filled from the current plan (decision 10). Null keeps what they have. */
  feePlanId?: string | null;
  overrideAmountCents?: number | null;
  classId?: string | null;
  feeWaived?: boolean;
  feeOverrideCents?: number | null;
  /** Skip a field the office does not want written after all. */
  rejectFields?: ReadmissionField[];
}

export interface ApproveResult {
  applied: FieldDiff[];
  fee: FeeResult;
  alreadyApproved: boolean;
}

/**
 * Approve: write the changes the office accepted, roll the child into the year, raise the fee.
 *
 * The Student ID never changes, the status stays active, and a child who was never withdrawn is not
 * re-created — this is an update to a record that already exists, which is the whole difference
 * between re-admission and admission.
 *
 * Idempotent: an already-approved row returns what it did without writing again, because the bulk
 * approve button is the one most likely to be pressed twice.
 */
export function approveReadmission(input: ApproveInput, actor: AuditActor, at = new Date()): ApproveResult {
  const { readmission: row, current, changes } = reviewReadmission(input.readmissionId);

  if (row.state === 'approved' || row.state === 'enrolled') {
    return { applied: [], fee: { chargeId: null, created: false, decision: { amountCents: null, reason: 'none' } }, alreadyApproved: true };
  }
  if (row.state === 'not_returning') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'That family said they are not returning. Put them back to pending first if that has changed.' });
  }

  const rejected = new Set(input.rejectFields ?? []);
  const applied = changes.filter((c) => !rejected.has(c.field));
  const year = db.select({ label: schoolYears.label }).from(schoolYears).where(eq(schoolYears.id, row.schoolYearId)).get();

  db.transaction((tx) => {
    const txx = tx as unknown as Tx;
    applyDiff(txx, current, applied, at);

    // The fee plan for the NEW year — reconfirmed rather than carried silently. Carrying a hardship
    // rate forward in silence is how it quietly persists a year too long; dropping it in silence is
    // how a family gets a bill they cannot pay. Pre-fill makes the default cheap and the decision
    // visible, and this is where the office's answer lands.
    if (input.feePlanId) {
      const plan = txx.select({ id: feePlans.id }).from(feePlans).where(and(eq(feePlans.id, input.feePlanId), eq(feePlans.status, 'active'))).get();
      if (!plan) throw new TRPCError({ code: 'NOT_FOUND', message: 'Fee plan not found.' });
      const existing = txx.select({ id: studentFees.id }).from(studentFees).where(eq(studentFees.studentId, row.studentId)).get();
      if (existing) {
        txx.update(studentFees).set({ feePlanId: input.feePlanId, overrideAmountCents: input.overrideAmountCents ?? null, updatedAt: at }).where(eq(studentFees.id, existing.id)).run();
      } else {
        txx.insert(studentFees).values({ id: rid('stf'), studentId: row.studentId, feePlanId: input.feePlanId, overrideAmountCents: input.overrideAmountCents ?? null, createdAt: at, updatedAt: at }).run();
      }
    }

    // Class placement for the new year. Phase 3 moves this to `structure/enrollment.ts`, the single
    // mover that opens a dated enrollment row beside the pointer — this call site is one of the ones
    // that must route through it then. Do not invent a partial one here to get ahead of it.
    if (input.classId) txx.update(students).set({ classId: input.classId, updatedAt: at }).where(eq(students.id, row.studentId)).run();

    txx
      .update(readmissions)
      .set({ state: 'approved', approvedAt: at, approvedByUserId: actor.userId ?? null, feeWaived: input.feeWaived ?? row.feeWaived, feeOverrideCents: input.feeOverrideCents ?? row.feeOverrideCents, updatedAt: at })
      .where(eq(readmissions.id, row.id))
      .run();
  });

  // Outside the transaction and idempotent on its own, exactly as conversion does it: a failure here
  // leaves an approved child with no re-enrollment charge, which an office can see, rather than
  // rolling back an approval that had already succeeded.
  const fee = raiseEnrollmentFee({
    studentId: row.studentId,
    schoolYearId: row.schoolYearId,
    yearLabel: year?.label ?? null,
    kind: 'readmission',
    overrideCents: input.feeOverrideCents ?? row.feeOverrideCents,
    waived: input.feeWaived ?? row.feeWaived,
    createdByUserId: actor.userId ?? null,
    at,
  });

  audit(actor, 'readmission.approve', {
    entity: 'readmission',
    entityId: row.id,
    // Field NAMES, never the values — an address is the family's, and the trail only needs to say
    // that it changed (§14).
    detail: { studentId: row.studentId, fields: applied.map((c) => c.field), rejected: [...rejected], chargeRaised: fee.created },
  });

  return { applied, fee, alreadyApproved: false };
}

/** Mark a state by hand: `lapsed` for a family that never answered, or back to `pending` to reopen. */
export function setReadmissionState(readmissionId: string, state: ReadmissionState, actor: AuditActor, at = new Date()): void {
  const row = db.select().from(readmissions).where(eq(readmissions.id, readmissionId)).get();
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That re-admission no longer exists.' });
  db.update(readmissions).set({ state, updatedAt: at }).where(eq(readmissions.id, readmissionId)).run();
  audit(actor, 'readmission.state', { entity: 'readmission', entityId: readmissionId, detail: { from: row.state, to: state } });
}

/**
 * Who has answered and who has not, for one year.
 *
 * The actual job, per the spec: this happens to a whole school in one fortnight and the screen an
 * office lives on is the one that says who is outstanding.
 */
export function readmissionBoard(schoolYearId: string): {
  rows: (Readmission & { fullName: string; studentCode: string | null; changed: number })[];
  counts: Partial<Record<ReadmissionState, number>>;
} {
  const rows = db
    .select({ r: readmissions, fullName: students.fullName, studentCode: students.studentCode })
    .from(readmissions)
    .innerJoin(students, eq(students.id, readmissions.studentId))
    .where(eq(readmissions.schoolYearId, schoolYearId))
    .all();
  const counts: Partial<Record<ReadmissionState, number>> = {};
  const out = rows.map(({ r, fullName, studentCode }) => {
    counts[r.state] = (counts[r.state] ?? 0) + 1;
    const payload = r.submittedPayload as Record<string, unknown> | null;
    return { ...r, fullName, studentCode, changed: payload ? Object.keys(payload).length : 0 };
  });
  out.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return { rows: out, counts };
}

/** A date arriving from a client is validated, never trusted (§9) — re-exported so the router's
 *  re-admission inputs use the same check every other date boundary does. */
export { isIsoDay };
