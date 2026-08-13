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

/** Friendly localized money string for an integer-cents amount, e.g. "$350.00". */
export function formatMoney(cents: number, currency = 'usd'): string {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: currency.toUpperCase() }).format(fromCents(cents));
  } catch {
    return `${fromCents(cents).toFixed(2)} ${currency.toUpperCase()}`;
  }
}
