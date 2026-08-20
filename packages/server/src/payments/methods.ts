// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * What a saved payment method IS, and repairing the rows that never recorded it (0.48.0).
 *
 * THE BUG THIS FIXES. `saveCard` read `pm.card?.brand`, `pm.card?.last4` and the two expiry fields and
 * wrote nothing else. The portal's Payment Element offers whatever the masjid's Stripe account has
 * switched on — so a household that saved a US BANK ACCOUNT (or paid through Link, or Cash App) had
 * `pm.card` come back undefined, every column stored NULL, and the portal rendered the literal
 * "CARD ···· " with "Expires /". The payment method worked; the app just had nowhere to write what it
 * was looking at, and so described everything as a card whose details it had lost.
 *
 * `describePaymentMethod` is now the ONE place that reads a Stripe PaymentMethod, so `saveCard` and the
 * repair below cannot disagree about what a bank account looks like.
 *
 * WHAT IS DELIBERATELY NOT READ. `us_bank_account.routing_number`, any `billing_details.name`, and
 * `link.email`. A parent reading their own row learns nothing from them that the last four digits do not
 * already tell them, and this table is rendered on a screen the household reaches over the internet
 * (§14 data minimization). The rule for this table has always been "brand/last4/exp only, never a PAN";
 * this keeps to the same spirit for the kinds of method it did not previously know about.
 */
import { eq, and, asc, isNull } from 'drizzle-orm';
import { db } from '../db';
import { autopayEnrollments, paymentMethods } from '../db/schema';
import { stripeClient } from './stripe';
import { makeLog } from '../logger';

const log = makeLog('payments');

/** Only the fields we consume, so this module needs no Stripe type import and states its own contract. */
export interface StripePaymentMethodLike {
  id: string;
  type?: string | null;
  card?: {
    brand?: string | null;
    last4?: string | null;
    exp_month?: number | null;
    exp_year?: number | null;
    wallet?: { type?: string | null } | null;
  } | null;
  us_bank_account?: { bank_name?: string | null; last4?: string | null; account_type?: string | null } | null;
}

/** The columns of `payment_methods` that describe the method rather than owning it. */
export interface PaymentMethodDetails {
  type: string | null;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  wallet: string | null;
  bankName: string | null;
  accountType: string | null;
}

/** Short, because these are stored and rendered, not free text. */
const cap = (v: unknown, n = 60): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);

/**
 * Read a Stripe PaymentMethod into our columns.
 *
 * Every branch is additive: an unrecognized `type` still stores the type, so a method this app has never
 * heard of is described as itself ("Cash App") by the portal rather than mislabeled as a card. That is
 * the whole failure this replaces.
 */
export function describePaymentMethod(pm: StripePaymentMethodLike): PaymentMethodDetails {
  const bank = pm.us_bank_account;
  return {
    type: cap(pm.type, 40),
    brand: cap(pm.card?.brand, 40),
    last4: cap(pm.card?.last4 ?? bank?.last4, 4),
    expMonth: int(pm.card?.exp_month),
    expYear: int(pm.card?.exp_year),
    wallet: cap(pm.card?.wallet?.type, 40),
    bankName: cap(bank?.bank_name, 80),
    accountType: cap(bank?.account_type, 20),
  };
}

/**
 * A household's saved methods in the order they will be tried — position 0 first (0.48.0).
 *
 * `(sortOrder, createdAt)` on purpose: after migration 0036 every non-default row shares one sort value, so
 * the second key is what makes the list stable and oldest-first rather than dependent on SQLite's mood.
 */
export function orderedMethods(familyId: string) {
  return db
    .select()
    .from(paymentMethods)
    .where(eq(paymentMethods.familyId, familyId))
    .orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.createdAt))
    .all();
}

/**
 * Renumber a household's methods 0..n-1 and make everything that reads "which one is default" agree.
 *
 * THREE THINGS HAVE TO MOVE TOGETHER, which is the whole reason this is one function: `sort_order` (the
 * authority), `is_default` (what the portal and the office screens read), and
 * `autopay_enrollments.default_pm_id` (what a charge actually presents). Leaving any one behind produces
 * the worst kind of bug here — a screen that says one card and a charge that uses another.
 *
 * Called after every change to the set: a reorder, a new method, a removal.
 */
export function resequenceMethods(familyId: string): void {
  const rows = orderedMethods(familyId);
  const ts = new Date();
  db.transaction((tx) => {
    rows.forEach((r, i) => {
      tx.update(paymentMethods).set({ sortOrder: i, isDefault: i === 0 }).where(eq(paymentMethods.id, r.id)).run();
    });
    const first = rows[0]?.id ?? null;
    const enr = tx.select({ familyId: autopayEnrollments.familyId, defaultPmId: autopayEnrollments.defaultPmId }).from(autopayEnrollments).where(eq(autopayEnrollments.familyId, familyId)).get();
    // Only when it actually changed, so an untouched household's `updatedAt` is not churned.
    if (enr && enr.defaultPmId !== first) {
      if (first) {
        // Autopay stays ON and simply follows the new first choice — that is what removing the top card, or
        // promoting the second, is meant to do.
        tx.update(autopayEnrollments).set({ defaultPmId: first, updatedAt: ts }).where(eq(autopayEnrollments.familyId, familyId)).run();
      } else {
        // Nothing left to charge, so autopay cannot run. Switched off rather than left enabled with nothing
        // behind it, which would be a promise the scheduler silently skips every day.
        tx.update(autopayEnrollments).set({ defaultPmId: null, enabled: false, updatedAt: ts }).where(eq(autopayEnrollments.familyId, familyId)).run();
      }
    }
  });
}

/** How many unclassified rows one read will repair. A household has one or two payment methods; this is
 *  a guard against a read making a long series of Stripe calls, not a real limit. */
const REPAIR_LIMIT = 5;

/**
 * Fill in any of this family's rows that never recorded what they were, from Stripe.
 *
 * Possible at all because `payment_methods.id` IS the Stripe PaymentMethod id, so the fact was never
 * lost — only unrecorded. That means the households already showing "CARD ···· " are repaired the next
 * time a parent opens the tab, with nobody having to re-save anything.
 *
 * BEST-EFFORT BY CONSTRUCTION: it is called from a read, so every failure is swallowed and the row is
 * left as it was. Stripe being unreachable must degrade the wording on one line, never take down the
 * page that tells a parent what they owe (§13.5). It runs at most once per row — a repaired row has a
 * `type` and is no longer selected.
 */
export async function repairPaymentMethods(familyId: string): Promise<number> {
  const unknown = db
    .select({ id: paymentMethods.id })
    .from(paymentMethods)
    .where(and(eq(paymentMethods.familyId, familyId), isNull(paymentMethods.type)))
    .limit(REPAIR_LIMIT)
    .all();
  if (!unknown.length) return 0;
  const stripe = stripeClient();
  if (!stripe) return 0;

  let fixed = 0;
  for (const row of unknown) {
    try {
      const pm = (await stripe.paymentMethods.retrieve(row.id)) as StripePaymentMethodLike;
      const d = describePaymentMethod(pm);
      if (!d.type) continue; // nothing learned; leave it for next time rather than writing blanks back
      db.update(paymentMethods).set(d).where(eq(paymentMethods.id, row.id)).run();
      fixed++;
    } catch (e) {
      // Ids only — never the family, never the method's details (§14).
      log.warn('payment method repair failed', { paymentMethodId: row.id, error: (e as Error).message });
    }
  }
  return fixed;
}
