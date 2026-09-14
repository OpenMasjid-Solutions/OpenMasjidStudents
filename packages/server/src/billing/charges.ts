// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * RAISING A CHARGE WITH A NATURAL KEY — the one place a charge is raised on a family's behalf (0.52.0).
 *
 * CLAUDE.md §9, §16, §4a Phase 0.
 *
 * ── Why this exists before anything calls it ────────────────────────────────
 *
 * `charges` shipped with two indexes, neither unique, and `billing.chargeAdd` inserts with a fresh id
 * and no existence check — while bulk FEE-PLAN assignment, a few hundred lines away in the same router,
 * does check first. That asymmetry is harmless while a person raises every charge by hand: a duplicate
 * is visible on the screen and voidable in a click.
 *
 * It stops being harmless the moment software raises one. §4a Phase 2 raises an enrollment fee at
 * admission conversion and a re-admission fee at approval, from BULK buttons, across a whole school in
 * one fortnight — where "approve the returning cohort" gets pressed a second time because the first
 * press looked slow. A family charged twice for re-enrolling is the kind of defect that looks fine in
 * testing and lands on a hundred households at once.
 *
 * So the key, the column and its one writer land together and ahead of the caller, and they belong to
 * `billing/` rather than to `admissions/` because the next thing that raises money on a schedule will
 * need exactly this (§9).
 *
 * ── What it is NOT ──────────────────────────────────────────────────────────
 *
 * **Not a second human-facing way to raise a charge.** The office's path stays `billing.chargeAdd` and
 * `billing.chargeAddBulk`, which pass no key and are unaffected: `source_key` is NULL for every charge a
 * person raises, and SQLite permits many NULLs in a UNIQUE column. Adding a `sourceKey` input to those
 * procedures would put a deduplication mechanism in the hands of somebody who has no deterministic key
 * to give it — which is how a second place starts deciding an existing rule (§20).
 *
 * **Not a billing step.** This writes the `charges` row and stops. Whether that charge is billed on its
 * own, attached to an existing invoice, or left for the next period's run is `billing/invoices.ts`'s
 * question, and the caller asks it — because the answer differs per caller and baking one in here would
 * make this the second place that decides what a bill is made of.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { rid } from '../db/ids';
import { charges, type Charge } from '../db/schema';

/**
 * A deterministic, namespaced key for a charge raised by software.
 *
 * Namespaced because two features must not be able to collide on a bare id, and the column is UNIQUE
 * across the whole table. Built here rather than typed at each call site so the shape is one decision:
 * `admission:inq_7`, `readmission:stu_3:sy_2027`.
 */
export function sourceKeyFor(kind: 'admission' | 'readmission', ...parts: string[]): string {
  if (parts.length === 0 || parts.some((p) => !p)) throw new Error('a source key needs every part');
  return [kind, ...parts].join(':');
}

export type ChargeRaise = {
  studentId: string;
  /** Snapshotted at the point of raising, like every other charge — re-pricing must not rewrite history. */
  label: string;
  amountCents: number;
  chargeItemId?: string | null;
  note?: string | null;
  /** Which billing period to land in; null means the next period generated. */
  periodKey?: string | null;
  createdByUserId?: string | null;
  /** From `sourceKeyFor`. Required — a caller with nothing deterministic to say should use `chargeAdd`. */
  sourceKey: string;
};

/** The charge already raised under this key, if there is one. */
export function chargeBySourceKey(sourceKey: string): Charge | undefined {
  return db.select().from(charges).where(eq(charges.sourceKey, sourceKey)).get();
}

/**
 * Raise a charge once, whatever happens.
 *
 * `created: false` means the key had already been used and the existing charge is returned unchanged —
 * that is a SUCCESS and not an error, because the caller is a button whose honest answer to "already
 * done" is "done". Nothing about the existing row is updated: a re-approval must not silently re-price
 * a fee the office may have already adjusted by hand.
 *
 * The read-then-insert is not the guard; the UNIQUE index is. Two concurrent approvals both pass the
 * read, so the loser catches the constraint and re-reads. Handling it this way rather than with a
 * transaction is deliberate — an INSERT ... ON CONFLICT DO NOTHING would not tell us which row won, and
 * a transaction around a read still needs the constraint to be correct under concurrency.
 */
export function raiseChargeOnce(r: ChargeRaise, at = new Date()): { chargeId: string; created: boolean } {
  const existing = chargeBySourceKey(r.sourceKey);
  if (existing) return { chargeId: existing.id, created: false };

  if (r.amountCents === 0) throw new Error('a charge cannot be zero');

  const id = rid('chg');
  try {
    db.insert(charges)
      .values({
        id,
        studentId: r.studentId,
        chargeItemId: r.chargeItemId ?? null,
        label: r.label,
        amountCents: r.amountCents,
        note: r.note ?? null,
        periodKey: r.periodKey ?? null,
        status: 'pending',
        invoiceItemId: null,
        createdByUserId: r.createdByUserId ?? null,
        sourceKey: r.sourceKey,
        createdAt: at,
        updatedAt: at,
      })
      .run();
    return { chargeId: id, created: true };
  } catch (e) {
    // The only constraint this insert can violate is the source-key one; anything else is a real fault
    // and must keep propagating rather than being swallowed as "already raised".
    const raced = chargeBySourceKey(r.sourceKey);
    if (!raced) throw e;
    return { chargeId: raced.id, created: false };
  }
}
