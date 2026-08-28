// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Client money helpers. All amounts cross the wire as integer cents (server is the source of
 *  truth); these are for display + parsing the finance forms. */

/**
 * ONE `Intl.NumberFormat` per currency, kept for the life of the page.
 *
 * `formatMoney` built a fresh formatter on every call, and it is called once per money cell — which on
 * the screens that matter is not a handful. A billing record prints every invoice, every line of every
 * invoice and every payment; the year view is every child times twelve months. So one render was
 * constructing hundreds of formatters, and CONSTRUCTING one is the expensive half by a wide margin
 * (locale resolution plus pattern lookup) — an order of magnitude above formatting a number with one
 * that already exists. That cost was then paid AGAIN on every keystroke in any form on the same
 * screen, because typing re-renders the tables around it, which is what made those screens feel
 * jittery rather than merely slow to open.
 *
 * Keyed on the currency alone, because the locale cannot change within a page: the first argument is
 * `undefined`, i.e. the BROWSER's locale, not i18next's language. (That is pre-existing behavior and
 * deliberately left alone — switching the app's language has never restyled the money, and making it
 * do so is a display decision, not a performance one.)
 *
 * A code the runtime rejects is remembered as a miss too, so a bad currency setting cannot turn every
 * cell on the screen into a thrown-and-caught constructor call.
 */
const formatters = new Map<string, Intl.NumberFormat | null>();

function formatterFor(code: string): Intl.NumberFormat | null {
  const hit = formatters.get(code);
  if (hit !== undefined) return hit;
  let made: Intl.NumberFormat | null = null;
  try {
    made = new Intl.NumberFormat(undefined, { style: 'currency', currency: code });
  } catch {
    made = null; // not a currency this runtime knows — the caller falls back to a plain amount
  }
  formatters.set(code, made);
  return made;
}

export function formatMoney(cents: number, currency = 'usd'): string {
  const code = currency.toUpperCase();
  const fmt = formatterFor(code);
  return fmt ? fmt.format(cents / 100) : `${(cents / 100).toFixed(2)} ${code}`;
}

/** Parse a dollars-and-cents input string to integer cents; null if not a valid positive amount.
 *  Rejecting negatives is deliberate: a payment, a fee-plan price and a per-student override are all
 *  amounts owed, and a minus sign there is a typo. Charges are the exception — see below. */
export function parseCents(input: string): number | null {
  const n = Number(input.trim());
  if (Number.isNaN(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** Parse an amount that is ALLOWED to be negative — a one-off charge, where a negative line is how a
 *  credit, scholarship or correction is issued (an invoice line is immutable once written, §9).
 *  Returns null for blank or non-numeric input; 0 is returned as 0 and refused by the server with a
 *  clear message rather than being silently treated as "no amount". */
export function parseSignedCents(input: string): number | null {
  const s = input.trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}
