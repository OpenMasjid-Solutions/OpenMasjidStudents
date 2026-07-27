// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The human-readable student ID (`YUS1234`) — generation, the awkward names, uniqueness, and the boot
 * backfill. Since there is no PIN behind it, the ID is the whole credential in the payment flow, which
 * makes two of its properties load-bearing: it must be UNIQUE per install (two children sharing one
 * would let a payment land on the wrong record) and it must be generated, never chosen.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { families, students, feePlans, studentFees, settings } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let codes: typeof import('../src/billing/studentCodes');
const caller = (role: Role) => app.appRouter.createCaller(makeCtx({ session: { userId: 'u1', role, name: 'A' } }).ctx);

beforeAll(async () => {
  app = await freshApp();
  codes = await import('../src/billing/studentCodes');
});

beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [studentFees, students, feePlans, families, settings]) db.delete(t).run();
});

describe('codePrefix — three letters, always', () => {
  it('takes the first three letters of the first name, uppercased', () => {
    expect(codes.codePrefix('Yusuf')).toBe('YUS');
    expect(codes.codePrefix('ibrahim')).toBe('IBR');
  });

  it('strips diacritics rather than dropping the letter', () => {
    expect(codes.codePrefix('Yūsuf')).toBe('YUS');
    expect(codes.codePrefix('Áïsha')).toBe('AIS');
  });

  it('pads a one- or two-letter name, so the prefix space is never narrower than three', () => {
    expect(codes.codePrefix('Bo')).toBe('BOX');
    expect(codes.codePrefix('A')).toBe('AXX');
  });

  it('ignores spaces, hyphens and apostrophes instead of encoding them', () => {
    expect(codes.codePrefix("Abd'ul")).toBe('ABD');
    expect(codes.codePrefix('Al Amin')).toBe('ALA');
    expect(codes.codePrefix('Zayn-Ali')).toBe('ZAY');
  });

  it('falls back to STU for a name with no Latin letters at all, rather than guessing', () => {
    expect(codes.codePrefix('يوسف')).toBe('STU');
    expect(codes.codePrefix('123')).toBe('STU');
    expect(codes.codePrefix('')).toBe('STU');
  });

  it('always returns exactly three A-Z characters', () => {
    for (const n of ['Yusuf', 'Bo', 'A', '', 'يوسف', "O'Brien", '  ']) {
      expect(codes.codePrefix(n)).toMatch(/^[A-Z]{3}$/);
    }
  });
});

describe('normalizeStudentCode — what a parent might actually type', () => {
  it('uppercases and strips spaces and hyphens', () => {
    expect(codes.normalizeStudentCode(' yus-1234 ')).toBe('YUS1234');
    expect(codes.normalizeStudentCode('yus 1234')).toBe('YUS1234');
  });
});

describe('generateUniqueStudentCode', () => {
  async function seedFamily() {
    const admin = caller('admin');
    const fam = await admin.people.familyCreate({ name: 'Ismail' });
    const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
    return { admin, famId: fam.id, planId: plan.id };
  }

  it('matches the agreed shape: first three letters + 4 digits', async () => {
    const { admin, famId, planId } = await seedFamily();
    const r = await admin.people.studentCreate({ familyId: famId, firstName: 'Yusuf', lastName: 'Ismail', feePlanId: planId });
    const row = app.dbmod.db.select().from(students).all().find((s) => s.id === r.id)!;
    expect(row.studentCode).toMatch(/^YUS\d{4}$/);
    expect(row.studentCode).toMatch(codes.STUDENT_CODE_RE);
  });

  it('never repeats a code, even for many children with the same first name', async () => {
    const { admin, famId, planId } = await seedFamily();
    for (let i = 0; i < 25; i++) {
      await admin.people.studentCreate({ familyId: famId, firstName: 'Yusuf', lastName: `Ismail${i}`, feePlanId: planId });
    }
    const all = app.dbmod.db.select().from(students).all();
    const list = all.map((s) => s.studentCode!);
    expect(list).toHaveLength(25);
    expect(new Set(list).size).toBe(25); // all distinct
    for (const c of list) expect(c.startsWith('YUS')).toBe(true);
  });

  it('is generated server-side, so a caller cannot choose or import one', async () => {
    const { admin, famId, planId } = await seedFamily();
    // studentCreate's input schema has no studentCode field at all; passing one is ignored/rejected.
    const r = await admin.people.studentCreate({
      familyId: famId,
      firstName: 'Yusuf',
      lastName: 'Ismail',
      feePlanId: planId,
      // @ts-expect-error — proving the field is not part of the contract
      studentCode: 'AAA0001',
    });
    const row = app.dbmod.db.select().from(students).all().find((s) => s.id === r.id)!;
    expect(row.studentCode).not.toBe('AAA0001');
  });
});

describe('backfillStudentCodes — the upgrade path', () => {
  it('fills every student missing a code, and is a no-op on the second run', async () => {
    const admin = caller('admin');
    const fam = await admin.people.familyCreate({ name: 'Ismail' });
    const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
    const a = await admin.people.studentCreate({ familyId: fam.id, firstName: 'Yusuf', lastName: 'Ismail', feePlanId: plan.id });
    const b = await admin.people.studentCreate({ familyId: fam.id, firstName: 'Bo', lastName: 'Ismail', feePlanId: plan.id });

    // Simulate rows that predate the column.
    const { db } = app.dbmod;
    db.update(students).set({ studentCode: null }).run();
    expect(db.select().from(students).all().every((s) => s.studentCode === null)).toBe(true);

    expect(codes.backfillStudentCodes()).toBe(2);
    const after = db.select().from(students).all();
    const byId = new Map(after.map((s) => [s.id, s.studentCode]));
    expect(byId.get(a.id)).toMatch(/^YUS\d{4}$/);
    expect(byId.get(b.id)).toMatch(/^BOX\d{4}$/); // two-letter name padded
    expect(new Set(after.map((s) => s.studentCode)).size).toBe(2);

    // Idempotent: nothing left to do.
    expect(codes.backfillStudentCodes()).toBe(0);
  });
});
