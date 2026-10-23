// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * THE ENROLLMENT FEE (0.52.0, CLAUDE.md §4a Phase 2, docs/ADMISSIONS.md §1.5, §4).
 *
 * **This file opens no path into the ledger, and that is the whole of its job.** It reads what a year
 * charges, applies whatever the office waived or overrode for this family, and hands the result to
 * `billing/charges.ts` `raiseChargeOnce` — the charge machinery that already existed. It writes
 * nothing to `charges` itself, knows nothing about invoices, and touches no money math.
 *
 * §4a's binding invariant for the whole academic layer is that nothing in it may touch the ledger,
 * invoicing or the Fabric contract, and the one place money and academics meet is exactly this: an
 * ordinary charge, raised the ordinary way. If a design here ever seems to need its own money path,
 * it is wrong.
 *
 * ── Charged ON ENROLLMENT, never pay-to-confirm (decision 1) ────────────────
 *
 * Taking money to hold a place would mean accepting a payment for a child with no student record —
 * a second entry point into the ledger, and one with nothing to attach the money to. Settled, and if
 * it is ever wanted it needs its own design pass and its own answer to "what is the money attached to
 * before the child exists?".
 *
 * ── Idempotent by the DATABASE, not by a guard ──────────────────────────────
 *
 * `sourceKeyFor('admission', inquiryId)` is deterministic, `charges.source_key` is UNIQUE, and a
 * repeat is a NO-OP that returns the existing charge rather than an error — because the caller is a
 * bulk approve button pressed twice by somebody who thought the first press had not registered, and
 * "already done" is a success. That whole mechanism shipped in Phase 0, ahead of this caller, for
 * this reason (§9).
 */
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { schoolYears } from '../db/schema';
import { chargeBySourceKey, raiseChargeOnce, sourceKeyFor } from '../billing/charges';

/** What this family actually pays, after the office's own decision about them. */
export interface FeeDecision {
  /** Null means nothing is charged: no fee on the year, or the office waived it. */
  amountCents: number | null;
  /** Why, for the screen — never for the charge label. */
  reason: 'none' | 'waived' | 'override' | 'year';
}

/**
 * Resolve the fee for one enrollment.
 *
 * A waiver beats an override beats the year's figure, and each step is a narrower decision than the
 * one before it: the year is the list price, an override is this family's price, and a waiver is "not
 * this family, this time". `fee_waived` is a separate column from `fee_override_cents` on purpose —
 * an override of 0 would say the same thing ambiguously, and an office reading the record back needs
 * to see that somebody DECIDED rather than that a number happened to be zero.
 */
export function resolveEnrollmentFee(opts: {
  schoolYearId: string | null;
  kind: 'admission' | 'readmission';
  overrideCents?: number | null;
  waived?: boolean;
}): FeeDecision {
  if (opts.waived) return { amountCents: null, reason: 'waived' };
  if (opts.overrideCents != null) {
    return opts.overrideCents > 0 ? { amountCents: opts.overrideCents, reason: 'override' } : { amountCents: null, reason: 'waived' };
  }
  if (!opts.schoolYearId) return { amountCents: null, reason: 'none' };
  const year = db.select().from(schoolYears).where(eq(schoolYears.id, opts.schoolYearId)).get();
  if (!year) return { amountCents: null, reason: 'none' };
  const listed = opts.kind === 'admission' ? year.admissionFeeCents : year.readmissionFeeCents;
  // Null means no fee, which is an ordinary madrasah rather than an unconfigured one. So is 0, and
  // `raiseChargeOnce` refuses a zero charge anyway — a bill for nothing is not a bill.
  if (listed == null || listed <= 0) return { amountCents: null, reason: 'none' };
  return { amountCents: listed, reason: 'year' };
}

export interface FeeResult {
  /** The charge id, when one exists — whether this call raised it or found it already raised. */
  chargeId: string | null;
  /** True only when THIS call wrote the row. A bulk button re-pressed reports false, not an error. */
  created: boolean;
  decision: FeeDecision;
}

/**
 * Raise the enrollment fee for a child who has just been admitted, once.
 *
 * The label is SNAPSHOTTED like every other charge — re-pricing next year's fee must not rewrite what
 * this family was billed (§4). The period is left null, so it lands in the next run the office
 * generates rather than this module deciding what a bill is made of; that answer belongs to
 * `billing/invoices.ts` and differs per caller.
 */
export function raiseEnrollmentFee(opts: {
  studentId: string;
  inquiryId?: string;
  schoolYearId: string | null;
  yearLabel?: string | null;
  kind: 'admission' | 'readmission';
  overrideCents?: number | null;
  waived?: boolean;
  createdByUserId?: string | null;
  at?: Date;
}): FeeResult {
  const decision = resolveEnrollmentFee(opts);
  const sourceKey =
    opts.kind === 'admission'
      ? sourceKeyFor('admission', opts.inquiryId ?? opts.studentId)
      : sourceKeyFor('readmission', opts.studentId, opts.schoolYearId ?? 'no-year');

  if (decision.amountCents == null) {
    // Nothing to charge. Report any charge already raised under this key rather than pretending there
    // is none: an office that set a fee, approved, and then waived it afterwards must still be able
    // to see the charge that exists and void it deliberately.
    return { chargeId: chargeBySourceKey(sourceKey)?.id ?? null, created: false, decision };
  }

  const label = opts.kind === 'admission' ? 'Enrollment fee' : `Re-enrollment fee${opts.yearLabel ? ` — ${opts.yearLabel}` : ''}`;
  const { chargeId, created } = raiseChargeOnce(
    {
      studentId: opts.studentId,
      label,
      amountCents: decision.amountCents,
      periodKey: null,
      createdByUserId: opts.createdByUserId ?? null,
      sourceKey,
    },
    opts.at,
  );
  return { chargeId, created, decision };
}
