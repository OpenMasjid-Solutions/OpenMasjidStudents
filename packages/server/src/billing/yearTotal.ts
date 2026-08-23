// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * WHAT A YEAR OF FEES COMES TO — the one place that answers it (0.51.0-dev.11).
 *
 * The question an office is asked at every enrollment: "so what is this going to cost us for the year?"
 * Until now the only way to answer was to work it out on paper — monthly plan times however many months
 * this madrasah teaches, plus the per-term ones times the number of terms — and the office was doing that
 * arithmetic in front of a parent, from figures on two different screens.
 *
 * ── IT IS A PROJECTION, AND NOTHING HERE BILLS ANYTHING ──────────────────────
 * This is the load-bearing distinction. Every balance in this app is `invoiced − paid`, derived, never
 * stored (§9) — so a figure for a year that has not been invoiced yet is NOT a balance and must never be
 * mistaken for one. It writes nothing, it is not owed, and a family who leaves in March owes March, not
 * this. The office quotes it in conversation; the ledger continues to be the only thing that says what
 * anybody owes.
 *
 * That is also why it is not "add the year to their balance". An office CAN do that if they want to — a
 * one-off charge for the year's total, which is how some madāris prefer to bill — and this is the figure
 * they would use. But that would be a deliberate charge with a real invoice behind it, not a number this
 * module quietly turned into money.
 *
 * ── THE CADENCE ARITHMETIC, WHICH IS THE ONLY HARD PART ──────────────────────
 *  • `monthly`  × the months this school year actually teaches. NEVER twelve, and never the calendar:
 *    a madrasah running September to June bills ten months, and using twelve would overstate every quote
 *    by a fifth. `schoolYearMonths` is the one place that knows which months those are.
 *  • `per_term` × the number of terms configured on that year. A year with no terms configured bills
 *    these never (`generateForStudent` only writes them on a term period), so they count as zero rather
 *    than as one — counting them anyway would quote a family for something the app will not charge.
 *  • `one_time` × once, and ONLY if it has not already been billed. `alreadyBilledOnce` mirrors the
 *    generator's own dedupe (on a LIVE invoice, so voiding makes it billable again); a registration fee
 *    the family has already paid is not part of what the rest of the year will cost.
 *
 * The per-student amount override is honored throughout, because that is what this child is actually
 * charged — quoting the plan's list price to a family on a sibling rate would be quoting a figure the
 * office had already agreed not to charge them (§9).
 *
 * ── IT RUNS FROM WHERE THIS CHILD IS ACTUALLY BILLED ─────────────────────────
 * The HEADLINE is `fromTotalCents`: from where this student’s billing begins to the end of the year. The
 * whole-year figure is kept alongside as context, but it is the wrong number to lead with, and quietly so
 * — a child who joined in February is not going to be billed September to January, so the full year
 * overstates what they will pay by half, and it is the office who has to correct it in front of a parent.
 *
 * The start month is DERIVED when the caller does not name one (`billingStartFor`), and their earliest
 * invoice is what tells us: `billStudentFrom` created those from the month the office chose, so a mid-year
 * joiner comes out right with nobody re-entering anything.
 *
 * The per-term and one-time lines are NOT prorated by that month: a term fee is for a term the child will
 * attend, and a month says nothing about which terms remain.
 */
import { and, eq, ne } from 'drizzle-orm';
import { db } from '../db';
import { feePlans, invoiceItems, invoices, schoolYears, studentFees, students, terms, type FeeCadence } from '../db/schema';
import { schoolYearMonths } from './schoolYear';
import { isMonthPeriod } from './period';

export interface YearLine {
  planId: string;
  label: string;
  cadence: FeeCadence;
  /** What THIS child is charged per occurrence — the override when there is one. */
  amountCents: number;
  /** How many times it is charged across the whole year. */
  times: number;
  /** …and from `fromPeriod` onward, when one was given. */
  timesFrom: number;
  totalCents: number;
  fromTotalCents: number;
}

export interface YearTotal {
  /** Null when this install has no current school year — the projection is then impossible, not zero. */
  year: { label: string; startYear: number; months: number; terms: number } | null;
  lines: YearLine[];
  /** Every month of the school year, whether or not this child is billed for all of them. Context. */
  totalCents: number;
  /** THE HEADLINE FIGURE: from where this student's billing actually starts to the end of the year. */
  fromTotalCents: number;
  /** The month that total runs from — given by the caller, or derived (see `billingStartFor`). */
  fromPeriod: string | null;
  /**
   * How `fromPeriod` was arrived at, so the screen can say so rather than presenting a number with no
   * provenance. `given` = the caller named it; `invoices` = this child's earliest bill this year;
   * `current` = nothing billed yet, so from now; `yearStart` = the year has not begun.
   */
  fromSource: 'given' | 'invoices' | 'current' | 'yearStart';
  /** Months counted in `fromTotalCents`. */
  monthsCounted: number;
}

/**
 * WHERE THIS STUDENT'S YEAR ACTUALLY STARTS, when the caller has not said (0.51.0-dev.13).
 *
 * The whole-year figure is the wrong headline for most of the children an office asks about. A child who
 * joined in February is not going to be billed September to January, so quoting the full year overstates
 * what they will pay by half — and it is the office who would then have to correct it in front of a
 * parent. So the default runs from where their billing really begins to the end of the year.
 *
 * In order of what actually tells us:
 *
 *  1. **Their earliest invoice inside this year.** The strongest signal there is, and the one that makes a
 *     mid-year joiner correct without anybody re-entering their start month: `billStudentFrom` created
 *     those invoices from the month the office named, so the earliest one IS that month. Non-month periods
 *     are skipped — a `carry-in` or a stand-alone charge is not a tuition month (billing/period.ts).
 *  2. **An invoice EARLIER than this year** → the year's own start. A returning student is billed all of
 *     it, so the two figures coincide, which is correct rather than a special case.
 *  3. **Nothing billed yet** → this month, if it falls inside the year. A child being added today will be
 *     picked up by the next run, so "from now to the end of the year" is what a parent is agreeing to.
 *  4. **The year has not started** → its first month. Nothing has happened yet and the whole year is ahead.
 */
function billingStartFor(studentId: string, months: string[], now: Date): { from: string; source: 'invoices' | 'current' | 'yearStart' } {
  const mine = db
    .select({ periodKey: invoices.periodKey })
    .from(invoices)
    .where(and(eq(invoices.studentId, studentId), ne(invoices.status, 'void')))
    .all()
    .map((r) => r.periodKey)
    .filter(isMonthPeriod)
    .sort();

  const first = months[0];
  if (mine.length) {
    const earliest = mine[0];
    // Earlier than this year → they are billed all of it (case 2).
    return { from: earliest < first ? first : earliest, source: 'invoices' };
  }
  const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  if (thisMonth >= first && thisMonth <= months[months.length - 1]) return { from: thisMonth, source: 'current' };
  return { from: first, source: 'yearStart' };
}

/** Has this one-time plan already been billed to this student on a live invoice? Same rule as the
 *  generator's own dedupe — voiding an invoice deliberately makes a one-time fee billable again. */
function alreadyBilledOnce(studentId: string, feePlanId: string): boolean {
  return !!db
    .select({ id: invoiceItems.id })
    .from(invoiceItems)
    .innerJoin(invoices, eq(invoices.id, invoiceItems.invoiceId))
    .where(and(eq(invoiceItems.studentId, studentId), eq(invoiceItems.feePlanId, feePlanId), ne(invoices.status, 'void')))
    .get();
}

/**
 * What this student's year comes to, and what it comes to from `fromPeriod`.
 *
 * Returns a `year: null` shape rather than throwing when no school year is configured: the office asking
 * the question on a half-set-up install should be told the year is missing, which is actionable, instead
 * of being shown a zero that looks like an answer.
 */
export function yearTotalFor(studentId: string, fromPeriod?: string | null, now = new Date()): YearTotal {
  const student = db.select({ schoolId: students.schoolId }).from(students).where(eq(students.id, studentId)).get();
  const year = db
    .select()
    .from(schoolYears)
    .where(student?.schoolId ? and(eq(schoolYears.isCurrent, true), eq(schoolYears.schoolId, student.schoolId)) : eq(schoolYears.isCurrent, true))
    .get();

  const empty: YearTotal = { year: null, lines: [], totalCents: 0, fromTotalCents: 0, fromPeriod: fromPeriod ?? null, fromSource: fromPeriod ? 'given' : 'yearStart', monthsCounted: 0 };
  if (!year || year.startYear == null) return empty;

  const months = schoolYearMonths(year.startYear, year.startMonth, year.endMonth).map((m) => m.periodKey);
  // Where this child's year really starts. Named by the caller, or derived — see `billingStartFor` for
  // why the whole year is the wrong default headline for a mid-year joiner.
  const start = fromPeriod ? { from: fromPeriod, source: 'given' as const } : billingStartFor(studentId, months, now);
  const monthsFrom = months.filter((k) => k >= start.from);
  const termCount = db.select({ id: terms.id }).from(terms).where(eq(terms.schoolYearId, year.id)).all().length;

  const rows = db
    .select({
      planId: feePlans.id,
      label: feePlans.name,
      cadence: feePlans.cadence,
      planAmount: feePlans.amountCents,
      override: studentFees.overrideAmountCents,
    })
    .from(studentFees)
    .innerJoin(feePlans, eq(feePlans.id, studentFees.feePlanId))
    .where(and(eq(studentFees.studentId, studentId), eq(feePlans.status, 'active')))
    .all();

  const lines: YearLine[] = [];
  for (const r of rows) {
    const amountCents = r.override ?? r.planAmount;
    if (amountCents === 0) continue; // a zero line is noise in a quote, exactly as on an invoice
    let times = 0;
    let timesFrom = 0;
    if (r.cadence === 'monthly') {
      times = months.length;
      timesFrom = monthsFrom.length;
    } else if (r.cadence === 'per_term') {
      // Zero when the year has no terms: the generator would never bill it, so quoting it would be a
      // figure this app is not going to charge.
      times = termCount;
      // Not prorated — a month says nothing about which terms remain. See the header.
      timesFrom = termCount;
    } else if (!alreadyBilledOnce(studentId, r.planId)) {
      times = 1;
      timesFrom = 1;
    }
    if (times === 0 && timesFrom === 0) continue;
    lines.push({
      planId: r.planId,
      label: r.label,
      cadence: r.cadence,
      amountCents,
      times,
      timesFrom,
      totalCents: amountCents * times,
      fromTotalCents: amountCents * timesFrom,
    });
  }

  return {
    year: { label: year.label, startYear: year.startYear, months: months.length, terms: termCount },
    lines,
    totalCents: lines.reduce((n, l) => n + l.totalCents, 0),
    fromTotalCents: lines.reduce((n, l) => n + l.fromTotalCents, 0),
    fromPeriod: start.from,
    fromSource: start.source,
    monthsCounted: monthsFrom.length,
  };
}
