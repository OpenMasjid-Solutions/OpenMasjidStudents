// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * CSV student import (people/import.ts): the dry-run validator, the all-or-nothing commit, and
 * the name resolution that makes siblings share a family.
 *
 * The important guarantees under test:
 *  - a file with ANY bad row commits NOTHING (a half-imported billing roster is worse than a
 *    rejected file)
 *  - classes and fee plans are never invented from a spreadsheet — an unknown name is a row error
 *  - families ARE created on demand, and two rows naming the same family become siblings
 *  - a guardian repeated across sibling rows is linked once, not duplicated
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { paymentAllocations, payments, charges, invoiceItems, invoices, chargeItems, studentFees, feePlans, guardianFamilies, guardians, students, classes, courses, families, terms, schoolYears, users, auditLog } from '../src/db/schema';
import type { Role } from '../src/db/schema';
import { parseAmountCents } from '../src/people/import';

let app: Awaited<ReturnType<typeof freshApp>>;
const caller = (role: Role, opts: { origin?: 'lan' | 'tunnel' } = {}) =>
  app.appRouter.createCaller(makeCtx({ origin: opts.origin ?? 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => { app = await freshApp(); });
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, charges, invoiceItems, invoices, chargeItems, studentFees, feePlans, guardianFamilies, guardians, students, classes, courses, families, terms, schoolYears, users, auditLog]) db.delete(t).run();
});

/** A plan and a Hifz 1 class to import against. */
async function base() {
  const admin = caller('admin');
  const plan = await admin.billing.feePlanCreate({ name: 'Monthly tuition', amountCents: 35000, cadence: 'monthly' });
  const course = await admin.structure.courseCreate({ name: 'Hifz' });
  const cls = await admin.structure.classCreate({ courseId: course.id, name: 'Hifz 1' });
  return { admin, planId: plan.id, courseId: course.id, classId: cls.id };
}

describe('parseAmountCents', () => {
  it('accepts what a spreadsheet actually produces', () => {
    expect(parseAmountCents('350')).toBe(35000);
    expect(parseAmountCents('350.00')).toBe(35000);
    expect(parseAmountCents('$350')).toBe(35000);
    expect(parseAmountCents('1,250.50')).toBe(125050);
    expect(parseAmountCents(' 700 ')).toBe(70000);
    expect(parseAmountCents('')).toBeNull();
    expect(parseAmountCents(undefined)).toBeNull();
    expect(parseAmountCents('350 ACH')).toBe('bad');
    expect(parseAmountCents('abc')).toBe('bad');
  });
});

describe('importTemplate', () => {
  it('exposes the canonical columns with required flags and match aliases', async () => {
    const { admin } = await base();
    const t = await admin.people.importTemplate();
    expect(t.find((f) => f.key === 'firstName')).toMatchObject({ required: true });
    expect(t.find((f) => f.key === 'amount')!.aliases).toContain('paying');
    expect(t.map((f) => f.key)).toContain('guardianPhone');
  });
});

describe('preview catches problems before anything is written', () => {
  it('accepts a clean file and groups siblings into one new family', async () => {
    const { admin, planId } = await base();
    const r = await admin.people.importPreview({
      defaultFeePlanId: planId,
      rows: [
        { firstName: 'Yusuf', lastName: 'Ismail', familyName: 'Ismail' },
        { firstName: 'Sara', lastName: 'Ismail', familyName: 'Ismail' },
      ],
    });
    expect(r.okCount).toBe(2);
    expect(r.errorCount).toBe(0);
    expect(r.newFamilies).toEqual(['Ismail']); // one family for both siblings
  });

  it('defaults the family label to "<last name> family" when the column is absent', async () => {
    const { admin, planId } = await base();
    const r = await admin.people.importPreview({ defaultFeePlanId: planId, rows: [{ firstName: 'Yusuf', lastName: 'Ismail' }] });
    expect(r.rows[0].resolved!.familyName).toBe('Ismail family');
  });

  it('reuses an EXISTING family instead of creating a duplicate', async () => {
    const { admin, planId } = await base();
    await admin.people.familyCreate({ name: 'Ismail' });
    const r = await admin.people.importPreview({ defaultFeePlanId: planId, rows: [{ firstName: 'Yusuf', lastName: 'Ismail', familyName: 'ismail' }] });
    expect(r.rows[0].resolved!.familyExists).toBe(true);
    expect(r.newFamilies).toEqual([]);
  });

  it('requires both names', async () => {
    const { admin, planId } = await base();
    const r = await admin.people.importPreview({ defaultFeePlanId: planId, rows: [{ firstName: '', lastName: 'X' }, { firstName: 'A', lastName: '' }] });
    expect(r.errorCount).toBe(2);
    expect(r.rows[0].errors[0]).toMatch(/First name/);
    expect(r.rows[1].errors[0]).toMatch(/Last name/);
  });

  it('refuses an unknown class or fee plan rather than inventing one from a typo', async () => {
    const { admin, planId } = await base();
    const r = await admin.people.importPreview({
      defaultFeePlanId: planId,
      rows: [
        { firstName: 'A', lastName: 'B', className: 'Hifz 9' },
        { firstName: 'C', lastName: 'D', feePlanName: 'Nonexistent plan' },
      ],
    });
    expect(r.rows[0].errors[0]).toMatch(/Class "Hifz 9" does not exist/);
    expect(r.rows[1].errors[0]).toMatch(/Fee plan "Nonexistent plan" does not exist/);
  });

  it('asks for a Course column when a class name is ambiguous across courses', async () => {
    const { admin, planId } = await base();
    const other = await admin.structure.courseCreate({ name: 'Nazrah' });
    await admin.structure.classCreate({ courseId: other.id, name: 'Hifz 1' }); // same class name, different course
    const r = await admin.people.importPreview({ defaultFeePlanId: planId, rows: [{ firstName: 'A', lastName: 'B', className: 'Hifz 1' }] });
    expect(r.rows[0].errors[0]).toMatch(/more than one course/);
    // Naming the course disambiguates it.
    const ok = await admin.people.importPreview({ defaultFeePlanId: planId, rows: [{ firstName: 'A', lastName: 'B', className: 'Hifz 1', courseName: 'Nazrah' }] });
    expect(ok.errorCount).toBe(0);
  });

  it('requires SOME fee plan — a per-row column or an import-wide default', async () => {
    const { admin, planId } = await base();
    const none = await admin.people.importPreview({ rows: [{ firstName: 'A', lastName: 'B' }] });
    expect(none.rows[0].errors[0]).toMatch(/No fee plan/);
    const viaColumn = await admin.people.importPreview({ rows: [{ firstName: 'A', lastName: 'B', feePlanName: 'Monthly tuition' }] });
    expect(viaColumn.errorCount).toBe(0);
    const viaDefault = await admin.people.importPreview({ defaultFeePlanId: planId, rows: [{ firstName: 'A', lastName: 'B' }] });
    expect(viaDefault.errorCount).toBe(0);
  });

  it('rejects an unparseable amount, a malformed date, and a non-email', async () => {
    const { admin, planId } = await base();
    const r = await admin.people.importPreview({
      defaultFeePlanId: planId,
      rows: [
        { firstName: 'A', lastName: 'B', amount: '350 ACH' },
        { firstName: 'C', lastName: 'D', dob: '03/04/2015' },
        { firstName: 'E', lastName: 'F', guardianEmail: 'not-an-email' },
      ],
    });
    expect(r.rows[0].errors[0]).toMatch(/not a number/);
    expect(r.rows[1].errors[0]).toMatch(/YYYY-MM-DD/);
    expect(r.rows[2].errors[0]).toMatch(/not an email/);
  });
});

describe('commit is all-or-nothing', () => {
  it('writes NOTHING when any row is invalid', async () => {
    const { admin, planId } = await base();
    await expect(
      admin.people.importCommit({
        defaultFeePlanId: planId,
        rows: [
          { firstName: 'Good', lastName: 'Row' },
          { firstName: '', lastName: 'Bad' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(app.dbmod.db.select().from(students).all()).toHaveLength(0);
    expect(app.dbmod.db.select().from(families).all()).toHaveLength(0);
  });

  it('imports a roster: families, classes, per-row amounts, and one guardian across siblings', async () => {
    const { admin, planId, classId } = await base();
    const r = await admin.people.importCommit({
      defaultFeePlanId: planId,
      rows: [
        { firstName: 'Yusuf', lastName: 'Ismail', familyName: 'Ismail', className: 'Hifz 1', amount: '350', guardianName: 'Abu Yusuf', guardianPhone: '555-0001' },
        { firstName: 'Sara', lastName: 'Ismail', familyName: 'Ismail', className: 'Hifz 1', amount: '$700', guardianName: 'Abu Yusuf', guardianPhone: '555-0001' },
        { firstName: 'Bilal', lastName: 'Farooqi', className: 'Hifz 1' },
      ],
    });
    expect(r).toMatchObject({ created: 3, familiesCreated: 2, guardiansCreated: 1 });
    expect(r.students).toHaveLength(3);
    for (const s of r.students) expect(s.studentCode).toMatch(/^[A-Z]{3}\d{4}$/);
    expect(new Set(r.students.map((s) => s.studentCode)).size).toBe(3); // Student IDs unique

    // Siblings really share one family.
    const grouped = await admin.structure.studentsByClass();
    const ismail = grouped.filter((g) => g.familyName === 'Ismail');
    expect(ismail).toHaveLength(2);
    expect(new Set(ismail.map((g) => g.familyId)).size).toBe(1);
    expect(ismail.every((g) => g.classId === classId)).toBe(true);

    // The Amount column became a per-student override, so the invoice reflects 350 + 700.
    const familyId = ismail[0].familyId;
    await admin.billing.generateFamily({ familyId, periodKey: '2026-07', label: 'Jul' });
    const inv = (await admin.billing.familyBilling({ familyId })).invoices[0];
    expect(inv.totalCents).toBe(105000);

    // Bilal had no Amount, so he falls back to the plan's own 35000.
    const bilal = grouped.find((g) => g.firstName === 'Bilal')!;
    await admin.billing.generateFamily({ familyId: bilal.familyId, periodKey: '2026-07', label: 'Jul' });
    expect((await admin.billing.familyBilling({ familyId: bilal.familyId })).invoices[0].totalCents).toBe(35000);
  });

  it('links a new student to an existing family so guardians already on file apply', async () => {
    const { admin, planId } = await base();
    const fam = await admin.people.familyCreate({ name: 'Ismail' });
    await admin.people.guardianCreate({ familyId: fam.id, name: 'Abu Yusuf', phone: '555-9' });
    const r = await admin.people.importCommit({ defaultFeePlanId: planId, rows: [{ firstName: 'Sara', lastName: 'Ismail', familyName: 'Ismail', guardianName: 'Abu Yusuf' }] });
    // The guardian was already on the family, so nothing new was created.
    expect(r.guardiansCreated).toBe(0);
    const detail = await admin.people.familyGet({ id: fam.id });
    expect(detail.students).toHaveLength(1);
    expect(detail.guardians).toHaveLength(1);
  });

  it('audits counts only — never names or Student IDs', async () => {
    const { admin, planId } = await base();
    const r = await admin.people.importCommit({ defaultFeePlanId: planId, rows: [{ firstName: 'Yusuf', lastName: 'Ismail' }] });
    const entry = app.dbmod.db.select().from(auditLog).all().find((e) => e.action === 'student.import')!;
    const detail = JSON.stringify(entry.detail ?? {});
    expect(detail).toContain('"created":1');
    expect(detail).not.toContain('Yusuf');
    expect(detail).not.toContain(r.students[0].studentCode);
  });
});

describe('walls', () => {
  it('import is admin-only and LAN-only', async () => {
    const rows = [{ firstName: 'A', lastName: 'B' }];
    await expect(caller('finance').people.importPreview({ rows })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller('finance').people.importCommit({ rows })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller('admin', { origin: 'tunnel' }).people.importCommit({ rows })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('moving a student between families is admin-only and redirects future billing only', async () => {
    const { admin, planId } = await base();
    const a = await admin.people.familyCreate({ name: 'A fam' });
    const b = await admin.people.familyCreate({ name: 'B fam' });
    const s = await admin.people.studentCreate({ familyId: a.id, firstName: 'Yusuf', lastName: 'Ismail', feePlanId: planId });
    // Bill family A, then move the student to B.
    await admin.billing.generateFamily({ familyId: a.id, periodKey: '2026-07', label: 'Jul' });
    const moved = await admin.people.studentSetFamily({ studentId: s.id, familyId: b.id });
    expect(moved.moved).toBe(true);
    // A keeps the invoice it was billed (immutable history); B bills going forward.
    expect((await admin.billing.familyBilling({ familyId: a.id })).invoices).toHaveLength(1);
    await admin.billing.generateFamily({ familyId: b.id, periodKey: '2026-08', label: 'Aug' });
    expect((await admin.billing.familyBilling({ familyId: b.id })).invoices[0].totalCents).toBe(35000);
    await expect(caller('finance').people.studentSetFamily({ studentId: s.id, familyId: a.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
