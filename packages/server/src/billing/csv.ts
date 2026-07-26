// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * CSV building for the billing exports (§14).
 *
 * TWO separate escaping problems, and conflating them is how CSV exports go wrong:
 *
 * 1. **CSV quoting** — a value containing a comma, quote or newline must be wrapped in quotes with
 *    its own quotes doubled, or the file silently gains columns. Purely structural.
 *
 * 2. **Formula injection** — a spreadsheet treats a cell starting with `=`, `+`, `-`, `@` (and,
 *    in Excel, a leading tab or carriage return) as a FORMULA. A family called `=cmd|…` or a memo
 *    pasted by a parent becomes code that runs when the office opens the file. §14 mandates escaping
 *    these; we prefix a single quote, which spreadsheets treat as "this is text" and hide.
 *    This is a security control, not cosmetics: the data here includes free-typed guardian names and
 *    payment memos, i.e. attacker-influenced strings.
 *
 * Money is written as plain decimal (`35.00`), never a currency symbol, so the receiving spreadsheet
 * reads it as a number. Dates are ISO so they sort.
 */

/** Characters that make a spreadsheet treat a cell as a formula rather than text. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * One CSV cell: neutralise a leading formula character, then quote structurally.
 *
 * Order matters — prefix FIRST, then quote, so the guard character ends up inside the quotes where
 * the spreadsheet will see it.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (FORMULA_LEAD.test(s)) s = `'${s}`;
  // Quote when the value could otherwise break the row — including the leading-quote case we just
  // created, since a cell starting with ' is fine but one containing " is not.
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** A whole CSV document. CRLF line endings, because Excel still wants them. */
export function toCsv(header: string[], rows: unknown[][]): string {
  const lines = [header.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))];
  // A trailing newline: some tools drop the last row without it.
  return `${lines.join('\r\n')}\r\n`;
}

/** Integer cents → a plain decimal string a spreadsheet reads as a number. Negative stays negative
 *  (a credit), and is quoted/prefixed by `csvCell` because `-` leads a formula. */
export function csvMoney(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** A timestamp → `YYYY-MM-DD`, so exports sort and don't depend on a locale. */
export function csvDate(d: Date | number | string | null): string {
  if (d === null) return '';
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}
