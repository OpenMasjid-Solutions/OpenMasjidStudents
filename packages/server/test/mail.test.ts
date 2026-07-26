// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Recipients + graceful degradation.
 *
 * This app has NO mail transport of its own: OpenMasjidOS owns the provider and the From address, so
 * there is no SMTP config to round-trip and no password for it to keep secret. What matters here is
 * that guardian emails resolve for a family, and that with no platform wired up every sender no-ops
 * safely and says WHY — a standalone install is a supported mode where invites become copy/print
 * links, not a broken one (§6). The platform send path itself is covered in platformMail.test.ts.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { guardians, guardianFamilies, families, students, settings, auditLog, invites, studentFees, feePlans } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let notify: typeof import('../src/mail/notify');
let recips: typeof import('../src/mail/recipients');
const caller = (role: Role) => app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp();
  notify = await import('../src/mail/notify');
  recips = await import('../src/mail/recipients');
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [invites, guardianFamilies, guardians, studentFees, feePlans, students, families, settings, auditLog]) db.delete(t).run();
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
    // No Fabric in this harness → there is no transport at all.
    expect(notify.mailAvailable()).toBe(false);
    expect(await notify.sendReceipt(fam.id, '$50.00')).toBe(0);
    expect(await notify.sendAutopayFailure(fam.id, true)).toBe(0);
    // An absolute URL is supplied here, so the ONLY thing missing is a transport.
    expect(await notify.sendInvite('a@test.org', 'https://x/family/invite?token=t', 'A')).toEqual({ sent: false, skipped: 'no_transport' });
  });

  it('reports the TRANSPORT as missing before the URL, since that is the one an admin acts on first', async () => {
    // Nothing is configured in this harness: no platform, no public URL. Both are missing, and the
    // order matters — "no email set up" is actionable; "no public address" follows from it.
    expect(notify.mailAvailable()).toBe(false);
    expect(await notify.sendInvite('a@test.org', '/family/invite?token=t', 'A')).toEqual({ sent: false, skipped: 'no_transport' });
    expect(await notify.sendReset('a@test.org', '/family/reset?token=t')).toEqual({ sent: false, skipped: 'no_transport' });
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
