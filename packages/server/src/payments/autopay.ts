// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Autopay (CLAUDE.md §13.3) — saved card + OUR scheduler, NOT Stripe Billing. Each day the scheduler
 * charges every autopay-ON family the sum of its invoices due by today, off-session, against the
 * family's default card. `autopay_runs` UNIQUE(family, run_date) is our idempotency; the Stripe PI
 * idempotency key is derived from the run id.
 *
 * THERE IS NO WEBHOOK (§13.4), and this header said there was until 0.50.0. An off-session confirm
 * returns its outcome SYNCHRONOUSLY, so a success is recorded right there (channel `autopay`) and a
 * decline throws and advances a +2 / +5-day retry ladder that walks down the household's own saved-card
 * order; after the third failure autopay auto-disables and notifies. An INDETERMINATE outcome — a
 * network error, a rare async status — is left `pending` and never counted as a strike, and the daily
 * reconciliation (§11.4) is what resolves it.
 */
import { and, eq, inArray, lte, ne, isNull, or } from 'drizzle-orm';
import { db } from '../db';
import { autopayEnrollments, autopayRuns, families, invoices, paymentMethods, students } from '../db/schema';
import { invoiceTotal, invoicePaid, recordSplit, recordedSplit, splitAcrossFamily, familyStudentIds, familyBalance } from '../billing/ledger';
import { formatMoney } from '../db/money';
import { getCurrency } from '../settings';
import { rid } from '../db/ids';
import { makeLog } from '../logger';
import { alertStaff, childrenOf, studentAmounts } from '../alerts';
import { sendReceipt, sendAutopayFailure, sendAutopayUpcoming, sendCardExpiring } from '../mail/notify';
import { formatDate } from '../settings/dates';
import { stripeClient } from './stripe';
import { orderedMethods } from './methods';
import { feeMetadata, feeQuote } from './fees';

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

/**
 * How many days before a charge the family is told about it (0.50.0).
 *
 * Three: long enough to move money or to switch autopay off for the month, short enough that the
 * message is still true when it arrives — a fortnight's notice would be forgotten, and a bill can be
 * paid another way in between, which is exactly why the notice is a courtesy and not a promise.
 */
export const AUTOPAY_NOTICE_DAYS = 3;

/**
 * Households to warn today that a charge is coming (0.50.0).
 *
 * IDEMPOTENT BY CONSTRUCTION, with no state of its own, and the rule that makes it so is the one
 * subtle thing here: a household qualifies only when it has an open invoice whose due date is
 * EXACTLY `today + AUTOPAY_NOTICE_DAYS`. Selecting on "something is due soon" instead would message a
 * family with an older overdue bill every single day until they paid it — which is not a courtesy,
 * it is the behavior that gets a school's messages muted.
 *
 * The amount quoted is what autopay would actually take on that day, capped by the household's real
 * balance, so it is the same figure `autopayDue` will compute when the run happens.
 */
export function autopayUpcoming(today: string): { familyId: string; amountCents: number; on: string }[] {
  const on = addDays(today, AUTOPAY_NOTICE_DAYS);
  const enrolled = db
    .select({ familyId: autopayEnrollments.familyId, defaultPmId: autopayEnrollments.defaultPmId })
    .from(autopayEnrollments)
    .where(eq(autopayEnrollments.enabled, true))
    .all();

  const out: { familyId: string; amountCents: number; on: string }[] = [];
  for (const e of enrolled) {
    if (!e.defaultPmId) continue;
    const dueThatDay = db
      .select({ id: invoices.id })
      .from(invoices)
      .innerJoin(students, eq(students.id, invoices.studentId))
      .where(and(eq(students.familyId, e.familyId), eq(invoices.dueDate, on), ne(invoices.status, 'void')))
      .all();
    if (!dueThatDay.length) continue;
    const amountCents = amountDue(e.familyId, on);
    if (amountCents > 0) out.push({ familyId: e.familyId, amountCents, on });
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
 *  the outcome is returned synchronously by the off-session confirm — there is no webhook (§13.4).
 *  No-op when Stripe isn't configured. */
export async function chargeFamily(familyId: string, amountCents: number, today: string): Promise<void> {
  const stripe = stripeClient();
  if (!stripe) return;
  const enr = db.select({ defaultPmId: autopayEnrollments.defaultPmId, failureCount: autopayEnrollments.failureCount }).from(autopayEnrollments).where(eq(autopayEnrollments.familyId, familyId)).get();
  const fam = db.select({ stripeCustomerId: families.stripeCustomerId }).from(families).where(eq(families.id, familyId)).get();
  if (!enr?.defaultPmId || !fam?.stripeCustomerId) return;

  /**
   * WHICH METHOD, on this attempt (0.48.0).
   *
   * A household can now put its saved methods in order — "the joint account, then my card" — and the ladder
   * walks down it: attempt 1 takes their first choice, attempt 2 the second, attempt 3 the third. Before
   * this, all three attempts presented the SAME declining card two days apart, which is not a retry so much
   * as the same answer three times.
   *
   * It falls back to the first when the list is shorter than the ladder, so a household with one card
   * behaves exactly as it did. `defaultPmId` remains the answer for attempt 1 — `resequenceMethods` keeps
   * it equal to position 0 — so nothing depends on the ordering being present to work.
   */
  const ordered = orderedMethods(familyId);
  const attemptIndex = enr.failureCount ?? 0;
  const chosenPmId = ordered.length ? (ordered[Math.min(attemptIndex, ordered.length - 1)]?.id ?? enr.defaultPmId) : enr.defaultPmId;
  // Never fire a second charge while a prior one's outcome is still unknown. A run only stays 'pending'
  // when a charge fired but neither succeeded nor definitively failed (async processing, or an
  // indeterminate network error) — re-charging across days would double-bill (reconciliation, or
  // reconciliation §11.4, resolves the pending run). Same-day is already covered by createAutopayRun.
  const pending = db.select({ id: autopayRuns.id }).from(autopayRuns).where(and(eq(autopayRuns.familyId, familyId), eq(autopayRuns.status, 'pending'))).get();
  if (pending) {
    log.info('autopay skipped — a prior charge is still unresolved', { familyId });
    return;
  }
  const runId = createAutopayRun(familyId, amountCents, today, (enr.failureCount ?? 0) + 1);
  if (!runId) return; // already attempted today
  /**
   * THE PROCESSING FEE, QUOTED FOR THE METHOD THIS ATTEMPT WILL ACTUALLY USE (0.51.0).
   *
   * `amountCents` stays the tuition throughout — it is what `autopay_runs` stores, what the ledger
   * records, and what the parent's notices quote — and the gross is used for the Stripe charge alone.
   * Keeping the two apart is what makes the retry ladder safe: attempt 2 may fall through to a bank
   * account, which costs the masjid a fifth of what the card did, and re-quoting per attempt means the
   * family is charged the cost of the method that actually paid rather than the one that declined.
   */
  const kind = (ordered.find((m) => m.id === chosenPmId)?.type ?? 'card') === 'us_bank_account' ? 'bank' : 'card';
  const quote = feeQuote(amountCents, kind);
  try {
    const pi = await stripe.paymentIntents.create(
      {
        amount: quote.grossCents,
        currency: getCurrency(),
        customer: fam.stripeCustomerId,
        payment_method: chosenPmId,
        off_session: true,
        confirm: true,
        description: 'Autopay tuition',
        metadata: { purpose: 'students-billing', omos_app: 'students-portal', students_family_id: familyId, students_channel: 'autopay', students_autopay_run_id: runId, ...feeMetadata(quote) },
      },
      { idempotencyKey: `autopay:${runId}` },
    );
    db.update(autopayRuns).set({ stripePaymentIntentId: pi.id, updatedAt: new Date() }).where(eq(autopayRuns.id, runId)).run();
    // An off-session confirm returns the terminal outcome synchronously. Record a success NOW (the
    // ledger is idempotent on the PI id, so a reconciliation replay is a harmless no-op) so the
    // balance clears before the next daily tick — otherwise the family would still read as
    // family "due" tomorrow and we'd charge the card again. A non-'succeeded' status (rare async
    // processing) stays pending for reconciliation; a synchronous decline throws (handled below).
    if (pi.status === 'succeeded') {
      // One card charge, one ledger row PER CHILD. The split walks the family's open invoices
      // oldest-due-first — the same order every other payment path uses, so a confirm-on-return that
      // reconciliation later replays lands on exactly the same children in the same amounts (§11.4).
      // Held in a variable so the alert can report the very split that was recorded, rather than
      // re-deriving one that a concurrent invoice change could make disagree with the ledger.
      //
      // AND ASK FIRST WHETHER THIS PI IS ALREADY IN THE LEDGER (§9's rule for every caller that
      // DERIVES a split rather than being handed one). The window is narrow but real: the Stripe
      // idempotency key is `autopay:${runId}`, so a retry after a crash between `create` and the
      // record below gets the SAME PaymentIntent back — and by then the first pass has paid those
      // invoices down, so re-deriving yields a different, smaller split. Where the original had no
      // open invoice left, `splitAcrossFamily` parks the money as credit on the alphabetically first
      // child; if that child was not in the first split, the per-student key is new and the same
      // money is recorded a second time. Reusing the recorded split makes the retry a no-op instead.
      const done = recordedSplit(pi.id);
      const shares = done.length ? done.map((d) => ({ studentId: d.studentId, amountCents: d.amountCents })) : splitAcrossFamily(familyId, amountCents);
      const res = recordSplit(
        {
          channel: 'autopay',
          occurredAt: new Date(),
          idempotencyKey: pi.id,
          memo: null,
          externalRef: { stripePaymentIntentId: pi.id, stripeChargeId: (pi.latest_charge as string) ?? null },
        },
        shares,
        { userId: null, role: 'autopay', name: 'autopay' },
      );
      if (!res.duplicate) {
        void alertStaff('payment-received', {
          title: 'Tuition payment received',
          // Per child, because that is how the charge was recorded (§9) — a household total would hide
          // which of them it actually cleared.
          text: `${formatMoney(amountCents, getCurrency())} charged by autopay: ${studentAmounts(shares, getCurrency())}.`,
          publicText: `A tuition payment of ${formatMoney(amountCents, getCurrency())} was received (autopay).`,
        });
        void sendReceipt(familyId, formatMoney(amountCents, getCurrency())); // parent receipt (§13.2.5); !duplicate avoids a double with reconciliation
      }
      onAutopaySucceeded(pi.id, runId); // mark the run charged + reset the retry ladder
    }
  } catch (e) {
    const err = e as StripeErrLike;
    // Capture the PI id even on failure (the Stripe error carries it) so reconciliation can link back.
    if (err.payment_intent?.id) db.update(autopayRuns).set({ stripePaymentIntentId: err.payment_intent.id, updatedAt: new Date() }).where(eq(autopayRuns.id, runId)).run();
    if (err.type === 'StripeCardError') {
      // A definite decline (card_declined, insufficient_funds, authentication_required) → advance the ladder.
      log.warn('autopay charge declined', { familyId, code: err.code });
      markRunFailed(runId, today);
    } else {
      // Indeterminate (network / timeout / API error) — the charge MAY have gone through. Leave the run
      // pending (do NOT advance the ladder — a phantom failure could auto-disable early); the daily
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

/** How a card is named to a parent — "Visa ···· 4242", brand and last four only. Never a PAN and never
 *  a holder name; neither is stored (§14). Empty when there is nothing recognizable to say. */
function cardLabelFor(familyId: string): string {
  const pm = orderedMethods(familyId)[0];
  if (!pm) return '';
  const brand = (pm.brand ?? '').trim();
  const last4 = (pm.last4 ?? '').trim();
  if (!brand && !last4) return '';
  const nice = brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : 'card';
  return last4 ? `${nice} ···· ${last4}` : nice;
}

/**
 * Tell the households that autopay will charge them in a few days (0.50.0).
 *
 * Daily, and stateless — see `autopayUpcoming` for the exactly-on-that-day rule that keeps it from
 * becoming a daily message. Best-effort per household: one that cannot be reached must not stop the
 * rest being told.
 */
export async function runAutopayNotice(today: string): Promise<{ notified: number }> {
  const currency = getCurrency();
  let notified = 0;
  for (const u of autopayUpcoming(today)) {
    try {
      await sendAutopayUpcoming(u.familyId, formatMoney(u.amountCents, currency), formatDate(u.on), cardLabelFor(u.familyId));
      notified++;
    } catch (e) {
      log.warn('autopay notice failed for one household', { error: (e as Error).message });
    }
  }
  if (notified) log.info('autopay notices sent', { notified });
  return { notified };
}

/**
 * Tell the households whose saved card is about to expire (0.50.0).
 *
 * Run on the FIRST of the month, which is the whole of its idempotency: a card qualifies while it
 * expires this month or next, so a family gets at most two notices per card — one the month before
 * and one during — and never a daily nag.
 *
 * This is the message that removes an entire failure sequence. Without it a card expires, the next
 * charge declines, the retry ladder runs, autopay switches itself off, and a family discovers three
 * months later that they are behind.
 */
export async function runCardExpiryNotice(today: string): Promise<{ notified: number }> {
  const [y, m] = today.split('-').map(Number);
  if (!y || !m) return { notified: 0 };
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const soon = (em: number | null, ey: number | null) => !!em && !!ey && ((ey === y && em === m) || (ey === nextY && em === nextM));

  let notified = 0;
  for (const e of db.select({ familyId: autopayEnrollments.familyId, defaultPmId: autopayEnrollments.defaultPmId }).from(autopayEnrollments).where(eq(autopayEnrollments.enabled, true)).all()) {
    // The card autopay would actually use — warning about a spare nobody is charging is noise.
    const pm = e.defaultPmId
      ? db.select().from(paymentMethods).where(eq(paymentMethods.id, e.defaultPmId)).get()
      : orderedMethods(e.familyId)[0];
    if (!pm || !soon(pm.expMonth, pm.expYear)) continue;
    try {
      await sendCardExpiring(e.familyId, cardLabelFor(e.familyId), `${String(pm.expMonth).padStart(2, '0')}/${pm.expYear}`);
      notified++;
    } catch (err) {
      log.warn('card expiry notice failed for one household', { error: (err as Error).message });
    }
  }
  if (notified) log.info('card expiry notices sent', { notified });
  return { notified };
}

/** Find an autopay run by OUR run id (always carried in the PI metadata) first, then fall back to the
 *  Stripe PI id. The run id is robust even when the PI id was never persisted — e.g. the create() call
 *  timed out after Stripe had already created (and maybe charged) the intent (§13.3). */
function findRun(runId: string | null | undefined, paymentIntentId: string) {
  const byId = runId ? db.select().from(autopayRuns).where(eq(autopayRuns.id, runId)).get() : undefined;
  return byId ?? db.select().from(autopayRuns).where(eq(autopayRuns.stripePaymentIntentId, paymentIntentId)).get();
}

/** An autopay PI succeeded (from the synchronous confirm or from reconciliation) → mark the run charged,
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
 * ladder: nothing was ever presented to the card, so counting it as a strike would penalize the
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

/** Shared failure handling (a synchronous decline, or one reconciliation resolved): advance the ladder. Acts ONLY on
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
    // rather than only the masjid webhook, which most installs never configure.
    //
    // The children, not a household label. A card and an autopay enrollment DO belong to the household
    // — one adult holds the card for all of them — so this names the children it pays FOR rather than
    // claiming a child owns the card. Either way the office gets the names their records are keyed by.
    void alertStaff('autopay-disabled', {
      title: 'Autopay switched off',
      text: `Autopay for ${childrenOf(run.familyId)} has been turned off after three failed card charges. They will not be charged again until someone follows up.`,
      publicText: 'Autopay was turned off for a family after three failed charge attempts.',
    });
    void sendAutopayFailure(run.familyId, true); // parent: autopay is now off — pay now + update card (§13.3)
  } else {
    // Retry on day +2 (after the 1st failure) then day +5 (after the 2nd).
    db.update(autopayEnrollments).set({ failureCount, nextAttemptAt: addDays(runDate, failureCount === 1 ? 2 : 3), updatedAt: ts }).where(eq(autopayEnrollments.familyId, run.familyId)).run();
    void alertStaff('autopay-failed', {
      title: 'An autopay charge failed',
      text: `The card paying for ${childrenOf(run.familyId)} was declined (attempt ${failureCount} of 3). We will try again in a few days; they have been emailed.`,
      publicText: `An autopay charge was declined (attempt ${failureCount} of 3). A retry is scheduled.`,
    });
    void sendAutopayFailure(run.familyId, false); // parent: charge failed, we'll retry — or pay now (§13.3)
  }
}
