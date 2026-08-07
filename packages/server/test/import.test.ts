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
 *  - EVERY ROW GETS ITS OWN HOUSEHOLD. The import does not work siblings out from the file and never
 *    joins an existing family; that is done afterwards with `familyAddSibling`, where the decision
 *    is visible on a record instead of buried in a 200-row spreadsheet.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshApp, makeCtx } from './harness';
import { paymentAllocations, payments, charges, invoiceItems, invoices, chargeItems, studentFees, feePlans, guardianFamilies, guardians, students, classes, courses, families, terms, schoolYears, users, auditLog } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
/**
 * Imported DYNAMICALLY, after freshApp() has pointed DATA_DIR at a temp directory.
 *
 * `src/people/import` pulls in `src/db`, which opens the database AT MODULE LOAD. As a static
 * import at the top of this file it therefore opened the real DATA_DIR database before the harness
 * could redirect it, and the suite then ran its migrations against the developer's actual data.
 * Harmless until a migration rebuilt a populated table, at which point every test in this file
 * failed in `beforeAll`. The harness header calls this out; this file was the one exception.
 */
let parseAmountCents: typeof import('../src/people/import').parseAmountCents;

const caller = (role: Role, opts: { origin?: 'lan' | 'tunnel' } = {}) =>
  app.appRouter.createCaller(makeCtx({ origin: opts.origin ?? 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp();
  ({ parseAmountCents } = await import('../src/people/import'));
});
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
    expect(t.find((f) => f.key === 'fullName')).toMatchObject({ required: true });
    expect(t.find((f) => f.key === 'amount')!.aliases).toContain('paying');
    expect(t.map((f) => f.key)).toContain('guardianPhone');
  });
});

describe('preview catches problems before anything is written', () => {
  it('accepts a clean file', async () => {
    const { admin, planId } = await base();
    const r = await admin.people.importPreview({
      defaultFeePlanId: planId,
      rows: [{ fullName: 'Yusuf Ismail' }, { fullName: 'Sara Ismail' }],
    });
    expect(r.okCount).toBe(2);
    expect(r.errorCount).toBe(0);
  });

  it('offers no family column at all — grouping is not something a spreadsheet decides', async () => {
    const { admin } = await base();
    const keys = (await admin.people.importTemplate()).map((f) => f.key);
    expect(keys).not.toContain('familyName');
    // Nor is a surname column quietly repurposed as one.
    for (const f of await admin.people.importTemplate()) {
      if (f.key !== 'fullName') expect(f.aliases).not.toContain('surname');
    }
  });

  it('requires a name — one field now, so blank or whitespace-only is the only way to miss it', async () => {
    const { admin, planId } = await base();
    const r = await admin.people.importPreview({ defaultFeePlanId: planId, rows: [{ fullName: '' }, { fullName: '   ' }, { fullName: 'Bilal' }] });
    expect(r.errorCount).toBe(2);
    expect(r.rows[0].errors[0]).toMatch(/Name is required/);
    expect(r.rows[1].errors[0]).toMatch(/Name is required/);
    // A single-word name is NOT an error: plenty of children have one, and demanding a surname is
    // exactly the assumption this change removed.
    expect(r.rows[2].ok).toBe(true);
  });

  it('refuses an unknown class or fee plan rather than inventing one from a typo', async () => {
    const { admin, planId } = await base();
    const r = await admin.people.importPreview({
      defaultFeePlanId: planId,
      rows: [
        { fullName: 'A B', className: 'Hifz 9' },
        { fullName: 'C D', feePlanName: 'Nonexistent plan' },
      ],
    });
    expect(r.rows[0].errors[0]).toMatch(/Class "Hifz 9" does not exist/);
    expect(r.rows[1].errors[0]).toMatch(/Fee plan "Nonexistent plan" does not exist/);
  });

  it('asks for a Course column when a class name is ambiguous across courses', async () => {
    const { admin, planId } = await base();
    const other = await admin.structure.courseCreate({ name: 'Nazrah' });
    await admin.structure.classCreate({ courseId: other.id, name: 'Hifz 1' }); // same class name, different course
    const r = await admin.people.importPreview({ defaultFeePlanId: planId, rows: [{ fullName: 'A B', className: 'Hifz 1' }] });
    expect(r.rows[0].errors[0]).toMatch(/more than one course/);
    // Naming the course disambiguates it.
    const ok = await admin.people.importPreview({ defaultFeePlanId: planId, rows: [{ fullName: 'A B', className: 'Hifz 1', courseName: 'Nazrah' }] });
    expect(ok.errorCount).toBe(0);
  });

  it('requires SOME fee plan — a per-row column or an import-wide default', async () => {
    const { admin, planId } = await base();
    const none = await admin.people.importPreview({ rows: [{ fullName: 'A B' }] });
    expect(none.rows[0].errors[0]).toMatch(/No fee plan/);
    const viaColumn = await admin.people.importPreview({ rows: [{ fullName: 'A B', feePlanName: 'Monthly tuition' }] });
    expect(viaColumn.errorCount).toBe(0);
    const viaDefault = await admin.people.importPreview({ defaultFeePlanId: planId, rows: [{ fullName: 'A B' }] });
    expect(viaDefault.errorCount).toBe(0);
  });

  it('rejects an unparseable amount, a date that is not a date, and a non-email', async () => {
    const { admin, planId } = await base();
    const r = await admin.people.importPreview({
      defaultFeePlanId: planId,
      rows: [
        { fullName: 'A B', amount: '350 ACH' },
        // Three plausible numbers that are not a calendar date — February has no 30th.
        { fullName: 'C D', dob: '2015-02-30' },
        { fullName: 'E F', guardianEmail: 'not-an-email' },
        { fullName: 'G H', dob: 'sometime in 2015' },
      ],
    });
    expect(r.rows[0].errors[0]).toMatch(/not a number/);
    expect(r.rows[1].errors[0]).toMatch(/isn’t a date we can read/);
    expect(r.rows[2].errors[0]).toMatch(/not an email/);
    expect(r.rows[3].errors[0]).toMatch(/isn’t a date we can read/);
  });

  /**
   * A slashed date used to be a hard error, so an office exporting from their old system had to
   * reformat the column by hand — which is exactly where the wrong day gets introduced. From 0.47.0 the
   * import reads the format the masjid set in Settings, and always still accepts ISO.
   */
  it('accepts a slashed date in the configured order, and normalises it to ISO', async () => {
    const { admin, planId } = await base();

    // Default (`iso`) reads an ambiguous slashed date month-first.
    const us = await admin.people.importPreview({ defaultFeePlanId: planId, rows: [{ fullName: 'C D', dob: '03/04/2015' }] });
    expect(us.errorCount).toBe(0);

    await admin.settings.set({ dateFormat: 'uk' });
    const uk = await admin.people.importCommit({ defaultFeePlanId: planId, rows: [{ fullName: 'C D', dob: '03/04/2015' }] });
    const { db } = app.dbmod;
    // Stored ISO whatever was typed — the storage format never moves (settings/dates.ts).
    expect(db.select().from(students).where(eq(students.id, uk.students[0].studentId)).get()!.dob).toBe('2015-04-03');

    // A date only one reading can explain ignores the setting rather than being rejected.
    const unambiguous = await admin.people.importCommit({ defaultFeePlanId: planId, rows: [{ fullName: 'E F', dob: '12/25/2015' }] });
    expect(db.select().from(students).where(eq(students.id, unambiguous.students[0].studentId)).get()!.dob).toBe('2015-12-25');
  });
});

describe('commit is all-or-nothing', () => {
  it('writes NOTHING when any row is invalid', async () => {
    const { admin, planId } = await base();
    await expect(
      admin.people.importCommit({
        defaultFeePlanId: planId,
        rows: [
          { fullName: 'Good Row' },
          { fullName: '' }, // the whole file must be rejected because of this one
        ],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(app.dbmod.db.select().from(students).all()).toHaveLength(0);
    expect(app.dbmod.db.select().from(families).all()).toHaveLength(0);
  });

  it('imports a roster: one household per row, classes, per-row amounts, guardians', async () => {
    const { admin, planId, classId } = await base();
    const r = await admin.people.importCommit({
      defaultFeePlanId: planId,
      rows: [
        { fullName: 'Yusuf Ismail', className: 'Hifz 1', amount: '350', guardianName: 'Abu Yusuf', guardianPhone: '555-0001' },
        { fullName: 'Sara Ismail', className: 'Hifz 1', amount: '$700', guardianName: 'Abu Yusuf', guardianPhone: '555-0001' },
        { fullName: 'Bilal Farooqi', className: 'Hifz 1' },
      ],
    });
    // Three children, three households, and a guardian record per row that named one. Two rows
    // naming the same parent are NOT merged — linking the children afterwards is what does that.
    expect(r).toMatchObject({ created: 3, familiesCreated: 3, guardiansCreated: 2 });
    expect(r.students).toHaveLength(3);
    for (const s of r.students) expect(s.studentCode).toMatch(/^[A-Z]{3}\d{4}$/);
    expect(new Set(r.students.map((s) => s.studentCode)).size).toBe(3); // Student IDs unique

    const grouped = await admin.structure.studentsByClass();
    expect(new Set(grouped.map((g) => g.familyId)).size).toBe(3);
    expect(grouped.every((g) => g.classId === classId)).toBe(true);
    // Each household is labelled from its own child, exactly as the UI would label it.
    expect(grouped.map((g) => g.familyName).sort()).toEqual(['Farooqi family', 'Ismail family', 'Ismail family']);

    // The Amount column became a per-student override, and each child is billed their own figure.
    const yusuf = grouped.find((g) => g.fullName === 'Yusuf Ismail')!;
    const sara = grouped.find((g) => g.fullName === 'Sara Ismail')!;
    for (const g of [yusuf, sara]) await admin.billing.generateFamily({ familyId: g.familyId, periodKey: '2026-07', label: 'Jul' });
    expect((await admin.billing.studentBilling({ studentId: yusuf.id })).invoices[0].totalCents).toBe(35000);
    expect((await admin.billing.studentBilling({ studentId: sara.id })).invoices[0].totalCents).toBe(70000);

    // Bilal had no Amount, so he falls back to the plan's own 35000.
    const bilal = grouped.find((g) => g.fullName === 'Bilal Farooqi')!;
    await admin.billing.generateFamily({ familyId: bilal.familyId, periodKey: '2026-07', label: 'Jul' });
    expect((await admin.billing.studentBilling({ studentId: bilal.id })).invoices[0].totalCents).toBe(35000);

    // …and once the office links the two Ismails, one balance covers both.
    await admin.people.familyAddSibling({ familyId: sara.familyId, studentId: yusuf.id });
    expect((await admin.billing.familyBilling({ familyId: sara.familyId })).balance.owedCents).toBe(105000);
  });

  it('never joins an existing household, even one that looks like an obvious match', async () => {
    const { admin, planId } = await base();
    const existing = await admin.people.studentAdd({ fullName: 'Yusuf Ismail', feePlanId: planId });
    await admin.people.guardianCreate({ familyId: existing.familyId, name: 'Abu Yusuf', phone: '555-9' });

    await admin.people.importCommit({ defaultFeePlanId: planId, rows: [{ fullName: 'Sara Ismail', guardianName: 'Abu Yusuf' }] });

    // Same surname, same parent name — and still a separate household, because two unrelated
    // children sharing a surname must never end up sharing guardians and a balance by accident.
    const detail = await admin.people.familyGet({ id: existing.familyId });
    expect(detail.students).toHaveLength(1);
    expect(detail.students[0].fullName).toBe('Yusuf Ismail');
    expect(app.dbmod.db.select().from(families).all()).toHaveLength(2);
  });

  it('audits counts only — never names or Student IDs', async () => {
    const { admin, planId } = await base();
    const r = await admin.people.importCommit({ defaultFeePlanId: planId, rows: [{ fullName: 'Yusuf Ismail' }] });
    const entry = app.dbmod.db.select().from(auditLog).all().find((e) => e.action === 'student.import')!;
    const detail = JSON.stringify(entry.detail ?? {});
    expect(detail).toContain('"created":1');
    expect(detail).not.toContain('Yusuf');
    expect(detail).not.toContain(r.students[0].studentCode);
  });
});

describe('walls', () => {
  it('import is admin-only and LAN-only', async () => {
    const rows = [{ fullName: 'A B' }];
    await expect(caller('finance').people.importPreview({ rows })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller('finance').people.importCommit({ rows })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller('admin', { origin: 'tunnel' }).people.importCommit({ rows })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  /** A bill belongs to the CHILD since 0.39.0, so moving a child between households carries their
   *  billing with them. That is the right answer: an unpaid bill stranded on a household the child
   *  has left is a debt nobody is looking at. The invoice rows themselves are never rewritten. */
  it('linking siblings is admin-only and takes a child’s billing with them', async () => {
    const { admin, planId } = await base();
    // Two children added separately, so each starts in a household of their own.
    const a = await admin.people.studentAdd({ fullName: 'Yusuf Ismail', feePlanId: planId });
    const b = await admin.people.studentAdd({ fullName: 'Maryam Ismail', feePlanId: planId });
    expect(a.familyId).not.toBe(b.familyId);

    // Bill Yusuf BEFORE the link, so we can prove the debt survives the merge.
    await admin.billing.generateFamily({ familyId: a.familyId, periodKey: '2026-07', label: 'Jul' });
    const invId = (await admin.billing.studentBilling({ studentId: a.id })).invoices[0].id;

    await expect(caller('finance').people.familyAddSibling({ familyId: b.familyId, studentId: a.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const r = await admin.people.familyAddSibling({ familyId: b.familyId, studentId: a.id });
    expect(r.merged).toBe(true);
    expect(r.familyId).toBe(b.familyId); // the household on screen is the one that survives

    // The child's own record is untouched — same invoice, same id, still owed. Money is per student,
    // so a regrouping of households cannot rewrite it.
    const after = await admin.billing.studentBilling({ studentId: a.id });
    expect(after.invoices).toHaveLength(1);
    expect(after.invoices[0].id).toBe(invId);
    expect(after.balance.owedCents).toBe(35000);

    // One household now, holding both children and the debt.
    const merged = await admin.billing.familyBilling({ familyId: b.familyId });
    expect(merged.students).toHaveLength(2);
    expect(merged.balance.owedCents).toBe(35000);
    // …and the emptied one is gone rather than left behind as a stray record.
    expect((await admin.people.directory()).some((f) => f.id === a.familyId)).toBe(false);
  });
});
