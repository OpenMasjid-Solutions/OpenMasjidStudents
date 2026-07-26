// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Month names for the school-year pickers and the year grid's column heads.
 *
 * Shared rather than repeated, because the Structure tab sets the year's start/end months and the
 * Year view renders the resulting columns — two lists that must agree about what month 4 is.
 *
 * The server sends short labels with the grid it computes (billing/schoolYear.ts); these are the
 * full names, for the configuration selects where "April" reads better than "Apr".
 */
export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** 1-12 → "April". Out-of-range returns '' rather than throwing: it renders as a blank cell, which
 *  is the right failure for a label, and the server already validates the stored value. */
export function monthName(month: number): string {
  return MONTH_NAMES[month - 1] ?? '';
}

/** How a configured year reads in one line, e.g. "April 2026 – March 2027". A year whose end month
 *  is not after its start month wraps into the next calendar year — the same rule the server's
 *  period builder uses, restated here so the admin sees the consequence of their own choice. */
export function schoolYearSpan(startYear: number | null, startMonth: number, endMonth: number): string {
  const start = monthName(startMonth);
  const end = monthName(endMonth);
  if (startYear == null) return `${start} – ${end}`;
  const endYear = endMonth < startMonth ? startYear + 1 : startYear;
  return `${start} ${startYear} – ${end} ${endYear}`;
}
