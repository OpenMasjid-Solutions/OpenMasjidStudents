// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Who recorded the money (0.44.0) — `payments.recorded_by_name`.
 *
 * Cash is the one channel nobody else can verify: no Stripe id, no webhook, nothing to reconcile
 * against. The only record of who took it is the row, so the row says. What is worth testing is the
 * split that makes this useful without weakening the audit trail:
 *
 *   the PAYMENT carries the person's NAME     (the office asks "who took this?")
 *   the AUDIT LOG carries their USERNAME      (the account identity, which never changes)
 *
 * …and that an OpenMasjidOS SSO session, which has no local account at all, does not end up stamping
 * another system's untrusted display text onto an immutable money row.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, students, families, users, auditLog } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;

const caller = (role: Role, opts: { userId?: string; username?: string; source?: 'local' | 'sso' } = {}) =>
  app.appRouter.createCaller(
    makeCtx({
      origin: 'lan',
      session: { role, source: opts.source ?? 'local', username: opts.username ?? role, userId: opts.userId ?? `usr_${role}` },
    }).ctx,
  );

beforeAll(async () => {
  app = await freshApp();
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, students, families, users, auditLog]) db.delete(t).run();
});

/** One household, one child, one open bill — enough to record a payment against. */
async function scenario() {
  const admin = caller('admin');
  const fam = await admin.people.familyCreate({ name: 'Ismail' });
  const plan = await admin.billing.feePlanCreate({ name: 'Monthly tuition', amountCents: 5000, cadence: 'monthly' });
  const kid = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });
  await admin.billing.generateFamily({ familyId: fam.id, periodKey: '2026-07', label: 'Tuition — Jul 2026', dueDate: '2026-07-01' });
  return { admin, familyId: fam.id, studentId: kid.id };
}

describe('a payment says who recorded it', () => {
  it('uses the name the account was created with, not the username', async () => {
    const { admin, familyId, studentId } = await scenario();
    // Staff accounts take a name (Staff → Name); this is what makes the column worth having.
    const bilal = await admin.staff.create({ username: 'bilal', displayName: 'Ustādh Bilāl', role: 'finance', tempPassword: 'temp-pass-1234' });
    const finance = caller('finance', { userId: bilal.id, username: 'bilal' });

    await finance.billing.recordManualPayment({ studentId, amountCents: 5000, channel: 'cash', occurredAt: '2026-07-03' });

    const billing = await admin.billing.familyBilling({ familyId });
    expect(billing.payments).toHaveLength(1);
    expect(billing.payments[0].by).toBe('Ustādh Bilāl');

    // …while the audit trail still names the ACCOUNT. Two different questions, two different answers.
    const { db } = app.dbmod;
    const entry = db.select().from(auditLog).all().find((a) => a.action === 'payment.record');
    expect(entry?.actorName).toBe('bilal');
    expect(entry?.actorUserId).toBe(bilal.id);
  });

  it('falls back to the username when an account has no name of its own', async () => {
    const { admin, familyId, studentId } = await scenario();
    // No displayName passed — staff.create defaults it to the username, so that is what shows.
    const u = await admin.staff.create({ username: 'frontdesk', role: 'finance', tempPassword: 'temp-pass-1234' });
    await caller('finance', { userId: u.id, username: 'frontdesk' }).billing.recordManualPayment({ studentId, amountCents: 1000, channel: 'zelle', occurredAt: '2026-07-04' });
    const billing = await admin.billing.familyBilling({ familyId });
    expect(billing.payments[0].by).toBe('frontdesk');
  });

  it('records a platform SSO admin as plain "Admin" — never the platform\'s own display text', async () => {
    const { admin, familyId, studentId } = await scenario();
    // An SSO session has NO local user row (§12), so there is no name of ours to use. The platform does
    // send a username, but it is untrusted text from another system and this row is immutable.
    const sso = caller('admin', { source: 'sso', username: 'omos-dashboard-user', userId: undefined });
    await sso.billing.recordManualPayment({ studentId, amountCents: 2000, channel: 'cash', occurredAt: '2026-07-05' });
    const billing = await admin.billing.familyBilling({ familyId });
    expect(billing.payments[0].by).toBe('Admin');
  });

  it('names the person on a reversal too — a correction is somebody\'s decision', async () => {
    const { admin, familyId, studentId } = await scenario();
    const bilal = await admin.staff.create({ username: 'bilal', displayName: 'Ustādh Bilāl', role: 'finance', tempPassword: 'temp-pass-1234' });
    const finance = caller('finance', { userId: bilal.id, username: 'bilal' });
    const paid = await finance.billing.recordManualPayment({ studentId, amountCents: 5000, channel: 'cash', occurredAt: '2026-07-03' });
    await finance.billing.reversePayment({ paymentId: paid.paymentId });

    const billing = await admin.billing.familyBilling({ familyId });
    const reversal = billing.payments.find((p) => p.amountCents < 0);
    expect(reversal?.by).toBe('Ustādh Bilāl');
  });

  it('the CSV export carries the same name', async () => {
    const { admin, studentId } = await scenario();
    const bilal = await admin.staff.create({ username: 'bilal', displayName: 'Ustādh Bilāl', role: 'finance', tempPassword: 'temp-pass-1234' });
    await caller('finance', { userId: bilal.id, username: 'bilal' }).billing.recordManualPayment({ studentId, amountCents: 5000, channel: 'cash', occurredAt: '2026-07-03' });
    const csv = await admin.billing.exportCsv({ dataset: 'payments' });
    expect(csv.csv).toContain('Recorded by');
    expect(csv.csv).toContain('Ustādh Bilāl');
  });
});
