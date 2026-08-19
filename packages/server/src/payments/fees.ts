// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Processing fees — the ONE place the money is grossed up, and the one place it is taken back out
 * again (0.51.0).
 *
 * WHAT THIS IS. A madrasah pays Stripe roughly 2.9% + 30¢ to accept a card. Off by default, an office
 * can decide the PAYER covers that instead of the school: a parent settling $100 is charged $103.30,
 * the school still receives $100, and the extra is Stripe's, not the masjid's. Cash, cheque and Zelle
 * are untouched — there is no processing fee to pass on, and inventing one would be a charge for
 * nothing.
 *
 * ── THE RULE EVERYTHING ELSE HANGS ON ───────────────────────────────────────
 * **A FEE IS NOT TUITION AND NEVER ENTERS THE LEDGER.** The ledger records what the family owed and
 * paid; the fee is money that passed through on its way to Stripe. Get this wrong and it is not a
 * cosmetic bug — every derived balance in the app is `invoiced − paid` (§9), so crediting $103.30
 * against a $100 bill leaves a $3.30 credit that absorbs part of next month, and the error compounds
 * silently for as long as the setting is on.
 *
 * Which is why the dangerous direction is READING a Stripe amount back. Three paths do that — the
 * portal's confirm-on-return, autopay's synchronous confirm, and the daily reconciliation — and every
 * one of them sees the GROSS. So the fee travels in the PaymentIntent's own metadata
 * (`students_fee_cents`, §11.3) and `netOfIntent` is the single function that turns a Stripe amount
 * into a tuition amount. Nothing else may do that subtraction, and nothing may skip it: a PI minted
 * while the setting was on must still resolve correctly after it is switched off, which a
 * settings-time lookup could never manage.
 *
 * ── WHY THE PAYER'S METHOD IS PICKED BEFORE THE INTENT EXISTS ───────────────
 * A card and a US bank account cost the masjid completely different amounts — 2.9% + 30¢ against
 * 0.8% CAPPED AT $5 — so on a $2,000 term payment the honest fee is either $59.98 or $5.00. A
 * PaymentIntent's amount is fixed when it is created, and with `automatic_payment_methods` the payer
 * does not choose until after that. So when fees are on, the portal asks first (trpc/portal.ts). The
 * alternative was charging everybody the card rate, which would have quietly overcharged every bank
 * payer by fifty dollars and kept the difference — exactly the thing the copy promises we do not do.
 *
 * ── COMPLIANCE, WHICH IS NOT OURS TO DECIDE BUT IS OURS TO SAY OUT LOUD ─────
 * Passing a card fee to the payer is regulated, and the rules are about the MASJID's jurisdiction and
 * card agreements, not about this code: US federal law forbids it on DEBIT cards, a few states forbid
 * it outright, and the card networks cap it at the actual cost of acceptance. This module therefore
 * clamps the configurable rate to something that cannot exceed a real cost of acceptance, the settings
 * screen says plainly that the office must check its own position, and the default is off. See
 * docs/PAYMENTS.md §6.
 */
import { getProcessingFee, type ProcessingFeeConfig } from '../settings';

/**
 * The two things a payer can use that cost the masjid anything.
 *
 * Deliberately NOT the full list of Stripe payment method types. These are the two whose cost differs
 * enough to matter and whose rate an office can configure; anything else Stripe offers is treated as a
 * card, which is the conservative reading (it never under-collects, and the payer sees the figure
 * before agreeing to it).
 */
export type PayMethodKind = 'card' | 'bank';

/** What a payer will actually be charged, and how that splits. All three are integer cents. */
export interface FeeQuote {
  /** What the school receives and what the ledger will record — the tuition. */
  netCents: number;
  /** Stripe's cut, added on top. Zero whenever the feature is off or the channel takes no fee. */
  feeCents: number;
  /** What the card or bank is actually charged: `netCents + feeCents`. */
  grossCents: number;
  /** Which rate was applied, so a screen can name it ("card processing fee"). */
  method: PayMethodKind;
}

/** No fee: the identity quote. The shape callers get when the feature is off, so no call site needs a
 *  branch — a quote is always safe to read, and `feeCents === 0` is the normal case. */
function free(netCents: number, method: PayMethodKind): FeeQuote {
  return { netCents, feeCents: 0, grossCents: netCents, method };
}

/** Is the fee switched on for this kind of payment at all? Bank has its own switch because an office
 *  may pass on the card cost and swallow the (much smaller, capped) bank one. */
export function feeApplies(method: PayMethodKind, cfg: ProcessingFeeConfig = getProcessingFee()): boolean {
  if (!cfg.enabled) return false;
  return method === 'card' ? true : cfg.bankEnabled;
}

/**
 * Gross up `netCents` so that what lands after Stripe's cut is exactly `netCents`.
 *
 * The algebra, because the obvious version is wrong: adding 2.9% of the NET undercharges, since Stripe
 * takes its percentage of the GROSS. We need G where `G − (G·p + f) = N`, so `G = (N + f) / (1 − p)`.
 * On $100 that is $103.30 rather than the $103.20 a naive markup would produce, and the missing dime
 * comes out of the madrasah's tuition every single time.
 *
 * A CAP CHANGES THE SHAPE, not just the number. ACH is 0.8% capped at $5, so above roughly $625 the
 * cost stops growing and the gross-up must stop with it — otherwise a $2,000 payment gets $59 added
 * to cover a $5 charge, and the surplus is money we took for nothing. So: solve uncapped, and if the
 * fee that implies would exceed the cap, the answer is simply `N + cap`.
 *
 * Rounding is UP, on the gross. Half a cent has to go somewhere, and the school being a cent over is
 * an accounting rounding; the school being a cent short means a $100 invoice settles at $99.99 and
 * stays open forever, showing a family as unpaid over a penny.
 */
export function feeQuote(netCents: number, method: PayMethodKind, cfg: ProcessingFeeConfig = getProcessingFee()): FeeQuote {
  if (netCents <= 0 || !feeApplies(method, cfg)) return free(Math.max(0, netCents), method);

  const bps = method === 'card' ? cfg.cardPercentBps : cfg.bankPercentBps;
  const fixed = method === 'card' ? cfg.cardFixedCents : cfg.bankFixedCents;
  // A cap of 0 means "no cap" — cards have none. Only the bank rate is capped in practice.
  const cap = method === 'card' ? 0 : cfg.bankCapCents;
  if (bps <= 0 && fixed <= 0) return free(netCents, method);

  const rate = bps / 10_000;
  // rate is clamped well below 1 in settings validation, so this cannot divide by zero or go negative.
  const gross = Math.ceil((netCents + fixed) / (1 - rate));
  const impliedFee = gross - netCents;
  if (cap > 0 && impliedFee > cap) return { netCents, feeCents: cap, grossCents: netCents + cap, method };
  return { netCents, feeCents: impliedFee, grossCents: gross, method };
}

/**
 * The metadata key the fee travels in, and the only way it travels.
 *
 * On the PaymentIntent rather than in our database on purpose. A PI is read back by three separate
 * paths, one of them a job that runs a day later and knows nothing about the request that created it
 * (§11.4) — and the setting may have been switched off, or its rate changed, in between. The figure
 * that matters is the one that was true when the payer agreed to it, so it is carried WITH the charge.
 * It is also what lets Donations and Kiosk mint their own intents and still be read correctly here.
 *
 * Never a Student ID and never a name, like every other key in §11.3 — an amount is not identifying.
 */
export const FEE_METADATA_KEY = 'students_fee_cents';

/** The metadata fragment to merge into any PaymentIntent we create. Omitted entirely when there is no
 *  fee, so an install that never turns this on has PIs identical to before. */
export function feeMetadata(quote: FeeQuote): Record<string, string> {
  return quote.feeCents > 0 ? { [FEE_METADATA_KEY]: String(quote.feeCents) } : {};
}

/**
 * A Stripe amount → the TUITION amount. The one place that subtraction happens.
 *
 * Defensive in every direction, because this decides what a family is credited and there is no second
 * chance at it: a missing key, a non-numeric one, a negative, or a fee that claims to be the whole
 * charge all fall back to treating the amount as pure tuition. That is the safe failure — the family
 * is credited what Stripe actually took, which at worst leaves a small credit on their account rather
 * than an invoice that can never be settled.
 */
export function netOfIntent(amountCents: number, metadata: Record<string, string> | null | undefined): number {
  const raw = metadata?.[FEE_METADATA_KEY];
  if (!raw) return amountCents;
  const fee = Number(raw);
  if (!Number.isFinite(fee) || fee <= 0 || fee >= amountCents) return amountCents;
  return amountCents - Math.floor(fee);
}

/**
 * The policy in the shape a consumer needs to quote a fee itself (§11.2 `info`).
 *
 * Donations and Kiosk mint their own PaymentIntents, so they cannot ask us for a quote per keystroke —
 * they need the rule. They must also write `students_fee_cents` onto the intent and report the NET in
 * `record-payment`; the contract doc says so in the one place a consumer will actually read.
 */
export function feePolicyForConsumers(cfg: ProcessingFeeConfig = getProcessingFee()): {
  enabled: boolean;
  card: { percentBps: number; fixedCents: number } | null;
  bank: { percentBps: number; fixedCents: number; capCents: number } | null;
} {
  if (!cfg.enabled) return { enabled: false, card: null, bank: null };
  return {
    enabled: true,
    card: { percentBps: cfg.cardPercentBps, fixedCents: cfg.cardFixedCents },
    bank: cfg.bankEnabled ? { percentBps: cfg.bankPercentBps, fixedCents: cfg.bankFixedCents, capCents: cfg.bankCapCents } : null,
  };
}
