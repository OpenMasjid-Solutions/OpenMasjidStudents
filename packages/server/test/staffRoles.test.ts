// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Staff roles: creating an admin or a finance user, and changing between them.
 *
 * The interesting cases are the refusals, because each one is a way to brick an install or to escalate
 * privilege, and none of them is obvious from the happy path:
 *   - the LAST admin must not be demoted or disabled (admin is the only role that reaches settings,
 *     and admin sign-in is LAN-only, so there is no remote way back in);
 *   - nobody may change or disable their OWN account;
 *   - a parent's portal account must not be reachable from this screen at all.
 * A role change also has to bite immediately, since sessions carry a role copy.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshApp, makeCtx } from './harness';
import { users, guardians, guardianUsers, guardianFamilies, families, sessions } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
const PW = 'a-long-temp-password';

/** A caller acting as a specific user id, so self-action guards can be exercised. */
const asUser = (role: Role, userId: string) =>
  app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId } }).ctx);

beforeAll(async () => {
  app = await freshApp();
});

beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [sessions, guardianUsers, guardianFamilies, guardians, families, users]) db.delete(t).run();
});

/** The primary admin every install has, plus a caller acting as them. */
function seedAdmin(id = 'usr_admin1') {
  const ts = new Date();
  app.dbmod.db
    .insert(users)
    .values({ id, username: 'admin', passwordHash: 'x', role: 'admin', status: 'active', displayName: 'Admin', mustChangePassword: false, createdAt: ts, updatedAt: ts })
    .run();
  return { id, caller: asUser('admin', id) };
}

describe('creating staff with a chosen role', () => {
  it('creates a finance user', async () => {
    const { caller } = seedAdmin();
    const r = await caller.staff.create({ username: 'fatima', role: 'finance', tempPassword: PW });
    const u = app.dbmod.db.select().from(users).where(eq(users.id, r.id)).get()!;
    expect(u.role).toBe('finance');
    expect(u.mustChangePassword).toBe(true); // forced change on first login
  });

  it('creates a SECOND ADMIN — the thing that was impossible before', async () => {
    const { caller } = seedAdmin();
    const r = await caller.staff.create({ username: 'yusuf', role: 'admin', tempPassword: PW });
    expect(app.dbmod.db.select().from(users).where(eq(users.id, r.id)).get()!.role).toBe('admin');
  });

  it('refuses a parent role from this screen', async () => {
    const { caller } = seedAdmin();
    // @ts-expect-error — `parent` is not in the staff role enum
    await expect(caller.staff.create({ username: 'p', role: 'parent', tempPassword: PW })).rejects.toThrow();
  });

  it('lists admins as well as finance, so roles are visible', async () => {
    const { caller } = seedAdmin();
    await caller.staff.create({ username: 'fatima', role: 'finance', tempPassword: PW });
    const rows = await caller.staff.list();
    expect(rows.map((r) => r.role).sort()).toEqual(['admin', 'finance']);
  });
});

describe('changing a role', () => {
  it('promotes finance → admin and demotes back', async () => {
    const { caller } = seedAdmin();
    const f = await caller.staff.create({ username: 'fatima', role: 'finance', tempPassword: PW });
    await caller.staff.setRole({ userId: f.id, role: 'admin' });
    expect(app.dbmod.db.select().from(users).where(eq(users.id, f.id)).get()!.role).toBe('admin');
    await caller.staff.setRole({ userId: f.id, role: 'finance' });
    expect(app.dbmod.db.select().from(users).where(eq(users.id, f.id)).get()!.role).toBe('finance');
  });

  it('takes effect on a LIVE session — the session’s frozen role copy is not trusted', async () => {
    const { caller } = seedAdmin();
    const f = await caller.staff.create({ username: 'fatima', role: 'finance', tempPassword: PW });
    const sessions = await import('../src/auth/sessions');
    const { token } = sessions.createSession({ userId: f.id, role: 'finance', source: 'local', username: 'fatima' });
    expect(sessions.getSession(token)?.role).toBe('finance');
    await caller.staff.setRole({ userId: f.id, role: 'admin' });
    // Same cookie, no re-login: the live role wins.
    expect(sessions.getSession(token)?.role).toBe('admin');
  });

  it('REFUSES demoting the last admin, and allows it once a second exists', async () => {
    const { id, caller } = seedAdmin();
    const other = await caller.staff.create({ username: 'yusuf', role: 'admin', tempPassword: PW });
    // Two admins now, so demoting `other` is fine...
    await caller.staff.setRole({ userId: other.id, role: 'finance' });
    // ...and now the seeded admin is the only one left. Another admin must do the asking, so act as
    // the demoted user's colleague: promote them back, then try to demote the last admin from there.
    const asOther = asUser('admin', other.id);
    await caller.staff.setRole({ userId: other.id, role: 'admin' });
    await expect(asOther.staff.setRole({ userId: id, role: 'finance' })).resolves.toBeTruthy();
    // Only `other` remains an admin; demoting them must now fail. This app has no Fabric configured
    // (freshApp() without it), which is the whole reason the refusal is right here: there is no platform
    // dashboard to come back in through, so the office would be locked out of its own settings. On an
    // OpenMasjidOS install the same call is ALLOWED — see lastAdmin.test.ts, which needs its own file
    // because `fabricConfigured()` is fixed per test file.
    await expect(asUser('admin', id).staff.setRole({ userId: other.id, role: 'finance' })).rejects.toThrow(/only admin/i);
    // …and it says which of the two things to do about it, since "no" alone is not actionable.
    await expect(asUser('admin', id).staff.setRole({ userId: other.id, role: 'finance' })).rejects.toThrow(/not connected to OpenMasjidOS/);
  });

  it('refuses changing your OWN role', async () => {
    const { id, caller } = seedAdmin();
    await caller.staff.create({ username: 'yusuf', role: 'admin', tempPassword: PW });
    await expect(caller.staff.setRole({ userId: id, role: 'finance' })).rejects.toThrow(/your own role/i);
  });
});

describe('disabling', () => {
  it('refuses disabling the last admin', async () => {
    const { id, caller } = seedAdmin();
    const other = await caller.staff.create({ username: 'yusuf', role: 'admin', tempPassword: PW });
    // `other` disables the seeded admin: allowed, two admins exist.
    await asUser('admin', other.id).staff.setStatus({ userId: id, status: 'disabled' });
    // Now `other` is the only ACTIVE admin — disabling them would lock everyone out.
    await expect(asUser('admin', id).staff.setStatus({ userId: other.id, status: 'disabled' })).rejects.toThrow(/only admin/i);
  });

  it('refuses disabling your own account', async () => {
    const { id, caller } = seedAdmin();
    await caller.staff.create({ username: 'yusuf', role: 'admin', tempPassword: PW });
    await expect(caller.staff.setStatus({ userId: id, status: 'disabled' })).rejects.toThrow(/your own account/i);
  });
});

describe('parent accounts are out of reach from the staff screen', () => {
  it('refuses setRole, setStatus and resetPassword on a guardian’s portal account', async () => {
    const { caller } = seedAdmin();
    const fam = await caller.people.familyCreate({ name: 'Ismail' });
    const g = await caller.people.guardianCreate({ familyId: fam.id, name: 'Abu Yusuf', email: 'abu@test.org' });
    // Mint the parent user + guardian link the way invite-accept does.
    const ts = new Date();
    const { db } = app.dbmod;
    db.insert(users).values({ id: 'usr_parent', username: 'abu@test.org', passwordHash: 'x', role: 'parent', status: 'active', displayName: 'Abu', mustChangePassword: false, createdAt: ts, updatedAt: ts }).run();
    db.insert(guardianUsers).values({ guardianId: g.id, userId: 'usr_parent', createdAt: ts }).run();

    await expect(caller.staff.setRole({ userId: 'usr_parent', role: 'admin' })).rejects.toThrow(/parent/i);
    await expect(caller.staff.setStatus({ userId: 'usr_parent', status: 'disabled' })).rejects.toThrow(/parent/i);
    await expect(caller.staff.resetPassword({ userId: 'usr_parent', tempPassword: PW })).rejects.toThrow(/parent/i);
    // And they never appear in the staff list.
    expect((await caller.staff.list()).some((u) => u.id === 'usr_parent')).toBe(false);
  });
});

describe('role walls still hold', () => {
  it('finance cannot manage staff', async () => {
    seedAdmin();
    const finance = asUser('finance', 'usr_fin');
    await expect(finance.staff.list()).rejects.toThrow();
    await expect(finance.staff.setRole({ userId: 'usr_admin1', role: 'finance' })).rejects.toThrow();
  });

  it('an admin session presented over the tunnel is refused (origin policy)', async () => {
    seedAdmin();
    const overTunnel = app.appRouter.createCaller(
      makeCtx({ origin: 'tunnel', session: { role: 'admin', source: 'local', username: 'admin', userId: 'usr_admin1' } }).ctx,
    );
    await expect(overTunnel.staff.setRole({ userId: 'usr_x', role: 'finance' })).rejects.toThrow();
  });
});

/**
 * A PASSWORD RESET SIGNS THAT ACCOUNT OUT (§12, §14).
 *
 * `staff.resetPassword` was the only one of the three password-writing paths that did not revoke:
 * `auth.changePassword` deletes the account's other sessions and `auth.resetConfirm` signs it out
 * everywhere, while this wrote the new hash and stopped. Nothing else evicted it either — `getSession`
 * re-checks the account's status and live role per request but never the password — so a cookie held by
 * whoever the admin was locking out kept full API authority for the rest of its 12-hour life.
 * `mustChangePassword` is not a substitute: it steers the honest user's browser and gates nothing.
 */
describe('resetting a password revokes that account', () => {
  it('signs the target out everywhere', async () => {
    const { caller } = seedAdmin();
    const target = await caller.staff.create({ username: 'fatima', role: 'finance', tempPassword: PW });
    const { token } = app.sessionsMod.createSession({ userId: target.id, role: 'finance', source: 'local', username: 'fatima' });
    expect(app.sessionsMod.getSession(token)).not.toBeNull(); // control: it was live to begin with

    await caller.staff.resetPassword({ userId: target.id, tempPassword: 'another-long-temp-password' });
    expect(app.sessionsMod.getSession(token)).toBeNull();
  });

  it('does not sign OTHER accounts out', async () => {
    const { caller } = seedAdmin();
    const a = await caller.staff.create({ username: 'fatima', role: 'finance', tempPassword: PW });
    const b = await caller.staff.create({ username: 'yusuf', role: 'finance', tempPassword: PW });
    const other = app.sessionsMod.createSession({ userId: b.id, role: 'finance', source: 'local', username: 'yusuf' }).token;

    await caller.staff.resetPassword({ userId: a.id, tempPassword: 'another-long-temp-password' });
    expect(app.sessionsMod.getSession(other)).not.toBeNull();
  });

  /**
   * Unlike `setRole` and `setStatus`, this procedure has no self guard and the UI offers it on every row
   * including the caller's own — so an unconditional delete would log an admin out of the tab they are
   * standing in. Same `keep` reasoning as `auth.changePassword`.
   */
  it("spares the admin's own cookie when they reset their own password", async () => {
    const { id } = seedAdmin();
    const { token } = app.sessionsMod.createSession({ userId: id, role: 'admin', source: 'local', username: 'admin' });
    const self = app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role: 'admin', source: 'local', username: 'admin', userId: id }, token }).ctx);

    await self.staff.resetPassword({ userId: id, tempPassword: 'another-long-temp-password' });
    expect(app.sessionsMod.getSession(token)).not.toBeNull();
  });
});
