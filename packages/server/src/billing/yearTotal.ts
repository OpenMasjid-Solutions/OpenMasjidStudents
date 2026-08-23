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
 * ── FROM A MONTH, FOR A CHILD JOINING MID-YEAR ───────────────────────────────
 * A child starting in February does not owe September to January, so `fromPeriod` narrows the monthly
 * count to the months from then on. The per-term and one-time lines are NOT prorated: a term fee is for a
 * term the child will attend, and there is no honest way to guess which terms remain from a month alone.
 * The result reports both totals, so an office can say "the full year is $1,000, and from February it is
 * $400" without doing either sum themselves.
 */
import { and, eq, ne } from 'drizzle-orm';
import { db } from '../db';
import { feePlans, invoiceItems, invoices, schoolYears, studentFees, students, terms, type FeeCadence } from '../db/schema';
import { schoolYearMonths } from './schoolYear';

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
  totalCents: number;
  /** The total from `fromPeriod` onward. Equal to `totalCents` when no month was given. */
  fromTotalCents: number;
  fromPeriod: string | null;
  /** Months of this year still to come from `fromPeriod` (or all of them). */
  monthsCounted: number;
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
export function yearTotalFor(studentId: string, fromPeriod?: string | null): YearTotal {
  const student = db.select({ schoolId: students.schoolId }).from(students).where(eq(students.id, studentId)).get();
  const year = db
    .select()
    .from(schoolYears)
    .where(student?.schoolId ? and(eq(schoolYears.isCurrent, true), eq(schoolYears.schoolId, student.schoolId)) : eq(schoolYears.isCurrent, true))
    .get();

  const empty: YearTotal = { year: null, lines: [], totalCents: 0, fromTotalCents: 0, fromPeriod: fromPeriod ?? null, monthsCounted: 0 };
  if (!year || year.startYear == null) return empty;

  const months = schoolYearMonths(year.startYear, year.startMonth, year.endMonth).map((m) => m.periodKey);
  const monthsFrom = fromPeriod ? months.filter((k) => k >= fromPeriod) : months;
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
    fromPeriod: fromPeriod ?? null,
    monthsCounted: monthsFrom.length,
  };
}
