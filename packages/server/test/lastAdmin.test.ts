// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * May the last local admin be removed, when the platform can still let one in? (0.48.0)
 *
 * The rule protects against one thing: nobody able to reach the admin screens again. Admin sign-in is
 * LAN-only (§12.4), so on a STANDALONE install there genuinely is no way back and refusing is right —
 * `staffRoles.test.ts` covers that side, and runs without the Fabric.
 *
 * Installed through OpenMasjidOS there is always another door: the platform's own admin opens the app
 * from its dashboard on the masjid network and the SSO fast-path mints an admin session with no app
 * account involved at all (§12). There the rule protects nothing — it only stops an admin tidying up a
 * staff account they no longer want, which is what was reported.
 *
 * ONE APP PER FILE, deliberately. `fabricConfigured()` is derived from the environment and read through
 * the `config` module, which is a single instance per test file — so booting a fabric app and a
 * standalone app in the same file gives BOTH of them whichever answer was captured first. The first
 * version of this file did exactly that and its standalone case passed for the wrong reason.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshApp, makeCtx } from './harness';
import { users } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;

beforeAll(async () => {
  app = await freshApp({ fabric: true });
});
beforeEach(() => {
  app.dbmod.db.delete(users).run();
});

const as = (role: Role, userId: string) =>
  app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId } }).ctx);

/** Two admins, so the second can do the asking — nobody may change their own role (a separate rule). */
function twoAdmins() {
  const ts = new Date();
  for (const [id, username] of [['usr_founder', 'founder'], ['usr_asker', 'asker']]) {
    app.dbmod.db
      .insert(users)
      .values({ id, username, passwordHash: 'x', role: 'admin', status: 'active', displayName: username, mustChangePassword: false, createdAt: ts, updatedAt: ts })
      .run();
  }
  return { founder: 'usr_founder', asker: 'usr_asker' };
}

const roleOf = (id: string) => app.dbmod.db.select().from(users).where(eq(users.id, id)).get()!.role;
const statusOf = (id: string) => app.dbmod.db.select().from(users).where(eq(users.id, id)).get()!.status;

describe('with OpenMasjidOS behind it', () => {
  it('lets the last local admin be demoted — the platform can still sign one in', async () => {
    const { founder, asker } = twoAdmins();
    // Demote the asker first, so the founder really is the only admin left.
    await as('admin', founder).staff.setRole({ userId: asker, role: 'finance' });
    expect(roleOf(asker)).toBe('finance');

    // On a standalone install this is the refusal. Here it is allowed, because an admin can always come
    // in through the dashboard on the masjid network.
    await as('admin', asker).staff.setRole({ userId: founder, role: 'finance' });
    expect(roleOf(founder)).toBe('finance');
  });

  it('lets the last local admin be disabled', async () => {
    const { founder, asker } = twoAdmins();
    await as('admin', founder).staff.setRole({ userId: asker, role: 'finance' });
    await as('admin', asker).staff.setStatus({ userId: founder, status: 'disabled' });
    expect(statusOf(founder)).toBe('disabled');
  });

  /** The rules that are NOT about a lockout still stand — this change loosened one guard, not all of them. */
  it('still refuses to let somebody change their own role', async () => {
    const { founder } = twoAdmins();
    await expect(as('admin', founder).staff.setRole({ userId: founder, role: 'finance' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(roleOf(founder)).toBe('admin');
  });
});
