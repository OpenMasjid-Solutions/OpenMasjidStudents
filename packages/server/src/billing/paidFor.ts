// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * WHAT a payment was for (0.48.0).
 *
 * The parent portal's history said who and how much — "Yusuf · Card · 3 Feb · $250" — and left the
 * parent to work out which bill that had settled. They cannot: a household paying monthly has a column
 * of identical amounts, and the one question asked down the phone is "so what's the February payment,
 * did that cover the books?". The app already knows, because `payment_allocations` records the invoice —
 * and the LINE — every cent landed on. It was simply never read back out.
 *
 * THE INVOICE LEADS, NOT THE LINE. Allocation has been per-line since 0.43.0, so nearly every row names
 * an `invoice_item`: reading those out gives "Monthly tuition · Book fee", which says what KIND of thing
 * was paid and loses the only part the parent asked about — WHICH MONTH. So each invoice contributes its
 * own label ("Tuition — Feb 2027"), and the lines are named only when the payment covered SOME of that
 * invoice rather than all of it, which is exactly the case where the parent chose lines and needs to see
 * which ones. A whole-invoice payment needs no line list; it paid the bill.
 *
 * THE ANSWER IS DERIVED, like every other balance (§9). Nothing is stored on the payment: allocations are
 * recomputed whenever an invoice or charge changes (`ledger.reallocateStudent`), so a stored description
 * would go stale the moment a bill was voided or a carry-in appeared. Reading it live means the history
 * says what the money is doing NOW, which is the only version worth showing.
 *
 * MONEY ALLOCATED TO NOTHING is not an error and must not render as a blank: it is paid ahead of any bill,
 * sitting as credit on the child's record. Saying so is the difference between a parent trusting the
 * figure and ringing the office.
 */
import { inArray } from 'drizzle-orm';
import type { Tx } from './ledger';
import { paymentAllocations, invoices, invoiceItems } from '../db/schema';

/** What one payment settled. `more` is how many further entries were left out, so a long list is
 *  truncated visibly rather than silently. */
export interface PaidFor {
  /** Human labels, biggest share first — "Tuition — Feb 2027", or "Tuition — Feb 2027 · Book fee" when
   *  only part of that bill was paid. */
  labels: string[];
  more: number;
  /** True when the payment is allocated to nothing at all: money paid ahead, sitting as credit. */
  advance: boolean;
}

/** Enough to tell a parent what happened without turning one row into a paragraph. */
const MAX_LABELS = 3;
/** Lines named within one bill before it stops being a summary. */
const MAX_LINES = 2;

/**
 * For each payment id, what it was for.
 *
 * Batched over the whole history in three queries rather than per row: the portal home renders 25 of
 * these per household, and a per-row lookup would be 75 round trips for one page.
 */
export function paidForByPayment(tx: Tx, paymentIds: string[]): Map<string, PaidFor> {
  const out = new Map<string, PaidFor>();
  for (const id of paymentIds) out.set(id, { labels: [], more: 0, advance: true });
  if (!paymentIds.length) return out;

  const allocs = tx
    .select({
      paymentId: paymentAllocations.paymentId,
      invoiceId: paymentAllocations.invoiceId,
      invoiceItemId: paymentAllocations.invoiceItemId,
      amountCents: paymentAllocations.amountCents,
    })
    .from(paymentAllocations)
    .where(inArray(paymentAllocations.paymentId, paymentIds))
    .all();
  if (!allocs.length) return out;

  const invoiceIds = [...new Set(allocs.map((a) => a.invoiceId))];
  const invoiceLabel = new Map(
    tx.select({ id: invoices.id, label: invoices.label }).from(invoices).where(inArray(invoices.id, invoiceIds)).all().map((i) => [i.id, i.label]),
  );
  // Every line of every invoice involved — needed to tell "paid the bill" from "paid part of it", which
  // is what decides whether the lines are worth naming.
  const itemLabel = new Map<string, string>();
  const itemsPerInvoice = new Map<string, number>();
  for (const r of tx.select({ id: invoiceItems.id, invoiceId: invoiceItems.invoiceId, description: invoiceItems.description }).from(invoiceItems).where(inArray(invoiceItems.invoiceId, invoiceIds)).all()) {
    itemLabel.set(r.id, r.description);
    itemsPerInvoice.set(r.invoiceId, (itemsPerInvoice.get(r.invoiceId) ?? 0) + 1);
  }

  const byPayment = new Map<string, typeof allocs>();
  for (const a of allocs) byPayment.set(a.paymentId, [...(byPayment.get(a.paymentId) ?? []), a]);

  for (const [paymentId, rows] of byPayment) {
    /** Per invoice: how much of this payment went to it, and which of its lines. */
    const perInvoice = new Map<string, { amount: number; items: string[] }>();
    for (const a of rows) {
      const e = perInvoice.get(a.invoiceId) ?? { amount: 0, items: [] };
      e.amount += Math.abs(a.amountCents);
      // A null item is a pre-0.43.0 row meaning "the invoice as a whole"; it contributes no line name,
      // which correctly leaves that invoice described by its own label alone.
      if (a.invoiceItemId && !e.items.includes(a.invoiceItemId)) e.items.push(a.invoiceItemId);
      perInvoice.set(a.invoiceId, e);
    }

    // Biggest share first, so a payment spread over several bills leads with the one it mostly went to and
    // anything truncated is the least of it.
    const ordered = [...perInvoice.entries()].sort((a, b) => b[1].amount - a[1].amount);
    const labels: string[] = [];
    for (const [invoiceId, e] of ordered) {
      const base = invoiceLabel.get(invoiceId);
      if (!base) continue; // an invoice that vanished under a live allocation would be a bug, not a label
      const total = itemsPerInvoice.get(invoiceId) ?? 0;
      // Only when the payment covered PART of the bill: naming every line of a bill that was paid in full
      // adds length and no information.
      const partial = e.items.length > 0 && e.items.length < total;
      const lines = partial ? e.items.map((id) => itemLabel.get(id)).filter((v): v is string => !!v) : [];
      const shown = lines.slice(0, MAX_LINES);
      const hidden = lines.length - shown.length;
      labels.push(
        shown.length
          ? `${base} · ${shown.join(', ')}${hidden > 0 ? ` +${hidden}` : ''}`
          : base,
      );
    }

    out.set(paymentId, {
      labels: labels.slice(0, MAX_LABELS),
      more: Math.max(0, labels.length - MAX_LABELS),
      // Allocation rows exist, so this money is doing something — never "paid ahead".
      advance: false,
    });
  }
  return out;
}
