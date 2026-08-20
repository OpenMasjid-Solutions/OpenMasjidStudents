// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * ITEMISED BILLS (0.43.0): a bill made of tuition plus a one-off charge can be read line by line, and a
 * parent can pay ONE of those lines.
 *
 * Two properties carry the whole feature, and both are here:
 *
 *  1. THE ARITHMETIC. The lines of an invoice add up to that invoice's balance — otherwise a kiosk that
 *     sums what the parent ticked charges the wrong amount. Credit lines are the interesting case: their
 *     value is deducted from the lines above them and they report a balance of 0, so summing is always
 *     safe.
 *  2. SURVIVAL. Allocation is DERIVED and recomputed whenever a bill changes, so an instruction honored
 *     only at the moment of payment would be silently undone by the next month's invoice — the book fee
 *     the parent deliberately settled would be outstanding again on their next statement. The
 *     instruction is stored on the payment and re-applied on every recompute, and the test that matters
 *     is the one that generates another month afterwards and checks the line is still settled.
 *
 * Also pinned: the sibling wall (an instruction cannot name another child's line) lives in
 * ledger.test.ts, and the office-facing path (`recordManualPayment` with `directed`) is exercised here
 * because that is what the finance screen actually calls.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { paymentAllocations, payments, charges, invoiceItems, invoices, chargeItems, studentFees, feePlans, students, classes, courses, families, terms, schoolYears, users, auditLog } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
const caller = (role: Role) => app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp();
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, charges, invoiceItems, invoices, chargeItems, studentFees, feePlans, students, classes, courses, families, terms, schoolYears, users, auditLog]) db.delete(t).run();
});

/** One child on $200/month, billed for July, with a $50 book fee on the same invoice. */
async function seedBillWithCharge() {
  const admin = caller('admin');
  const fam = await admin.people.familyCreate({ name: 'Ismail' });
  const plan = await admin.billing.feePlanCreate({ name: 'Monthly tuition', amountCents: 20000, cadence: 'monthly' });
  const s = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });
  await admin.billing.chargeAdd({ studentId: s.id, source: { kind: 'custom', label: 'Book fee', amountCents: 5000 }, periodKey: '2026-07' });
  await admin.billing.generateFamily({ familyId: fam.id, periodKey: '2026-07', label: 'Tuition — Jul 2026', dueDate: '2026-07-01' });
  return { admin, familyId: fam.id, studentId: s.id };
}

const lineNamed = (lines: { label: string }[], label: string) => lines.find((l) => l.label === label)!;

describe('a bill can be read line by line', () => {
  it('lists the tuition and the one-off charge separately, with their kinds', async () => {
    const { admin, studentId } = await seedBillWithCharge();
    const { lines, balance } = await admin.billing.studentPayables({ studentId });

    expect(lines.map((l) => [l.label, l.kind, l.amountCents])).toEqual([
      ['Monthly tuition', 'tuition', 20000],
      ['Book fee', 'charge', 5000],
    ]);
    expect(balance.owedCents).toBe(25000);
  });

  it('the lines add up to the invoice balance — including after a partial payment', async () => {
    const { admin, studentId } = await seedBillWithCharge();
    await admin.billing.recordManualPayment({ studentId, amountCents: 12000, channel: 'cash', occurredAt: '2026-07-05' });

    const { lines } = await admin.billing.studentPayables({ studentId });
    const invoice = (await admin.billing.studentBilling({ studentId })).invoices[0];
    expect(lines.reduce((s, l) => s + l.balanceCents, 0)).toBe(invoice.balanceCents);
    // Undirected money covers the lines in the order they were written: tuition first.
    expect(lineNamed(lines, 'Monthly tuition').balanceCents).toBe(8000);
    expect(lineNamed(lines, 'Book fee').balanceCents).toBe(5000);
  });

  /** A negative charge (a bursary, a correction) is not something anyone pays. Its value comes off the
   *  lines above it and it reports 0, which is what keeps a consumer's sum honest. */
  it('a credit line reduces the payable lines and reports no balance of its own', async () => {
    const { admin, studentId, familyId } = await seedBillWithCharge();
    await admin.billing.chargeAdd({ studentId, source: { kind: 'custom', label: 'Bursary', amountCents: -5000 }, periodKey: '2026-07' });

    const all = await admin.billing.invoiceLines({ invoiceId: (await admin.billing.familyBilling({ familyId })).invoices[0].id });
    const credit = lineNamed(all, 'Bursary');
    expect([credit.kind, credit.amountCents, credit.balanceCents]).toEqual(['credit', -5000, 0]);
    // $250 billed − $50 bursary = $200 payable. The bursary covers the lines in the canonical order,
    // so it comes off the tuition first (billing/lines.ts `orderedItems`).
    expect(lineNamed(all, 'Monthly tuition').balanceCents).toBe(15000);
    expect(lineNamed(all, 'Book fee').balanceCents).toBe(5000);
    expect(all.reduce((s, l) => s + l.balanceCents, 0)).toBe(20000);
  });
});

describe('paying ONE line', () => {
  it('settles the line the parent chose, not the oldest one', async () => {
    const { admin, studentId } = await seedBillWithCharge();
    const book = lineNamed((await admin.billing.studentPayables({ studentId })).lines, 'Book fee');

    await admin.billing.recordManualPayment({ studentId, amountCents: 5000, channel: 'cash', occurredAt: '2026-07-06', directed: [{ itemId: book.itemId, amountCents: 5000 }] });

    const { lines } = await admin.billing.studentPayables({ studentId });
    // The book fee is gone from the payable list; the tuition is untouched and still owed in full.
    expect(lines.map((l) => l.label)).toEqual(['Monthly tuition']);
    expect(lines[0].balanceCents).toBe(20000);
  });

  /**
   * THE property. Generating August recomputes every allocation this child has; if the instruction were
   * not stored, the $50 would slide onto July's tuition (oldest-due-first) and the book fee would read
   * as unpaid again — on the statement, in the portal and at the kiosk.
   */
  it('stays settled after the next month is generated', async () => {
    const { admin, studentId, familyId } = await seedBillWithCharge();
    const book = lineNamed((await admin.billing.studentPayables({ studentId })).lines, 'Book fee');
    await admin.billing.recordManualPayment({ studentId, amountCents: 5000, channel: 'cash', occurredAt: '2026-07-06', directed: [{ itemId: book.itemId, amountCents: 5000 }] });

    await admin.billing.generateFamily({ familyId, periodKey: '2026-08', label: 'Tuition — Aug 2026', dueDate: '2026-08-01' });

    const { lines } = await admin.billing.studentPayables({ studentId });
    expect(lines.some((l) => l.label === 'Book fee')).toBe(false);
    // July tuition and August tuition are both still owed, in that order.
    expect(lines.map((l) => [l.invoiceLabel, l.balanceCents])).toEqual([
      ['Tuition — Jul 2026', 20000],
      ['Tuition — Aug 2026', 20000],
    ]);
  });

  it('reversing the payment puts the line back', async () => {
    const { admin, studentId } = await seedBillWithCharge();
    const book = lineNamed((await admin.billing.studentPayables({ studentId })).lines, 'Book fee');
    const p = await admin.billing.recordManualPayment({ studentId, amountCents: 5000, channel: 'cash', occurredAt: '2026-07-06', directed: [{ itemId: book.itemId, amountCents: 5000 }] });

    await admin.billing.reversePayment({ paymentId: p.paymentId });

    const { lines, balance } = await admin.billing.studentPayables({ studentId });
    expect(lineNamed(lines, 'Book fee').balanceCents).toBe(5000);
    expect(balance.owedCents).toBe(25000);
  });

  it('an instruction for a line that no longer needs the money falls back to oldest-due-first', async () => {
    const { admin, studentId, familyId } = await seedBillWithCharge();
    const book = lineNamed((await admin.billing.studentPayables({ studentId })).lines, 'Book fee');
    // Somebody settles the whole July bill in the office while a kiosk session is still open on the
    // book fee. The second payment must not vanish, and must not overpay the line.
    await admin.billing.recordManualPayment({ studentId, amountCents: 25000, channel: 'cash', occurredAt: '2026-07-05' });
    await admin.billing.generateFamily({ familyId, periodKey: '2026-08', label: 'Tuition — Aug 2026', dueDate: '2026-08-01' });
    await admin.billing.recordManualPayment({ studentId, amountCents: 5000, channel: 'cash', occurredAt: '2026-07-06', directed: [{ itemId: book.itemId, amountCents: 5000 }] });

    const { lines, balance } = await admin.billing.studentPayables({ studentId });
    expect(balance.owedCents).toBe(15000); // 20000 August − the 5000 that had nowhere else to go
    expect(lines.map((l) => [l.invoiceLabel, l.balanceCents])).toEqual([['Tuition — Aug 2026', 15000]]);
  });
});
