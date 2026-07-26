// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * People & SIS router (CLAUDE.md §4/§5/§9/§14): admin-only writes, admin|finance reads,
 * teacher/parent walled off (for now), admin LAN-only, unique PINs, and audit entries
 * that never contain the PIN.
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
  it('admin creates a family + student with a unique 6-digit PIN, visible in the directory', async () => {
    const admin = caller('admin');
    const fam = await admin.people.familyCreate({ name: 'Ismail family' });
    const st = await admin.people.studentCreate({ familyId: fam.id, firstName: 'Yusuf', lastName: 'Ismail', feePlanId: await aPlan(admin) });
    expect(st.pin).toMatch(/^\d{6}$/);
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

describe('student PINs', () => {
  it('generates unique PINs across many students', async () => {
    const admin = caller('admin');
    const fam = await admin.people.familyCreate({ name: 'Big family' });
    const feePlanId = await aPlan(admin);
    const pins = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const s = await admin.people.studentCreate({ familyId: fam.id, firstName: `S${i}`, lastName: 'X', feePlanId });
      pins.add(s.pin);
    }
    expect(pins.size).toBe(25);
  });

  it('regenerate changes the PIN (admin + finance) and is audited WITHOUT the PIN value', async () => {
    const admin = caller('admin');
    const fam = await admin.people.familyCreate({ name: 'Fam' });
    const s = await admin.people.studentCreate({ familyId: fam.id, firstName: 'A', lastName: 'B', feePlanId: await aPlan(admin) });
    const r = await caller('finance').people.pinRegenerate({ studentId: s.id });
    expect(r.pin).toMatch(/^\d{6}$/);
    expect(r.pin).not.toBe(s.pin);
    const entries = app.dbmod.db.select().from(auditLog).where(eq(auditLog.action, 'student.pin.regenerate')).all();
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0].detail ?? {})).not.toContain(r.pin); // PIN never in the audit trail
    expect(JSON.stringify(entries[0].detail ?? {})).not.toContain(s.pin);
  });
});

describe('records + audit', () => {
  it('withdraw is audited as student.withdraw; guardians + emergency contacts attach; admin sees the PIN on the record', async () => {
    const admin = caller('admin');
    const fam = await admin.people.familyCreate({ name: 'Fam' });
    const s = await admin.people.studentCreate({ familyId: fam.id, firstName: 'A', lastName: 'B', feePlanId: await aPlan(admin) });
    await admin.people.studentUpdate({ id: s.id, status: 'withdrawn' });
    await admin.people.guardianCreate({ familyId: fam.id, name: 'Abu Yusuf', phone: '555-1', relation: 'father', isEmergencyContact: true });
    await admin.people.emergencyContactAdd({ familyId: fam.id, name: 'Neighbour', phone: '555-2' });

    const detail = await admin.people.familyGet({ id: fam.id });
    expect(detail.students[0].status).toBe('withdrawn');
    expect(detail.students[0].pin).toMatch(/^\d{6}$/);
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
