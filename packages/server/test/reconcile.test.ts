// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Stripe reconciliation (CLAUDE.md §11.4). The Stripe search itself is mocked; what we verify is the
 * logic around it: record a missed succeeded tuition PI once (idempotent on the PI id), map the
 * channel from metadata, skip unattributable PIs, paginate, recover a stuck autopay run, and never
 * lose money on a re-run. Not-configured (no Stripe) is a clean no-op.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { freshApp, makeCtx } from './harness';
import { autopayEnrollments, autopayRuns, paymentMethods, paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, students, families, settings } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let recon: typeof import('../src/payments/reconcile');
let ledger: typeof import('../src/billing/ledger');
let ap: typeof import('../src/payments/autopay');
let stripeMod: typeof import('../src/payments/stripe');
const caller = (role: Role) => app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);
const sysActor = { userId: null, role: 'system', name: 'reconciliation' };

beforeAll(async () => {
  app = await freshApp();
  recon = await import('../src/payments/reconcile');
  ledger = await import('../src/billing/ledger');
  ap = await import('../src/payments/autopay');
  stripeMod = await import('../src/payments/stripe');
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [autopayRuns, autopayEnrollments, paymentMethods, paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, students, families, settings]) db.delete(t).run();
});

/** A family with one open $50 invoice. */
async function familyWithInvoice(amount = 5000, due = '2026-06-01') {
  const admin = caller('admin');
  const fam = await admin.people.familyCreate({ name: 'Ismail' });
  const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: amount, cadence: 'monthly' });
  const stu = await admin.people.studentCreate({ familyId: fam.id, firstName: 'Yusuf', lastName: 'Ismail', feePlanId: plan.id });
  await admin.billing.generateFamily({ familyId: fam.id, periodKey: '2026-06', label: 'Tuition — Jun 2026', dueDate: due });
  studentOf.set(fam.id, stu.id);
  return fam.id;
}

/** familyId → its one child, so tests can record against the student the way the app does. */
const studentOf = new Map<string, string>();

/**
 * The ledger rows for one PaymentIntent. A charge covering several children is stored as one row per
 * child under `${piId}:${studentId}`, so an exact idempotency-key match would find nothing.
 */
const rowsForPi = (piId: string) =>
  app.dbmod.db.select().from(payments).all().filter((x) => x.idempotencyKey === piId || x.idempotencyKey.startsWith(`${piId}:`));

interface FakePI {
  id: string;
  created: number;
  status: string;
  amount: number;
  amount_received: number;
  latest_charge: string | null;
  metadata: Record<string, string>;
}
const pi = (o: Partial<FakePI> & { id: string; metadata: Record<string, string> }): FakePI => ({
  created: 1_720_000_000,
  status: 'succeeded',
  amount: 5000,
  amount_received: 5000,
  latest_charge: 'ch_x',
  ...o,
});

describe('reconcile — not configured', () => {
  it('is a clean no-op when Stripe is not configured', async () => {
    const r = await recon.reconcile(sysActor);
    expect(r).toMatchObject({ ok: false, scanned: 0, recorded: 0 });
  });
});

describe('reconcile — with mocked Stripe search', () => {
  const empty = () => ({ data: [] as FakePI[], has_more: false, next_page: null });
  let searchImpl: () => { data: FakePI[]; has_more: boolean; next_page: string | null } = empty;
  let pendingImpl: () => { data: FakePI[]; has_more: boolean; next_page: string | null } = empty; // the cursor-hold pending scan
  let searchCalls = 0;
  const fakeStripe = {
    paymentIntents: {
      search: async (args: { query?: string }) => {
        searchCalls++;
        // reconcile runs two searches: the succeeded scan and a pending-PI scan (to hold the cursor).
        if (args?.query && /processing|requires_action/.test(args.query)) return pendingImpl();
        return searchImpl();
      },
    },
  };

  beforeAll(() => stripeMod._setStripeForTest({}, fakeStripe as unknown as Stripe));
  beforeEach(() => {
    searchCalls = 0;
    searchImpl = empty;
    pendingImpl = empty;
  });

  it('records a missed donations-web payment, flagged via reconciliation', async () => {
    const familyId = await familyWithInvoice();
    searchImpl = () => ({ data: [pi({ id: 'pi_don1', metadata: { purpose: 'students-billing', omos_app: 'donations', students_family_id: familyId } })], has_more: false, next_page: null });
    const r = await recon.reconcile(sysActor);
    expect(r).toMatchObject({ ok: true, scanned: 1, recorded: 1 });
    const p = rowsForPi('pi_don1')[0]!;
    expect(p.channel).toBe('donations-web');
    expect((p.externalRef as Record<string, unknown>).via).toBe('reconciliation');
    expect(ledger.familyBalance(familyId).owedCents).toBe(0);
    // The summary is stored for the finance UI.
    expect(recon.reconcileStatus()).toMatchObject({ scanned: 1, recorded: 1 });
  });

  it('is idempotent — a re-run records nothing new', async () => {
    const familyId = await familyWithInvoice();
    searchImpl = () => ({ data: [pi({ id: 'pi_don1', metadata: { purpose: 'students-billing', omos_app: 'donations', students_family_id: familyId } })], has_more: false, next_page: null });
    expect((await recon.reconcile(sysActor)).recorded).toBe(1);
    const again = await recon.reconcile(sysActor);
    expect(again).toMatchObject({ scanned: 1, recorded: 0 }); // already recorded → skipped
  });

  it('skips PIs it cannot attribute (unknown origin, no family, zero amount)', async () => {
    const familyId = await familyWithInvoice();
    searchImpl = () => ({
      data: [
        pi({ id: 'pi_unknown', metadata: { purpose: 'students-billing', omos_app: 'mystery', students_family_id: familyId } }),
        pi({ id: 'pi_nofam', metadata: { purpose: 'students-billing', omos_app: 'donations' } }),
        pi({ id: 'pi_zero', amount: 0, amount_received: 0, metadata: { purpose: 'students-billing', omos_app: 'donations', students_family_id: familyId } }),
      ],
      has_more: false,
      next_page: null,
    });
    const r = await recon.reconcile(sysActor);
    expect(r).toMatchObject({ scanned: 3, recorded: 0 });
    expect(ledger.familyBalance(familyId).owedCents).toBe(5000); // untouched
  });

  it('paginates through has_more pages', async () => {
    const familyId = await familyWithInvoice(20000);
    searchImpl = () =>
      searchCalls === 1
        ? { data: [pi({ id: 'pi_p1', metadata: { purpose: 'students-billing', omos_app: 'kiosk', students_family_id: familyId } })], has_more: true, next_page: 'pg2' }
        : { data: [pi({ id: 'pi_p2', metadata: { purpose: 'students-billing', omos_app: 'donations', students_family_id: familyId } })], has_more: false, next_page: null };
    const r = await recon.reconcile(sysActor);
    expect(searchCalls).toBe(3); // 2 succeeded pages + 1 pending-PI scan (cursor hold)
    expect(r).toMatchObject({ scanned: 2, recorded: 2 });
  });

  const cursorVal = () => app.dbmod.db.select().from(settings).where(eq(settings.key, 'stripe_reconcile_cursor')).get()?.value;

  it('holds the cursor below a still-pending PI so its later success is never skipped', async () => {
    const familyId = await familyWithInvoice();
    app.dbmod.db.insert(settings).values({ key: 'stripe_reconcile_cursor', value: '1', updatedAt: new Date() }).run();
    // A succeeded PI (created 200, recorded) + a still-processing PI (created 100) in the same window.
    searchImpl = () => ({ data: [pi({ id: 'pi_ok', created: 200, metadata: { purpose: 'students-billing', omos_app: 'donations', students_family_id: familyId } })], has_more: false, next_page: null });
    pendingImpl = () => ({ data: [pi({ id: 'pi_pending', created: 100, status: 'processing', metadata: { purpose: 'students-billing', omos_app: 'students-portal', students_channel: 'portal', students_family_id: familyId } })], has_more: false, next_page: null });
    await recon.reconcile(sysActor);
    expect(cursorVal()).toBe('99'); // held below the pending PI (created 100), NOT advanced to 200
  });

  it('holds the cursor below a PI that errored on record, then re-records it next run (no money loss)', async () => {
    const familyId = await familyWithInvoice(20000);
    const { db } = app.dbmod;
    // pi_bad references a family that does not exist yet, so there is no child to attribute it to.
    // That is retryable, not terminal — the cursor must be held below it.
    searchImpl = () => ({
      data: [
        pi({ id: 'pi_bad', created: 100, metadata: { purpose: 'students-billing', omos_app: 'donations', students_family_id: 'fam_missing' } }),
        pi({ id: 'pi_good', created: 200, metadata: { purpose: 'students-billing', omos_app: 'donations', students_family_id: familyId } }),
      ],
      has_more: false,
      next_page: null,
    });
    const r1 = await recon.reconcile(sysActor);
    expect(r1.recorded).toBe(1); // only pi_good
    expect(rowsForPi('pi_bad')).toHaveLength(0);
    expect(cursorVal()).toBe('99'); // held below pi_bad (created 100), NOT advanced to 200 — pi_bad is not lost
    // The family AND a child arrive; the next run re-scans the held window and records pi_bad. A
    // family with no children still has nowhere to put the money, so the student is the part that
    // actually unblocks it.
    const ts = new Date();
    db.insert(families).values({ id: 'fam_missing', name: 'Late', createdAt: ts, updatedAt: ts }).run();
    db.insert(students).values({ id: 'stu_late', familyId: 'fam_missing', firstName: 'Late', lastName: 'Arrival', status: 'active', studentCode: 'LAT9001', createdAt: ts, updatedAt: ts }).run();
    const r2 = await recon.reconcile(sysActor);
    expect(r2.recorded).toBe(1);
    expect(rowsForPi('pi_bad')).toHaveLength(1);
  });

  it('advances the cursor past an unattributable PI (it can never be recorded)', async () => {
    await familyWithInvoice();
    // A deterministic starting cursor so the assertion doesn't depend on the default look-back window.
    app.dbmod.db.insert(settings).values({ key: 'stripe_reconcile_cursor', value: '1000', updatedAt: new Date() }).run();
    searchImpl = () => ({ data: [pi({ id: 'pi_orphan', created: 1_720_000_500, metadata: { purpose: 'students-billing', omos_app: 'donations' } })], has_more: false, next_page: null }); // no family id
    const r = await recon.reconcile(sysActor);
    expect(r.recorded).toBe(0);
    expect(cursorVal()).toBe('1720000500'); // advanced past the orphan — a terminal skip must not wedge the scan
  });

  it('heals a stuck-pending autopay run even when the payment is already recorded', async () => {
    const familyId = await familyWithInvoice();
    const { db } = app.dbmod;
    const runId = ap.createAutopayRun(familyId, 5000, '2026-07-01', 1)!; // pending
    // The payment is already in the ledger, but the run stayed 'pending' (crash after the ledger write).
    ledger.recordPayment({ studentId: studentOf.get(familyId)!, amountCents: 5000, channel: 'autopay', occurredAt: new Date(), idempotencyKey: 'pi_healed', memo: null, externalRef: { stripePaymentIntentId: 'pi_healed' } }, { userId: null, role: 'autopay', name: 'x' });
    const ts = new Date();
    db.insert(autopayEnrollments).values({ familyId, enabled: true, defaultPmId: null, consentAt: ts, failureCount: 1, nextAttemptAt: '2026-07-03', createdAt: ts, updatedAt: ts }).run();
    searchImpl = () => ({ data: [pi({ id: 'pi_healed', metadata: { purpose: 'students-billing', omos_app: 'students-portal', students_channel: 'autopay', students_family_id: familyId, students_autopay_run_id: runId } })], has_more: false, next_page: null });
    const r = await recon.reconcile(sysActor);
    expect(r.recorded).toBe(0); // already recorded — not re-recorded
    expect(db.select().from(autopayRuns).where(eq(autopayRuns.id, runId)).get()!.status).toBe('charged'); // but healed
    expect(db.select().from(autopayEnrollments).where(eq(autopayEnrollments.familyId, familyId)).get()!).toMatchObject({ failureCount: 0, nextAttemptAt: null });
  });

  it('recovers an autopay success whose webhook was lost — resolves the run + resets the ladder', async () => {
    const familyId = await familyWithInvoice();
    const { db } = app.dbmod;
    const runId = ap.createAutopayRun(familyId, 5000, '2026-07-01', 1)!; // pending, PI id never persisted
    const ts = new Date();
    db.insert(autopayEnrollments).values({ familyId, enabled: true, defaultPmId: null, consentAt: ts, failureCount: 1, nextAttemptAt: '2026-07-03', createdAt: ts, updatedAt: ts }).run();
    searchImpl = () => ({ data: [pi({ id: 'pi_auto', metadata: { purpose: 'students-billing', omos_app: 'students-portal', students_channel: 'autopay', students_family_id: familyId, students_autopay_run_id: runId } })], has_more: false, next_page: null });
    const r = await recon.reconcile(sysActor);
    expect(r.recorded).toBe(1);
    expect(rowsForPi('pi_auto')[0]!.channel).toBe('autopay');
    const run = db.select().from(autopayRuns).where(eq(autopayRuns.id, runId)).get()!;
    expect(run).toMatchObject({ status: 'charged', stripePaymentIntentId: 'pi_auto' });
    expect(db.select().from(autopayEnrollments).where(eq(autopayEnrollments.familyId, familyId)).get()!).toMatchObject({ failureCount: 0, nextAttemptAt: null });
  });
});
