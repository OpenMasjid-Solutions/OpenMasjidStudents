// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * How a saved payment method reads on screen.
 *
 * The reported bug was a portal row saying "CARD ···· " with "Expires /" — the old code was
 * `(brand ?? 'card').toUpperCase() + ' ···· ' + last4`, which for anything that is not a card (a bank
 * account, Link, Cash App) had no brand and no card last4, so it printed the fallback word and two empty
 * gaps. Worse than useless: it ASSERTED "card" about something that was not one.
 *
 * So the cases below are the ones that used to produce that, plus the two promises the component leans
 * on: a card is good through the END of its expiry month, and a name is never invented.
 */
import { describe, it, expect } from 'vitest';
import { describeMethod, formatExpiry, methodTitle } from './paymentMethod';

const FALLBACK = 'Saved payment method';
const title = (m: Parameters<typeof describeMethod>[0], now?: Date) => methodTitle(describeMethod(m, now), FALLBACK);

describe('cards', () => {
  it('names the network as the card itself spells it', () => {
    expect(title({ type: 'card', brand: 'visa', last4: '4242' })).toBe('Visa ···· 4242');
    expect(title({ type: 'card', brand: 'mastercard', last4: '4444' })).toBe('Mastercard ···· 4444');
    expect(title({ type: 'card', brand: 'amex', last4: '0005' })).toBe('American Express ···· 0005');
  });

  it('pads the expiry the way it is printed on the card', () => {
    expect(formatExpiry(describeMethod({ type: 'card', brand: 'visa', last4: '4242', expMonth: 4, expYear: 2027 }))).toBe('04/2027');
  });

  it('says which wallet a card was added through', () => {
    expect(title({ type: 'card', brand: 'visa', last4: '4242', wallet: 'apple_pay' })).toBe('Apple Pay · Visa ···· 4242');
  });

  it('still names an unknown network rather than dropping it', () => {
    expect(title({ type: 'card', brand: 'girocard', last4: '1234' })).toBe('Girocard ···· 1234');
  });
});

describe('expiry', () => {
  const card = { type: 'card', brand: 'visa', last4: '4242', expMonth: 4, expYear: 2027 };

  it('is good through the last day of the expiry month', () => {
    // 04/2027 means "usable during April 2027" — expiring it on the 1st would tell a parent to replace a
    // working card, and is the off-by-one this test exists for.
    //
    // Local-time constructors, not UTC strings: the comparison is deliberately made in the VIEWER's month,
    // because "has my card expired" is a question about the calendar on their wall. A UTC instant here
    // would pass or fail depending on the timezone the test happened to run in.
    expect(describeMethod(card, new Date(2027, 3, 30)).expired).toBe(false); // 30 April 2027
    expect(describeMethod(card, new Date(2027, 4, 1)).expired).toBe(true); //  1 May 2027
  });

  it('is not expired a year before', () => {
    expect(describeMethod(card, new Date(2026, 7, 12)).expired).toBe(false);
  });

  it('never claims expiry for a method that has none', () => {
    const bank = describeMethod({ type: 'us_bank_account', bankName: 'Chase', last4: '6789' });
    expect(bank.expired).toBe(false);
    expect(formatExpiry(bank)).toBeNull();
  });
});

describe('bank accounts — the case that printed "CARD ···· "', () => {
  it('leads with the bank and reports the account type', () => {
    const d = describeMethod({ type: 'us_bank_account', bankName: 'Chase', last4: '6789', accountType: 'checking' });
    expect(d.kind).toBe('bank');
    expect(methodTitle(d, FALLBACK)).toBe('Chase ···· 6789');
    expect(d.accountType).toBe('checking');
  });

  it('falls back to a generic name when Stripe gave no bank name', () => {
    expect(title({ type: 'us_bank_account', last4: '6789' })).toBe('Bank account ···· 6789');
  });

  it('treats the other debit schemes as bank accounts too', () => {
    for (const type of ['sepa_debit', 'bacs_debit', 'acss_debit', 'au_becs_debit']) {
      expect(describeMethod({ type }).kind).toBe('bank');
    }
  });
});

describe('everything else', () => {
  it('names the methods it knows', () => {
    expect(title({ type: 'link' })).toBe('Link');
    expect(title({ type: 'cashapp' })).toBe('Cash App');
    expect(title({ type: 'paypal' })).toBe('PayPal');
  });

  it('says an unknown method by its own name rather than calling it a card', () => {
    const d = describeMethod({ type: 'some_new_wallet' });
    expect(d.kind).toBe('other');
    expect(methodTitle(d, FALLBACK)).toBe('Some new wallet');
  });

  it('falls back honestly when nothing at all was recorded', () => {
    // A row saved before the `type` column existed, on an install that cannot reach Stripe to repair it.
    // Vague, but true — which the old "CARD ···· " was not.
    const d = describeMethod({});
    expect(d.kind).toBe('other');
    expect(methodTitle(d, FALLBACK)).toBe(FALLBACK);
  });

  it('reads a legacy row with a brand but no type as the card it is', () => {
    // Migration 0035 backfills `type = 'card'` where a brand exists, but the same inference is made here
    // so a row that slipped through still renders properly.
    expect(title({ brand: 'visa', last4: '4242' })).toBe('Visa ···· 4242');
  });
});
