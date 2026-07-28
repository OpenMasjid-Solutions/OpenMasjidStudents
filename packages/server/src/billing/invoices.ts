// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Invoice generation (CLAUDE.md §4): build ONE STUDENT's invoice for a period from their own fee
 * plans (one line per plan), then append any pending one-off charges of theirs.
 * UNIQUE(student, periodKey) makes generation idempotent — re-running a period never double-bills.
 * Money is integer cents.
 *
 * Two rules live here and nowhere else:
 *
 *  1. CADENCE IS HONOURED. A `monthly` plan bills only on month periods; a `per_term` plan only
 *     on term periods (so generating a term invoice can't double-bill monthly tuition); a
 *     `one_time` plan bills exactly once, ever, deduped on (student, plan) against live invoice
 *     lines. A madrasah with no terms configured simply never generates term periods, so its
 *     `per_term` plans are an intentional no-op.
 *  2. THE EFFECTIVE AMOUNT is `student_fees.override_amount_cents ?? fee_plans.amount_cents`, so
 *     one student can be charged differently without minting a parallel plan. This override is
 *     also how a sibling discount is expressed now that the family-level discount is gone (0.39.0)
 *     — a discount belongs on the child whose bill it reduces, not on a household line no single
 *     invoice could honestly carry.
 */
import { and, eq, asc, ne, or, isNull } from 'drizzle-orm';
import { db } from '../db';
import { invoices, invoiceItems, studentFees, students, feePlans, charges } from '../db/schema';
import { rid } from '../db/ids';
import { refreshStatus, reallocateStudent, type Tx } from './ledger';

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

/** Tuition lines from ONE student's active fee plans, after the cadence gate and the per-student
 *  override. Returns [] for a student who is not active. */
function feeLines(tx: Tx, studentId: string, periodKind: PeriodKind): Line[] {
  const rows = tx
    .select({
      studentId: students.id,
      planId: feePlans.id,
      planName: feePlans.name,
      planAmount: feePlans.amountCents,
      cadence: feePlans.cadence,
      override: studentFees.overrideAmountCents,
    })
    .from(studentFees)
    .innerJoin(students, eq(students.id, studentFees.studentId))
    .innerJoin(feePlans, eq(feePlans.id, studentFees.feePlanId))
    .where(and(eq(students.id, studentId), eq(students.status, 'active'), eq(feePlans.status, 'active')))
    .orderBy(asc(feePlans.name))
    .all();

  const out: Line[] = [];
  for (const r of rows) {
    if (r.cadence === 'monthly' && periodKind !== 'month') continue;
    if (r.cadence === 'per_term' && periodKind !== 'term') continue;
    if (r.cadence === 'one_time' && alreadyBilled(tx, r.studentId, r.planId)) continue;
    const amountCents = r.override ?? r.planAmount;
    if (amountCents === 0) continue; // a zero line is noise on a printed statement
    // No name in the description any more: the invoice IS the child's, so "Tuition — Yusuf" on
    // Yusuf's own bill just repeats the header.
    out.push({ description: r.planName, amountCents, studentId: r.studentId, feePlanId: r.planId });
  }
  return out;
}

/** One student's pending charges that belong on this period: either explicitly targeted at it, or
 *  untargeted (`period_key IS NULL`) and therefore due on the next invoice generated. */
function pendingCharges(tx: Tx, studentId: string, periodKey: string) {
  return tx
    .select({ id: charges.id, studentId: charges.studentId, label: charges.label, amountCents: charges.amountCents })
    .from(charges)
    .innerJoin(students, eq(students.id, charges.studentId))
    .where(
      and(
        eq(students.id, studentId),
        eq(students.status, 'active'),
        eq(charges.status, 'pending'),
        or(eq(charges.periodKey, periodKey), isNull(charges.periodKey)),
      ),
    )
    .orderBy(asc(charges.createdAt))
    .all();
}

/** Insert one charge as an invoice line and flip it to `invoiced`. */
function writeChargeLine(tx: Tx, invoiceId: string, c: { id: string; studentId: string; label: string; amountCents: number }, ts: Date): void {
  const itemId = rid('iti');
  tx.insert(invoiceItems).values({ id: itemId, invoiceId, description: c.label, amountCents: c.amountCents, studentId: c.studentId, feePlanId: null, createdAt: ts }).run();
  tx.update(charges).set({ status: 'invoiced', invoiceItemId: itemId, updatedAt: ts }).where(eq(charges.id, c.id)).run();
}

/** Generate one STUDENT's invoice for a period. Idempotent on (student, periodKey); returns the
 *  existing invoice unchanged if already generated, and skips a student with nothing to bill.
 *  Everything is computed INSIDE the transaction so the one-time dedupe can't race the insert. */
export function generateForStudent(studentId: string, opts: GenerateOpts): { invoiceId: string | null; created: boolean } {
  const existing = db.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.studentId, studentId), eq(invoices.periodKey, opts.periodKey))).get();
  if (existing) return { invoiceId: existing.id, created: false };

  const periodKind = opts.periodKind ?? 'month';
  const ts = new Date();
  const invId = rid('inv');
  let created = false;

  db.transaction((tx) => {
    const lines = feeLines(tx, studentId, periodKind);
    const chs = pendingCharges(tx, studentId, opts.periodKey);
    if (lines.length === 0 && chs.length === 0) return; // nothing to bill — no empty invoice

    tx.insert(invoices).values({ id: invId, studentId, label: opts.label, periodKey: opts.periodKey, dueDate: opts.dueDate ?? null, status: 'open', createdAt: ts, updatedAt: ts }).run();
    for (const l of lines) {
      tx.insert(invoiceItems).values({ id: rid('iti'), invoiceId: invId, description: l.description, amountCents: l.amountCents, studentId: l.studentId, feePlanId: l.feePlanId, createdAt: ts }).run();
    }
    for (const c of chs) writeChargeLine(tx, invId, c, ts);
    // Money the family already handed over covers this month the moment it is billed. Without this
    // an advance payment stayed as an unattached credit and the new invoice showed up unpaid — right
    // balance, wrong invoice status, and a ✗ in the year grid for a month that IS paid.
    reallocateStudent(tx, studentId);
    created = true;
  });

  return { invoiceId: created ? invId : null, created };
}

/** Generate invoices for every student on one family. The "bill this household" action — a parent
 *  thinks in households even though each child now gets their own bill. */
export function generateForFamily(familyId: string, opts: GenerateOpts): { created: number; invoiceIds: string[] } {
  const kids = db.select({ id: students.id }).from(students).where(and(eq(students.familyId, familyId), eq(students.status, 'active'))).orderBy(asc(students.fullName)).all();
  const invoiceIds: string[] = [];
  let created = 0;
  for (const k of kids) {
    const r = generateForStudent(k.id, opts);
    if (r.invoiceId) invoiceIds.push(r.invoiceId);
    if (r.created) created++;
  }
  return { created, invoiceIds };
}

/** Generate invoices for every active student who has something to bill. Returns how many were created. */
export function generateForPeriod(opts: GenerateOpts): { created: number } {
  const kids = db.select({ id: students.id }).from(students).where(eq(students.status, 'active')).all();
  let created = 0;
  for (const k of kids) if (generateForStudent(k.id, opts).created) created++;
  return { created };
}

/** Append a single pending charge onto the family's ALREADY-EXISTING invoice for its period, when
 *  there is one. This is the "add a charge to the invoice" path: if the period has been generated
 *  the charge lands immediately and the invoice's status is re-derived; otherwise it stays
 *  `pending` and the next generation picks it up. A void invoice is refused — its lines are
 *  settled history, and re-opening it by adding a line would corrupt the family balance. */
export function attachChargeToExistingInvoice(chargeId: string): { attached: boolean; invoiceId?: string; reason?: 'no_period' | 'no_invoice' | 'invoice_void' | 'not_pending' } {
  const c = db
    .select({ id: charges.id, studentId: charges.studentId, label: charges.label, amountCents: charges.amountCents, periodKey: charges.periodKey, status: charges.status })
    .from(charges)
    .where(eq(charges.id, chargeId))
    .get();
  if (!c) return { attached: false, reason: 'not_pending' };
  if (c.status !== 'pending') return { attached: false, reason: 'not_pending' };
  if (!c.periodKey) return { attached: false, reason: 'no_period' };

  const inv = db.select({ id: invoices.id, status: invoices.status }).from(invoices).where(and(eq(invoices.studentId, c.studentId), eq(invoices.periodKey, c.periodKey))).get();
  if (!inv) return { attached: false, reason: 'no_invoice' };
  if (inv.status === 'void') return { attached: false, reason: 'invoice_void' };

  const ts = new Date();
  db.transaction((tx) => {
    writeChargeLine(tx, inv.id, { id: c.id, studentId: c.studentId, label: c.label, amountCents: c.amountCents }, ts);
    tx.update(invoices).set({ updatedAt: ts }).where(eq(invoices.id, inv.id)).run();
    refreshStatus(tx, inv.id);
    // A charge on a family sitting on an advance balance should come OUT of that balance first —
    // that is what a parent means by "we've already paid ahead". Re-deriving oldest-due-first does
    // it: the charge's invoice is older than the months the advance was covering, so it takes its
    // money back off the newest covered month. If that leaves the month short it correctly returns
    // to open, which is what puts it back on the statement and in front of autopay.
    reallocateStudent(tx, c.studentId);
  });
  return { attached: true, invoiceId: inv.id };
}
