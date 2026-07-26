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
import { families, students, feePlans, studentFees, invoices, invoiceItems, payments, paymentAllocations, charges, chargeItems } from '../src/db/schema';
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
});

async function seed() {
  const admin = caller('admin');
  const fam = await admin.people.familyCreate({ name: 'Ismail' });
  const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
  const s = await admin.people.studentCreate({ familyId: fam.id, firstName: 'Yusuf', lastName: 'Ismail', feePlanId: plan.id });
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
    await admin.billing.chargeAdd({ studentId, source: { kind: 'custom', label: 'Books', amountCents: 1000 } });
    let info = await admin.people.studentDeletable({ studentId });
    expect(info.deletable).toBe(true);
    expect(info.pendingCharges).toBe(1);

    // Invoice it, and now it is history.
    await admin.billing.generatePeriod({ periodKey: '2026-07', label: 'Tuition — Jul 2026' });
    info = await admin.people.studentDeletable({ studentId });
    expect(info.deletable).toBe(false);
    await expect(admin.people.studentDelete({ studentId })).rejects.toThrow(/billed|withdrawn/i);
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

  it('frees the deleted student’s ID and PIN for reuse (both are UNIQUE)', async () => {
    const { admin, famId, planId, studentId } = await seed();
    await admin.people.studentDelete({ studentId });
    // Creating another Yusuf must not trip the unique index on either column.
    const again = await admin.people.studentCreate({ familyId: famId, firstName: 'Yusuf', lastName: 'Ismail', feePlanId: planId });
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
