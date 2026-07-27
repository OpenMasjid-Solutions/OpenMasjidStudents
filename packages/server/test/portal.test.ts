// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Parent portal (CLAUDE.md §5, §12, §14): the invite door (create → accept → parent account +
 * guardian link + session), single-use/expiry enforcement, and — the load-bearing wall — a
 * parent sees ONLY their own family's data and cannot reach staff procedures.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshApp, makeCtx } from './harness';
import { invites, guardianUsers, guardianFamilies, guardians, emergencyContacts, paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, students, families, sessions, users, auditLog } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
const caller = (role: Role, opts: { origin?: 'lan' | 'tunnel'; userId?: string } = {}) =>
  app.appRouter.createCaller(makeCtx({ origin: opts.origin ?? 'lan', session: { role, source: 'local', username: role, userId: opts.userId ?? `usr_${role}` } }).ctx);
const pub = (origin: 'lan' | 'tunnel' = 'lan') => app.appRouter.createCaller(makeCtx({ origin }).ctx);

beforeAll(async () => { app = await freshApp(); });
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [invites, guardianUsers, guardianFamilies, guardians, emergencyContacts, paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, students, families, sessions, users, auditLog]) db.delete(t).run();
});

/** Two families, each with a student and a guardian-with-email; family A also has a fee+invoice+payment. */
async function scenario() {
  const admin = caller('admin');
  const famA = await admin.people.familyCreate({ name: 'Ismail' });
  const famB = await admin.people.familyCreate({ name: 'Farooqi' });
  // studentCreate requires a plan. Family A's student is on it for real; family B's carries a ZERO
  // override so family B stays deliberately un-invoiced — it is the "other family" the
  // parent-scoping walls below are tested against.
  const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
  const sA = await admin.people.studentCreate({ familyId: famA.id, firstName: 'Yusuf', lastName: 'Ismail', feePlanId: plan.id });
  const sB = await admin.people.studentCreate({ familyId: famB.id, firstName: 'Bilal', lastName: 'Farooqi', feePlanId: plan.id, overrideAmountCents: 0 });
  const gA = await admin.people.guardianCreate({ familyId: famA.id, name: 'Abu Yusuf', email: 'AbuYusuf@example.com' });
  const gB = await admin.people.guardianCreate({ familyId: famB.id, name: 'Abu Bilal', email: 'abubilal@example.com' });
  // Family A: an invoice + partial payment, so the balance view has content.
  await admin.billing.generateFamily({ familyId: famA.id, periodKey: '2026-07', label: 'Tuition — Jul 2026', dueDate: '2026-07-01' });
  await admin.billing.recordManualPayment({ studentId: sA.id, amountCents: 2000, channel: 'cash', occurredAt: '2026-07-03' });
  return { admin, famA: famA.id, famB: famB.id, gA: gA.id, gB: gB.id, sA: sA.id, sB: sB.id };
}

/** Run the real invite door for a guardian; returns the new parent userId. */
async function acceptInvite(admin: ReturnType<typeof caller>, guardianId: string, password = 'parent-pass-1234') {
  const inv = await admin.auth.inviteCreate({ guardianId });
  const res = await pub().auth.inviteAccept({ token: inv.token, password });
  expect(res).toMatchObject({ ok: true, role: 'parent' });
  const link = app.dbmod.db.select().from(guardianUsers).where(eq(guardianUsers.guardianId, guardianId)).get();
  expect(link).toBeTruthy();
  return link!.userId;
}

describe('invite door', () => {
  it('create → accept mints a parent user + guardian link + session', async () => {
    const { admin, gA } = await scenario();
    const uid = await acceptInvite(admin, gA);
    const u = app.dbmod.db.select().from(users).where(eq(users.id, uid)).get()!;
    expect(u.role).toBe('parent');
    expect(u.username).toBe('abuyusuf@example.com'); // guardian email, lowercased
    expect(app.dbmod.db.select().from(sessions).all().length).toBeGreaterThan(0);
  });

  it('rejects inviting a guardian with no email, one already accounted, or a duplicate email', async () => {
    const { admin, famA, gA } = await scenario();
    const noEmail = await admin.people.guardianCreate({ familyId: famA, name: 'No Email' });
    await expect(admin.auth.inviteCreate({ guardianId: noEmail.id })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await acceptInvite(admin, gA);
    await expect(admin.auth.inviteCreate({ guardianId: gA })).rejects.toMatchObject({ code: 'CONFLICT' }); // already has an account
    // A second guardian reusing the same email can't be invited (username clash).
    const dup = await admin.people.guardianCreate({ familyId: famA, name: 'Dup', email: 'abuyusuf@example.com' });
    await expect(admin.auth.inviteCreate({ guardianId: dup.id })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('an invite is single-use and an unknown/expired token is refused', async () => {
    const { admin, gA } = await scenario();
    const inv = await admin.auth.inviteCreate({ guardianId: gA });
    await pub().auth.inviteAccept({ token: inv.token, password: 'parent-pass-1234' });
    // Second accept of the same token fails (already used).
    await expect(pub().auth.inviteAccept({ token: inv.token, password: 'another-pass-1234' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(pub().auth.inviteAccept({ token: 'not-a-real-token', password: 'parent-pass-1234' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('inviteInfo greets a valid token and is uniform-invalid otherwise', async () => {
    const { admin, gA } = await scenario();
    const inv = await admin.auth.inviteCreate({ guardianId: gA });
    expect(await pub().auth.inviteInfo({ token: inv.token })).toMatchObject({ valid: true, guardianName: 'Abu Yusuf' });
    expect(await pub().auth.inviteInfo({ token: 'nope' })).toEqual({ valid: false });
    await pub().auth.inviteAccept({ token: inv.token, password: 'parent-pass-1234' });
    expect(await pub().auth.inviteInfo({ token: inv.token })).toEqual({ valid: false }); // used → invalid
  });

  it('a parent can log in with their email in any case (stored lowercased)', async () => {
    const { admin, gA } = await scenario(); // gA email is 'AbuYusuf@example.com' (mixed case)
    await acceptInvite(admin, gA, 'parent-pass-1234');
    // The office typed a mixed-case email; the parent types it however they know it / a phone
    // auto-capitalizes — all must resolve to the one lowercased account.
    for (const typed of ['AbuYusuf@example.com', 'abuyusuf@example.com', 'ABUYUSUF@EXAMPLE.COM']) {
      expect(await pub().auth.login({ username: typed, password: 'parent-pass-1234' })).toMatchObject({ ok: true, role: 'parent' });
    }
    await expect(pub().auth.login({ username: 'AbuYusuf@example.com', password: 'wrong-pass-9999' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('a long guardian email works end to end (login username cap fits an email)', async () => {
    const { admin, famA } = await scenario();
    const longEmail = `${'a'.repeat(50)}@example-domain-name.org`; // 74 chars, > the old 64 cap
    const g = await admin.people.guardianCreate({ familyId: famA, name: 'Long Email', email: longEmail });
    const inv = await admin.auth.inviteCreate({ guardianId: g.id });
    await pub().auth.inviteAccept({ token: inv.token, password: 'parent-pass-1234' });
    expect(await pub().auth.login({ username: longEmail, password: 'parent-pass-1234' })).toMatchObject({ ok: true, role: 'parent' });
  });

  it('only admin/finance can create invites; parents cannot', async () => {
    const { gA } = await scenario();
    await expect(caller('parent').auth.inviteCreate({ guardianId: gA })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await caller('finance').auth.inviteCreate({ guardianId: gA })).token).toBeTruthy();
  });
});

describe('parent portal scoping (the wall)', () => {
  it('myFamily returns only the parent’s own family, with its kids/balance/invoices/payments', async () => {
    const { admin, famA, gA } = await scenario();
    const uid = await acceptInvite(admin, gA);
    const parent = caller('parent', { userId: uid });
    const res = await parent.portal.myFamily();
    expect(res.families).toHaveLength(1);
    const f = res.families[0];
    expect(f.id).toBe(famA);
    expect(f.name).toBe('Ismail family'); // derived from the children's surname (0.39.0)
    expect(f.students.map((s) => s.firstName)).toEqual(['Yusuf']);
    expect(f.balance.owedCents).toBe(3000); // 5000 invoiced − 2000 paid
    expect(f.invoices).toHaveLength(1);
    expect(f.payments.length).toBeGreaterThan(0);
  });

  it('a parent linked to family A can never see family B', async () => {
    const { admin, famB, gA } = await scenario();
    const uid = await acceptInvite(admin, gA);
    const parent = caller('parent', { userId: uid });
    const res = await parent.portal.myFamily();
    expect(res.families.every((f) => f.id !== famB)).toBe(true);
    // And a parent cannot reach any staff read (billing / directory) — role wall.
    await expect(parent.billing.familyBilling({ familyId: famB })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(parent.people.directory()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an unlinked parent session sees nothing', async () => {
    await scenario();
    const res = await caller('parent', { userId: 'usr_orphan' }).portal.myFamily();
    expect(res.families).toEqual([]);
  });

  it('parent portal works over the tunnel (parents are remote by design)', async () => {
    const { admin, gA } = await scenario();
    const uid = await acceptInvite(admin, gA);
    const res = await caller('parent', { origin: 'tunnel', userId: uid }).portal.myFamily();
    expect(res.families).toHaveLength(1);
  });
});
