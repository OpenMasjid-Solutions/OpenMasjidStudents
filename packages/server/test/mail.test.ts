// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * SMTP settings + recipients + graceful degradation (CLAUDE.md §4/§10). The actual send needs a real
 * mail server (integration), so here we verify: the config round-trips, the admin API keeps the
 * password WRITE-ONLY (never returned; merged when omitted), guardian emails resolve for a family,
 * and every sender no-ops safely when SMTP is off.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { guardians, guardianFamilies, families, students, settings, auditLog, invites, studentFees, feePlans } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let settingsMod: typeof import('../src/settings');
let smtp: typeof import('../src/mail/smtp');
let notify: typeof import('../src/mail/notify');
let recips: typeof import('../src/mail/recipients');
const caller = (role: Role) => app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp();
  settingsMod = await import('../src/settings');
  smtp = await import('../src/mail/smtp');
  notify = await import('../src/mail/notify');
  recips = await import('../src/mail/recipients');
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [invites, guardianFamilies, guardians, studentFees, feePlans, students, families, settings, auditLog]) db.delete(t).run();
});

describe('SMTP config round-trip', () => {
  it('is null by default; stores + reads back; smtpConfigured tracks it', () => {
    expect(settingsMod.getSmtp()).toBeNull();
    expect(smtp.smtpConfigured()).toBe(false);
    settingsMod.setSmtp({ host: 'smtp.test', port: 587, secure: false, user: 'u', pass: 'secret', from: 'S <o@test.org>' });
    expect(smtp.smtpConfigured()).toBe(true);
    expect(settingsMod.getSmtp()).toMatchObject({ host: 'smtp.test', port: 587, secure: false, user: 'u', pass: 'secret', from: 'S <o@test.org>' });
  });
});

describe('settings router — SMTP password is write-only', () => {
  it('smtpGet never returns the password; smtpSet merges it when omitted', async () => {
    const admin = caller('admin');
    await admin.settings.smtpSet({ host: 'smtp.test', port: 587, secure: false, user: 'u', from: 'S <o@test.org>', password: 'secret' });
    const got = await admin.settings.smtpGet();
    expect(got).toMatchObject({ configured: true, host: 'smtp.test', hasPassword: true });
    expect(got).not.toHaveProperty('password');
    expect(got).not.toHaveProperty('pass');
    // Change host WITHOUT re-sending the password → the stored password is retained.
    await admin.settings.smtpSet({ host: 'smtp2.test', port: 465, secure: true, user: 'u', from: 'S <o@test.org>' });
    expect(settingsMod.getSmtp()).toMatchObject({ host: 'smtp2.test', port: 465, secure: true, pass: 'secret' });
  });

  it('is admin-only (finance/teacher/parent refused)', async () => {
    for (const r of ['finance', 'parent'] as Role[]) {
      await expect(caller(r).settings.smtpGet()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await expect(caller('admin').settings.smtpGet()).resolves.toBeTruthy();
    // admin over the tunnel is blocked (origin policy)
    const tunnelAdmin = app.appRouter.createCaller(makeCtx({ origin: 'tunnel', session: { role: 'admin', source: 'local', username: 'admin', userId: 'usr_admin' } }).ctx);
    await expect(tunnelAdmin.settings.smtpGet()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('guardianEmailsForFamily', () => {
  it('returns valid guardian emails, deduped; skips guardians with no/invalid email', async () => {
    const admin = caller('admin');
    const fam = await admin.people.familyCreate({ name: 'Ismail' });
    await admin.people.guardianCreate({ familyId: fam.id, name: 'A', email: 'a@test.org' });
    await admin.people.guardianCreate({ familyId: fam.id, name: 'B', email: 'b@test.org' });
    // A guardian with no email on file (direct insert) must be skipped.
    const { db } = app.dbmod;
    const ts = new Date();
    db.insert(guardians).values({ id: 'grd_none', name: 'C', phone: null, email: null, createdAt: ts, updatedAt: ts }).run();
    db.insert(guardianFamilies).values({ guardianId: 'grd_none', familyId: fam.id, relation: null, isEmergencyContact: false, createdAt: ts }).run();
    expect(recips.guardianEmailsForFamily(fam.id).sort()).toEqual(['a@test.org', 'b@test.org']);
    expect(recips.guardianEmailsForFamily('fam_missing')).toEqual([]);
  });
});

describe('senders degrade gracefully, and say WHY', () => {
  it('no-op with no transport at all, reporting no_transport rather than failing silently', async () => {
    const admin = caller('admin');
    const fam = await admin.people.familyCreate({ name: 'X' });
    await admin.people.guardianCreate({ familyId: fam.id, name: 'A', email: 'a@test.org' });
    // No SMTP and no Fabric in this harness → mailAvailable() is false.
    expect(notify.mailAvailable()).toBe(false);
    expect(await notify.sendReceipt(fam.id, '$50.00')).toBe(0);
    expect(await notify.sendAutopayFailure(fam.id, true)).toBe(0);
    // An absolute URL is supplied here, so the ONLY thing missing is a transport.
    expect(await notify.sendInvite('a@test.org', 'https://x/family/invite?token=t', 'A')).toEqual({ sent: false, skipped: 'no_transport' });
  });

  it('does not email an invite when there is no absolute base URL, reporting no_public_url', async () => {
    // SMTP configured, but the test env sets no OPENMASJID_PUBLIC_URL and there is no Fabric to ask
    // for a live one → portalBase() is '' → skip the send. Emailing a parent a relative or LAN-only
    // link is worse than not emailing: the office falls back to the copy/print link instead.
    settingsMod.setSmtp({ host: 'smtp.test', port: 587, secure: false, user: 'u', pass: 'p', from: 'S <o@test.org>' });
    expect(smtp.smtpConfigured()).toBe(true);
    expect(notify.mailAvailable()).toBe(true); // a transport EXISTS — the URL is what's missing
    expect(await notify.sendInvite('a@test.org', '/family/invite?token=t', 'A')).toEqual({ sent: false, skipped: 'no_public_url' });
    expect(await notify.sendReset('a@test.org', '/family/reset?token=t')).toEqual({ sent: false, skipped: 'no_public_url' });
  });

  it('records WHY an invite was not emailed, so a suppressed send leaves a trail', async () => {
    const admin = caller('admin');
    const fam = await admin.people.familyCreate({ name: 'Ismail' });
    const g = await admin.people.guardianCreate({ familyId: fam.id, name: 'Abu Yusuf', email: 'abu@test.org' });
    const r = await admin.auth.inviteCreate({ guardianId: g.id });
    // The invite itself still works — the office copies the link.
    expect(r.url).toContain('/family/invite?token=');
    expect(r.emailed).toBe(false);
    expect(r.mailSkipped).toBeTruthy();
    const entry = app.dbmod.db.select().from(auditLog).all().find((e) => e.action === 'invite.mail')!;
    expect(entry).toBeTruthy();
    expect(JSON.stringify(entry.detail)).toContain('"emailed":false');
    expect(JSON.stringify(entry.detail)).toContain(String(r.mailSkipped));
  });
});
