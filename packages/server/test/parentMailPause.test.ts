// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The master stop on parent email (0.48.0).
 *
 * Its whole purpose is a mistake nobody can take back: an office setting the app up with their REAL
 * roster in it, trying an import, a payment, an autopay run — every one of those paths emails somebody.
 *
 * So the tests are about what must NOT go out, and the two things that make the switch trustworthy:
 *  - it overrides even the always-send messages (invites, password resets), which are deliberately
 *    exempt from every OTHER parent-email switch;
 *  - it does not touch STAFF mail — an admin's own password reset, the office's alerts and the test
 *    send all still work, or an install that paused parent mail would have locked itself out.
 * And it must be VISIBLE: a paused send reports `parents_paused`, so the office is told rather than
 * left with mail that appears broken.
 *
 * Asserted at the TRANSPORT (the one `fetch` to the platform's email endpoint), not by trusting a
 * return value — if an address reaches that call, a real parent got mail. Same stub as
 * platformMail.test.ts, and `freshApp({ fabric: true })` for the same reason: without it
 * `mailAvailable()` is false and every sender bails for the wrong reason, proving nothing.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { auditLog, families, guardians, guardianFamilies, guardianUsers, students, sessions, users } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let notify: typeof import('../src/mail/notify');
let recipients: typeof import('../src/mail/recipients');
let settings: typeof import('../src/settings');

/** Every address the app actually tried to write to, in order. */
let sent: string[] = [];
const realFetch = globalThis.fetch;

const caller = (role: Role) =>
  app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  // publicUrl as well as fabric: an invite and a reset deliberately refuse to send without an
  // ABSOLUTE off-network link, so without one they would come back 'no_public_url' and the pause
  // assertions below would pass for the wrong reason.
  app = await freshApp({ fabric: true, publicUrl: 'https://masjid.test/students' });
  notify = await import('../src/mail/notify');
  recipients = await import('../src/mail/recipients');
  settings = await import('../src/settings');
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [guardianUsers, guardianFamilies, guardians, students, families, sessions, users, auditLog]) db.delete(t).run();
  settings.setParentMailPaused(false);
  sent = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: unknown) => {
    const url = String(input);
    const body = ((init ?? {}) as { body?: string }).body;
    if (url.endsWith('/api/fabric/email') && body) sent.push((JSON.parse(body) as { to: string }).to);
    // An invite needs an absolute public URL as well as a transport, so `site` has to answer too.
    const json = url.endsWith('/api/fabric/site')
      ? { enabled: true, domain: 'masjid.test', publicUrl: 'https://masjid.test/students', basePath: '/students' }
      : { sent: true };
    return { ok: true, status: 200, json: async () => json } as unknown as Response;
  }) as unknown as typeof fetch;
});

/** A household with one child and one guardian who has an email. */
function household(email = 'parent@example.org') {
  const { db } = app.dbmod;
  const ts = new Date();
  db.insert(families).values({ id: 'fam_1', name: 'Ismail family', status: 'active', createdAt: ts, updatedAt: ts }).run();
  db.insert(students).values({ id: 'stu_1', familyId: 'fam_1', fullName: 'Yusuf Ismail', status: 'active', studentCode: 'YUS1234', createdAt: ts, updatedAt: ts }).run();
  db.insert(guardians).values({ id: 'grd_1', name: 'Abu Yusuf', email, phone: null, createdAt: ts, updatedAt: ts }).run();
  db.insert(guardianFamilies).values({ guardianId: 'grd_1', familyId: 'fam_1', relation: 'father', isEmergencyContact: false, createdAt: ts }).run();
  return { familyId: 'fam_1', email };
}

describe('while parent mail is paused', () => {
  it('sends no receipt and no autopay notice', async () => {
    const h = household();
    // Unpaused first, to prove the fixture can actually send — otherwise a pass proves nothing.
    expect(await notify.sendReceipt(h.familyId, '$350.00')).toBe(1);
    expect(sent).toEqual([h.email]);

    sent = [];
    settings.setParentMailPaused(true);
    expect(await notify.sendReceipt(h.familyId, '$350.00')).toBe(0);
    expect(await notify.sendAutopayFailure(h.familyId, false)).toBe(0);
    expect(sent).toEqual([]);
  });

  /** The switches in `ParentEmailPrefs` deliberately do NOT cover these two. This one has to. */
  it('holds an invite and a parent’s password reset — the always-send ones', async () => {
    // Again, proof the fixture sends when it should.
    expect(await notify.sendInvite('parent@example.org', 'https://masjid.test/invite', 'Abu Yusuf')).toMatchObject({ sent: true });
    expect(sent).toEqual(['parent@example.org']);

    sent = [];
    settings.setParentMailPaused(true);
    expect(await notify.sendInvite('parent@example.org', 'https://masjid.test/invite', 'Abu Yusuf')).toEqual({ sent: false, skipped: 'parents_paused' });
    expect(await notify.sendReset('parent@example.org', 'https://masjid.test/reset', 'parent')).toEqual({ sent: false, skipped: 'parents_paused' });
    expect(sent).toEqual([]);
  });

  it('leaves a family with no reachable addresses at all', () => {
    const h = household();
    expect(recipients.guardianEmailsForFamily(h.familyId)).toEqual([h.email]);
    settings.setParentMailPaused(true);
    // The second line of defense: whatever a future parent-facing message reaches for, there is nobody
    // to write to. This function is only ever used to send.
    expect(recipients.guardianEmailsForFamily(h.familyId)).toEqual([]);
  });

  it('still hands the office a link, so an invite is held rather than lost', async () => {
    const h = household();
    const admin = caller('admin');
    settings.setParentMailPaused(true);
    const r = await admin.auth.inviteCreate({ guardianId: 'grd_1' });
    expect(r.emailed).toBe(false);
    expect(r.mailSkipped).toBe('parents_paused');
    // The link is the point: the office prints or reads it out, and the invite still works.
    expect(r.url).toContain('/invite');
    expect(sent).toEqual([]);
    expect(h.familyId).toBe('fam_1');
  });
});

describe('what the pause must NOT touch', () => {
  it('still sends a staff alert — the office has to hear about a locked ID or a failed autopay', async () => {
    settings.setParentMailPaused(true);
    expect(await notify.sendAlert('office@example.org', 'Autopay switched off', 'body')).toBe(true);
    expect(sent).toEqual(['office@example.org']);
  });

  it('still sends the admin’s own test email — it is how they check mail works at all', async () => {
    settings.setParentMailPaused(true);
    expect(await notify.sendTestEmail('admin@example.org')).toBe(true);
    expect(sent).toEqual(['admin@example.org']);
  });

  /** The public reset door serves staff AND parents through one procedure, so the audience is taken
   *  from the account. Pausing parent mail must never stop an admin resetting their own password —
   *  that would be an install locking itself out. */
  it('still sends a STAFF password reset', async () => {
    settings.setParentMailPaused(true);
    expect(await notify.sendReset('admin@example.org', 'https://masjid.test/reset', 'staff')).toMatchObject({ sent: true });
    expect(sent).toEqual(['admin@example.org']);
  });
});

describe('the setting itself', () => {
  it('is off by default, so an install in service behaves as it always has', () => {
    expect(settings.getParentMailPaused()).toBe(false);
  });

  it('is admin-only to change, and audited both ways', async () => {
    const admin = caller('admin');
    await expect(caller('finance').settings.parentMailPauseSet({ paused: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await admin.settings.parentMailPauseSet({ paused: true });
    expect((await admin.settings.alertsGet()).parentMailPaused).toBe(true);
    await admin.settings.parentMailPauseSet({ paused: false });
    expect((await admin.settings.alertsGet()).parentMailPaused).toBe(false);

    // Turning it back ON is the change somebody will want a record of, so both directions are logged.
    const entries = app.dbmod.db.select().from(auditLog).all().filter((e) => e.action === 'settings.parentMailPause');
    expect(entries.map((e) => (e.detail as { paused: boolean }).paused)).toEqual([true, false]);
  });
});
