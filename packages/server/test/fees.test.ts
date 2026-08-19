// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Processing fees (0.51.0) — passing Stripe's cut to the payer.
 *
 * The arithmetic is the small half of this file. The important half is the ROUND TRIP: a fee is added
 * to what the card is charged and must be taken back out again before anything touches the ledger,
 * because every balance in this app is `invoiced − paid` (§9). If a fee is ever credited as tuition the
 * symptom is not an error — it is a family sitting on a credit that quietly absorbs part of next month,
 * compounding for as long as the setting is on. So the tests that matter here are the ones that assert
 * the ledger figure, not the Stripe figure.
 *
 * Every gross-up case is checked by SIMULATING STRIPE'S OWN DEDUCTION rather than by asserting a
 * hard-coded total: take the fee we computed, work out what Stripe would keep on that gross, and
 * confirm the school is left with the tuition. A hard-coded expectation would pass just as happily
 * against the naive markup (percentage of the NET) that this module exists to avoid.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp } from './harness';

let fees: typeof import('../src/payments/fees');
let settings: typeof import('../src/settings');

beforeAll(async () => {
  await freshApp();
  fees = await import('../src/payments/fees');
  settings = await import('../src/settings');
});

beforeEach(() => {
  // The module keeps no state, but the SETTING does — and it is read by default in every function here.
  settings.setProcessingFee({ enabled: false, cardPercentBps: 290, cardFixedCents: 30, bankEnabled: false, bankPercentBps: 80, bankFixedCents: 0, bankCapCents: 500 });
});

/** What Stripe actually keeps on a gross of `gross`, given a rate. Stripe rounds its own fee to the
 *  nearest cent, which is why this is a helper and not an inline multiplication. */
function stripeKeeps(gross: number, bps: number, fixedCents: number, capCents = 0): number {
  const raw = Math.round((gross * bps) / 10_000) + fixedCents;
  return capCents > 0 ? Math.min(raw, capCents) : raw;
}

describe('the switch', () => {
  it('is off by default, so an upgraded install charges nobody anything new', () => {
    expect(settings.getProcessingFee().enabled).toBe(false);
    const q = fees.feeQuote(10_000, 'card');
    expect(q.feeCents).toBe(0);
    expect(q.grossCents).toBe(10_000);
  });

  it('leaves the bank rate off even when the master switch is on — it is a separate decision', () => {
    settings.setProcessingFee({ enabled: true });
    expect(fees.feeQuote(10_000, 'card').feeCents).toBeGreaterThan(0);
    expect(fees.feeQuote(10_000, 'bank').feeCents).toBe(0);
    settings.setProcessingFee({ bankEnabled: true });
    expect(fees.feeQuote(10_000, 'bank').feeCents).toBeGreaterThan(0);
  });

  it('refuses a rate that could only be a typo, rather than charging it', () => {
    // 2900 bps meant as "2.9%" would add $290 to a $100 bill. The clamp keeps the previous value.
    settings.setProcessingFee({ cardPercentBps: 2900 });
    expect(settings.getProcessingFee().cardPercentBps).toBe(290);
  });
});

describe('the gross-up', () => {
  beforeEach(() => settings.setProcessingFee({ enabled: true, bankEnabled: true }));

  it('leaves the school with exactly the tuition on a card', () => {
    const q = fees.feeQuote(10_000, 'card');
    expect(q.netCents).toBe(10_000);
    // The whole point: 2.9% of the GROSS, not of the net. A naive markup gives 10_320 and leaves the
    // school ten cents short of the tuition every single time.
    expect(q.grossCents).toBe(10_330);
    expect(q.grossCents - stripeKeeps(q.grossCents, 290, 30)).toBeGreaterThanOrEqual(10_000);
  });

  it('never leaves the school short, at any amount', () => {
    for (const net of [100, 137, 999, 1_000, 4_321, 10_000, 25_000, 99_999, 250_000]) {
      const q = fees.feeQuote(net, 'card');
      const landed = q.grossCents - stripeKeeps(q.grossCents, 290, 30);
      // A cent over is rounding; a cent under leaves an invoice that can never be settled.
      expect(landed).toBeGreaterThanOrEqual(net);
      expect(landed).toBeLessThanOrEqual(net + 2);
      expect(q.grossCents).toBe(net + q.feeCents);
    }
  });

  it('honours the ACH cap instead of charging a percentage of a fee that stopped growing', () => {
    // $2,000 by bank costs the masjid $5, not 0.8% of $2,000 ($16).
    const q = fees.feeQuote(200_000, 'bank');
    expect(q.feeCents).toBe(500);
    expect(q.grossCents).toBe(200_500);
    const landed = q.grossCents - stripeKeeps(q.grossCents, 80, 0, 500);
    expect(landed).toBeGreaterThanOrEqual(200_000);
  });

  it('stays under the cap for a small bank payment', () => {
    const q = fees.feeQuote(1_000, 'bank');
    expect(q.feeCents).toBeLessThan(500);
    expect(q.grossCents - stripeKeeps(q.grossCents, 80, 0, 500)).toBeGreaterThanOrEqual(1_000);
  });

  it('charges a bank payer the bank rate — the difference is real money on a term bill', () => {
    const card = fees.feeQuote(200_000, 'card');
    const bank = fees.feeQuote(200_000, 'bank');
    // $59.79 against $5.00. Quoting the card rate to a bank payer would have pocketed the difference.
    expect(card.feeCents - bank.feeCents).toBeGreaterThan(5_000);
  });

  it('treats a zero or negative amount as nothing to charge', () => {
    expect(fees.feeQuote(0, 'card').grossCents).toBe(0);
    expect(fees.feeQuote(-500, 'card').grossCents).toBe(0);
  });
});

describe('the round trip — what the ledger records', () => {
  beforeEach(() => settings.setProcessingFee({ enabled: true }));

  it('takes the fee back out of the amount Stripe reports', () => {
    const q = fees.feeQuote(10_000, 'card');
    const md = { purpose: 'students-billing', ...fees.feeMetadata(q) };
    // This is the assertion the whole feature stands on: the card was charged 10_330, and the family's
    // bill is credited 10_000.
    expect(fees.netOfIntent(q.grossCents, md)).toBe(10_000);
  });

  it('survives the setting being switched off after the charge', () => {
    const q = fees.feeQuote(10_000, 'card');
    const md = fees.feeMetadata(q);
    // Reconciliation runs a day later and may find the feature off, or the rate changed. The figure
    // that was true when the payer agreed to it travels on the charge, which is why it is metadata and
    // not a settings lookup.
    settings.setProcessingFee({ enabled: false, cardPercentBps: 500 });
    expect(fees.netOfIntent(q.grossCents, md)).toBe(10_000);
  });

  it('writes no metadata at all when there is no fee', () => {
    settings.setProcessingFee({ enabled: false });
    expect(fees.feeMetadata(fees.feeQuote(10_000, 'card'))).toEqual({});
    // An install that never turns this on mints PaymentIntents identical to 0.50.0's.
    expect(fees.netOfIntent(10_000, { purpose: 'students-billing' })).toBe(10_000);
  });

  it('credits the full charge when a consumer grossed up but never said so', () => {
    // The safe failure direction, and the reason `amountCents` in the contract stays the NET: a missing
    // key leaves a small credit on a family's account, where a missing SUBTRACTION would leave an
    // invoice nobody can ever settle.
    expect(fees.netOfIntent(10_330, {})).toBe(10_330);
    expect(fees.netOfIntent(10_330, null)).toBe(10_330);
  });

  it('ignores a fee that is nonsense rather than trusting it', () => {
    for (const bad of ['abc', '-500', '0', '10330', '99999', '', 'NaN']) {
      // Each of these would otherwise credit a family less than they paid, or nothing at all.
      expect(fees.netOfIntent(10_330, { students_fee_cents: bad })).toBe(10_330);
    }
  });

  it('rounds a fractional fee towards the family', () => {
    expect(fees.netOfIntent(10_330, { students_fee_cents: '330.9' })).toBe(10_000);
  });
});

describe('what consumers are told', () => {
  it('says nothing is charged when the feature is off', () => {
    const p = fees.feePolicyForConsumers();
    expect(p).toEqual({ enabled: false, card: null, bank: null });
  });

  it('hands over the rule, not a quote — and hides the bank rate until it is switched on', () => {
    settings.setProcessingFee({ enabled: true });
    const p = fees.feePolicyForConsumers();
    expect(p.enabled).toBe(true);
    expect(p.card).toEqual({ percentBps: 290, fixedCents: 30 });
    // Off means "we absorb this one", so a consumer must not add it.
    expect(p.bank).toBeNull();
    settings.setProcessingFee({ bankEnabled: true });
    expect(fees.feePolicyForConsumers().bank).toEqual({ percentBps: 80, fixedCents: 0, capCents: 500 });
  });
});
