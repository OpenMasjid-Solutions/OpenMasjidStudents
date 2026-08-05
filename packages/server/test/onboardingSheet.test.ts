// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The printable student onboarding sheet — the numbers on it, the promises it makes, and its access
 * wall.
 *
 * Three things are worth testing here and they are not the layout:
 *
 *  1. THE MONEY. The sheet tells a family what they will be charged. A per-student override is how a
 *     bursary or a sibling rate is expressed (§9), so printing the fee plan's list price instead would
 *     hand a family a figure the office never agreed with them — and they would reasonably believe the
 *     paper over the person.
 *  2. THE PROMISES. It also tells them how to pay, and it must not offer a route this install does not
 *     have: no card without Stripe, no kiosk or website when the admin has switched external payments
 *     off, and no self-signup QR when that door is shut — a QR to a page that refuses you is worse
 *     than no QR, because the parent concludes they did something wrong.
 *  3. THE WALL. It carries a Student ID, a child's date of birth and the household's phone numbers and
 *     emails, so it is admin/finance only, over real HTTP, with an admin session refused from the
 *     tunnel (§12.4). Driven through Fastify `inject` like statementRoute.test.ts.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { freshApp } from './harness';
import {
  classes, courses, emergencyContacts, families, feePlans, guardianFamilies, guardians,
  invoiceItems, invoices, paymentAllocations, payments, sessions, studentFees, students, users,
} from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let http: FastifyInstance;
let sessionsMod: typeof import('../src/auth/sessions');
let settingsMod: typeof import('../src/settings');
let sheet: typeof import('../src/people/onboardingSheet');

beforeAll(async () => {
  app = await freshApp();
  sessionsMod = await import('../src/auth/sessions');
  settingsMod = await import('../src/settings');
  sheet = await import('../src/people/onboardingSheet');
  const { registerStatementRoutes } = await import('../src/billing/statementRoutes');
  http = Fastify();
  await http.register(fastifyCookie);
  registerStatementRoutes(http);
  await http.ready();
});

beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [
    paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans,
    guardianFamilies, guardians, emergencyContacts, students, classes, courses, families, sessions, users,
  ]) db.delete(t).run();
  // Both doors open by default, so a test that cares must say so.
  settingsMod.setSetting(settingsMod.SETTING_KEYS.externalPayments, '1');
  settingsMod.setSetting(settingsMod.SETTING_KEYS.selfRegistration, '1');
});

const ALL_ON = { card: true, external: true, selfRegister: true };

/** One household, one child, optionally in a class. */
function child(opts: { fullName?: string; dob?: string | null; code?: string | null } = {}) {
  const { db } = app.dbmod;
  const ts = new Date('2026-01-15T00:00:00Z');
  db.insert(families).values({ id: 'fam_1', name: 'Ismail family', status: 'active', createdAt: ts, updatedAt: ts }).run();
  db.insert(courses).values({ id: 'crs_1', name: 'Hifz', sortOrder: 0, status: 'active', createdAt: ts, updatedAt: ts }).run();
  db.insert(classes).values({ id: 'cls_1', courseId: 'crs_1', name: 'Group B', sortOrder: 0, status: 'active', createdAt: ts, updatedAt: ts }).run();
  db.insert(students).values({
    id: 'stu_1', familyId: 'fam_1', fullName: opts.fullName ?? 'Yusuf Ismail',
    dob: opts.dob === undefined ? '2016-03-04' : opts.dob,
    status: 'active', classId: 'cls_1',
    studentCode: opts.code === undefined ? 'YUS1234' : opts.code,
    createdAt: ts, updatedAt: ts,
  }).run();
  return 'stu_1';
}

/** Assign a plan to the student, optionally at an overridden amount. */
function fee(id: string, name: string, amountCents: number, cadence: 'monthly' | 'per_term' | 'one_time', override?: number, note?: string) {
  const { db } = app.dbmod;
  const ts = new Date();
  db.insert(feePlans).values({ id, name, amountCents, cadence, status: 'active', createdAt: ts, updatedAt: ts }).run();
  db.insert(studentFees).values({
    id: `sf_${id}`, studentId: 'stu_1', feePlanId: id,
    overrideAmountCents: override ?? null, note: note ?? null, createdAt: ts, updatedAt: ts,
  }).run();
}

function cookieFor(role: Role): string {
  const { token } = sessionsMod.createSession({ userId: null, role, source: 'sso', username: role });
  return `${sessionsMod.COOKIE}=${token}`;
}

const get = (id: string, opts: { cookie?: string; tunnel?: boolean } = {}) =>
  http.inject({
    method: 'GET',
    url: `/sheets/student/${id}`,
    headers: {
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.tunnel ? { 'cf-ray': 'test-ray' } : {}),
    },
  });

const html = (routes = ALL_ON) => sheet.buildStudentSheetHtml('stu_1', 'http://masjid.local', routes, new Date('2026-06-01T00:00:00Z'));

describe('what the office has on file', () => {
  it('collects the child, their class, and the household label', () => {
    child();
    const d = sheet.collectStudentSheet('stu_1')!;
    expect(d.student.fullName).toBe('Yusuf Ismail');
    expect(d.student.studentCode).toBe('YUS1234');
    expect(d.student.dob).toBe('2016-03-04');
    expect(d.className).toBe('Hifz — Group B'); // course + class, not the bare class name
    expect(d.familyLabel).toBe('Ismail family');
  });

  it('lists siblings but never the child themselves', () => {
    child();
    const { db } = app.dbmod;
    const ts = new Date();
    db.insert(students).values({ id: 'stu_2', familyId: 'fam_1', fullName: 'Maryam Ismail', status: 'active', studentCode: 'MAR5678', createdAt: ts, updatedAt: ts }).run();
    const d = sheet.collectStudentSheet('stu_1')!;
    expect(d.siblings.map((s) => s.fullName)).toEqual(['Maryam Ismail']);
  });

  it('returns null for a student that does not exist', () => {
    expect(sheet.collectStudentSheet('stu_nope')).toBeNull();
  });

  it('does not double-escape its own row labels', async () => {
    child();
    const { db } = app.dbmod;
    const ts = new Date();
    db.insert(students).values({ id: 'stu_2', familyId: 'fam_1', fullName: 'Maryam Ismail', status: 'active', studentCode: 'MAR5678', createdAt: ts, updatedAt: ts }).run();
    const out = (await html())!;
    // The label is escaped once by row(); a pre-escaped "&amp;" printed a literal &amp; on the page.
    expect(out).toContain('Brothers &amp; sisters here');
    expect(out).not.toContain('&amp;amp;');
  });

  it('renders with no DOB, no code, no fees and no guardians — a just-created record', async () => {
    child({ dob: null, code: null });
    const out = (await html())!;
    expect(out).toContain('Yusuf Ismail');
    expect(out).toContain('No fees assigned yet');
    expect(out).toContain('No parent or guardian details on file');
    expect(out).not.toContain('Date of birth'); // the row is omitted, not left blank
  });
});

describe('the fee figures — what the family is told they owe', () => {
  it('prints the AGREED rate, not the plan price, when a student has an override', async () => {
    child();
    fee('fp_1', 'Monthly tuition', 20000, 'monthly', 12000, 'bursary');
    const d = sheet.collectStudentSheet('stu_1')!;
    expect(d.fees[0].effectiveCents).toBe(12000);
    expect(d.fees[0].overridden).toBe(true);

    const out = (await html())!;
    expect(out).toContain('$120.00');
    expect(out).not.toContain('$200.00'); // the list price must not appear anywhere
    expect(out).toContain('agreed rate');
    expect(out).toContain('bursary');
  });

  it('uses the plan amount when there is no override, and does not label it', async () => {
    child();
    fee('fp_1', 'Monthly tuition', 20000, 'monthly');
    const d = sheet.collectStudentSheet('stu_1')!;
    expect(d.fees[0].effectiveCents).toBe(20000);
    expect(d.fees[0].overridden).toBe(false);
    expect((await html())!).not.toContain('agreed rate');
  });

  it('totals only the monthly fees — a term or one-off fee is not a monthly commitment', async () => {
    child();
    fee('fp_1', 'Monthly tuition', 20000, 'monthly');
    fee('fp_2', 'Books', 5000, 'one_time');
    fee('fp_3', 'Term levy', 9000, 'per_term');
    const out = (await html())!;
    expect(out).toContain('Total each month');
    expect(out).toContain('$200.00'); // the monthly total, not 200+50+90
    expect(out).not.toContain('$340.00');
  });

  it('omits the monthly total entirely when nothing is monthly', async () => {
    child();
    fee('fp_2', 'Books', 5000, 'one_time');
    expect((await html())!).not.toContain('Total each month');
  });

  it('lists the recurring fee before a one-off, whatever the names sort to', async () => {
    child();
    // Alphabetically "Books" precedes "Monthly tuition", which floated a one-time book fee above the
    // tuition and left the monthly total sitting under an unrelated row.
    fee('fp_2', 'Books', 5000, 'one_time');
    fee('fp_1', 'Monthly tuition', 20000, 'monthly');
    const d = sheet.collectStudentSheet('stu_1')!;
    expect(d.fees.map((f) => f.cadence)).toEqual(['monthly', 'one_time']);
    const out = (await html())!;
    expect(out.indexOf('Monthly tuition')).toBeLessThan(out.indexOf('Books'));
  });

  it('says nothing is due when the child is square, and shows credit as paid ahead', async () => {
    child();
    const { db } = app.dbmod;
    const ts = new Date();
    expect((await html())!).toContain('Nothing due');

    db.insert(payments).values({ id: 'pay_1', studentId: 'stu_1', amountCents: 7500, channel: 'cash', occurredAt: ts, idempotencyKey: 'k1', createdAt: ts }).run();
    const out = (await html())!;
    expect(out).toContain('paid ahead');
    expect(out).toContain('$75.00');
  });
});

describe('it must not promise a payment route this install does not have', () => {
  it('offers card, website and kiosk when everything is configured', async () => {
    child();
    const out = (await html(ALL_ON))!;
    expect(out).toContain('parent portal, by card');
    expect(out).toContain('masjid website');
    expect(out).toContain('kiosk in the masjid');
    expect(out).toContain('Apple Pay and Google Pay');
  });

  it('drops the kiosk and the website when external payments are switched off', async () => {
    child();
    const out = (await html({ card: true, external: false, selfRegister: true }))!;
    expect(out).not.toContain('masjid website');
    expect(out).not.toContain('kiosk in the masjid');
    expect(out).not.toContain('Apple Pay');
    expect(out).toContain('parent portal, by card'); // the portal is unaffected
  });

  it('drops every card mention when there is no Stripe account behind it', async () => {
    child();
    const out = (await html({ card: false, external: false, selfRegister: true }))!;
    expect(out).not.toContain('by card');
    expect(out).not.toContain('autopay');
    expect(out).not.toContain('Save a card');
  });

  it('does not describe a payment history the family could never have had', async () => {
    child();
    const out = (await html({ card: false, external: false, selfRegister: false }))!;
    // The portal-benefits list used to enumerate card/kiosk/website unconditionally.
    expect(out).toContain('Every payment the office has recorded for you');
    expect(out).not.toContain('the kiosk or the masjid website');
    const partial = (await html({ card: true, external: false, selfRegister: true }))!;
    expect(partial).toContain('cash or card');
    expect(partial).not.toContain('kiosk');
  });

  it('always offers the office routes — they need no integration, only a person', async () => {
    child();
    const out = (await html({ card: false, external: false, selfRegister: false }))!;
    expect(out).toContain('Cash, check, Zelle or bank transfer (ACH)');
    expect(out).toContain('through the office');
    expect(out).toContain('Ask for confirmation');
  });

  it('points the QR at signup when self-registration is on', async () => {
    child();
    const out = (await html(ALL_ON))!;
    expect(out).toContain('http://masjid.local/family/register');
    expect(out).toContain('Scan this to set up your account');
  });

  it('asks for an invite instead of printing a QR to a door that is shut', async () => {
    child();
    const out = (await html({ card: true, external: true, selfRegister: false }))!;
    expect(out).not.toContain('/family/register');
    expect(out).toContain('Ask the office for a portal invite');
  });

  it('payRoutes() reads the two admin toggles rather than assuming them', () => {
    settingsMod.setSetting(settingsMod.SETTING_KEYS.externalPayments, '0');
    settingsMod.setSetting(settingsMod.SETTING_KEYS.selfRegistration, '0');
    const r = sheet.payRoutes();
    expect(r.external).toBe(false);
    expect(r.selfRegister).toBe(false);
  });
});

describe('the sheet says what it is for', () => {
  it('tells the family to check it and report anything wrong', async () => {
    child();
    const out = (await html())!;
    expect(out).toContain('is now on our system');
    expect(out).toContain('Please check this sheet');
    // Tolerant of source line wrapping — the instruction is what matters, not where it breaks.
    expect(out).toMatch(/tell the\s+office/);
  });

  it('prints the Student ID prominently and explains what it is for', async () => {
    child();
    const out = (await html())!;
    expect(out).toContain('YUS1234');
    expect(out).toContain('Student ID');
    expect(out).toContain('how a payment finds your child');
  });

  it('explains why the portal is worth having', async () => {
    child();
    const out = (await html())!;
    expect(out).toContain('what the household owes altogether');
    expect(out).toContain('line by line');
  });
});

describe('ageFromDob', () => {
  it('computes whole years, and has not had the birthday yet this year', () => {
    expect(sheet.ageFromDob('2016-03-04', new Date('2026-06-01T00:00:00Z'))).toBe(10);
    expect(sheet.ageFromDob('2016-12-31', new Date('2026-06-01T00:00:00Z'))).toBe(9);
    expect(sheet.ageFromDob('2016-06-01', new Date('2026-06-01T00:00:00Z'))).toBe(10);
  });

  it('returns null rather than a wrong number for absent or malformed input', () => {
    expect(sheet.ageFromDob(null)).toBeNull();
    expect(sheet.ageFromDob('')).toBeNull();
    expect(sheet.ageFromDob('not-a-date')).toBeNull();
    expect(sheet.ageFromDob('04/03/2016')).toBeNull();
  });
});

describe('GET /sheets/student/:id — the access wall', () => {
  it('serves admin on the LAN and finance from either origin', async () => {
    child();
    expect((await get('stu_1', { cookie: cookieFor('admin') })).statusCode).toBe(200);
    expect((await get('stu_1', { cookie: cookieFor('finance') })).statusCode).toBe(200);
    expect((await get('stu_1', { cookie: cookieFor('finance'), tunnel: true })).statusCode).toBe(200);
  });

  it('refuses an admin session presented over the tunnel (§12.4)', async () => {
    child();
    const res = await get('stu_1', { cookie: cookieFor('admin'), tunnel: true });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('YUS1234');
    expect(res.body).not.toContain('2016-03-04'); // nor the child's DOB
  });

  it('refuses a parent, an unknown token, and no session at all', async () => {
    child();
    expect((await get('stu_1', { cookie: cookieFor('parent') })).statusCode).toBe(403);
    expect((await get('stu_1')).statusCode).toBe(403);
    expect((await get('stu_1', { cookie: `${sessionsMod.COOKIE}=nope` })).statusCode).toBe(403);
  });

  it('404s an unknown student for an authorised caller', async () => {
    child();
    expect((await get('stu_nope', { cookie: cookieFor('finance') })).statusCode).toBe(404);
  });

  it('carries the same hardening headers as the statement route', async () => {
    child();
    const res = await get('stu_1', { cookie: cookieFor('admin') });
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('img-src data:'); // the QR must still render
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('escaping — the sheet renders user input as text', () => {
  it('escapes a hostile student name', async () => {
    child({ fullName: '<script>alert(1)</script> Ismail' });
    const res = await get('stu_1', { cookie: cookieFor('admin') });
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;');
  });

  it('escapes a guardian name and a fee note, both typed by staff', async () => {
    child();
    fee('fp_1', 'Tuition', 20000, 'monthly', 12000, '"><img src=x onerror=alert(1)>');
    const { db } = app.dbmod;
    const ts = new Date();
    db.insert(guardians).values({ id: 'g_1', name: '<b>Ibrahim</b>', phone: '555', email: 'i@x.test', createdAt: ts, updatedAt: ts }).run();
    db.insert(guardianFamilies).values({ guardianId: 'g_1', familyId: 'fam_1', relation: 'father', isEmergencyContact: true, createdAt: ts }).run();

    const res = await get('stu_1', { cookie: cookieFor('admin') });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('<img src=x onerror=alert(1)>');
    expect(res.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(res.body).not.toContain('<b>Ibrahim</b>');
    expect(res.body).toContain('&lt;b&gt;Ibrahim&lt;/b&gt;');
  });
});
