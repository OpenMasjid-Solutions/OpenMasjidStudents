// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * `charges.source_key` — the natural key that stops software charging a family twice (0.52.0).
 *
 * CLAUDE.md §9, §4a Phase 0. The caller arrives in Phase 2 (admissions raises an enrollment fee at
 * conversion and a re-admission fee at approval, both from bulk buttons); the key, the column and its
 * one writer land first, because a family charged twice for re-enrolling is a defect that looks fine in
 * testing and lands on a hundred households in the fortnight a whole school re-enrolls.
 *
 * What these assert, and why each one is here:
 *
 *  - raising the same key twice creates ONE charge, and the second call REPORTS that (`created: false`)
 *    rather than erroring — the caller is a button and "already done" is success;
 *  - the second call does not re-price or re-label the existing row, so a fee the office adjusted by
 *    hand survives a re-approval;
 *  - the UNIQUE index is the real guard, proven by going around `raiseChargeOnce` and inserting the
 *    duplicate directly — a check-then-insert is passed by both of two concurrent requests, so a suite
 *    that only ever drove the happy path would pass with no index at all;
 *  - the OFFICE's own path is untouched: `chargeAdd` still raises two charges when pressed twice,
 *    because a person can see a duplicate and void it, and a null key repeats freely.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshApp, makeCtx } from './harness';
import { paymentAllocations, payments, charges, invoiceItems, invoices, chargeItems, studentFees, feePlans, students, classes, courses, families, terms, schoolYears, users, auditLog } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
/**
 * Imported dynamically, inside `beforeAll`, like every other module under test here: a STATIC import of
 * anything in `src/` that reaches `config` or `db` freezes `dataDir` to `./data` before `freshApp()`
 * runs, and the harness then refuses to continue (see its comment for the 0.48.0 case that caused it).
 * `billing/charges.ts` imports `db`, so it is exactly that.
 */
let sut: typeof import('../src/billing/charges');

const caller = (role: Role) =>
  app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp();
  sut = await import('../src/billing/charges');
});

beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, charges, invoiceItems, invoices, chargeItems, studentFees, feePlans, students, classes, courses, families, terms, schoolYears, users, auditLog]) db.delete(t).run();
});

async function seedStudent() {
  const admin = caller('admin');
  const fam = await admin.people.familyCreate({ name: 'Ismail' });
  const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
  const s = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });
  return { admin, familyId: fam.id, studentId: s.id };
}

describe('sourceKeyFor', () => {
  it('namespaces the key, so two features cannot collide on a bare id', () => {
    expect(sut.sourceKeyFor('admission', 'inq_7')).toBe('admission:inq_7');
    expect(sut.sourceKeyFor('readmission', 'stu_3', 'sy_2027')).toBe('readmission:stu_3:sy_2027');
  });

  it('refuses an empty part rather than building a key that collides with everything', () => {
    expect(() => sut.sourceKeyFor('admission', '')).toThrow();
    expect(() => sut.sourceKeyFor('readmission', 'stu_3', '')).toThrow();
  });
});

describe('raiseChargeOnce', () => {
  it('raises the charge the first time', async () => {
    const { studentId, familyId, admin } = await seedStudent();
    const r = sut.raiseChargeOnce({ studentId, label: 'Admission fee', amountCents: 7500, sourceKey: sut.sourceKeyFor('admission', 'inq_7') });
    expect(r.created).toBe(true);
    const list = await admin.billing.chargeList({ familyId });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ label: 'Admission fee', amountCents: 7500, status: 'pending' });
  });

  it('RAISES IT ONCE when the same key comes back, and says so instead of throwing', async () => {
    const { studentId, familyId, admin } = await seedStudent();
    const key = sut.sourceKeyFor('readmission', studentId, 'sy_2027');
    const first = sut.raiseChargeOnce({ studentId, label: 'Re-admission fee', amountCents: 5000, sourceKey: key });
    const second = sut.raiseChargeOnce({ studentId, label: 'Re-admission fee', amountCents: 5000, sourceKey: key });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.chargeId).toBe(first.chargeId);
    expect(await admin.billing.chargeList({ familyId })).toHaveLength(1);
  });

  it('does NOT re-price or re-label on the repeat — a fee the office adjusted survives a re-approval', async () => {
    const { studentId, admin, familyId } = await seedStudent();
    const key = sut.sourceKeyFor('readmission', studentId, 'sy_2027');
    const first = sut.raiseChargeOnce({ studentId, label: 'Re-admission fee', amountCents: 5000, note: 'standard', sourceKey: key });

    // The office halves it for hardship, by hand, the way it would any other charge.
    const { db } = app.dbmod;
    db.update(charges).set({ amountCents: 2500, note: 'hardship, agreed with the imam' }).where(eq(charges.id, first.chargeId)).run();

    sut.raiseChargeOnce({ studentId, label: 'Re-admission fee', amountCents: 5000, note: 'standard', sourceKey: key });

    const list = await admin.billing.chargeList({ familyId });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ amountCents: 2500, note: 'hardship, agreed with the imam' });
  });

  it('THE UNIQUE INDEX IS THE GUARD — a duplicate inserted around the helper is refused by the database', async () => {
    // Deliberately bypasses raiseChargeOnce. Without this the rest of the file would pass with no index
    // at all, because every other test goes through the read-then-insert that the index exists to back
    // up under concurrency.
    const { studentId } = await seedStudent();
    const key = sut.sourceKeyFor('admission', 'inq_9');
    sut.raiseChargeOnce({ studentId, label: 'Admission fee', amountCents: 7500, sourceKey: key });

    const { db } = app.dbmod;
    const ts = new Date();
    expect(() =>
      db.insert(charges).values({ id: 'chg_forced', studentId, chargeItemId: null, label: 'Admission fee', amountCents: 7500, note: null, periodKey: null, status: 'pending', invoiceItemId: null, createdByUserId: null, sourceKey: key, createdAt: ts, updatedAt: ts }).run(),
    ).toThrow();
  });

  it('leaves the office path alone: null keys repeat freely', async () => {
    const { studentId, familyId, admin } = await seedStudent();
    // Two hand-raised charges with no key between them — a book fee genuinely charged twice.
    await admin.billing.chargeAdd({ bill: 'period', studentId, source: { kind: 'custom', label: 'Qaidah book', amountCents: 1500 } });
    await admin.billing.chargeAdd({ bill: 'period', studentId, source: { kind: 'custom', label: 'Qaidah book', amountCents: 1500 } });
    expect(await admin.billing.chargeList({ familyId })).toHaveLength(2);

    const { db } = app.dbmod;
    expect(db.select().from(charges).all().every((r) => r.sourceKey === null)).toBe(true);
  });

  it('chargeBySourceKey finds it, and finds nothing for a key never used', async () => {
    const { studentId } = await seedStudent();
    const key = sut.sourceKeyFor('admission', 'inq_11');
    const { chargeId } = sut.raiseChargeOnce({ studentId, label: 'Admission fee', amountCents: 7500, sourceKey: key });
    expect(sut.chargeBySourceKey(key)?.id).toBe(chargeId);
    expect(sut.chargeBySourceKey(sut.sourceKeyFor('admission', 'inq_12'))).toBeUndefined();
  });

  it('refuses a zero charge, like every other path into this table', async () => {
    const { studentId } = await seedStudent();
    expect(() => sut.raiseChargeOnce({ studentId, label: 'Nothing', amountCents: 0, sourceKey: sut.sourceKeyFor('admission', 'inq_13') })).toThrow();
  });
});
