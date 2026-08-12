// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Reading a Stripe PaymentMethod into our columns (0.48.0).
 *
 * THE BUG. `saveCard` read `pm.card` and nothing else. The portal's Payment Element offers whatever the
 * masjid's Stripe account has switched on, so a household that saved a US BANK ACCOUNT stored a row of
 * NULLs and the portal rendered the literal "CARD ···· " with "Expires /". Every assertion below is a
 * shape that used to produce exactly that.
 *
 * Also pinned: what must NOT be stored. A routing number and an account holder's name are available on
 * the object and are deliberately dropped — this table is rendered on a screen a household reaches over
 * the internet, and the last four digits already answer "which one is this?" (§14).
 */
import { describe, it, expect } from 'vitest';
import { describePaymentMethod, type StripePaymentMethodLike } from '../src/payments/methods';

/** A card, as Stripe returns one. */
const CARD: StripePaymentMethodLike = {
  id: 'pm_card',
  type: 'card',
  card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2027 },
};

/** A US bank account — the shape that broke it. Extra fields present on purpose: the test asserts they
 *  are not carried into the row. */
const BANK = {
  id: 'pm_bank',
  type: 'us_bank_account',
  us_bank_account: { bank_name: 'Chase', last4: '6789', account_type: 'checking', routing_number: '110000000' },
  billing_details: { name: 'Hasan Ismail' },
} as StripePaymentMethodLike;

describe('describePaymentMethod', () => {
  it('reads a card', () => {
    expect(describePaymentMethod(CARD)).toEqual({
      type: 'card',
      brand: 'visa',
      last4: '4242',
      expMonth: 4,
      expYear: 2027,
      wallet: null,
      bankName: null,
      accountType: null,
    });
  });

  it('reads a bank account — the case that used to store nothing at all', () => {
    const d = describePaymentMethod(BANK);
    expect(d.type).toBe('us_bank_account');
    expect(d.bankName).toBe('Chase');
    expect(d.accountType).toBe('checking');
    // The last four come from the bank block, so the portal has digits to show for it.
    expect(d.last4).toBe('6789');
    // And nothing card-shaped is invented.
    expect(d.brand).toBeNull();
    expect(d.expMonth).toBeNull();
    expect(d.expYear).toBeNull();
  });

  it('stores no routing number and no account holder name', () => {
    const stored = JSON.stringify(describePaymentMethod(BANK));
    expect(stored).not.toContain('110000000');
    expect(stored).not.toContain('Hasan');
  });

  it('records the wallet a card was added through', () => {
    const d = describePaymentMethod({ ...CARD, card: { ...CARD.card, wallet: { type: 'apple_pay' } } });
    expect(d.wallet).toBe('apple_pay');
    expect(d.brand).toBe('visa');
  });

  it('keeps the type of a method it has never heard of', () => {
    // The whole point of storing `type`: an unknown method is describable as itself rather than being
    // called a card with no details.
    const d = describePaymentMethod({ id: 'pm_x', type: 'cashapp' });
    expect(d.type).toBe('cashapp');
    expect(d.brand).toBeNull();
    expect(d.last4).toBeNull();
  });

  it('survives a payment method with nothing on it', () => {
    expect(describePaymentMethod({ id: 'pm_empty' })).toEqual({
      type: null, brand: null, last4: null, expMonth: null, expYear: null, wallet: null, bankName: null, accountType: null,
    });
  });

  it('bounds every stored string', () => {
    // These are rendered on a printed sheet and in a portal row; a Stripe field is not a free-text box we
    // control, so the lengths are capped where they are read rather than trusted.
    const d = describePaymentMethod({
      id: 'pm_long',
      type: 'x'.repeat(200),
      us_bank_account: { bank_name: 'B'.repeat(400), last4: '123456789', account_type: 'checking' },
    });
    expect(d.type!.length).toBeLessThanOrEqual(40);
    expect(d.bankName!.length).toBeLessThanOrEqual(80);
    expect(d.last4).toBe('1234');
  });

  it('ignores a nonsense expiry rather than storing it', () => {
    const d = describePaymentMethod({ id: 'pm_bad', type: 'card', card: { brand: 'visa', last4: '1111', exp_month: null, exp_year: undefined } });
    expect(d.expMonth).toBeNull();
    expect(d.expYear).toBeNull();
  });
});
