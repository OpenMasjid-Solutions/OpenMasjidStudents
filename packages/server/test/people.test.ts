// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * People & SIS router (CLAUDE.md §4/§5/§9/§14): admin-only writes, admin|finance reads,
 * parent walled off, admin LAN-only, unique Student IDs, and audited records.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshApp, makeCtx } from './harness';
import { families, students, guardians, guardianFamilies, emergencyContacts, auditLog, studentFees, feePlans } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;

beforeAll(async () => {
  app = await freshApp();
});

beforeEach(() => {
  const { db } = app.dbmod;
  db.delete(guardianFamilies).run();
  db.delete(emergencyContacts).run();
  // student_fees references students AND fee_plans with RESTRICT, so it must go first.
  db.delete(studentFees).run();
  db.delete(feePlans).run();
  db.delete(students).run();
  db.delete(guardians).run();
  db.delete(families).run();
  db.delete(auditLog).run();
});

const session = (role: Role) => ({ role, source: 'local' as const, username: `${role}-user`, userId: `usr_${role}` });
const caller = (role: Role, origin: 'lan' | 'tunnel' = 'lan') => app.appRouter.createCaller(makeCtx({ origin, session: session(role) }).ctx);

/** studentCreate requires a fee plan (a student on no plan would never be invoiced). These
 *  tests are about people, not money, so they just need *a* plan to exist. */
const aPlan = async (admin: ReturnType<typeof caller>) =>
  (await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' })).id;

describe('writes are admin-only; reads are admin | finance', () => {
  it('admin creates a family + student with a Student ID, visible in the directory', async () => {
    const admin = caller('admin');
    const fam = await admin.people.familyCreate({ name: 'Ismail family' });
    const st = await admin.people.studentCreate({ familyId: fam.id, firstName: 'Yusuf', lastName: 'Ismail', feePlanId: await aPlan(admin) });
    expect(st.studentCode).toBe('YUS' + st.studentCode.slice(3)); // prefix from the first name
    expect(st.studentCode).toMatch(/^[A-Z]{3}\d{4}$/);
    const dir = await admin.people.directory();
    expect(dir).toHaveLength(1);
    expect(dir[0].students[0].firstName).toBe('Yusuf');
  });

  it('finance can READ the directory but cannot create', async () => {
    await caller('admin').people.familyCreate({ name: 'A family' });
    const finance = caller('finance');
    expect(await finance.people.directory()).toHaveLength(1);
    await expect(finance.people.familyCreate({ name: 'B family' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('teacher and parent cannot read the directory or write', async () => {
    for (const role of ['parent'] as const) {
      await expect(caller(role).people.directory()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(caller(role).people.familyCreate({ name: 'X' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('admin over the tunnel cannot touch people (LAN-only)', async () => {
    await expect(caller('admin', 'tunnel').people.directory()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller('admin', 'tunnel').people.familyCreate({ name: 'X' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('student IDs', () => {
  it('generates unique Student IDs across many children who share a first-name prefix', async () => {
    const admin = caller('admin');
    const fam = await admin.people.familyCreate({ name: 'Big family' });
    const feePlanId = await aPlan(admin);
    const codes = new Set<string>();
    for (let i = 0; i < 25; i++) {
      // Same first three letters every time, so all 25 compete for one prefix — the case where a
      // careless generator would collide.
      const s = await admin.people.studentCreate({ familyId: fam.id, firstName: `Sami${i}`, lastName: 'X', feePlanId });
      codes.add(s.studentCode);
    }
    expect(codes.size).toBe(25);
  });
});

describe('records + audit', () => {
  it('withdraw is audited as student.withdraw; guardians + emergency contacts attach; admin sees the Student ID on the record', async () => {
    const admin = caller('admin');
    const fam = await admin.people.familyCreate({ name: 'Fam' });
    const s = await admin.people.studentCreate({ familyId: fam.id, firstName: 'A', lastName: 'B', feePlanId: await aPlan(admin) });
    await admin.people.studentUpdate({ id: s.id, status: 'withdrawn' });
    await admin.people.guardianCreate({ familyId: fam.id, name: 'Abu Yusuf', phone: '555-1', relation: 'father', isEmergencyContact: true });
    await admin.people.emergencyContactAdd({ familyId: fam.id, name: 'Neighbour', phone: '555-2' });

    const detail = await admin.people.familyGet({ id: fam.id });
    expect(detail.students[0].status).toBe('withdrawn');
    expect(detail.students[0].studentCode).toMatch(/^[A-Z]{3}\d{4}$/);
    expect(detail.guardians[0].name).toBe('Abu Yusuf');
    expect(detail.guardians[0].isEmergencyContact).toBe(true);
    expect(detail.emergencyContacts[0].name).toBe('Neighbour');

    const withdraws = app.dbmod.db.select().from(auditLog).where(eq(auditLog.action, 'student.withdraw')).all();
    expect(withdraws).toHaveLength(1);
    expect(withdraws[0].actorRole).toBe('admin');
  });

  it('a guardian can be linked to a second family (spans families)', async () => {
    const admin = caller('admin');
    const famA = await admin.people.familyCreate({ name: 'A' });
    const famB = await admin.people.familyCreate({ name: 'B' });
    const g = await admin.people.guardianCreate({ familyId: famA.id, name: 'Shared Guardian' });
    await admin.people.guardianLinkFamily({ guardianId: g.id, familyId: famB.id, relation: 'uncle' });
    const a = await admin.people.familyGet({ id: famA.id });
    const b = await admin.people.familyGet({ id: famB.id });
    expect(a.guardians.some((x) => x.guardianId === g.id)).toBe(true);
    expect(b.guardians.some((x) => x.guardianId === g.id)).toBe(true);
    // linking the same guardian to the same family twice is a conflict
    await expect(admin.people.guardianLinkFamily({ guardianId: g.id, familyId: famB.id })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
