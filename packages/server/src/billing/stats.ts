// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The madrasah's tuition position, in one screenful — the numbers an admin wants when they are not at
 * a desk (0.50.0-dev.15).
 *
 * Written for the WhatsApp `stats` command (`fabric/commands.ts`), and deliberately NOT inside it: a
 * command handler is an HTTP shell with a ten-second budget, and the arithmetic here is worth testing
 * without one. A future dashboard tile wants exactly this too, and deriving it twice is how two
 * screens end up disagreeing about what a masjid is owed (CLAUDE.md §16).
 *
 * EVERYTHING IS AN AGGREGATE, ON PURPOSE. Alerts name children now (§9) because they go to addresses
 * and numbers an admin configured, one event at a time. A command reply is different: it lands in a
 * WhatsApp thread that keeps a copy forever, on whichever phone is authorised today, and the platform
 * refuses to expose app logs for precisely that reason. So this counts and totals; it never lists who.
 * "Who is behind" is a question for a screen behind a login, or the past-due digest that already goes
 * to people the office chose.
 *
 * OWED AND CREDIT ARE SUMMED PER STUDENT, never netted install-wide. One child owing $100 while
 * another sits on $100 of credit is a madrasah with $100 outstanding, not a square one — netting would
 * report the second thing and quietly hide real arrears.
 */

import { and, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import { db } from '../db';
import { autopayEnrollments, families, invoiceItems, invoices, payments, students } from '../db/schema';
import { getCurrency } from '../settings';
import { periodOf } from './period';
import { pastDueFamilies, studentsBehind } from './pastDue';
import { reconcileStatus } from '../payments/reconcile';

export interface TuitionStats {
  /** The day this was computed for, ISO — passed in, never read from the clock, so a test and the job
   *  and a preview all see the same numbers (the rule `pastDueFamilies` already follows). */
  asOf: string;
  currency: string;
  /** The current billing period's key, e.g. `2026-08` — what "this month" below means. */
  periodKey: string;

  activeStudents: number;
  households: number;

  /** Net money dated inside the current calendar month. A reversal is a negative row dated when it was
   *  reversed, so a payment taken and reversed in the same month correctly nets to nothing here. */
  collectedThisMonthCents: number;
  paymentsThisMonth: number;
  /** Invoiced for the current period — the bill the month asked for, against what came in. */
  billedThisPeriodCents: number;

  /** Summed per student. See the header: never netted against other students' credit. */
  outstandingCents: number;
  creditCents: number;

  pastDueStudents: number;
  pastDueCents: number;

  autopayHouseholds: number;
  /** When the Stripe safety net last ran, ISO — null if it never has on this install. */
  lastReconcileAt: string | null;
}

/** First day of `asOf`'s calendar month, ISO. Text comparison, like every other date here (§9). */
function monthStart(asOf: string): string {
  return `${asOf.slice(0, 7)}-01`;
}

/** First day of the month AFTER `asOf`'s, ISO — the exclusive upper bound. */
function nextMonthStart(asOf: string): string {
  const y = Number(asOf.slice(0, 4));
  const m = Number(asOf.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

export function tuitionStats(asOf: string): TuitionStats {
  const currency = getCurrency();
  // `asOf` is an ISO day; the period is its year-month. Derived from the string rather than a Date so
  // no timezone can move it to the neighbouring month (§9 — every date here is compared as text).
  const periodKey = periodOf(new Date(`${asOf}T12:00:00.000Z`));

  const activeStudents = db.select({ n: sql<number>`count(*)` }).from(students).where(eq(students.status, 'active')).get()?.n ?? 0;
  const households = db.select({ n: sql<number>`count(*)` }).from(families).where(eq(families.status, 'active')).get()?.n ?? 0;

  // `occurredAt` is a timestamp column, so the window is compared as one. The bounds are the first
  // instant of this month and the first of next — half-open, so a payment at 23:59 on the last day is
  // inside it and one at 00:00 on the 1st is not counted twice.
  const from = new Date(`${monthStart(asOf)}T00:00:00.000Z`);
  const to = new Date(`${nextMonthStart(asOf)}T00:00:00.000Z`);
  const monthRows = db
    .select({ a: payments.amountCents })
    .from(payments)
    .where(and(gte(payments.occurredAt, from), lt(payments.occurredAt, to)))
    .all();
  const collectedThisMonthCents = monthRows.reduce((s, r) => s + r.a, 0);

  const periodInvoices = db
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.periodKey, periodKey), ne(invoices.status, 'void')))
    .all()
    .map((i) => i.id);
  const billedThisPeriodCents = periodInvoices.length
    ? db.select({ a: invoiceItems.amountCents }).from(invoiceItems).where(inArray(invoiceItems.invoiceId, periodInvoices)).all().reduce((s, r) => s + r.a, 0)
    : 0;

  // Per student, in two passes rather than one query per child: a madrasah of 300 would otherwise pay
  // 600 round trips for a single message. Withdrawn children are INCLUDED — an unpaid bill survives a
  // child leaving, and scoping this to active would quietly write real debt off (the rule
  // `familyStudentIds` states).
  const liveInvoices = db
    .select({ id: invoices.id, studentId: invoices.studentId })
    .from(invoices)
    .where(ne(invoices.status, 'void'))
    .all();
  const invoicedByStudent = new Map<string, number>();
  if (liveInvoices.length) {
    const owner = new Map(liveInvoices.map((i) => [i.id, i.studentId]));
    for (const it of db.select({ invoiceId: invoiceItems.invoiceId, a: invoiceItems.amountCents }).from(invoiceItems).all()) {
      const sid = owner.get(it.invoiceId);
      if (sid) invoicedByStudent.set(sid, (invoicedByStudent.get(sid) ?? 0) + it.a);
    }
  }
  const paidByStudent = new Map<string, number>();
  for (const p of db.select({ studentId: payments.studentId, a: payments.amountCents }).from(payments).all()) {
    paidByStudent.set(p.studentId, (paidByStudent.get(p.studentId) ?? 0) + p.a);
  }
  let outstandingCents = 0;
  let creditCents = 0;
  for (const sid of new Set([...invoicedByStudent.keys(), ...paidByStudent.keys()])) {
    const bal = (invoicedByStudent.get(sid) ?? 0) - (paidByStudent.get(sid) ?? 0);
    if (bal > 0) outstandingCents += bal;
    else if (bal < 0) creditCents += -bal;
  }

  // The same derivation the digest and the parent reminders use, so three places cannot disagree about
  // who is late. Every overdue child, not only those past the grace period: this is a readout, and an
  // office asking "how are we doing" means all of it.
  const behind = studentsBehind(pastDueFamilies(asOf));

  const autopayHouseholds = db.select({ n: sql<number>`count(*)` }).from(autopayEnrollments).where(eq(autopayEnrollments.enabled, true)).get()?.n ?? 0;

  return {
    asOf,
    currency,
    periodKey,
    activeStudents,
    households,
    collectedThisMonthCents,
    paymentsThisMonth: monthRows.length,
    billedThisPeriodCents,
    outstandingCents,
    creditCents,
    pastDueStudents: behind.length,
    pastDueCents: behind.reduce((s, b) => s + b.amountCents, 0),
    autopayHouseholds,
    lastReconcileAt: reconcileStatus()?.ranAt ?? null,
  };
}
