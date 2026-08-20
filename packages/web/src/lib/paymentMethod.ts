// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * How a saved payment method reads on screen (0.48.0).
 *
 * It used to be `(brand ?? 'card').toUpperCase() + ' ···· ' + last4`, which produced the literal
 * "CARD ···· " with an empty expiry for every method that is not a card — a bank account, Link, Cash App
 * — because those have no brand and no last four in the card fields. Worse, it ASSERTED "card" about
 * something that was not one.
 *
 * So this returns a descriptor and lets the component do the wording. The split is deliberate: the names
 * here are PROPER NOUNS — Visa, Mastercard, Apple Pay, the bank's own name — and a proper noun must not
 * be run through i18n, while "Expires", "Checking" and "Default" must be. Getting that backwards is how
 * a Spanish portal ends up saying "Visado".
 *
 * Two rules held on purpose:
 *   - never claim a kind we were not told. An unrecognized type is titled from the type itself
 *     ("Cash App"), and a method with nothing recorded is `other` with no name, which the component
 *     renders as "Saved payment method" — vague, but true, which the old output was not.
 *   - a card expires at the END of its expiry month, which is what the networks mean by 04/27.
 */

/** The fields `portal.autopayStatus` returns for one saved method. */
export interface SavedMethod {
  type?: string | null;
  brand?: string | null;
  last4?: string | null;
  expMonth?: number | null;
  expYear?: number | null;
  wallet?: string | null;
  bankName?: string | null;
  accountType?: string | null;
}

export interface MethodDisplay {
  /** Drives the icon and which subtitle the component builds. */
  kind: 'card' | 'bank' | 'other';
  /** "Visa", "Chase", "Cash App" — a proper noun, or null when nothing was recorded. */
  name: string | null;
  last4: string | null;
  /** "Apple Pay" / "Google Pay" when the card was added through a wallet. */
  wallet: string | null;
  expMonth: number | null;
  expYear: number | null;
  /** Past its expiry month. Worth surfacing: an expired default card is why autopay stops working. */
  expired: boolean;
  /** `checking` | `savings` for a bank account, for the component to translate. */
  accountType: 'checking' | 'savings' | null;
}

/** Stripe's `card.brand` values, spelled the way the card itself is. */
const BRANDS: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
  cartes_bancaires: 'Cartes Bancaires',
  eftpos_au: 'Eftpos',
  link: 'Link',
};

/** `card.wallet.type` values. */
const WALLETS: Record<string, string> = {
  apple_pay: 'Apple Pay',
  google_pay: 'Google Pay',
  samsung_pay: 'Samsung Pay',
  link: 'Link',
  amex_express_checkout: 'Amex Express Checkout',
  masterpass: 'Masterpass',
  visa_checkout: 'Visa Checkout',
};

/** Non-card `PaymentMethod.type` values worth naming properly, and which of them are bank debits. */
const TYPES: Record<string, { name: string; kind: 'bank' | 'other' }> = {
  us_bank_account: { name: 'Bank account', kind: 'bank' },
  sepa_debit: { name: 'SEPA Direct Debit', kind: 'bank' },
  bacs_debit: { name: 'Bacs Direct Debit', kind: 'bank' },
  acss_debit: { name: 'Pre-authorized debit', kind: 'bank' },
  au_becs_debit: { name: 'BECS Direct Debit', kind: 'bank' },
  link: { name: 'Link', kind: 'other' },
  cashapp: { name: 'Cash App', kind: 'other' },
  paypal: { name: 'PayPal', kind: 'other' },
  amazon_pay: { name: 'Amazon Pay', kind: 'other' },
};

/** `us_bank_account` → "US bank account". For a type this app has never heard of, saying its own name is
 *  better than calling it a card. */
function prettifyType(type: string): string {
  const words = type.replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

/** A card is good through the last day of its expiry month. `now` is injectable so this is testable. */
function isExpired(expMonth: number | null, expYear: number | null, now: Date): boolean {
  if (!expMonth || !expYear) return false;
  const endOfMonth = expYear * 12 + expMonth; // months since year 0, inclusive of the expiry month
  return now.getFullYear() * 12 + (now.getMonth() + 1) > endOfMonth;
}

export function describeMethod(m: SavedMethod, now: Date = new Date()): MethodDisplay {
  const type = m.type ?? (m.brand ? 'card' : null);
  const last4 = m.last4 ?? null;
  const expMonth = m.expMonth ?? null;
  const expYear = m.expYear ?? null;
  const accountType = m.accountType === 'checking' || m.accountType === 'savings' ? m.accountType : null;

  if (type === 'card') {
    return {
      kind: 'card',
      // An unrecognized brand still gets said rather than dropped — a new network is a name, not an error.
      name: m.brand ? BRANDS[m.brand] ?? prettifyType(m.brand) : null,
      last4,
      wallet: m.wallet ? WALLETS[m.wallet] ?? prettifyType(m.wallet) : null,
      expMonth,
      expYear,
      expired: isExpired(expMonth, expYear, now),
      accountType: null,
    };
  }

  if (type) {
    const known = TYPES[type];
    return {
      kind: known?.kind ?? 'other',
      // The bank's own name beats the generic "Bank account" when Stripe gave us one.
      name: m.bankName ?? known?.name ?? prettifyType(type),
      last4,
      wallet: null,
      expMonth: null,
      expYear: null,
      expired: false,
      accountType,
    };
  }

  // Nothing recorded at all — a row saved before the type column existed, on an install that cannot
  // reach Stripe to repair it. Say so vaguely rather than falsely.
  return { kind: 'other', name: null, last4, wallet: null, expMonth: null, expYear: null, expired: false, accountType: null };
}

/** "Visa ···· 4242", "Chase ···· 6789", "Apple Pay · Visa ···· 4242", or just a name. `fallback` is the
 *  translated "Saved payment method", supplied by the caller so this file holds no UI strings. */
export function methodTitle(d: MethodDisplay, fallback: string): string {
  const parts: string[] = [];
  if (d.wallet) parts.push(d.wallet);
  parts.push(d.name ?? fallback);
  const head = parts.join(' · ');
  return d.last4 ? `${head} ···· ${d.last4}` : head;
}

/** Zero-padded, the way it is printed on the card: `04/2027`. */
export function formatExpiry(d: MethodDisplay): string | null {
  if (!d.expMonth || !d.expYear) return null;
  return `${String(d.expMonth).padStart(2, '0')}/${d.expYear}`;
}
