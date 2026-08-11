// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * A student who joins part-way through the year (0.48.0).
 *
 * THE PROBLEM. `studentAdd` creates a child and their fee plan and no invoices at all, and
 * `generateForPeriod` bills whoever is active WHEN IT RUNS. So a child added in February is billed from
 * the next generation onward, and every month already generated silently skips them. That is right for a
 * child who genuinely started in February and wrong for one who has been attending since October — and
 * nothing on the screen said which of the two had just happened.
 *
 * So the add form asks, and this is what the answer does. It is a BACKFILL, not a stored rule: there is
 * no "billing starts in October" column anywhere, because that would be a second source of truth about
 * what a child owes, sitting beside the invoices that actually decide it (§9 — balances are derived).
 * Choosing October creates October's, November's, December's, January's and February's invoices, and from
 * then on this child is billed by the same nightly run as everybody else.
 *
 * THREE DECISIONS, all Hasan's:
 *
 *  1. ONE INVOICE PER MONTH, not one combined catch-up line. The year view is a column per month and
 *     reads real invoices, so a single "Oct–Jan" invoice would leave those four squares showing as never
 *     billed — which is exactly the question the grid exists to answer.
 *  2. ONE DUE DATE, TODAY, for all of them. Dating October's invoice in October is truthful and would
 *     make the family five months overdue the instant their child is added — enough to send the new
 *     past-due reminder to somebody who has not yet been told they owe anything (billing/pastDue.ts).
 *     They owe the same amount either way; this only decides whether they are treated as late for it.
 *  3. MONTHS COME FROM THE SCHOOL YEAR, never from the calendar. A madrasah teaching September to June
 *     does not bill July, so a July invoice must not appear in a catch-up just because it lies between
 *     the start month and today.
 *
 * The `billing_start_period` floor (§9 — a mid-year adoption records its arrears ONCE, as a carry-in)
 * applies here as it does everywhere: anything earlier is already in that carried-forward figure, and
 * billing it again would charge it twice.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { schoolYears, students } from '../db/schema';
import { generateForStudent } from './invoices';
import { isMonthPeriod, resolveInvoiceLabel } from './period';
import { schoolYearMonths } from './schoolYear';
import { getBillingStartPeriod, getInvoiceLabelTemplate } from '../settings';

/** Today as a period key, in UTC — the same basis the schedulers use. */
export function currentPeriod(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** How far back to offer months when no school year says which months are taught. A year of catch-up is
 *  more than any madrasah needs mid-year, and the billing floor usually cuts it shorter anyway. */
const FALLBACK_MONTHS_BACK = 12;

/** The last `n` months ending with the current one, oldest first. */
function recentMonths(n: number, now: Date): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/**
 * The months an office may start a new student's billing from: this school year's own months, no earlier
 * than the install's billing floor, and no later than the month we are in.
 *
 * FUTURE MONTHS ARE DELIBERATELY ABSENT. There is nothing to create for a month that has not happened,
 * and the normal monthly run will bill this child when it arrives — so offering "April" would look like a
 * promise to start then, which nothing here enforces. "Not yet" already means exactly that.
 *
 * WITH NO SCHOOL YEAR SET UP, this falls back to a window of recent calendar months rather than returning
 * nothing. That is not a nicety: it returned an empty list, the add form hid the field entirely, and the
 * one install guaranteed to have no school year yet is a NEW one — which is exactly when an office is
 * adding students and most likely to need a catch-up. `invoiceMonthOptions` in trpc/billing.ts has always
 * had the same fallback for the same reason; this one was missing it.
 */
export function billFromMonths(schoolId: string | null, now = new Date()): { periodKey: string; label: string }[] {
  const year = db
    .select()
    .from(schoolYears)
    .where(schoolId ? and(eq(schoolYears.isCurrent, true), eq(schoolYears.schoolId, schoolId)) : eq(schoolYears.isCurrent, true))
    .get();
  const floor = getBillingStartPeriod();
  const today = currentPeriod(now);
  const keys =
    year && year.startYear != null
      ? schoolYearMonths(year.startYear, year.startMonth, year.endMonth).map((m) => m.periodKey)
      : recentMonths(FALLBACK_MONTHS_BACK, now);
  return keys
    .filter((k) => k <= today && (!floor || k >= floor))
    .map((k) => ({ periodKey: k, label: resolveInvoiceLabel('[month] [year]', k) }));
}

export interface JoinResult {
  created: number;
  /** The months actually billed, oldest first — what the caller reports back to the office. */
  periods: string[];
  /** Why nothing happened, when nothing did. */
  reason?: 'not_a_month' | 'before_floor' | 'no_school_year' | 'future' | 'nothing_to_bill';
}

/**
 * Bill one student from `fromPeriod` up to the current month, one invoice per month.
 *
 * Idempotent by construction: `generateForStudent` no-ops on a month this student already has an invoice
 * for (UNIQUE on student + period), so running it twice cannot double-bill, and a student who was
 * already billed for some of the range only gains the missing months.
 */
export function billStudentFrom(studentId: string, fromPeriod: string, now = new Date()): JoinResult {
  if (!isMonthPeriod(fromPeriod)) return { created: 0, periods: [], reason: 'not_a_month' };

  const floor = getBillingStartPeriod();
  if (floor && fromPeriod < floor) return { created: 0, periods: [], reason: 'before_floor' };

  const today = currentPeriod(now);
  if (fromPeriod > today) return { created: 0, periods: [], reason: 'future' };

  const student = db.select({ schoolId: students.schoolId }).from(students).where(eq(students.id, studentId)).get();
  const months = billFromMonths(student?.schoolId ?? null, now).filter((m) => m.periodKey >= fromPeriod);
  // Only reachable now if the chosen month is outside the offered window entirely — with no school year
  // the fallback above always yields at least the current month.
  if (!months.length) return { created: 0, periods: [], reason: 'no_school_year' };

  // One date for the whole catch-up: they are being told about all of it today (decision 2 above).
  const dueDate = now.toISOString().slice(0, 10);
  const template = getInvoiceLabelTemplate();

  const periods: string[] = [];
  let created = 0;
  for (const m of months) {
    const r = generateForStudent(studentId, {
      periodKey: m.periodKey,
      label: resolveInvoiceLabel(template, m.periodKey),
      dueDate,
    });
    if (r.created) {
      created++;
      periods.push(m.periodKey);
    }
  }
  // A child on nothing but a per-term or one-time plan has no monthly line to bill, so `generateForStudent`
  // correctly writes no empty invoices — worth saying out loud rather than reporting a silent success.
  return created ? { created, periods } : { created: 0, periods: [], reason: 'nothing_to_bill' };
}

/** Every student the given ids refer to that actually exists — used to keep the caller honest. */
export function existingStudentIds(ids: string[]): string[] {
  if (!ids.length) return [];
  return db.select({ id: students.id }).from(students).where(inArray(students.id, ids)).all().map((r) => r.id);
}
