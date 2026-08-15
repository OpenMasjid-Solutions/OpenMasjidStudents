// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * WhatsApp (0.50.0).
 *
 * Every test here is about something that fails SILENTLY and expensively if it is wrong, because that
 * is the shape of this whole feature: a message either goes to the right phone or it goes to a
 * stranger, and nothing in between reports itself.
 *
 *  - **`toE164`.** A number typed by an office over ten years, turned into one wire format. Get the
 *    trunk zero wrong and every UK number is dead; get the country-code detection wrong and a
 *    ten-digit US number becomes somebody else's phone. Both are pure functions and both are tested
 *    against the real strings an office types.
 *  - **The gates, in order.** Off, no gateway, event off, paused, opted out, unreadable — six ways a
 *    message should not go out, and the pause has an exception (the test student) that must work and
 *    must not leak to anybody else.
 *  - **The opt-out is absolute.** Not overridden by the pause exception, and not by an office pressing
 *    a button. A person said no.
 *  - **Nothing auth-critical goes by WhatsApp.** An invite or a reset must never touch this channel:
 *    the number can be banned overnight and the day it is must not be the day nobody can sign in.
 *  - **The body is never stored.** The log is an audit trail, not a copy of what was said.
 *
 * `fetch` is stubbed, so nothing leaves the machine; the assertions are on the requests we build.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { freshApp, makeCtx } from './harness';
import { alertRecipients, guardians, guardianFamilies, families, students, settings, auditLog, studentFees, feePlans, payments, paymentAllocations, invoiceItems, invoices, whatsappLog, users } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let whatsapp: typeof import('../src/whatsapp');
let numbers: typeof import('../src/whatsapp/numbers');
let notify: typeof import('../src/mail/notify');
let alerts: typeof import('../src/alerts');

const caller = (role: Role) => app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

interface Call {
  url: string;
  body: Record<string, unknown>;
}
let calls: Call[] = [];
/** What the platform's `GET /api/fabric/whatsapp` says. `ready` unless a test says otherwise. */
let waAvailable: { available: boolean; reason: string } = { available: true, reason: 'ready' };
/** The HTTP status the STATUS probe answers with. 200 unless a test is exercising a refusal. */
let statusHttp = 200;
/** The groups the platform says this app may post into. Only what an ADMIN approved ever appears. */
let groupList: { id: string; label: string }[] = [{ id: '1203630001@g.us', label: 'Parents' }];
/** The status the queue answers with. 202 is the real one; the others are the four documented refusals. */
let queueStatus = 202;
const realFetch = globalThis.fetch;

function installFetch(): void {
  globalThis.fetch = vi.fn(async (input: unknown, init?: unknown) => {
    const i = (init ?? {}) as { body?: string; method?: string };
    const url = String(input);
    calls.push({ url, body: i.body ? (JSON.parse(i.body) as Record<string, unknown>) : { _method: i.method ?? 'GET' } });
    if (url.endsWith('/api/fabric/whatsapp/groups')) return { ok: true, status: 200, json: async () => ({ groups: groupList }) } as unknown as Response;
    if (url.endsWith('/api/fabric/whatsapp')) {
      if ((i.method ?? 'GET') === 'GET') return { ok: statusHttp < 300, status: statusHttp, json: async () => waAvailable } as unknown as Response;
      return { ok: queueStatus < 300, status: queueStatus, json: async () => ({ queued: queueStatus === 202 }) } as unknown as Response;
    }
    if (url.endsWith('/api/fabric/email')) return { ok: true, status: 200, json: async () => ({ sent: true }) } as unknown as Response;
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
}

/** The emails, for the tests that assert on both channels at once. */
const emails = () => calls.filter((c) => c.url.endsWith('/api/fabric/email'));

/** Only the messages we actually handed to the queue — a GET status probe is not a send. */
const sends = () => calls.filter((c) => c.url.endsWith('/api/fabric/whatsapp') && typeof c.body.to === 'string');

/**
 * Let the fire-and-forget sends finish.
 *
 * `alertStaff` deliberately does NOT await the WhatsApp fan-out (nor the platform alert, nor the
 * webhook): a notification failing must never sit in the critical path of the payment or the autopay
 * run that triggered it. Same for `sendReceipt`. So a test asserting on those has to drain the queue
 * rather than assume the awaited call covered them.
 */
const drain = () => new Promise((r) => setTimeout(r, 30));

beforeAll(async () => {
  app = await freshApp({ fabric: true, publicUrl: 'https://masjid.example.org' });
  whatsapp = await import('../src/whatsapp');
  numbers = await import('../src/whatsapp/numbers');
  notify = await import('../src/mail/notify');
  alerts = await import('../src/alerts');
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, students, guardianFamilies, guardians, families, alertRecipients, whatsappLog, settings, auditLog]) db.delete(t).run();
  db.delete(users).run();
  calls = [];
  waAvailable = { available: true, reason: 'ready' };
  statusHttp = 200;
  queueStatus = 202;
  groupList = [{ id: '1203630001@g.us', label: 'Parents' }];
  // The availability answer is cached for five minutes so a send never pays for a status hop; a test
  // that changed it would otherwise be reading the previous test's answer.
  whatsapp.resetWhatsAppStatusCache();
  installFetch();
});

// ── The number ──────────────────────────────────────────────────────────────
describe('turning a number an office typed into one WhatsApp will take', () => {
  it('puts the country on a plain national number', () => {
    expect(numbers.toE164('5551234567', '+1')).toBe('+15551234567');
    expect(numbers.toE164('(555) 123-4567', '+1')).toBe('+15551234567');
    expect(numbers.toE164('555-123-4567', '+1')).toBe('+15551234567');
  });

  it('does not put it on twice when the number already carries it', () => {
    expect(numbers.toE164('15551234567', '+1')).toBe('+15551234567');
    expect(numbers.toE164('1 (555) 123-4567', '+1')).toBe('+15551234567');
    expect(numbers.toE164('447911123456', '+44')).toBe('+447911123456');
  });

  /**
   * The ambiguous one, and the reason the rule is length-based rather than prefix-based.
   *
   * `1234567890` begins with the country code `1` and is ten digits. Read as "already prefixed" it
   * becomes `+1234567890`, which is a real number belonging to somebody else. Ten digits is a NATIONAL
   * number, so it gets the code — and in the NANP it cannot be anything else, since an area code never
   * starts with 1.
   */
  it('reads a ten-digit number as national even when it starts with the country code', () => {
    expect(numbers.toE164('1234567890', '+1')).toBe('+11234567890');
  });

  /** Without this, every UK, Pakistani, Egyptian and German number on an install is dead. */
  it('drops a national trunk zero before the country code goes on', () => {
    expect(numbers.toE164('07911 123456', '+44')).toBe('+447911123456');
    expect(numbers.toE164('0300 1234567', '+92')).toBe('+923001234567');
    expect(numbers.toE164('01012345678', '+20')).toBe('+201012345678');
  });

  it('understands the 00 international prefix, and leaves a + alone', () => {
    expect(numbers.toE164('00 44 7911 123456', '+1')).toBe('+447911123456');
    expect(numbers.toE164('+44 20 7946 0958', '+1')).toBe('+442079460958');
  });

  it('refuses what it cannot read rather than guessing', () => {
    expect(numbers.toE164('', '+1')).toBeNull();
    expect(numbers.toE164(null, '+1')).toBeNull();
    expect(numbers.toE164('ask mum', '+1')).toBeNull();
    expect(numbers.toE164('123', '+1')).toBeNull(); // too short even with the code
    expect(numbers.toE164('555-1234 x22', '+1')).toBeNull(); // an extension is not a phone number…
    expect(numbers.toE164('(555) 123-4567 (mobile)', '+1')).toBeNull(); // …and neither is a note beside one
    expect(numbers.toE164('5551234567', 'nope')).toBeNull(); // a country code that is not one
    expect(numbers.toE164('1234567890123456', '+1')).toBeNull(); // past E.164's 15 digits
  });

  it('masks a number for a screen that must say which one without printing it', () => {
    expect(numbers.maskNumber('+15551234567')).toBe('···4567');
    expect(numbers.maskNumber(null)).toBe('');
  });
});

/** A signed-in parent portal caller for one guardian - the portal's scoping wall is `guardian_users`. */
async function portalFor(guardianId: string) {
  const { db } = app.dbmod;
  const { eq } = await import('drizzle-orm');
  const { guardianUsers } = await import('../src/db/schema');
  const uid = `usr_p_${guardianId}`;
  const ts = new Date();
  if (!db.select().from(users).where(eq(users.id, uid)).get()) {
    db.insert(users).values({ id: uid, username: `p-${guardianId}@test.org`, passwordHash: 'x', role: 'parent', status: 'active', createdAt: ts, updatedAt: ts }).run();
    db.insert(guardianUsers).values({ guardianId, userId: uid, createdAt: ts }).run();
  }
  return app.appRouter.createCaller(makeCtx({ origin: 'tunnel', session: { role: 'parent', source: 'local', username: 'p', userId: uid } }).ctx);
}

// ── Fixtures ────────────────────────────────────────────────────────────────
/** A household with one guardian who has a number, and one child. */
async function household(surname: string, opts: { phone?: string | null; email?: string; kid?: string } = {}) {
  const admin = caller('admin');
  const plan = await admin.billing.feePlanCreate({ name: 'Monthly tuition', amountCents: 5000, cadence: 'monthly' });
  const fam = await admin.people.familyCreate({ name: surname });
  const g = await admin.people.guardianCreate({
    familyId: fam.id,
    name: `Abu ${surname}`,
    phone: opts.phone === null ? undefined : (opts.phone ?? '5551234567'),
    email: opts.email,
  });
  const kid = await admin.people.studentCreate({ familyId: fam.id, fullName: `${opts.kid ?? 'Yusuf'} ${surname}`, feePlanId: plan.id });
  return { admin, familyId: fam.id, guardianId: g.id, studentId: kid.id, feePlanId: plan.id };
}

/** Switch the feature on with one event, which is what almost every test below needs. */
async function turnOn(event: 'receipt' | 'autopay-failed' | 'past-due' = 'receipt', opts: { paused?: boolean } = {}) {
  const admin = caller('admin');
  await admin.whatsapp.set({ enabled: true, paused: opts.paused ?? false });
  await admin.whatsapp.set({ event: { id: event, on: true } });
}

// ── The gates ───────────────────────────────────────────────────────────────
describe('the gates, in order', () => {
  it('sends nothing at all while the feature is off — which is how every install starts', async () => {
    const { familyId } = await household('Ismail');
    calls = [];
    const out = await whatsapp.notifyFamily('receipt', familyId, 'receipt');
    expect(out.blocked).toBe('off');
    expect(sends()).toHaveLength(0);
  });

  it('sends nothing when the masjid has no gateway, whatever the app settings say', async () => {
    const { familyId } = await household('Ismail');
    await turnOn();
    waAvailable = { available: false, reason: 'not-linked' };
    whatsapp.resetWhatsAppStatusCache();
    calls = [];
    const out = await whatsapp.notifyFamily('receipt', familyId, 'receipt');
    expect(out.blocked).toBe('unavailable');
    expect(sends()).toHaveLength(0);
  });

  it('sends nothing for an event that is switched off', async () => {
    const { familyId } = await household('Ismail');
    await turnOn('receipt');
    calls = [];
    const out = await whatsapp.notifyFamily('past-due', familyId, 'past-due');
    expect(out.blocked).toBe('event_off');
    expect(sends()).toHaveLength(0);
  });

  it('queues to a household once everything is on', async () => {
    const { familyId } = await household('Ismail');
    await turnOn();
    calls = [];
    const out = await whatsapp.notifyFamily('receipt', familyId, 'receipt', { amount: '$50.00' });
    expect(out.queued).toBe(1);
    expect(sends()).toHaveLength(1);
    expect(sends()[0].body.to).toBe('+15551234567');
    // Rendered from the template, not handed in by the caller — the tags resolve to this household.
    expect(String(sends()[0].body.text)).toContain('$50.00');
  });

  it('skips a guardian whose number cannot be read, and says so in the log', async () => {
    const { admin, familyId } = await household('Ismail', { phone: 'ask mum' });
    await turnOn();
    calls = [];
    const out = await whatsapp.notifyFamily('receipt', familyId, 'receipt');
    expect(out.queued).toBe(0);
    expect(out.skipped.no_number).toBe(1);
    expect(sends()).toHaveLength(0);
    const log = await admin.whatsapp.log({});
    expect(log[0]).toMatchObject({ status: 'skipped', reason: 'no_number' });
  });

  it('records a refusal from the queue as failed, not as sent', async () => {
    const { admin, familyId } = await household('Ismail');
    await turnOn();
    queueStatus = 429; // the platform protecting the masjid's number
    calls = [];
    const out = await whatsapp.notifyFamily('receipt', familyId, 'receipt');
    expect(out.queued).toBe(0);
    const log = await admin.whatsapp.log({});
    expect(log[0]).toMatchObject({ status: 'failed', reason: 'http_429' });
  });
});

// ── The pause and its one exception ─────────────────────────────────────────
describe('the pause, and the test student who gets through it', () => {
  it('stops every household while it is on', async () => {
    const { familyId } = await household('Ismail');
    await turnOn('receipt', { paused: true });
    calls = [];
    const out = await whatsapp.notifyFamily('receipt', familyId, 'receipt');
    expect(out.queued).toBe(0);
    expect(out.skipped.paused).toBe(1);
    expect(sends()).toHaveLength(0);
  });

  /** The whole point of the setting: try a real message on one real household, and nobody else. */
  it('lets the test student’s household through — and only theirs', async () => {
    const a = await household('Ismail');
    const b = await household('Farooqi', { phone: '5559998888' });
    await turnOn('receipt', { paused: true });
    await a.admin.whatsapp.set({ testStudentId: a.studentId });
    calls = [];

    expect((await whatsapp.notifyFamily('receipt', a.familyId, 'receipt')).queued).toBe(1);
    expect((await whatsapp.notifyFamily('receipt', b.familyId, 'receipt')).queued).toBe(0);
    expect(sends().map((c) => c.body.to)).toEqual(['+15551234567']);
  });

  /** A withdrawn or deleted test student must fail CLOSED: the exception stops, the pause holds. */
  it('stops being an exception when the student is no longer on the roll', async () => {
    const a = await household('Ismail');
    await turnOn('receipt', { paused: true });
    await a.admin.whatsapp.set({ testStudentId: a.studentId });
    await a.admin.people.studentUpdate({ id: a.studentId, status: 'withdrawn' });
    calls = [];
    expect((await whatsapp.notifyFamily('receipt', a.familyId, 'receipt')).queued).toBe(0);
    // …and the settings screen says so rather than leaving it looking configured.
    expect((await a.admin.whatsapp.get()).testFamilyId).toBeNull();
  });

  it('does not apply to staff alerts — an office that paused parent mail still wants to be told', async () => {
    const { admin } = await household('Ismail');
    await turnOn('receipt', { paused: true });
    const staff = await admin.staff.create({ username: 'treasurer', role: 'finance', tempPassword: 'a-long-temp-password' });
    await admin.staff.setContact({ userId: staff.id, phone: '5557778888', waEvents: ['autopay-disabled'] });
    calls = [];
    await alerts.alertStaff('autopay-disabled', { title: 'Autopay off', text: 'Ismail family — three failures.', publicText: 'Autopay was turned off for a family.' });
    await drain();
    expect(sends().map((c) => c.body.to)).toEqual(['+15557778888']);
  });
});

// ── The opt-out ─────────────────────────────────────────────────────────────
describe('a parent who asked not to be messaged', () => {
  /** The portal's own switch, on the guardian behind the signed-in parent. */
  async function optOut(guardianId: string, familyId: string) {
    const { db } = app.dbmod;
    const { eq } = await import('drizzle-orm');
    const uid = `usr_p_${guardianId}`;
    const ts = new Date();
    const { guardianUsers } = await import('../src/db/schema');
    db.insert(users).values({ id: uid, username: `p-${guardianId}@test.org`, passwordHash: 'x', role: 'parent', status: 'active', createdAt: ts, updatedAt: ts }).run();
    db.insert(guardianUsers).values({ guardianId, userId: uid, createdAt: ts }).run();
    const parent = app.appRouter.createCaller(makeCtx({ origin: 'tunnel', session: { role: 'parent', source: 'local', username: 'p', userId: uid } }).ctx);
    await parent.portal.messagingSet({ optOut: true });
    // Sanity: it landed on the guardian, which is what every gate below reads.
    expect(db.select().from(guardians).where(eq(guardians.id, guardianId)).get()?.waOptOut).toBe(true);
    expect(familyId).toBeTruthy();
    return parent;
  }

  it('is never messaged, even when everything else says yes', async () => {
    const { familyId, guardianId } = await household('Ismail');
    await turnOn();
    await optOut(guardianId, familyId);
    calls = [];
    const out = await whatsapp.notifyFamily('receipt', familyId, 'receipt');
    expect(out.queued).toBe(0);
    expect(out.skipped.opted_out).toBe(1);
    expect(sends()).toHaveLength(0);
  });

  /** The pause exception is about the PAUSE. It does not outrank a person's answer. */
  it('is not overridden by being the test student’s household', async () => {
    const a = await household('Ismail');
    await turnOn('receipt', { paused: true });
    await a.admin.whatsapp.set({ testStudentId: a.studentId });
    await optOut(a.guardianId, a.familyId);
    calls = [];
    expect((await whatsapp.notifyFamily('receipt', a.familyId, 'receipt')).queued).toBe(0);
    expect(sends()).toHaveLength(0);
  });

  it('can be turned back on by the parent', async () => {
    const { familyId, guardianId } = await household('Ismail');
    await turnOn();
    const parent = await optOut(guardianId, familyId);
    expect((await parent.portal.messagingGet()).people[0].optedOut).toBe(true);
    await parent.portal.messagingSet({ optOut: false });
    expect((await parent.portal.messagingGet()).people[0].optedOut).toBe(false);
    calls = [];
    expect((await whatsapp.notifyFamily('receipt', familyId, 'receipt')).queued).toBe(1);
  });

  it('shows the parent which number it is about, without printing it', async () => {
    const { familyId, guardianId } = await household('Ismail');
    await turnOn();
    const parent = await optOut(guardianId, familyId);
    const view = await parent.portal.messagingGet();
    expect(view.available).toBe(true);
    expect(view.people[0].mask).toBe('···4567');
    expect(view.people[0].isYou).toBe(true);
  });

  it('shows a parent nothing at all when the madrasah has not switched WhatsApp on', async () => {
    const { familyId, guardianId } = await household('Ismail');
    const parent = await optOut(guardianId, familyId);
    expect((await parent.portal.messagingGet()).available).toBe(false);
  });
});

// ── What may and may not travel this way ────────────────────────────────────
describe('what is allowed on this channel', () => {
  /**
   * The rule that must never erode. A WhatsApp number can be restricted overnight, and the day it is
   * must not be the day nobody can accept an invite or reset a password. Those go by email, which has
   * a real provider behind it.
   */
  it('never carries an invite or a password reset', async () => {
    await household('Ismail');
    await turnOn();
    calls = [];
    await notify.sendInvite('parent@test.org', 'https://masjid.example.org/family/invite?t=x', 'Abu Yusuf');
    await notify.sendReset('parent@test.org', 'https://masjid.example.org/reset?t=x', 'parent');
    expect(sends()).toHaveLength(0);
    // …and both did go by email, so this is not passing because nothing was sent at all.
    expect(calls.filter((c) => c.url.endsWith('/api/fabric/email'))).toHaveLength(2);
  });

  /** The log is an audit trail, not a second copy of a message about a child's fees. */
  it('never stores the message body', async () => {
    const { familyId } = await household('Ismail');
    await turnOn();
    await whatsapp.notifyFamily('receipt', familyId, 'receipt', { amount: '$250.00' });
    const rows = app.dbmod.db.select().from(whatsappLog).all();
    expect(rows).toHaveLength(1);
    // The figure and the child's name both went out in the message and neither is in the row.
    expect(JSON.stringify(rows)).not.toContain('$250');
    expect(JSON.stringify(rows)).not.toContain('Yusuf');
  });

  /** A receipt is a PAYMENT, never a donation (§11.3) — the same wording rule the email follows. */
  it('calls a payment a payment', async () => {
    const { familyId } = await household('Ismail');
    await turnOn();
    calls = [];
    await notify.sendReceipt(familyId, '$50.00');
    await drain(); // the WhatsApp send is fire-and-forget
    const text = String(sends()[0].body.text).toLowerCase();
    expect(text).toContain('payment');
    expect(text).not.toContain('donation');
  });

  /** The channel split: WhatsApp carries the fact, email carries the detail — and says so only when
   *  there is actually an address for that person to look in. */
  it('points at the email only when the school has one', async () => {
    const withAddress = await household('Ismail', { email: 'parent@test.org' });
    const without = await household('Farooqi', { phone: '5559998888' });
    await turnOn();
    calls = [];
    await notify.sendReceipt(withAddress.familyId, '$50.00');
    await notify.sendReceipt(without.familyId, '$50.00');
    await drain();
    const byNumber = new Map(sends().map((c) => [String(c.body.to), String(c.body.text)]));
    expect(byNumber.get('+15551234567')).toContain('emailed');
    expect(byNumber.get('+15559998888')).not.toContain('emailed');
  });
});

// ── Staff ───────────────────────────────────────────────────────────────────
describe('alerts to a staff phone', () => {
  async function treasurer(events: string[] = ['autopay-disabled'], phone = '5557778888') {
    const admin = caller('admin');
    const staff = await admin.staff.create({ username: `staff-${phone}`, role: 'finance', tempPassword: 'a-long-temp-password' });
    await admin.staff.setContact({ userId: staff.id, phone, waEvents: events as ('autopay-disabled')[] });
    return { admin, id: staff.id };
  }

  it('reaches exactly the people subscribed to that alert', async () => {
    await household('Ismail');
    await turnOn();
    await treasurer(['autopay-disabled'], '5557778888');
    await treasurer(['payment-received'], '5556665555');
    calls = [];
    await alerts.alertStaff('autopay-disabled', { title: 'Autopay off', text: 'Ismail family — three failures.', publicText: 'Autopay was turned off for a family.' });
    await drain();
    expect(sends().map((c) => c.body.to)).toEqual(['+15557778888']);
  });

  /**
   * §14's line is around THIRD-PARTY sinks — a Slack webhook, the platform's alert channel. A number
   * an admin typed, on a gateway the masjid runs itself, is the same audience as their inbox, and an
   * alert that cannot say which family is not actionable.
   */
  it('names the household, like the alert email and unlike the webhook', async () => {
    await household('Ismail');
    await turnOn();
    await treasurer();
    calls = [];
    await alerts.alertStaff('autopay-disabled', { title: 'Autopay off', text: 'Ismail family — three failures.', publicText: 'Autopay was turned off for a family.' });
    await drain();
    expect(String(sends()[0].body.text)).toContain('Ismail');
  });

  it('reaches nobody once their number is cleared', async () => {
    await household('Ismail');
    await turnOn();
    const { admin, id } = await treasurer();
    await admin.staff.setContact({ userId: id, phone: '' });
    calls = [];
    await alerts.alertStaff('autopay-disabled', { title: 'T', text: 'B', publicText: 'B' });
    await drain();
    expect(sends()).toHaveLength(0);
  });

  it('is admin-only, and refuses an alert id the server does not know', async () => {
    await expect(caller('finance').staff.setContact({ userId: 'usr_x', phone: '555' })).rejects.toThrow(/access/i);
    const { admin, id } = await treasurer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately invalid input
    await expect(admin.staff.setContact({ userId: id, waEvents: ['everything'] as any })).rejects.toThrow();
  });
});

// ── The missing-email outreach ──────────────────────────────────────────────
describe('asking for a missing email address', () => {
  it('lists only households with no address, and names their children', async () => {
    const admin = caller('admin');
    await household('Ismail', { email: 'parent@test.org' }); // has an address — not listed
    const b = await household('Farooqi', { phone: '5559998888', kid: 'Maryam' });
    await admin.people.studentCreate({ familyId: b.familyId, fullName: 'Bilal Farooqi', feePlanId: b.feePlanId });
    await turnOn();

    const p = await admin.whatsapp.emailRequestPreview();
    expect(p.households).toBe(1);
    expect(p.sendable).toBe(1);
    expect(p.preview[0].children).toEqual(['Bilal Farooqi', 'Maryam Farooqi']);
    // The message says WHICH children, as a sentence rather than a list dump.
    expect(p.preview[0].text).toContain('Bilal Farooqi and Maryam Farooqi');
    // …and it says why an email matters at all, which is the whole ask.
    expect(p.preview[0].text.toLowerCase()).toContain('email');
  });

  it('sends one message per household, to the first adult it can reach', async () => {
    const admin = caller('admin');
    const h = await household('Farooqi', { phone: '5559998888' });
    await admin.people.guardianCreate({ familyId: h.familyId, name: 'Umm Maryam', phone: '5551112222' });
    await turnOn();
    calls = [];
    const r = await admin.whatsapp.emailRequestSend({});
    expect(r.queued).toBe(1);
    expect(sends()).toHaveLength(1);
  });

  it('respects the pause, and says so rather than doing nothing quietly', async () => {
    const admin = caller('admin');
    await household('Farooqi', { phone: '5559998888' });
    await turnOn('receipt', { paused: true });
    calls = [];
    const r = await admin.whatsapp.emailRequestSend({});
    expect(r.queued).toBe(0);
    expect(r.skipped.paused).toBe(1);
    expect(sends()).toHaveLength(0);
    // The skip is logged here, unlike the broadcast case: somebody pressed a button and is waiting.
    expect((await admin.whatsapp.log({}))[0]).toMatchObject({ status: 'skipped', reason: 'paused' });
  });

  it('keeps the office’s own wording', async () => {
    const admin = caller('admin');
    await household('Farooqi', { phone: '5559998888' });
    await turnOn();
    await admin.whatsapp.emailRequestSet({ text: 'Salam [family] — we need an email for [children]. — [school]' });
    calls = [];
    await admin.whatsapp.emailRequestSend({});
    const text = String(sends()[0].body.text);
    expect(text).toContain('Salam Farooqi');
    expect(text).toContain('Yusuf Farooqi');
    expect(text).not.toContain('[school]');
    // Clearing the box puts our sentence back rather than sending a blank message.
    await admin.whatsapp.emailRequestSet({ text: '' });
    expect((await admin.whatsapp.emailRequestPreview()).preview[0].text).toContain('don’t have an email address');
  });
});

// -- The four things a real office hit on the first build --------------------
/**
 * Every test in this block is a bug a masjid found by using it, and each one failed SILENTLY — which
 * is the whole hazard of a notification channel. Nothing errors when a message is not sent; you just
 * stand there waiting for a phone that never buzzes.
 */
describe('reported by an office setting this up', () => {
  /**
   * "I set a test student and neither the email NOR the WhatsApp arrived."
   *
   * The setting lifted the WhatsApp pause and nothing else, so on a fresh install — where the parent
   * MAIL pause also defaults on — a receipt was held back by the other switch. "That household will
   * receive notifications even if paused" has to mean notifications, not one kind of them.
   */
  it('the test student household gets the EMAIL too, not only the WhatsApp', async () => {
    const a = await household('Ismail', { email: 'parent@test.org' });
    const b = await household('Farooqi', { phone: '5559998888', email: 'other@test.org' });
    await turnOn('receipt', { paused: true });
    await a.admin.settings.parentMailPauseSet({ paused: true });
    await a.admin.whatsapp.set({ testStudentId: a.studentId });
    calls = [];

    // The test household hears on both channels...
    expect(await notify.sendReceipt(a.familyId, '$50.00')).toBe(1);
    await drain();
    expect(emails().map((c) => c.body.to)).toEqual(['parent@test.org']);
    expect(sends()).toHaveLength(1);

    // ...and everybody else still hears nothing at all, which is what the pause is for.
    calls = [];
    expect(await notify.sendReceipt(b.familyId, '$50.00')).toBe(0);
    await drain();
    expect(emails()).toHaveLength(0);
    expect(sends()).toHaveLength(0);
  });

  /** The second line of the mail pause has to honour the exception too, or it silently cancels it. */
  it('the exception survives the guardian-address lookup, not just the sender', async () => {
    const a = await household('Ismail', { email: 'parent@test.org' });
    await a.admin.settings.parentMailPauseSet({ paused: true });
    await a.admin.whatsapp.set({ testStudentId: a.studentId });
    const recipients = await import('../src/mail/recipients');
    expect(recipients.guardianEmailsForFamily(a.familyId)).toEqual(['parent@test.org']);
    // Any other household is still empty while paused.
    const b = await household('Farooqi', { email: 'other@test.org' });
    expect(recipients.guardianEmailsForFamily(b.familyId)).toEqual([]);
  });

  /**
   * "The Send test button is greyed out even after adding a test student."
   *
   * The screen read a CACHED gateway status that nothing primed except a 15-minute cron, so for the
   * first quarter of an hour after a container start a perfectly working install reported "not ready".
   */
  it('reports the gateway status on the first read, not fifteen minutes later', async () => {
    const admin = caller('admin');
    whatsapp.resetWhatsAppStatusCache(); // exactly the state a freshly-booted container is in
    const got = await admin.whatsapp.get();
    expect(got.status).toMatchObject({ available: true, reason: 'ready', source: 'platform' });
  });

  /**
   * "The portal is per household, not per parent — both of them log in and see the same thing."
   *
   * So a parent manages messages for the household, not only for themselves.
   */
  it('a parent can switch messages off for the other parent on their household', async () => {
    const admin = caller('admin');
    const h = await household('Ismail');
    const mum = await admin.people.guardianCreate({ familyId: h.familyId, name: 'Umm Yusuf', phone: '5551112222' });
    await turnOn();
    const dad = await portalFor(h.guardianId);

    const view = await dad.portal.messagingGet();
    expect(view.people.map((x) => x.name).sort()).toEqual(['Abu Ismail', 'Umm Yusuf']);
    expect(view.people.find((x) => x.guardianId === h.guardianId)?.isYou).toBe(true);
    expect(view.people.find((x) => x.guardianId === mum.id)?.isYou).toBe(false);

    await dad.portal.messagingSet({ guardianId: mum.id, optOut: true });
    calls = [];
    const out = await whatsapp.notifyFamily('receipt', h.familyId, 'receipt', { amount: '$50.00' });
    // Dad still hears; mum does not.
    expect(out.queued).toBe(1);
    expect(out.skipped.opted_out).toBe(1);
  });

  /** ...but only on a household they are actually linked to (the wall is the query, as always). */
  it('cannot touch a guardian on somebody elses household', async () => {
    const a = await household('Ismail');
    const b = await household('Farooqi', { phone: '5559998888' });
    await turnOn();
    const dad = await portalFor(a.guardianId);
    await expect(dad.portal.messagingSet({ guardianId: b.guardianId, optOut: true })).rejects.toThrow(/access/i);
  });
});

// -- The office's own wording ------------------------------------------------
describe('rewriting what a message says', () => {
  it('fills in the tags an office is offered', async () => {
    const admin = caller('admin');
    const h = await household('Ismail');
    await turnOn();
    await admin.whatsapp.textsSet({ boxes: [{ key: 'receipt', text: 'Salam [family] - [amount] received for [children]. You owe [balance]. - [school]' }] });
    calls = [];
    await whatsapp.notifyFamily('receipt', h.familyId, 'receipt', { amount: '$50.00' });
    const text = String(sends()[0].body.text);
    expect(text).toContain('Salam Ismail');
    expect(text).toContain('$50.00 received for Yusuf');
    // [balance] is the DERIVED figure, like every other balance in this app.
    expect(text).toContain('You owe $0.00');
    expect(text).not.toContain('[school]');
  });

  it('previews against a real household, with and without the check-your-email line', async () => {
    const admin = caller('admin');
    const h = await household('Ismail');
    await admin.whatsapp.set({ enabled: true, testStudentId: h.studentId });
    const p = await admin.whatsapp.textsGet();
    // The DERIVED household label (people/household.ts), not the name the fixture typed — which is
    // exactly what a parent sees on their statement, so it is what the preview should show.
    expect(p.sampleFamily).toBe('Ismail family');
    const receipt = p.preview.find((x) => x.key === 'receipt')!;
    expect(receipt.withEmail).toContain('emailed');
    expect(receipt.withoutEmail).not.toContain('emailed');
  });

  it('clearing a box goes back to our sentence rather than sending a blank message', async () => {
    const admin = caller('admin');
    await household('Ismail');
    await admin.whatsapp.textsSet({ boxes: [{ key: 'receipt', text: 'mine' }] });
    expect((await admin.whatsapp.textsGet()).overrides.receipt).toBe('mine');
    await admin.whatsapp.textsSet({ boxes: [{ key: 'receipt', text: '' }] });
    expect((await admin.whatsapp.textsGet()).overrides.receipt).toBeUndefined();
    await admin.whatsapp.textsSet({ boxes: [{ key: 'receipt', text: 'mine' }] });
    await admin.whatsapp.textsSet({ reset: true });
    expect((await admin.whatsapp.textsGet()).overrides).toEqual({});
  });

  it('refuses a message key the server does not know, and is admin-only', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately invalid input
    await expect(caller('admin').whatsapp.textsSet({ boxes: [{ key: 'nope' as any, text: 'x' }] })).rejects.toThrow();
    await expect(caller('finance').whatsapp.textsGet()).rejects.toThrow(/access/i);
  });

  /** Two texts behind one switch: the third strike is a different message, and an office rewriting
   *  one almost always wants to rewrite the other differently. */
  it('has its own wording for the third autopay strike', async () => {
    const admin = caller('admin');
    const h = await household('Ismail');
    await turnOn('autopay-failed');
    await admin.whatsapp.textsSet({ boxes: [{ key: 'autopay-stopped', text: 'STOPPED' }, { key: 'autopay-failed', text: 'RETRYING' }] });
    calls = [];
    await notify.sendAutopayFailure(h.familyId, false);
    await drain();
    expect(String(sends()[0].body.text)).toBe('RETRYING');
    calls = [];
    await notify.sendAutopayFailure(h.familyId, true);
    await drain();
    expect(String(sends()[0].body.text)).toBe('STOPPED');
  });
});

// -- The four notification types added in 0.50.0 -----------------------------
/**
 * Each of these is a gap a madrasah notices the week it starts using this, and each is on BOTH
 * channels rather than WhatsApp alone: email is the reliable one and the one a household with no
 * phone number still has, so a notification type that existed only on WhatsApp would be one those
 * families could never receive.
 *
 * All four default OFF on both channels. That is the rule for any NEW message (§ getParentEmails): a
 * madrasah that updates on a Tuesday must not start writing to two hundred families on the Wednesday.
 */
describe('the newer notification types', () => {
  it('all start switched off, on both channels', async () => {
    const admin = caller('admin');
    const prefs = (await admin.settings.alertsGet()).parentEmails;
    expect(prefs.invoiceReady).toBe(false);
    expect(prefs.autopayUpcoming).toBe(false);
    expect(prefs.cardExpiring).toBe(false);
    expect(prefs.refund).toBe(false);
    // ...and the two that shipped before them are still ON, because an upgraded install was sending
    // those and must keep doing so.
    expect(prefs.receipt).toBe(true);
    expect(prefs.autopayFailure).toBe(true);
    expect((await admin.whatsapp.get()).events).toEqual({});
  });

  /**
   * ONE message per household, not one per child.
   *
   * Bills are per child; the message is to a parent. A household with three children would otherwise
   * get three of them for one billing run, on a channel whose allowance belongs to the masjid's number.
   */
  it('tells a household its bill is ready, once, however many children it has', async () => {
    const admin = caller('admin');
    const h = await household('Ismail');
    await admin.people.studentCreate({ familyId: h.familyId, fullName: 'Maryam Ismail', feePlanId: h.feePlanId });
    await turnOn('invoice-ready');
    calls = [];
    await admin.billing.generateFamily({ familyId: h.familyId, periodKey: '2026-07', label: 'Tuition - Jul 2026', dueDate: '2026-07-01' });
    await drain();
    expect(sends()).toHaveLength(1);
    const text = String(sends()[0].body.text);
    // Both children are named -- "what is this for?" is the question this message answers.
    expect(text).toContain('Yusuf');
    expect(text).toContain('Maryam');
    // The whole household's new bills, added up.
    expect(text).toContain('$100.00');
  });

  /** Re-running a period is idempotent by design, so it must not message anybody a second time. */
  it('does not tell them twice when a period is generated again', async () => {
    const admin = caller('admin');
    const h = await household('Ismail');
    await turnOn('invoice-ready');
    await admin.billing.generateFamily({ familyId: h.familyId, periodKey: '2026-07', label: 'Tuition', dueDate: '2026-07-01' });
    await drain();
    calls = [];
    await admin.billing.generateFamily({ familyId: h.familyId, periodKey: '2026-07', label: 'Tuition', dueDate: '2026-07-01' });
    await drain();
    expect(sends()).toHaveLength(0);
  });

  /**
   * The upcoming-charge notice, and the rule that stops it becoming a daily one: a household
   * qualifies only when a bill falls due EXACTLY on the notice day. Selecting on "something is due
   * soon" would message a family with an older overdue bill every single day until they paid.
   */
  it('warns about an autopay charge on the day it is three days off, and no other day', async () => {
    const admin = caller('admin');
    const h = await household('Ismail');
    await admin.billing.generateFamily({ familyId: h.familyId, periodKey: '2026-07', label: 'Tuition', dueDate: '2026-07-10' });
    const { db } = app.dbmod;
    const { autopayEnrollments, paymentMethods } = await import('../src/db/schema');
    const ts = new Date();
    db.insert(paymentMethods)
      .values({ id: 'pm_1', familyId: h.familyId, stripePaymentMethodId: 'pm_x', brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030, isDefault: true, sortOrder: 0, createdAt: ts, updatedAt: ts })
      .run();
    db.insert(autopayEnrollments).values({ familyId: h.familyId, enabled: true, defaultPmId: 'pm_1', consentAt: ts, failureCount: 0, createdAt: ts, updatedAt: ts }).run();

    const autopay = await import('../src/payments/autopay');
    expect(autopay.autopayUpcoming('2026-07-07').map((x) => x.familyId)).toEqual([h.familyId]);
    // A day earlier, a day later, and the day of the charge itself: nothing.
    expect(autopay.autopayUpcoming('2026-07-06')).toEqual([]);
    expect(autopay.autopayUpcoming('2026-07-08')).toEqual([]);
    expect(autopay.autopayUpcoming('2026-07-10')).toEqual([]);

    await turnOn('autopay-upcoming');
    calls = [];
    await autopay.runAutopayNotice('2026-07-07');
    await drain();
    expect(sends()).toHaveLength(1);
    // Brand and last four only -- never a PAN, never a holder name.
    expect(String(sends()[0].body.text)).toContain('Visa');
    expect(String(sends()[0].body.text)).toContain('4242');
  });

  /** The message that removes a whole failure sequence: expired card, decline, retry ladder, autopay
   *  off, family three months behind. */
  it('warns about a card expiring this month or next, and not one expiring later', async () => {
    const admin = caller('admin');
    const h = await household('Ismail');
    const { db } = app.dbmod;
    const { autopayEnrollments, paymentMethods } = await import('../src/db/schema');
    const ts = new Date();
    db.insert(paymentMethods)
      .values({ id: 'pm_1', familyId: h.familyId, stripePaymentMethodId: 'pm_x', brand: 'visa', last4: '4242', expMonth: 8, expYear: 2026, isDefault: true, sortOrder: 0, createdAt: ts, updatedAt: ts })
      .run();
    db.insert(autopayEnrollments).values({ familyId: h.familyId, enabled: true, defaultPmId: 'pm_1', consentAt: ts, failureCount: 0, createdAt: ts, updatedAt: ts }).run();
    await turnOn('card-expiring');

    const autopay = await import('../src/payments/autopay');
    // The month before, and the month itself.
    calls = [];
    expect((await autopay.runCardExpiryNotice('2026-07-01')).notified).toBe(1);
    calls = [];
    expect((await autopay.runCardExpiryNotice('2026-08-01')).notified).toBe(1);
    // Not two months out, and not after it has gone.
    calls = [];
    expect((await autopay.runCardExpiryNotice('2026-06-01')).notified).toBe(0);
    expect((await autopay.runCardExpiryNotice('2026-09-01')).notified).toBe(0);
    expect(admin).toBeTruthy();
  });
});

// -- Why nothing is sending --------------------------------------------------
/**
 * The diagnostic that was missing, and it cost a real madrasah an evening: they turned WhatsApp on,
 * set a test student, took a genuine tuition payment, and got no message AND no log row — because the
 * global gates stop a send before any recipient is considered and deliberately write nothing (a
 * switch that is off would otherwise fill the trail every invoice run).
 */
describe('the screen says why nothing is sending', () => {
  it('names the master switch when the feature is off', async () => {
    expect((await caller('admin').whatsapp.get()).blockers).toContain('off');
  });

  it('names the gateway when the platform cannot send', async () => {
    const admin = caller('admin');
    await turnOn();
    waAvailable = { available: false, reason: 'not-linked' };
    whatsapp.resetWhatsAppStatusCache();
    expect((await admin.whatsapp.get()).blockers).toContain('gateway_not-linked');
  });

  /** The one that actually bit: everything on, nothing selected, so nothing can ever fire. */
  it('names the empty event list', async () => {
    const admin = caller('admin');
    await admin.whatsapp.set({ enabled: true, paused: false });
    expect((await admin.whatsapp.get()).blockers).toContain('no_events');
  });

  it('names a pause with nobody excepted from it', async () => {
    const admin = caller('admin');
    await turnOn('receipt', { paused: true });
    expect((await admin.whatsapp.get()).blockers).toContain('paused_no_test');
  });

  it('is empty once everything is actually set up — and says so when only the test household hears', async () => {
    const h = await household('Ismail');
    await turnOn('receipt', { paused: false });
    expect((await h.admin.whatsapp.get()).blockers).toEqual([]);

    await h.admin.whatsapp.set({ paused: true, testStudentId: h.studentId });
    const paused = await h.admin.whatsapp.get();
    expect(paused.blockers).toEqual([]);
    expect(paused.pausedWithTest).toBe(true);
  });
});

// -- The test button ---------------------------------------------------------
describe('sending a test', () => {
  /** It refused outright unless WhatsApp was ready, which made it useless in the exact situation an
   *  office is in when they press it — and the test student governs the email pause too. */
  it('still emails the test household when WhatsApp is not ready', async () => {
    const h = await household('Ismail', { email: 'parent@test.org' });
    await h.admin.whatsapp.set({ enabled: true, testStudentId: h.studentId });
    await h.admin.settings.parentMailPauseSet({ paused: true });
    waAvailable = { available: false, reason: 'not-configured' };
    whatsapp.resetWhatsAppStatusCache();
    calls = [];

    const r = await h.admin.whatsapp.testSend();
    expect(r.emailed).toBe(1);
    expect(r.whatsapp).toBe('not_ready');
    expect(emails().map((c) => c.body.to)).toEqual(['parent@test.org']);
  });

  it('does both when it can', async () => {
    const h = await household('Ismail', { email: 'parent@test.org' });
    await turnOn();
    await h.admin.whatsapp.set({ testStudentId: h.studentId });
    calls = [];
    const r = await h.admin.whatsapp.testSend();
    expect(r.emailed).toBe(1);
    expect(r.whatsapp).toBe('queued');
  });

  it('still refuses with no test student at all', async () => {
    const admin = caller('admin');
    await turnOn();
    await expect(admin.whatsapp.testSend()).rejects.toThrow(/test student/i);
  });

  it('fails honestly when the household can be reached on neither channel', async () => {
    const h = await household('Ismail', { phone: 'ask mum' });
    await h.admin.whatsapp.set({ enabled: true, testStudentId: h.studentId });
    waAvailable = { available: false, reason: 'not-configured' };
    whatsapp.resetWhatsAppStatusCache();
    await expect(h.admin.whatsapp.testSend()).rejects.toThrow(/nothing could be sent/i);
  });
});

// -- Staff alerts to a group -------------------------------------------------
/**
 * A group here is a STAFF channel — a masjid's finance group getting every payment alert — and not a
 * way to reach parents. Two things have to hold, and both are the kind that fail silently:
 *
 *  • **A parent's business never reaches a group.** Per-family sends call `sendPlatformWhatsApp`,
 *    which has no parameter that can name a group; group alerts call `sendPlatformWhatsAppGroup`,
 *    which has no parameter that can name a person. The wire is asserted in both directions.
 *  • **`detail` decides which of an alert's two texts a group gets**, and defaults to the one that
 *    names nobody. This app cannot see who is in a group; getting that default backwards would put a
 *    family's balance in front of everyone in it.
 */
describe('staff alerts to a group', () => {
  /** Subscribe the approved group to one alert. */
  async function subscribe(events: string[], detail = false) {
    const admin = caller('admin');
    await admin.whatsapp.groupSet({ groupId: '1203630001@g.us', events: events as ('autopay-disabled')[], detail });
    return admin;
  }
  const posts = () => calls.filter((c) => c.url.endsWith('/api/fabric/whatsapp') && typeof c.body.group === 'string');

  it('sends an alert to a subscribed group, with `group` and never a `to`', async () => {
    await turnOn();
    await subscribe(['autopay-disabled']);
    calls = [];
    await alerts.alertStaff('autopay-disabled', { title: 'Autopay off', text: 'Ismail family — three failures.', publicText: 'Autopay was turned off for a family.' });
    await drain();
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body.group).toBe('1203630001@g.us');
    expect(posts()[0].body.to).toBeUndefined();
  });

  it('sends nothing to a group that is not subscribed to that alert', async () => {
    await turnOn();
    await subscribe(['payment-received']);
    calls = [];
    await alerts.alertStaff('autopay-disabled', { title: 'T', text: 'B', publicText: 'B' });
    await drain();
    expect(posts()).toHaveLength(0);
  });

  /** The default. A group gets the text that names nobody until an admin says otherwise. */
  it('names no household by default', async () => {
    await turnOn();
    await subscribe(['autopay-disabled']);
    calls = [];
    await alerts.alertStaff('autopay-disabled', { title: 'Autopay off', text: 'Ismail family — three failures.', publicText: 'Autopay was turned off for a family.' });
    await drain();
    const text = String(posts()[0].body.text);
    expect(text).not.toContain('Ismail');
    expect(text).toContain('Autopay was turned off for a family');
  });

  it('names the household once an admin turns detail on for that group', async () => {
    await turnOn();
    await subscribe(['autopay-disabled'], true);
    calls = [];
    await alerts.alertStaff('autopay-disabled', { title: 'Autopay off', text: 'Ismail family — three failures.', publicText: 'Autopay was turned off for a family.' });
    await drain();
    expect(String(posts()[0].body.text)).toContain('Ismail');
  });

  /** The other half of the wall: a per-family message must never grow a `group` field. */
  it('a household message never carries a group', async () => {
    const h = await household('Ismail');
    await turnOn();
    calls = [];
    await whatsapp.notifyFamily('receipt', h.familyId, 'receipt', { amount: '$50.00' });
    expect(sends()).toHaveLength(1);
    expect(sends()[0].body.group).toBeUndefined();
    expect(sends()[0].body.to).toBe('+15551234567');
  });

  /** The PARENT pause is a switch about writing to families. An office that paused it while importing
   *  a roster still wants to know when a card fails — exactly as for a staff member's own number. */
  it('is not held by the parent pause', async () => {
    await turnOn('receipt', { paused: true });
    await subscribe(['autopay-disabled']);
    calls = [];
    await alerts.alertStaff('autopay-disabled', { title: 'T', text: 'B', publicText: 'B' });
    await drain();
    expect(posts()).toHaveLength(1);
  });

  it('refuses a group the admin has not approved, and an event id it does not know', async () => {
    const admin = caller('admin');
    await turnOn();
    await expect(admin.whatsapp.groupSet({ groupId: 'never@g.us', events: ['autopay-disabled'] })).rejects.toThrow(/approved/i);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately invalid input
    await expect(admin.whatsapp.groupSet({ groupId: '1203630001@g.us', events: ['everything'] as any })).rejects.toThrow();
  });

  it('lists the approved groups with what each one hears, and hides the feature when there are none', async () => {
    const admin = caller('admin');
    await turnOn();
    await subscribe(['autopay-disabled', 'past-due'], true);
    const got = await admin.whatsapp.groups();
    expect(got.groups).toHaveLength(1);
    expect(got.groups[0].events.sort()).toEqual(['autopay-disabled', 'past-due']);
    expect(got.groups[0].detail).toBe(true);
    groupList = [];
    expect((await admin.whatsapp.groups()).groups).toEqual([]);
  });

  it('unticking the last alert leaves no setting behind', async () => {
    await turnOn();
    const admin = await subscribe(['autopay-disabled']);
    await admin.whatsapp.groupSet({ groupId: '1203630001@g.us', events: [] });
    expect((await admin.whatsapp.groups()).groups[0].events).toEqual([]);
  });

  it('has a fixed test message, and logs the group by label without the text', async () => {
    const admin = caller('admin');
    await turnOn();
    groupList = [{ id: 'g1@g.us', label: 'Finance' }];
    calls = [];
    await admin.whatsapp.groupTest({ groupId: 'g1@g.us' });
    expect(posts()).toHaveLength(1);
    expect(String(posts()[0].body.text)).toContain('test');
    const log = await admin.whatsapp.log({});
    expect(log[0]).toMatchObject({ kind: 'group', who: 'Finance', status: 'queued' });
    expect(JSON.stringify(log)).not.toContain('If you can read this');
  });

  it('is admin-only', async () => {
    await expect(caller('finance').whatsapp.groups()).rejects.toThrow(/access/i);
    await expect(caller('finance').whatsapp.groupSet({ groupId: 'g1@g.us', events: [] })).rejects.toThrow(/access/i);
    await expect(caller('finance').whatsapp.groupTest({ groupId: 'g1@g.us' })).rejects.toThrow(/access/i);
  });
});

// ── Settings ────────────────────────────────────────────────────────────────
describe('the settings themselves', () => {
  it('start off, paused, and with no event switched on', async () => {
    const got = await caller('admin').whatsapp.get();
    expect(got.enabled).toBe(false);
    expect(got.paused).toBe(true);
    expect(got.events).toEqual({});
  });

  it('refuse a country code that is not one', async () => {
    const admin = caller('admin');
    await expect(admin.whatsapp.set({ defaultCountry: 'US' })).rejects.toThrow(/country code/i);
    await expect(admin.whatsapp.set({ countries: ['+1', 'x'] })).rejects.toThrow(/country code/i);
    await admin.whatsapp.set({ countries: ['+44'] });
    // The default is always in the list — it is what every unset number falls back to.
    expect((await admin.whatsapp.get()).countries).toContain('+1');
  });

  it('refuse a test student who is not on the roll', async () => {
    await expect(caller('admin').whatsapp.set({ testStudentId: 'stu_nope' })).rejects.toThrow(/roll/i);
  });

  it('are admin-only, and unreachable by an admin over the tunnel', async () => {
    await expect(caller('finance').whatsapp.get()).rejects.toThrow(/access/i);
    await expect(caller('parent').whatsapp.set({ enabled: true })).rejects.toThrow(/access/i);
    const overTunnel = app.appRouter.createCaller(makeCtx({ origin: 'tunnel', session: { role: 'admin', source: 'local', username: 'admin', userId: 'usr_admin' } }).ctx);
    await expect(overTunnel.whatsapp.get()).rejects.toThrow(/masjid network/i);
  });

  it('report each of the platform’s four states so the screen can say the right thing', async () => {
    const admin = caller('admin');
    for (const reason of ['ready', 'not-configured', 'not-linked', 'unreachable'] as const) {
      waAvailable = { available: reason === 'ready', reason };
      whatsapp.resetWhatsAppStatusCache();
      const s = await admin.whatsapp.statusCheck();
      expect(s.reason).toBe(reason);
      expect(s.available).toBe(reason === 'ready');
    }
  });
});

/**
 * The same shape of guard as the alert-manifest test, for the same reason: declaring the capability is
 * what authorizes the calls, and without it every send is answered 403 — fail-soft, and therefore
 * completely invisible.
 */
describe('the manifest and the screen agree with the code', () => {
  it('declares the whatsapp capability', () => {
    const manifest = readFileSync(path.resolve(__dirname, '..', '..', '..', 'manifest.yaml'), 'utf8');
    expect(manifest).toMatch(/^whatsapp:\s*true\s*$/m);
  });

  /** `settings.ev_payment-refunded` once reached a masjid's screen as a raw key. i18next renders a
   *  missing key rather than failing, so the only place these can be held together is a test. */
  it('has a label and a hint for every parent event', () => {
    const en = JSON.parse(readFileSync(path.resolve(__dirname, '..', '..', 'web', 'src', 'lib', 'i18n', 'en.json'), 'utf8')) as { settings: Record<string, string> };
    for (const e of whatsapp.WA_PARENT_EVENTS) {
      expect(en.settings[`waEv_${e}`], `missing i18n key settings.waEv_${e}`).toBeTruthy();
      expect(en.settings[`waEvHint_${e}`], `missing i18n key settings.waEvHint_${e}`).toBeTruthy();
    }
  });

  /** …and a heading for every editable message. The wording screen renders one box per key, so a
   *  missing label prints the raw key at a masjid exactly as `settings.ev_payment-refunded` once did. */
  it('has a heading for every message an office can rewrite', async () => {
    const templates = await import('../src/whatsapp/templates');
    const en = JSON.parse(readFileSync(path.resolve(__dirname, '..', '..', 'web', 'src', 'lib', 'i18n', 'en.json'), 'utf8')) as { settings: Record<string, string> };
    for (const k of templates.WA_TEXT_KEYS) {
      expect(en.settings[`waText_${k}`], `missing i18n key settings.waText_${k}`).toBeTruthy();
      // Every message must also offer at least one tag, or the editor shows an empty "You can use:".
      expect(templates.WA_TEXT_TAGS[k]?.length, `no tags declared for ${k}`).toBeGreaterThan(0);
      expect(templates.WA_TEXT_DEFAULTS[k], `no shipped sentence for ${k}`).toBeTruthy();
    }
  });

  /** One sentence per reason, because each needs something different done about it. */
  it('has a sentence for each gateway state, including the two we infer ourselves', () => {
    const en = JSON.parse(readFileSync(path.resolve(__dirname, '..', '..', 'web', 'src', 'lib', 'i18n', 'en.json'), 'utf8')) as { settings: Record<string, string> };
    for (const r of ['ready', 'not-configured', 'not-linked', 'unreachable', 'not-permitted', 'unsupported']) {
      expect(en.settings[`waReason_${r}`], `missing i18n key settings.waReason_${r}`).toBeTruthy();
      // …and the blocker banner names it too, for the ones that stop a send.
      if (r !== 'ready') expect(en.settings[`waBlock_gateway_${r}`], `missing i18n key settings.waBlock_gateway_${r}`).toBeTruthy();
    }
  });
});

/**
 * Telling apart "the masjid has no WhatsApp" from "this app is not allowed to use it".
 *
 * A masjid with a working, linked gateway was told their server had no WhatsApp set up, and went and
 * checked a setting that was already correct — because a 403 was reported as `not-configured`. The
 * two need opposite actions: one is an OpenMasjidOS setting, the other is this app's own capability
 * grant, which comes from the catalog entry the masjid installed from (§9, the same trap as alert ids).
 */
describe('what the gateway actually said', () => {
  async function probe() {
    whatsapp.resetWhatsAppStatusCache();
    return caller('admin').whatsapp.statusCheck();
  }

  it('reports a refusal as not-permitted, never as "not set up"', async () => {
    statusHttp = 403;
    const s = await probe();
    expect(s.reason).toBe('not-permitted');
    expect(s.source).toBe('http');
    expect(s.httpStatus).toBe(403);
  });

  it('reports a missing endpoint as unsupported', async () => {
    statusHttp = 404;
    expect((await probe()).reason).toBe('unsupported');
    statusHttp = 405;
    expect((await probe()).reason).toBe('unsupported');
  });

  it('keeps the platform’s own word when it answers properly, and says the word came from there', async () => {
    waAvailable = { available: false, reason: 'not-linked' };
    const s = await probe();
    expect(s.reason).toBe('not-linked');
    expect(s.source).toBe('platform');
  });

  /** A 200 with a word we don't know is a client that is out of date, not a gateway that is off — so
   *  it must not claim "not set up" either. */
  it('does not invent "not-configured" for an answer it cannot read', async () => {
    waAvailable = { available: false, reason: 'something-new' };
    expect((await probe()).reason).toBe('unreachable');
  });

  it('carries the distinction all the way to the blocker list', async () => {
    const admin = caller('admin');
    await turnOn();
    statusHttp = 403;
    whatsapp.resetWhatsAppStatusCache();
    expect((await admin.whatsapp.get()).blockers).toContain('gateway_not-permitted');
  });
});
