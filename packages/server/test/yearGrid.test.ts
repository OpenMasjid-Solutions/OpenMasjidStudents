// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The year view: school-year month derivation, the students × months payment grid, and the
 * admin-configurable optional columns.
 *
 * Two things matter most here:
 *  - a cell reports the FAMILY's invoice state for that period (that is what is billed and paid),
 *    so siblings on one bill legitimately show the same cell
 *  - a column the admin has not enabled is absent from the payload entirely — `pin` especially,
 *    since it is a capability token that pays tuition and is OFF by default (§14)
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { paymentAllocations, payments, charges, invoiceItems, invoices, chargeItems, studentFees, feePlans, guardianFamilies, guardians, students, classes, courses, families, terms, schoolYears, users, auditLog, settings } from '../src/db/schema';
import type { Role } from '../src/db/schema';
import { schoolYearMonths } from '../src/billing/schoolYear';

let app: Awaited<ReturnType<typeof freshApp>>;
const caller = (role: Role, opts: { origin?: 'lan' | 'tunnel' } = {}) =>
  app.appRouter.createCaller(makeCtx({ origin: opts.origin ?? 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => { app = await freshApp(); });
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, charges, invoiceItems, invoices, chargeItems, studentFees, feePlans, guardianFamilies, guardians, students, classes, courses, families, terms, schoolYears, users, auditLog, settings]) db.delete(t).run();
});

describe('schoolYearMonths', () => {
  it('wraps a madrasa year that runs Apr → Mar into 12 months across two calendar years', () => {
    const m = schoolYearMonths(2026, 4, 3);
    expect(m).toHaveLength(12);
    expect(m[0]).toMatchObject({ periodKey: '2026-04', label: 'Apr' });
    expect(m[8]).toMatchObject({ periodKey: '2026-12', label: 'Dec' });
    expect(m[9]).toMatchObject({ periodKey: '2027-01', label: 'Jan' });
    expect(m[11]).toMatchObject({ periodKey: '2027-03', label: 'Mar' });
  });

  it('handles a plain calendar year', () => {
    const m = schoolYearMonths(2026, 1, 12);
    expect(m).toHaveLength(12);
    expect(m[0].periodKey).toBe('2026-01');
    expect(m[11].periodKey).toBe('2026-12');
  });

  it('handles a short year and a single month', () => {
    expect(schoolYearMonths(2026, 9, 11).map((x) => x.periodKey)).toEqual(['2026-09', '2026-10', '2026-11']);
    expect(schoolYearMonths(2026, 4, 4).map((x) => x.periodKey)).toEqual(['2026-04']);
  });

  it('period keys are exactly the invoice periodKey format', () => {
    for (const m of schoolYearMonths(2026, 4, 3)) expect(m.periodKey).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
  });
});

/** Apr 2026 → Mar 2027, one course/class, two Ismail siblings + one Farooqi. */
async function seed() {
  const admin = caller('admin');
  await admin.structure.schoolYearCreate({ label: '1447–1448 / 2026–2027', startYear: 2026, startMonth: 4, endMonth: 3, makeCurrent: true });
  const course = await admin.structure.courseCreate({ name: 'Hifz' });
  const cls = await admin.structure.classCreate({ courseId: course.id, name: 'Hifz 1' });
  const plan = await admin.billing.feePlanCreate({ name: 'Monthly tuition', amountCents: 35000, cadence: 'monthly' });

  const ismail = await admin.people.familyCreate({ name: 'Ismail' });
  await admin.people.studentCreate({ familyId: ismail.id, firstName: 'Yusuf', lastName: 'Ismail', feePlanId: plan.id, classId: cls.id });
  await admin.people.studentCreate({ familyId: ismail.id, firstName: 'Sara', lastName: 'Ismail', feePlanId: plan.id, overrideAmountCents: 70000, feeNote: 'ACH', classId: cls.id });
  await admin.people.guardianCreate({ familyId: ismail.id, name: 'Abu Yusuf', phone: '(901) 949-2646', email: 'abu@example.com' });

  const farooqi = await admin.people.familyCreate({ name: 'Farooqi' });
  await admin.people.studentCreate({ familyId: farooqi.id, firstName: 'Bilal', lastName: 'Farooqi', feePlanId: plan.id, classId: cls.id });

  return { admin, ismailId: ismail.id, farooqiId: farooqi.id, planId: plan.id };
}

describe('yearGrid', () => {
  it('returns the year, its 12 months and one row per active student', async () => {
    const { admin } = await seed();
    const g = await admin.billing.yearGrid();
    expect(g.year!.label).toBe('1447–1448 / 2026–2027');
    expect(g.needsStartYear).toBe(false);
    expect(g.months).toHaveLength(12);
    expect(g.months[0].periodKey).toBe('2026-04');
    expect(g.rows).toHaveLength(3);
    expect(g.rows.map((r) => r.firstName).sort()).toEqual(['Bilal', 'Sara', 'Yusuf']);
    expect(g.rows.every((r) => r.className === 'Hifz 1' && r.courseName === 'Hifz')).toBe(true);
  });

  it('the Paying column is the student\'s effective monthly amount, with its note', async () => {
    const { admin } = await seed();
    const g = await admin.billing.yearGrid();
    const yusuf = g.rows.find((r) => r.firstName === 'Yusuf')!;
    const sara = g.rows.find((r) => r.firstName === 'Sara')!;
    expect(yusuf.monthlyAmountCents).toBe(35000); // plan amount
    expect(sara.monthlyAmountCents).toBe(70000); // override wins
    expect(sara.feeNote).toBe('ACH');
  });

  it('cells track the family invoice through open → partial → paid, and stay none when unbilled', async () => {
    const { admin, ismailId } = await seed();
    const at = async (first: string, period: string) => {
      const g = await admin.billing.yearGrid();
      return g.rows.find((r) => r.firstName === first)!.cells.find((c) => c.periodKey === period)!;
    };

    expect((await at('Yusuf', '2026-04')).status).toBe('none');
    await admin.billing.generateFamily({ familyId: ismailId, periodKey: '2026-04', label: 'Apr' });
    expect((await at('Yusuf', '2026-04')).status).toBe('open');

    // 35000 + 70000 = 105000 for the family.
    await admin.billing.recordManualPayment({ familyId: ismailId, amountCents: 40000, channel: 'cash', occurredAt: '2026-04-05' });
    expect((await at('Yusuf', '2026-04')).status).toBe('partial');
    await admin.billing.recordManualPayment({ familyId: ismailId, amountCents: 65000, channel: 'zelle', occurredAt: '2026-04-09' });
    const paid = await at('Yusuf', '2026-04');
    expect(paid.status).toBe('paid');
    expect(paid.totalCents).toBe(105000);

    // Siblings share the bill, so Sara's cell matches Yusuf's.
    expect((await at('Sara', '2026-04')).status).toBe('paid');
    // A different family is untouched.
    expect((await at('Bilal', '2026-04')).status).toBe('none');
    // A later month is still unbilled.
    expect((await at('Yusuf', '2026-05')).status).toBe('none');
  });

  it('a voided invoice reads as void, not paid', async () => {
    const { admin, ismailId } = await seed();
    await admin.billing.generateFamily({ familyId: ismailId, periodKey: '2026-04', label: 'Apr' });
    const invId = (await admin.billing.familyBilling({ familyId: ismailId })).invoices[0].id;
    await admin.billing.voidInvoice({ id: invId });
    const g = await admin.billing.yearGrid();
    expect(g.rows.find((r) => r.firstName === 'Yusuf')!.cells.find((c) => c.periodKey === '2026-04')!.status).toBe('void');
  });

  it('asks for a start year when the year predates the start_year column', async () => {
    const { admin } = await seed();
    const { db } = app.dbmod;
    db.update(schoolYears).set({ startYear: null }).run(); // simulate a row created under 0022
    const g = await admin.billing.yearGrid();
    expect(g.needsStartYear).toBe(true);
    expect(g.months).toEqual([]);
    expect(g.rows).toEqual([]);
  });

  it('returns an empty shell when no school year is configured at all', async () => {
    const admin = caller('admin');
    const g = await admin.billing.yearGrid();
    expect(g.year).toBeNull();
    expect(g.rows).toEqual([]);
  });
});

describe('optional columns are opt-in, and PIN is off by default', () => {
  it('defaults to guardian phones and does NOT include PINs', async () => {
    const { admin } = await seed();
    const g = await admin.billing.yearGrid();
    expect(g.columns).toEqual(['guardianPhones']);
    const yusuf = g.rows.find((r) => r.firstName === 'Yusuf')!;
    expect(yusuf.extra.guardianPhones).toEqual(['(901) 949-2646']);
    // Absent from the payload entirely, not merely blank.
    expect('pin' in yusuf.extra).toBe(false);
    expect('dob' in yusuf.extra).toBe(false);
    expect('balanceCents' in yusuf.extra).toBe(false);
  });

  it('includes PINs only once an admin switches that column on', async () => {
    const { admin } = await seed();
    await admin.billing.yearViewColumnsSet({ columns: ['pin', 'balance', 'guardianNames'] });
    const g = await admin.billing.yearGrid();
    expect(g.columns.sort()).toEqual(['balance', 'guardianNames', 'pin']);
    const yusuf = g.rows.find((r) => r.firstName === 'Yusuf')!;
    expect(yusuf.extra.pin).toMatch(/^\d{6}$/);
    expect(yusuf.extra.guardianNames).toEqual(['Abu Yusuf']);
    expect(typeof yusuf.extra.balanceCents).toBe('number');
    // Turning it back off removes it again.
    await admin.billing.yearViewColumnsSet({ columns: [] });
    const g2 = await admin.billing.yearGrid();
    expect('pin' in g2.rows[0].extra).toBe(false);
  });

  it('reports the balance a family actually owes', async () => {
    const { admin, ismailId } = await seed();
    await admin.billing.yearViewColumnsSet({ columns: ['balance'] });
    await admin.billing.generateFamily({ familyId: ismailId, periodKey: '2026-04', label: 'Apr' });
    const g = await admin.billing.yearGrid();
    expect(g.rows.find((r) => r.firstName === 'Yusuf')!.extra.balanceCents).toBe(105000);
    expect(g.rows.find((r) => r.firstName === 'Bilal')!.extra.balanceCents).toBe(0);
  });
});

describe('walls', () => {
  it('finance can read the grid and the column list but cannot change the columns', async () => {
    await seed();
    const finance = caller('finance');
    expect((await finance.billing.yearGrid()).rows).toHaveLength(3);
    expect((await finance.billing.yearViewColumnsGet()).enabled).toEqual(['guardianPhones']);
    await expect(finance.billing.yearViewColumnsSet({ columns: ['pin'] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a parent cannot read the grid, and admin over the tunnel is refused', async () => {
    await seed();
    await expect(caller('parent').billing.yearGrid()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller('admin', { origin: 'tunnel' }).billing.yearGrid()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
