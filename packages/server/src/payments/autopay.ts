// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Autopay (CLAUDE.md §13.3) — saved card + OUR scheduler, NOT Stripe Billing. Each day the scheduler
 * charges every autopay-ON family the sum of its invoices due by today, off-session, against the
 * family's default card. `autopay_runs` UNIQUE(family, run_date) is our idempotency; the Stripe PI
 * idempotency key is derived from the run id. The webhook drives the outcome: success resets the
 * ladder; a failure advances a +2 / +5-day retry ladder and, after the third failure, auto-disables
 * autopay and notifies. The ledger truth (channel `autopay`) still lands via the webhook.
 */
import { and, eq, inArray, lte, isNull, or } from 'drizzle-orm';
import { db } from '../db';
import { autopayEnrollments, autopayRuns, families, invoices } from '../db/schema';
import { invoiceTotal, invoicePaid, recordSplit, splitAcrossFamily, familyStudentIds, familyBalance } from '../billing/ledger';
import { formatMoney } from '../db/money';
import { getCurrency } from '../settings';
import { rid } from '../db/ids';
import { makeLog } from '../logger';
import { alertStaff, householdName } from '../alerts';
import { sendReceipt, sendAutopayFailure } from '../mail/notify';
import { stripeClient } from './stripe';

const log = makeLog('autopay');

/** The Stripe error shape we care about — declared structurally so this module doesn't import the
 *  Stripe SDK (§16: only payments/stripe.ts does). A card decline is a definite failure; anything
 *  else is an indeterminate outcome (the charge may still have gone through). */
type StripeErrLike = { type?: string; code?: string; payment_intent?: { id?: string } };

/** Add `n` days to an ISO date (UTC — no timezone drift). */
export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * What autopay should charge a family today: the sum of EVERY child's invoice balances due on/before
 * `today`. One card, one charge, even though the bills behind it are per student — the split back out
 * to the children happens at the ledger (see `chargeFamily`).
 *
 * NEVER MORE THAN THE FAMILY ACTUALLY OWES. That cap is not belt-and-braces: this walks invoices and
 * counts only the positive ones, so anything that makes a household's derived balance smaller than the
 * sum of its due bills — a credit line bigger than the invoice it sits on, money paid ahead against a
 * bill not yet due — would otherwise be charged to a card as if it were owed. The derived balance
 * (`invoiced − paid`, the same figure the parent sees) is the authority on what is owed, so it is the
 * ceiling here, and a family whose screen says they owe nothing can never be charged.
 */
function amountDue(familyId: string, today: string): number {
  const kidIds = familyStudentIds(familyId);
  if (!kidIds.length) return 0;
  const open = db
    .select({ id: invoices.id, dueDate: invoices.dueDate, status: invoices.status })
    .from(invoices)
    .where(and(inArray(invoices.studentId, kidIds), inArray(invoices.status, ['open', 'partially_paid'])))
    .all();
  let due = 0;
  for (const i of open) {
    if (!i.dueDate || i.dueDate > today) continue; // only invoices actually due by today
    const bal = invoiceTotal(db, i.id) - invoicePaid(db, i.id);
    if (bal > 0) due += bal;
  }
  return Math.min(due, familyBalance(familyId).owedCents);
}

/** Families eligible to be charged today: autopay on, a default card set, not waiting on the retry
 *  ladder (nextAttemptAt null or reached), and with a positive amount due. Pure — testable. */
export function autopayDue(today: string): { familyId: string; amountCents: number }[] {
  const enrolled = db
    .select({ familyId: autopayEnrollments.familyId, defaultPmId: autopayEnrollments.defaultPmId, nextAttemptAt: autopayEnrollments.nextAttemptAt })
    .from(autopayEnrollments)
    .where(and(eq(autopayEnrollments.enabled, true), or(isNull(autopayEnrollments.nextAttemptAt), lte(autopayEnrollments.nextAttemptAt, today))))
    .all();
  const out: { familyId: string; amountCents: number }[] = [];
  for (const e of enrolled) {
    if (!e.defaultPmId) continue;
    const amountCents = amountDue(e.familyId, today);
    if (amountCents > 0) out.push({ familyId: e.familyId, amountCents });
  }
  return out;
}

/** Create the day's autopay_run for a family, idempotent on (family, run_date). Returns the run id,
 *  or null if one already exists for today (already attempted). */
export function createAutopayRun(familyId: string, amountCents: number, today: string, attempt: number): string | null {
  const existing = db.select({ id: autopayRuns.id }).from(autopayRuns).where(and(eq(autopayRuns.familyId, familyId), eq(autopayRuns.runDate, today))).get();
  if (existing) return null;
  const id = rid('apr');
  const ts = new Date();
  try {
    db.insert(autopayRuns).values({ id, familyId, runDate: today, amountCents, status: 'pending', stripePaymentIntentId: null, attempt, createdAt: ts, updatedAt: ts }).run();
  } catch {
    return null; // lost the UNIQUE(family, run_date) race — another pass already made today's run
  }
  return id;
}

/** Charge one family off-session for `amountCents`. Creates the run (idempotent) + an off-session PI;
 *  the outcome arrives via the webhook. No-op when Stripe isn't configured. */
export async function chargeFamily(familyId: string, amountCents: number, today: string): Promise<void> {
  const stripe = stripeClient();
  if (!stripe) return;
  const enr = db.select({ defaultPmId: autopayEnrollments.defaultPmId, failureCount: autopayEnrollments.failureCount }).from(autopayEnrollments).where(eq(autopayEnrollments.familyId, familyId)).get();
  const fam = db.select({ stripeCustomerId: families.stripeCustomerId }).from(families).where(eq(families.id, familyId)).get();
  if (!enr?.defaultPmId || !fam?.stripeCustomerId) return;
  // Never fire a second charge while a prior one's outcome is still unknown. A run only stays 'pending'
  // when a charge fired but neither succeeded nor definitively failed (async processing, or an
  // indeterminate network error) — re-charging across days would double-bill (the webhook, or
  // reconciliation §11.4, resolves the pending run). Same-day is already covered by createAutopayRun.
  const pending = db.select({ id: autopayRuns.id }).from(autopayRuns).where(and(eq(autopayRuns.familyId, familyId), eq(autopayRuns.status, 'pending'))).get();
  if (pending) {
    log.info('autopay skipped — a prior charge is still unresolved', { familyId });
    return;
  }
  const runId = createAutopayRun(familyId, amountCents, today, (enr.failureCount ?? 0) + 1);
  if (!runId) return; // already attempted today
  try {
    const pi = await stripe.paymentIntents.create(
      {
        amount: amountCents,
        currency: getCurrency(),
        customer: fam.stripeCustomerId,
        payment_method: enr.defaultPmId,
        off_session: true,
        confirm: true,
        description: 'Autopay tuition',
        metadata: { purpose: 'students-billing', omos_app: 'students-portal', students_family_id: familyId, students_channel: 'autopay', students_autopay_run_id: runId },
      },
      { idempotencyKey: `autopay:${runId}` },
    );
    db.update(autopayRuns).set({ stripePaymentIntentId: pi.id, updatedAt: new Date() }).where(eq(autopayRuns.id, runId)).run();
    // An off-session confirm returns the terminal outcome synchronously. Record a success NOW (the
    // ledger is idempotent on the PI id, so the webhook re-delivery is a harmless no-op) so the
    // balance clears before the next daily tick — otherwise a delayed/lost webhook would leave the
    // family "due" tomorrow and we'd charge the card again. A non-'succeeded' status (rare async
    // processing) stays pending for the webhook; a synchronous decline throws (handled below).
    if (pi.status === 'succeeded') {
      // One card charge, one ledger row PER CHILD. The split walks the family's open invoices
      // oldest-due-first — the same order every other payment path uses, so a lost webhook that
      // reconciliation later replays lands on exactly the same children in the same amounts (§11.4).
      const res = recordSplit(
        {
          channel: 'autopay',
          occurredAt: new Date(),
          idempotencyKey: pi.id,
          memo: null,
          externalRef: { stripePaymentIntentId: pi.id, stripeChargeId: (pi.latest_charge as string) ?? null },
        },
        splitAcrossFamily(familyId, amountCents),
        { userId: null, role: 'autopay', name: 'autopay' },
      );
      if (!res.duplicate) {
        void alertStaff('payment-received', {
          title: 'Tuition payment received',
          text: `${householdName(familyId)} was charged ${formatMoney(amountCents, getCurrency())} by autopay.`,
          publicText: `A tuition payment of ${formatMoney(amountCents, getCurrency())} was received (autopay).`,
        });
        void sendReceipt(familyId, formatMoney(amountCents, getCurrency())); // parent receipt (§13.2.5); !duplicate avoids a double with the webhook
      }
      onAutopaySucceeded(pi.id, runId); // mark the run charged + reset the retry ladder
    }
  } catch (e) {
    const err = e as StripeErrLike;
    // Capture the PI id even on failure (the Stripe error carries it) so a later webhook can link back.
    if (err.payment_intent?.id) db.update(autopayRuns).set({ stripePaymentIntentId: err.payment_intent.id, updatedAt: new Date() }).where(eq(autopayRuns.id, runId)).run();
    if (err.type === 'StripeCardError') {
      // A definite decline (card_declined, insufficient_funds, authentication_required) → advance the ladder.
      log.warn('autopay charge declined', { familyId, code: err.code });
      markRunFailed(runId, today);
    } else {
      // Indeterminate (network / timeout / API error) — the charge MAY have gone through. Leave the run
      // pending (do NOT advance the ladder — a phantom failure could auto-disable early); the webhook or
      // reconciliation (§11.4) settles it, and the pending-run guard above blocks a re-charge meanwhile.
      log.warn('autopay charge indeterminate — left pending for reconciliation', { familyId, type: err.type });
    }
  }
}

/** The daily entry point (called by the scheduler; tests call it directly with a fixed date). */
export async function runAutopay(today: string): Promise<{ attempted: number }> {
  const due = autopayDue(today);
  for (const d of due) await chargeFamily(d.familyId, d.amountCents, today);
  return { attempted: due.length };
}

/** Find an autopay run by OUR run id (always carried in the PI metadata) first, then fall back to the
 *  Stripe PI id. The run id is robust even when the PI id was never persisted — e.g. the create() call
 *  timed out after Stripe had already created (and maybe charged) the intent (§13.3). */
function findRun(runId: string | null | undefined, paymentIntentId: string) {
  const byId = runId ? db.select().from(autopayRuns).where(eq(autopayRuns.id, runId)).get() : undefined;
  return byId ?? db.select().from(autopayRuns).where(eq(autopayRuns.stripePaymentIntentId, paymentIntentId)).get();
}

/** An autopay PI succeeded (from the webhook or the synchronous success path) → mark the run charged,
 *  backfill its PI id, and reset the family's retry ladder. Idempotent. */
export function onAutopaySucceeded(paymentIntentId: string, runId?: string | null): void {
  const run = findRun(runId, paymentIntentId);
  if (!run) return;
  db.update(autopayRuns).set({ status: 'charged', stripePaymentIntentId: paymentIntentId, updatedAt: new Date() }).where(eq(autopayRuns.id, run.id)).run();
  db.update(autopayEnrollments).set({ failureCount: 0, nextAttemptAt: null, updatedAt: new Date() }).where(eq(autopayEnrollments.familyId, run.familyId)).run();
}

/** An autopay PI reached a TERMINAL failure at Stripe → advance the retry ladder (+2, then +5),
 *  disabling after the third. Called by reconciliation (`resolveStuckRuns`); there is no webhook. */
export function onAutopayFailed(paymentIntentId: string, runId?: string | null): void {
  const run = findRun(runId, paymentIntentId);
  if (!run) return;
  if (!run.stripePaymentIntentId) db.update(autopayRuns).set({ stripePaymentIntentId: paymentIntentId, updatedAt: new Date() }).where(eq(autopayRuns.id, run.id)).run();
  markRunFailed(run.id, run.runDate);
}

/**
 * Close out a run that never actually reached Stripe — `paymentIntents.create` threw before returning
 * an id, and a metadata search confirms no PaymentIntent for this run exists.
 *
 * Marked `failed` so it stops blocking the family's future charges, but WITHOUT advancing the retry
 * ladder: nothing was ever presented to the card, so counting it as a strike would penalise the
 * family for our own network error and could auto-disable autopay on three bad nights of
 * connectivity. Idempotent, and only ever acts on a still-pending run.
 */
export function abandonRun(runId: string): boolean {
  const run = db.select({ id: autopayRuns.id, status: autopayRuns.status }).from(autopayRuns).where(eq(autopayRuns.id, runId)).get();
  if (!run || run.status !== 'pending') return false;
  db.update(autopayRuns).set({ status: 'failed', updatedAt: new Date() }).where(eq(autopayRuns.id, runId)).run();
  return true;
}

/** Every run still sitting at `pending` — the ones the guard in `chargeFamily` blocks on. */
export function pendingRuns(): { id: string; familyId: string; runDate: string; stripePaymentIntentId: string | null }[] {
  return db
    .select({ id: autopayRuns.id, familyId: autopayRuns.familyId, runDate: autopayRuns.runDate, stripePaymentIntentId: autopayRuns.stripePaymentIntentId })
    .from(autopayRuns)
    .where(eq(autopayRuns.status, 'pending'))
    .all();
}

/** Shared failure handling (from a webhook or a synchronous decline): advance the ladder. Acts ONLY on
 *  a still-'pending' run, so a re-delivered failure — or a failure event for an already-charged run —
 *  can never double-advance the ladder or flip a charged run back to failed. */
function markRunFailed(runId: string, runDate: string): void {
  const run = db.select().from(autopayRuns).where(eq(autopayRuns.id, runId)).get();
  if (!run || run.status !== 'pending') return;
  db.update(autopayRuns).set({ status: 'failed', updatedAt: new Date() }).where(eq(autopayRuns.id, runId)).run();
  const enr = db.select().from(autopayEnrollments).where(eq(autopayEnrollments.familyId, run.familyId)).get();
  if (!enr) return;
  const failureCount = (enr.failureCount ?? 0) + 1;
  const ts = new Date();
  if (failureCount >= 3) {
    // Third strike — stop trying, turn autopay off, and tell finance + the parent.
    db.update(autopayEnrollments).set({ enabled: false, failureCount, nextAttemptAt: null, updatedAt: ts }).where(eq(autopayEnrollments.familyId, run.familyId)).run();
    // An ALERT, not a notification: this family stops being charged until a human intervenes, so it
    // must reach a person — the office's own alert list, and the admin's email via OpenMasjidOS —
    // rather than only a webhook nobody configured. Named, because "a family" is not actionable.
    void alertStaff('autopay-disabled', {
      title: 'Autopay switched off',
      text: `${householdName(run.familyId)} had three failed card charges, so autopay has been turned off. They will not be charged again until someone follows up.`,
      publicText: 'Autopay was turned off for a family after three failed charge attempts.',
    });
    void sendAutopayFailure(run.familyId, true); // parent: autopay is now off — pay now + update card (§13.3)
  } else {
    // Retry on day +2 (after the 1st failure) then day +5 (after the 2nd).
    db.update(autopayEnrollments).set({ failureCount, nextAttemptAt: addDays(runDate, failureCount === 1 ? 2 : 3), updatedAt: ts }).where(eq(autopayEnrollments.familyId, run.familyId)).run();
    void alertStaff('autopay-failed', {
      title: 'An autopay charge failed',
      text: `${householdName(run.familyId)}'s card was declined (attempt ${failureCount} of 3). We will try again in a few days; they have been emailed.`,
      publicText: `An autopay charge was declined (attempt ${failureCount} of 3). A retry is scheduled.`,
    });
    void sendAutopayFailure(run.familyId, false); // parent: charge failed, we'll retry — or pay now (§13.3)
  }
}
