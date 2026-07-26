// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The ledger — the ONE money-write path (CLAUDE.md §16). Every payment (manual now; Fabric,
 * Stripe webhook, and autopay later) flows through `recordPayment`. Money is integer cents;
 * balances are DERIVED, never stored; payments are immutable (corrections are reversal rows).
 *
 * Allocation: a payment pays a family's open invoices oldest-due-first; any surplus becomes
 * family credit (unallocated). `idempotencyKey` is UNIQUE, so a replay returns the original.
 */
import { and, eq, asc, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import type { DB } from '../db';
import { invoices, invoiceItems, payments, paymentAllocations, autopayEnrollments } from '../db/schema';
import type { InvoiceStatus, PaymentChannel } from '../db/schema';
import { rid } from '../db/ids';

export type Tx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];
type Actor = { userId: string | null; role: string; name: string | null };

/** Sum of an invoice's line items (its total). */
export function invoiceTotal(tx: Tx, invoiceId: string): number {
  return tx.select({ a: invoiceItems.amountCents }).from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId)).all().reduce((s, r) => s + r.a, 0);
}
/** Sum of allocations against an invoice (nets reversals, which are negative). */
export function invoicePaid(tx: Tx, invoiceId: string): number {
  return tx.select({ a: paymentAllocations.amountCents }).from(paymentAllocations).where(eq(paymentAllocations.invoiceId, invoiceId)).all().reduce((s, r) => s + r.a, 0);
}

function statusFor(total: number, paid: number): InvoiceStatus {
  if (paid <= 0) return 'open';
  if (paid >= total) return 'paid';
  return 'partially_paid';
}

/** Recompute + persist an invoice's status from its total vs allocated (skips voided).
 *  Exported because appending a charge line changes an invoice's TOTAL, so its status has to be
 *  re-derived too — a charge added to a `paid` invoice correctly drops it to `partially_paid`. */
export function refreshStatus(tx: Tx, invoiceId: string): void {
  const inv = tx.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, invoiceId)).get();
  if (!inv || inv.status === 'void') return;
  tx.update(invoices).set({ status: statusFor(invoiceTotal(tx, invoiceId), invoicePaid(tx, invoiceId)), updatedAt: new Date() }).where(eq(invoices.id, invoiceId)).run();
}

export interface FamilyBalance {
  invoicedCents: number;
  paidCents: number;
  balanceCents: number; // > 0 owed, < 0 overpaid
  creditCents: number; // max(0, -balance)
  owedCents: number; // max(0, balance)
}

/** A family's derived balance: total invoiced (non-void) minus net payments. */
export function familyBalance(familyId: string): FamilyBalance {
  const invs = db.select({ id: invoices.id, status: invoices.status }).from(invoices).where(eq(invoices.familyId, familyId)).all();
  const liveIds = invs.filter((i) => i.status !== 'void').map((i) => i.id);
  const invoicedCents = liveIds.length ? db.select({ a: invoiceItems.amountCents }).from(invoiceItems).where(inArray(invoiceItems.invoiceId, liveIds)).all().reduce((s, r) => s + r.a, 0) : 0;
  const paidCents = db.select({ a: payments.amountCents }).from(payments).where(eq(payments.familyId, familyId)).all().reduce((s, r) => s + r.a, 0);
  const balanceCents = invoicedCents - paidCents;
  return { invoicedCents, paidCents, balanceCents, creditCents: balanceCents < 0 ? -balanceCents : 0, owedCents: balanceCents > 0 ? balanceCents : 0 };
}

export interface RecordInput {
  familyId: string;
  amountCents: number; // > 0
  channel: PaymentChannel;
  occurredAt: Date;
  idempotencyKey: string;
  memo?: string | null;
  externalRef?: Record<string, unknown> | null;
  /** Optional explicit allocation (Fabric/webhook); omitted → auto oldest-due-first. */
  allocations?: { invoiceId: string; amountCents: number }[];
}

/** Record a payment + allocate it. Idempotent on `idempotencyKey` (a replay returns the original). */
export function recordPayment(input: RecordInput, actor: Actor): { paymentId: string; duplicate: boolean; allocatedCents: number; creditCents: number } {
  const dup = db.select({ id: payments.id }).from(payments).where(eq(payments.idempotencyKey, input.idempotencyKey)).get();
  if (dup) {
    const allocated = db.select({ a: paymentAllocations.amountCents }).from(paymentAllocations).where(eq(paymentAllocations.paymentId, dup.id)).all().reduce((s, r) => s + r.a, 0);
    return { paymentId: dup.id, duplicate: true, allocatedCents: allocated, creditCents: input.amountCents - allocated };
  }
  if (input.amountCents <= 0) throw new Error('payment amount must be positive');

  const ts = new Date();
  const paymentId = rid('pay');
  let allocated = 0;
  db.transaction((tx) => {
    tx.insert(payments).values({ id: paymentId, familyId: input.familyId, amountCents: input.amountCents, channel: input.channel, occurredAt: input.occurredAt, memo: input.memo ?? null, idempotencyKey: input.idempotencyKey, externalRef: input.externalRef ?? null, reversalOf: null, recordedByUserId: actor.userId, recordedByName: actor.name, createdAt: ts }).run();

    if (input.allocations && input.allocations.length) {
      for (const a of input.allocations) {
        const inv = tx.select({ id: invoices.id, familyId: invoices.familyId, status: invoices.status }).from(invoices).where(eq(invoices.id, a.invoiceId)).get();
        // Same family, not void, within the invoice's remaining balance, and never exceeding
        // the payment total — an explicit allocation (Fabric/webhook) can't overpay a bill or
        // manufacture negative credit (§11.2).
        if (!inv || inv.familyId !== input.familyId || inv.status === 'void') throw new Error('invalid_allocation');
        if (a.amountCents <= 0) continue;
        const bal = invoiceTotal(tx, a.invoiceId) - invoicePaid(tx, a.invoiceId);
        if (a.amountCents > bal || allocated + a.amountCents > input.amountCents) throw new Error('invalid_allocation');
        tx.insert(paymentAllocations).values({ id: rid('pal'), paymentId, invoiceId: a.invoiceId, amountCents: a.amountCents, createdAt: ts }).run();
        allocated += a.amountCents;
        refreshStatus(tx, a.invoiceId);
      }
    } else {
      // Auto: oldest-due-first across the family's non-void invoices with a positive balance.
      const open = tx
        .select({ id: invoices.id, dueDate: invoices.dueDate, createdAt: invoices.createdAt })
        .from(invoices)
        .where(and(eq(invoices.familyId, input.familyId)))
        // Oldest-due-first. SQLite sorts NULL before any value, so an undated invoice would
        // otherwise jump the queue ahead of a genuinely-due one — push NULLs last (§11.2/§16).
        .orderBy(sql`${invoices.dueDate} is null`, asc(invoices.dueDate), asc(invoices.createdAt))
        .all();
      let remaining = input.amountCents;
      for (const inv of open) {
        if (remaining <= 0) break;
        const status = tx.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, inv.id)).get()?.status;
        if (status === 'void') continue;
        const bal = invoiceTotal(tx, inv.id) - invoicePaid(tx, inv.id);
        if (bal <= 0) continue;
        const amt = Math.min(remaining, bal);
        tx.insert(paymentAllocations).values({ id: rid('pal'), paymentId, invoiceId: inv.id, amountCents: amt, createdAt: ts }).run();
        remaining -= amt;
        allocated += amt;
        refreshStatus(tx, inv.id);
      }
    }
  });
  // A payment that clears the family's balance (via ANY channel — portal, manual, autopay, Fabric)
  // resets the autopay retry ladder: it tracks CONSECUTIVE failures against outstanding debt, so once
  // the debt is gone a fresh billing cycle must start at zero, not inherit a stale failure count that
  // could trip the auto-disable early (§13.3). A no-op for families without an autopay enrollment.
  if (familyBalance(input.familyId).owedCents === 0) {
    db.update(autopayEnrollments).set({ failureCount: 0, nextAttemptAt: null, updatedAt: new Date() }).where(eq(autopayEnrollments.familyId, input.familyId)).run();
  }
  return { paymentId, duplicate: false, allocatedCents: allocated, creditCents: input.amountCents - allocated };
}

/** Reverse a payment: a negative payment + negative allocations mirroring the original, so
 *  per-invoice paid nets to zero. Immutable — never edits/deletes the original (§9). */
export function reversePayment(paymentId: string, actor: Actor): { reversalId: string } {
  const orig = db.select().from(payments).where(eq(payments.id, paymentId)).get();
  if (!orig) throw new Error('payment not found');
  if (orig.reversalOf) throw new Error('cannot reverse a reversal');
  const already = db.select({ id: payments.id }).from(payments).where(eq(payments.reversalOf, paymentId)).get();
  if (already) return { reversalId: already.id };

  const ts = new Date();
  const reversalId = rid('pay');
  db.transaction((tx) => {
    tx.insert(payments).values({ id: reversalId, familyId: orig.familyId, amountCents: -orig.amountCents, channel: orig.channel, occurredAt: ts, memo: `Reversal of ${orig.id}`, idempotencyKey: `reversal:${orig.id}`, externalRef: null, reversalOf: orig.id, recordedByUserId: actor.userId, recordedByName: actor.name, createdAt: ts }).run();
    for (const a of tx.select().from(paymentAllocations).where(eq(paymentAllocations.paymentId, orig.id)).all()) {
      tx.insert(paymentAllocations).values({ id: rid('pal'), paymentId: reversalId, invoiceId: a.invoiceId, amountCents: -a.amountCents, createdAt: ts }).run();
      refreshStatus(tx, a.invoiceId);
    }
  });
  return { reversalId };
}
