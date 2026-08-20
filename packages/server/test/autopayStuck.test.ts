// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Resolving autopay runs stuck at 'pending' (payments/reconcile.ts `resolveStuckRuns`).
 *
 * THE BUG THIS EXISTS FOR: when webhooks were removed at v0.32.0, `onAutopayFailed` lost its only
 * caller. A charge that failed ASYNCHRONOUSLY therefore left its run at 'pending' forever, and the
 * pending-run guard in `chargeFamily` then blocked that family from ever being charged again — no
 * error, no alert, just a family that quietly stops paying. Reconciliation only ever scanned
 * status:"succeeded", so nothing resolved it.
 *
 * The rule under test throughout: an unreachable or ambiguous Stripe must NEVER be read as "no charge
 * happened", because that is how you double-bill someone. Only a definite answer resolves a run.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { freshApp, makeCtx } from './harness';
import { autopayEnrollments, autopayRuns, paymentMethods, paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, students, families, settings, auditLog } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let recon: typeof import('../src/payments/reconcile');
let ap: typeof import('../src/payments/autopay');
let stripeMod: typeof import('../src/payments/stripe');
const caller = (role: Role) => app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);
const sysActor = { userId: null, role: 'system', name: 'reconciliation' };

beforeAll(async () => {
  app = await freshApp();
  recon = await import('../src/payments/reconcile');
  ap = await import('../src/payments/autopay');
  stripeMod = await import('../src/payments/stripe');
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [autopayRuns, autopayEnrollments, paymentMethods, paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, students, families, settings, auditLog]) db.delete(t).run();
});

/** A family, an autopay enrollment with a saved card, and one stuck 'pending' run. */
async function stuckRun(opts: { withPiId: boolean; failureCount?: number }) {
  const admin = caller('admin');
  const fam = await admin.people.familyCreate({ name: 'Ismail' });
  const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
  await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });
  const { db } = app.dbmod;
  const ts = new Date();
  db.insert(autopayEnrollments)
    .values({ familyId: fam.id, enabled: true, defaultPmId: 'pm_x', consentAt: ts, failureCount: opts.failureCount ?? 0, nextAttemptAt: null, createdAt: ts, updatedAt: ts })
    .run();
  const runId = ap.createAutopayRun(fam.id, 5000, '2026-06-01', 1)!;
  if (opts.withPiId) db.update(autopayRuns).set({ stripePaymentIntentId: 'pi_stuck' }).where(eq(autopayRuns.id, runId)).run();
  return { familyId: fam.id, runId };
}

const runStatus = (runId: string) => app.dbmod.db.select({ status: autopayRuns.status }).from(autopayRuns).where(eq(autopayRuns.id, runId)).get()!.status;
const enrollment = (familyId: string) => app.dbmod.db.select().from(autopayEnrollments).where(eq(autopayEnrollments.familyId, familyId)).get()!;

describe('resolveStuckRuns', () => {
  /** Configurable fake: `retrieveStatus` drives paymentIntents.retrieve; `searchHit` drives the
   *  metadata lookup used when a run has no PI id. `throwOn` simulates Stripe being unreachable. */
  let retrieveStatus = 'canceled';
  let searchHit: { id: string; status: string } | null = null;
  let throwOn = false;
  const fakeStripe = {
    paymentIntents: {
      retrieve: async (id: string) => {
        if (throwOn) throw new Error('network');
        return { id, status: retrieveStatus };
      },
      search: async (args: { query?: string }) => {
        if (throwOn) throw new Error('network');
        // The run-id metadata lookup; reconcile's own two scans get nothing so only this logic runs.
        if (args?.query && /students_autopay_run_id/.test(args.query)) {
          return { data: searchHit ? [searchHit] : [], has_more: false, next_page: null };
        }
        return { data: [], has_more: false, next_page: null };
      },
    },
  };

  beforeAll(() => stripeMod._setStripeForTest({}, fakeStripe as unknown as Stripe));
  beforeEach(() => {
    retrieveStatus = 'canceled';
    searchHit = null;
    throwOn = false;
  });

  it('is a clean no-op with no stuck runs', async () => {
    expect(await recon.resolveStuckRuns(sysActor)).toEqual({ checked: 0, resolved: 0 });
  });

  it('a canceled PI resolves the run as failed and advances the retry ladder', async () => {
    const { familyId, runId } = await stuckRun({ withPiId: true });
    retrieveStatus = 'canceled';
    expect(await recon.resolveStuckRuns(sysActor)).toEqual({ checked: 1, resolved: 1 });
    expect(runStatus(runId)).toBe('failed');
    const e = enrollment(familyId);
    expect(e.failureCount).toBe(1);
    expect(e.nextAttemptAt).toBeTruthy(); // ladder scheduled the retry
    expect(e.enabled).toBe(true); // not the third strike
  });

  it('requires_payment_method is also a terminal failure', async () => {
    const { familyId, runId } = await stuckRun({ withPiId: true });
    retrieveStatus = 'requires_payment_method';
    await recon.resolveStuckRuns(sysActor);
    expect(runStatus(runId)).toBe('failed');
    expect(enrollment(familyId).failureCount).toBe(1);
  });

  it('the third strike turns autopay off, exactly as a synchronous decline would', async () => {
    const { familyId, runId } = await stuckRun({ withPiId: true, failureCount: 2 });
    retrieveStatus = 'canceled';
    await recon.resolveStuckRuns(sysActor);
    expect(runStatus(runId)).toBe('failed');
    const e = enrollment(familyId);
    expect(e.failureCount).toBe(3);
    expect(e.enabled).toBe(false);
  });

  it('a succeeded PI resolves the run and RESETS the ladder', async () => {
    const { familyId, runId } = await stuckRun({ withPiId: true, failureCount: 2 });
    retrieveStatus = 'succeeded';
    expect(await recon.resolveStuckRuns(sysActor)).toEqual({ checked: 1, resolved: 1 });
    expect(runStatus(runId)).toBe('charged');
    expect(enrollment(familyId).failureCount).toBe(0);
  });

  it('leaves a genuinely in-flight PI alone', async () => {
    const { familyId, runId } = await stuckRun({ withPiId: true });
    for (const s of ['processing', 'requires_action', 'requires_confirmation', 'requires_capture']) {
      retrieveStatus = s;
      expect(await recon.resolveStuckRuns(sysActor)).toEqual({ checked: 1, resolved: 0 });
      expect(runStatus(runId)).toBe('pending');
      expect(enrollment(familyId).failureCount).toBe(0);
    }
  });

  it('closes a run with NO PaymentIntent at Stripe — without a strike, since nothing was charged', async () => {
    const { familyId, runId } = await stuckRun({ withPiId: false });
    searchHit = null; // the metadata search finds nothing: create() threw before returning an id
    expect(await recon.resolveStuckRuns(sysActor)).toEqual({ checked: 1, resolved: 1 });
    expect(runStatus(runId)).toBe('failed'); // no longer blocks future charges
    // Crucially the family is NOT penalized for our own network error.
    const e = enrollment(familyId);
    expect(e.failureCount).toBe(0);
    expect(e.enabled).toBe(true);
    expect(app.dbmod.db.select().from(auditLog).all().some((a) => a.action === 'autopay.run.abandoned')).toBe(true);
  });

  it('finds a PI by run-id metadata when the id was never recorded', async () => {
    const { familyId, runId } = await stuckRun({ withPiId: false });
    searchHit = { id: 'pi_found', status: 'succeeded' };
    await recon.resolveStuckRuns(sysActor);
    expect(runStatus(runId)).toBe('charged');
    expect(enrollment(familyId).failureCount).toBe(0);
    expect(app.dbmod.db.select({ pi: autopayRuns.stripePaymentIntentId }).from(autopayRuns).where(eq(autopayRuns.id, runId)).get()!.pi).toBe('pi_found');
  });

  it('an unreachable Stripe leaves the run pending — never read as "no charge happened"', async () => {
    const { familyId, runId } = await stuckRun({ withPiId: true });
    throwOn = true;
    expect(await recon.resolveStuckRuns(sysActor)).toEqual({ checked: 1, resolved: 0 });
    expect(runStatus(runId)).toBe('pending');
    expect(enrollment(familyId).failureCount).toBe(0);
  });

  it('unblocks the family: chargeFamily was refusing to charge while the run sat pending', async () => {
    const { familyId, runId } = await stuckRun({ withPiId: true });
    // Before: the guard blocks, so a later day's run is never even created.
    expect(ap.createAutopayRun(familyId, 5000, '2026-06-10', 1)).toBeTruthy();
    app.dbmod.db.delete(autopayRuns).where(eq(autopayRuns.runDate, '2026-06-10')).run();
    expect(runStatus(runId)).toBe('pending');

    retrieveStatus = 'canceled';
    await recon.resolveStuckRuns(sysActor);
    expect(runStatus(runId)).toBe('failed');
    // After: nothing is pending, so the guard no longer stands in the way.
    expect(ap.pendingRuns()).toHaveLength(0);
  });

  it('a full reconcile pass resolves stuck runs too, not just the direct call', async () => {
    const { runId } = await stuckRun({ withPiId: true });
    retrieveStatus = 'canceled';
    const r = await recon.reconcile(sysActor);
    expect(r.ok).toBe(true);
    expect(runStatus(runId)).toBe('failed');
  });
});
