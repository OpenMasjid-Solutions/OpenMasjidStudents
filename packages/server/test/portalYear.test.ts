// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The year at a glance in the parent portal (0.48.0 — portal.yearGrid).
 *
 * Two things are worth pinning, and they are the two that would matter if they broke:
 *
 *  1. THE WALL. This is a new read on a tunnel-facing surface, so it must show a parent their own children
 *     and nobody else's — enforced in the query, never by the UI (§14). A parent cannot even name another
 *     family, because the procedure takes no family id at all.
 *  2. IT AGREES WITH THE OFFICE. The squares come from `yearCellsFor`, shared with the staff grid, so a
 *     parent ringing up about November is looking at what the volunteer is looking at. Asserted by
 *     comparing the two outputs rather than by trusting that they call the same thing.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import {
  paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, guardianUsers, guardianFamilies,
  guardians, students, classes, courses, families, schoolYears, settings, users, auditLog, carryIns,
} from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;

const staff = (role: Role) =>
  app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);
/** A parent, over the tunnel — where a parent actually is. */
const parent = (userId: string) =>
  app.appRouter.createCaller(makeCtx({ origin: 'tunnel', session: { role: 'parent', source: 'local', username: 'parent', userId } }).ctx);

beforeAll(async () => {
  app = await freshApp();
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, invoiceItems, invoices, carryIns, studentFees, feePlans, guardianUsers, guardianFamilies, guardians, students, classes, courses, families, schoolYears, settings, users, auditLog]) {
    db.delete(t).run();
  }
});

/** Two households, each with a child and a parent account — so "only my own" has something to fail on. */
async function twoFamilies() {
  const admin = staff('admin');
  await admin.structure.schoolYearCreate({ label: '2026–27', startYear: 2026, startMonth: 9, endMonth: 6, makeCurrent: true });
  const plan = await admin.billing.feePlanCreate({ name: 'Monthly', amountCents: 10000, cadence: 'monthly' });

  const mine = await admin.people.studentAdd({ fullName: 'Yusuf Ismail', feePlanId: plan.id });
  const theirs = await admin.people.studentAdd({ fullName: 'Bilal Farooqi', feePlanId: plan.id });

  // A guardian on my household, linked to a portal account.
  const g = await admin.people.guardianCreate({ familyId: mine.familyId, name: 'Abu Yusuf', email: 'abu@example.org' });
  const ts = new Date();
  app.dbmod.db
    .insert(users)
    .values({ id: 'usr_parent', username: 'abu@example.org', passwordHash: 'x', role: 'parent', status: 'active', displayName: 'Abu Yusuf', mustChangePassword: false, createdAt: ts, updatedAt: ts })
    .run();
  app.dbmod.db.insert(guardianUsers).values({ guardianId: g.id, userId: 'usr_parent', createdAt: ts }).run();

  return { admin, mine, theirs };
}

describe('a parent sees their own children’s year', () => {
  it('lists the school year’s months and a row per child', async () => {
    await twoFamilies();
    const r = await parent('usr_parent').portal.yearGrid();
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].yearLabel).toBe('2026–27');
    expect(r.blocks[0].months.map((m) => m.periodKey)).toEqual([
      '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06',
    ]);
    expect(r.blocks[0].students.map((s) => s.fullName)).toEqual(['Yusuf Ismail']);
  });

  /** The wall. A parent cannot even ASK about another family — the procedure takes no id — so the test is
   *  that the other household's child is simply absent. */
  it('shows nothing about anybody else’s child', async () => {
    await twoFamilies();
    const r = await parent('usr_parent').portal.yearGrid();
    const names = r.blocks.flatMap((b) => b.students.map((s) => s.fullName));
    expect(names).toEqual(['Yusuf Ismail']);
    expect(names).not.toContain('Bilal Farooqi');
  });

  it('refuses staff roles and anyone with no parent link', async () => {
    await twoFamilies();
    // Not a parent-facing surface for staff: they have the office's own year view.
    await expect(staff('finance').portal.yearGrid()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // A parent account with no guardian link has no children, so there is nothing to show — and no error
    // that would tell them whether other families exist.
    const r = await parent('usr_nobody').portal.yearGrid();
    expect(r.blocks).toEqual([]);
  });

  it('says the same thing about a month as the office’s own grid', async () => {
    const { admin } = await twoFamilies();
    await admin.billing.generatePeriod({ periodKey: '2026-09', labelTemplate: 'Tuition — [month] [year]' });
    await admin.billing.generatePeriod({ periodKey: '2026-10', labelTemplate: 'Tuition — [month] [year]' });
    const kid = (await admin.people.directory()).flatMap((f) => f.students).find((s) => s.fullName === 'Yusuf Ismail')!;
    await admin.billing.recordManualPayment({ studentId: kid.id, amountCents: 10000, channel: 'cash', occurredAt: '2026-09-05' });

    const officeRow = (await admin.billing.yearGrid()).rows.find((r) => r.fullName === 'Yusuf Ismail')!;
    const parentRow = (await parent('usr_parent').portal.yearGrid()).blocks[0].students.find((s) => s.fullName === 'Yusuf Ismail')!;

    // Same statuses, month for month — one function, asserted rather than assumed.
    expect(parentRow.cells.map((c) => `${c.periodKey}=${c.status}`)).toEqual(officeRow.cells.map((c) => `${c.periodKey}=${c.status}`));
    expect(parentRow.cells.find((c) => c.periodKey === '2026-09')!.status).toBe('paid');
    expect(parentRow.cells.find((c) => c.periodKey === '2026-10')!.status).toBe('open');
  });

  it('carries the go-live answer through to the parent’s view too', async () => {
    const { admin } = await twoFamilies();
    const kid = (await admin.people.directory()).flatMap((f) => f.students).find((s) => s.fullName === 'Yusuf Ismail')!;
    await admin.billing.midYearCommit({ goLivePeriod: '2026-11', asOf: '2026-11-01', rows: [{ studentId: kid.id, paidThrough: '2026-09' }] });

    const cells = (await parent('usr_parent').portal.yearGrid()).blocks[0].students[0].cells;
    const at = (p: string) => cells.find((c) => c.periodKey === p)!.status;
    // September was settled before the app arrived; October was not, and is in the carried-forward bill.
    expect(at('2026-09')).toBe('settled');
    expect(at('2026-10')).toBe('carried');
  });

  it('shows nothing rather than an empty grid when no school year is set up', async () => {
    const { admin } = await twoFamilies();
    // Drop the year: there are no months to lay out, so the tab says so instead of drawing an empty axis.
    app.dbmod.db.delete(schoolYears).run();
    expect((await parent('usr_parent').portal.yearGrid()).blocks).toEqual([]);
    // …and the office's grid says the same thing about itself.
    expect((await admin.billing.yearGrid()).year).toBeNull();
  });
});
