// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The year view: school-year month derivation, the students × months payment grid, and the
 * admin-configurable optional columns.
 *
 * Two things matter most here:
 *  - a cell reports THAT CHILD's own invoice state for that period (billing is per student since
 *    0.39.0), so two siblings can differ in the same month — the point of the change
 *  - a column the admin has not enabled is absent from the payload entirely, not merely blank — the
 *    guardian ones especially, since they put contact details on a whole-school printout (§14)
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { paymentAllocations, payments, charges, invoiceItems, invoices, chargeItems, studentFees, feePlans, guardianFamilies, guardians, emergencyContacts, students, classes, courses, families, terms, schoolYears, users, auditLog, settings } from '../src/db/schema';
import type { Role } from '../src/db/schema';
import { schoolYearMonths } from '../src/billing/schoolYear';

let app: Awaited<ReturnType<typeof freshApp>>;
const caller = (role: Role, opts: { origin?: 'lan' | 'tunnel' } = {}) =>
  app.appRouter.createCaller(makeCtx({ origin: opts.origin ?? 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => { app = await freshApp(); });
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, charges, invoiceItems, invoices, chargeItems, studentFees, feePlans, guardianFamilies, guardians, emergencyContacts, students, classes, courses, families, terms, schoolYears, users, auditLog, settings]) db.delete(t).run();
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
  const yusuf = await admin.people.studentCreate({ familyId: ismail.id, fullName: 'Yusuf Ismail', feePlanId: plan.id, classId: cls.id });
  const sara = await admin.people.studentCreate({ familyId: ismail.id, fullName: 'Sara Ismail', feePlanId: plan.id, overrideAmountCents: 70000, feeNote: 'ACH', classId: cls.id });
  await admin.people.guardianCreate({ familyId: ismail.id, name: 'Abu Yusuf', phone: '(901) 949-2646', email: 'abu@example.com' });

  const farooqi = await admin.people.familyCreate({ name: 'Farooqi' });
  await admin.people.studentCreate({ familyId: farooqi.id, fullName: 'Bilal Farooqi', feePlanId: plan.id, classId: cls.id });

  return { admin, ismailId: ismail.id, farooqiId: farooqi.id, planId: plan.id, yusufId: yusuf.id, saraId: sara.id };
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
    expect(g.rows.map((r) => r.fullName).sort()).toEqual(['Bilal Farooqi', 'Sara Ismail', 'Yusuf Ismail']);
    expect(g.rows.every((r) => r.className === 'Hifz 1' && r.courseName === 'Hifz')).toBe(true);
  });

  it('the Paying column is the student\'s effective monthly amount, with its note', async () => {
    const { admin } = await seed();
    const g = await admin.billing.yearGrid();
    const yusuf = g.rows.find((r) => r.fullName === 'Yusuf Ismail')!;
    const sara = g.rows.find((r) => r.fullName === 'Sara Ismail')!;
    expect(yusuf.monthlyAmountCents).toBe(35000); // plan amount
    expect(sara.monthlyAmountCents).toBe(70000); // override wins
    expect(sara.feeNote).toBe('ACH');
  });

  /** Each cell is now THAT CHILD's own invoice, so siblings move independently. This is the visible
   *  payoff of per-student billing: "Yusuf paid April, Sara hasn't" is finally expressible. */
  it('cells track each child’s OWN invoice through open → partial → paid, siblings independently', async () => {
    const { admin, ismailId, yusufId } = await seed();
    const at = async (first: string, period: string) => {
      const g = await admin.billing.yearGrid();
      return g.rows.find((r) => r.fullName === first)!.cells.find((c) => c.periodKey === period)!;
    };

    expect((await at('Yusuf Ismail', '2026-04')).status).toBe('none');
    await admin.billing.generateFamily({ familyId: ismailId, periodKey: '2026-04', label: 'Apr' });
    expect((await at('Yusuf Ismail', '2026-04')).status).toBe('open');
    expect((await at('Yusuf Ismail', '2026-04')).totalCents).toBe(35000); // his own bill, not the household's

    // Pay Yusuf only: his cell advances and Sara's does NOT.
    await admin.billing.recordManualPayment({ studentId: yusufId, amountCents: 20000, channel: 'cash', occurredAt: '2026-04-05' });
    expect((await at('Yusuf Ismail', '2026-04')).status).toBe('partial');
    expect((await at('Sara Ismail', '2026-04')).status).toBe('open');
    await admin.billing.recordManualPayment({ studentId: yusufId, amountCents: 15000, channel: 'zelle', occurredAt: '2026-04-09' });
    expect((await at('Yusuf Ismail', '2026-04')).status).toBe('paid');
    // Sara is still open on her own 70000 — the sibling's payment did not touch her.
    const sara = await at('Sara Ismail', '2026-04');
    expect(sara.status).toBe('open');
    expect(sara.totalCents).toBe(70000);
    // A different family is untouched.
    expect((await at('Bilal Farooqi', '2026-04')).status).toBe('none');
    // A later month is still unbilled.
    expect((await at('Yusuf Ismail', '2026-05')).status).toBe('none');
  });

  it('a voided invoice reads as void, not paid', async () => {
    const { admin, ismailId } = await seed();
    await admin.billing.generateFamily({ familyId: ismailId, periodKey: '2026-04', label: 'Apr' });
    const invId = (await admin.billing.familyBilling({ familyId: ismailId })).invoices[0].id;
    await admin.billing.voidInvoice({ id: invId });
    const g = await admin.billing.yearGrid();
    expect(g.rows.find((r) => r.fullName === 'Yusuf Ismail')!.cells.find((c) => c.periodKey === '2026-04')!.status).toBe('void');
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

describe('optional columns are opt-in', () => {
  it('defaults to the three phone columns and nothing else', async () => {
    const { admin } = await seed();
    const g = await admin.billing.yearGrid();
    expect(g.columns).toEqual(['fatherPhone', 'motherPhone', 'otherPhone']);
    const yusuf = g.rows.find((r) => r.fullName === 'Yusuf Ismail')!;
    // The seeded guardian has no relation recorded — as every CSV-imported one does — so their number
    // lands in "other" rather than disappearing off the page.
    expect(yusuf.extra.otherPhone).toEqual(['(901) 949-2646']);
    expect(yusuf.extra.fatherPhone).toEqual([]);
    // Absent from the payload entirely, not merely blank.
    expect('studentCode' in yusuf.extra).toBe(false);
    expect('dob' in yusuf.extra).toBe(false);
    expect('balanceCents' in yusuf.extra).toBe(false);
  });

  /**
   * One labelled column per number (0.42.0). The office wants to know WHOSE number it is about to
   * ring, which a single comma-separated cell could never say.
   */
  it('files each number under the right heading, and keeps unlabelled ones in "other"', async () => {
    const { admin, ismailId } = await seed();
    await admin.people.guardianCreate({ familyId: ismailId, name: 'Abu Yusuf', phone: '(555) 111-1111', email: 'dad@test.org', relation: 'father' });
    // Free text from before the dropdown existed still classifies — offices type "Mom", not "mother".
    await admin.people.guardianCreate({ familyId: ismailId, name: 'Umm Yusuf', phone: '5552222222', email: 'mum@test.org', relation: 'Mom' });
    await admin.people.emergencyContactAdd({ familyId: ismailId, name: 'Uncle Bilal', phone: '555-333-3333' });
    await admin.billing.yearViewColumnsSet({ columns: ['fatherPhone', 'motherPhone', 'otherPhone', 'emergencyPhone', 'fatherEmail', 'motherEmail'] });

    const yusuf = (await admin.billing.yearGrid()).rows.find((r) => r.fullName === 'Yusuf Ismail')!;
    expect(yusuf.extra.fatherPhone).toEqual(['(555) 111-1111']);
    expect(yusuf.extra.motherPhone).toEqual(['5552222222']);
    expect(yusuf.extra.otherPhone).toEqual(['(901) 949-2646']); // the relation-less guardian from seed()
    expect(yusuf.extra.emergencyPhone).toEqual(['555-333-3333']);
    expect(yusuf.extra.fatherEmail).toEqual(['dad@test.org']);
    expect(yusuf.extra.motherEmail).toEqual(['mum@test.org']);
    // A sibling shares the household, so they share the numbers.
    const sara = (await admin.billing.yearGrid()).rows.find((r) => r.fullName === 'Sara Ismail')!;
    expect(sara.extra.fatherPhone).toEqual(['(555) 111-1111']);
    // ...and an unrelated household gets none of them.
    const bilal = (await admin.billing.yearGrid()).rows.find((r) => r.fullName === 'Bilal Farooqi')!;
    expect(bilal.extra.fatherPhone).toEqual([]);
    expect(bilal.extra.emergencyPhone).toEqual([]);
  });

  it('shows one number once, however differently the same digits were typed', async () => {
    const { admin, ismailId } = await seed();
    // The office recorded the father's mobile twice, punctuated differently, on two guardian rows.
    await admin.people.guardianCreate({ familyId: ismailId, name: 'Abu Yusuf', phone: '(555) 111-1111', relation: 'father' });
    await admin.people.guardianCreate({ familyId: ismailId, name: 'Abu Yusuf (work)', phone: '5551111111', relation: 'father' });
    await admin.billing.yearViewColumnsSet({ columns: ['fatherPhone'] });
    const yusuf = (await admin.billing.yearGrid()).rows.find((r) => r.fullName === 'Yusuf Ismail')!;
    expect(yusuf.extra.fatherPhone).toEqual(['(555) 111-1111']);
  });

  /** An install that had the old combined column keeps seeing the same numbers, in labelled columns,
   *  with no migration and no visit to Settings. */
  it('translates the pre-0.42.0 saved column names on read', async () => {
    const { admin } = await seed();
    app.dbmod.db.insert(settings).values({ key: 'year_view_columns', value: JSON.stringify(['guardianPhones', 'studentId']), updatedAt: new Date() }).run();
    const g = await admin.billing.yearGrid();
    expect(g.columns).toEqual(['fatherPhone', 'motherPhone', 'otherPhone', 'studentId']);
    expect(g.rows.find((r) => r.fullName === 'Yusuf Ismail')!.extra.otherPhone).toEqual(['(901) 949-2646']);
  });

  it('includes a column only once an admin switches it on', async () => {
    const { admin } = await seed();
    await admin.billing.yearViewColumnsSet({ columns: ['studentId', 'balance', 'guardianNames'] });
    const g = await admin.billing.yearGrid();
    expect(g.columns.sort()).toEqual(['balance', 'guardianNames', 'studentId']);
    const yusuf = g.rows.find((r) => r.fullName === 'Yusuf Ismail')!;
    expect(yusuf.extra.studentCode).toMatch(/^[A-Z]{3}\d{4}$/);
    expect(yusuf.extra.guardianNames).toEqual(['Abu Yusuf']);
    expect(typeof yusuf.extra.balanceCents).toBe('number');
    // Turning it back off removes it again.
    await admin.billing.yearViewColumnsSet({ columns: [] });
    const g2 = await admin.billing.yearGrid();
    expect('studentCode' in g2.rows[0].extra).toBe(false);
  });

  /** The balance column is the CHILD's own, not the household's — the row is the child. Two siblings
   *  on one bill used to show the same (combined) figure, which read as double-counting. */
  it('reports what each child owes, not the household total', async () => {
    const { admin, ismailId, yusufId } = await seed();
    await admin.billing.yearViewColumnsSet({ columns: ['balance'] });
    await admin.billing.generateFamily({ familyId: ismailId, periodKey: '2026-04', label: 'Apr' });
    let g = await admin.billing.yearGrid();
    expect(g.rows.find((r) => r.fullName === 'Yusuf Ismail')!.extra.balanceCents).toBe(35000); // his plan
    expect(g.rows.find((r) => r.fullName === 'Sara Ismail')!.extra.balanceCents).toBe(70000); // her override
    expect(g.rows.find((r) => r.fullName === 'Bilal Farooqi')!.extra.balanceCents).toBe(0); // never billed

    // Paying one child moves only that child's figure.
    await admin.billing.recordManualPayment({ studentId: yusufId, amountCents: 35000, channel: 'cash', occurredAt: '2026-04-05' });
    g = await admin.billing.yearGrid();
    expect(g.rows.find((r) => r.fullName === 'Yusuf Ismail')!.extra.balanceCents).toBe(0);
    expect(g.rows.find((r) => r.fullName === 'Sara Ismail')!.extra.balanceCents).toBe(70000);
  });
});

describe('walls', () => {
  it('finance can read the grid and the column list but cannot change the columns', async () => {
    await seed();
    const finance = caller('finance');
    expect((await finance.billing.yearGrid()).rows).toHaveLength(3);
    expect((await finance.billing.yearViewColumnsGet()).enabled).toEqual(['fatherPhone', 'motherPhone', 'otherPhone']);
    await expect(finance.billing.yearViewColumnsSet({ columns: ['fatherEmail'] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a parent cannot read the grid, and admin over the tunnel is refused', async () => {
    await seed();
    await expect(caller('parent').billing.yearGrid()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller('admin', { origin: 'tunnel' }).billing.yearGrid()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
