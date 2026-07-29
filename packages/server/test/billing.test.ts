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
  const s1 = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: p.id });
  const s2 = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Sara Ismail', feePlanId: p.id });
  return { admin, familyId: fam.id, s1: s1.id, s2: s2.id, planId: p.id };
}

describe('fee plans → assign → generate → pay', () => {
  /** Billing a household now creates ONE INVOICE PER CHILD. The parent still sees one combined figure;
   *  the difference is that each child's bill exists in its own right. */
  it('generates one invoice per child and records a payment against one of them', async () => {
    const { admin, familyId, s1 } = await scenario();
    const gen = await admin.billing.generateFamily({ familyId, periodKey: '2026-07', label: 'Tuition — Jul 2026', dueDate: '2026-07-01' });
    expect(gen.created).toBe(2); // two children, two bills
    let billing = await admin.billing.familyBilling({ familyId });
    expect(billing.invoices).toHaveLength(2);
    expect(billing.invoices.every((i) => i.totalCents === 5000)).toBe(true); // $50 each
    expect(billing.balance.owedCents).toBe(10000); // the household total is unchanged
    // Re-generating the same period is idempotent (no duplicate invoices).
    expect((await admin.billing.generateFamily({ familyId, periodKey: '2026-07', label: 'x' })).created).toBe(0);

    // Pay one child in two goes. The money touches HIS bill only.
    await admin.billing.recordManualPayment({ studentId: s1, amountCents: 2000, channel: 'cash', occurredAt: '2026-07-03' });
    billing = await admin.billing.familyBilling({ familyId });
    expect(billing.invoices.find((i) => i.studentId === s1)!.status).toBe('partially_paid');
    expect(billing.students.find((k) => k.id === s1)!.balance.owedCents).toBe(3000);
    expect(billing.balance.owedCents).toBe(8000);
    await admin.billing.recordManualPayment({ studentId: s1, amountCents: 3000, channel: 'check', occurredAt: '2026-07-10' });
    billing = await admin.billing.familyBilling({ familyId });
    expect(billing.invoices.find((i) => i.studentId === s1)!.status).toBe('paid');
    expect(billing.students.find((k) => k.id === s1)!.balance.balanceCents).toBe(0);
    // The sibling is untouched — his bill is still fully open.
    expect(billing.balance.owedCents).toBe(5000);
  });

  /** The family discount was dropped in 0.39.0. A reduced rate is the per-student override, which lands
   *  on the child whose bill it reduces rather than as a household line no single invoice could carry. */
  it('a per-student override is how a reduced rate is expressed', async () => {
    const { admin, familyId, s1 } = await scenario({ name: 'Tuition', amountCents: 10000, cadence: 'per_term' });
    const fees = await admin.billing.familyFees({ familyId });
    const s1Fee = fees.find((f) => f.studentId === s1)!;
    await admin.billing.setFeeOverride({ id: s1Fee.feeId!, overrideAmountCents: 9000, note: 'Sibling rate' });
    // A per-term plan only bills on a TERM period now that cadence is enforced.
    await admin.billing.generateFamily({ familyId, periodKey: 'T1', label: 'Term 1', periodKind: 'term' });
    const billing = await admin.billing.familyBilling({ familyId });
    expect(billing.invoices.find((i) => i.studentId === s1)!.totalCents).toBe(9000);
    expect(billing.invoices.find((i) => i.studentId !== s1)!.totalCents).toBe(10000);
    expect(billing.balance.owedCents).toBe(19000);
  });

  it('refuses to void an invoice that still carries payment; allows it once reversed', async () => {
    const { admin, familyId, s1 } = await scenario({ name: 'Tuition', amountCents: 8000, cadence: 'one_time' });
    await admin.billing.generateFamily({ familyId, periodKey: 'once', label: 'One-time' });
    const invId = (await admin.billing.studentBilling({ studentId: s1 })).invoices[0].id;
    const pay = await admin.billing.recordManualPayment({ studentId: s1, amountCents: 8000, channel: 'cash', occurredAt: '2026-07-03' });
    // Voiding a paid invoice would understate the balance — refuse until the payment is reversed.
    await expect(admin.billing.voidInvoice({ id: invId })).rejects.toMatchObject({ code: 'CONFLICT' });
    await admin.billing.reversePayment({ paymentId: pay.paymentId });
    await admin.billing.voidInvoice({ id: invId });
    const after = await admin.billing.studentBilling({ studentId: s1 });
    expect(after.invoices[0].status).toBe('void');
    // Balance stays coherent: nothing invoiced (voided), the payment netted out by its reversal.
    expect(after.balance.balanceCents).toBe(0);
  });

  it('studentBilling shows one child’s own record', async () => {
    const { admin, s1, s2 } = await scenario();
    await admin.billing.generateFamily({ familyId: (await admin.billing.studentBilling({ studentId: s1 })).student.familyId, periodKey: '2026-07', label: 'Jul' });
    const a = await admin.billing.studentBilling({ studentId: s1 });
    expect(a.student.id).toBe(s1);
    expect(a.invoices).toHaveLength(1);
    expect(a.balance.owedCents).toBe(5000);
    // And it really is scoped: the sibling's bill is nowhere in it.
    expect(a.invoices.every((i) => i.studentId === s1)).toBe(true);
    expect((await admin.billing.studentBilling({ studentId: s2 })).invoices.every((i) => i.studentId === s2)).toBe(true);
  });

  it('reversing a payment restores the balance; void removes an invoice from the balance', async () => {
    const { admin, s1 } = await scenario({ name: 'Tuition', amountCents: 8000, cadence: 'one_time' });
    const familyId = (await admin.billing.studentBilling({ studentId: s1 })).student.familyId;
    await admin.billing.generateFamily({ familyId, periodKey: 'once', label: 'One-time' });
    const pay = await admin.billing.recordManualPayment({ studentId: s1, amountCents: 8000, channel: 'cash', occurredAt: '2026-07-03' });
    expect((await admin.billing.studentBilling({ studentId: s1 })).balance.balanceCents).toBe(0);
    await admin.billing.reversePayment({ paymentId: pay.paymentId });
    expect((await admin.billing.studentBilling({ studentId: s1 })).balance.owedCents).toBe(8000);
    const invId = (await admin.billing.studentBilling({ studentId: s1 })).invoices[0].id;
    await admin.billing.voidInvoice({ id: invId });
    expect((await admin.billing.studentBilling({ studentId: s1 })).balance.owedCents).toBe(0);
  });
});

describe('walls', () => {
  it('billing is admin+finance only; teacher/parent refused; admin over tunnel refused; finance over tunnel ok', async () => {
    const { admin, familyId, s1 } = await scenario();
    for (const r of ['parent'] as const) {
      await expect(caller(r).billing.feePlanList()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(caller(r).billing.familyBilling({ familyId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(caller(r).billing.recordManualPayment({ studentId: s1, amountCents: 100, channel: 'cash', occurredAt: '2026-07-01' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await expect(caller('admin', { origin: 'tunnel' }).billing.feePlanList()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // finance can do billing, including over the tunnel
    expect(Array.isArray(await caller('finance', { origin: 'tunnel' }).billing.feePlanList())).toBe(true);
    const r = await caller('finance', { origin: 'tunnel' }).billing.familiesOverview();
    expect(r.find((f) => f.id === familyId)).toBeTruthy();
    void admin;
  });

  /**
   * 0.42.0 (Hasan's call): finance RUNS the billing but does not decide WHAT the madrasa charges.
   * Archiving a plan silently unassigns every student on it and deleting one is permanent, so all
   * three writes sit behind the admin wall while the list stays readable — no invoice screen means
   * anything without the plan names.
   */
  it('fee plans: finance can read them but cannot create, archive or delete one', async () => {
    const { planId } = await scenario();
    const finance = caller('finance');
    expect(Array.isArray(await finance.billing.feePlanList())).toBe(true);
    await expect(finance.billing.feePlanCreate({ name: 'Sneaky', amountCents: 100, cadence: 'monthly' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(finance.billing.feePlanArchive({ id: planId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(finance.billing.feePlanDelete({ id: planId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(finance.billing.feePlanDeletable({ id: planId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Nothing happened: the plan is still there and still assigned.
    expect((await caller('admin').billing.feePlanList()).some((p) => p.id === planId)).toBe(true);
  });
});
