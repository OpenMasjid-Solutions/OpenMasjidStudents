// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * One month of one child's billing, as the year grid shows it (0.48.0).
 *
 * Extracted so the STAFF year view and the PARENT portal's year view are the same computation. They show
 * the same twelve squares about the same child, and a parent ringing the office about one of them has to
 * be looking at what the office is looking at — two copies of this logic would eventually disagree about
 * a month, and the office would have no way to tell which was right.
 *
 * The states, and why there are eight of them:
 *   paid / partial / open / void  — an invoice of ours exists; this is its state.
 *   none                          — no invoice, and there COULD be. A real gap, shown blank.
 *   before / settled / carried    — the month predates the first month this install bills, so it was
 *                                   never ours to bill. Which of the three depends on what the go-live
 *                                   step was told about that child, and on whether the bill it produced
 *                                   is still outstanding. See below.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { carryIns, invoices } from '../db/schema';
import { invoicePaid, invoiceTotal } from './ledger';
import { CARRY_IN_PERIOD } from './period';
import { getBillingStartPeriod } from '../settings';

export type YearCellStatus = 'paid' | 'partial' | 'open' | 'void' | 'none' | 'before' | 'settled' | 'carried';

export interface YearCell {
  periodKey: string;
  status: YearCellStatus;
  /** Present only when there is a real invoice behind the cell. */
  totalCents?: number;
  paidCents?: number;
  invoiceId?: string;
}

/**
 * The cells for each of `studentIds` across `months`, keyed by student id.
 *
 * Reads everything it needs in four queries regardless of how many children there are — a whole-school
 * grid is 200 rows × 12 months, and a query per cell would be 2,400 of them.
 */
export function yearCellsFor(studentIds: string[], months: string[]): Map<string, YearCell[]> {
  const out = new Map<string, YearCell[]>();
  if (!studentIds.length) return out;

  // One pass over the year's invoices → per (student, period) state. Per STUDENT, not per household:
  // billing has been per child since 0.39.0, so two siblings can legitimately differ in the same month.
  const byStudent = new Map<string, Map<string, { status: string; totalCents: number; paidCents: number; invoiceId: string }>>();
  if (months.length) {
    for (const inv of db
      .select({ id: invoices.id, studentId: invoices.studentId, periodKey: invoices.periodKey, status: invoices.status })
      .from(invoices)
      .where(and(inArray(invoices.studentId, studentIds), inArray(invoices.periodKey, months)))
      .all()) {
      if (!byStudent.has(inv.studentId)) byStudent.set(inv.studentId, new Map());
      byStudent.get(inv.studentId)!.set(inv.periodKey, {
        status: inv.status,
        totalCents: invoiceTotal(db, inv.id),
        paidCents: invoicePaid(db, inv.id),
        invoiceId: inv.id,
      });
    }
  }

  const startPeriod = getBillingStartPeriod();
  /** What the go-live step was told about each child, and whether its bill is still owed. */
  const saidPaidThrough = new Map<string, string | null>();
  const stillOwesCarryIn = new Set<string>();
  if (startPeriod) {
    for (const c of db
      .select({ studentId: carryIns.studentId, paidThrough: carryIns.paidThrough })
      .from(carryIns)
      .where(inArray(carryIns.studentId, studentIds))
      .all()) {
      saidPaidThrough.set(c.studentId, c.paidThrough);
    }
    // The POSITIVE test — "is anything outstanding" — not "was it paid off". A child recorded as behind
    // can have no carry-in invoice at all (per-term fees, or a waived one, means a monthly rate of zero,
    // so the wizard derived nothing to bill). Asking whether anything is owed answers that correctly;
    // asking whether it was settled would mark those months owed forever against money that never was.
    for (const inv of db
      .select({ id: invoices.id, studentId: invoices.studentId, status: invoices.status })
      .from(invoices)
      .where(and(inArray(invoices.studentId, studentIds), eq(invoices.periodKey, CARRY_IN_PERIOD)))
      .all()) {
      if (inv.status === 'void') continue;
      if (invoiceTotal(db, inv.id) - invoicePaid(db, inv.id) > 0) stillOwesCarryIn.add(inv.studentId);
    }
  }

  for (const studentId of studentIds) {
    const cells = byStudent.get(studentId);
    out.set(
      studentId,
      months.map((periodKey) => {
        const c = cells?.get(periodKey);
        if (c) {
          // A real invoice always wins, even in a pre-go-live month: one generated before the floor was
          // set is a fact about money and must not be painted over as "not ours".
          const status: YearCellStatus =
            c.status === 'void' ? 'void' : c.paidCents >= c.totalCents && c.totalCents > 0 ? 'paid' : c.paidCents > 0 ? 'partial' : 'open';
          return { periodKey, status, totalCents: c.totalCents, paidCents: c.paidCents, invoiceId: c.invoiceId };
        }
        if (!startPeriod || periodKey >= startPeriod) return { periodKey, status: 'none' as const };
        // A null `paidThrough` means NOTHING was said about this child, which is deliberately not the
        // same as "square" — the grid says "we don't know" rather than claiming a month was paid.
        const said = saidPaidThrough.get(studentId);
        if (!said) return { periodKey, status: 'before' as const };
        if (periodKey <= said) return { periodKey, status: 'settled' as const };
        return { periodKey, status: stillOwesCarryIn.has(studentId) ? ('carried' as const) : ('settled' as const) };
      }),
    );
  }
  return out;
}
