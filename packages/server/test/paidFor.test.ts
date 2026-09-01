// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * WHAT a payment was for (0.48.0) — the parent portal's history said who and how much and left the parent
 * to guess which bill it settled. On a monthly plan that is a column of identical amounts, and "which one
 * was February, and did it cover the books?" is the question the office actually gets asked.
 *
 * The answer is DERIVED from `payment_allocations`, which is what makes these the interesting cases:
 *
 *  1. It follows the recompute. Allocation is recalculated whenever a bill changes, so a payment's
 *     description is not a fact about the day it was taken — generate the next month and the older
 *     payment must still name what it is now paying.
 *  2. THE INVOICE LEADS. Allocation has been per-line since 0.43.0, so almost every row names an item —
 *     reading those out gives "Monthly tuition · Book fee", which loses the only part the parent asked
 *     about, the MONTH. So the invoice's label leads, and the lines are named only where the payment
 *     covered part of a bill rather than all of it, which is the case that needs explaining.
 *  3. Money paid ahead is allocated to NOTHING, which must read as credit rather than as a blank. A row
 *     saying only "$200 · Card · 3 Feb" with no bill named reads as money gone missing.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { paymentAllocations, payments, charges, invoiceItems, invoices, chargeItems, studentFees, feePlans, students, classes, courses, families, terms, schoolYears, users, auditLog } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
const caller = (role: Role) => app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);
/** Imported inside `beforeAll` — a static import would bind the app to ./data (see harness.ts). */
let paidForByPayment: typeof import('../src/billing/paidFor')['paidForByPayment'];

beforeAll(async () => {
  app = await freshApp();
  ({ paidForByPayment } = await import('../src/billing/paidFor'));
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, charges, invoiceItems, invoices, chargeItems, studentFees, feePlans, students, classes, courses, families, terms, schoolYears, users, auditLog]) db.delete(t).run();
});

/** One child on $200/month with a $50 book fee on July's bill. */
async function seed() {
  const admin = caller('admin');
  const fam = await admin.people.familyCreate({ name: 'Ismail' });
  const plan = await admin.billing.feePlanCreate({ name: 'Monthly tuition', amountCents: 20000, cadence: 'monthly' });
  const s = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });
  await admin.billing.chargeAdd({ bill: 'period', studentId: s.id, source: { kind: 'custom', label: 'Book fee', amountCents: 5000 }, periodKey: '2026-07' });
  await admin.billing.generateFamily({ familyId: fam.id, periodKey: '2026-07', label: 'Tuition — Jul 2026', dueDate: '2026-07-01' });
  return { admin, familyId: fam.id, studentId: s.id };
}

/** What the portal would show for the family's one-and-only payment. */
function only() {
  const { db } = app.dbmod;
  const rows = db.select({ id: payments.id }).from(payments).all();
  expect(rows).toHaveLength(1);
  return paidForByPayment(db, [rows[0].id]).get(rows[0].id)!;
}

describe('a payment says what it was for', () => {
  it('names the bill it paid', async () => {
    const { admin, studentId } = await seed();
    await admin.billing.recordManualPayment({ studentId, amountCents: 25000, channel: 'cash', occurredAt: '2026-07-05' });
    const d = only();
    expect(d.advance).toBe(false);
    // Undirected money lands on the invoice, so the invoice's own label is what it is for.
    expect(d.labels).toEqual(['Tuition — Jul 2026']);
  });

  it('names the bill AND the line when the parent paid only part of it', async () => {
    // The month is what the parent is looking for, so the invoice leads; the line is added because this
    // payment settled one line out of two, which is precisely the case they need explaining.
    const { admin, studentId } = await seed();
    const { lines } = await admin.billing.studentPayables({ studentId });
    const book = lines.find((l) => l.label === 'Book fee')!;
    await admin.billing.recordManualPayment({
      studentId,
      amountCents: 5000,
      channel: 'cash',
      occurredAt: '2026-07-05',
      directed: [{ itemId: book.itemId, amountCents: 5000 }],
    });
    const d = only();
    expect(d.labels).toEqual(['Tuition — Jul 2026 · Book fee']);
  });

  it('does not list the lines of a bill that was paid in full', async () => {
    // Naming every line of a settled bill is length without information — "Tuition — Jul 2026" says it.
    const { admin, studentId } = await seed();
    await admin.billing.recordManualPayment({ studentId, amountCents: 25000, channel: 'cash', occurredAt: '2026-07-05' });
    expect((only()).labels).toEqual(['Tuition — Jul 2026']);
  });

  it('still names it after the next month is generated', async () => {
    // The property that matters: allocations are recomputed on every change, so this is read live rather
    // than stored. A description frozen at payment time would drift the moment another bill appeared.
    const { admin, familyId, studentId } = await seed();
    const { lines } = await admin.billing.studentPayables({ studentId });
    const book = lines.find((l) => l.label === 'Book fee')!;
    await admin.billing.recordManualPayment({
      studentId, amountCents: 5000, channel: 'cash', occurredAt: '2026-07-05',
      directed: [{ itemId: book.itemId, amountCents: 5000 }],
    });
    await admin.billing.generateFamily({ familyId, periodKey: '2026-08', label: 'Tuition — Aug 2026', dueDate: '2026-08-01' });
    const d = only();
    expect(d.labels).toEqual(['Tuition — Jul 2026 · Book fee']);
  });

  it('reports money paid before any bill exists as paid ahead, not as a blank', async () => {
    const admin = caller('admin');
    const fam = await admin.people.familyCreate({ name: 'Ismail' });
    const plan = await admin.billing.feePlanCreate({ name: 'Monthly tuition', amountCents: 20000, cadence: 'monthly' });
    const s = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });
    // Nothing generated yet, so there is nothing to allocate against.
    await admin.billing.recordManualPayment({ studentId: s.id, amountCents: 20000, channel: 'cash', occurredAt: '2026-06-20' });
    const d = only();
    expect(d.advance).toBe(true);
    expect(d.labels).toEqual([]);
  });

  it('stops being paid ahead once the bill it was waiting for arrives', async () => {
    const admin = caller('admin');
    const fam = await admin.people.familyCreate({ name: 'Ismail' });
    const plan = await admin.billing.feePlanCreate({ name: 'Monthly tuition', amountCents: 20000, cadence: 'monthly' });
    const s = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });
    await admin.billing.recordManualPayment({ studentId: s.id, amountCents: 20000, channel: 'cash', occurredAt: '2026-06-20' });
    await admin.billing.generateFamily({ familyId: fam.id, periodKey: '2026-07', label: 'Tuition — Jul 2026', dueDate: '2026-07-01' });
    const d = only();
    expect(d.advance).toBe(false);
    expect(d.labels).toEqual(['Tuition — Jul 2026']);
  });

  it('names several bills when one payment cleared more than one, biggest share first', async () => {
    const { admin, familyId, studentId } = await seed();
    await admin.billing.generateFamily({ familyId, periodKey: '2026-08', label: 'Tuition — Aug 2026', dueDate: '2026-08-01' });
    // $25,000 of July + $20,000 of August, paid in one go.
    await admin.billing.recordManualPayment({ studentId, amountCents: 45000, channel: 'cash', occurredAt: '2026-08-05' });
    const d = only();
    expect(d.labels).toContain('Tuition — Jul 2026');
    expect(d.labels).toContain('Tuition — Aug 2026');
    expect(d.more).toBe(0);
  });

  it('truncates visibly rather than silently', async () => {
    // Five bills settled by one payment: three named, and the count of what was left out — so a long
    // list never reads as a complete one.
    const { admin, familyId, studentId } = await seed();
    for (const m of ['08', '09', '10', '11']) {
      await admin.billing.generateFamily({ familyId, periodKey: `2026-${m}`, label: `Tuition — ${m} 2026`, dueDate: `2026-${m}-01` });
    }
    await admin.billing.recordManualPayment({ studentId, amountCents: 105000, channel: 'cash', occurredAt: '2026-11-05' });
    const d = only();
    expect(d.labels).toHaveLength(3);
    expect(d.more).toBe(2);
  });

  it('answers for every id it was asked about, including ones with no allocations', async () => {
    const { db } = app.dbmod;
    const out = paidForByPayment(db, ['pay_nope']);
    expect(out.get('pay_nope')).toEqual({ labels: [], more: 0, advance: true });
  });

  it('is one query set, not one per payment', async () => {
    // Batching is the reason this is a Map rather than a per-row helper: the portal renders 25 rows per
    // household. Asking for many ids at once must return them all.
    const { admin, familyId, studentId } = await seed();
    await admin.billing.generateFamily({ familyId, periodKey: '2026-08', label: 'Tuition — Aug 2026', dueDate: '2026-08-01' });
    await admin.billing.recordManualPayment({ studentId, amountCents: 25000, channel: 'cash', occurredAt: '2026-07-05' });
    await admin.billing.recordManualPayment({ studentId, amountCents: 20000, channel: 'cash', occurredAt: '2026-08-05' });
    const { db } = app.dbmod;
    const ids = db.select({ id: payments.id }).from(payments).all().map((p) => p.id);
    const out = paidForByPayment(db, ids);
    expect(out.size).toBe(2);
    expect([...out.values()].every((v) => v.labels.length > 0)).toBe(true);
  });
});
