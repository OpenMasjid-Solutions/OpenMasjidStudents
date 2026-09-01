// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Usernames are ONE name whatever the case (0.48.0 — found by audit).
 *
 * THE DEFECT. Signing in looks an account up case-insensitively (a parent's username is their email
 * address, and a phone keyboard capitalizes it), but every "is this name taken?" check compared exactly —
 * and `users.username` is UNIQUE under SQLite's binary collation, so `Office` and `office` were accepted
 * as two accounts. Only one of them could then ever be signed into: the lookup matches both and takes the
 * first row. An admin creating a second admin that way got an account that silently did not work, with no
 * error anywhere.
 *
 * So these tests pin both halves of the rule:
 *   • creation refuses a name that already exists in another case, at every door (staff, invite, self-
 *     registration through the invite mint);
 *   • signing in still finds an account whatever case the person typed, AND — for an install that already
 *     has such a pair — an exact match wins, so each person reaches their own account.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { users, guardians, guardianFamilies, guardianUsers, families, students, invites, sessions, studentFees, feePlans } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let usernames: typeof import('../src/auth/usernames');
let passwords: typeof import('../src/auth/passwords');

const caller = (role: Role) => app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);
const anon = () => app.appRouter.createCaller(makeCtx({ origin: 'lan' }).ctx);

beforeAll(async () => {
  app = await freshApp();
  usernames = await import('../src/auth/usernames');
  passwords = await import('../src/auth/passwords');
});

beforeEach(() => {
  const { db } = app.dbmod;
  // In dependency order — `student_fees` references students ON DELETE RESTRICT, so the fee rows have to
  // go before the children they belong to.
  for (const t of [sessions, guardianUsers, guardianFamilies, guardians, invites, studentFees, feePlans, students, families, users]) db.delete(t).run();
});

describe('creating an account', () => {
  it('refuses a staff username that already exists in another case', async () => {
    const admin = caller('admin');
    await admin.staff.create({ username: 'Office', role: 'finance', tempPassword: 'a-long-enough-password' });
    // Before the fix this was ACCEPTED, and the resulting admin account could never be signed into.
    await expect(admin.staff.create({ username: 'office', role: 'admin', tempPassword: 'another-long-password' })).rejects.toThrow(/already taken/i);
    await expect(admin.staff.create({ username: 'OFFICE', role: 'admin', tempPassword: 'another-long-password' })).rejects.toThrow(/already taken/i);
    expect(app.dbmod.db.select().from(users).all()).toHaveLength(1);
  });

  it('still allows a genuinely different username', async () => {
    const admin = caller('admin');
    await admin.staff.create({ username: 'Office', role: 'finance', tempPassword: 'a-long-enough-password' });
    await admin.staff.create({ username: 'office2', role: 'finance', tempPassword: 'a-long-enough-password' });
    expect(app.dbmod.db.select().from(users).all()).toHaveLength(2);
  });

  it('keeps the case an admin typed, rather than lower-casing the account', async () => {
    // The comparison is case-insensitive; the STORED value is what the office typed and expects to read
    // back on the staff screen.
    await caller('admin').staff.create({ username: 'Ustadh.Bilal', role: 'finance', tempPassword: 'a-long-enough-password' });
    expect(app.dbmod.db.select().from(users).all()[0].username).toBe('Ustadh.Bilal');
  });

  it('refuses to invite a guardian whose email is already a staff login in another case', async () => {
    const admin = caller('admin');
    await admin.staff.create({ username: 'Office@masjid.org', role: 'finance', tempPassword: 'a-long-enough-password' });
    const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
    const stu = await admin.people.studentAdd({ fullName: 'Yusuf Ismail', feePlanId: plan.id });
    const g = await admin.people.guardianCreate({ familyId: stu.familyId, name: 'Bilal Ismail', email: 'office@masjid.org' });

    await expect(admin.auth.inviteCreate({ guardianId: g.id })).rejects.toThrow(/already used by another account/i);
  });
});

describe('signing in', () => {
  /**
   * A local account with a known password, written straight to the table.
   *
   * Inserted rather than created through `staff.create`, because the pair below is exactly what that
   * procedure now refuses — this is the install that made one BEFORE the fix, which is the state the
   * exact-match-first rule exists for. (The row id can't be derived from the lowercased name for the same
   * reason: the two rows would collide.)
   */
  let seq = 0;
  async function account(username: string, password: string, role: Role = 'finance') {
    const ts = new Date();
    app.dbmod.db
      .insert(users)
      .values({ id: `usr_seed_${seq++}`, username, passwordHash: await passwords.hashPassword(password), role, status: 'active', mustChangePassword: false, displayName: username, createdAt: ts, updatedAt: ts })
      .run();
  }

  it('finds the account however the person typed it', async () => {
    await account('Office', 'a-long-enough-password');
    const r = await anon().auth.login({ username: 'OFFICE', password: 'a-long-enough-password' });
    expect(r.ok).toBe(true);
  });

  it('prefers an exact match, so an install that already has both pairs still works', async () => {
    // The creation guard stops NEW pairs; this is what looks after an install that made one before the
    // fix. Each person signs in with their own name and reaches their own account.
    await account('Office', 'password-for-the-first', 'finance');
    await account('office', 'password-for-the-second', 'admin');

    expect(usernames.findUserByUsername('Office')?.role).toBe('finance');
    expect(usernames.findUserByUsername('office')?.role).toBe('admin');
    // And the loose match is still there for a case neither row holds exactly.
    expect(usernames.findUserByUsername('OFFICE')).toBeDefined();
  });
});
