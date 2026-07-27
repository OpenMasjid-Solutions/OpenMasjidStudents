// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Autopay engine (CLAUDE.md §13.3) — the offline-verifiable core: which families are due on a date,
 * the per-family-per-day run idempotency, and the retry ladder (+2 / +5 days, then auto-disable).
 * The off-session PI creation itself needs live Stripe; the scheduling + ladder logic is pure DB.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { freshApp, makeCtx } from './harness';
import { autopayEnrollments, autopayRuns, paymentMethods, paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, students, families } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let ap: typeof import('../src/payments/autopay');
// Dynamic imports (in beforeAll) so DATA_DIR is set by freshApp BEFORE ../src/db opens its connection —
// a static top-level import of any db-touching module would bind the singleton to the wrong data dir.
let ledger: typeof import('../src/billing/ledger');
let stripeMod: typeof import('../src/payments/stripe');
const caller = (role: Role) => app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp();
  ap = await import('../src/payments/autopay');
  ledger = await import('../src/billing/ledger');
  stripeMod = await import('../src/payments/stripe');
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [autopayRuns, autopayEnrollments, paymentMethods, paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, students, families]) db.delete(t).run();
});

/** A family enrolled in autopay with a saved default card and one overdue $50 invoice. */
async function familyDue(dueDate = '2026-06-01') {
  const admin = caller('admin');
  const fam = await admin.people.familyCreate({ name: 'Ismail' });
  const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
  const stu = await admin.people.studentCreate({ familyId: fam.id, firstName: 'Yusuf', lastName: 'Ismail', feePlanId: plan.id });
  await admin.billing.generateFamily({ familyId: fam.id, periodKey: '2026-06', label: 'Tuition — Jun 2026', dueDate });
  const { db } = app.dbmod;
  const ts = new Date();
  db.update(families).set({ stripeCustomerId: 'cus_test' }).where(eq(families.id, fam.id)).run();
  db.insert(paymentMethods).values({ id: 'pm_test', familyId: fam.id, brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030, isDefault: true, createdAt: ts }).run();
  db.insert(autopayEnrollments).values({ familyId: fam.id, enabled: true, defaultPmId: 'pm_test', consentAt: ts, failureCount: 0, nextAttemptAt: null, createdAt: ts, updatedAt: ts }).run();
  return { familyId: fam.id, studentId: stu.id };
}

describe('addDays', () => {
  it('adds days in UTC', () => {
    expect(ap.addDays('2026-07-01', 2)).toBe('2026-07-03');
    expect(ap.addDays('2026-07-30', 3)).toBe('2026-08-02');
  });
});

describe('autopayDue', () => {
  it('selects an enrolled family with a due invoice; skips off/not-due/waiting families', async () => {
    const { familyId, studentId } = await familyDue('2026-06-01');
    expect(ap.autopayDue('2026-07-01')).toEqual([{ familyId, amountCents: 5000 }]);
    // Not yet due (invoice due in the future relative to the run date).
    expect(ap.autopayDue('2026-05-01')).toEqual([]);
    // Autopay off → skipped.
    app.dbmod.db.update(autopayEnrollments).set({ enabled: false }).where(eq(autopayEnrollments.familyId, familyId)).run();
    expect(ap.autopayDue('2026-07-01')).toEqual([]);
    // On again but waiting on the retry ladder (nextAttemptAt in the future) → skipped.
    app.dbmod.db.update(autopayEnrollments).set({ enabled: true, nextAttemptAt: '2026-07-10' }).where(eq(autopayEnrollments.familyId, familyId)).run();
    expect(ap.autopayDue('2026-07-01')).toEqual([]);
    expect(ap.autopayDue('2026-07-10').length).toBe(1); // reached the retry date
  });
});

describe('createAutopayRun idempotency', () => {
  it('is one run per family per day', async () => {
    const { familyId, studentId } = await familyDue();
    expect(ap.createAutopayRun(familyId, 5000, '2026-07-01', 1)).toBeTruthy();
    expect(ap.createAutopayRun(familyId, 5000, '2026-07-01', 1)).toBeNull(); // same day → no second run
    expect(ap.createAutopayRun(familyId, 5000, '2026-07-02', 2)).toBeTruthy(); // next day is fine
  });
});

describe('retry ladder', () => {
  const runFail = (familyId: string, date: string) => {
    const runId = ap.createAutopayRun(familyId, 5000, date, 1)!;
    app.dbmod.db.update(autopayRuns).set({ stripePaymentIntentId: `pi_${date}` }).where(eq(autopayRuns.id, runId)).run();
    ap.onAutopayFailed(`pi_${date}`);
  };
  const enr = (familyId: string) => app.dbmod.db.select().from(autopayEnrollments).where(eq(autopayEnrollments.familyId, familyId)).get()!;

  it('advances +2 then +5, then disables after the third failure', async () => {
    const { familyId, studentId } = await familyDue();
    runFail(familyId, '2026-07-01');
    expect(enr(familyId)).toMatchObject({ enabled: true, failureCount: 1, nextAttemptAt: '2026-07-03' }); // +2
    runFail(familyId, '2026-07-03');
    expect(enr(familyId)).toMatchObject({ enabled: true, failureCount: 2, nextAttemptAt: '2026-07-06' }); // +3 (≈ +5 from origin)
    runFail(familyId, '2026-07-06');
    expect(enr(familyId)).toMatchObject({ enabled: false, failureCount: 3 }); // third strike → disabled
  });

  it('a success resets the ladder', async () => {
    const { familyId, studentId } = await familyDue();
    runFail(familyId, '2026-07-01');
    expect(enr(familyId).failureCount).toBe(1);
    const runId = ap.createAutopayRun(familyId, 5000, '2026-07-03', 2)!;
    app.dbmod.db.update(autopayRuns).set({ stripePaymentIntentId: 'pi_ok' }).where(eq(autopayRuns.id, runId)).run();
    ap.onAutopaySucceeded('pi_ok');
    expect(enr(familyId)).toMatchObject({ failureCount: 0, nextAttemptAt: null });
    expect(app.dbmod.db.select().from(autopayRuns).where(eq(autopayRuns.id, runId)).get()!.status).toBe('charged');
  });

  it('resolves a late failure by run id, backfills the PI id, and never double-advances', async () => {
    const { familyId, studentId } = await familyDue();
    // create() timed out: run pending, PI id never persisted. The webhook resolves it by our run id.
    const runId = ap.createAutopayRun(familyId, 5000, '2026-07-01', 1)!;
    ap.onAutopayFailed('pi_f', runId);
    let run = app.dbmod.db.select().from(autopayRuns).where(eq(autopayRuns.id, runId)).get()!;
    expect(run.status).toBe('failed');
    expect(run.stripePaymentIntentId).toBe('pi_f'); // backfilled from the webhook
    expect(enr(familyId).failureCount).toBe(1);
    // A re-delivered failure event is a no-op — the run is no longer 'pending'.
    ap.onAutopayFailed('pi_f', runId);
    expect(enr(familyId).failureCount).toBe(1);
  });

  it('links a late success by run id and backfills the PI id, resetting an inflated ladder', async () => {
    const { familyId, studentId } = await familyDue();
    const runId = ap.createAutopayRun(familyId, 5000, '2026-07-01', 1)!; // pending, no PI id
    app.dbmod.db.update(autopayEnrollments).set({ failureCount: 1, nextAttemptAt: '2026-07-03' }).where(eq(autopayEnrollments.familyId, familyId)).run();
    ap.onAutopaySucceeded('pi_late', runId);
    const run = app.dbmod.db.select().from(autopayRuns).where(eq(autopayRuns.id, runId)).get()!;
    expect(run.status).toBe('charged');
    expect(run.stripePaymentIntentId).toBe('pi_late');
    expect(enr(familyId)).toMatchObject({ failureCount: 0, nextAttemptAt: null });
  });
});

describe('ladder reset on any balance-clearing payment', () => {
  it('resets a mid-ladder family when a non-autopay payment clears the balance', async () => {
    const { familyId, studentId } = await familyDue('2026-06-01');
    const { db } = app.dbmod;
    // Two prior autopay failures, waiting on the retry ladder.
    db.update(autopayEnrollments).set({ failureCount: 2, nextAttemptAt: '2026-07-05' }).where(eq(autopayEnrollments.familyId, familyId)).run();
    // The parent pays the $50 balance manually (cash) — a different channel entirely.
    ledger.recordPayment({ studentId, amountCents: 5000, channel: 'cash', occurredAt: new Date(), idempotencyKey: 'cash_manual_1', memo: null }, { userId: null, role: 'admin', name: 'admin' });
    expect(ledger.familyBalance(familyId).owedCents).toBe(0);
    expect(db.select().from(autopayEnrollments).where(eq(autopayEnrollments.familyId, familyId)).get()!).toMatchObject({ failureCount: 0, nextAttemptAt: null });
  });

  it('leaves the ladder alone when a payment only partially clears the balance', async () => {
    const { familyId, studentId } = await familyDue('2026-06-01');
    const { db } = app.dbmod;
    db.update(autopayEnrollments).set({ failureCount: 2, nextAttemptAt: '2026-07-05' }).where(eq(autopayEnrollments.familyId, familyId)).run();
    ledger.recordPayment({ studentId, amountCents: 2000, channel: 'cash', occurredAt: new Date(), idempotencyKey: 'cash_partial_1', memo: null }, { userId: null, role: 'admin', name: 'admin' });
    expect(ledger.familyBalance(familyId).owedCents).toBe(3000);
    expect(db.select().from(autopayEnrollments).where(eq(autopayEnrollments.familyId, familyId)).get()!).toMatchObject({ failureCount: 2, nextAttemptAt: '2026-07-05' });
  });
});

describe('chargeFamily (off-session, mocked Stripe)', () => {
  const createCalls: { args: unknown; opts: unknown }[] = [];
  let createImpl: (args: unknown) => unknown = () => ({ id: 'pi_default', status: 'succeeded', latest_charge: 'ch_default' });
  const fakeStripe = {
    paymentIntents: {
      create: async (args: unknown, opts: unknown) => {
        createCalls.push({ args, opts });
        return createImpl(args);
      },
    },
  };
  const runOf = (familyId: string) => app.dbmod.db.select().from(autopayRuns).where(eq(autopayRuns.familyId, familyId)).get()!;
  const enrOf = (familyId: string) => app.dbmod.db.select().from(autopayEnrollments).where(eq(autopayEnrollments.familyId, familyId)).get()!;

  beforeAll(() => stripeMod._setStripeForTest({}, fakeStripe as unknown as Stripe));
  beforeEach(() => {
    createCalls.length = 0;
    createImpl = () => ({ id: 'pi_default', status: 'succeeded', latest_charge: 'ch_default' });
  });

  it('records a synchronous success and clears the balance so there is no cross-day re-charge', async () => {
    const { familyId, studentId } = await familyDue('2026-06-01');
    createImpl = () => ({ id: 'pi_sync', status: 'succeeded', latest_charge: 'ch_sync' });
    await ap.chargeFamily(familyId, 5000, '2026-07-01');
    expect(createCalls.length).toBe(1);
    expect(ledger.familyBalance(familyId).owedCents).toBe(0); // recorded now, not only on the webhook
    expect(runOf(familyId)).toMatchObject({ status: 'charged', stripePaymentIntentId: 'pi_sync' });
    expect(enrOf(familyId)).toMatchObject({ failureCount: 0, nextAttemptAt: null });
    // The family is no longer due → the next daily pass won't select it (no second charge).
    expect(ap.autopayDue('2026-07-02')).toEqual([]);
  });

  it('does not re-charge while a prior run is still pending (delayed / lost webhook)', async () => {
    const { familyId, studentId } = await familyDue('2026-06-01');
    const { db } = app.dbmod;
    const ts = new Date();
    // A prior charge fired a PI but its outcome hasn't landed yet.
    db.insert(autopayRuns).values({ id: 'apr_pending', familyId, runDate: '2026-07-01', amountCents: 5000, status: 'pending', stripePaymentIntentId: 'pi_inflight', attempt: 1, createdAt: ts, updatedAt: ts }).run();
    await ap.chargeFamily(familyId, 5000, '2026-07-02');
    expect(createCalls.length).toBe(0); // skipped — no second charge
    expect(db.select().from(autopayRuns).where(eq(autopayRuns.runDate, '2026-07-02')).get()).toBeUndefined();
  });

  it('leaves the run pending and does NOT advance the ladder on an indeterminate error', async () => {
    const { familyId, studentId } = await familyDue('2026-06-01');
    createImpl = () => { throw { type: 'StripeConnectionError', message: 'timeout' }; };
    await ap.chargeFamily(familyId, 5000, '2026-07-01');
    expect(runOf(familyId).status).toBe('pending');
    expect(enrOf(familyId)).toMatchObject({ failureCount: 0, nextAttemptAt: null });
  });

  it('advances the ladder and backfills the PI id on a synchronous card decline', async () => {
    const { familyId, studentId } = await familyDue('2026-06-01');
    createImpl = () => { throw { type: 'StripeCardError', code: 'card_declined', payment_intent: { id: 'pi_declined' } }; };
    await ap.chargeFamily(familyId, 5000, '2026-07-01');
    expect(runOf(familyId)).toMatchObject({ status: 'failed', stripePaymentIntentId: 'pi_declined' });
    expect(enrOf(familyId)).toMatchObject({ failureCount: 1, nextAttemptAt: '2026-07-03' });
  });
});
