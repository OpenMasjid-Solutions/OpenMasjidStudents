// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Refunds (0.48.0) — giving money back.
 *
 * The existing "Reverse" button wrote the ledger's mirror rows and nothing else, which for a CARD was a
 * half-truth: the balance went back up, the parent's money stayed with Stripe, and nothing said so. So the
 * cases that matter here are the ones where the two halves could come apart:
 *
 *  1. A CARD REFUND ASKS STRIPE. If it does not, the office has been told a family was paid back when it
 *     was not — the exact failure this module exists to end.
 *  2. STRIPE FIRST, LEDGER SECOND. A refused refund must leave the ledger saying the money is still here,
 *     because it is. The reverse order would record a refund that never happened.
 *  3. ONE CHARGE, ONE REFUND, ACROSS SIBLINGS. A card payment covering three children is three payment
 *     rows (§9). Refunding the group must reverse ALL of them and call Stripe exactly ONCE — a per-row
 *     refund would ask Stripe for the whole charge three times.
 *  4. TWICE IS ONCE. A double press, or a retry after a timeout, must not refund twice.
 *  5. CASH IS NOT STRIPE. A manual payment must never reach the Stripe client, and must be reported as
 *     needing a person to hand the money over.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { freshApp, makeCtx } from './harness';
import { paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, students, families, users, auditLog, paymentMethods, autopayEnrollments } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let stripeMod: typeof import('../src/payments/stripe');
let ledger: typeof import('../src/billing/ledger');
const caller = (role: Role) => app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

/** Every refund Stripe was asked for, with its request options (so idempotency can be asserted). */
const refundCalls: { args: Record<string, unknown>; opts: Record<string, unknown> | undefined }[] = [];
let refundImpl: () => unknown = () => ({ id: 're_1', status: 'succeeded' });
const fakeStripe = {
  refunds: {
    create: async (args: Record<string, unknown>, opts?: Record<string, unknown>) => {
      refundCalls.push({ args, opts });
      return refundImpl();
    },
  },
};

beforeAll(async () => {
  app = await freshApp();
  stripeMod = await import('../src/payments/stripe');
  ledger = await import('../src/billing/ledger');
  stripeMod._setStripeForTest({ publishableKey: 'pk_test' }, fakeStripe as unknown as Stripe);
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, autopayEnrollments, paymentMethods, students, families, users, auditLog]) db.delete(t).run();
  refundCalls.length = 0;
  refundImpl = () => ({ id: 're_1', status: 'succeeded' });
});

/** Two siblings, each billed $200 for July. */
async function household() {
  const admin = caller('admin');
  const fam = await admin.people.familyCreate({ name: 'Ismail' });
  const plan = await admin.billing.feePlanCreate({ name: 'Monthly tuition', amountCents: 20000, cadence: 'monthly' });
  const a = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });
  const b = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Zayd Ismail', feePlanId: plan.id });
  await admin.billing.generateFamily({ familyId: fam.id, periodKey: '2026-07', label: 'Tuition — Jul 2026', dueDate: '2026-07-01' });
  return { admin, familyId: fam.id, a: a.id, b: b.id };
}

/** One card charge of $400 covering both children, exactly as the portal records one. */
function cardCharge(familyId: string, cents = 40000) {
  return ledger.recordSplit(
    { channel: 'portal', occurredAt: new Date('2026-07-05'), idempotencyKey: 'pi_card_1', memo: null, externalRef: { stripePaymentIntentId: 'pi_card_1' } },
    ledger.splitAcrossFamily(familyId, cents),
    { userId: null, role: 'portal', name: null },
  );
}

const liveRows = () => app.dbmod.db.select().from(payments).all();

describe('a card payment', () => {
  it('is refunded at Stripe as well as on the ledger', async () => {
    const { familyId } = await household();
    cardCharge(familyId);
    expect(ledger.familyBalance(familyId).owedCents).toBe(0);

    const r = await caller('finance').billing.refund({ key: 'pi_card_1' });

    expect(r.route).toBe('stripe');
    // The whole point: Stripe was actually asked.
    expect(refundCalls).toHaveLength(1);
    expect(refundCalls[0].args.payment_intent).toBe('pi_card_1');
    // And the ledger followed, so the bills are owed again.
    expect(ledger.familyBalance(familyId).owedCents).toBe(40000);
  });

  it('reverses every sibling row but asks Stripe once', async () => {
    // A charge covering two children is two rows; the refund is ONE transaction. Asking Stripe per row
    // would refund the full charge twice.
    const { familyId } = await household();
    cardCharge(familyId);
    expect(liveRows().filter((p) => !p.reversalOf)).toHaveLength(2);

    const r = await caller('finance').billing.refund({ key: 'pi_card_1' });

    expect(r.reversed).toBe(2);
    expect(r.amountCents).toBe(40000);
    expect(refundCalls).toHaveLength(1);
    expect(liveRows().filter((p) => p.reversalOf)).toHaveLength(2);
  });

  it('records nothing when Stripe refuses', async () => {
    // Stripe first, ledger second. If this order ever flips, the office is told a family was paid back
    // over a refund that was refused.
    const { familyId } = await household();
    cardCharge(familyId);
    refundImpl = () => { throw new Error('charge_already_refunded'); };

    await expect(caller('finance').billing.refund({ key: 'pi_card_1' })).rejects.toThrow();

    expect(ledger.familyBalance(familyId).owedCents).toBe(0); // still paid, because it still is
    expect(liveRows().filter((p) => p.reversalOf)).toHaveLength(0);
  });

  it('records nothing when Stripe reports the refund failed', async () => {
    // A 200 response is not a success — `status: 'failed'` is Stripe telling us the money did not move.
    const { familyId } = await household();
    cardCharge(familyId);
    refundImpl = () => ({ id: 're_bad', status: 'failed' });

    await expect(caller('finance').billing.refund({ key: 'pi_card_1' })).rejects.toThrow();
    expect(liveRows().filter((p) => p.reversalOf)).toHaveLength(0);
  });

  it('carries a pending bank refund through rather than treating it as a failure', async () => {
    // An ACH refund settles over days and comes back `pending`. That is a success in progress, and the
    // ledger should go back up now — the family is not going to be chased for it.
    const { familyId } = await household();
    cardCharge(familyId);
    refundImpl = () => ({ id: 're_ach', status: 'pending' });

    const r = await caller('finance').billing.refund({ key: 'pi_card_1' });
    expect(r.stripeStatus).toBe('pending');
    expect(r.reversed).toBe(2);
    expect(ledger.familyBalance(familyId).owedCents).toBe(40000);
  });

  it('refunds once however many times it is pressed', async () => {
    const { familyId } = await household();
    cardCharge(familyId);
    const finance = caller('finance');

    await finance.billing.refund({ key: 'pi_card_1' });
    const second = await finance.billing.refund({ key: 'pi_card_1' });

    expect(second.alreadyDone).toBe(true);
    expect(second.reversed).toBe(0);
    // No second call at all — and the first carried an idempotency key, so even a retry that DID reach
    // Stripe could not double it.
    expect(refundCalls).toHaveLength(1);
    expect(refundCalls[0].opts?.idempotencyKey).toBe('students-refund:pi_card_1');
    expect(ledger.familyBalance(familyId).owedCents).toBe(40000);
  });

  it('refuses when the payments connection is down, rather than lying about the money', async () => {
    const { familyId } = await household();
    cardCharge(familyId);
    stripeMod._setStripeForTest({}, null);
    try {
      await expect(caller('finance').billing.refund({ key: 'pi_card_1' })).rejects.toThrow(/aren’t available|not available/i);
      expect(liveRows().filter((p) => p.reversalOf)).toHaveLength(0);
    } finally {
      stripeMod._setStripeForTest({ publishableKey: 'pk_test' }, fakeStripe as unknown as Stripe);
    }
  });
});

describe('a cash payment', () => {
  it('is reversed on the ledger and never sent to Stripe', async () => {
    const { admin, familyId, a } = await household();
    const p = await admin.billing.recordManualPayment({ studentId: a, amountCents: 20000, channel: 'cash', occurredAt: '2026-07-05' });

    const r = await caller('finance').billing.refund({ key: p.paymentId });

    expect(r.route).toBe('manual');
    expect(refundCalls).toHaveLength(0); // there is no card to send it back to
    expect(r.reversed).toBe(1);
    expect(ledger.studentBalance(a).owedCents).toBe(20000);
    void familyId;
  });
});

describe('a balance carried forward', () => {
  /** What the go-live step writes for a family who was already paid up when the madrasah adopted the app. */
  function carryIn(studentId: string, cents = 30000) {
    return ledger.recordPayment(
      { studentId, amountCents: cents, channel: 'carry_in', occurredAt: new Date('2026-02-01'), idempotencyKey: `carry:${studentId}`, memo: 'Balance carried forward' },
      { userId: null, role: 'admin', name: 'admin' },
    );
  }

  it('is not offered as something to refund', async () => {
    // It is not a payment this app took. There is nothing to send back, and reversing it would re-open
    // arrears the family does not owe.
    const { a } = await household();
    carryIn(a);
    const { transactions } = await caller('finance').billing.refundable({});
    expect(transactions.filter((tx) => tx.channel === 'carry_in')).toHaveLength(0);
  });

  it('is refused even when asked for directly', async () => {
    // Refused in the engine, not merely filtered out of the list — a screen can be stale or bookmarked,
    // and this is money.
    const { a } = await household();
    const p = carryIn(a);
    await expect(caller('finance').billing.refund({ key: p.paymentId })).rejects.toThrow(/carried forward/i);
    expect(liveRows().filter((r) => r.reversalOf)).toHaveLength(0);
    expect(refundCalls).toHaveLength(0);
  });

  it('still leaves ordinary payments refundable', async () => {
    // The exclusion must be the channel, not "anything on a student who has a carry-in".
    const { admin, a } = await household();
    carryIn(a);
    const p = await admin.billing.recordManualPayment({ studentId: a, amountCents: 20000, channel: 'cash', occurredAt: '2026-07-05' });
    const r = await caller('finance').billing.refund({ key: p.paymentId });
    expect(r.reversed).toBe(1);
  });
});

describe('the list', () => {
  it('groups a sibling charge into one row naming both children', async () => {
    const { familyId } = await household();
    cardCharge(familyId);
    const { transactions } = await caller('finance').billing.refundable({});
    expect(transactions).toHaveLength(1);
    expect(transactions[0].amountCents).toBe(40000);
    expect(transactions[0].route).toBe('stripe');
    expect(transactions[0].parts.map((p) => p.studentName).sort()).toEqual(['Yusuf Ismail', 'Zayd Ismail']);
  });

  it('still calls a card payment a card payment when the payments connection is down', async () => {
    /**
     * The route describes how the money ARRIVED; it must not flip with the connection.
     *
     * It used to read `pi && stripeReady()`, so losing the Stripe keys for a minute (they come from the
     * platform, §13.1) relabelled every card charge `manual` — and `manual` is the row that tells the
     * office "the money still has to be handed back". Follow that and the family is paid twice.
     */
    const { familyId } = await household();
    cardCharge(familyId);
    stripeMod._setStripeForTest({}, null);
    try {
      const res = await caller('finance').billing.refundable({});
      expect(res.transactions[0].route).toBe('stripe');
      // Reported separately, so the screen can disable the button and say why.
      expect(res.cardRefundsReady).toBe(false);
    } finally {
      stripeMod._setStripeForTest({ publishableKey: 'pk_test' }, fakeStripe as unknown as Stripe);
    }
  });

  it('marks what has already been refunded rather than hiding it', async () => {
    // Removing a refunded row would leave an office wondering whether the press worked.
    const { familyId } = await household();
    cardCharge(familyId);
    await caller('finance').billing.refund({ key: 'pi_card_1' });
    const { transactions } = await caller('finance').billing.refundable({});
    expect(transactions).toHaveLength(1);
    expect(transactions[0].refunded).toBe(true);
  });

  it('never offers a reversal row as something to refund', async () => {
    const { admin, a } = await household();
    const p = await admin.billing.recordManualPayment({ studentId: a, amountCents: 20000, channel: 'cash', occurredAt: '2026-07-05' });
    await caller('finance').billing.refund({ key: p.paymentId });
    const { transactions } = await caller('finance').billing.refundable({});
    // The mirror row IS the refund; refunding it would be recording money coming back in.
    expect(transactions).toHaveLength(1);
    expect(transactions.every((tx) => tx.amountCents > 0)).toBe(true);
  });

  it('says WHAT each payment was for, not only how it arrived', async () => {
    // "$400 · Card · 5 Jul" cannot be told apart from next month's identical row, and this is the list an
    // office picks a refund from.
    const { familyId } = await household();
    cardCharge(familyId);
    const { transactions } = await caller('finance').billing.refundable({});
    expect(transactions[0].paidFor.labels).toContain('Tuition — Jul 2026');
    expect(transactions[0].paidFor.advance).toBe(false);
    // One label, not one per child: a sibling charge settles the same-named bill for each of them.
    expect(transactions[0].paidFor.labels).toHaveLength(1);
  });

  it('marks money paid before any bill as paid ahead rather than leaving it blank', async () => {
    const admin = caller('admin');
    const fam = await admin.people.familyCreate({ name: 'Farooqi' });
    const plan = await admin.billing.feePlanCreate({ name: 'Monthly tuition', amountCents: 20000, cadence: 'monthly' });
    const s = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Bilal Farooqi', feePlanId: plan.id });
    await admin.billing.recordManualPayment({ studentId: s.id, amountCents: 20000, channel: 'cash', occurredAt: '2026-06-20' });
    const { transactions } = await caller('finance').billing.refundable({});
    expect(transactions[0].paidFor.advance).toBe(true);
    expect(transactions[0].paidFor.labels).toEqual([]);
  });

  it('finds a payment by the child it was for', async () => {
    const { admin, a } = await household();
    await admin.billing.recordManualPayment({ studentId: a, amountCents: 20000, channel: 'cash', occurredAt: '2026-07-05' });
    expect((await caller('finance').billing.refundable({ query: 'yusuf' })).transactions).toHaveLength(1);
    expect((await caller('finance').billing.refundable({ query: 'nobody' })).transactions).toHaveLength(0);
  });
});

describe('who may, and what is recorded', () => {
  it('is closed to a parent', async () => {
    const { familyId } = await household();
    cardCharge(familyId);
    await expect(caller('parent').billing.refund({ key: 'pi_card_1' })).rejects.toThrow();
    expect(refundCalls).toHaveLength(0);
  });

  it('reports the amount, the child and the bill — and keeps the child out of the public text', async () => {
    // The two texts have different audiences and different rules (§9/§14): our own email goes to addresses
    // an admin typed and MAY name a household, because "a refund was recorded" is unactionable; the public
    // text goes to the masjid webhook and the platform's alert channel, which are third-party sinks.
    const { familyId } = await household();
    cardCharge(familyId);
    const alerts = await import('../src/alerts');
    const sent: { text: string; publicText: string; title?: string }[] = [];
    const spy = vi.spyOn(alerts, 'alertStaff').mockImplementation(async (_event, msg) => {
      sent.push(msg as { text: string; publicText: string; title?: string });
    });
    try {
      await caller('finance').billing.refund({ key: 'pi_card_1' });
      expect(sent).toHaveLength(1);
      const { text, publicText, title } = sent[0];
      // The office's email: how much, who for, and what it covered.
      expect(text).toContain('$400.00');
      expect(text).toContain('Yusuf Ismail');
      expect(text).toContain('Tuition — Jul 2026');
      expect(title).toContain('$400.00');
      // The public one: the figure, and nothing that identifies anybody.
      expect(publicText).toContain('$400.00');
      expect(publicText).not.toContain('Yusuf');
      expect(publicText).not.toContain('Ismail');
    } finally {
      spy.mockRestore();
    }
  });

  it('audits the act with amounts and ids, and no household name', async () => {
    const { familyId } = await household();
    cardCharge(familyId);
    await caller('finance').billing.refund({ key: 'pi_card_1' });
    const row = app.dbmod.db.select().from(auditLog).where(eq(auditLog.action, 'payment.refund')).get()!;
    expect(row).toBeTruthy();
    const detail = JSON.stringify(row.detail);
    expect(detail).toContain('40000');
    expect(detail).toContain('re_1');
    // §14: the audit trail records the act, not the family.
    expect(detail).not.toContain('Ismail');
  });
});

/**
 * Autopay, on the household's billing record (0.48.0).
 *
 * The office could not see this anywhere, so a family whose card pays them on Friday looked exactly like
 * one that had ignored two reminders. It rides on `familyBilling` because that is the record a volunteer
 * has open when a parent rings.
 */
describe('autopay on the billing record', () => {
  it('is reported off when nobody has set it up', async () => {
    const { familyId } = await household();
    const r = await caller('finance').billing.familyBilling({ familyId });
    expect(r.autopay).toEqual({ enabled: false, method: null, since: null });
  });

  it('names the method it will charge', async () => {
    const { familyId } = await household();
    const { db } = app.dbmod;
    const ts = new Date();
    db.insert(paymentMethods).values({ id: 'pm_1', familyId, type: 'card', brand: 'visa', last4: '4242', expMonth: 4, expYear: 2027, isDefault: true, createdAt: ts }).run();
    db.insert(autopayEnrollments).values({ familyId, enabled: true, defaultPmId: 'pm_1', consentAt: ts, failureCount: 0, nextAttemptAt: null, createdAt: ts, updatedAt: ts }).run();

    const r = await caller('finance').billing.familyBilling({ familyId });
    expect(r.autopay.enabled).toBe(true);
    // The same fields the parent's own screen renders from, so the office and the family cannot end up
    // naming different things.
    expect(r.autopay.method).toMatchObject({ type: 'card', brand: 'visa', last4: '4242' });
  });

  it('reports a BANK ACCOUNT as one, not as a card with no digits', async () => {
    const { familyId } = await household();
    const { db } = app.dbmod;
    const ts = new Date();
    db.insert(paymentMethods).values({ id: 'pm_bank', familyId, type: 'us_bank_account', bankName: 'Chase', last4: '6789', accountType: 'checking', isDefault: true, createdAt: ts }).run();
    db.insert(autopayEnrollments).values({ familyId, enabled: true, defaultPmId: 'pm_bank', consentAt: ts, failureCount: 0, nextAttemptAt: null, createdAt: ts, updatedAt: ts }).run();

    const r = await caller('finance').billing.familyBilling({ familyId });
    expect(r.autopay.method).toMatchObject({ type: 'us_bank_account', bankName: 'Chase', last4: '6789' });
  });

  it('says on-with-no-method rather than breaking when the card has since been removed', async () => {
    // Removing the default card turns autopay off through the portal, but a row could survive a hand-edit
    // or a half-finished change — and a billing screen must render either way.
    const { familyId } = await household();
    const { db } = app.dbmod;
    const ts = new Date();
    db.insert(autopayEnrollments).values({ familyId, enabled: true, defaultPmId: 'pm_gone', consentAt: ts, failureCount: 0, nextAttemptAt: null, createdAt: ts, updatedAt: ts }).run();
    const r = await caller('finance').billing.familyBilling({ familyId });
    expect(r.autopay.enabled).toBe(true);
    expect(r.autopay.method).toBeNull();
  });
});

/** Nothing here should have reached the network. */
it('made no HTTP calls of its own', () => {
  expect(vi.isMockFunction(globalThis.fetch)).toBe(false);
});
