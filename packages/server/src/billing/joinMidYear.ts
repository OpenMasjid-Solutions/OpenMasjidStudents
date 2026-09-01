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
import { charges, invoices, schoolYears, students } from '../db/schema';
import { rid } from '../db/ids';
import { invoiceTotal } from './ledger';
import { attachChargeToExistingInvoice, generateForStudent } from './invoices';
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

/**
 * `n` months ending at `endKey`, oldest first.
 *
 * Ends at the HORIZON rather than at today, because the horizon can be a month ahead: an install whose
 * go-live is September, asked in August, must still be offered September. Walking back from the end is what
 * makes that fall out of one calculation instead of two.
 */
function monthsEndingAt(endKey: string, n: number): string[] {
  const [y, m] = endKey.split('-').map(Number);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
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
 * THE LIST FALLS BACK TO RECENT CALENDAR MONTHS whenever the school year yields none, and that covers two
 * real installs, both of which hid the field completely:
 *
 *   • NO SCHOOL YEAR AT ALL — a brand-new install, which is exactly when an office is entering a roster
 *     and most likely to need a catch-up.
 *   • A CURRENT YEAR THAT HAS NOT STARTED YET. In August, a 2026-27 year running September to June has
 *     every one of its months in the future, so filtering to "no later than this month" left nothing. An
 *     install that had been set up properly therefore showed FEWER options than one that had not, which is
 *     how this was found: the field appeared on a fresh install and not on the real one.
 *
 * `invoiceMonthOptions` in trpc/billing.ts has always had the same fallback; this one was missing it.
 *
 * THE GO-LIVE MONTH IS ALWAYS OFFERED, even when it is still in the future. A madrasah that ran the
 * mid-year step in August and said "we bill from September" had NOTHING offered at all: no month can be
 * both no-later-than-August and no-earlier-than-September. But September is the first month that install
 * will ever bill, so it is precisely the month an office wants to name for a child enrolling now. Choosing
 * it creates no invoice yet — September has not happened — and the form says exactly that rather than
 * implying otherwise; the September run then bills them with everybody else.
 *
 * It can still come back empty (a floor further out than the month after next, say). The form handles that
 * by saying so rather than by hiding the field, which is the other half of the fix.
 */
export function billFromMonths(schoolId: string | null, now = new Date()): { periodKey: string; label: string }[] {
  const year = db
    .select()
    .from(schoolYears)
    .where(schoolId ? and(eq(schoolYears.isCurrent, true), eq(schoolYears.schoolId, schoolId)) : eq(schoolYears.isCurrent, true))
    .get();
  const floor = getBillingStartPeriod();
  const today = currentPeriod(now);
  // How far forward to look: this month, or the go-live month when that is still ahead of us.
  const horizon = floor && floor > today ? floor : today;
  const eligible = (keys: string[]) => keys.filter((k) => k <= horizon && (!floor || k >= floor));

  const fromYear =
    year && year.startYear != null ? eligible(schoolYearMonths(year.startYear, year.startMonth, year.endMonth).map((m) => m.periodKey)) : [];
  const keys = fromYear.length ? fromYear : eligible(monthsEndingAt(horizon, FALLBACK_MONTHS_BACK));
  return keys.map((k) => ({ periodKey: k, label: resolveInvoiceLabel('[month] [year]', k) }));
}

export interface JoinResult {
  created: number;
  /** The months actually billed, oldest first — what the caller reports back to the office. */
  periods: string[];
  /** Why nothing happened, when nothing did. */
  reason?: 'not_a_month' | 'before_floor' | 'no_school_year' | 'future' | 'nothing_to_bill';
  /** Whether the first month was brought to an agreed figure (0.51.0-dev.11). False when none was asked
   *  for, when it already matched, or when that month was not one this call created. */
  firstMonthAdjusted?: boolean;
}

/**
 * Bill one student from `fromPeriod` up to the current month, one invoice per month.
 *
 * Idempotent by construction: `generateForStudent` no-ops on a month this student already has an invoice
 * for (UNIQUE on student + period), so running it twice cannot double-bill, and a student who was
 * already billed for some of the range only gains the missing months.
 */
/**
 * Bring the FIRST month of a catch-up to a stated amount (0.51.0-dev.11).
 *
 * A child who starts on the 15th is often charged part of that month, and sometimes an office simply
 * agrees a different figure for it. The rest of the year is the plan's own amount, so this is about ONE
 * invoice, which is why it is not a per-student override (that would change every month) and not a new
 * fee plan (a plan per joining date is a catalog nobody can read).
 *
 * DONE AS AN ADJUSTMENT LINE, not by rewriting the tuition line. Two reasons, and the second is the one
 * that decided it:
 *
 *  1. It is honest on paper. The invoice reads "Monthly tuition $100" then "Joined part-way through the
 *     month −$40", which is a bill a parent can check against what they were told. A single silently
 *     reduced line invites "why is this one different?" at the exact moment trust is being established.
 *  2. It keeps ONE place writing money. The adjustment is an ordinary charge (§4 — a negative charge is
 *     how a credit or correction is expressed) attached by the ordinary path, so it allocates, re-derives
 *     and reverses exactly like everything else. Teaching `generateForStudent` to take an amount override
 *     would put a second answer to "what is this line worth?" inside the generator.
 *
 * Works upward too: if the agreed figure is HIGHER than the plan, the adjustment is positive. And it is
 * a no-op when the figure already matches, so an office confirming the normal amount writes no line.
 */
function adjustFirstMonth(studentId: string, periodKey: string, targetCents: number, ts: Date): boolean {
  const inv = db.select({ id: invoices.id, status: invoices.status }).from(invoices).where(and(eq(invoices.studentId, studentId), eq(invoices.periodKey, periodKey))).get();
  if (!inv || inv.status === 'void') return false;
  const current = invoiceTotal(db, inv.id);
  const delta = targetCents - current;
  if (delta === 0) return false;

  const chargeId = rid('chg');
  db.insert(charges)
    .values({
      id: chargeId,
      studentId,
      chargeItemId: null,
      label: delta < 0 ? 'Joined part-way through the month' : 'First month adjustment',
      amountCents: delta,
      note: null,
      periodKey,
      status: 'pending',
      createdByUserId: null,
      createdAt: ts,
      updatedAt: ts,
    })
    .run();
  return attachChargeToExistingInvoice(chargeId).attached;
}

export function billStudentFrom(studentId: string, fromPeriod: string, now = new Date(), opts: { firstMonthCents?: number | null } = {}): JoinResult {
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
  if (!created) return { created: 0, periods: [], reason: 'nothing_to_bill' };

  // The agreed figure for their first month, if the office named one. Applied only to the month they
  // actually STARTED — `periods[0]` is the oldest created — and only when that month was created by this
  // call, so re-running the catch-up cannot adjust it a second time.
  const adjusted = opts.firstMonthCents != null && periods[0] === fromPeriod ? adjustFirstMonth(studentId, fromPeriod, opts.firstMonthCents, now) : false;
  return { created, periods, firstMonthAdjusted: adjusted };
}
