// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The app→platform contract for mail and alerts (manifest `email:` / `alerts:`).
 *
 * These two calls are the reason the rest of the "why didn't the invite arrive" work is trustworthy,
 * and both have a failure mode that is invisible without a test:
 *
 *  - `POST /api/fabric/email` answers **HTTP 200** with `{ sent:false, reason }` when the masjid has
 *    not configured a mail provider. Trusting the status code reports a suppressed invite as
 *    delivered — worse than not sending, because nobody goes looking.
 *  - `POST /api/fabric/alert` reads the id from **`alert`**, not `id`, and 400s without it. Since
 *    `raiseAlert` is deliberately fail-soft, a wrong field name makes every security alert vanish
 *    silently. This asserts the wire shape, not just "we called something".
 *
 * `fetch` is stubbed so nothing leaves the machine; the assertions are on the request we build and
 * the response we interpret. Both mirror OpenMasjidOS `packages/core/src/api/fabric.ts`.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { freshApp } from './harness';

let platform: typeof import('../src/fabric/platform');
let notify: typeof import('../src/mail/notify');

/** Every fetch the code under test made, in order. */
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}
let calls: Call[] = [];
/** What the next fetch should answer. */
let reply: { status: number; json: unknown } = { status: 200, json: { sent: true } };
/** What `GET /api/fabric/site` answers — separate, because an invite needs BOTH a transport and an
 *  absolute public URL, and conflating the two is how a mail test passes for the wrong reason. */
let siteReply: { status: number; json: unknown } = {
  status: 200,
  json: { enabled: true, domain: 'masjid.test', publicUrl: 'https://masjid.test/students', basePath: '/students' },
};

const realFetch = globalThis.fetch;

/** The recording stub. Reinstalled per test, because a couple of cases below deliberately swap in a
 *  throwing one and must not leak that into the next test. */
function installFetch(): void {
  globalThis.fetch = vi.fn(async (input: unknown, init?: unknown) => {
    const i = (init ?? {}) as { method?: string; headers?: Record<string, string>; body?: string };
    calls.push({
      url: String(input),
      method: i.method ?? 'GET',
      headers: i.headers ?? {},
      body: i.body ? (JSON.parse(i.body) as Record<string, unknown>) : {},
    });
    const r = String(input).endsWith('/api/fabric/site') ? siteReply : reply;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.json,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

beforeAll(async () => {
  // fabric: true → OPENMASJID_BASE_URL + APP_SECRET are set, so fabricConfigured() is true and the
  // platform branch is reachable at all (the mail.test.ts suite deliberately runs without it).
  await freshApp({ fabric: true });
  platform = await import('../src/fabric/platform');
  notify = await import('../src/mail/notify');
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  calls = [];
  reply = { status: 200, json: { sent: true } };
  installFetch();
});

describe('POST /api/fabric/email — a 200 does not mean it sent', () => {
  it('sends the shape the platform reads, with our app secret', async () => {
    const ok = await platform.sendPlatformEmail('parent@test.org', 'Subject', 'Body', '<p>Body</p>');
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://platform.test/api/fabric/email');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['X-OpenMasjid-App-Secret']).toBe('test-secret');
    expect(calls[0].body).toEqual({ to: 'parent@test.org', subject: 'Subject', text: 'Body', html: '<p>Body</p>' });
  });

  it('omits `html` entirely when there is none (the platform requires text OR html)', async () => {
    await platform.sendPlatformEmail('parent@test.org', 'S', 'T');
    expect(calls[0].body).toEqual({ to: 'parent@test.org', subject: 'S', text: 'T' });
    expect('html' in calls[0].body).toBe(false);
  });

  // The regression this file exists for. Every one of these is HTTP 200.
  for (const reason of ['not_configured', 'bad_recipient', 'empty', 'rate_limited', 'error']) {
    it(`returns false on 200 { sent:false, reason:"${reason}" }`, async () => {
      reply = { status: 200, json: { sent: false, reason } };
      expect(await platform.sendPlatformEmail('parent@test.org', 'S', 'T')).toBe(false);
    });
  }

  it('returns false when the platform rejects us outright (403 — capability not granted yet)', async () => {
    reply = { status: 403, json: { sent: false, error: 'This app is not allowed to send email.' } };
    expect(await platform.sendPlatformEmail('parent@test.org', 'S', 'T')).toBe(false);
  });

  it('returns false — never throws — when the body is not JSON at all', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }) as unknown as Response) as unknown as typeof fetch;
    expect(await platform.sendPlatformEmail('parent@test.org', 'S', 'T')).toBe(false);
  });
});

describe('an unsent platform email must not be reported as emailed', () => {
  // sendInvite needs BOTH a transport and an absolute public URL. Learn the URL from the (stubbed)
  // platform first, or every assertion below passes for the wrong reason — it would short-circuit on
  // `no_public_url` and never reach the mail call at all.
  beforeEach(async () => {
    const info = await platform.refreshSiteInfo();
    expect(info?.publicUrl).toBe('https://masjid.test/students');
    calls = [];
  });

  it('sendInvite reports sent:false when the platform suppressed it — and NOT as a skip', async () => {
    // No local SMTP in this harness, so deliver() goes straight to the platform.
    reply = { status: 200, json: { sent: false, reason: 'not_configured' } };
    const out = await notify.sendInvite('parent@test.org', 'https://x.test/family/invite?token=t', 'Abu Yusuf');
    expect(out).toEqual({ sent: false });
    // Proof it really attempted the send rather than bailing out earlier.
    expect(calls.map((c) => c.url)).toContain('http://platform.test/api/fabric/email');
  });

  it('...and sent:true when it really did send', async () => {
    reply = { status: 200, json: { sent: true } };
    const out = await notify.sendInvite('parent@test.org', 'https://x.test/family/invite?token=t', 'Abu Yusuf');
    expect(out).toEqual({ sent: true });
  });

  it('a receipt reaches every guardian through the platform, one call each', async () => {
    reply = { status: 200, json: { sent: true } };
    // sendReceipt has no public-URL requirement (it just drops the portal button), and with no local
    // SMTP it must use the per-recipient platform loop.
    const before = calls.length;
    const n = await notify.sendReceipt('fam_does_not_exist', '$50.00');
    // No guardians for an unknown family → nothing sent, and nothing attempted.
    expect(n).toBe(0);
    expect(calls.length).toBe(before);
  });
});

describe('POST /api/fabric/alert — the id field is `alert`, not `id`', () => {
  it('puts the alert id in `alert` (sending `id` makes the platform 400 and the alert vanish)', async () => {
    reply = { status: 200, json: { delivered: true } };
    const ok = await platform.raiseAlert('pin-lockout', 'A lookup was locked.', { title: 'Tuition lookup locked' });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://platform.test/api/fabric/alert');
    expect(calls[0].body.alert).toBe('pin-lockout');
    // Guard against a regression back to the wrong key.
    expect('id' in calls[0].body).toBe(false);
    expect(calls[0].body.text).toBe('A lookup was locked.');
    expect(calls[0].body.title).toBe('Tuition lookup locked');
  });

  it('defaults to the platform severity `warning` (not notifyPlatform\'s `warn`)', async () => {
    reply = { status: 200, json: { delivered: true } };
    await platform.raiseAlert('pin-lockout', 'x');
    expect(calls[0].body.level).toBe('warning');
  });

  it('carries an explicit level through — a recovered payment is info, not a warning', async () => {
    reply = { status: 200, json: { delivered: true } };
    await platform.raiseAlert('reconcile-recovered', 'x', { level: 'info' });
    expect(calls[0].body.level).toBe('info');
  });

  it('returns false on 400 (an id the installed catalog entry does not declare)', async () => {
    reply = { status: 400, json: { delivered: false, error: 'Unknown alert "test"' } };
    expect(await platform.raiseAlert('test', 'x')).toBe(false);
  });

  it('never throws when the platform is unreachable', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await expect(platform.raiseAlert('autopay-disabled', 'x')).resolves.toBe(false);
  });
});

describe('no PII leaves the app', () => {
  it('an alert body carries no student PIN, name, or amount-with-name', async () => {
    reply = { status: 200, json: { delivered: true } };
    // These are the exact strings the four call sites use (fabric/provider.ts, trpc/auth.ts,
    // payments/autopay.ts, payments/reconcile.ts) — none may name a person or a PIN (§14).
    await platform.raiseAlert('pin-lockout', 'A tuition name + PIN lookup was locked after repeated failed attempts.');
    const body = JSON.stringify(calls[0].body);
    expect(body).not.toMatch(/\d{6}/); // no 6-digit PIN
    expect(body.toLowerCase()).not.toContain('yusuf');
  });
});
