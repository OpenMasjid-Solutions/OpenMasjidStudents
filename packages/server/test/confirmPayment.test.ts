// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Portal pay-now confirm-on-return (CLAUDE.md §13.2 — NO webhook) + the Stripe account picker (§10).
 * confirmPayment retrieves the PI (mocked), records a success to the ledger idempotently, and refuses
 * to record a PI that isn't this family's. The account picker persists the admin's choice (admin-only).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { freshApp, makeCtx } from './harness';
import { guardianUsers, guardians, guardianFamilies, invites, paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, students, families, sessions, users, settings } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let ledger: typeof import('../src/billing/ledger');
let settingsMod: typeof import('../src/settings');
let stripeMod: typeof import('../src/payments/stripe');
const caller = (role: Role, userId?: string) => app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: userId ?? `usr_${role}` } }).ctx);
const pub = () => app.appRouter.createCaller(makeCtx({ origin: 'lan' }).ctx);

// A mutable PI the mocked Stripe returns from retrieve().
let pi: { id: string; status: string; amount: number; amount_received: number; latest_charge: string | null; metadata: Record<string, string> };
const fakeStripe = { paymentIntents: { retrieve: async (id: string) => ({ ...pi, id }) } };

beforeAll(async () => {
  app = await freshApp();
  ledger = await import('../src/billing/ledger');
  settingsMod = await import('../src/settings');
  stripeMod = await import('../src/payments/stripe');
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [guardianUsers, guardians, guardianFamilies, invites, paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, students, families, sessions, users, settings]) db.delete(t).run();
});

/** A family with a $50 open invoice + a real parent account linked to it (via the invite door). */
async function familyWithParent() {
  const admin = caller('admin');
  const fam = await admin.people.familyCreate({ name: 'Ismail' });
  const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
  await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });
  const g = await admin.people.guardianCreate({ familyId: fam.id, name: 'Abu Yusuf', email: 'abu@example.com' });
  await admin.billing.generateFamily({ familyId: fam.id, periodKey: '2026-07', label: 'Tuition — Jul 2026', dueDate: '2026-07-01' });
  const inv = await admin.auth.inviteCreate({ guardianId: g.id });
  await pub().auth.inviteAccept({ token: inv.token, password: 'parent-pass-1234' });
  const link = app.dbmod.db.select().from(guardianUsers).where(eq(guardianUsers.guardianId, g.id)).get()!;
  return { famId: fam.id, parentUserId: link.userId };
}

describe('portal.confirmPayment (record-on-return, no webhook)', () => {
  beforeEach(() => stripeMod._setStripeForTest({}, fakeStripe as unknown as Stripe));

  it('records a succeeded PI to the ledger, idempotently (no double)', async () => {
    const { famId, parentUserId } = await familyWithParent();
    pi = { id: 'pi_ok', status: 'succeeded', amount: 5000, amount_received: 5000, latest_charge: 'ch_1', metadata: { purpose: 'students-billing', omos_app: 'students-portal', students_family_id: famId } };
    const parent = caller('parent', parentUserId);
    expect(await parent.portal.confirmPayment({ familyId: famId, paymentIntentId: 'pi_ok' })).toEqual({ status: 'succeeded', recorded: true });
    expect(ledger.familyBalance(famId)).toMatchObject({ owedCents: 0, creditCents: 0 });
    // A second confirm (Elements retried / double-submit) must NOT double-charge the ledger.
    await parent.portal.confirmPayment({ familyId: famId, paymentIntentId: 'pi_ok' });
    expect(ledger.familyBalance(famId)).toMatchObject({ owedCents: 0, creditCents: 0 });
  });

  it('does not record a non-succeeded PI', async () => {
    const { famId, parentUserId } = await familyWithParent();
    pi = { id: 'pi_pending', status: 'requires_payment_method', amount: 5000, amount_received: 0, latest_charge: null, metadata: { purpose: 'students-billing', omos_app: 'students-portal', students_family_id: famId } };
    const r = await caller('parent', parentUserId).portal.confirmPayment({ familyId: famId, paymentIntentId: 'pi_pending' });
    expect(r).toMatchObject({ recorded: false });
    expect(ledger.familyBalance(famId).owedCents).toBe(5000);
  });

  it('refuses a PI that belongs to another family (the wall)', async () => {
    const { famId, parentUserId } = await familyWithParent();
    pi = { id: 'pi_other', status: 'succeeded', amount: 5000, amount_received: 5000, latest_charge: 'ch_x', metadata: { purpose: 'students-billing', omos_app: 'students-portal', students_family_id: 'fam_someone_else' } };
    await expect(caller('parent', parentUserId).portal.confirmPayment({ familyId: famId, paymentIntentId: 'pi_other' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(ledger.familyBalance(famId).owedCents).toBe(5000);
  });

  it('refuses a family the parent is not linked to', async () => {
    const { parentUserId } = await familyWithParent();
    pi = { id: 'pi_ok', status: 'succeeded', amount: 5000, amount_received: 5000, latest_charge: null, metadata: { purpose: 'students-billing', omos_app: 'students-portal', students_family_id: 'fam_x' } };
    await expect(caller('parent', parentUserId).portal.confirmPayment({ familyId: 'fam_x', paymentIntentId: 'pi_ok' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('settings — Stripe account picker (§10)', () => {
  it('persists the admin\'s chosen account; standalone has no accounts + not ready; admin-only', async () => {
    await stripeMod.loadStripeKeys(); // reset any client a prior describe injected (no Fabric → clears it)
    const admin = caller('admin');
    // Standalone (no Fabric in tests): empty list, nothing chosen, not ready.
    expect(await admin.settings.stripeAccountsGet()).toMatchObject({ accounts: [], chosenId: '', ready: false });
    const r = await admin.settings.stripeAccountSet({ accountId: 'acct_123' });
    expect(r).toMatchObject({ ok: false, ready: false }); // loadStripeKeys can't reach the Fabric offline
    expect(settingsMod.getChosenStripeAccount()).toBe('acct_123');
    expect(await admin.settings.stripeAccountsGet()).toMatchObject({ chosenId: 'acct_123' });
    for (const role of ['finance', 'parent'] as Role[]) {
      await expect(caller(role).settings.stripeAccountsGet()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });
});
