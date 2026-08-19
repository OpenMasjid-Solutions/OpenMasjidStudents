// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Stripe reconciliation (CLAUDE.md §11.4) — the safety net. A daily job + an on-demand "Reconcile
 * now" button (finance) list every SUCCEEDED PaymentIntent tagged `metadata.purpose ==
 * "students-billing"` since the last cursor and record any whose PI id isn't already an idempotency
 * key, flagged `via: reconciliation`. This covers BOTH a missed broker call from Donations/Kiosk
 * AND our own portal/autopay intents whose confirm-on-return never happened (a browser closed
 * mid-payment, a dropped tunnel) — so money is never lost, only delayed. There is no webhook (§13.4).
 *
 * Recording goes through the ONE ledger path (idempotency key = the PI id), so a reconcile that
 * overlaps a late broker call, or a re-run over the same window, is a harmless no-op. Recording an
 * autopay PI here also resolves a stuck-'pending' autopay run (a success whose confirm never landed).
 */
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { payments } from '../db/schema';
import type { PaymentChannel } from '../db/schema';
import { recordSplit, splitAcrossFamily, recordedSplit } from '../billing/ledger';
import { onAutopaySucceeded, onAutopayFailed, abandonRun, pendingRuns } from './autopay';
import { stripeClient, loadStripeKeys } from './stripe';
import { getSetting, setSetting, SETTING_KEYS, getCurrency } from '../settings';
import { formatMoney } from '../db/money';
import { audit, type AuditActor } from '../audit';
import { alertStaff, studentAmounts } from '../alerts';
import { makeLog } from '../logger';
import { netOfIntent } from './fees';

const log = makeLog('reconcile');

/** First-run look-back when no cursor is stored yet (seconds) — a month of history to catch up. */
const FIRST_RUN_LOOKBACK_SEC = 35 * 24 * 60 * 60;

/** Stripe PaymentIntent statuses that will never change again without a new action from us. */
const TERMINAL_FAILURE = new Set(['canceled', 'requires_payment_method']);
/** Still in flight — leave the run pending and look again next pass. */
const STILL_WORKING = new Set(['processing', 'requires_action', 'requires_confirmation', 'requires_capture']);

/**
 * Resolve autopay runs stuck at `pending`, which nothing else can do now that there is no webhook.
 *
 * For each stuck run, ask Stripe what actually happened:
 *   - `succeeded`                                → resolve the run + reset the ladder (the main scan
 *                                                  above books the money; this just unblocks billing)
 *   - `canceled` / `requires_payment_method`     → a real decline → advance the retry ladder
 *   - `processing` / `requires_action` / …       → genuinely unresolved, leave it alone
 *   - no PaymentIntent exists for the run at all → `paymentIntents.create` threw before returning an
 *                                                  id, so NOTHING was charged. Close the run without
 *                                                  advancing the ladder (see `abandonRun`).
 *
 * The no-id case is found by searching `metadata["students_autopay_run_id"]`, which is exactly why we
 * stamp the run id onto every autopay PI. Never guesses: if Stripe can't be reached the run is left
 * pending, because wrongly deciding "no charge happened" is how you double-bill someone.
 */
export async function resolveStuckRuns(actor: AuditActor): Promise<{ checked: number; resolved: number }> {
  const stripe = stripeClient();
  if (!stripe) return { checked: 0, resolved: 0 };
  const stuck = pendingRuns();
  let resolved = 0;

  for (const run of stuck) {
    try {
      let pi: { id: string; status: string } | null = null;
      if (run.stripePaymentIntentId) {
        const got = await stripe.paymentIntents.retrieve(run.stripePaymentIntentId);
        pi = { id: got.id, status: got.status };
      } else {
        const found = await stripe.paymentIntents.search({ query: `metadata["students_autopay_run_id"]:"${run.id}"`, limit: 1 });
        const first = found.data[0];
        pi = first ? { id: first.id, status: first.status } : null;
      }

      if (!pi) {
        // Confirmed: Stripe has no PaymentIntent for this run, so no money moved.
        if (abandonRun(run.id)) {
          resolved++;
          audit(actor, 'autopay.run.abandoned', { entity: 'family', entityId: run.familyId, detail: { runId: run.id, runDate: run.runDate } });
          log.warn('autopay run had no PaymentIntent at Stripe — closed without a strike', { runId: run.id });
        }
        continue;
      }
      if (STILL_WORKING.has(pi.status)) continue; // genuinely in flight
      if (pi.status === 'succeeded') {
        onAutopaySucceeded(pi.id, run.id);
        resolved++;
        continue;
      }
      if (TERMINAL_FAILURE.has(pi.status)) {
        onAutopayFailed(pi.id, run.id);
        resolved++;
        audit(actor, 'autopay.run.failed', { entity: 'family', entityId: run.familyId, detail: { runId: run.id, stripeStatus: pi.status } });
        log.warn('autopay run resolved as failed by reconciliation', { runId: run.id, status: pi.status });
      }
    } catch (e) {
      // Leave it pending — an unreachable Stripe must never be read as "no charge happened".
      log.warn('could not resolve stuck autopay run — will retry next pass', { runId: run.id, error: (e as Error).message });
    }
  }
  return { checked: stuck.length, resolved };
}

export interface ReconcileResult {
  ok: boolean; // false only when Stripe isn't configured (nothing to do)
  scanned: number;
  recorded: number;
  ranAt: string;
}

/** Map a students-billing PI's metadata (§11.3) to our ledger channel. Returns null for an
 *  unrecognized origin — we only record what we can attribute. */
function channelFor(md: Record<string, string>): PaymentChannel | null {
  switch (md.omos_app) {
    case 'donations':
      return 'donations-web';
    case 'kiosk':
      return 'kiosk';
    case 'students-portal':
      return md.students_channel === 'autopay' ? 'autopay' : 'portal';
    default:
      return null;
  }
}

/** Has this PI reached the ledger? Asks via `recordedSplit`, not an exact key match, because one PI
 *  covering several children is stored as one row per child under `${piId}:${studentId}` — an exact
 *  match would report "not recorded" for every split payment and reconcile it a second time. */
function alreadyRecorded(piId: string): boolean {
  return recordedSplit(piId).length > 0;
}

/** Run one reconciliation pass. Safe to run concurrently with a broker call and safe to re-run. */
export async function reconcile(actor: AuditActor): Promise<ReconcileResult> {
  const ranAt = new Date().toISOString();
  let stripe = stripeClient();
  if (!stripe) {
    await loadStripeKeys();
    stripe = stripeClient();
  }
  if (!stripe) {
    log.info('reconcile skipped — Stripe not configured');
    return { ok: false, scanned: 0, recorded: 0, ranAt };
  }

  const nowSec = Math.floor(Date.parse(ranAt) / 1000);
  const cursor = Number(getSetting(SETTING_KEYS.reconcileCursor)) || nowSec - FIRST_RUN_LOOKBACK_SEC;
  // Re-scan a 1-second overlap so a PI created in the cursor's exact second is never skipped
  // (Stripe search has no >= operator); the ledger's PI-id idempotency makes the overlap a no-op.
  const since = Math.max(0, cursor - 1);
  const query = `status:"succeeded" AND metadata["purpose"]:"students-billing" AND created>${since}`;

  let scanned = 0;
  let recorded = 0;
  let maxCreated = cursor;
  // The earliest created-time of a PI we scanned but could NOT durably record (a transient record
  // throw — e.g. a DB write error, or a family row that isn't there yet). The persisted cursor is
  // capped strictly below this so the PI is re-scanned next run and never silently skipped — money is
  // never lost (recording stays idempotent, so the re-scan is a no-op once it succeeds). Unattributable
  // PIs (no family / unknown origin) are TERMINAL — they can never be recorded, so they don't hold the
  // cursor back (that would wedge the scan forever); we surface them in the log for manual handling.
  let earliestErrored = Infinity;
  let page: string | undefined;
  try {
    for (;;) {
      const res = await stripe.paymentIntents.search({ query, limit: 100, ...(page ? { page } : {}) });
      for (const pi of res.data) {
        scanned++;
        if (pi.created > maxCreated) maxCreated = pi.created;
        const md = (pi.metadata ?? {}) as Record<string, string>;
        if (alreadyRecorded(pi.id)) {
          // Already captured (a broker call, or the synchronous confirm) — but a run can still be stuck
          // 'pending' if the success path crashed after the ledger write but before resolving the run
          // and the confirm was lost too. Heal it here (idempotent) so chargeFamily's pending-run
          // guard doesn't silently block the family's future charges.
          if (channelFor(md) === 'autopay') onAutopaySucceeded(pi.id, md.students_autopay_run_id);
          continue;
        }
        const familyId = md.students_family_id;
        const channel = channelFor(md);
        /**
         * THE TUITION, not what was charged (0.51.0). This job is the whole reason the processing fee
         * travels in the PI's own metadata rather than in a setting: it runs a day later, it never saw
         * the request, and the office may have changed the rate or switched the feature off in between.
         * The figure that was true when the payer agreed to it is the one carried on the charge
         * (payments/fees.ts). A consumer that grossed up without writing the key is credited its full
         * charge — the safe direction, and the contract says so in §11.3.
         */
        const amount = netOfIntent(pi.amount_received || pi.amount || 0, md);
        if (!familyId || !channel || amount <= 0) {
          // A succeeded tuition PI we can't attribute (missing family id / unknown origin). It can
          // never be recorded, so let the cursor pass it — but surface it so finance can reconcile
          // by hand rather than have it silently retried forever (no PII: the PI id + app only).
          log.warn('reconcile: unattributable tuition PI skipped', { pi: pi.id, omosApp: md.omos_app || null });
          continue;
        }
        try {
          // Payments are per student, but a PI only carries a family (and optionally the one student
          // it was matched to). `splitAcrossFamily` walks that family's open invoices oldest-due-first
          // — the same deterministic order the original push path used — so the split we reproduce
          // here is the one that charge would have produced had its confirm landed.
          const shares = splitAcrossFamily(familyId, amount, md.students_student_id || null);
          if (!shares.length) {
            // The family has no student to attribute to — because the family row does not exist yet,
            // or its children have not been imported yet. RETRYABLE, not terminal: hold the cursor
            // below this PI so a later run picks it up once the roster catches up. Skipping would
            // advance the cursor past real money and lose it, which §11.4 exists to prevent.
            if (pi.created < earliestErrored) earliestErrored = pi.created;
            log.warn('reconcile: tuition PI has no student to attribute to yet — will retry', { pi: pi.id });
            continue;
          }
          const r = recordSplit(
            {
              channel,
              occurredAt: new Date(pi.created * 1000),
              idempotencyKey: pi.id,
              memo: null,
              externalRef: { stripePaymentIntentId: pi.id, stripeChargeId: (pi.latest_charge as string) ?? null, via: 'reconciliation' },
            },
            shares,
            { userId: null, role: channel, name: 'reconciliation' },
          );
          if (!r.duplicate) {
            recorded++;
            // A recovered autopay success resolves its stuck-'pending' run + resets the retry ladder.
            if (channel === 'autopay') onAutopaySucceeded(pi.id, md.students_autopay_run_id);
            audit(actor, 'payment.reconcile', { entity: 'family', entityId: familyId, detail: { channel, amountCents: amount, stripePaymentIntentId: pi.id } });
            // An alert: a payment reaching Stripe but not the ledger directly means a push path
            // failed, which someone should look at rather than have it vanish into an unset webhook.
            // `info`, not the default `warning`: the money was recovered, so this is a notice that a
            // push path needs looking at — not something going wrong right now.
            void alertStaff('payment-recovered', {
              title: 'A missed payment was recovered',
              text: `A ${formatMoney(amount, getCurrency())} payment (${channel}) reached Stripe but not the ledger, so the daily check recorded it: ${studentAmounts(shares, getCurrency())}. The money is safe; the push path is worth a look.`,
              publicText: `A previously-missed tuition payment of ${formatMoney(amount, getCurrency())} was recorded (${channel}).`,
            });
          }
        } catch (e) {
          // A transient write failure on ONE PI must not abort the pass — but must NOT let the cursor
          // pass it either. Hold the cursor below it so the next run retries it (idempotent).
          if (pi.created < earliestErrored) earliestErrored = pi.created;
          log.warn('reconcile record failed — will retry next run', { pi: pi.id, error: (e as Error).message });
        }
      }
      if (!res.has_more || !res.next_page) break;
      page = res.next_page;
    }
  } catch (e) {
    // Stripe unreachable / search error: keep whatever we recorded, do NOT advance the cursor, and
    // let the next run retry the same window (recording stays idempotent).
    log.error('reconcile scan failed', { error: (e as Error).message });
    return { ok: true, scanned, recorded, ranAt };
  }

  // Also hold the cursor below any tuition PI still PENDING (async settling / SCA) in this window:
  // otherwise a later-created SUCCEEDED PI advances the cursor past it, and its eventual success would
  // never be re-scanned — money silently unbooked. This is load-bearing because there is no webhook
  // (reconcile is the sole backstop for a portal pay-now the browser didn't confirm). Best-effort: a
  // failed pending scan just leaves the cursor at maxCreated (the rare async case → a manual reconcile).
  let earliestPending = Infinity;
  try {
    const pendingQuery = `metadata["purpose"]:"students-billing" AND (status:"processing" OR status:"requires_action") AND created>${since}`;
    let ppage: string | undefined;
    for (;;) {
      const pres = await stripe.paymentIntents.search({ query: pendingQuery, limit: 100, ...(ppage ? { page: ppage } : {}) });
      for (const p of pres.data) if (p.created < earliestPending) earliestPending = p.created;
      if (!pres.has_more || !pres.next_page) break;
      ppage = pres.next_page;
    }
  } catch (e) {
    log.warn('reconcile pending scan failed — cursor not held for pending PIs this run', { error: (e as Error).message });
  }

  // Resolve autopay runs stuck at 'pending'. This scan is SEPARATE from the succeeded-PI scan above
  // and is not optional: the scan above only ever sees status:"succeeded", so a run whose PI ended in a
  // TERMINAL FAILURE was never resolved by anything, stayed 'pending' forever, and the pending-run
  // guard in chargeFamily then blocked that family from ever being charged again. Silent, and it looks
  // exactly like "autopay stopped working" months later.
  const stuck = await resolveStuckRuns(actor);

  // Never advance the cursor to/past a PI that errored on record OR is still pending — cap it strictly
  // below the earliest such PI so it is re-scanned once it succeeds (money is never silently skipped, §11.4).
  const holdBelow = Math.min(earliestErrored, earliestPending);
  const nextCursor = holdBelow === Infinity ? maxCreated : Math.min(maxCreated, holdBelow - 1);
  setSetting(SETTING_KEYS.reconcileCursor, String(nextCursor));
  setSetting(SETTING_KEYS.reconcileLast, JSON.stringify({ ranAt, scanned, recorded, stuckResolved: stuck.resolved }));
  log.info('reconcile complete', { scanned, recorded, stuckChecked: stuck.checked, stuckResolved: stuck.resolved });
  return { ok: true, scanned, recorded, ranAt };
}

/** The last reconcile run's summary, for the finance UI (null before the first run). */
export function reconcileStatus(): { ranAt: string; scanned: number; recorded: number } | null {
  const raw = getSetting(SETTING_KEYS.reconcileLast);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { ranAt: string; scanned: number; recorded: number };
  } catch {
    return null;
  }
}
