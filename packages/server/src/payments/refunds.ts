// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Refunds (0.48.0) — giving money back, whichever way it arrived.
 *
 * WHAT WAS THERE BEFORE, AND WHY IT WAS NOT ENOUGH. `ledger.reversePayment` writes the mirror rows that
 * undo a payment on the ledger, and a "Reverse" button inside a household's record called it. For cash
 * that is the whole job. For a CARD it was a half-truth: the office pressed Reverse, the balance went back
 * up, the parent's money stayed with Stripe, and nothing in the app ever said so. This module is the other
 * half — the money actually leaves the masjid's Stripe account — and it is the only place that should be
 * used from now on, because it does both halves in the right order.
 *
 * A TRANSACTION IS THE UNIT, NOT A ROW. One card charge covering three children is THREE `payments` rows,
 * keyed `${idempotencyKey}:${studentId}` (§9), because bills are per child. Refunding one of those rows
 * while asking Stripe for the whole charge would put the ledger and Stripe permanently out of step. So
 * everything here groups by the Stripe PaymentIntent where there is one, and refunds the group.
 *
 * ORDER MATTERS, AND SO DOES WHICH FAILURE IS SURVIVABLE:
 *   1. Stripe first. If the refund is refused, nothing is written — the ledger keeps saying the money is
 *      here, which is true.
 *   2. Then the ledger reversals. If one of those throws after Stripe succeeded, the money HAS gone and
 *      the log says so loudly; `reversePayment` is idempotent, so pressing Refund again finishes the job
 *      rather than refunding twice.
 * The reverse order — ledger first — would mean a refused card refund leaving the office believing a
 * family had been paid back.
 *
 * FULL REFUNDS ONLY, on purpose. Every mirror row `reversePayment` writes is derived from the original's
 * own allocations, line for line, which is what keeps a reversed directed payment from leaving its line
 * looking settled. A partial refund has no such derivation — it would need new money math in a second
 * place, and §16 keeps money math in one. The office's tool for giving part of it back is a credit on the
 * next bill (a negative charge), which is already there and already tested.
 */
import { desc, eq, inArray, like, or } from 'drizzle-orm';
import { db } from '../db';
import { payments, students } from '../db/schema';
import { reversePayment } from '../billing/ledger';

/** The same shape `ledger.ts` uses — declared here rather than widening its export for one caller. */
type Actor = { userId: string | null; role: string; name: string | null };
import { stripeClient, stripeReady } from './stripe';
import { makeLog } from '../logger';

const log = makeLog('refunds');

/** How money can be sent back for a given transaction. */
export type RefundRoute =
  /** It came through Stripe: the refund is automatic and the parent gets it back the way they paid. */
  | 'stripe'
  /** Cash, a check, a bank transfer, a carried-in balance: the ledger can be put right, but a person has
   *  to hand the money over. Saying which of the two it is, up front, is the whole point of the split. */
  | 'manual';

export interface RefundableTx {
  /** The group: a Stripe PaymentIntent id when there is one, otherwise the single payment's id. */
  key: string;
  channel: string;
  occurredAt: Date;
  /** The total across every child the transaction covered. */
  amountCents: number;
  route: RefundRoute;
  /** Already reversed — the button is spent, and the row says so rather than disappearing. */
  refunded: boolean;
  memo: string | null;
  /** Who took it, when a person did. */
  recordedByName: string | null;
  /** One entry per child, because that is how the money landed. */
  parts: { paymentId: string; studentId: string; studentName: string; amountCents: number }[];
}

const piOf = (externalRef: Record<string, unknown> | null): string | null => {
  const v = externalRef?.stripePaymentIntentId;
  return typeof v === 'string' && v ? v : null;
};

/**
 * Recent transactions, newest first, grouped as above.
 *
 * `limit` counts TRANSACTIONS, so a page of twenty is twenty things the office can act on rather than
 * twenty rows that might be seven charges. It over-reads the payment rows to fill that, which is why the
 * query limit is separate and larger.
 */
export function refundableTransactions(opts: { limit?: number; query?: string } = {}): RefundableTx[] {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 25));
  const needle = (opts.query ?? '').trim().toLowerCase();

  const rows = db
    .select({
      id: payments.id,
      studentId: payments.studentId,
      amountCents: payments.amountCents,
      channel: payments.channel,
      occurredAt: payments.occurredAt,
      memo: payments.memo,
      externalRef: payments.externalRef,
      reversalOf: payments.reversalOf,
      recordedByName: payments.recordedByName,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .orderBy(desc(payments.occurredAt), desc(payments.createdAt))
    .limit(limit * 20)
    .all();

  // Which originals already have their mirror. Read once for the whole page rather than per row.
  const reversedIds = new Set(
    db.select({ reversalOf: payments.reversalOf }).from(payments).where(inArray(payments.reversalOf, rows.map((r) => r.id))).all()
      .map((r) => r.reversalOf)
      .filter((v): v is string => !!v),
  );
  const nameById = new Map(
    db.select({ id: students.id, fullName: students.fullName }).from(students).where(inArray(students.id, [...new Set(rows.map((r) => r.studentId))])).all()
      .map((s) => [s.id, s.fullName]),
  );

  const groups = new Map<string, RefundableTx>();
  for (const r of rows) {
    // Mirror rows are not transactions anybody refunds; they ARE the refund.
    if (r.reversalOf) continue;
    const pi = piOf(r.externalRef);
    const key = pi ?? r.id;
    const name = nameById.get(r.studentId) ?? '';
    if (needle && !`${name} ${r.channel} ${r.memo ?? ''} ${pi ?? ''}`.toLowerCase().includes(needle)) continue;

    const g = groups.get(key);
    if (g) {
      g.amountCents += r.amountCents;
      g.parts.push({ paymentId: r.id, studentId: r.studentId, studentName: name, amountCents: r.amountCents });
      // A group counts as refunded only when EVERY row in it has been reversed — a half-reversed group is
      // still refundable, and pressing Refund finishes it.
      g.refunded = g.refunded && reversedIds.has(r.id);
    } else {
      groups.set(key, {
        key,
        channel: r.channel,
        occurredAt: r.occurredAt,
        amountCents: r.amountCents,
        route: pi && stripeReady() ? 'stripe' : 'manual',
        refunded: reversedIds.has(r.id),
        memo: r.memo,
        recordedByName: r.recordedByName,
        parts: [{ paymentId: r.id, studentId: r.studentId, studentName: name, amountCents: r.amountCents }],
      });
    }
  }
  return [...groups.values()].slice(0, limit);
}

/**
 * Every live payment row of one transaction.
 *
 * Found by IDEMPOTENCY KEY rather than by scanning: §9 fixes that key as the Stripe PaymentIntent id for
 * every channel, and `recordSplit` suffixes `:studentId` when one charge fans out over several children.
 * So one `LIKE` on a unique-indexed column finds the whole group, where filtering the JSON `externalRef`
 * in JavaScript would mean reading every payment the madrasah has ever taken.
 *
 * The `externalRef` check afterwards is the belt and braces: a manual payment whose memo-shaped key
 * happened to collide with a PaymentIntent id must not be swept into someone else's refund.
 */
function rowsOf(key: string) {
  const direct = db.select().from(payments).where(eq(payments.id, key)).get();
  // A single manual payment is identified by its own row id; there is no group to gather.
  if (direct && !piOf(direct.externalRef)) return [direct];

  const group = db
    .select()
    .from(payments)
    .where(or(eq(payments.idempotencyKey, key), like(payments.idempotencyKey, `${key}:%`)))
    .all()
    .filter((p) => !p.reversalOf && piOf(p.externalRef) === key);
  if (group.length) return group;
  return direct ? [direct] : [];
}

export interface RefundResult {
  route: RefundRoute;
  /** Cents actually reversed on the ledger this time round. */
  amountCents: number;
  /** Rows reversed, one per child. */
  reversed: number;
  /** Set when Stripe sent the money back; `pending` for a bank refund, which takes days. */
  stripeRefundId: string | null;
  stripeStatus: string | null;
  alreadyDone: boolean;
}

/**
 * Give a whole transaction back.
 *
 * Idempotent at both ends: Stripe by request key, the ledger because `reversePayment` returns the existing
 * mirror rather than writing a second one. Pressing Refund twice refunds once.
 */
export async function refundTransaction(key: string, actor: Actor): Promise<RefundResult> {
  const rows = rowsOf(key);
  if (!rows.length) throw new Error('payment not found');
  if (rows.some((r) => r.amountCents <= 0)) throw new Error('that is not a payment');

  const pi = piOf(rows[0].externalRef);
  const alreadyReversed = new Set(
    db.select({ reversalOf: payments.reversalOf }).from(payments).where(inArray(payments.reversalOf, rows.map((r) => r.id))).all()
      .map((r) => r.reversalOf)
      .filter((v): v is string => !!v),
  );
  const outstanding = rows.filter((r) => !alreadyReversed.has(r.id));
  if (!outstanding.length) {
    return { route: pi ? 'stripe' : 'manual', amountCents: 0, reversed: 0, stripeRefundId: null, stripeStatus: null, alreadyDone: true };
  }

  let stripeRefundId: string | null = null;
  let stripeStatus: string | null = null;
  let route: RefundRoute = 'manual';

  if (pi) {
    const stripe = stripeClient();
    if (!stripe) {
      // Refusing is the honest answer: the ledger must not say a card was refunded while the charge is
      // still with Stripe. It is a temporary condition (keys come from the platform, §13.1).
      throw new Error('card_refunds_unavailable');
    }
    route = 'stripe';
    // The whole charge, not a per-child slice — see the header. The idempotency key is derived from the
    // PaymentIntent, so a double press (or a retry after a timeout) cannot refund twice.
    const refund = await stripe.refunds.create({ payment_intent: pi }, { idempotencyKey: `students-refund:${pi}` });
    stripeRefundId = refund.id;
    stripeStatus = refund.status ?? null;
    if (refund.status === 'failed' || refund.status === 'canceled') {
      throw new Error(`refund_${refund.status}`);
    }
  }

  // Stripe has paid it back (or there was nothing to pay back). Now the ledger. A throw here leaves money
  // out and the ledger behind — logged loudly, and fixed by pressing Refund again, which reverses only
  // what is still outstanding.
  let reversed = 0;
  let amountCents = 0;
  for (const r of outstanding) {
    try {
      reversePayment(r.id, actor);
      reversed++;
      amountCents += r.amountCents;
    } catch (e) {
      log.error('refunded at Stripe but the ledger reversal failed — press Refund again to finish', {
        paymentId: r.id,
        stripeRefundId,
        error: (e as Error).message,
      });
      throw e;
    }
  }
  log.info('refund recorded', { key, route, reversed, stripeRefundId, stripeStatus });
  return { route, amountCents, reversed, stripeRefundId, stripeStatus, alreadyDone: false };
}
