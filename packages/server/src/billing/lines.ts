// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * What a bill is actually MADE OF — the payable lines on an invoice.
 *
 * An invoice has always had line items (one per fee plan, plus one per one-off charge), but nothing
 * outside the office could see them: the parent portal, the printed statement, the CSV export and the
 * Fabric provider all read the invoice's LABEL and its total, so "Tuition — Feb 2027 · $250" was the
 * whole story a parent got when it was really $200 of tuition and a $50 book fee. A parent who wanted
 * to settle the book fee had no way to say so, and a kiosk had nothing to list.
 *
 * This module is the ONE place that turns an invoice into lines, so the portal, the kiosk, the donation
 * site, the statement and the office screens all describe a bill the same way (§16: one
 * implementation, thin callers).
 *
 * THE ARITHMETIC RULE, which every consumer depends on: for the lines of one invoice,
 * `sum(balanceCents)` equals that invoice's balance. Credit lines are what make that non-obvious — a
 * negative line (a bursary, a correction) is not something anyone pays, so rather than handing out a
 * negative balance for a consumer to mis-sum, its value is DEDUCTED from the lines above it and it
 * reports `balanceCents: 0`. Add up the lines and you get the bill; no special cases at the caller.
 *
 * The one place that rule is a CLAMP rather than an equality: a credit larger than everything it sits
 * with (a 100% bursary, a correction for an over-billed month) makes the invoice itself cost less than
 * nothing, and a line balance is never negative — so the lines sum to 0 while the invoice's own balance
 * is negative. The surplus is not lost: it is in the student's derived balance as credit, which is the
 * figure the parent sees and the ceiling on what autopay may charge. The clamp errs toward under-
 * charging, which is the only safe direction for money coming out of a card.
 */
import { asc, eq, inArray } from 'drizzle-orm';
import { invoiceItems, invoices, paymentAllocations } from '../db/schema';
import type { Tx } from './ledger';

/**
 * What KIND of thing a line is — the distinction a parent is looking for when they read a bill.
 *
 * Derived, not stored: a line that came from a fee plan carries its `feePlanId`, so tuition is exactly
 * "has a plan behind it". Everything else on an invoice arrived as a one-off charge, and a NEGATIVE
 * one-off charge is how this app expresses a discount or a correction — hence the sign check first.
 */
export type LineKind = 'tuition' | 'charge' | 'credit';

export interface PayableLine {
  itemId: string;
  invoiceId: string;
  studentId: string;
  /** The invoice this line sits on, e.g. "Tuition — Feb 2027" — the period a parent recognizes. */
  invoiceLabel: string;
  periodKey: string;
  dueDate: string | null;
  /** The line's own name: the fee plan's name, or the charge's label ("Book fee"). */
  label: string;
  kind: LineKind;
  /** What the line costs. Negative for a credit line. */
  amountCents: number;
  /** How much of it is already dealt with — by money, or by a credit line on the same invoice. */
  coveredCents: number;
  /** What is still owed on this line. Always ≥ 0; always 0 for a credit line. */
  balanceCents: number;
}

function kindOf(amountCents: number, feePlanId: string | null): LineKind {
  if (amountCents < 0) return 'credit';
  return feePlanId ? 'tuition' : 'charge';
}

/**
 * The lines of an invoice in ONE canonical order — tuition, then charges, then credits.
 *
 * This has to be explicit, and it has to be shared. Generation writes the fee lines and the charge
 * lines inside a single transaction with a SINGLE timestamp, so `ORDER BY created_at` alone leaves
 * rows tied and SQLite free to return them either way round: the same bill could show the book fee
 * above the tuition on one read and below it on the next. That is not just cosmetic, because the order
 * decides which line undirected money covers first — so the allocator in `reallocateStudent` orders by
 * this exact function too. If the two ever disagreed, the balances shown per line would not be the ones
 * the money actually landed on.
 *
 * Tuition first is the meaningful part: money with nothing said about it goes to the tuition before the
 * extras, which is what an office means by "he paid this month". `id` is the final tie-break purely so
 * the answer is stable.
 */
export function orderedItems(tx: Tx, invoiceId: string): { id: string; description: string; amountCents: number; feePlanId: string | null }[] {
  return tx
    .select({ id: invoiceItems.id, description: invoiceItems.description, amountCents: invoiceItems.amountCents, feePlanId: invoiceItems.feePlanId, createdAt: invoiceItems.createdAt })
    .from(invoiceItems)
    .where(eq(invoiceItems.invoiceId, invoiceId))
    .all()
    .sort((a, b) => {
      const rank = (r: { amountCents: number; feePlanId: string | null }) => (r.amountCents < 0 ? 2 : r.feePlanId ? 0 : 1);
      return rank(a) - rank(b) || a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
}

/**
 * The lines of ONE invoice, in the order they were written (fee lines first, then charges as they
 * were applied) — which is also the order money covers them in when nobody has said otherwise.
 *
 * Money reaches a line one of two ways. An allocation that names the line covers exactly that line —
 * this is how "I want to pay the book fee" survives (see `reallocateStudent`). Everything else — money
 * allocated to the invoice as a whole, including every allocation written before 0.43.0 — is spread
 * across the remaining lines in order, together with the value of any credit lines.
 */
export function invoiceLines(tx: Tx, invoiceId: string): PayableLine[] {
  const inv = tx.select({ id: invoices.id, studentId: invoices.studentId, label: invoices.label, periodKey: invoices.periodKey, dueDate: invoices.dueDate }).from(invoices).where(eq(invoices.id, invoiceId)).get();
  if (!inv) return [];

  const items = orderedItems(tx, invoiceId);

  const allocs = tx.select({ itemId: paymentAllocations.invoiceItemId, amountCents: paymentAllocations.amountCents }).from(paymentAllocations).where(eq(paymentAllocations.invoiceId, invoiceId)).all();
  const named = new Map<string, number>();
  /** Allocations that name no line: the invoice-level rows, which is all of them before 0.43.0. */
  let loose = 0;
  for (const a of allocs) {
    if (a.itemId) named.set(a.itemId, (named.get(a.itemId) ?? 0) + a.amountCents);
    else loose += a.amountCents;
  }

  // A credit line is money the school has already taken off this bill, so it covers the lines above
  // it exactly as a payment would. Pooling the two is what keeps `sum(balanceCents)` equal to the
  // invoice balance whichever way the reduction arrived.
  let pool = loose;
  for (const it of items) if (it.amountCents < 0) pool += -it.amountCents;
  if (pool < 0) pool = 0; // a reversal pair nets to zero; never let it push a line's balance up

  const out: PayableLine[] = [];
  const base = { invoiceId: inv.id, studentId: inv.studentId, invoiceLabel: inv.label, periodKey: inv.periodKey, dueDate: inv.dueDate };
  for (const it of items) {
    const kind = kindOf(it.amountCents, it.feePlanId);
    if (kind === 'credit') {
      out.push({ ...base, itemId: it.id, label: it.description, kind, amountCents: it.amountCents, coveredCents: -it.amountCents, balanceCents: 0 });
      continue;
    }
    // Named allocations first — capped at the line, so a stale or over-eager allocation can never
    // report a line as more than paid.
    let covered = Math.min(it.amountCents, Math.max(0, named.get(it.id) ?? 0));
    if (covered < it.amountCents && pool > 0) {
      const take = Math.min(it.amountCents - covered, pool);
      covered += take;
      pool -= take;
    }
    out.push({ ...base, itemId: it.id, label: it.description, kind, amountCents: it.amountCents, coveredCents: covered, balanceCents: it.amountCents - covered });
  }
  return out;
}

/**
 * Every line still owed by a set of students, oldest bill first — the "what is there to pay?" list
 * behind the kiosk, the donation site, the parent portal and the office's quick payment box.
 *
 * Settled lines and credit lines are dropped: this is a list of things to pay, and a paid book fee is
 * not one. Void invoices are excluded for the same reason the balance ignores them.
 */
export function payableLines(tx: Tx, studentIds: string[]): PayableLine[] {
  if (!studentIds.length) return [];
  // Same ordering rule as the ledger: due date first, NULLs last, then age. A consumer that renders
  // the list top-down is showing the parent the same priority the allocator uses.
  const ordered = tx
    .select({ id: invoices.id, status: invoices.status, dueDate: invoices.dueDate, createdAt: invoices.createdAt })
    .from(invoices)
    .where(inArray(invoices.studentId, studentIds))
    .all()
    .filter((i) => i.status === 'open' || i.status === 'partially_paid')
    .sort((a, b) => {
      if (a.dueDate !== b.dueDate) {
        if (a.dueDate === null) return 1;
        if (b.dueDate === null) return -1;
        return a.dueDate < b.dueDate ? -1 : 1;
      }
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

  const out: PayableLine[] = [];
  for (const inv of ordered) for (const l of invoiceLines(tx, inv.id)) if (l.balanceCents > 0) out.push(l);
  return out;
}

// (`linesByInvoice` lived here until 0.48.0 — a keyed-by-invoice wrapper for callers nesting lines under
// their invoices. Both of the callers it was written for ended up mapping `invoiceLines` themselves, which
// reads better at the call site, and nothing referenced it.)
