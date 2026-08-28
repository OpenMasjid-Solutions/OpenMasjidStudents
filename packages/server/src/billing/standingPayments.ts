// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * STANDING PAYMENTS — autopay for money that never touches Stripe (0.51.0-dev.15).
 *
 * A family hands over cash on the first of every month, or sends a bank transfer, and the office was
 * keying the same payment in twelve times a year. So an arrangement is set on the child's billing record —
 * channel and day — and on that day this records it.
 *
 * ── IT ASSERTS THAT MONEY ARRIVED. READ THIS BEFORE CHANGING ANYTHING ────────
 *
 * That is the whole nature of the feature and it was a deliberate choice, taken over a confirm-first queue
 * that would have recorded nothing until a person clicked. It means the ledger can say PAID for cash that
 * was never handed over: the family drops off the past-due chase, their statement reads settled, and the
 * outstanding total is wrong until somebody reconciles the cash box by hand. An office turning this on is
 * saying "I trust this family to pay, and I would rather fix the exception than type the rule".
 *
 * TWO RULES KEEP IT FROM BECOMING A FICTION, and neither is optional:
 *
 *  1. **THE AMOUNT IS WHAT IS OWED ON THE DAY.** Never a figure stored on the arrangement. This is the
 *     rule that matters most: a stored $200 recorded against a $150 bill would mint $50 of credit out of
 *     nothing, month after month, and credit is absorbed silently by the next invoice (§9) — so the error
 *     would compound with no screen ever showing it. Owing nothing therefore records nothing, which is
 *     also the correct answer for a family who paid another way this month.
 *  2. **`payments.idempotency_key` IS `standing:<student>:<period>`, AND THAT COLUMN IS UNIQUE.** The
 *     idempotency is the DATABASE's, not a marker we keep: a re-run, a container restarted through the
 *     scheduled minute, or two schedulers cannot record the same month twice. `lastPeriod` on the row is
 *     for the screen only — relying on it would be exactly the "trust a stored number" mistake §6 warns
 *     about.
 *
 * WHAT MAKES IT SURVIVABLE WHEN IT IS WRONG. Every payment it writes is an ordinary manual-channel payment
 * on the ordinary ledger path, so `billing.reversePayment` reverses it like any other and the mirror rows
 * put the bill back. It is stamped `recorded_by_name = 'Standing arrangement'` rather than a person's name,
 * so the office reading "who took this cash?" can tell the app from a colleague — which is precisely the
 * distinction `recordingActor` exists to draw (§9).
 */
import { and, eq, inArray, lte, ne } from 'drizzle-orm';
import { db } from '../db';
import { invoices, payments, standingPayments, students, type ManualPaymentChannel } from '../db/schema';
import { invoicePaid, invoiceTotal, recordPayment, studentBalance } from './ledger';
import { makeLog } from '../logger';

const log = makeLog('standing');

/** The name stamped on the payment row, so the office can tell the app from a colleague. */
export const STANDING_ACTOR = 'Standing arrangement';

/** `YYYY-MM` for a date, in UTC — the same basis every other scheduled job uses. */
function periodOf(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface StandingDue {
  studentId: string;
  channel: ManualPaymentChannel;
  amountCents: number;
  memo: string | null;
}

/**
 * What is OWED by one student right now, and therefore what a standing arrangement would record.
 *
 * The sum of their own invoice balances that are actually due, capped by what the ledger says they owe —
 * the same two-part rule autopay uses (`amountDue` in payments/autopay.ts), and capped for the same
 * reason: a credit line larger than its invoice, or money already paid ahead, would otherwise be recorded
 * again as though owed.
 *
 * Deliberately NOT shared with autopay's version even though the shape rhymes: that one sums a whole
 * FAMILY for one card charge, this one is a single student, and collapsing them into a
 * `dueFor(scope)` helper would put a family-vs-student switch inside the one calculation neither caller
 * would want to get wrong.
 */
export function owedNow(studentId: string, today: string): number {
  const open = db
    .select({ id: invoices.id, dueDate: invoices.dueDate })
    .from(invoices)
    .where(and(eq(invoices.studentId, studentId), inArray(invoices.status, ['open', 'partially_paid'])))
    .all();
  let due = 0;
  for (const i of open) {
    if (!i.dueDate || i.dueDate > today) continue; // not due yet
    const bal = invoiceTotal(db, i.id) - invoicePaid(db, i.id);
    if (bal > 0) due += bal;
  }
  // THEIR OWN derived balance is the ceiling, not the household's — this money lands on one child, and a
  // sibling's arrears are not this student's to have paid.
  return Math.min(due, studentBalance(studentId).owedCents);
}

/**
 * The arrangements that should record today: enabled, their day has arrived this month, and the student is
 * still active. Pure enough to test — it computes, it does not write.
 *
 * THE DAY IS `<=`, NOT `===`, on purpose. A container that is down on the 1st would otherwise skip the
 * month entirely and silently; catching up on the 2nd is the same behavior every other job here has, and
 * the UNIQUE payment key is what stops the later day recording a second time.
 */
export function standingDue(today: Date): StandingDue[] {
  const day = today.getUTCDate();
  const iso = today.toISOString().slice(0, 10);
  const period = periodOf(today);

  const rows = db
    .select({
      studentId: standingPayments.studentId,
      channel: standingPayments.channel,
      dayOfMonth: standingPayments.dayOfMonth,
      memo: standingPayments.memo,
      status: students.status,
    })
    .from(standingPayments)
    .innerJoin(students, eq(students.id, standingPayments.studentId))
    .where(and(eq(standingPayments.enabled, true), lte(standingPayments.dayOfMonth, day), ne(students.status, 'withdrawn')))
    .all();

  const out: StandingDue[] = [];
  for (const r of rows) {
    // Already recorded for this month? The UNIQUE key is the real guard, but checking first keeps the
    // scheduler quiet and lets the preview screen show the truth.
    const key = standingKey(r.studentId, period);
    if (db.select({ id: payments.id }).from(payments).where(eq(payments.idempotencyKey, key)).get()) continue;
    const amountCents = owedNow(r.studentId, iso);
    if (amountCents <= 0) continue; // nothing owed — nothing to record, which is the honest answer
    out.push({ studentId: r.studentId, channel: r.channel, amountCents, memo: r.memo });
  }
  return out;
}

/** The one spelling of the key. UNIQUE on `payments`, so this IS the idempotency (see the header). */
export function standingKey(studentId: string, period: string): string {
  return `standing:${studentId}:${period}`;
}

/**
 * The next date this arrangement would run: this month's day if it has not passed, otherwise next month's.
 *
 * Exists because the SCREEN's question is not "what is owed today" (0.51.0-dev.15). An office setting an
 * arrangement up on the 24th of August, for a bill due on the 1st of September, was shown "nothing is owed
 * right now, so nothing would be recorded" — which is true of today and reads exactly like a broken
 * feature. The useful answer is what it would record on the day it actually runs, so the panel asks for
 * that instead. Found by a test that expected the useful answer and got the literal one.
 */
export function nextRunDate(dayOfMonth: number, now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const day = Math.min(Math.max(dayOfMonth, 1), 28);
  const thisMonth = new Date(Date.UTC(y, m, day));
  if (now.getUTCDate() <= day) return thisMonth.toISOString().slice(0, 10);
  return new Date(Date.UTC(y, m + 1, day)).toISOString().slice(0, 10);
}

/** Record today's standing payments. Best-effort per student: one family's problem must not stop the rest. */
export function runStanding(today = new Date()): { recorded: number; amountCents: number; skipped: number } {
  const due = standingDue(today);
  const period = periodOf(today);
  let recorded = 0;
  let amountCents = 0;
  let skipped = 0;

  for (const d of due) {
    try {
      recordPayment(
        {
          studentId: d.studentId,
          amountCents: d.amountCents,
          channel: d.channel,
          occurredAt: today,
          idempotencyKey: standingKey(d.studentId, period),
          memo: d.memo,
        },
        // Not a person. The office reads this back asking who took the money, and the honest answer is
        // that the app did, on a standing arrangement they set up (§9).
        { userId: null, role: 'system', name: STANDING_ACTOR },
      );
      db.update(standingPayments).set({ lastPeriod: period, updatedAt: new Date() }).where(eq(standingPayments.studentId, d.studentId)).run();
      recorded++;
      amountCents += d.amountCents;
    } catch (e) {
      skipped++;
      log.warn('standing payment failed', { error: (e as Error).message });
    }
  }
  if (recorded) log.info('standing payments recorded', { recorded, amountCents });
  return { recorded, amountCents, skipped };
}
