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
let waAvailable = { available: true, reason: 'ready' };
/** The status the queue answers with. 202 is the real one; the others are the four documented refusals. */
let queueStatus = 202;
const realFetch = globalThis.fetch;

function installFetch(): void {
  globalThis.fetch = vi.fn(async (input: unknown, init?: unknown) => {
    const i = (init ?? {}) as { body?: string; method?: string };
    const url = String(input);
    calls.push({ url, body: i.body ? (JSON.parse(i.body) as Record<string, unknown>) : { _method: i.method ?? 'GET' } });
    if (url.endsWith('/api/fabric/whatsapp')) {
      if ((i.method ?? 'GET') === 'GET') return { ok: true, status: 200, json: async () => waAvailable } as unknown as Response;
      return { ok: queueStatus < 300, status: queueStatus, json: async () => ({ queued: queueStatus === 202 }) } as unknown as Response;
    }
    if (url.endsWith('/api/fabric/email')) return { ok: true, status: 200, json: async () => ({ sent: true }) } as unknown as Response;
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
}

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
  queueStatus = 202;
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
    const out = await whatsapp.notifyFamily('receipt', familyId, () => 'hello');
    expect(out.blocked).toBe('off');
    expect(sends()).toHaveLength(0);
  });

  it('sends nothing when the masjid has no gateway, whatever the app settings say', async () => {
    const { familyId } = await household('Ismail');
    await turnOn();
    waAvailable = { available: false, reason: 'not-linked' };
    whatsapp.resetWhatsAppStatusCache();
    calls = [];
    const out = await whatsapp.notifyFamily('receipt', familyId, () => 'hello');
    expect(out.blocked).toBe('unavailable');
    expect(sends()).toHaveLength(0);
  });

  it('sends nothing for an event that is switched off', async () => {
    const { familyId } = await household('Ismail');
    await turnOn('receipt');
    calls = [];
    const out = await whatsapp.notifyFamily('past-due', familyId, () => 'hello');
    expect(out.blocked).toBe('event_off');
    expect(sends()).toHaveLength(0);
  });

  it('queues to a household once everything is on', async () => {
    const { familyId } = await household('Ismail');
    await turnOn();
    calls = [];
    const out = await whatsapp.notifyFamily('receipt', familyId, () => 'Assalamu alaykum');
    expect(out.queued).toBe(1);
    expect(sends()).toHaveLength(1);
    expect(sends()[0].body.to).toBe('+15551234567');
    expect(sends()[0].body.text).toBe('Assalamu alaykum');
  });

  it('skips a guardian whose number cannot be read, and says so in the log', async () => {
    const { admin, familyId } = await household('Ismail', { phone: 'ask mum' });
    await turnOn();
    calls = [];
    const out = await whatsapp.notifyFamily('receipt', familyId, () => 'hi');
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
    const out = await whatsapp.notifyFamily('receipt', familyId, () => 'hi');
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
    const out = await whatsapp.notifyFamily('receipt', familyId, () => 'hi');
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

    expect((await whatsapp.notifyFamily('receipt', a.familyId, () => 'hi')).queued).toBe(1);
    expect((await whatsapp.notifyFamily('receipt', b.familyId, () => 'hi')).queued).toBe(0);
    expect(sends().map((c) => c.body.to)).toEqual(['+15551234567']);
  });

  /** A withdrawn or deleted test student must fail CLOSED: the exception stops, the pause holds. */
  it('stops being an exception when the student is no longer on the roll', async () => {
    const a = await household('Ismail');
    await turnOn('receipt', { paused: true });
    await a.admin.whatsapp.set({ testStudentId: a.studentId });
    await a.admin.people.studentUpdate({ id: a.studentId, status: 'withdrawn' });
    calls = [];
    expect((await whatsapp.notifyFamily('receipt', a.familyId, () => 'hi')).queued).toBe(0);
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
    const out = await whatsapp.notifyFamily('receipt', familyId, () => 'hi');
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
    expect((await whatsapp.notifyFamily('receipt', a.familyId, () => 'hi')).queued).toBe(0);
    expect(sends()).toHaveLength(0);
  });

  it('can be turned back on by the parent', async () => {
    const { familyId, guardianId } = await household('Ismail');
    await turnOn();
    const parent = await optOut(guardianId, familyId);
    expect((await parent.portal.messagingGet()).optedOut).toBe(true);
    await parent.portal.messagingSet({ optOut: false });
    expect((await parent.portal.messagingGet()).optedOut).toBe(false);
    calls = [];
    expect((await whatsapp.notifyFamily('receipt', familyId, () => 'hi')).queued).toBe(1);
  });

  it('shows the parent which number it is about, without printing it', async () => {
    const { familyId, guardianId } = await household('Ismail');
    await turnOn();
    const parent = await optOut(guardianId, familyId);
    const view = await parent.portal.messagingGet();
    expect(view.mask).toBe('···4567');
    expect(view.available).toBe(true);
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
    const secret = 'Yusuf owes $250 for November';
    await whatsapp.notifyFamily('receipt', familyId, () => secret);
    const rows = app.dbmod.db.select().from(whatsappLog).all();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('$250');
    expect(JSON.stringify(rows)).not.toContain(secret);
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

  /** One sentence per reason, because each needs something different done about it. */
  it('has a sentence for each of the four gateway states', () => {
    const en = JSON.parse(readFileSync(path.resolve(__dirname, '..', '..', 'web', 'src', 'lib', 'i18n', 'en.json'), 'utf8')) as { settings: Record<string, string> };
    for (const r of ['ready', 'not-configured', 'not-linked', 'unreachable']) {
      expect(en.settings[`waReason_${r}`], `missing i18n key settings.waReason_${r}`).toBeTruthy();
    }
  });
});
