// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Adding a sibling to a household — what replaced "move to family", simplified again in 0.41.0 to the
 * one question the office can answer: which child belongs on the record you are looking at.
 *
 * The household ON SCREEN survives, and the joining child's household is absorbed into it. That
 * direction is the load-bearing part: it is the record whose guardians, label and Stripe customer the
 * office can see, so it must not be the one that silently disappears.
 *
 * The merge is what makes the shared guardians work: they hang off the household, so nothing is copied
 * per child. The emptied household is removed rather than left as a stray record, and the merge is
 * refused outright when the absorbed household has card/autopay state, because those belong to that
 * family's Stripe customer.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, guardianFamilies, guardians, guardianUsers, users, emergencyContacts, students, families, autopayEnrollments, paymentMethods } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
const caller = (role: Role, origin: 'lan' | 'tunnel' = 'lan') =>
  app.appRouter.createCaller(makeCtx({ origin, session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => { app = await freshApp(); });
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, invoiceItems, invoices, autopayEnrollments, paymentMethods, studentFees, feePlans, guardianUsers, guardianFamilies, guardians, emergencyContacts, students, families, users]) db.delete(t).run();
});

async function twoChildren() {
  const admin = caller('admin');
  const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 35000, cadence: 'monthly' });
  const a = await admin.people.studentAdd({ fullName: 'Yusuf Ismail', feePlanId: plan.id });
  const b = await admin.people.studentAdd({ fullName: 'Maryam Ismail', feePlanId: plan.id });
  return { admin, planId: plan.id, a, b };
}

describe('familyAddSibling', () => {
  it('brings the child into THIS household and shares the guardians already on file', async () => {
    const { admin, a, b } = await twoChildren();
    // Each household has its own contacts before the link.
    await admin.people.guardianCreate({ familyId: a.familyId, name: 'Abu Yusuf', phone: '555-1' });
    await admin.people.emergencyContactAdd({ familyId: b.familyId, name: 'Neighbour', phone: '555-2' });

    // Reading Maryam's record, the office adds Yusuf to it.
    const r = await admin.people.familyAddSibling({ familyId: b.familyId, studentId: a.id });
    expect(r).toMatchObject({ merged: true, familyId: b.familyId });

    const detail = await admin.people.familyGet({ id: b.familyId });
    expect(detail.students.map((s) => s.fullName).sort()).toEqual(['Maryam Ismail', 'Yusuf Ismail']);
    // Both sides' contacts came along — nothing was copied per student, they simply share a household.
    expect(detail.guardians.map((g) => g.name)).toEqual(['Abu Yusuf']);
    expect(detail.emergencyContacts.map((c) => c.name)).toEqual(['Neighbour']);
    // The emptied household is gone, not left behind.
    expect((await admin.people.directory()).some((f) => f.id === a.familyId)).toBe(false);
  });

  it('keeps the household the office is looking at, and takes the joining child’s siblings with them', async () => {
    const { admin, planId, a, b } = await twoChildren();
    // A third child already linked to Yusuf, so his household holds two.
    const step = await admin.people.studentAdd({ fullName: 'Bilal Ismail', feePlanId: planId, linkToStudentId: a.id });

    await admin.people.familyAddSibling({ familyId: b.familyId, studentId: a.id });
    // Sibling-hood is transitive: Bilal came across too, without being named.
    const detail = await admin.people.familyGet({ id: b.familyId });
    expect(detail.students.map((s) => s.id).sort()).toEqual([a.id, b.id, step.id].sort());
  });

  it('re-derives the household label from whoever is now in it', async () => {
    const { admin, planId, a } = await twoChildren();
    const step = await admin.people.studentAdd({ fullName: 'Bilal Farooqi', feePlanId: planId });
    await admin.people.familyAddSibling({ familyId: a.familyId, studentId: step.id });
    // Sorted, so the label depends on WHO is in the household rather than who was added first.
    expect((await admin.people.familyGet({ id: a.familyId })).family.name).toBe('Farooqi / Ismail');
  });

  it('does not duplicate a guardian who is already on the surviving household', async () => {
    const { admin, a, b } = await twoChildren();
    const g = await admin.people.guardianCreate({ familyId: a.familyId, name: 'Abu Yusuf', phone: '555-1' });
    await admin.people.guardianLinkFamily({ guardianId: g.id, familyId: b.familyId });

    await admin.people.familyAddSibling({ familyId: b.familyId, studentId: a.id });
    expect((await admin.people.familyGet({ id: b.familyId })).guardians).toHaveLength(1);
  });

  /**
   * The CSV-import aftermath, which is what this dedupe exists for: every imported row gets its own
   * household AND its own guardian record, so one father with three children arrives as three people.
   * Linking the children used to stack all three copies on the record.
   */
  it('folds a duplicate guardian — the same person imported once per child — into ONE record', async () => {
    const { admin, a, b } = await twoChildren();
    // Two separate guardian ROWS for the same man, exactly as an import would create them.
    await admin.people.guardianCreate({ familyId: a.familyId, name: 'Abu Yusuf', phone: '(555) 123-4567', relation: 'father' });
    await admin.people.guardianCreate({ familyId: b.familyId, name: 'Abu Yusuf', email: 'abu@test.org' });

    const r = await admin.people.familyAddSibling({ familyId: b.familyId, studentId: a.id });
    expect(r.mergedGuardians).toBe(1);

    const detail = await admin.people.familyGet({ id: b.familyId });
    expect(detail.guardians).toHaveLength(1);
    // Blanks are FILLED, not overwritten: one copy had the phone, the other the email, and the
    // survivor keeps both plus the relation whichever copy recorded it.
    expect(detail.guardians[0]).toMatchObject({ name: 'Abu Yusuf', phone: '(555) 123-4567', email: 'abu@test.org', relation: 'father' });
  });

  it('matches on the phone number even when the name was typed differently', async () => {
    const { admin, a, b } = await twoChildren();
    await admin.people.guardianCreate({ familyId: a.familyId, name: 'Abu Yusuf', phone: '5551234567' });
    await admin.people.guardianCreate({ familyId: b.familyId, name: 'abu  yusuf ISMAIL', phone: '(555) 123-4567' });
    expect((await admin.people.familyAddSibling({ familyId: b.familyId, studentId: a.id })).mergedGuardians).toBe(1);
    expect((await admin.people.familyGet({ id: b.familyId })).guardians).toHaveLength(1);
  });

  it('leaves two genuinely different adults alone', async () => {
    const { admin, a, b } = await twoChildren();
    await admin.people.guardianCreate({ familyId: a.familyId, name: 'Abu Yusuf', phone: '5551234567', relation: 'father' });
    await admin.people.guardianCreate({ familyId: b.familyId, name: 'Umm Yusuf', phone: '5559998888', relation: 'mother' });
    expect((await admin.people.familyAddSibling({ familyId: b.familyId, studentId: a.id })).mergedGuardians).toBe(0);
    expect((await admin.people.familyGet({ id: b.familyId })).guardians).toHaveLength(2);
  });

  it('never silently removes a guardian who has a portal login when both copies have one', async () => {
    const { admin, a, b } = await twoChildren();
    const g1 = await admin.people.guardianCreate({ familyId: a.familyId, name: 'Abu Yusuf', email: 'abu@test.org' });
    const g2 = await admin.people.guardianCreate({ familyId: b.familyId, name: 'Abu Yusuf', email: 'abu@test.org' });
    // Both copies were invited and both accepted — two logins for one man.
    const ts = new Date();
    for (const [i, g] of [g1, g2].entries()) {
      app.dbmod.db.insert(users).values({ id: `usr_p${i}`, username: `p${i}@test.org`, passwordHash: 'x', role: 'parent', status: 'active', mustChangePassword: false, createdAt: ts, updatedAt: ts }).run();
      app.dbmod.db.insert(guardianUsers).values({ guardianId: g.id, userId: `usr_p${i}`, createdAt: ts }).run();
    }
    expect((await admin.people.familyAddSibling({ familyId: b.familyId, studentId: a.id })).mergedGuardians).toBe(0);
    // Both still there — deleting one would cascade its login away and leave that parent signed in to
    // nothing. A human decides which account goes.
    expect((await admin.people.familyGet({ id: b.familyId })).guardians).toHaveLength(2);
  });

  it('folds a duplicate emergency contact too — the office adds the same uncle to each child', async () => {
    const { admin, a, b } = await twoChildren();
    await admin.people.emergencyContactAdd({ familyId: a.familyId, name: 'Uncle Bilal', phone: '5552223333' });
    await admin.people.emergencyContactAdd({ familyId: b.familyId, name: 'Uncle Bilal', phone: '(555) 222-3333', relation: 'uncle' });
    const r = await admin.people.familyAddSibling({ familyId: b.familyId, studentId: a.id });
    expect(r.mergedContacts).toBe(1);
    const contacts = (await admin.people.familyGet({ id: b.familyId })).emergencyContacts;
    expect(contacts).toHaveLength(1);
    expect(contacts[0].relation).toBe('uncle');
  });

  it('is a no-op for a child already in this household', async () => {
    const { admin, a, b } = await twoChildren();
    await admin.people.familyAddSibling({ familyId: b.familyId, studentId: a.id });
    expect(await admin.people.familyAddSibling({ familyId: b.familyId, studentId: a.id })).toMatchObject({ merged: false });
  });

  it('404s on a household or a student that does not exist', async () => {
    const { admin, a } = await twoChildren();
    await expect(admin.people.familyAddSibling({ familyId: 'fam_nope', studentId: a.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(admin.people.familyAddSibling({ familyId: a.familyId, studentId: 'stu_nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses to absorb a household that has autopay set up, rather than re-pointing its Stripe state', async () => {
    const { admin, a, b } = await twoChildren();
    const ts = new Date();
    app.dbmod.db.insert(autopayEnrollments).values({ familyId: a.familyId, enabled: true, createdAt: ts, updatedAt: ts }).run();
    await expect(admin.people.familyAddSibling({ familyId: b.familyId, studentId: a.id })).rejects.toMatchObject({ code: 'CONFLICT' });
    // Merging the OTHER way round is still fine — it is the absorbed side that matters, and the
    // refusal message says so.
    expect(await admin.people.familyAddSibling({ familyId: a.familyId, studentId: b.id })).toMatchObject({ merged: true, familyId: a.familyId });
  });

  it('is admin-only and LAN-only', async () => {
    const { a, b } = await twoChildren();
    await expect(caller('finance').people.familyAddSibling({ familyId: b.familyId, studentId: a.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller('admin', 'tunnel').people.familyAddSibling({ familyId: b.familyId, studentId: a.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('studentUnlinkSiblings', () => {
  it('moves one child into a household of their own, taking their billing but not the guardians', async () => {
    const { admin, a, b } = await twoChildren();
    await admin.people.guardianCreate({ familyId: b.familyId, name: 'Abu Yusuf', phone: '555-1' });
    await admin.people.familyAddSibling({ familyId: b.familyId, studentId: a.id });
    await admin.billing.generateFamily({ familyId: b.familyId, periodKey: '2026-07', label: 'Jul' });

    const r = await admin.people.studentUnlinkSiblings({ studentId: a.id });
    expect(r.moved).toBe(true);
    expect(r.familyId).not.toBe(b.familyId);

    // Their own invoice follows them; the guardians stay on the household they left, because
    // guessing which adult belongs to the new one would be worse than an empty list.
    expect((await admin.billing.studentBilling({ studentId: a.id })).balance.owedCents).toBe(35000);
    expect((await admin.people.familyGet({ id: r.familyId })).guardians).toHaveLength(0);
    expect((await admin.people.familyGet({ id: b.familyId })).guardians).toHaveLength(1);
    expect((await admin.people.familyGet({ id: r.familyId })).family.name).toBe('Ismail family');
  });

  it('is a no-op for an only child — there is nothing to unlink from', async () => {
    const { admin, a } = await twoChildren();
    expect(await admin.people.studentUnlinkSiblings({ studentId: a.id })).toMatchObject({ moved: false, familyId: a.familyId });
  });
});
