// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * THE ADMISSION FORM — WHAT IT ASKS, WHO MAY OPEN IT, AND WHAT COMES BACK (0.52.0-dev.12).
 *
 * CLAUDE.md §4a Phase 2, docs/ADMISSIONS.md §3a. Hasan's brief: "someone inquires online. And then
 * we call them for like an interview. And then once it works out… then you would give them the
 * admission form."
 *
 * The inquiry is six boxes on purpose — a fixed, minimal public field set, because a configurable
 * public form is a configurable attack surface (decision 9). THIS is the real form, the one a
 * madrasah actually fills in when it has decided to take a child, and it is a different surface with
 * a different threat model: **nobody reaches it without having been given a token.**
 *
 * ── THE FIELD SET IS THE REGISTRY, NOT A SECOND LIST ─────────────────────────
 *
 * `people/fields.ts` already answers "does this field exist, has the office switched it off, and who
 * may see it" (§16). This module ASKS it rather than hard-coding a list, because a hard-coded list is
 * a list that drifts from the student record the first time either changes — and the drift is silent,
 * since both still compile. What is added here is only what the registry has no opinion about: the
 * child's name and date of birth (which are core columns, not registry fields) and the guardian, who
 * is a row on another table entirely.
 *
 * ── THREE REGISTRY FIELDS ARE DELIBERATELY WITHHELD ──────────────────────────
 *
 * `admittedOn`, `withdrawnOn` and `withdrawalReason` are the OFFICE's answers, not the family's. A
 * form that asks a parent when their child was admitted is asking them to fill in the school's own
 * record, and a form that asks when they left is asking a question about a child who has not
 * arrived. They are registry fields and they stay registry fields; they are simply not on this form.
 *
 * ── MEDICAL FIELDS ARE HERE, AND WRITE-ONLY, AND THAT IS THE AMENDMENT ───────
 *
 * §14 said medical fields never appear on a family-facing page. Hasan's sign-off (0.52.0-dev.12: "if
 * medical questions are enabled in settings, show in admission form") narrows that rather than
 * holing it, and the distinction is **providing is not disclosure**: a parent typing their child's
 * allergy into an intake form is telling the madrasah something; a screen showing them what the
 * office has since written about their child is what the rule exists to prevent.
 *
 * So they appear only if the office enabled them — the same switch, not a second one — and they are
 * WRITE-ONLY. `prefillFor` cannot return a medical value because an admission form is about a child
 * who does not exist yet, and there is nothing to read back. That is not an accident of ordering, it
 * is the reason this form got the medical fields and the re-admission form did not: re-admission is
 * pre-filled by design and would hand a family the office's own notes.
 *
 * ── WHAT COMES BACK CHANGES NOTHING ──────────────────────────────────────────
 *
 * A submission is stored INERT in `inquiries.submitted_payload` and is not a record of anything until
 * an admin approves it, at which point `admissions/convert.ts` reads it. That is the same shape
 * re-admission uses and the same rule §4 states for every family-submitted form: it lands as a
 * proposal the office reviews, never as a write.
 */
import { and, eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { db } from '../db';
import { rid } from '../db/ids';
import { admissionLinks, inquiries, type Inquiry } from '../db/schema';
import { ADMISSION_LINK_TTL_MS, hashToken, mintToken, tokenState } from '../auth/tokens';
import { studentField, visibleFields, type StudentFieldKind } from '../people/fields';
import { getAdmissions } from '../settings';
import { portalBase } from '../auth/invites';
import { isIsoDay } from '../settings/dates';
import { audit, type AuditActor } from '../audit';

/** Where an answer ends up once the office approves it. Not layout — three different tables. */
export type AdmissionFieldScope = 'child' | 'household' | 'guardian';

/**
 * The fields this form asks about that are NOT registry fields, because the registry has no opinion
 * about them: two are core columns on `students` and three are a row on `guardians`.
 *
 * `childName` is the only field that is required whatever the office says. A submission with no
 * child's name is not an admission form, it is a blank page, and there would be nothing to show the
 * office on the other side.
 */
export const CORE_ADMISSION_FIELDS = [
  { key: 'childName', kind: 'text' as StudentFieldKind, scope: 'child' as const, label: "Child's full name", alwaysRequired: true },
  { key: 'childDob', kind: 'date' as StudentFieldKind, scope: 'child' as const, label: 'Date of birth', alwaysRequired: false },
  { key: 'guardianName', kind: 'text' as StudentFieldKind, scope: 'guardian' as const, label: "Parent or guardian's name", alwaysRequired: false },
  { key: 'guardianPhone', kind: 'text' as StudentFieldKind, scope: 'guardian' as const, label: 'Phone', alwaysRequired: false },
  { key: 'guardianEmail', kind: 'text' as StudentFieldKind, scope: 'guardian' as const, label: 'Email', alwaysRequired: false },
] as const;

/** Registry fields the FAMILY is never asked for — see the header. */
const OFFICE_ONLY_FIELDS: readonly string[] = ['admittedOn', 'withdrawnOn', 'withdrawalReason'];

export interface AdmissionField {
  key: string;
  kind: StudentFieldKind;
  scope: AdmissionFieldScope;
  /** English, and only a fallback: the office side renders `admissions.formField_<key>` through i18n
   *  (§16), and the public page uses this because it is served outside React and has no i18n. */
  label: string;
  /** `medical` fields are write-only and never pre-filled — see the header. */
  medical: boolean;
  required: boolean;
  /** What the family already told us on the inquiry. Always '' for a medical field. */
  prefill: string;
}

/** Caps per kind, matching `people/fields.ts` — one answer to "how long may this be". */
export const ADMISSION_CAPS: Record<StudentFieldKind, number> = { text: 300, longtext: 4000, date: 10, flag: 8 };

/**
 * What this madrasah's admission form asks, in order, for this inquiry.
 *
 * The role is hard-coded `admin` and that is correct rather than lazy: `visibleFields` answers "is it
 * switched on AND may this role read it", and the only role that may ever read a medical field is
 * admin (§5's medical wall). The family is not a role — they are answering about their own child, and
 * what they may WRITE is what this function returns.
 */
export function admissionFormFields(inquiry: Inquiry | null): AdmissionField[] {
  const required = new Set(getAdmissions().requiredAdmissionFields);
  const out: AdmissionField[] = CORE_ADMISSION_FIELDS.map((f) => ({
    key: f.key,
    kind: f.kind,
    scope: f.scope,
    label: f.label,
    medical: false,
    required: f.alwaysRequired || required.has(f.key),
    prefill: prefillFor(f.key, inquiry),
  }));

  for (const spec of visibleFields('admin')) {
    if (OFFICE_ONLY_FIELDS.includes(spec.key)) continue;
    const medical = spec.sensitivity === 'medical';
    out.push({
      key: spec.key,
      kind: spec.kind,
      scope: spec.scope === 'household' ? 'household' : 'child',
      label: spec.label,
      medical,
      required: required.has(spec.key),
      // WRITE-ONLY: never read a medical value back to a family (§14). Today there is nothing to read
      // — no student exists yet — and the explicit guard is what keeps that true if this function is
      // ever handed a record.
      prefill: medical ? '' : prefillFor(spec.key, inquiry),
    });
  }
  return out;
}

/**
 * What the family already told us, so they are not asked twice.
 *
 * Hasan asked for this directly: "I wanted to pre-fill the fields from the inquiry form." A family
 * that has already typed their child's name and their own phone number and is asked for both again
 * is a family that closes the tab.
 */
function prefillFor(key: string, inquiry: Inquiry | null): string {
  if (!inquiry) return '';
  switch (key) {
    case 'childName':
      return inquiry.childName ?? '';
    case 'childDob':
      return inquiry.childDob ?? '';
    case 'guardianName':
      return inquiry.parentName ?? '';
    case 'guardianPhone':
      return inquiry.phone ?? '';
    case 'guardianEmail':
      return inquiry.email ?? '';
    default:
      return '';
  }
}

/** Trim and cap one answer by its field's kind. Returns null for an answer that is not usable. */
export function normalizeAnswer(field: AdmissionField, raw: unknown): string | null {
  if (field.kind === 'flag') {
    if (raw === true || raw === 'true' || raw === '1' || raw === 'on') return 'yes';
    if (raw === false || raw === 'false' || raw === '0' || raw === '') return 'no';
    return null;
  }
  if (typeof raw !== 'string') return null;
  const v = raw.trim().slice(0, ADMISSION_CAPS[field.kind]);
  // A date is validated, never trusted: a date column is compared as TEXT, so a non-ISO value is a
  // silent permanent fault rather than an error (§9). An unparseable one is dropped, not stored.
  if (field.kind === 'date' && v && !isIsoDay(v)) return null;
  return v;
}

export type AdmissionLookup =
  | { ok: true; inquiry: Inquiry; fields: AdmissionField[]; linkId: string }
  | { ok: false; reason: 'unknown' | 'expired' | 'used' | 'closed' };

/**
 * Resolve a family's link.
 *
 * Says WHICH failure, unlike the public inquiry form — and the difference is not an inconsistency.
 * The inquiry form answers identically to everything because telling a stranger "we already know
 * that child" is an enumeration oracle. A token holder is not a stranger: they were handed this
 * link, and "your link has expired" is the only useful thing to say to somebody staring at a form
 * that will not open. `readmissionByToken` draws the same line for the same reason.
 */
export function admissionByToken(token: string, now = new Date()): AdmissionLookup {
  const link = db
    .select()
    .from(admissionLinks)
    .where(and(eq(admissionLinks.tokenHash, hashToken(token)), eq(admissionLinks.kind, 'admission')))
    .get();
  const state = tokenState(link, now);
  if (state !== 'ok' || !link?.inquiryId) return { ok: false, reason: state === 'ok' ? 'unknown' : state };
  const inquiry = db.select().from(inquiries).where(eq(inquiries.id, link.inquiryId)).get();
  if (!inquiry) return { ok: false, reason: 'unknown' };
  // A family the office has finished with is told, rather than silently allowed to overwrite a
  // proposal somebody has since acted on.
  if (inquiry.state === 'admitted' || inquiry.state === 'declined') return { ok: false, reason: 'closed' };
  return { ok: true, inquiry, fields: admissionFormFields(inquiry), linkId: link.id };
}

/**
 * Issue a family their link.
 *
 * Minting does NOT move the inquiry's state — `admissions/transition.ts` is the one writer of that
 * (§16), and the router moves it to `admission` in the same call. Two writers of a state is the bug
 * that module exists to prevent, and "the mint also transitions" is exactly how a second one gets
 * added without anybody deciding to.
 */
export function mintAdmissionLink(inquiryId: string, createdByUserId: string | null, at = new Date()): { token: string; url: string } {
  const row = db.select().from(inquiries).where(eq(inquiries.id, inquiryId)).get();
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That inquiry no longer exists.' });
  const { token, tokenHash } = mintToken();
  db.insert(admissionLinks)
    .values({
      id: rid('adl'),
      tokenHash,
      kind: 'admission',
      inquiryId,
      readmissionId: null,
      createdByUserId,
      createdAt: at,
      expiresAt: new Date(at.getTime() + ADMISSION_LINK_TTL_MS),
    })
    .run();
  const base = portalBase();
  return { token, url: base ? `${base}/public/admission?token=${token}` : '' };
}

/**
 * Store what a family sent — INERT.
 *
 * Nothing here writes to `students`, `families` or `guardians`. The payload sits on the inquiry until
 * an admin approves it, and approving is what runs conversion. A token link that could write onto a
 * roster would be a roster anybody with a forwarded URL could edit.
 *
 * **A re-submission REPLACES the proposal rather than making a second one**, and the link survives
 * until the office acts. A family who realizes they mistyped a phone number should be able to open
 * the link again and fix it, not ring the office to ask for a new one. That is a deliberate
 * difference from an invite token, which is single-use because the thing it grants is an ACCOUNT;
 * what this grants is the ability to propose, and proposing twice costs nobody anything.
 */
export function submitAdmission(
  token: string,
  payload: Record<string, unknown>,
  opts: { actor: AuditActor; at?: Date },
): { ok: boolean; reason?: string } {
  const at = opts.at ?? new Date();
  const found = admissionByToken(token, at);
  if (!found.ok) return { ok: false, reason: found.reason };

  const answers: Record<string, string> = {};
  for (const field of found.fields) {
    // A field the form never rendered is absent, and absent is not the same as blank — the same rule
    // `diffSubmission` draws. Only what was ASKED can be answered.
    if (!(field.key in payload)) continue;
    const v = normalizeAnswer(field, payload[field.key]);
    if (v === null) continue;
    answers[field.key] = v;
  }
  if (!answers.childName?.trim()) return { ok: false, reason: 'incomplete' };
  for (const field of found.fields) {
    if (field.required && !answers[field.key]?.trim()) return { ok: false, reason: 'incomplete' };
  }

  db.update(inquiries).set({ submittedPayload: answers, updatedAt: at }).where(eq(inquiries.id, found.inquiry.id)).run();

  // COUNTS ONLY. What a family typed about their child — an allergy above all — does not belong in a
  // trail that outlives the proposal (§14). The office reads the answers on the screen, from the row.
  audit(opts.actor, 'admission.submit', {
    entity: 'inquiry',
    entityId: found.inquiry.id,
    detail: { answered: Object.keys(answers).length, medical: found.fields.some((f) => f.medical && answers[f.key]) },
  });
  return { ok: true };
}

/** What the office reviews: the form as it was asked, beside what came back. */
export interface AdmissionProposal {
  inquiry: Inquiry;
  fields: AdmissionField[];
  answers: Record<string, string>;
  submitted: boolean;
}

export function admissionProposal(inquiryId: string): AdmissionProposal {
  const inquiry = db.select().from(inquiries).where(eq(inquiries.id, inquiryId)).get();
  if (!inquiry) throw new TRPCError({ code: 'NOT_FOUND', message: 'That inquiry no longer exists.' });
  const answers = (inquiry.submittedPayload ?? {}) as Record<string, string>;
  return { inquiry, fields: admissionFormFields(inquiry), answers, submitted: Object.keys(answers).length > 0 };
}

/**
 * Split a family's answers into the three tables they belong to.
 *
 * PURE — it decides nothing about writing and touches no database. `admissions/convert.ts` owns the
 * transaction that creates a child (§16), so the write stays there; what lives here is the knowledge
 * of which answer is about the CHILD, which is about the HOUSEHOLD, and which is about an adult,
 * because that is the same knowledge this module used to build the form.
 *
 * Two things it refuses, and both are the reason it is a function rather than a spread:
 *
 * 1. **A key the form would not have asked for is dropped.** The payload is stored JSON on a row, and
 *    a row is a thing a future migration, a restored backup or a hand-edit can put anything into. The
 *    field list is re-derived HERE rather than trusted from what was stored, so a key that was
 *    enabled when the family submitted and switched off since does not get written now.
 * 2. **An office-only field is never accepted from a payload**, even if one appears in it —
 *    `admittedOn` is the office's answer and conversion sets it from the approval, not from a form.
 */
export function admissionPatch(answers: Record<string, string>): {
  core: { fullName?: string; dob?: string };
  student: Record<string, string | null>;
  family: Record<string, string | null>;
  guardian: { name?: string; phone?: string; email?: string };
} {
  const fields = admissionFormFields(null);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const core: { fullName?: string; dob?: string } = {};
  const student: Record<string, string | null> = {};
  const family: Record<string, string | null> = {};
  const guardian: { name?: string; phone?: string; email?: string } = {};

  for (const [key, value] of Object.entries(answers)) {
    const field = byKey.get(key);
    if (!field) continue;
    const v = typeof value === 'string' ? value.trim() : '';
    if (!v) continue;
    switch (key) {
      case 'childName':
        core.fullName = v;
        continue;
      case 'childDob':
        core.dob = v;
        continue;
      case 'guardianName':
        guardian.name = v;
        continue;
      case 'guardianPhone':
        guardian.phone = v;
        continue;
      case 'guardianEmail':
        guardian.email = v.toLowerCase();
        continue;
      default:
        break;
    }
    const spec = studentField(key);
    if (!spec) continue;
    // A flag is stored as the registry stores one. 'yes'/'no' is what the form sends; anything else
    // was never answered and leaves the column alone rather than guessing a default.
    const stored = spec.kind === 'flag' ? (v === 'yes' ? '1' : v === 'no' ? '0' : null) : v;
    if (stored === null) continue;
    if (spec.scope === 'household') family[spec.column] = stored;
    else student[spec.column] = stored;
  }
  return { core, student, family, guardian };
}
