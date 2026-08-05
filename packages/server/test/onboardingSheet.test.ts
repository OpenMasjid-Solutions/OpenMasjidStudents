// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The printable household onboarding sheet — the figures on it, the promises it makes, its shape on
 * paper, and its access wall.
 *
 * Four things are worth testing here and none of them is the styling:
 *
 *  1. IT IS ONE SHEET FOR THE HOUSEHOLD. Every child appears, the guardians and the payment routes
 *     appear ONCE, and the totals are the household's. That is the whole point of the redesign: a sheet
 *     per child repeated 60% of itself and never showed what the family actually owed.
 *  2. THE MONEY. A per-student override is how a bursary or a sibling rate is expressed (§9), so
 *     printing the fee plan's list price would hand a family a figure the office never agreed with them
 *     — and they would believe the paper over the person. The monthly total must add up across children.
 *  3. THE PROMISES. It must not offer a route this install does not have: no card without Stripe, no
 *     kiosk or website when external payments are off, and no self-signup QR when that door is shut.
 *  4. THE WALL. It carries Student IDs, children's dates of birth and the household's phone numbers and
 *     emails, so it is admin/finance only, over real HTTP, with an admin session refused from the tunnel
 *     (§12.4). Driven through Fastify `inject` like statementRoute.test.ts.
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
  settingsMod.setSetting(settingsMod.SETTING_KEYS.externalPayments, '1');
  settingsMod.setSetting(settingsMod.SETTING_KEYS.selfRegistration, '1');
});

const ALL_ON = { card: true, external: true, selfRegister: true };
const TS = new Date('2026-01-15T00:00:00Z');
const NOW = new Date('2026-06-01T00:00:00Z');

/** A household with one course/class available to place children in. */
function household() {
  const { db } = app.dbmod;
  db.insert(families).values({ id: 'fam_1', name: 'Ismail family', status: 'active', createdAt: TS, updatedAt: TS }).run();
  db.insert(courses).values({ id: 'crs_1', name: 'Hifz', sortOrder: 0, status: 'active', createdAt: TS, updatedAt: TS }).run();
  db.insert(classes).values({ id: 'cls_1', courseId: 'crs_1', name: 'Group B', sortOrder: 0, status: 'active', createdAt: TS, updatedAt: TS }).run();
  return 'fam_1';
}

/** Add a child to the household. */
function child(id: string, fullName: string, opts: { dob?: string | null; code?: string | null; classId?: string | null; status?: 'active' | 'withdrawn' } = {}) {
  const { db } = app.dbmod;
  db.insert(students).values({
    id, familyId: 'fam_1', fullName,
    dob: opts.dob === undefined ? '2016-03-04' : opts.dob,
    status: opts.status ?? 'active',
    classId: opts.classId === undefined ? 'cls_1' : opts.classId,
    studentCode: opts.code === undefined ? `${fullName.slice(0, 3).toUpperCase()}1234` : opts.code,
    createdAt: TS, updatedAt: TS,
  }).run();
  return id;
}

/** Assign a plan to a child, optionally at an overridden amount. The plan is created on first use, so
 *  two children can share one plan — which is the case that matters, since that is how a sibling rate
 *  (an override on the shared plan) actually arises. */
function fee(planId: string, studentId: string, name: string, amountCents: number, cadence: 'monthly' | 'per_term' | 'one_time', override?: number, note?: string) {
  const { db } = app.dbmod;
  const exists = db.select({ id: feePlans.id }).from(feePlans).all().some((p) => p.id === planId);
  if (!exists) {
    db.insert(feePlans).values({ id: planId, name, amountCents, cadence, status: 'active', createdAt: TS, updatedAt: TS }).run();
  }
  db.insert(studentFees).values({
    id: `sf_${planId}_${studentId}`, studentId, feePlanId: planId,
    overrideAmountCents: override ?? null, note: note ?? null, createdAt: TS, updatedAt: TS,
  }).run();
}

function cookieFor(role: Role): string {
  const { token } = sessionsMod.createSession({ userId: null, role, source: 'sso', username: role });
  return `${sessionsMod.COOKIE}=${token}`;
}

const get = (id: string, opts: { cookie?: string; tunnel?: boolean } = {}) =>
  http.inject({
    method: 'GET',
    url: `/sheets/family/${id}`,
    headers: {
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.tunnel ? { 'cf-ray': 'test-ray' } : {}),
    },
  });

const html = (routes = ALL_ON) => sheet.buildFamilySheetHtml('fam_1', 'http://masjid.local', routes, NOW);

describe('one sheet for the household', () => {
  it('lists every child, with their own ID, DOB, class and balance', async () => {
    household();
    child('stu_1', 'Yusuf Ismail', { code: 'YUS1234' });
    child('stu_2', 'Maryam Ismail', { code: 'MAR5678', dob: '2018-07-20' });
    const d = sheet.collectFamilySheet('fam_1')!;
    expect(d.children.map((c) => c.fullName)).toEqual(['Maryam Ismail', 'Yusuf Ismail']);
    expect(d.children.map((c) => c.studentCode).sort()).toEqual(['MAR5678', 'YUS1234']);
    expect(d.children.every((c) => c.className === 'Hifz — Group B')).toBe(true);

    const out = (await html())!;
    expect(out).toContain('YUS1234');
    expect(out).toContain('MAR5678');
    expect(out).toContain('Yusuf Ismail');
    expect(out).toContain('Maryam Ismail');
  });

  it('names the children in the opening sentence, and pluralises', async () => {
    household();
    child('stu_1', 'Yusuf Ismail');
    expect((await html())!).toContain('<b>Yusuf is now on our system.</b>');

    child('stu_2', 'Maryam Ismail');
    child('stu_3', 'Bilal Ismail');
    const out = (await html())!;
    expect(out).toContain('Bilal, Maryam and Yusuf are now on our system.');
    expect(out).toContain('Your children');
  });

  it('prints the guardians, contacts, portal and payment routes ONCE, not once per child', async () => {
    household();
    child('stu_1', 'Yusuf Ismail');
    child('stu_2', 'Maryam Ismail');
    child('stu_3', 'Bilal Ismail');
    const { db } = app.dbmod;
    db.insert(guardians).values({ id: 'g_1', name: 'Ibrahim Ismail', phone: '555', email: 'i@x.test', createdAt: TS, updatedAt: TS }).run();
    db.insert(guardianFamilies).values({ guardianId: 'g_1', familyId: 'fam_1', relation: 'father', isEmergencyContact: true, createdAt: TS }).run();
    db.insert(emergencyContacts).values({ id: 'ec_1', familyId: 'fam_1', name: 'Khalid', phone: '556', relation: 'uncle', createdAt: TS, updatedAt: TS }).run();

    const out = (await html())!;
    const count = (needle: string) => out.split(needle).length - 1;
    expect(count('Ibrahim Ismail')).toBe(1);
    expect(count('Khalid')).toBe(1);
    expect(count('How to pay')).toBe(1);
    expect(count('Parent portal QR code')).toBe(1); // one QR for the household
    expect(count('Please check this sheet')).toBe(1);
  });

  it('includes a withdrawn child, whose unpaid bill is still owed', async () => {
    household();
    child('stu_1', 'Yusuf Ismail');
    child('stu_2', 'Maryam Ismail', { status: 'withdrawn' });
    const out = (await html())!;
    expect(out).toContain('Maryam Ismail');
    expect(out).toContain('(withdrawn)');
  });

  it('returns null for a household that does not exist', () => {
    expect(sheet.collectFamilySheet('fam_nope')).toBeNull();
  });

  it('renders a brand-new household with no children, fees or guardians yet', async () => {
    household();
    const out = (await html())!;
    expect(out).toContain('No children on this record yet.');
    expect(out).toContain('No fees assigned yet');
    expect(out).toContain('No parent or guardian details on file');
  });
});

describe('the money — what the family is told they owe', () => {
  it('prints the AGREED rate per child, not the plan price', async () => {
    household();
    child('stu_1', 'Yusuf Ismail');
    child('stu_2', 'Maryam Ismail');
    fee('fp_1', 'stu_1', 'Monthly tuition', 20000, 'monthly', 15000, 'sibling rate');
    fee('fp_1', 'stu_2', 'Monthly tuition', 20000, 'monthly'); // same plan, no override

    const d = sheet.collectFamilySheet('fam_1')!;
    const yusuf = d.children.find((c) => c.id === 'stu_1')!;
    const maryam = d.children.find((c) => c.id === 'stu_2')!;
    expect(yusuf.fees[0].effectiveCents).toBe(15000);
    expect(yusuf.fees[0].overridden).toBe(true);
    expect(maryam.fees[0].effectiveCents).toBe(20000);
    expect(maryam.fees[0].overridden).toBe(false);

    const out = (await html())!;
    expect(out).toContain('$150.00');
    expect(out).toContain('$200.00');
    expect(out).toContain('sibling rate');
    expect(out).toContain('agreed');
  });

  it('totals the monthly fees ACROSS the children', async () => {
    household();
    child('stu_1', 'Yusuf Ismail');
    child('stu_2', 'Maryam Ismail');
    fee('fp_1', 'stu_1', 'Monthly tuition', 20000, 'monthly', 15000);
    fee('fp_1', 'stu_2', 'Monthly tuition', 20000, 'monthly');
    fee('fp_2', 'stu_1', 'Books', 5000, 'one_time'); // must NOT be in the monthly total

    const d = sheet.collectFamilySheet('fam_1')!;
    expect(d.monthlyCents).toBe(35000);
    const out = (await html())!;
    expect(out).toContain('Every month, for the family');
    expect(out).toContain('$350.00');
  });

  it('leaves a withdrawn child out of the monthly commitment', () => {
    household();
    child('stu_1', 'Yusuf Ismail');
    child('stu_2', 'Maryam Ismail', { status: 'withdrawn' });
    fee('fp_1', 'stu_1', 'Monthly tuition', 20000, 'monthly');
    fee('fp_1', 'stu_2', 'Monthly tuition', 20000, 'monthly');
    expect(sheet.collectFamilySheet('fam_1')!.monthlyCents).toBe(20000);
  });

  it('shows the HOUSEHOLD balance, and the per-child split beside it', async () => {
    household();
    child('stu_1', 'Yusuf Ismail');
    child('stu_2', 'Maryam Ismail');
    const { db } = app.dbmod;
    db.insert(invoices).values({ id: 'inv_1', studentId: 'stu_1', label: 'Tuition — Feb', periodKey: '2026-02', dueDate: '2026-02-01', status: 'open', createdAt: TS, updatedAt: TS }).run();
    db.insert(invoiceItems).values({ id: 'iti_1', invoiceId: 'inv_1', description: 'Monthly tuition', amountCents: 15000, studentId: 'stu_1', createdAt: TS }).run();

    const d = sheet.collectFamilySheet('fam_1')!;
    expect(d.owedCents).toBe(15000);
    expect(d.children.find((c) => c.id === 'stu_1')!.owedCents).toBe(15000);
    expect(d.children.find((c) => c.id === 'stu_2')!.owedCents).toBe(0);

    const out = (await html())!;
    expect(out).toContain('Your balance right now:');
    expect(out).toContain('$150.00');
    expect(out).toContain('Bills still open');
    expect(out).toContain('Tuition — Feb');
  });

  it('says nothing is due when square, and reports credit as paid ahead', async () => {
    household();
    child('stu_1', 'Yusuf Ismail');
    expect((await html())!).toContain('Nothing due');

    const { db } = app.dbmod;
    db.insert(payments).values({ id: 'pay_1', studentId: 'stu_1', amountCents: 7500, channel: 'cash', occurredAt: TS, idempotencyKey: 'k1', createdAt: TS }).run();
    const out = (await html())!;
    expect(out).toContain('paid ahead');
    expect(out).toContain('$75.00');
  });
});

describe('it fits a double-sided letter sheet', () => {
  it('declares letter paper and breaks to side two exactly once', async () => {
    household();
    child('stu_1', 'Yusuf Ismail');
    const out = (await html())!;
    expect(out).toContain('@page { size: letter; margin: 0.5in; }');
    // One explicit break: the front is the children and money, the back is how to pay.
    expect(out.split('class="side2"').length - 1).toBe(1);
    expect(out).toContain('page-break-before: always');
  });

  it('puts the children and the fees on the front, and paying on the back', async () => {
    household();
    child('stu_1', 'Yusuf Ismail');
    fee('fp_1', 'stu_1', 'Monthly tuition', 20000, 'monthly');
    const out = (await html())!;
    const brk = out.indexOf('class="side2"');
    const front = out.slice(0, brk);
    const back = out.slice(brk);
    expect(front).toContain('Student ID');
    expect(front).toContain('Monthly tuition');
    expect(front).toContain('Your balance right now');
    expect(back).toContain('How to pay');
    expect(back).toContain('parent portal');
    expect(back).toContain('Please check this sheet');
  });
});

describe('it must not promise a payment route this install does not have', () => {
  it('offers card, website and kiosk when everything is configured', async () => {
    household();
    child('stu_1', 'Yusuf Ismail');
    const out = (await html(ALL_ON))!;
    expect(out).toContain('parent portal, by card');
    expect(out).toContain('masjid website');
    expect(out).toContain('kiosk in the masjid');
    expect(out).toContain('Apple Pay and Google Pay');
  });

  it('drops the kiosk and the website when external payments are off', async () => {
    household();
    child('stu_1', 'Yusuf Ismail');
    const out = (await html({ card: true, external: false, selfRegister: true }))!;
    expect(out).not.toContain('masjid website');
    expect(out).not.toContain('kiosk in the masjid');
    expect(out).not.toContain('Apple Pay');
    expect(out).toContain('parent portal, by card');
  });

  it('drops every card mention when there is no Stripe account behind it', async () => {
    household();
    child('stu_1', 'Yusuf Ismail');
    const out = (await html({ card: false, external: false, selfRegister: true }))!;
    expect(out).not.toContain('by card');
    expect(out).not.toContain('autopay');
  });

  it('always offers the office routes — they need no integration, only a person', async () => {
    household();
    child('stu_1', 'Yusuf Ismail');
    const out = (await html({ card: false, external: false, selfRegister: false }))!;
    expect(out).toContain('Cash, check, Zelle or bank transfer (ACH)');
    expect(out).toContain('through the office');
    expect(out).toContain('Ask for confirmation');
  });

  it('does not describe a payment history the family could never have had', async () => {
    household();
    child('stu_1', 'Yusuf Ismail');
    const out = (await html({ card: false, external: false, selfRegister: false }))!;
    expect(out).toContain('Every payment the office has recorded for you');
    expect(out).not.toContain('the kiosk or the masjid website');
  });

  it('points the QR at signup when self-registration is on, and says one account covers all', async () => {
    household();
    child('stu_1', 'Yusuf Ismail');
    const out = (await html(ALL_ON))!;
    expect(out).toContain('http://masjid.local/family/register');
    expect(out).toContain('Scan this to set up your account');
    expect(out).toContain('One account covers all of');
  });

  it('asks for an invite instead of printing a QR to a door that is shut', async () => {
    household();
    child('stu_1', 'Yusuf Ismail');
    const out = (await html({ card: true, external: true, selfRegister: false }))!;
    expect(out).not.toContain('/family/register');
    expect(out).toContain('Ask the office for a portal invite');
  });

  it('tells the family what the IDs are for, differently when nothing external is on', async () => {
    household();
    child('stu_1', 'Yusuf Ismail', { code: 'YUS1234' });
    expect((await html(ALL_ON))!).toContain('what you need to pay at the kiosk or on the masjid website');
    const off = (await html({ card: true, external: false, selfRegister: true }))!;
    expect(off).toContain('when the office enters it');
    expect(off).not.toContain('pay at the kiosk');
  });

  it('payRoutes() reads the two admin toggles rather than assuming them', () => {
    settingsMod.setSetting(settingsMod.SETTING_KEYS.externalPayments, '0');
    settingsMod.setSetting(settingsMod.SETTING_KEYS.selfRegistration, '0');
    const r = sheet.payRoutes();
    expect(r.external).toBe(false);
    expect(r.selfRegister).toBe(false);
  });
});

describe('ageFromDob', () => {
  it('computes whole years, and has not had the birthday yet this year', () => {
    expect(sheet.ageFromDob('2016-03-04', NOW)).toBe(10);
    expect(sheet.ageFromDob('2016-12-31', NOW)).toBe(9);
    expect(sheet.ageFromDob('2016-06-01', NOW)).toBe(10);
  });

  it('returns null rather than a wrong number for absent or malformed input', () => {
    expect(sheet.ageFromDob(null)).toBeNull();
    expect(sheet.ageFromDob('')).toBeNull();
    expect(sheet.ageFromDob('not-a-date')).toBeNull();
    expect(sheet.ageFromDob('04/03/2016')).toBeNull();
  });
});

describe('GET /sheets/family/:id — the access wall', () => {
  it('serves admin on the LAN and finance from either origin', async () => {
    household();
    child('stu_1', 'Yusuf Ismail');
    expect((await get('fam_1', { cookie: cookieFor('admin') })).statusCode).toBe(200);
    expect((await get('fam_1', { cookie: cookieFor('finance') })).statusCode).toBe(200);
    expect((await get('fam_1', { cookie: cookieFor('finance'), tunnel: true })).statusCode).toBe(200);
  });

  it('refuses an admin session presented over the tunnel (§12.4)', async () => {
    household();
    child('stu_1', 'Yusuf Ismail', { code: 'YUS1234' });
    const res = await get('fam_1', { cookie: cookieFor('admin'), tunnel: true });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('YUS1234');
    expect(res.body).not.toContain('2016-03-04'); // nor a child's DOB
  });

  it('refuses a parent, an unknown token, and no session at all', async () => {
    household();
    child('stu_1', 'Yusuf Ismail');
    expect((await get('fam_1', { cookie: cookieFor('parent') })).statusCode).toBe(403);
    expect((await get('fam_1')).statusCode).toBe(403);
    expect((await get('fam_1', { cookie: `${sessionsMod.COOKIE}=nope` })).statusCode).toBe(403);
  });

  it('404s an unknown household for an authorised caller', async () => {
    household();
    expect((await get('fam_nope', { cookie: cookieFor('finance') })).statusCode).toBe(404);
  });

  it('carries the same hardening headers as the statement route', async () => {
    household();
    child('stu_1', 'Yusuf Ismail');
    const res = await get('fam_1', { cookie: cookieFor('admin') });
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('img-src data:');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('escaping — the sheet renders user input as text', () => {
  it('escapes a hostile child name', async () => {
    household();
    child('stu_1', '<script>alert(1)</script> Ismail');
    const res = await get('fam_1', { cookie: cookieFor('admin') });
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;');
  });

  it('escapes a guardian name and a fee note', async () => {
    household();
    child('stu_1', 'Yusuf Ismail');
    fee('fp_1', 'stu_1', 'Tuition', 20000, 'monthly', 12000, '"><img src=x onerror=alert(1)>');
    const { db } = app.dbmod;
    db.insert(guardians).values({ id: 'g_1', name: '<b>Ibrahim</b>', phone: '555', email: 'i@x.test', createdAt: TS, updatedAt: TS }).run();
    db.insert(guardianFamilies).values({ guardianId: 'g_1', familyId: 'fam_1', relation: 'father', isEmergencyContact: true, createdAt: TS }).run();

    const res = await get('fam_1', { cookie: cookieFor('admin') });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('<img src=x onerror=alert(1)>');
    expect(res.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(res.body).not.toContain('<b>Ibrahim</b>');
    expect(res.body).toContain('&lt;b&gt;Ibrahim&lt;/b&gt;');
  });
});
