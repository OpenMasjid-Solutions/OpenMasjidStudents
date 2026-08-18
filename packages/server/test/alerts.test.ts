// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Email alerts (0.44.0) — who hears what.
 *
 * Three things here are worth a test rather than a reading:
 *
 *  - **A recipient hears ONLY what it is subscribed to.** The filter is the entire feature; get it
 *    wrong and either a trustee is copied on every cash payment or the autopay-off alert reaches
 *    nobody, and both look like "alerts don't work".
 *  - **An alert email does not depend on the OpenMasjidOS alert list.** `raiseAlert` 400s for any id
 *    the installed catalog entry doesn't declare (which is how `payment-short` was silently dropped
 *    for a whole release). Our own email must go out anyway — that is why this path exists.
 *  - **The parent-email switches actually gate.** They are checked inside mail/notify.ts rather than
 *    at each of the five call sites, so the test is on the sender, not on any one caller.
 *
 * `fetch` is stubbed, so nothing leaves the machine; the assertions are on the requests we build.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { freshApp, makeCtx } from './harness';
import { alertRecipients, guardians, guardianFamilies, families, students, settings, auditLog, studentFees, feePlans, payments, paymentAllocations, invoiceItems, invoices } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let alerts: typeof import('../src/alerts');
let notify: typeof import('../src/mail/notify');

const caller = (role: Role) => app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

/** Every fetch the code under test made, in order. */
interface Call {
  url: string;
  body: Record<string, unknown>;
}
let calls: Call[] = [];
/** What the platform answers. Defaults to "the alert id is unknown" + "the email sent", which is the
 *  combination that matters most: a masjid on an older catalog entry must still be told by email. */
let alertStatus = 400;
let emailReply: { status: number; json: unknown } = { status: 200, json: { sent: true } };
const realFetch = globalThis.fetch;

function installFetch(): void {
  globalThis.fetch = vi.fn(async (input: unknown, init?: unknown) => {
    const i = (init ?? {}) as { body?: string };
    const url = String(input);
    calls.push({ url, body: i.body ? (JSON.parse(i.body) as Record<string, unknown>) : {} });
    if (url.endsWith('/api/fabric/alert')) return { ok: alertStatus < 300, status: alertStatus, json: async () => ({}) } as unknown as Response;
    if (url.endsWith('/api/fabric/email')) return { ok: emailReply.status < 300, status: emailReply.status, json: async () => emailReply.json } as unknown as Response;
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
}

const emailCalls = () => calls.filter((c) => c.url.endsWith('/api/fabric/email'));
const alertCalls = () => calls.filter((c) => c.url.endsWith('/api/fabric/alert'));

beforeAll(async () => {
  // fabric: true — without a base URL + secret there is no transport at all and every send no-ops.
  app = await freshApp({ fabric: true });
  alerts = await import('../src/alerts');
  notify = await import('../src/mail/notify');
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, students, guardianFamilies, guardians, families, alertRecipients, settings, auditLog]) db.delete(t).run();
  calls = [];
  alertStatus = 400;
  emailReply = { status: 200, json: { sent: true } };
  installFetch();
});

describe('the recipient list', () => {
  it('starts a new address on the alerts that cost money — and NOT on every payment', async () => {
    const admin = caller('admin');
    await admin.settings.alertRecipientSave({ email: 'Treasurer@Test.org', label: 'Treasurer' });
    const got = await admin.settings.alertsGet();
    expect(got.recipients).toHaveLength(1);
    const r = got.recipients[0];
    // Lowercased on the way in, so the same person cannot subscribe twice and get everything twice.
    expect(r.email).toBe('treasurer@test.org');
    expect(r.label).toBe('Treasurer');
    expect(r.events).toEqual(expect.arrayContaining(['autopay-disabled', 'lookup-lockout', 'payment-recovered', 'payment-short']));
    expect(r.events).not.toContain('payment-received');
    expect(r.events).not.toContain('invoices-generated');
  });

  it('re-adding the same address updates it instead of failing on the unique index', async () => {
    const admin = caller('admin');
    const first = await admin.settings.alertRecipientSave({ email: 'office@test.org' });
    const again = await admin.settings.alertRecipientSave({ email: 'OFFICE@test.org', label: 'Office' });
    expect(again.id).toBe(first.id);
    const got = await admin.settings.alertsGet();
    expect(got.recipients).toHaveLength(1);
    expect(got.recipients[0].label).toBe('Office');
  });

  it('refuses an event id the server does not know', async () => {
    const admin = caller('admin');
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately invalid input
      admin.settings.alertRecipientSave({ email: 'x@test.org', events: ['everything'] as any }),
    ).rejects.toThrow();
  });

  it('is admin-only: finance and parents cannot read or change it', async () => {
    await expect(caller('finance').settings.alertsGet()).rejects.toThrow(/access/i);
    await expect(caller('finance').settings.alertRecipientSave({ email: 'f@test.org' })).rejects.toThrow(/access/i);
    await expect(caller('parent').settings.alertsGet()).rejects.toThrow(/access/i);
    // …and an admin cookie presented over the tunnel is refused too (§12.4).
    const overTunnel = app.appRouter.createCaller(makeCtx({ origin: 'tunnel', session: { role: 'admin', source: 'local', username: 'admin', userId: 'usr_admin' } }).ctx);
    await expect(overTunnel.settings.alertsGet()).rejects.toThrow(/masjid network/i);
  });

  it('removing an address stops it hearing anything', async () => {
    const admin = caller('admin');
    const { id } = await admin.settings.alertRecipientSave({ email: 'gone@test.org' });
    await admin.settings.alertRecipientRemove({ id });
    expect((await admin.settings.alertsGet()).recipients).toHaveLength(0);
    calls = [];
    await alerts.alertStaff('autopay-disabled', { title: 'T', text: 'B', publicText: 'B' });
    expect(emailCalls()).toHaveLength(0);
  });
});

describe('dispatch', () => {
  it('emails exactly the addresses subscribed to that event', async () => {
    const admin = caller('admin');
    // Subscribed to the default set (includes autopay-disabled, excludes payment-received).
    await admin.settings.alertRecipientSave({ email: 'treasurer@test.org' });
    // Subscribed to payments only.
    await admin.settings.alertRecipientSave({ email: 'imam@test.org', events: ['payment-received'] });
    calls = [];

    await alerts.alertStaff('autopay-disabled', { title: 'Autopay switched off', text: 'Ismail family — three failures.', publicText: 'Autopay was turned off for a family.' });
    expect(emailCalls().map((c) => c.body.to)).toEqual(['treasurer@test.org']);

    calls = [];
    await alerts.alertStaff('payment-received', { title: 'Payment', text: 'Ismail family paid $50.', publicText: 'A tuition payment of $50 was received.' });
    expect(emailCalls().map((c) => c.body.to)).toEqual(['imam@test.org']);
  });

  it('still emails the office when OpenMasjidOS rejects the alert id (the 0.43.0 payment-short case)', async () => {
    const admin = caller('admin');
    await admin.settings.alertRecipientSave({ email: 'office@test.org' });
    calls = [];
    alertStatus = 400; // "Unknown alert" — an older catalog entry

    await alerts.alertStaff('payment-short', { title: 'Partly recorded', text: 'Check the family’s record.', publicText: 'A payment was only partly recorded.' });

    // The platform was asked (and refused) — and the email went anyway.
    expect(alertCalls()).toHaveLength(1);
    expect(alertCalls()[0].body.alert).toBe('payment-short'); // the field the platform reads is `alert`
    expect(emailCalls()).toHaveLength(1);
    expect(emailCalls()[0].body.to).toBe('office@test.org');
    expect(String(emailCalls()[0].body.subject)).toContain('Partly recorded');
  });

  /**
   * §14. The masjid webhook is usually a Slack or Discord channel, and the platform's alert delivery is
   * not ours to reason about — so neither may carry a family's name beside an amount. Our OWN email to
   * an address the admin typed may, and must, or the alert is not actionable. `publicText` is a required
   * field precisely so this cannot be forgotten at a call site.
   */
  it('names the household by email but NEVER on the webhook or the platform alert channel', async () => {
    const admin = caller('admin');
    await admin.settings.alertRecipientSave({ email: 'office@test.org', events: ['payment-received', 'autopay-disabled'] });
    calls = [];

    // payment-received is the one event that also posts to the masjid webhook.
    await alerts.alertStaff('payment-received', {
      title: 'Tuition payment received',
      text: 'Ismail family paid $50.00 (cash).',
      publicText: 'A tuition payment of $50.00 was received (cash).',
    });
    const webhook = calls.find((c) => c.url.endsWith('/api/fabric/notify'))!;
    expect(webhook).toBeDefined();
    expect(String(webhook.body.text)).not.toContain('Ismail');
    expect(String(emailCalls()[0].body.text)).toContain('Ismail');

    calls = [];
    await alerts.alertStaff('autopay-disabled', {
      title: 'Autopay switched off',
      text: 'Ismail family had three failed card charges.',
      publicText: 'Autopay was turned off for a family after three failed charge attempts.',
    });
    expect(String(alertCalls()[0].body.text)).not.toContain('Ismail');
    expect(String(emailCalls()[0].body.text)).toContain('Ismail');
  });

  it('never throws, even when the transport does', async () => {
    const admin = caller('admin');
    await admin.settings.alertRecipientSave({ email: 'office@test.org' });
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(alerts.alertStaff('autopay-disabled', { title: 'T', text: 'B' })).resolves.toBeUndefined();
  });

  /**
   * NAMES THE CHILD, NOT THE HOUSEHOLD (0.50.0-dev.14).
   *
   * These alerts said "the Ismail family paid $250" for six releases, which is one indirection away
   * from what the app bills: invoices and payments are per STUDENT (§9). Worse, the household label is
   * DERIVED from the children's surnames, so a madrasah with four Ismail households gets four alerts
   * that read identically — the one thing a name is for.
   */
  describe('who an alert is about', () => {
    async function kids() {
      const admin = caller('admin');
      const fam = await admin.people.familyCreate({ name: 'Ismail' });
      const plan = await admin.billing.feePlanCreate({ name: 'Monthly tuition', amountCents: 5000, cadence: 'monthly' });
      const a = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });
      const b = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Maryam Ismail', feePlanId: plan.id });
      return { admin, familyId: fam.id, a: a.id, b: b.id };
    }

    it('names one child', async () => {
      const { a } = await kids();
      expect(alerts.studentName(a)).toBe('Yusuf Ismail');
      // An id that no longer resolves must not produce "undefined paid $50".
      expect(alerts.studentName('stu_nope')).toBe('A student');
    });

    it('breaks a split charge down per child, because that is how it was recorded', async () => {
      const { a, b } = await kids();
      const said = alerts.studentAmounts(
        [
          { studentId: a, amountCents: 15000 },
          { studentId: b, amountCents: 10000 },
        ],
        'usd',
      );
      expect(said).toBe('Yusuf Ismail $150.00 and Maryam Ismail $100.00');
    });

    it('names the children a card pays for, without claiming the card is theirs', async () => {
      const { familyId } = await kids();
      // Alphabetical, so the sentence does not depend on who was added first.
      expect(alerts.childrenOf(familyId)).toBe('Maryam Ismail and Yusuf Ismail');
    });

    it('does not let six children fill a page', async () => {
      const { admin, familyId } = await kids();
      const plan = await admin.billing.feePlanCreate({ name: 'Second', amountCents: 100, cadence: 'monthly' });
      for (const n of ['Ali Ismail', 'Bilal Ismail', 'Zayd Ismail']) await admin.people.studentCreate({ familyId, fullName: n, feePlanId: plan.id });
      expect(alerts.childrenOf(familyId)).toMatch(/and 1 other$/);
    });
  });
});

/**
 * The guard for a bug that shipped: `payment-short` was added to the alert union in 0.43.0 and to the
 * manifest in 0.44.0, so for a whole release every one of those alerts was answered 400 "Unknown
 * alert" and dropped — invisibly, because `raiseAlert` is deliberately fail-soft.
 *
 * Declaring an id in the manifest is what authorizes it; it also has to reach the CATALOG entry a
 * masjid installed from, which no test here can see. This checks the half that lives in this repo.
 */
describe('every alert id we can raise is declared in the manifest', () => {
  it('has no undeclared ids', () => {
    const manifest = readFileSync(path.resolve(__dirname, '..', '..', '..', 'manifest.yaml'), 'utf8');
    // Matched with a regex rather than a YAML parse to keep this dependency-free, like version.test.ts.
    const declared = [...manifest.matchAll(/^\s+-\s+id:\s*(\S+)\s*$/gm)].map((m) => m[1]);
    for (const id of alerts.platformAlertIds()) expect(declared).toContain(id);
  });

  /**
   * …and every EVENT an office can subscribe to has a label on the settings screen.
   *
   * The same shape of bug as the manifest one above, one layer out: `payment-refunded` was added to
   * `ALERT_EVENTS` in 0.48.0-dev.32 and the column heading was never added, so Settings → Email alerts
   * printed the raw key "settings.ev_payment-refunded" at a masjid. i18next has no missing-key error — it
   * renders the key — so nothing failed, and the list of events is generated FROM this union, which means
   * adding one always adds a column.
   *
   * Reaching across into the web package's `en.json` is deliberate: the union lives here, the label lives
   * there, and the only place they can be held together is a test.
   */
  it('has a settings label for every subscribable event', () => {
    const en = JSON.parse(readFileSync(path.resolve(__dirname, '..', '..', 'web', 'src', 'lib', 'i18n', 'en.json'), 'utf8')) as {
      settings: Record<string, string>;
    };
    for (const event of alerts.ALERT_EVENTS) {
      expect(en.settings[`ev_${event}`], `missing i18n key settings.ev_${event}`).toBeTruthy();
    }
  });
});

describe('what parents are emailed', () => {
  /** A family with one guardian who has an email, and one child on a plan. */
  async function household() {
    const admin = caller('admin');
    const fam = await admin.people.familyCreate({ name: 'Ismail' });
    await admin.people.guardianCreate({ familyId: fam.id, name: 'Abu Yusuf', email: 'parent@test.org' });
    const plan = await admin.billing.feePlanCreate({ name: 'Monthly tuition', amountCents: 5000, cadence: 'monthly' });
    const kid = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });
    return { admin, familyId: fam.id, studentId: kid.id };
  }

  it('sends a receipt by default, and stops when the office turns it off', async () => {
    const { admin, familyId } = await household();
    calls = [];
    expect(await notify.sendReceipt(familyId, '$50.00')).toBe(1);
    expect(emailCalls()[0].body.to).toBe('parent@test.org');
    // Wording rule (§11.3): a receipt is a PAYMENT, never a donation.
    expect(String(emailCalls()[0].body.text).toLowerCase()).toContain('payment');
    expect(String(emailCalls()[0].body.text).toLowerCase()).not.toContain('donation');

    await admin.settings.parentEmailsSet({ receipt: false });
    calls = [];
    expect(await notify.sendReceipt(familyId, '$50.00')).toBe(0);
    expect(emailCalls()).toHaveLength(0);
    // The other switch is independent — and the four added in 0.50.0 start OFF, because each is a
    // message the app never used to send (§ settings/getParentEmails).
    expect((await admin.settings.alertsGet()).parentEmails).toEqual({
      receipt: false,
      autopayFailure: true,
      invoiceReady: false,
      autopayUpcoming: false,
      cardExpiring: false,
      refund: false,
    });
  });

  it('gates the autopay-failure notice separately', async () => {
    const { admin, familyId } = await household();
    await admin.settings.parentEmailsSet({ autopayFailure: false });
    calls = [];
    expect(await notify.sendAutopayFailure(familyId, true)).toBe(0);
    expect(emailCalls()).toHaveLength(0);
  });

  /** Cash was the gap: five ways to pay and only two of them told the family anything (0.44.0). */
  it('a payment recorded by hand emails the parent a receipt', async () => {
    const { admin, familyId, studentId } = await household();
    await admin.billing.generateFamily({ familyId, periodKey: '2026-07', label: 'Tuition — Jul 2026', dueDate: '2026-07-01' });
    calls = [];
    await admin.billing.recordManualPayment({ studentId, amountCents: 5000, channel: 'cash', occurredAt: '2026-07-03' });
    // The send is fire-and-forget, so let the microtask queue drain before asserting.
    await new Promise((r) => setTimeout(r, 20));
    const receipt = emailCalls().find((c) => c.body.to === 'parent@test.org');
    expect(receipt).toBeDefined();
    expect(String(receipt!.body.subject)).toContain('$50.00');
  });
});
