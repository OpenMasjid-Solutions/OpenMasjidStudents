// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * THE ONE PLACE AN INQUIRY BECOMES A STUDENT (0.52.0, CLAUDE.md §16, §4a Phase 2,
 * docs/ADMISSIONS.md §4).
 *
 * The delicate step of the whole phase, and everything below happens in ONE transaction: a household
 * (or the sibling's existing one), the child, their guardians, their fee plan, their class, the
 * enrollment fee, and the inquiry's move to `admitted` — or none of it.
 *
 * ── WHERE THE STUDENT ID COMES FROM, AND WHY IT IS NOT HERE ─────────────────
 *
 * `people/create.ts` `createStudentRow` mints it, as it does for every other path that creates a
 * child. This module does not generate one, does not accept one, and could not reserve one earlier
 * even if that were convenient: an ID is the whole credential on the payment path (§11.2), so minting
 * one at inquiry would put an unconfirmed, publicly submitted record where a stranger's payment could
 * land on it. That is the shortcut this phase exists to refuse.
 *
 * ── IDEMPOTENT BY CONSTRUCTION, NOT BY A GUARD BOLTED ON ────────────────────
 *
 * A double-submitted form, a double-clicked Admit and a retried request all find the inquiry already
 * `admitted` and get the existing student back. The state is what answers, because the state is
 * stored truth written in the same transaction as the child (§9) — not "does a student with this name
 * exist", which is a question a madrasah with two children called Muhammad Ali cannot answer. The
 * enrollment fee has its own, independent idempotency in the UNIQUE `charges.source_key`, so even a
 * conversion that somehow ran twice could not bill a family twice.
 *
 * ── WHAT IT REUSES RATHER THAN REIMPLEMENTS ─────────────────────────────────
 *
 * The student write path (`people/create.ts`), the household label derivation, the guardian write
 * pair, the fee-plan assignment `createStudentRow` already does, and the charge machinery
 * (`admissions/fees.ts` → `billing/charges.ts`). Admissions adds no money path and no second matcher.
 *
 * ── ONE THING PHASE 3 WILL MOVE ─────────────────────────────────────────────
 *
 * Class placement goes through `createStudentRow`'s `classId` today, because `structure/enrollment.ts`
 * — Phase 3's single mover, which opens a dated enrollment row alongside the pointer — does not exist
 * yet. When it does, this call site is one of the ones that must route through it, so an admission in
 * November opens an enrollment dated November and "the roster on that date" stays answerable. Do not
 * invent a partial `enrollment.ts` here to get ahead of it.
 */
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { rid } from '../db/ids';
import { families, guardianFamilies, guardians, inquiries, students, type Inquiry } from '../db/schema';
import { createStudentRow } from '../people/create';
import { identityKeys } from '../people/household';
import { audit, type AuditActor } from '../audit';
import type { Tx } from '../billing/ledger';
import { inquiryById, markAdmitted } from './transition';
import { raiseEnrollmentFee, type FeeResult } from './fees';

export interface ConvertInput {
  inquiryId: string;
  /** Required — a child with no plan is invisible to invoice generation (`people/create.ts`). */
  feePlanId: string;
  overrideAmountCents?: number | null;
  /** Join an existing household instead of creating one: the sibling case. */
  familyId?: string | null;
  classId?: string | null;
  /** The child's name as the office confirmed it, which may not be how a parent typed it at 11pm. */
  fullName?: string | null;
  dob?: string | null;
  admittedOn?: string | null;
  /** The adult to put on the household. Defaults to the name and contact from the inquiry itself. */
  guardian?: { name: string; phone?: string | null; email?: string | null; relation?: string | null } | null;
  feeWaived?: boolean;
  feeOverrideCents?: number | null;
  /**
   * The family's own answers from the admission form, already split by table (0.52.0-dev.12).
   *
   * Passed in rather than read from the inquiry here, because the OFFICE approves a proposal — they
   * may have corrected a name or rejected a field before pressing the button, and conversion must
   * write what was approved rather than re-reading what was submitted. `admissionPatch` is what
   * produces it, and it is the one place that knows which answer belongs to which table.
   */
  fields?: { student: Record<string, string | null>; family: Record<string, string | null> } | null;
}

export interface ConvertResult {
  studentId: string;
  studentCode: string;
  familyId: string;
  /** False when the inquiry was already admitted and this call returned the existing child. */
  created: boolean;
  fee: FeeResult | null;
}

/** Households that already hold somebody who looks like this family's adult. */
export interface SiblingHint {
  familyId: string;
  familyName: string;
  guardianName: string;
  /** Which identity matched — an office deciding "is this the same family?" should see WHY. */
  matchedOn: 'email' | 'phone' | 'name';
}

/**
 * Households this inquiry might already belong to.
 *
 * **Reuses `identityKeys` from `people/household.ts` rather than writing a third matcher** — it is
 * exported precisely so the sibling suggester and anything else asking "is this the same person?"
 * agree. `suggestSiblingGroups` itself cannot help here: it only considers households holding exactly
 * one active child, and an inquiry has no student row to appear in its output at all.
 *
 * A HINT, never an action. A younger sibling of an existing student must be OFFERED the existing
 * household rather than silently given a second one — but silently giving them the existing one is
 * the same mistake in the other direction, and worse, because it attaches a child to an address and
 * a set of guardians nobody confirmed. The office chooses; this only makes the choice visible.
 */
export function siblingHints(inquiry: Inquiry): SiblingHint[] {
  const wanted = identityKeys({ name: inquiry.parentName, phone: inquiry.phone, email: inquiry.email });
  if (wanted.length === 0) return [];
  const rank: Record<string, SiblingHint['matchedOn']> = { email: 'email', phone: 'phone', name: 'name' };
  const rows = db
    .select({ familyId: guardianFamilies.familyId, familyName: families.name, name: guardians.name, phone: guardians.phone, email: guardians.email })
    .from(guardianFamilies)
    .innerJoin(guardians, eq(guardians.id, guardianFamilies.guardianId))
    .innerJoin(families, eq(families.id, guardianFamilies.familyId))
    .all();

  const out = new Map<string, SiblingHint>();
  for (const r of rows) {
    for (const key of identityKeys({ name: r.name, phone: r.phone, email: r.email })) {
      if (!wanted.includes(key)) continue;
      const kind = rank[key.split(':')[0]] ?? 'name';
      const existing = out.get(r.familyId);
      // An email match is worth more than a name match, so a household that matches both is reported
      // by the stronger one — "same email address" and "same name" are not equally persuasive.
      if (!existing || (existing.matchedOn === 'name' && kind !== 'name')) {
        out.set(r.familyId, { familyId: r.familyId, familyName: r.familyName, guardianName: r.name, matchedOn: kind });
      }
    }
  }
  return [...out.values()];
}

/** The already-admitted answer, so a repeat is a no-op rather than an error. */
function existingConversion(inquiry: Inquiry): ConvertResult | null {
  if (inquiry.state !== 'admitted' || !inquiry.studentId) return null;
  const s = db.select({ id: students.id, studentCode: students.studentCode, familyId: students.familyId }).from(students).where(eq(students.id, inquiry.studentId)).get();
  // A student that has since been hard-deleted (§9's one door) leaves `student_id` null through the
  // FK, so reaching here with a missing row would be a genuine fault rather than a repeat.
  if (!s) throw new TRPCError({ code: 'CONFLICT', message: 'That inquiry was admitted, but the student record is gone. Somebody deleted it.' });
  return { studentId: s.id, studentCode: s.studentCode ?? '', familyId: s.familyId, created: false, fee: null };
}

export function convertInquiry(input: ConvertInput, actor: AuditActor, at = new Date()): ConvertResult {
  const inquiry = inquiryById(input.inquiryId);
  if (!inquiry) throw new TRPCError({ code: 'NOT_FOUND', message: 'That inquiry no longer exists.' });

  // Idempotency, first and outside the transaction: the common repeat is a second click, and it
  // should cost one read.
  const already = existingConversion(inquiry);
  if (already) return already;

  // A declined inquiry is not admitted by accident. The office reopens it first, which is one click
  // and leaves a trail row saying they did — the alternative is a decline that silently means nothing.
  if (inquiry.state === 'declined') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'That inquiry was declined. Reopen it first if you want to admit this child.' });
  }

  const fullName = (input.fullName ?? inquiry.childName).trim();
  if (!fullName) throw new TRPCError({ code: 'BAD_REQUEST', message: 'A child needs a name.' });

  const result = db.transaction((tx) => {
    const txx = tx as unknown as Tx;
    let familyId = input.familyId ?? null;
    if (familyId) {
      if (!txx.select({ id: families.id }).from(families).where(eq(families.id, familyId)).get()) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That household no longer exists.' });
      }
    } else {
      familyId = rid('fam');
      // A placeholder, overwritten inside this same transaction: `createStudentRow` derives the real
      // label from the children. Nobody is ever asked to NAME a household (§4).
      txx.insert(families).values({ id: familyId, name: 'Family', status: 'active', createdAt: at, updatedAt: at }).run();
    }

    const student = createStudentRow(
      {
        familyId,
        fullName,
        dob: (input.dob ?? inquiry.childDob) ?? undefined,
        feePlanId: input.feePlanId,
        overrideAmountCents: input.overrideAmountCents ?? undefined,
        classId: input.classId ?? undefined,
        noteBy: { userId: actor.userId ?? null, name: actor.name ?? null },
      },
      actor,
      txx,
    );

    // When this child actually joined, which is not `created_at` — that is when somebody typed them
    // in. Defaults to today, because an admission approved today is an admission today.
    //
    // The registry answers ride along in the SAME update rather than a second one: they are columns
    // on the row this statement is already writing, and two updates would be two chances for half of
    // an approved form to land. Column names come from `people/fields.ts` via `admissionPatch`, which
    // re-derives them from the catalog, so a key that is not a real enabled field never arrives here.
    txx
      .update(students)
      .set({
        admittedOn: (input.admittedOn ?? at.toISOString().slice(0, 10)) || null,
        ...(input.fields?.student ?? {}),
        updatedAt: at,
      })
      .where(eq(students.id, student.id))
      .run();

    // Address, languages and nationality belong to the HOUSEHOLD, not the child (§9, 0.52.0-dev.4) —
    // which is why the same form's answers land in two tables. Skipped when joining an existing
    // household: a younger sibling's form must not silently overwrite the address their brother's
    // record already carries, and the office can see the answer on the proposal either way.
    const familyPatch = input.fields?.family ?? {};
    if (!input.familyId && Object.keys(familyPatch).length) {
      txx.update(families).set({ ...familyPatch, updatedAt: at }).where(eq(families.id, familyId)).run();
    }

    // The adult goes on the HOUSEHOLD, as guardians always have — nothing is copied onto the child,
    // and there are no columns there to copy it into (§9). Skipped entirely when joining an existing
    // household, whose guardians are already right.
    const g = input.guardian ?? (input.familyId ? null : { name: inquiry.parentName, phone: inquiry.phone, email: inquiry.email, relation: null });
    if (g && g.name.trim()) {
      const gid = rid('grd');
      txx
        .insert(guardians)
        .values({ id: gid, name: g.name.trim(), phone: (g.phone ?? '').trim() || null, email: (g.email ?? '').trim().toLowerCase() || null, createdAt: at, updatedAt: at })
        .run();
      txx.insert(guardianFamilies).values({ guardianId: gid, familyId, relation: (g.relation ?? '').trim() || null, isEmergencyContact: false, createdAt: at }).run();
    }

    // Stored truth, in the same transaction as the child it is true about. `markAdmitted` is the only
    // way to reach this state, and it writes the trail row and the audit row with it.
    markAdmitted({ inquiryId: inquiry.id, studentId: student.id, familyId, actor, at, tx: txx });

    return { studentId: student.id, studentCode: student.studentCode, familyId, created: true };
  });

  // The fee is raised AFTER the transaction commits, deliberately. It is idempotent on its own
  // (UNIQUE `charges.source_key`), so a failure here leaves an admitted child with no enrollment
  // charge — which an office can see and fix — rather than rolling back a conversion that succeeded
  // and leaving the family wondering why they were admitted twice.
  const fee = raiseEnrollmentFee({
    studentId: result.studentId,
    inquiryId: inquiry.id,
    schoolYearId: inquiry.schoolYearId,
    kind: 'admission',
    overrideCents: input.feeOverrideCents,
    waived: input.feeWaived,
    createdByUserId: actor.userId ?? null,
    at,
  });

  audit(actor, 'inquiry.convert', {
    entity: 'inquiry',
    entityId: inquiry.id,
    detail: { studentId: result.studentId, familyId: result.familyId, joinedExisting: !!input.familyId, chargeRaised: fee.created },
  });

  return { ...result, fee };
}

/** Everything the Admit screen needs before it can ask anything: who this might already be. */
export function conversionPreview(inquiryId: string): { inquiry: Inquiry; hints: SiblingHint[]; alreadyAdmitted: boolean } {
  const inquiry = inquiryById(inquiryId);
  if (!inquiry) throw new TRPCError({ code: 'NOT_FOUND', message: 'That inquiry no longer exists.' });
  return { inquiry, hints: siblingHints(inquiry), alreadyAdmitted: inquiry.state === 'admitted' };
}

/** The inquiry a student came from, when they came from one — read by the student's own record. */
export function inquiryForStudent(studentId: string): Inquiry | undefined {
  return db.select().from(inquiries).where(eq(inquiries.studentId, studentId)).get();
}
