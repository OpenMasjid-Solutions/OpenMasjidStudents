// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * One-off CHARGES (books, uniform, registration, late fees, credits) and the configurable
 * charge-item catalog, plus the shared bulk-apply target resolver and the course → class
 * grouping it selects over.
 *
 * The load-bearing rules under test:
 *  - label + amount are SNAPSHOTS: renaming or repricing an item never rewrites an applied charge
 *  - a charge lands on the period's invoice immediately when one is already open, otherwise it
 *    waits as `pending` for the next generation
 *  - appending a line re-derives the invoice status (a paid invoice drops to partially_paid)
 *  - an invoiced charge cannot be voided — the correction is a NEGATIVE charge, because an
 *    invoice line is immutable (§9)
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshApp, makeCtx } from './harness';
import { paymentAllocations, payments, charges, invoiceItems, invoices, chargeItems, studentFees, feePlans, students, classes, courses, families, terms, schoolYears, users, auditLog } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
const caller = (role: Role, opts: { origin?: 'lan' | 'tunnel' } = {}) =>
  app.appRouter.createCaller(makeCtx({ origin: opts.origin ?? 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => { app = await freshApp(); });
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, charges, invoiceItems, invoices, chargeItems, studentFees, feePlans, students, classes, courses, families, terms, schoolYears, users, auditLog]) db.delete(t).run();
});

/** A family with one student on a $50 monthly plan. */
async function seed() {
  const admin = caller('admin');
  const fam = await admin.people.familyCreate({ name: 'Ismail' });
  const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
  const s = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });
  return { admin, familyId: fam.id, studentId: s.id, planId: plan.id };
}

const invoiceFor = async (admin: ReturnType<typeof caller>, familyId: string, periodKey: string) =>
  (await admin.billing.familyBilling({ familyId })).invoices.find((i) => i.periodKey === periodKey);

describe('charge items are a catalog, and applying one snapshots it', () => {
  it('applies an item at its default price and records the label', async () => {
    const { admin, studentId, familyId } = await seed();
    const item = await admin.billing.chargeItemCreate({ name: 'Qaidah book', defaultAmountCents: 1500 });
    const r = await admin.billing.chargeAdd({ studentId, source: { kind: 'item', chargeItemId: item.id } });
    expect(r.attached).toBe(false); // no invoice for that period yet
    const list = await admin.billing.chargeList({ familyId });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ label: 'Qaidah book', amountCents: 1500, status: 'pending' });
  });

  it('re-pricing or renaming the item does NOT rewrite a charge already applied', async () => {
    const { admin, studentId, familyId } = await seed();
    const item = await admin.billing.chargeItemCreate({ name: 'Qaidah book', defaultAmountCents: 1500 });
    await admin.billing.chargeAdd({ studentId, source: { kind: 'item', chargeItemId: item.id } });
    await admin.billing.chargeItemUpdate({ id: item.id, name: 'Qaidah book (2nd ed)', defaultAmountCents: 2500 });
    const list = await admin.billing.chargeList({ familyId });
    expect(list[0]).toMatchObject({ label: 'Qaidah book', amountCents: 1500 });
  });

  it('an item can be re-priced for one application without touching the catalog', async () => {
    const { admin, studentId, familyId } = await seed();
    const item = await admin.billing.chargeItemCreate({ name: 'Uniform', defaultAmountCents: 4000 });
    await admin.billing.chargeAdd({ studentId, source: { kind: 'item', chargeItemId: item.id, amountCents: 3000 } });
    expect((await admin.billing.chargeList({ familyId }))[0].amountCents).toBe(3000);
    expect((await admin.billing.chargeItemList())[0].defaultAmountCents).toBe(4000);
  });

  it('a custom one-off needs no item, and a zero charge is refused', async () => {
    const { admin, studentId, familyId } = await seed();
    await admin.billing.chargeAdd({ studentId, source: { kind: 'custom', label: 'Late fee', amountCents: 2500 } });
    expect((await admin.billing.chargeList({ familyId }))[0]).toMatchObject({ label: 'Late fee', amountCents: 2500 });
    await expect(admin.billing.chargeAdd({ studentId, source: { kind: 'custom', label: 'Nothing', amountCents: 0 } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('when a charge reaches an invoice', () => {
  it('waits as pending with no invoice, then is picked up by generation', async () => {
    const { admin, studentId, familyId } = await seed();
    await admin.billing.chargeAdd({ studentId, source: { kind: 'custom', label: 'Registration', amountCents: 5000 }, periodKey: '2026-07' });
    await admin.billing.generateFamily({ familyId, periodKey: '2026-07', label: 'Jul' });
    const inv = await invoiceFor(admin, familyId, '2026-07');
    expect(inv!.totalCents).toBe(10000); // 5000 tuition + 5000 registration
    expect((await admin.billing.chargeList({ familyId }))[0].status).toBe('invoiced');
  });

  it('an UNTARGETED charge rides the next invoice generated, whatever its period', async () => {
    const { admin, studentId, familyId } = await seed();
    await admin.billing.chargeAdd({ studentId, source: { kind: 'custom', label: 'Trip', amountCents: 1000 } });
    await admin.billing.generateFamily({ familyId, periodKey: '2026-09', label: 'Sep' });
    expect((await invoiceFor(admin, familyId, '2026-09'))!.totalCents).toBe(6000);
  });

  it('lands on an already-open invoice immediately and re-derives its status', async () => {
    const { admin, studentId, familyId } = await seed();
    await admin.billing.generateFamily({ familyId, periodKey: '2026-07', label: 'Jul' });
    await admin.billing.recordManualPayment({ studentId, amountCents: 5000, channel: 'cash', occurredAt: '2026-07-03' });
    expect((await invoiceFor(admin, familyId, '2026-07'))!.status).toBe('paid');
    // Adding a charge to the paid invoice raises the total, so it is no longer fully paid.
    const r = await admin.billing.chargeAdd({ studentId, source: { kind: 'custom', label: 'Late fee', amountCents: 1500 }, periodKey: '2026-07' });
    expect(r.attached).toBe(true);
    const inv = await invoiceFor(admin, familyId, '2026-07');
    expect(inv!.totalCents).toBe(6500);
    expect(inv!.status).toBe('partially_paid');
    expect((await admin.billing.familyBilling({ familyId })).balance.owedCents).toBe(1500);
  });

  it('refuses to touch a VOID invoice and leaves the charge pending', async () => {
    const { admin, studentId, familyId } = await seed();
    await admin.billing.generateFamily({ familyId, periodKey: '2026-07', label: 'Jul' });
    const invId = (await invoiceFor(admin, familyId, '2026-07'))!.id;
    await admin.billing.voidInvoice({ id: invId });
    const r = await admin.billing.chargeAdd({ studentId, source: { kind: 'custom', label: 'Book', amountCents: 1000 }, periodKey: '2026-07' });
    expect(r.attached).toBe(false);
    expect((await admin.billing.chargeList({ familyId }))[0].status).toBe('pending');
    expect((await invoiceFor(admin, familyId, '2026-07'))!.status).toBe('void');
  });

  it('a NEGATIVE charge is how a credit is issued', async () => {
    const { admin, studentId, familyId } = await seed();
    await admin.billing.generateFamily({ familyId, periodKey: '2026-07', label: 'Jul' });
    await admin.billing.chargeAdd({ studentId, source: { kind: 'custom', label: 'Scholarship', amountCents: -2000 }, periodKey: '2026-07' });
    expect((await invoiceFor(admin, familyId, '2026-07'))!.totalCents).toBe(3000);
  });
});

describe('voiding a charge', () => {
  it('works while pending, and is refused once invoiced', async () => {
    const { admin, studentId, familyId } = await seed();
    const a = await admin.billing.chargeAdd({ studentId, source: { kind: 'custom', label: 'Book', amountCents: 1000 } });
    await admin.billing.chargeVoid({ id: a.id });
    expect((await admin.billing.chargeList({ familyId }))[0].status).toBe('void');
    // A voided charge is skipped by generation.
    const gen = await admin.billing.generateFamily({ familyId, periodKey: '2026-07', label: 'Jul' });
    expect((await invoiceFor(admin, familyId, '2026-07'))!.totalCents).toBe(5000);
    expect(gen.created).toBe(1);

    const b = await admin.billing.chargeAdd({ studentId, source: { kind: 'custom', label: 'Late fee', amountCents: 1000 }, periodKey: '2026-07' });
    expect(b.attached).toBe(true);
    await expect(admin.billing.chargeVoid({ id: b.id })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('bulk apply over the course → class grouping', () => {
  /** Two classes in one course, two students each. */
  async function roster() {
    const admin = caller('admin');
    const course = await admin.structure.courseCreate({ name: 'Hifz' });
    const c1 = await admin.structure.classCreate({ courseId: course.id, name: 'Hifz 1' });
    const c2 = await admin.structure.classCreate({ courseId: course.id, name: 'Hifz 2' });
    const plan = await admin.billing.feePlanCreate({ name: 'Base', amountCents: 1000, cadence: 'monthly' });
    const mk = async (name: string, classId: string) => {
      const fam = await admin.people.familyCreate({ name });
      const s = await admin.people.studentCreate({ familyId: fam.id, fullName: `${name} X`, feePlanId: plan.id, classId });
      return s.id;
    };
    return { admin, course: course.id, c1: c1.id, c2: c2.id, a: await mk('A', c1.id), b: await mk('B', c1.id), c: await mk('C', c2.id), d: await mk('D', c2.id) };
  }

  it('courseTree reports live student counts per class', async () => {
    const { admin, c1 } = await roster();
    const tree = await admin.structure.courseTree();
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe('Hifz');
    expect(tree[0].classes.find((k) => k.id === c1)!.studentCount).toBe(2);
  });

  it('assignFeeBulk applies a plan to a whole class, and is idempotent on a re-run', async () => {
    const { admin, c1 } = await roster();
    const extra = await admin.billing.feePlanCreate({ name: 'Hifz supplement', amountCents: 2000, cadence: 'monthly' });
    const first = await admin.billing.assignFeeBulk({ feePlanId: extra.id, target: { kind: 'class', classId: c1 } });
    expect(first).toMatchObject({ targeted: 2, assigned: 2, skipped: 0 });
    const second = await admin.billing.assignFeeBulk({ feePlanId: extra.id, target: { kind: 'class', classId: c1 } });
    expect(second).toMatchObject({ targeted: 2, assigned: 0, skipped: 2 });
  });

  it('assignFeeBulk can carry an override for the whole selection', async () => {
    const { admin, c2, c: studentC } = await roster();
    const extra = await admin.billing.feePlanCreate({ name: 'Supplement', amountCents: 2000, cadence: 'monthly' });
    await admin.billing.assignFeeBulk({ feePlanId: extra.id, target: { kind: 'class', classId: c2 }, overrideAmountCents: 500, note: 'ACH' });
    const famId = app.dbmod.db.select({ familyId: students.familyId }).from(students).where(eq(students.id, studentC)).get()!.familyId;
    const fees = await admin.billing.familyFees({ familyId: famId });
    const supplement = fees.find((f) => f.feePlanName === 'Supplement')!;
    expect(supplement.effectiveAmountCents).toBe(500);
    expect(supplement.note).toBe('ACH');
  });

  it('chargeAddBulk charges an entire course from the item side', async () => {
    const { admin, course } = await roster();
    const item = await admin.billing.chargeItemCreate({ name: 'Mushaf', defaultAmountCents: 3000 });
    const r = await admin.billing.chargeAddBulk({ source: { kind: 'item', chargeItemId: item.id }, target: { kind: 'course', courseId: course }, periodKey: '2026-07' });
    expect(r).toMatchObject({ targeted: 4, created: 4 });
    expect(await admin.billing.chargeList({ status: 'pending' })).toHaveLength(4);
  });

  it('a bulk target skips withdrawn students', async () => {
    const { admin, c1, a } = await roster();
    await admin.people.studentUpdate({ id: a, status: 'withdrawn' });
    const item = await admin.billing.chargeItemCreate({ name: 'Book', defaultAmountCents: 100 });
    const r = await admin.billing.chargeAddBulk({ source: { kind: 'item', chargeItemId: item.id }, target: { kind: 'class', classId: c1 } });
    expect(r.targeted).toBe(1);
  });

  it('archiving a class unplaces its students so the RESTRICT FK stays satisfiable', async () => {
    const { admin, c1 } = await roster();
    const r = await admin.structure.classArchive({ id: c1 });
    expect(r.unplaced).toBe(2);
    const tree = await admin.structure.courseTree();
    expect(tree[0].classes.find((k) => k.id === c1)).toBeUndefined(); // archived, so out of the tree
  });
});

describe('walls', () => {
  it('charges are admin + finance only; a parent is refused', async () => {
    const { studentId } = await seed();
    await expect(caller('parent').billing.chargeItemList()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller('parent').billing.chargeAdd({ studentId, source: { kind: 'custom', label: 'X', amountCents: 100 } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller('parent').structure.courseTree()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('structure WRITES are admin-only — finance can read the tree but not change it', async () => {
    const finance = caller('finance');
    expect(await finance.structure.courseTree()).toEqual([]);
    await expect(finance.structure.courseCreate({ name: 'Nazrah' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('admin over the tunnel cannot touch structure or charges (LAN-only)', async () => {
    await expect(caller('admin', { origin: 'tunnel' }).structure.courseCreate({ name: 'X' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller('admin', { origin: 'tunnel' }).billing.chargeItemCreate({ name: 'X', defaultAmountCents: 100 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
