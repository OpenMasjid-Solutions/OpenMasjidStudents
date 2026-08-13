// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Period keys — the `YYYY-MM` strings that identify which month a bill is for.
 *
 * They matter more than they look, because UNIQUE(student, period_key) is the ONLY thing stopping
 * invoice generation from billing a month twice. That guarantee is exactly as strong as the agreement
 * on how a month is spelled: `2027-2` and `2027-02` are different keys, so typing the first one into
 * the Generate box raises a SECOND February invoice for every child, and nothing about the screen says
 * anything is wrong — the office just sees the year's total quietly double for one month. The field was
 * free text until 0.43.0.
 *
 * `carry-in` is reserved (see billing/carryIn.ts): it is a real period key belonging to the balance a
 * school brings with it when it starts mid-year, and letting someone generate "carry-in" as though it
 * were a month would collide with those invoices.
 */

/** The one spelling of a month: four-digit year, `-`, zero-padded 1-12. */
export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The period key the mid-year carried-forward balance lives on. Not a month, and never generated. */
export const CARRY_IN_PERIOD = 'carry-in';

export function isMonthPeriod(key: string): boolean {
  return PERIOD_RE.test(key);
}

/** Anything the office might have MEANT as a month: a year, a dash, one or two digits. */
const MONTH_SHAPED = /^\d{4}-\d{1,2}$/;

/**
 * What is wrong with a period key, in words for the office rather than for a log — or null if nothing.
 *
 * Deliberately narrow. A key that is not month-shaped at all ("once", "registration") is a legitimate
 * one-off label for something that does not recur, and it is idempotent on its own exact string, so
 * there is nothing to protect. The danger is only in keys that are month-shaped: those are the ones
 * where two spellings of the same month exist, and `2027-2` alongside `2027-02` bills February twice
 * with nothing on screen to suggest it.
 */
export function periodKeyError(key: string): string | null {
  const k = key.trim();
  if (!k) return 'Enter the month to bill, like 2027-02.';
  if (k.toLowerCase() === CARRY_IN_PERIOD) return 'That name is reserved for balances carried in from before you started using the app.';
  if (MONTH_SHAPED.test(k) && !PERIOD_RE.test(k)) {
    return 'Write the month as YYYY-MM with the leading zero — February 2027 is 2027-02. Without it this would bill that month a second time.';
  }
  return null;
}

/** Compare two `YYYY-MM` keys. String comparison is correct because both parts are fixed-width. */
export function periodBefore(a: string, b: string): boolean {
  return a < b;
}

/** `YYYY-MM` for a date, in local time — the month an office would call it. */
export function periodOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** The first day of a month period, as an ISO date — used for a carried-in bill's due date. */
export function firstDayOf(periodKey: string): string {
  return `${periodKey}-01`;
}

/** The month before this one. */
export function previousPeriod(periodKey: string): string {
  const [y, m] = periodKey.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** Month names, as every invoice label and month heading in the app writes them. THE one copy: this
 *  file already owns what a period key means, so the words for its months belong here too. */
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** What an invoice is called when nobody has said otherwise. */
export const DEFAULT_INVOICE_LABEL = 'Tuition — [month] [year]';

/**
 * Turn a label TEMPLATE into the label an invoice actually carries (0.48.0).
 *
 * The office used to type both the period key (`2026-07`) and the label (`Tuition — Jul 2026`) by hand,
 * every month, and the two had to agree — nothing checked that they did, so "Tuition — Jun 2026" filed
 * under `2026-07` was a typo away and would then be the wrong month on a parent's bill forever (an
 * invoice is money history and is not edited, §9).
 *
 * So the month is picked, not typed, and the label is written ONCE with tags in it. Both are derived from
 * the same period key here, which is what makes disagreeing impossible rather than merely unlikely.
 *
 * Tags, case-insensitive: [month] July · [mon] Jul · [year] 2026 · [yy] 26 · [period] 2026-07.
 * Anything else is left exactly as typed — an unknown tag is far more likely to be a madrasah's own
 * wording than a mistake, and silently deleting part of a label nobody could see the source of would be
 * the worse failure.
 */
export function resolveInvoiceLabel(template: string, periodKey: string): string {
  const [y, m] = periodKey.split('-').map(Number);
  const valid = Number.isInteger(y) && Number.isInteger(m) && m >= 1 && m <= 12;
  const subs: Record<string, string> = valid
    ? {
        month: MONTH_NAMES[m - 1],
        mon: MONTH_ABBR[m - 1],
        year: String(y),
        yy: String(y).slice(-2),
        period: periodKey,
      }
    : {};
  const out = template.replace(/\[(month|mon|year|yy|period)\]/gi, (whole, tag: string) => subs[tag.toLowerCase()] ?? whole);
  // A template that is nothing but tags we could not resolve would leave an invoice with no name at all,
  // which a parent then reads as a blank line on their bill. Fall back rather than ship that.
  return out.trim() || (valid ? `${MONTH_NAMES[m - 1]} ${y}` : periodKey);
}
