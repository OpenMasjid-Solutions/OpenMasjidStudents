// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Turning a configured school year into the concrete billing months the year view is a grid of.
 *
 * A madrasa year is usually offset from the calendar (Apr → Mar), so the months wrap: with
 * `startYear = 2026`, `startMonth = 4`, `endMonth = 3` the periods run 2026-04 … 2027-03. The
 * period keys produced here are the SAME `YYYY-MM` strings invoice generation uses, which is what
 * lets the grid line a student's row up against real invoices.
 */

export interface BillingMonth {
  /** `YYYY-MM` — identical to the invoice `periodKey` for that month. */
  periodKey: string;
  year: number;
  /** 1-12. */
  month: number;
  /** Short display label, e.g. "Apr". Rendered as the column head. */
  label: string;
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The months of a school year, in order, starting at `startMonth` and walking forward (wrapping
 * past December) until `endMonth` is included.
 *
 * Apr → Mar is 12 months; Apr → Apr is a single month. Anything that would exceed 12 months is
 * impossible by construction, since walking forward from any month reaches every other month
 * within 12 steps.
 */
export function schoolYearMonths(startYear: number, startMonth: number, endMonth: number): BillingMonth[] {
  const out: BillingMonth[] = [];
  let year = startYear;
  let month = startMonth;
  for (let i = 0; i < 12; i++) {
    out.push({ periodKey: `${year}-${String(month).padStart(2, '0')}`, year, month, label: MONTH_LABELS[month - 1] });
    if (month === endMonth) break;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}
