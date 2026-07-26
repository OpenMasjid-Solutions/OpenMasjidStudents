// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Client money helpers. All amounts cross the wire as integer cents (server is the source of
 *  truth); these are for display + parsing the finance forms. */

export function formatMoney(cents: number, currency = 'usd'): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
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
