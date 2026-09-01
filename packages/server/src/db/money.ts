// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The ONE money-formatting helper (CLAUDE.md §9, §16). All money is stored and
 * moved as integer cents; no floats anywhere in the ledger. Later slices add the
 * ledger/allocation engine (billing/ledger.ts) which is the single write path.
 */

/**
 * The smallest card payment a parent may start, wherever they start it.
 *
 * One constant so the parent portal, the Fabric `info` response the kiosk and donation site read, and
 * anything added later cannot drift apart — a floor the portal enforces but the kiosk advertises
 * differently is a support call. It sits above Stripe's own per-currency minimum on purpose, so a
 * parent is stopped by a friendly form message rather than by a card decline.
 *
 * It is deliberately NOT enforced on `record-payment`: that records money a consumer has ALREADY
 * taken, and refusing to write down a 50¢ charge somebody really made would lose it, not prevent it.
 */
export const MIN_PAYMENT_CENTS = 100;

/** Convert integer cents to major units. */
export function fromCents(cents: number): number {
  return cents / 100;
}

/**
 * ONE `Intl.NumberFormat` per currency, for the life of the process.
 *
 * Same trap, and the same fix, as the browser's `web/src/lib/money.ts` — constructing a formatter costs
 * an order of magnitude more than using one, and this is called once per money cell. A CSV export of a
 * season's ledger, a household statement, a class of invoices: all of them ran the constructor per
 * amount. The locale here is the literal `'en'`, so the currency is the whole key.
 *
 * A code the runtime rejects is remembered as a miss too, so a bad currency setting cannot make every
 * amount in a printed document a thrown-and-caught constructor call.
 */
const formatters = new Map<string, Intl.NumberFormat | null>();

function formatterFor(code: string): Intl.NumberFormat | null {
  const hit = formatters.get(code);
  if (hit !== undefined) return hit;
  let made: Intl.NumberFormat | null = null;
  try {
    made = new Intl.NumberFormat('en', { style: 'currency', currency: code });
  } catch {
    made = null; // not a currency this runtime knows — the caller falls back to a plain amount
  }
  formatters.set(code, made);
  return made;
}

/** Friendly localized money string for an integer-cents amount, e.g. "$350.00". */
export function formatMoney(cents: number, currency = 'usd'): string {
  const code = currency.toUpperCase();
  const fmt = formatterFor(code);
  return fmt ? fmt.format(fromCents(cents)) : `${fromCents(cents).toFixed(2)} ${code}`;
}
