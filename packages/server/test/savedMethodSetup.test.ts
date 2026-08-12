// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * What the portal's "add a payment method" step ASKS STRIPE FOR (0.48.0).
 *
 * THE BUG. `setupIntents.create` was called with neither `payment_method_types` nor
 * `automatic_payment_methods`, and Stripe defaults a SetupIntent to `['card']` in that case. So the step
 * was card-only on every install, whatever the masjid had enabled — a household could pay FROM a bank
 * account in pay-now (which has had automatic methods all along) and then find no way to save one. That
 * default is invisible in the code, which is exactly why it needs a test naming it.
 *
 * THE FIX MUST NOT NAME TYPES. Asking for `us_bank_account` explicitly makes Stripe reject the whole call
 * on an account that has not enabled it — which would break saving a CARD for every masjid that takes
 * cards only. So the assertion is both halves: automatic methods on, and no hard-coded type list.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type Stripe from 'stripe';
import { freshApp, makeCtx } from './harness';
import { eq } from 'drizzle-orm';
import { paymentMethods, autopayEnrollments, families, students, feePlans, studentFees, users, auditLog, guardians, guardianFamilies, guardianUsers } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let stripeMod: typeof import('../src/payments/stripe');
const caller = (role: Role, userId = `usr_${role}`) =>
  app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId } }).ctx);

/** Every SetupIntent this test provoked, with the arguments it was created from. */
const setupCalls: Record<string, unknown>[] = [];
const fakeStripe = {
  customers: { create: async () => ({ id: 'cus_test' }) },
  setupIntents: {
    create: async (args: Record<string, unknown>) => {
      setupCalls.push(args);
      return { id: 'seti_1', client_secret: 'seti_1_secret' };
    },
  },
  paymentMethods: {
    retrieve: async (id: string) => ({
      id,
      type: 'us_bank_account',
      us_bank_account: { bank_name: 'Chase', last4: '6789', account_type: 'checking' },
    }),
    attach: async () => ({}),
  },
};

beforeAll(async () => {
  app = await freshApp();
  stripeMod = await import('../src/payments/stripe');
  stripeMod._setStripeForTest({ publishableKey: 'pk_test' }, fakeStripe as unknown as Stripe);
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentMethods, autopayEnrollments, guardianUsers, guardianFamilies, guardians, studentFees, feePlans, students, families, users, auditLog]) db.delete(t).run();
  setupCalls.length = 0;
});

/** A household with a parent account linked to it, which is what `parentProcedure` scopes on. */
async function household() {
  const admin = caller('admin');
  const fam = await admin.people.familyCreate({ name: 'Ismail' });
  const plan = await admin.billing.feePlanCreate({ name: 'Monthly tuition', amountCents: 20000, cadence: 'monthly' });
  await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });
  const g = await admin.people.guardianCreate({ familyId: fam.id, name: 'Ismail', email: 'ismail@example.org' });
  const { db } = app.dbmod;
  const ts = new Date();
  db.insert(users).values({ id: 'usr_parent', username: 'ismail@example.org', passwordHash: 'x', role: 'parent', status: 'active', displayName: 'Ismail', mustChangePassword: false, createdAt: ts, updatedAt: ts }).run();
  db.insert(guardianUsers).values({ guardianId: g.id, userId: 'usr_parent', createdAt: ts }).run();
  db.update(families).set({ stripeCustomerId: 'cus_test' }).where(eq(families.id, fam.id)).run();
  return { familyId: fam.id, parent: caller('parent', 'usr_parent') };
}

describe('the SetupIntent behind "add a payment method"', () => {
  it('lets Stripe decide which methods to offer, rather than defaulting to cards only', async () => {
    const { familyId, parent } = await household();
    await parent.portal.createSetupIntent({ familyId });

    expect(setupCalls).toHaveLength(1);
    const args = setupCalls[0];
    expect(args.automatic_payment_methods).toEqual({ enabled: true });
    // The two ways of getting it wrong: leaving both fields off (Stripe then assumes cards, which is the
    // bug) and naming a type the masjid may not have enabled (Stripe then rejects the whole call, which
    // would break saving a card).
    expect(args.payment_method_types).toBeUndefined();
  });

  it('still sets it up for OFF-SESSION use, so autopay can charge it later', async () => {
    const { familyId, parent } = await household();
    await parent.portal.createSetupIntent({ familyId });
    expect(setupCalls[0].usage).toBe('off_session');
    expect(setupCalls[0].customer).toBe('cus_test');
  });

  it('tags it as ours, and carries no child in the metadata', async () => {
    const { familyId, parent } = await household();
    await parent.portal.createSetupIntent({ familyId });
    const meta = setupCalls[0].metadata as Record<string, string>;
    expect(meta.omos_app).toBe('students-portal');
    expect(meta.students_family_id).toBe(familyId);
    // §11.3: never a Student ID or a child's name in Stripe metadata.
    expect(JSON.stringify(meta)).not.toContain('Yusuf');
  });

  it('saves a BANK ACCOUNT with its details, which is what this whole change is for', async () => {
    const { familyId, parent } = await household();
    await parent.portal.saveCard({ familyId, paymentMethodId: 'pm_bank_1' });
    const row = app.dbmod.db.select().from(paymentMethods).where(eq(paymentMethods.id, 'pm_bank_1')).get()!;
    expect(row).toMatchObject({ type: 'us_bank_account', bankName: 'Chase', last4: '6789', accountType: 'checking' });
    // First method saved becomes the one autopay would use.
    expect(row.isDefault).toBe(true);
    // And nothing card-shaped was invented for it — the old code's failure.
    expect(row.brand).toBeNull();
    expect(row.expMonth).toBeNull();
  });

  it('refuses a family the parent is not linked to', async () => {
    // The scoping wall, on the procedure this change touched (§14).
    const { parent } = await household();
    const other = await caller('admin').people.familyCreate({ name: 'Farooqi' });
    await expect(parent.portal.createSetupIntent({ familyId: other.id })).rejects.toThrow();
    expect(setupCalls).toHaveLength(0);
  });
});
