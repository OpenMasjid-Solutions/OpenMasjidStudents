// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Deleting a student outright — "not just withdrawn".
 *
 * The line that matters: delete is for a MISTAKE (a duplicate, a typo, a child who never enrolled).
 * A student who has ever been billed appears on a raised invoice, and removing them would quietly
 * change what that invoice says it was for — the immutability §9 protects. Those students are
 * withdrawn, never deleted, and all three FKs into `students` are ON DELETE RESTRICT so the database
 * would refuse anyway; these tests prove we refuse FIRST, with a sentence the office can act on.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshApp, makeCtx } from './harness';
import { families, students, feePlans, studentFees, invoices, invoiceItems, payments, paymentAllocations, charges, chargeItems, auditLog } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
const caller = (role: Role) => app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp();
});

beforeEach(() => {
  const { db } = app.dbmod;
  // Children before parents: `charges.invoice_item_id` references invoice_items, so charges must go
  // first or the RESTRICT constraint refuses the cleanup itself.
  for (const t of [paymentAllocations, payments, charges, chargeItems, invoiceItems, invoices, studentFees, students, feePlans, families]) db.delete(t).run();
  // The trail too: the forced-delete test looks for its OWN audit row, and rows accumulate otherwise —
  // it would have matched an earlier test's identical row and passed without proving anything.
  db.delete(auditLog).run();
});

async function seed() {
  const admin = caller('admin');
  const fam = await admin.people.familyCreate({ name: 'Ismail' });
  const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
  const s = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });
  return { admin, famId: fam.id, planId: plan.id, studentId: s.id };
}

describe('studentDeletable — the reason, before the click', () => {
  it('reports a never-billed student as deletable, and counts what goes with them', async () => {
    const { admin, studentId } = await seed();
    const info = await admin.people.studentDeletable({ studentId });
    expect(info.deletable).toBe(true);
    expect(info.invoiceLines).toBe(0);
    expect(info.feeAssignments).toBe(1); // studentCreate requires a plan
  });

  it('reports a billed student as NOT deletable, and says how many lines block it', async () => {
    const { admin, studentId } = await seed();
    await admin.billing.generatePeriod({ periodKey: '2026-07', label: 'Tuition — Jul 2026' });
    const info = await admin.people.studentDeletable({ studentId });
    expect(info.deletable).toBe(false);
    expect(info.invoiceLines).toBeGreaterThan(0);
  });
});

describe('studentDelete', () => {
  it('deletes a never-billed student and their fee assignment in one go', async () => {
    const { admin, studentId } = await seed();
    const r = await admin.people.studentDelete({ studentId });
    expect(r.ok).toBe(true);
    expect(r.removedFees).toBe(1);
    const { db } = app.dbmod;
    expect(db.select().from(students).where(eq(students.id, studentId)).get()).toBeUndefined();
    // The RESTRICT constraint would have blocked this if the fee row were left behind.
    expect(db.select().from(studentFees).where(eq(studentFees.studentId, studentId)).all()).toHaveLength(0);
  });

  it('takes a pending charge with them, but REFUSES once that charge is on an invoice', async () => {
    const { admin, studentId } = await seed();
    // A pending charge is not yet money — it goes with them.
    await admin.billing.chargeAdd({ bill: 'period', studentId, source: { kind: 'custom', label: 'Books', amountCents: 1000 } });
    let info = await admin.people.studentDeletable({ studentId });
    expect(info.deletable).toBe(true);
    expect(info.pendingCharges).toBe(1);

    // Invoice it, and now it is history.
    await admin.billing.generatePeriod({ periodKey: '2026-07', label: 'Tuition — Jul 2026' });
    info = await admin.people.studentDeletable({ studentId });
    expect(info.deletable).toBe(false);
    await expect(admin.people.studentDelete({ studentId })).rejects.toThrow(/billed|withdrawn/i);
  });

  /**
   * The gap that shipped in 0.41.0: a child with an advance payment and NOTHING billed passed the
   * precheck, and the delete then died on the RESTRICT constraint — handing the office a raw
   * "FOREIGN KEY constraint failed" (§15: never). Money that arrived is money on the books, whether or
   * not a bill exists for it.
   */
  it('refuses a student who has been PAID for, even with nothing billed — and never with a raw DB error', async () => {
    const { admin, studentId } = await seed();
    await admin.billing.recordManualPayment({ studentId, amountCents: 7000, channel: 'cash', occurredAt: '2026-03-20' });

    const info = await admin.people.studentDeletable({ studentId });
    expect(info).toMatchObject({ deletable: false, payments: 1, invoiceLines: 0, invoices: 0 });

    const err = await admin.people.studentDelete({ studentId }).catch((e) => e as Error);
    expect((err as { code?: string }).code).toBe('CONFLICT');
    expect(err.message).not.toMatch(/FOREIGN KEY|constraint/i);
    expect(err.message).toContain('withdrawn');
    // Still there, money intact.
    expect(app.dbmod.db.select().from(students).where(eq(students.id, studentId)).all()).toHaveLength(1);
    expect(app.dbmod.db.select().from(payments).where(eq(payments.studentId, studentId)).all()).toHaveLength(1);
  });

  it('still refuses once the payment has been reversed — the pair is the story of the money', async () => {
    const { admin, studentId } = await seed();
    const p = await admin.billing.recordManualPayment({ studentId, amountCents: 7000, channel: 'cash', occurredAt: '2026-03-20' });
    await admin.billing.reversePayment({ paymentId: p.paymentId });
    expect((await admin.people.studentDeletable({ studentId })).deletable).toBe(false);
    await expect(admin.people.studentDelete({ studentId })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  /** Withdrawal is what the refusals point at, so it has to actually do the job it promises. */
  it('withdrawing really does stop the billing that delete would have stopped', async () => {
    const { admin, famId, studentId } = await seed();
    await admin.people.studentUpdate({ id: studentId, status: 'withdrawn' });
    await admin.billing.generateFamily({ familyId: famId, periodKey: '2026-07', label: 'Jul' });
    expect((await admin.billing.studentBilling({ studentId })).invoices).toHaveLength(0);
  });

  it('refuses a billed student and points at withdrawal instead', async () => {
    const { admin, studentId } = await seed();
    await admin.billing.generatePeriod({ periodKey: '2026-07', label: 'Tuition — Jul 2026' });
    await expect(admin.people.studentDelete({ studentId })).rejects.toThrow(/withdrawn/i);
    // Still there, and withdrawal remains available.
    expect(app.dbmod.db.select().from(students).where(eq(students.id, studentId)).get()).toBeTruthy();
    await admin.people.studentUpdate({ id: studentId, status: 'withdrawn' });
    expect(app.dbmod.db.select().from(students).where(eq(students.id, studentId)).get()!.status).toBe('withdrawn');
  });

  it('frees the deleted student’s ID for reuse (it is UNIQUE per install)', async () => {
    const { admin, famId, planId, studentId } = await seed();
    await admin.people.studentDelete({ studentId });
    // Creating another Yusuf must not trip the unique index on student_code.
    const again = await admin.people.studentCreate({ familyId: famId, fullName: 'Yusuf Ismail', feePlanId: planId });
    expect(app.dbmod.db.select().from(students).where(eq(students.id, again.id)).get()!.studentCode).toMatch(/^YUS\d{4}$/);
  });

  it('is admin-only, and refused for an admin session over the tunnel', async () => {
    const { studentId } = await seed();
    await expect(caller('finance').people.studentDelete({ studentId })).rejects.toThrow();
    await expect(caller('parent').people.studentDelete({ studentId })).rejects.toThrow();
    const overTunnel = app.appRouter.createCaller(makeCtx({ origin: 'tunnel', session: { role: 'admin', source: 'local', username: 'a', userId: 'usr_admin' } }).ctx);
    await expect(overTunnel.people.studentDelete({ studentId })).rejects.toThrow();
  });
});

/**
 * ERASING A BILLED STUDENT FOR GOOD (0.51.0-dev.14) — the deliberate exception to §9.
 *
 * Money is soft-deleted everywhere else in this app and money-path FKs are RESTRICT. This is the one door
 * out, and it exists for a case the refusal made unfixable: an install being set up bills a test roster by
 * accident (the nightly job needs no help), and the madrasah was then stuck with children who could only
 * ever be *withdrawn* — permanent clutter with real invoices behind them.
 *
 * What has to hold, because it destroys real ledger rows:
 *
 *  1. **It never happens without `force`.** An ordinary Delete is refused exactly as before.
 *  2. **It actually completes.** `foreign_keys` is ON and these are RESTRICT, so a wrong order leaves the
 *     student behind with half their history gone — the worst outcome available.
 *  3. **Nobody else's rows move.** A sibling on the same household, sharing the plan, is untouched.
 *  4. **The audit entry is written FIRST and names what went**, because it is the only trace left.
 *  5. **Admin only.** Finance runs the billing and cannot erase it.
 */
describe('studentDelete — force', () => {
  /** A student with the full spread: invoice, line, payment, allocation, charge, fee assignment. */
  async function billed() {
    const { admin, famId, planId, studentId } = await seed();
    await admin.billing.generatePeriod({ periodKey: '2026-09', label: 'Sep 2026' });
    await admin.billing.chargeAdd({ studentId, source: { kind: 'custom', label: 'Book fee', amountCents: 2500 } });
    await admin.billing.recordManualPayment({ studentId, amountCents: 5000, channel: 'cash', occurredAt: '2026-09-05' });
    return { admin, famId, planId, studentId };
  }

  const countFor = (studentId: string) => ({
    invoices: app.dbmod.db.select().from(invoices).all().filter((r) => r.studentId === studentId).length,
    lines: app.dbmod.db.select().from(invoiceItems).all().filter((r) => r.studentId === studentId).length,
    payments: app.dbmod.db.select().from(payments).all().filter((r) => r.studentId === studentId).length,
    charges: app.dbmod.db.select().from(charges).all().filter((r) => r.studentId === studentId).length,
    fees: app.dbmod.db.select().from(studentFees).all().filter((r) => r.studentId === studentId).length,
  });

  it('is still refused without force', async () => {
    const { admin, studentId } = await billed();
    await expect(admin.people.studentDelete({ studentId })).rejects.toMatchObject({ code: 'CONFLICT' });
    // Nothing moved.
    expect(app.dbmod.db.select().from(students).all().some((r) => r.id === studentId)).toBe(true);
  });

  /** THE ONE THAT MATTERS: it completes, rather than failing part-way on a RESTRICT. */
  it('erases the student and every money row of theirs', async () => {
    const { admin, studentId } = await billed();
    const before = countFor(studentId);
    expect(before.invoices).toBeGreaterThan(0);
    expect(before.payments).toBeGreaterThan(0);

    const r = await admin.people.studentDelete({ studentId, force: true });
    expect(r.forced).toBe(true);

    expect(app.dbmod.db.select().from(students).all().some((x) => x.id === studentId)).toBe(false);
    const after = countFor(studentId);
    expect(after).toEqual({ invoices: 0, lines: 0, payments: 0, charges: 0, fees: 0 });
    // And no orphaned allocations left pointing at rows that no longer exist.
    expect(app.dbmod.db.select().from(paymentAllocations).all()).toHaveLength(0);
  });

  it('leaves a sibling on the same household completely alone', async () => {
    const { admin, famId, planId, studentId } = await billed();
    const sib = await admin.people.studentCreate({ familyId: famId, fullName: 'Maryam Ismail', feePlanId: planId });
    await admin.billing.generatePeriod({ periodKey: '2026-10', label: 'Oct 2026' });
    await admin.billing.recordManualPayment({ studentId: sib.id, amountCents: 5000, channel: 'cash', occurredAt: '2026-10-05' });
    const sibBefore = countFor(sib.id);

    await admin.people.studentDelete({ studentId, force: true });

    expect(countFor(sib.id)).toEqual(sibBefore);
    expect(app.dbmod.db.select().from(students).all().some((x) => x.id === sib.id)).toBe(true);
    // The household survives too — it still has a child.
    expect(app.dbmod.db.select().from(families).all().some((f) => f.id === famId)).toBe(true);
  });

  /**
   * The audit row is the ONLY thing left afterwards, so it has to answer "what was here?" — an id that no
   * longer resolves documents nothing. Written before the delete, and carrying the name, the Student ID,
   * the counts and the money.
   */
  it('records what it destroyed, by name and amount', async () => {
    const { admin, studentId } = await billed();
    await admin.people.studentDelete({ studentId, force: true });

    const row = app.dbmod.db.select().from(auditLog).all().find((r) => r.action === 'student.deleteForced');
    expect(row).toBeTruthy();
    const detail = JSON.stringify(row!.detail ?? {});
    expect(detail).toContain('Yusuf Ismail');
    expect(detail).toContain('paidCents');
    // The figures, not just the fact.
    expect(row!.detail).toMatchObject({ payments: 1, paidCents: 5000 });
  });

  it('is admin only', async () => {
    const { studentId } = await billed();
    await expect(caller('finance').people.studentDelete({ studentId, force: true })).rejects.toThrow();
    expect(app.dbmod.db.select().from(students).all().some((x) => x.id === studentId)).toBe(true);
  });

  /** `force` on a student with no history behaves exactly like an ordinary delete — no special path. */
  it('is harmless on a student who was never billed', async () => {
    const { admin, studentId } = await seed();
    await admin.people.studentDelete({ studentId, force: true });
    expect(app.dbmod.db.select().from(students).all().some((x) => x.id === studentId)).toBe(false);
  });
});
