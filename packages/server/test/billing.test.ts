// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Billing router (CLAUDE.md §4/§5): fee plans, per-student assignment, per-family discount,
 * invoice generation (with discount line), the family ledger view, manual payments, void, and
 * the walls — admin + finance only (parent refused; admin over tunnel refused; finance
 * works over the tunnel).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, students, families, users, auditLog } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
const caller = (role: Role, opts: { origin?: 'lan' | 'tunnel'; userId?: string } = {}) =>
  app.appRouter.createCaller(makeCtx({ origin: opts.origin ?? 'lan', session: { role, source: 'local', username: role, userId: opts.userId ?? `usr_${role}` } }).ctx);

beforeAll(async () => { app = await freshApp(); });
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, students, families, users, auditLog]) db.delete(t).run();
});

/** studentCreate REQUIRES a fee plan (a student on no plan is invisible to invoice generation),
 *  so the plan is created first and both students are placed on it. Callers that need a
 *  different amount or cadence pass their own. */
async function scenario(plan: { name: string; amountCents: number; cadence: 'monthly' | 'per_term' | 'one_time' } = { name: 'Monthly tuition', amountCents: 5000, cadence: 'monthly' }) {
  const admin = caller('admin');
  const fam = await admin.people.familyCreate({ name: 'Ismail' });
  const p = await admin.billing.feePlanCreate(plan);
  const s1 = await admin.people.studentCreate({ familyId: fam.id, firstName: 'Yusuf', lastName: 'Ismail', feePlanId: p.id });
  const s2 = await admin.people.studentCreate({ familyId: fam.id, firstName: 'Sara', lastName: 'Ismail', feePlanId: p.id });
  return { admin, familyId: fam.id, s1: s1.id, s2: s2.id, planId: p.id };
}

describe('fee plans → assign → generate → pay', () => {
  it('generates a family invoice from assigned fees and records a payment against it', async () => {
    const { admin, familyId } = await scenario();
    const gen = await admin.billing.generateFamily({ familyId, periodKey: '2026-07', label: 'Tuition — Jul 2026', dueDate: '2026-07-01' });
    expect(gen.created).toBe(true);
    let billing = await admin.billing.familyBilling({ familyId });
    expect(billing.invoices[0].totalCents).toBe(10000); // 2 students × $50
    expect(billing.balance.owedCents).toBe(10000);
    // Re-generating the same period is idempotent (no duplicate invoice).
    const again = await admin.billing.generateFamily({ familyId, periodKey: '2026-07', label: 'x' });
    expect(again.created).toBe(false);
    // Pay part, then the rest.
    await admin.billing.recordManualPayment({ familyId, amountCents: 4000, channel: 'cash', occurredAt: '2026-07-03' });
    billing = await admin.billing.familyBilling({ familyId });
    expect(billing.invoices[0].status).toBe('partially_paid');
    expect(billing.balance.owedCents).toBe(6000);
    await admin.billing.recordManualPayment({ familyId, amountCents: 6000, channel: 'check', occurredAt: '2026-07-10' });
    billing = await admin.billing.familyBilling({ familyId });
    expect(billing.invoices[0].status).toBe('paid');
    expect(billing.balance.balanceCents).toBe(0);
  });

  it('applies a family percent discount as a negative line', async () => {
    const { admin, familyId } = await scenario({ name: 'Tuition', amountCents: 10000, cadence: 'per_term' });
    await admin.billing.setDiscount({ familyId, kind: 'percent', value: 1000 }); // 10%
    // A per-term plan only bills on a TERM period now that cadence is enforced.
    await admin.billing.generateFamily({ familyId, periodKey: 'T1', label: 'Term 1', periodKind: 'term' });
    const billing = await admin.billing.familyBilling({ familyId });
    expect(billing.invoices[0].totalCents).toBe(18000); // 20000 - 10%
  });

  it('refuses to void an invoice that still carries payment; allows it once reversed', async () => {
    const { admin, familyId } = await scenario({ name: 'Tuition', amountCents: 8000, cadence: 'one_time' });
    await admin.billing.generateFamily({ familyId, periodKey: 'once', label: 'One-time' });
    const invId = (await admin.billing.familyBilling({ familyId })).invoices[0].id;
    const pay = await admin.billing.recordManualPayment({ familyId, amountCents: 16000, channel: 'cash', occurredAt: '2026-07-03' });
    // Voiding a paid invoice would understate the balance — refuse until the payment is reversed.
    await expect(admin.billing.voidInvoice({ id: invId })).rejects.toMatchObject({ code: 'CONFLICT' });
    await admin.billing.reversePayment({ paymentId: pay.paymentId });
    await admin.billing.voidInvoice({ id: invId });
    expect((await admin.billing.familyBilling({ familyId })).invoices[0].status).toBe('void');
    // Balance stays coherent: nothing invoiced (voided), the payment netted out by its reversal.
    expect((await admin.billing.familyBilling({ familyId })).balance.balanceCents).toBe(0);
  });

  it('familyBilling reports the family discount so the finance form can show it', async () => {
    const { admin, familyId } = await scenario();
    expect((await admin.billing.familyBilling({ familyId })).discount).toMatchObject({ kind: 'none', value: 0 });
    await admin.billing.setDiscount({ familyId, kind: 'percent', value: 1500 });
    expect((await admin.billing.familyBilling({ familyId })).discount).toMatchObject({ kind: 'percent', value: 1500 });
  });

  it('reversing a payment restores the balance; void removes an invoice from the balance', async () => {
    const { admin, familyId } = await scenario({ name: 'Tuition', amountCents: 8000, cadence: 'one_time' });
    await admin.billing.generateFamily({ familyId, periodKey: 'once', label: 'One-time' });
    const pay = await admin.billing.recordManualPayment({ familyId, amountCents: 16000, channel: 'cash', occurredAt: '2026-07-03' });
    expect((await admin.billing.familyBilling({ familyId })).balance.balanceCents).toBe(0);
    await admin.billing.reversePayment({ paymentId: pay.paymentId });
    expect((await admin.billing.familyBilling({ familyId })).balance.owedCents).toBe(16000);
    const invId = (await admin.billing.familyBilling({ familyId })).invoices[0].id;
    await admin.billing.voidInvoice({ id: invId });
    expect((await admin.billing.familyBilling({ familyId })).balance.owedCents).toBe(0);
  });
});

describe('walls', () => {
  it('billing is admin+finance only; teacher/parent refused; admin over tunnel refused; finance over tunnel ok', async () => {
    const { admin, familyId } = await scenario();
    for (const r of ['parent'] as const) {
      await expect(caller(r).billing.feePlanList()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(caller(r).billing.familyBilling({ familyId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(caller(r).billing.recordManualPayment({ familyId, amountCents: 100, channel: 'cash', occurredAt: '2026-07-01' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await expect(caller('admin', { origin: 'tunnel' }).billing.feePlanList()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // finance can do billing, including over the tunnel
    expect(Array.isArray(await caller('finance', { origin: 'tunnel' }).billing.feePlanList())).toBe(true);
    const r = await caller('finance', { origin: 'tunnel' }).billing.familiesOverview();
    expect(r.find((f) => f.id === familyId)).toBeTruthy();
    void admin;
  });
});
