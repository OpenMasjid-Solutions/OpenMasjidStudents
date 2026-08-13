// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Dates arriving on the money path (0.48.0 — found by audit).
 *
 * §9 fixes the storage format as ISO because every date column is compared as TEXT. Three inputs in the
 * billing router took `z.string().max(20)` and never checked it, which broke in two different ways:
 *
 *  1. A PAYMENT DATE became `new Date('T12:00:00')` → `NaN` → SQLite stores NULL → the NOT NULL column
 *     refuses, and the office saw `NOT NULL constraint failed: payments.occurred_at`. Reachable from the
 *     real screen: clear the date box in the record-a-payment form and press Record. (Probed, not guessed.)
 *  2. A DUE DATE is a TEXT column, so a non-ISO value stores happily and then quietly misbehaves for good:
 *     it sorts wherever it likes, `due_date < today` is false so nobody is ever chased for it, and
 *     `due_date <= today` is false so autopay never collects it. A bill that can never be paid, with no
 *     error anywhere.
 *
 * A regex is not the fix — `2026-13-45` has the right shape and is not a day — so the check asks
 * `settings/dates.ts`, the one place that knows what a real stored date is.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, students, families, users, auditLog } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let dates: typeof import('../src/settings/dates');
const caller = (role: Role) => app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp();
  dates = await import('../src/settings/dates');
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, students, families, users, auditLog]) db.delete(t).run();
});

async function child() {
  const admin = caller('admin');
  const plan = await admin.billing.feePlanCreate({ name: 'Monthly tuition', amountCents: 20000, cadence: 'monthly' });
  const stu = await admin.people.studentAdd({ fullName: 'Yusuf Ismail', feePlanId: plan.id });
  return { admin, studentId: stu.id, familyId: stu.familyId };
}

/** Every shape that is ten-characters-and-not-a-date, plus the empty box that actually happened. */
const NOT_DATES = ['', '   ', 'not-a-date', '2026-13-45', '2026-02-30', '04/03/2026', '2026-3-4', '2026-03-04T00:00:00Z'];

describe('isIsoDay', () => {
  it('accepts exactly what a date column stores', () => {
    for (const good of ['2026-03-04', '2026-12-31', '1999-01-01']) expect(dates.isIsoDay(good)).toBe(true);
  });

  it('rejects the right shape that is not a day', () => {
    // The reason this is not a regex: all of these pass /^\d{4}-\d{2}-\d{2}$/ or look close enough.
    expect(dates.isIsoDay('2026-13-45')).toBe(false);
    expect(dates.isIsoDay('2026-02-30')).toBe(false);
    expect(dates.isIsoDay('0000-00-00')).toBe(false);
  });

  it('rejects a date in any other notation, and nothing at all', () => {
    for (const bad of ['04/03/2026', '4 Mar 2026', '2026-3-4', '', '   ', null, undefined]) expect(dates.isIsoDay(bad)).toBe(false);
  });
});

describe('recording a payment', () => {
  it('refuses a date that is not a date, with a sentence rather than a database error', async () => {
    const { admin, studentId } = await child();
    for (const bad of NOT_DATES) {
      await expect(admin.billing.recordManualPayment({ studentId, amountCents: 5000, channel: 'cash', occurredAt: bad })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    }
    // And nothing was written on the way to failing.
    expect(app.dbmod.db.select().from(payments).all()).toHaveLength(0);
  });

  it('names the field in the message, so the office knows which box to fix', async () => {
    const { admin, studentId } = await child();
    await expect(admin.billing.recordManualPayment({ studentId, amountCents: 5000, channel: 'cash', occurredAt: 'nope' })).rejects.toThrow(/payment date/i);
  });

  it('still records a real date', async () => {
    const { admin, studentId } = await child();
    const r = await admin.billing.recordManualPayment({ studentId, amountCents: 5000, channel: 'cash', occurredAt: '2026-03-04' });
    expect(r.duplicate).toBe(false);
    const row = app.dbmod.db.select().from(payments).all()[0];
    expect(row.occurredAt.toISOString().slice(0, 10)).toBe('2026-03-04');
  });
});

describe('generating invoices', () => {
  it('refuses a due date that is not a date', async () => {
    const { admin } = await child();
    for (const bad of ['not-a-date', '2026-13-45', '2026-02-30', '04/03/2026']) {
      await expect(admin.billing.generatePeriod({ periodKey: '2026-03', label: 'Tuition — Mar 2026', dueDate: bad })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(app.dbmod.db.select().from(invoices).all()).toHaveLength(0);
  });

  it('refuses one on a single household too', async () => {
    const { admin, familyId } = await child();
    await expect(admin.billing.generateFamily({ familyId, periodKey: '2026-03', label: 'Tuition — Mar 2026', dueDate: 'whenever' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('still treats an EMPTY due date as "no date given"', async () => {
    // The form sends '' when the office leaves it blank, and the invoice then takes the first of its own
    // month (billing/invoices.ts). That must keep working — it is the common case.
    const { admin } = await child();
    await admin.billing.generatePeriod({ periodKey: '2026-03', label: 'Tuition — Mar 2026', dueDate: '' });
    expect(app.dbmod.db.select().from(invoices).all()[0].dueDate).toBe('2026-03-01');
  });

  it('still accepts a real due date', async () => {
    const { admin } = await child();
    await admin.billing.generatePeriod({ periodKey: '2026-03', label: 'Tuition — Mar 2026', dueDate: '2026-03-15' });
    expect(app.dbmod.db.select().from(invoices).all()[0].dueDate).toBe('2026-03-15');
  });
});

describe('the mid-year go-live', () => {
  it('refuses a bad as-of date before writing a single carry-in', async () => {
    // Checked once, up front: this date lands on every artifact the run creates, and half a school's
    // histories dated NaN is not a state to discover afterwards.
    const { admin, studentId } = await child();
    await expect(
      admin.billing.midYearCommit({ goLivePeriod: '2026-03', asOf: 'sometime', rows: [{ studentId, paidThrough: '2026-02' }] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(app.dbmod.db.select().from(payments).all()).toHaveLength(0);
    expect(app.dbmod.db.select().from(invoices).all()).toHaveLength(0);
  });

  it('still runs with no as-of date at all (meaning today)', async () => {
    // The point is only that the absent field is accepted — what the run then writes depends on the school
    // year, which this fixture has none of. billing/carryIn's own tests cover the artifacts.
    const { admin, studentId } = await child();
    const r = await admin.billing.midYearCommit({ goLivePeriod: '2026-03', rows: [{ studentId, paidNothing: true }] });
    expect(r.startPeriod).toBe('2026-03');
  });
});
