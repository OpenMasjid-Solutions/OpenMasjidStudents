// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The ORDER a household's payment methods are charged in (0.48.0).
 *
 * There was one `is_default` boolean, so a family could name the card autopay used and nothing else — and
 * the retry ladder then presented that same declining card again two days later, which is the same answer
 * three times rather than a retry. A parent can now say "the joint account, then my card".
 *
 * Three things have to stay in step, and getting that wrong is the worst bug available here — a screen
 * saying one card while a charge uses another:
 *
 *   `payment_methods.sort_order`            the authority
 *   `payment_methods.is_default`            what the portal and the office screens read
 *   `autopay_enrollments.default_pm_id`     what a charge actually presents
 *
 * So every case below checks the trio, not just the column it changed. `resequenceMethods` is the single
 * place that moves them together; these tests are what hold that.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { freshApp, makeCtx } from './harness';
import { paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, students, families, users, auditLog, guardians, guardianFamilies, guardianUsers, paymentMethods, autopayEnrollments, autopayRuns } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let stripeMod: typeof import('../src/payments/stripe');
let ap: typeof import('../src/payments/autopay');
const caller = (role: Role, userId = `usr_${role}`) =>
  app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId } }).ctx);

/** Which payment method each off-session charge presented. */
const charged: string[] = [];
let piImpl: () => unknown = () => ({ id: 'pi_ok', status: 'succeeded', latest_charge: 'ch_ok' });
const fakeStripe = {
  customers: { create: async () => ({ id: 'cus_test' }) },
  setupIntents: { create: async () => ({ id: 'seti_1', client_secret: 'seti_1_secret' }) },
  paymentMethods: {
    retrieve: async (id: string) => ({ id, type: 'card', card: { brand: 'visa', last4: id.slice(-4), exp_month: 4, exp_year: 2030 } }),
    attach: async () => ({}),
    detach: async () => ({}),
  },
  paymentIntents: {
    create: async (args: Record<string, unknown>) => {
      charged.push(String(args.payment_method));
      return piImpl();
    },
  },
};

beforeAll(async () => {
  app = await freshApp();
  stripeMod = await import('../src/payments/stripe');
  ap = await import('../src/payments/autopay');
  stripeMod._setStripeForTest({ publishableKey: 'pk_test' }, fakeStripe as unknown as Stripe);
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, autopayRuns, autopayEnrollments, paymentMethods, invoiceItems, invoices, studentFees, feePlans, guardianUsers, guardianFamilies, guardians, students, families, users, auditLog]) db.delete(t).run();
  charged.length = 0;
  piImpl = () => ({ id: 'pi_ok', status: 'succeeded', latest_charge: 'ch_ok' });
});

/** A household with a parent account, a child on $200/month, and a bill due. */
async function household() {
  const admin = caller('admin');
  const fam = await admin.people.familyCreate({ name: 'Ismail' });
  const plan = await admin.billing.feePlanCreate({ name: 'Monthly tuition', amountCents: 20000, cadence: 'monthly' });
  const stu = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });
  await admin.billing.generateFamily({ familyId: fam.id, periodKey: '2026-07', label: 'Tuition — Jul 2026', dueDate: '2026-07-01' });
  const g = await admin.people.guardianCreate({ familyId: fam.id, name: 'Ismail', email: 'ismail@example.org' });
  const { db } = app.dbmod;
  const ts = new Date();
  db.insert(users).values({ id: 'usr_parent', username: 'ismail@example.org', passwordHash: 'x', role: 'parent', status: 'active', displayName: 'Ismail', mustChangePassword: false, createdAt: ts, updatedAt: ts }).run();
  db.insert(guardianUsers).values({ guardianId: g.id, userId: 'usr_parent', createdAt: ts }).run();
  db.update(families).set({ stripeCustomerId: 'cus_test' }).where(eq(families.id, fam.id)).run();
  return { admin, familyId: fam.id, studentId: stu.id, parent: caller('parent', 'usr_parent') };
}

/** Save `n` methods through the real procedure, so ordering is whatever the app actually does. */
async function saveMethods(parent: ReturnType<typeof caller>, familyId: string, ids: string[]) {
  for (const id of ids) await parent.portal.saveCard({ familyId, paymentMethodId: id });
}

const order = (familyId: string) =>
  app.dbmod.db
    .select({ id: paymentMethods.id, sortOrder: paymentMethods.sortOrder, isDefault: paymentMethods.isDefault })
    .from(paymentMethods)
    .where(eq(paymentMethods.familyId, familyId))
    .all()
    .sort((a, b) => a.sortOrder - b.sortOrder);
const enrolment = (familyId: string) => app.dbmod.db.select().from(autopayEnrollments).where(eq(autopayEnrollments.familyId, familyId)).get();

describe('saving methods', () => {
  it('keeps them in the order they were added, first one default', async () => {
    const { familyId, parent } = await household();
    await saveMethods(parent, familyId, ['pm_1111', 'pm_2222', 'pm_3333']);
    expect(order(familyId).map((r) => r.id)).toEqual(['pm_1111', 'pm_2222', 'pm_3333']);
    expect(order(familyId).map((r) => r.isDefault)).toEqual([true, false, false]);
  });

  it('does not let a newly added card jump the queue', async () => {
    // The household already chose what to charge first. Promoting the newest card over that choice is how
    // autopay quietly ends up on the wrong one.
    const { familyId, parent } = await household();
    await saveMethods(parent, familyId, ['pm_1111', 'pm_2222']);
    await parent.portal.setAutopay({ familyId, enabled: true });
    await saveMethods(parent, familyId, ['pm_9999']);
    expect(order(familyId).map((r) => r.id)).toEqual(['pm_1111', 'pm_2222', 'pm_9999']);
    expect(enrolment(familyId)!.defaultPmId).toBe('pm_1111');
  });
});

describe('reordering', () => {
  it('moves a method to the front and takes the default and the enrolment with it', async () => {
    const { familyId, parent } = await household();
    await saveMethods(parent, familyId, ['pm_1111', 'pm_2222']);
    await parent.portal.setAutopay({ familyId, enabled: true });
    expect(enrolment(familyId)!.defaultPmId).toBe('pm_1111');

    await parent.portal.reorderMethods({ familyId, orderedIds: ['pm_2222', 'pm_1111'] });

    const rows = order(familyId);
    expect(rows.map((r) => r.id)).toEqual(['pm_2222', 'pm_1111']);
    // All three in step — the whole point of resequenceMethods.
    expect(rows.map((r) => r.sortOrder)).toEqual([0, 1]);
    expect(rows.map((r) => r.isDefault)).toEqual([true, false]);
    expect(enrolment(familyId)!.defaultPmId).toBe('pm_2222');
    expect(enrolment(familyId)!.enabled).toBe(true); // still on; only the choice moved
  });

  it('refuses a list that is not exactly this set of methods', async () => {
    // A partial list would leave the rest at arbitrary positions, and this decides what gets charged.
    const { familyId, parent } = await household();
    await saveMethods(parent, familyId, ['pm_1111', 'pm_2222']);
    await expect(parent.portal.reorderMethods({ familyId, orderedIds: ['pm_1111'] })).rejects.toThrow(/out of date/i);
    await expect(parent.portal.reorderMethods({ familyId, orderedIds: ['pm_1111', 'pm_2222', 'pm_nope'] })).rejects.toThrow();
    expect(order(familyId).map((r) => r.id)).toEqual(['pm_1111', 'pm_2222']);
  });

  it('cannot be pointed at another household', async () => {
    const { familyId, parent } = await household();
    await saveMethods(parent, familyId, ['pm_1111']);
    const other = await caller('admin').people.familyCreate({ name: 'Farooqi' });
    await expect(parent.portal.reorderMethods({ familyId: other.id, orderedIds: ['pm_1111'] })).rejects.toThrow();
  });
});

describe('removing', () => {
  it('promotes the next choice and leaves autopay ON', async () => {
    // Before this, removing the charged card switched autopay off entirely — which is the opposite of what
    // having a second choice is for.
    const { familyId, parent } = await household();
    await saveMethods(parent, familyId, ['pm_1111', 'pm_2222']);
    await parent.portal.setAutopay({ familyId, enabled: true });

    await parent.portal.removeCard({ familyId, paymentMethodId: 'pm_1111' });

    expect(order(familyId).map((r) => [r.id, r.sortOrder, r.isDefault])).toEqual([['pm_2222', 0, true]]);
    expect(enrolment(familyId)).toMatchObject({ enabled: true, defaultPmId: 'pm_2222' });
  });

  it('switches autopay off when nothing is left to charge', async () => {
    // Enabled with no method behind it would be a promise the scheduler skips every day in silence.
    const { familyId, parent } = await household();
    await saveMethods(parent, familyId, ['pm_1111']);
    await parent.portal.setAutopay({ familyId, enabled: true });

    await parent.portal.removeCard({ familyId, paymentMethodId: 'pm_1111' });

    expect(order(familyId)).toEqual([]);
    expect(enrolment(familyId)).toMatchObject({ enabled: false, defaultPmId: null });
  });
});

describe('the retry ladder walks down the order', () => {
  it('charges the 1st choice, then the 2nd, then the 3rd', async () => {
    const { familyId, parent } = await household();
    await saveMethods(parent, familyId, ['pm_1111', 'pm_2222', 'pm_3333']);
    await parent.portal.setAutopay({ familyId, enabled: true });
    const { db } = app.dbmod;

    // Attempt 1 is a fresh enrolment (failureCount 0).
    await ap.chargeFamily(familyId, 20000, '2026-07-01');
    // Then as the ladder advances. `failureCount` is what the real decline path sets.
    for (const [n, date] of [[1, '2026-07-03'], [2, '2026-07-06']] as const) {
      db.update(autopayEnrollments).set({ failureCount: n }).where(eq(autopayEnrollments.familyId, familyId)).run();
      db.delete(autopayRuns).run(); // a new day's run; the same-day guard is tested elsewhere
      await ap.chargeFamily(familyId, 20000, date);
    }

    expect(charged).toEqual(['pm_1111', 'pm_2222', 'pm_3333']);
  });

  it('stays on the last choice when the ladder outruns the list', async () => {
    // One card must behave exactly as it did before any of this existed.
    const { familyId, parent } = await household();
    await saveMethods(parent, familyId, ['pm_1111']);
    await parent.portal.setAutopay({ familyId, enabled: true });
    const { db } = app.dbmod;
    db.update(autopayEnrollments).set({ failureCount: 2 }).where(eq(autopayEnrollments.familyId, familyId)).run();

    await ap.chargeFamily(familyId, 20000, '2026-07-06');

    expect(charged).toEqual(['pm_1111']);
  });
});
