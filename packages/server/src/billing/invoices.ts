// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Invoice generation (CLAUDE.md §4): build a family's invoice for a period from its active
 * students' fees (one line per student × fee plan), append any pending one-off charges, then
 * apply the family's discount as a negative line. UNIQUE(family, periodKey) makes generation
 * idempotent — re-running a period never double-bills. Money is integer cents.
 *
 * Three rules live here and nowhere else:
 *
 *  1. CADENCE IS HONOURED. A `monthly` plan bills only on month periods; a `per_term` plan only
 *     on term periods (so generating a term invoice can't double-bill monthly tuition); a
 *     `one_time` plan bills exactly once, ever, deduped on (student, plan) against live invoice
 *     lines. A madrasah with no terms configured simply never generates term periods, so its
 *     `per_term` plans are an intentional no-op.
 *  2. THE EFFECTIVE AMOUNT is `student_fees.override_amount_cents ?? fee_plans.amount_cents`, so
 *     one student can be charged differently without minting a parallel plan.
 *  3. THE DISCOUNT APPLIES TO TUITION ONLY, never to charges — a percentage off a book or a late
 *     fee is not what a family discount means.
 */
import { and, eq, asc, ne, or, isNull } from 'drizzle-orm';
import { db } from '../db';
import { invoices, invoiceItems, studentFees, students, feePlans, families, charges } from '../db/schema';
import { rid } from '../db/ids';
import { refreshStatus, type Tx } from './ledger';

/** Which kind of period is being generated. Drives the cadence gate. */
export type PeriodKind = 'month' | 'term';

export interface GenerateOpts {
  periodKey: string;
  label: string;
  dueDate?: string | null;
  /** Defaults to `month` — the common case and what the existing callers mean. */
  periodKind?: PeriodKind;
}

/** Has this student already been billed for this plan on a LIVE (non-void) invoice? Voiding an
 *  invoice deliberately makes a one-time fee billable again. */
function alreadyBilled(tx: Tx, studentId: string, feePlanId: string): boolean {
  return !!tx
    .select({ id: invoiceItems.id })
    .from(invoiceItems)
    .innerJoin(invoices, eq(invoices.id, invoiceItems.invoiceId))
    .where(and(eq(invoiceItems.studentId, studentId), eq(invoiceItems.feePlanId, feePlanId), ne(invoices.status, 'void')))
    .get();
}

interface Line {
  description: string;
  amountCents: number;
  studentId: string;
  feePlanId: string | null;
}

/** Tuition lines from a family's active students' active fee plans, after the cadence gate and
 *  the per-student override. */
function feeLines(tx: Tx, familyId: string, periodKind: PeriodKind): Line[] {
  const rows = tx
    .select({
      studentId: students.id,
      firstName: students.firstName,
      planId: feePlans.id,
      planName: feePlans.name,
      planAmount: feePlans.amountCents,
      cadence: feePlans.cadence,
      override: studentFees.overrideAmountCents,
    })
    .from(studentFees)
    .innerJoin(students, eq(students.id, studentFees.studentId))
    .innerJoin(feePlans, eq(feePlans.id, studentFees.feePlanId))
    .where(and(eq(students.familyId, familyId), eq(students.status, 'active'), eq(feePlans.status, 'active')))
    .orderBy(asc(students.firstName))
    .all();

  const out: Line[] = [];
  for (const r of rows) {
    if (r.cadence === 'monthly' && periodKind !== 'month') continue;
    if (r.cadence === 'per_term' && periodKind !== 'term') continue;
    if (r.cadence === 'one_time' && alreadyBilled(tx, r.studentId, r.planId)) continue;
    const amountCents = r.override ?? r.planAmount;
    if (amountCents === 0) continue; // a zero line is noise on a printed statement
    out.push({ description: `${r.planName} — ${r.firstName}`, amountCents, studentId: r.studentId, feePlanId: r.planId });
  }
  return out;
}

/** Pending charges that belong on this period: either explicitly targeted at it, or untargeted
 *  (`period_key IS NULL`) and therefore due on the next invoice generated. */
function pendingCharges(tx: Tx, familyId: string, periodKey: string) {
  return tx
    .select({ id: charges.id, studentId: charges.studentId, firstName: students.firstName, label: charges.label, amountCents: charges.amountCents })
    .from(charges)
    .innerJoin(students, eq(students.id, charges.studentId))
    .where(
      and(
        eq(students.familyId, familyId),
        eq(students.status, 'active'),
        eq(charges.status, 'pending'),
        or(eq(charges.periodKey, periodKey), isNull(charges.periodKey)),
      ),
    )
    .orderBy(asc(students.firstName), asc(charges.createdAt))
    .all();
}

/** The family discount as a negative amount for a given tuition subtotal (0 if none). */
function discountCents(tx: Tx, familyId: string, subtotal: number): number {
  const fam = tx.select({ kind: families.discountKind, value: families.discountValue }).from(families).where(eq(families.id, familyId)).get();
  if (!fam || fam.kind === 'none' || subtotal <= 0) return 0;
  if (fam.kind === 'percent') return -Math.min(subtotal, Math.round((subtotal * fam.value) / 10000));
  return -Math.min(subtotal, fam.value); // fixed
}

/** Insert one charge as an invoice line and flip it to `invoiced`. */
function writeChargeLine(tx: Tx, invoiceId: string, c: { id: string; studentId: string; firstName: string; label: string; amountCents: number }, ts: Date): void {
  const itemId = rid('iti');
  tx.insert(invoiceItems).values({ id: itemId, invoiceId, description: `${c.label} — ${c.firstName}`, amountCents: c.amountCents, studentId: c.studentId, feePlanId: null, createdAt: ts }).run();
  tx.update(charges).set({ status: 'invoiced', invoiceItemId: itemId, updatedAt: ts }).where(eq(charges.id, c.id)).run();
}

/** Generate one family's invoice for a period. Idempotent on (family, periodKey); returns the
 *  existing invoice unchanged if already generated, and skips a family with nothing to bill.
 *  Everything is computed INSIDE the transaction so the one-time dedupe can't race the insert. */
export function generateForFamily(familyId: string, opts: GenerateOpts): { invoiceId: string | null; created: boolean } {
  const existing = db.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.familyId, familyId), eq(invoices.periodKey, opts.periodKey))).get();
  if (existing) return { invoiceId: existing.id, created: false };

  const periodKind = opts.periodKind ?? 'month';
  const ts = new Date();
  const invId = rid('inv');
  let created = false;

  db.transaction((tx) => {
    const lines = feeLines(tx, familyId, periodKind);
    const chs = pendingCharges(tx, familyId, opts.periodKey);
    if (lines.length === 0 && chs.length === 0) return; // nothing to bill — no empty invoice

    const subtotal = lines.reduce((s, l) => s + l.amountCents, 0);
    const disc = discountCents(tx, familyId, subtotal);

    tx.insert(invoices).values({ id: invId, familyId, label: opts.label, periodKey: opts.periodKey, dueDate: opts.dueDate ?? null, status: 'open', createdAt: ts, updatedAt: ts }).run();
    for (const l of lines) {
      tx.insert(invoiceItems).values({ id: rid('iti'), invoiceId: invId, description: l.description, amountCents: l.amountCents, studentId: l.studentId, feePlanId: l.feePlanId, createdAt: ts }).run();
    }
    for (const c of chs) writeChargeLine(tx, invId, c, ts);
    if (disc !== 0) {
      tx.insert(invoiceItems).values({ id: rid('iti'), invoiceId: invId, description: 'Family discount', amountCents: disc, studentId: null, feePlanId: null, createdAt: ts }).run();
    }
    created = true;
  });

  return { invoiceId: created ? invId : null, created };
}

/** Generate invoices for every active family that has something to bill. Returns how many were created. */
export function generateForPeriod(opts: GenerateOpts): { created: number } {
  const fams = db.select({ id: families.id }).from(families).where(eq(families.status, 'active')).all();
  let created = 0;
  for (const f of fams) if (generateForFamily(f.id, opts).created) created++;
  return { created };
}

/** Append a single pending charge onto the family's ALREADY-EXISTING invoice for its period, when
 *  there is one. This is the "add a charge to the invoice" path: if the period has been generated
 *  the charge lands immediately and the invoice's status is re-derived; otherwise it stays
 *  `pending` and the next generation picks it up. A void invoice is refused — its lines are
 *  settled history, and re-opening it by adding a line would corrupt the family balance. */
export function attachChargeToExistingInvoice(chargeId: string): { attached: boolean; invoiceId?: string; reason?: 'no_period' | 'no_invoice' | 'invoice_void' | 'not_pending' } {
  const c = db
    .select({ id: charges.id, studentId: charges.studentId, firstName: students.firstName, familyId: students.familyId, label: charges.label, amountCents: charges.amountCents, periodKey: charges.periodKey, status: charges.status })
    .from(charges)
    .innerJoin(students, eq(students.id, charges.studentId))
    .where(eq(charges.id, chargeId))
    .get();
  if (!c) return { attached: false, reason: 'not_pending' };
  if (c.status !== 'pending') return { attached: false, reason: 'not_pending' };
  if (!c.periodKey) return { attached: false, reason: 'no_period' };

  const inv = db.select({ id: invoices.id, status: invoices.status }).from(invoices).where(and(eq(invoices.familyId, c.familyId), eq(invoices.periodKey, c.periodKey))).get();
  if (!inv) return { attached: false, reason: 'no_invoice' };
  if (inv.status === 'void') return { attached: false, reason: 'invoice_void' };

  const ts = new Date();
  db.transaction((tx) => {
    writeChargeLine(tx, inv.id, { id: c.id, studentId: c.studentId, firstName: c.firstName, label: c.label, amountCents: c.amountCents }, ts);
    tx.update(invoices).set({ updatedAt: ts }).where(eq(invoices.id, inv.id)).run();
    refreshStatus(tx, inv.id);
  });
  return { attached: true, invoiceId: inv.id };
}
