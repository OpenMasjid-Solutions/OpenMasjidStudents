// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The edges around a credit BIGGER than the bill it sits on, and the one that matters most: autopay must
 * never charge a card more than the household actually owes.
 *
 * Found by reviewing 0.43.0, but the root is older. A negative charge is the documented way to record a
 * bursary or a correction (§9: an invoice line is immutable, so the fix is a second, negative charge), and
 * nothing stops one being larger than the invoice it lands on — a 100% scholarship, or a correction for
 * an over-billed month. That makes an invoice cost less than nothing, and two things then go wrong:
 *
 *  1. Autopay walked invoices and summed only the POSITIVE ones, so a family whose derived balance said
 *     they owed nothing could still be charged. Money out of a parent's card that the app itself says is
 *     not owed is the worst failure in here, so the derived balance is now a hard ceiling on the charge.
 *  2. An invoice costing nothing read as "Open" forever, because the status check asked "has anything been
 *     paid?" before "does this cost anything?". No payment can ever be made against it, so it never left
 *     that state.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { autopayEnrollments, autopayRuns, paymentMethods, paymentAllocations, payments, charges, chargeItems, invoiceItems, invoices, studentFees, feePlans, students, families, users, auditLog } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let autopay: typeof import('../src/payments/autopay');
let ledger: typeof import('../src/billing/ledger');
const caller = (role: Role) => app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp();
  autopay = await import('../src/payments/autopay');
  ledger = await import('../src/billing/ledger');
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [autopayRuns, autopayEnrollments, paymentMethods, paymentAllocations, payments, charges, chargeItems, invoiceItems, invoices, studentFees, feePlans, students, families, users, auditLog]) db.delete(t).run();
});

/** One child on $100/month with February billed, plus autopay armed on a saved card. */
async function seedWithAutopay() {
  const admin = caller('admin');
  const fam = await admin.people.familyCreate({ name: 'Ismail' });
  const plan = await admin.billing.feePlanCreate({ name: 'Monthly tuition', amountCents: 10000, cadence: 'monthly' });
  const s = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });
  await admin.billing.generateFamily({ familyId: fam.id, periodKey: '2027-02', label: 'Tuition — Feb 2027', dueDate: '2027-02-01' });

  const ts = new Date();
  const { db } = app.dbmod;
  db.insert(paymentMethods).values({ id: 'pm_1', familyId: fam.id, stripePmId: 'pm_stripe', brand: 'visa', last4: '4242', expMonth: 1, expYear: 2030, isDefault: true, createdAt: ts }).run();
  db.insert(autopayEnrollments).values({ familyId: fam.id, enabled: true, defaultPmId: 'pm_1', consentAt: ts, failureCount: 0, nextAttemptAt: null, createdAt: ts, updatedAt: ts }).run();
  return { admin, familyId: fam.id, studentId: s.id };
}

describe('autopay never charges more than the household owes', () => {
  it('charges the due bill when it is genuinely owed', async () => {
    const { familyId } = await seedWithAutopay();
    expect(autopay.autopayDue('2027-02-05')).toEqual([{ familyId, amountCents: 10000 }]);
  });

  /**
   * A correction bigger than the month it corrects. The family is $200 in credit by the app's own
   * reckoning; charging them anything is indefensible, and it used to repeat every single month.
   */
  it('charges nothing when a correction leaves the family in credit', async () => {
    const { admin, familyId, studentId } = await seedWithAutopay();
    await admin.billing.chargeAdd({ studentId, source: { kind: 'custom', label: 'Correction — over-billed', amountCents: -30000 }, periodKey: '2027-02' });
    await admin.billing.generateFamily({ familyId, periodKey: '2027-03', label: 'Tuition — Mar 2027', dueDate: '2027-03-01' });

    const bal = ledger.familyBalance(familyId);
    expect({ owed: bal.owedCents, credit: bal.creditCents }).toEqual({ owed: 0, credit: 10000 });
    expect(autopay.autopayDue('2027-03-05'), 'a family in credit must never be charged').toEqual([]);
  });

  it('charges only the part that is really owed when a credit covers some of it', async () => {
    const { admin, familyId, studentId } = await seedWithAutopay();
    // Feb $100, a $150 correction against it, then March $100 → net owed $50.
    await admin.billing.chargeAdd({ studentId, source: { kind: 'custom', label: 'Correction', amountCents: -15000 }, periodKey: '2027-02' });
    await admin.billing.generateFamily({ familyId, periodKey: '2027-03', label: 'Tuition — Mar 2027', dueDate: '2027-03-01' });

    expect(ledger.familyBalance(familyId).owedCents).toBe(5000);
    expect(autopay.autopayDue('2027-03-05')).toEqual([{ familyId, amountCents: 5000 }]);
  });
});

describe('a bill that costs nothing is settled, not open', () => {
  it('a 100% bursary settles the invoice instead of leaving it open forever', async () => {
    const { admin, familyId, studentId } = await seedWithAutopay();
    await admin.billing.chargeAdd({ studentId, source: { kind: 'custom', label: 'Bursary', amountCents: -10000 }, periodKey: '2027-02' });

    const inv = (await admin.billing.familyBilling({ familyId })).invoices[0];
    expect({ total: inv.totalCents, status: inv.status }).toEqual({ total: 0, status: 'paid' });
    expect(ledger.familyBalance(familyId).owedCents).toBe(0);
    expect(autopay.autopayDue('2027-02-05')).toEqual([]);
  });
});
