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
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
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
/**
 * What the platform answers a webhook post with — and the default is the REAL contract, not a bare 200.
 *
 * `POST /api/fabric/notify` ends `reply.send(result)` where result is `{ delivered: true }` or
 * `{ delivered: false, reason }`, so a webhook that is disabled, has a bad URL, is rate limited or
 * answered 404 all come back **HTTP 200**. The stub used to fall through to `json: () => ({})`, which
 * is a shape the platform never sends and which quietly made every delivery look indeterminate.
 */
let notifyReply: { status: number; json: unknown } = { status: 200, json: { delivered: true } };
const realFetch = globalThis.fetch;

function installFetch(): void {
  globalThis.fetch = vi.fn(async (input: unknown, init?: unknown) => {
    const i = (init ?? {}) as { body?: string };
    const url = String(input);
    calls.push({ url, body: i.body ? (JSON.parse(i.body) as Record<string, unknown>) : {} });
    if (url.endsWith('/api/fabric/alert')) return { ok: alertStatus < 300, status: alertStatus, json: async () => ({}) } as unknown as Response;
    if (url.endsWith('/api/fabric/email')) return { ok: emailReply.status < 300, status: emailReply.status, json: async () => emailReply.json } as unknown as Response;
    if (url.endsWith('/api/fabric/notify')) return { ok: notifyReply.status < 300, status: notifyReply.status, json: async () => notifyReply.json } as unknown as Response;
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
  notifyReply = { status: 200, json: { delivered: true } };
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
   *
   * This is the DEFAULT half of that rule (the test's name says so since 0.51.0-dev.17). An office may
   * switch its own webhook to the naming text for payment notices; the describe block below covers that,
   * and this test must keep passing untouched — if you find yourself relaxing it, the default has
   * drifted. The platform alert channel has no such switch and this remains absolute for it.
   */
  it('names the household by email but NOT, BY DEFAULT, on the webhook or the platform alert channel', async () => {
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

  /**
   * THE WEBHOOK MAY BE OPENED, BY THE OFFICE, FOR PAYMENT NOTICES ONLY (0.51.0-dev.17).
   *
   * An office wanting "Yusuf paid $250" in their own staff channel is making the same deliberate choice
   * as typing an address into the alert list. What these pin down is that it is the ONLY thing that
   * changes: the default is untouched (the test above), the OpenMasjidOS alert channel never sees the
   * naming text whatever the setting says, and no other event inherits the permission.
   *
   * The fixture names share no substring, and that is load-bearing rather than fussy. CLAUDE.md records
   * a real incident where a past-due test's helper named a child "<household label> child", so an
   * assertion that the household name was gone passed on a substring of the student's name. 'Yusuf' and
   * 'Farooqi' cannot alias each other or the channel words.
   */
  describe('naming the child on the masjid webhook', () => {
    const NAMED = {
      title: 'Tuition payment received',
      text: '$250.00 paid for Yusuf Farooqi (cash), recorded by the office.',
      publicText: 'A tuition payment of $250.00 was received (cash).',
    };
    const webhookBody = () => String(calls.find((c) => c.url.endsWith('/api/fabric/notify'))!.body.text);

    it('sends the child name once an admin turns it on', async () => {
      const admin = caller('admin');
      await admin.settings.webhookNamesSet({ on: true });
      calls = [];
      await alerts.alertStaff('payment-received', NAMED);
      expect(webhookBody()).toContain('Yusuf Farooqi');
      // The name is the discriminating assertion; the amount appears in BOTH texts, so it is a control
      // that a message arrived and was parsed — not evidence of WHICH text. Labelling it the other way
      // round is how the line that does the real work gets weakened later.
      expect(webhookBody()).toContain('$250.00');
      expect(webhookBody()).toBe(NAMED.text);
    });

    it('goes back to the amount alone when it is switched off again', async () => {
      const admin = caller('admin');
      await admin.settings.webhookNamesSet({ on: true });
      await admin.settings.webhookNamesSet({ on: false });
      calls = [];
      await alerts.alertStaff('payment-received', NAMED);
      expect(webhookBody()).not.toContain('Yusuf');
      expect(webhookBody()).toContain('A tuition payment of $250.00');
    });

    /**
     * KEEPING THE TWO CHANNELS UNCONFUSABLE — and this one is worth reading, because the obvious test
     * for it is vacuous and was written that way first.
     *
     * `raiseAlert` sits one line above the webhook send and also takes `publicText`. The hazard is a
     * future edit that hoists the chosen text into a single shared variable and widens both channels at
     * once. Firing an alert cannot catch that: no event is both eligible to name on the webhook and
     * mapped to a platform alert id, so the hoisted value would be `publicText` anyway and an assertion
     * that "no name reached the alert channel" passes whether or not the bug is present. (Verified by
     * mutation — that test stayed green with the guard removed.)
     *
     * So this pins the REASON it is unobservable, which is the thing that could actually stop being
     * true: an event eligible to name a child on the webhook must have no platform id. Make one eligible
     * that has both, and the hoisting bug becomes reachable — so this fails first and says why.
     */
    it('never makes one event both webhook-naming and platform-alerting', () => {
      for (const e of alerts.webhookNamingEvents()) {
        expect(
          alerts.platformAlertIdFor(e),
          `${e} may name a child on the webhook AND raises a platform alert — the two texts can now be confused for one`,
        ).toBeNull();
      }
    });

    /**
     * ELIGIBILITY IS PER EVENT, and this is the guard on the design rather than on the code path.
     * `payment-received` is the only event with `webhook: true` today. If a later release adds the flag
     * to `past-due` (whose text is a roster of every child behind on fees, with amounts) or
     * `payment-refunded` (which names the invoice lines the money had paid for), it must NOT inherit an
     * office's consent to see a payment notice. This fails the moment a second event is made eligible,
     * which is the point: that decision needs its own reading of what the text contains.
     */
    it('declares exactly one event eligible to name a child on the webhook', () => {
      expect(alerts.webhookNamingEvents()).toEqual(['payment-received']);
    });

    /**
     * The eligibility half of the gate, asked directly.
     *
     * It cannot be reached through `alertStaff` today: `payment-received` is the only event with
     * `webhook: true`, so firing an ineligible event posts nothing to the webhook and an assertion that
     * no name arrived would pass because no message did. That is the vacuous shape §20 warns about, so
     * the rule is asked about the events that matter instead — the two whose text must never go to a
     * channel we cannot see, with the office's switch fully ON.
     */
    it('refuses the naming text for an ineligible event even with the setting on', async () => {
      await caller('admin').settings.webhookNamesSet({ on: true });
      const roster = {
        title: '2 students are past due',
        text: 'Yusuf Farooqi owes $250.00 and Maryam Farooqi owes $100.00.',
        publicText: '2 students are past due.',
      };
      expect(alerts.webhookTextFor('past-due', roster)).toBe(roster.publicText);
      const refund = {
        title: 'A payment was refunded',
        text: 'A $250.00 refund for Yusuf Farooqi (Book fee) was recorded by the office.',
        publicText: 'A payment of $250.00 was refunded.',
      };
      expect(alerts.webhookTextFor('payment-refunded', refund)).toBe(refund.publicText);
      // …and the eligible one does take it, so this is not passing because the setting failed to save.
      expect(alerts.webhookTextFor('payment-received', NAMED)).toBe(NAMED.text);
    });

    /** Admin only — the same wall as the recipient list (§5). Finance must not be able to widen it. */
    it('is refused to finance', async () => {
      await expect(caller('finance').settings.webhookNamesSet({ on: true })).rejects.toThrow();
    });

    /**
     * A NOTIFICATION THAT WENT NOWHERE MUST NOT LOOK LIKE ONE THAT ARRIVED.
     *
     * These exist because the first version of this release's "we now log a webhook failure" change was
     * half a fix, and the half it had could never fire. It checked `res.ok` only — but the platform's
     * notify route ends `reply.send({ delivered, reason })` with an unconditional HTTP 200, so a webhook
     * that is disabled, misconfigured, rate limited or 404ing all come back 200 and were silently
     * treated as delivered. Meanwhile the ONE case a status check does catch is a 403 (this app lacking
     * the `notifications` capability), where blaming "the masjid's webhook" names something that was
     * never contacted.
     *
     * `sendPlatformEmail` in the same file documents this exact trap for the same endpoint family. Two
     * places disagreeing about one rule is this codebase's recurring bug shape (§20) — so the rule is
     * now the same in both, and pinned here.
     */
    describe('when the notification does not reach the webhook', () => {
      /**
       * `alertStaff` sends the webhook with `void notifyPlatform(...)` — fire and forget, deliberately,
       * because none of this belongs in the caller's critical path. So the log line lands two microtask
       * hops after `alertStaff` has already returned (past `await fetch` and `await res.json()`), and
       * asserting straight afterwards reads an empty array.
       *
       * Worth knowing what that cost the first draft of these tests: without a flush, one test's warning
       * landed inside the NEXT test's spy, so a test asserting silence passed on a message that was
       * merely late, and a test asserting a message passed on the previous one's. Draining before AND
       * after each test is what keeps each assertion about its own send.
       */
      const settle = async () => {
        for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      };
      let warns: string[] = [];
      beforeEach(async () => {
        await settle(); // anything still in flight from an earlier test logs before the spy goes on
        warns = [];
        vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
          warns.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
        });
      });
      afterEach(async () => {
        await settle(); // …and this test's own sends finish while its spy is still installed
        vi.mocked(console.warn).mockRestore();
      });

      it('says so on a 200 that reports it was not delivered', async () => {
        notifyReply = { status: 200, json: { delivered: false, reason: 'disabled' } };
        await alerts.alertStaff('payment-received', NAMED);
        await settle();
        expect(warns.join('\n')).toContain('disabled');
      });

      it('stays quiet when it really was delivered', async () => {
        notifyReply = { status: 200, json: { delivered: true } };
        await alerts.alertStaff('payment-received', NAMED);
        await settle();
        // Positive control first: without it this passes just as well on a send that never happened.
        expect(calls.some((c) => c.url.endsWith('/api/fabric/notify'))).toBe(true);
        expect(warns.join('\n')).not.toMatch(/webhook/i);
      });

      it('does not blame the masjid for a refusal by the platform', async () => {
        // 403 = this app does not hold the `notifications` capability. The webhook was never contacted.
        notifyReply = { status: 403, json: {} };
        await alerts.alertStaff('payment-received', NAMED);
        await settle();
        expect(warns.join('\n')).toContain('platform refused');
        expect(warns.join('\n')).not.toContain('masjid webhook did not receive');
      });

      /** §14: the reason is a fixed platform enum. The message we sent is never logged — and with the
       *  naming switch ON, the message is the one thing in this whole feature that names a child. */
      it('never logs the message body, even when it names a child and delivery failed', async () => {
        await caller('admin').settings.webhookNamesSet({ on: true });
        notifyReply = { status: 200, json: { delivered: false, reason: 'http_404' } };
        await settle();
        warns = [];
        await alerts.alertStaff('payment-received', NAMED);
        await settle();
        expect(warns.join('\n')).toContain('http_404'); // positive control: it really did log
        expect(warns.join('\n')).not.toContain('Yusuf');
        expect(warns.join('\n')).not.toContain('250');
      });
    });

    /** Both ways, so "when did this start?" is answerable from the trail. */
    it('is audited in both directions', async () => {
      const { db } = app.dbmod;
      const admin = caller('admin');
      await admin.settings.webhookNamesSet({ on: true });
      await admin.settings.webhookNamesSet({ on: false });
      const rows = db.select().from(auditLog).all().filter((r) => r.action === 'settings.webhookNames');
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => (r.detail as { on: boolean }).on)).toEqual([true, false]);
    });
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

  /**
   * The webhook toggle's own strings (0.51.0-dev.17), which the loop above cannot reach.
   *
   * That loop enumerates a server export, so it only ever covers `ev_*`. A hand-written key is invisible
   * to it and to every other guard in the repo — nothing fails, and i18next renders the raw key on an
   * admin's screen, which is precisely how `settings.ev_payment-refunded` once reached a masjid (§9). So
   * this enumerates them literally: the four keys the screen asks for, listed where somebody deleting one
   * will be told.
   *
   * `webhookNamesOn`/`Off` are the two halves of one sentence that changes with the switch, so a missing
   * one is a blank line at exactly the moment an admin is deciding whether to open a channel.
   */
  it('has the strings the webhook-naming toggle renders', () => {
    const en = JSON.parse(readFileSync(path.resolve(__dirname, '..', '..', 'web', 'src', 'lib', 'i18n', 'en.json'), 'utf8')) as {
      settings: Record<string, string>;
    };
    for (const key of ['webhookNames', 'webhookNamesLabel', 'webhookNamesOn', 'webhookNamesOff', 'webhookNamesCaveat']) {
      expect(en.settings[key], `missing i18n key settings.${key}`).toBeTruthy();
    }
    // The two states must actually differ, or the switch says the same thing whichever way it is set.
    expect(en.settings.webhookNamesOn).not.toBe(en.settings.webhookNamesOff);
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

/**
 * THE STORM GATE (0.51.0-dev.6).
 *
 * OpenMasjidOS removed the 60-second per-recipient cooldown that had been quietly absorbing
 * per-external-failure alerts, and Kiosk found out what that had been hiding: one alert per refused
 * card, all through jummah. Three of ours have the same shape — `lookup-lockout` (one per Student ID
 * a sweep locks), `payment-recovered` (raised per PaymentIntent, and a first reconcile looks back 35
 * days), and `login-blocked`.
 *
 * The tests that matter are the boundaries: that it actually suppresses a repeat, that the HELD COUNT
 * survives to the next alert (for a sweep the number is the entire signal), and — most importantly —
 * that it does NOT suppress the ordinary alerts, where two of a thing in an afternoon are two things
 * an office needs to see.
 */
describe('the storm gate', () => {
  async function recipient(events: string[]) {
    const admin = caller('admin');
    await admin.settings.alertRecipientSave({ email: 'treasurer@test.org', events: events as never[] });
    return admin;
  }

  const bodies = () => emailCalls().map((c) => String(c.body.text ?? ''));

  it('lets the first through and holds the rest', async () => {
    await recipient(['lookup-lockout']);
    calls = [];
    for (let i = 0; i < 5; i++) {
      await alerts.alertStaff('lookup-lockout', { title: 'A Student ID was locked', text: 'One was locked.', publicText: 'One was locked.' });
    }
    // Five sweeps, one email — not five.
    expect(emailCalls()).toHaveLength(1);
  });

  it('reports how many it held, because on a sweep the count IS the signal', async () => {
    await recipient(['lookup-lockout']);
    // First speaks, three are held.
    for (let i = 0; i < 4; i++) {
      await alerts.alertStaff('lookup-lockout', { title: 'A Student ID was locked', text: 'One was locked.', publicText: 'One was locked.' });
    }
    // Wind the clock past the window by rewriting the stored timestamp — the state is in settings
    // precisely so it survives a restart, which makes it addressable here too.
    const s = await import('../src/settings');
    const raw = JSON.parse(s.getSetting(s.SETTING_KEYS.alertStorm) ?? '{}');
    raw['lookup-lockout'].at = Date.now() - 31 * 60_000;
    s.setSetting(s.SETTING_KEYS.alertStorm, JSON.stringify(raw));
    calls = [];
    await alerts.alertStaff('lookup-lockout', { title: 'A Student ID was locked', text: 'One was locked.', publicText: 'One was locked.' });
    expect(emailCalls()).toHaveLength(1);
    expect(bodies()[0]).toContain('3 more like it');
  });

  it('does NOT gate an ordinary alert — two refunds are two things to know about', async () => {
    await recipient(['payment-refunded']);
    calls = [];
    for (let i = 0; i < 3; i++) {
      await alerts.alertStaff('payment-refunded', { title: 'A payment was refunded', text: 'Yusuf, $50.00.', publicText: 'A refund of $50.00 was made.' });
    }
    expect(emailCalls()).toHaveLength(3);
  });

  it('gates each event separately — a locked ID must not silence a recovered payment', async () => {
    await recipient(['lookup-lockout', 'payment-recovered']);
    calls = [];
    await alerts.alertStaff('lookup-lockout', { title: 'A Student ID was locked', text: 'One was locked.', publicText: 'One was locked.' });
    await alerts.alertStaff('lookup-lockout', { title: 'A Student ID was locked', text: 'One was locked.', publicText: 'One was locked.' });
    await alerts.alertStaff('payment-recovered', { title: 'A missed payment was recovered', text: 'Yusuf, $50.00.', publicText: 'A payment of $50.00 was recorded.' });
    // One lockout (the second held) plus the recovery = two.
    expect(emailCalls()).toHaveLength(2);
  });

  it('keeps the held count out of nobody-naming text, since a count names nobody', async () => {
    await recipient(['payment-recovered']);
    for (let i = 0; i < 3; i++) {
      await alerts.alertStaff('payment-recovered', { title: 'A missed payment was recovered', text: 'Yusuf, $50.00.', publicText: 'A payment of $50.00 was recorded.' });
    }
    const s = await import('../src/settings');
    const raw = JSON.parse(s.getSetting(s.SETTING_KEYS.alertStorm) ?? '{}');
    raw['payment-recovered'].at = Date.now() - 31 * 60_000;
    s.setSetting(s.SETTING_KEYS.alertStorm, JSON.stringify(raw));
    calls = [];
    await alerts.alertStaff('payment-recovered', { title: 'A missed payment was recovered', text: 'Yusuf, $50.00.', publicText: 'A payment of $50.00 was recorded.' });
    // The public text carries the count too — it is a number, not a person (§14).
    const pushed = calls.filter((c) => c.url.includes('/api/fabric/alert')).map((c) => String(c.body.message ?? c.body.text ?? ''));
    expect(pushed.some((m) => m.includes('2 more like it'))).toBe(true);
    expect(pushed.some((m) => m.includes('Yusuf'))).toBe(false);
  });
});
