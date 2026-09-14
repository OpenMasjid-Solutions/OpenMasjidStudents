// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * THE PUBLIC ADMISSIONS INQUIRY FORM, OVER REAL HTTP (0.52.0, CLAUDE.md §4a Phase 2 / §14).
 *
 * This is the only unauthenticated write surface in the project, so it gets the treatment
 * `statementRoute.test.ts` gives the printable documents: a real Fastify instance and `inject`,
 * rather than a tRPC caller. That is not a style choice. `createCaller` bypasses the error formatter,
 * the body cap and the real request — and every property this surface has to hold is a property of
 * what the INTERNET sees: the same bytes back whatever happened, the headers, the CSP, whether being
 * refused is distinguishable from being stored.
 *
 * The assertions below are the list in docs/ADMISSIONS.md §8, and the one they all rest on is the
 * first: **one response, always**. Any difference in body, status or shape answers "is this child,
 * this email, this family already known to you?" for anybody who asks — on a surface that, unlike
 * `lookup`, has no per-identifier lockout behind it.
 *
 * Two things this file is careful about, both learned from scars in this repo:
 *  - the rate limiters are module-level singletons that are never reset between tests, so every test
 *    here uses its OWN peer address and the ceiling test sets the cap rather than exhausting it;
 *  - every negative assertion has a positive control in the same test. "Nothing was stored" passes
 *    beautifully against a route that stores nothing at all.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { freshApp } from './harness';
import { inquiries, inquiryEvents, settings, auditLog } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let http: FastifyInstance;
let settingsMod: typeof import('../src/settings');
let routes: typeof import('../src/admissions/publicRoutes');

/** Every call the (stubbed) platform received, so the alert can be asserted on. */
let calls: { url: string; body: Record<string, unknown> }[] = [];
const realFetch = globalThis.fetch;

/** Fire-and-forget sends log and post two microtask hops after the handler returns. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

beforeAll(async () => {
  // fabric: true — without a base URL and secret there is no transport at all, and an assertion that
  // the alert went would pass for the wrong reason (or fail for one).
  app = await freshApp({ fabric: true });
  settingsMod = await import('../src/settings');
  routes = await import('../src/admissions/publicRoutes');
  http = Fastify();
  // A bare instance, like fabric.test.ts. It deliberately does NOT carry index.ts's 1 MiB body cap —
  // the route declares its own, which is the thing being tested.
  routes.registerPublicInquiryRoutes(http);
  await http.ready();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [inquiryEvents, inquiries, auditLog]) db.delete(t).run();
  // Clear THIS feature's settings rows by key. Wiping the whole table would drop rows other seeds
  // rely on, and leaving them lets one test's policy leak into the next.
  for (const key of ['admissions', 'admissions_text', 'school_name', 'school_logo']) {
    db.delete(settings).where(eq(settings.key, key)).run();
  }
  calls = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: unknown) => {
    const i = (init ?? {}) as { body?: string };
    calls.push({ url: String(input), body: i.body ? (JSON.parse(i.body) as Record<string, unknown>) : {} });
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
});

/** The form, switched on and open, unless a test says otherwise. */
function openForm(patch: Partial<import('../src/settings').AdmissionsConfig> = {}): void {
  settingsMod.setAdmissions({ publicForm: true, open: true, dailyMax: 1_000, minSeconds: 3, ...patch });
}

/** A token that says the form was rendered long enough ago to have been filled in by a person. */
const goodToken = () => routes.mintFormToken(Date.now() - 30_000);

let peerN = 0;
/** Each test gets its own source address — the limiters are process-wide singletons. */
const freshPeer = () => `10.77.${Math.floor(peerN / 250)}.${(peerN++ % 250) + 1}`;

function post(body: Record<string, unknown>, opts: { peer?: string; tunnel?: boolean } = {}) {
  return http.inject({
    method: 'POST',
    url: '/public/inquiry',
    remoteAddress: opts.peer ?? freshPeer(),
    headers: { 'content-type': 'application/json', ...(opts.tunnel ? { 'cf-ray': 'test-ray' } : {}) },
    payload: JSON.stringify(body),
  });
}

/** A complete, honest submission. */
const submission = (over: Record<string, unknown> = {}) => ({
  childName: 'Yusuf Ismail',
  parentName: 'Ibrahim Ismail',
  email: 'ibrahim@example.org',
  phone: '07700 900123',
  message: 'We would like to ask about a place for September.',
  t: goodToken(),
  ...over,
});

const rows = () => app.dbmod.db.select().from(inquiries).all();

describe('the door itself', () => {
  it('does not exist until an office opens it', async () => {
    // publicForm is false on every install: this is the only unauthenticated write surface in the
    // app, and it is not something a masjid should discover they had.
    expect(settingsMod.getAdmissions().publicForm).toBe(false);
    expect((await http.inject({ method: 'GET', url: '/public/inquiry' })).statusCode).toBe(404);
    expect((await http.inject({ method: 'GET', url: '/public/inquiry/embed' })).statusCode).toBe(404);
    expect((await http.inject({ method: 'GET', url: '/public/inquiry.js' })).statusCode).toBe(404);
    expect((await post(submission())).statusCode).toBe(404);
    expect(rows()).toHaveLength(0);
  });

  it('serves the form from BOTH origins once it is on — that is the point of it', async () => {
    openForm();
    // `cf-ray` is what origin.ts reads as a genuine Cloudflare tunnel. A family fills this in from
    // home; an office reads it back on the LAN, through an adminProcedure, which is the wall.
    const lan = await http.inject({ method: 'GET', url: '/public/inquiry' });
    const tunnel = await http.inject({ method: 'GET', url: '/public/inquiry', headers: { 'cf-ray': 'test-ray' } });
    expect(lan.statusCode).toBe(200);
    expect(tunnel.statusCode).toBe(200);
    expect(tunnel.body).toContain('<form');

    const posted = await post(submission(), { tunnel: true });
    expect(posted.statusCode).toBe(200);
    expect(rows()).toHaveLength(1);
  });
});

describe('one response, whatever happened', () => {
  /**
   * THE LOAD-BEARING TEST OF THIS WHOLE SURFACE.
   *
   * Seven outcomes, one of which stores a row. If any of them can be told apart from the outside,
   * submitting becomes a way to ask whether a child, an email or a household is already known — the
   * no-enumeration rule `lookup` follows (§11.2), applied where there is no lockout to fall back on.
   */
  it('answers with identical bytes for stored, duplicate, incomplete, honeypot, too-fast, closed and over-ceiling', async () => {
    openForm();
    const seen: { label: string; status: number; body: string }[] = [];

    const record = async (label: string, res: Awaited<ReturnType<typeof post>>) => {
      seen.push({ label, status: res.statusCode, body: res.body });
    };

    await record('stored', await post(submission({ childName: 'Aisha Khan' })));
    await record('duplicate', await post(submission({ childName: 'Aisha Khan' })));
    await record('incomplete', await post({ t: goodToken() }));
    await record('honeypot', await post(submission({ childName: 'Bilal Khan', website: 'http://spam.example' })));
    await record('too-fast', await post(submission({ childName: 'Maryam Khan', t: routes.mintFormToken(Date.now()) })));
    await record('forged-token', await post(submission({ childName: 'Hanif Khan', t: `${Date.now() - 30_000}.not-a-signature` })));

    settingsMod.setAdmissions({ open: false });
    await record('closed', await post(submission({ childName: 'Zainab Khan' })));

    settingsMod.setAdmissions({ open: true, dailyMax: 0 });
    await record('over-ceiling', await post(submission({ childName: 'Idris Khan' })));

    // Every one of them, byte for byte.
    expect(seen).toHaveLength(8);
    for (const s of seen) {
      expect(s.status, `${s.label} answered ${s.status}`).toBe(200);
      expect(s.body, `${s.label} answered a different body`).toBe('{"ok":true}');
    }

    // ...and the positive control, without which the above passes against a route that stores nothing:
    // exactly ONE of the eight is on the record, and it is the right one.
    const stored = rows();
    expect(stored).toHaveLength(1);
    expect(stored[0].childName).toBe('Aisha Khan');
  });

  it('a duplicate inside the window is one row, and a different child is not a duplicate', async () => {
    openForm();
    const peer = freshPeer();
    await post(submission(), { peer });
    await post(submission(), { peer });
    expect(rows()).toHaveLength(1);
    // The vacuity guard: the dedupe must be recognizing THIS family, not refusing everything after
    // the first submission from one source.
    await post(submission({ childName: 'Maryam Ismail' }), { peer });
    expect(rows()).toHaveLength(2);
  });

  it('caps one source per hour, and the cap is not the whole install', async () => {
    openForm();
    const peer = freshPeer();
    for (let i = 0; i < 10; i++) await post(submission({ childName: `Child ${i} Test` }), { peer });
    expect(rows()).toHaveLength(10);
    const over = await post(submission({ childName: 'Child 10 Test' }), { peer });
    expect(over.statusCode).toBe(200);
    expect(over.body).toBe('{"ok":true}');
    expect(rows()).toHaveLength(10); // refused, silently

    // Somebody else is unaffected — a per-source limit that locked out the world would be a way to
    // close a masjid's admissions from one laptop.
    await post(submission({ childName: 'Someone Else' }), { peer: freshPeer() });
    expect(rows()).toHaveLength(11);
  });

  it('the install-wide ceiling refuses, and the same submission is accepted when it is raised', async () => {
    openForm({ dailyMax: 0 });
    await post(submission());
    expect(rows()).toHaveLength(0);
    // The control: the row was refused BY THE CEILING and not by anything else about it.
    settingsMod.setAdmissions({ dailyMax: 1_000 });
    await post(submission());
    expect(rows()).toHaveLength(1);
  });
});

describe('what it says out loud, and what it does not', () => {
  it('says intake is closed rather than silently discarding', async () => {
    openForm({ open: false });
    const page = await http.inject({ method: 'GET', url: '/public/inquiry' });
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain('<form');
    expect(page.body).toContain('not taking new admissions inquiries');
  });

  it('carries the document headers every served page in this app carries', async () => {
    openForm();
    const res = await http.inject({ method: 'GET', url: '/public/inquiry' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    // The hosted page is a link, not an embed: nobody frames it.
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('frames only the origins the office listed, and never “*”', async () => {
    openForm({ embedOrigins: ['https://masjid.example', 'https://www.masjid.example'] });
    const embed = await http.inject({ method: 'GET', url: '/public/inquiry/embed' });
    const csp = String(embed.headers['content-security-policy']);
    expect(csp).toContain('frame-ancestors https://masjid.example https://www.masjid.example');
    expect(csp).not.toContain('*');
  });

  it('an allowlist with nobody on it means nobody — embedding has no separate switch to drift from', async () => {
    openForm({ embedOrigins: [] });
    const embed = await http.inject({ method: 'GET', url: '/public/inquiry/embed' });
    expect(String(embed.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
  });

  it('a hand-edited settings row cannot widen frame-ancestors', async () => {
    // The row is re-validated on READ (`getAdmissions`), the way `getAccentColor` is, because these
    // strings are interpolated into a response header. Delete the `isEmbedOrigin` filter and this
    // goes red — with `*` and a javascript: source reaching a CSP the browser then honors.
    settingsMod.setSetting(
      'admissions',
      JSON.stringify({ publicForm: true, open: true, dailyMax: 100, minSeconds: 3, embedOrigins: ['*', "'none'; script-src *", 'https://ok.example', 'javascript:alert(1)'] }),
    );
    const embed = await http.inject({ method: 'GET', url: '/public/inquiry/embed' });
    const csp = String(embed.headers['content-security-policy']);
    expect(csp).toContain('frame-ancestors https://ok.example');
    expect(csp).not.toContain('*');
    expect(csp).not.toContain('javascript:');
    expect(csp).toContain("script-src 'unsafe-inline';"); // …and the real directive is intact
  });

  it('a truncated policy row reads back CLOSED, not open', async () => {
    settingsMod.setSetting('admissions', '{"publicForm":"yes","open"'); // unparseable
    expect(settingsMod.getAdmissions().publicForm).toBe(false);
    expect((await http.inject({ method: 'GET', url: '/public/inquiry' })).statusCode).toBe(404);
  });

  it('a row that parses but says “1” does not open the form either', async () => {
    // This is the case the truncated-row test above does NOT reach — that one is caught by the
    // try/catch, not by the coercion. Every switch here is `=== true` and not `!== false`, because
    // the safe value of all of them is OFF: a hand-edited row written by somebody who assumed the
    // '1'/'0' convention the scalar settings use must not be what opens a form to the internet.
    // Change the coercion and this goes red while the truncated-row test stays green.
    settingsMod.setSetting('admissions', JSON.stringify({ publicForm: '1', open: 1, dailyMax: 100, minSeconds: 3, embedOrigins: [] }));
    const cfg = settingsMod.getAdmissions();
    expect(cfg.publicForm).toBe(false);
    expect(cfg.open).toBe(false);
    expect((await http.inject({ method: 'GET', url: '/public/inquiry' })).statusCode).toBe(404);
    // The control: a row that says `true` properly does open it, so the above is not passing because
    // nothing can ever open this form.
    settingsMod.setSetting('admissions', JSON.stringify({ publicForm: true, open: true, dailyMax: 100, minSeconds: 3, embedOrigins: [] }));
    expect((await http.inject({ method: 'GET', url: '/public/inquiry' })).statusCode).toBe(200);
  });

  it('renders what a stranger typed as text, never as markup', async () => {
    // The whole page is assembled server-side from values somebody else controls — the school's name,
    // the office's own wording — and served to a browser. Same discipline as the printed statement,
    // with a sharper reason.
    settingsMod.setSetting('school_name', '<script>alert(1)</script>Masjid');
    openForm();
    settingsMod.setAdmissionsText({ intro: 'Welcome to <img src=x onerror=alert(2)> our school' });
    const page = await http.inject({ method: 'GET', url: '/public/inquiry' });
    expect(page.body).not.toContain('<script>alert(1)</script>');
    expect(page.body).not.toContain('<img src=x onerror=alert(2)>');
    expect(page.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page.body).toContain('&lt;img src=x onerror=alert(2)&gt;');
  });
});

describe('the signed render time', () => {
  it('refuses a form filled in faster than a person can type', async () => {
    openForm({ minSeconds: 3 });
    await post(submission({ t: routes.mintFormToken(Date.now()) }));
    expect(rows()).toHaveLength(0);
    await post(submission({ t: routes.mintFormToken(Date.now() - 5_000) }));
    expect(rows()).toHaveLength(1);
  });

  it('refuses a timestamp the caller made up — an unsigned one would be a number a bot edits', async () => {
    openForm();
    const old = Date.now() - 60_000;
    await post(submission({ t: String(old) }));
    await post(submission({ t: `${old}.` }));
    await post(submission({ t: `${old}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` }));
    expect(rows()).toHaveLength(0);
    await post(submission({ t: routes.mintFormToken(old) }));
    expect(rows()).toHaveLength(1);
  });

  it('a token minted before a restart still works — the secret is stored, not per process', async () => {
    // Deliberate: a per-process secret would turn a real family's inquiry into a silently discarded
    // one whenever the container restarted between opening the form and sending it, and — because the
    // response cannot differ — nobody would ever find out.
    openForm();
    const token = routes.mintFormToken(Date.now() - 30_000);
    const secret = settingsMod.getSetting('admissions_form_secret');
    expect(secret).toBeTruthy();
    expect(settingsMod.getSetting('admissions_form_secret')).toBe(secret); // minting again reuses it
    await post(submission({ t: token }));
    expect(rows()).toHaveLength(1);
  });
});

describe('what is written, and what is told', () => {
  it('stores the submission with a trail row, and mints no Student ID', async () => {
    openForm();
    await post(submission());
    const [row] = rows();
    expect(row.state).toBe('new');
    expect(row.source).toBe('public');
    expect(row.studentId).toBeNull();
    expect(row.familyId).toBeNull();
    // An inquiry is not a student: nothing in the students table, and no code minted anywhere.
    expect(app.dbmod.db.select().from(inquiryEvents).all()).toHaveLength(1);
    expect(JSON.stringify(row)).not.toMatch(/[A-Z]{3}\d{4}/);
  });

  it('never lets what a stranger typed reach a log line', async () => {
    openForm();
    const seen: string[] = [];
    const cap = (...args: unknown[]) => {
      seen.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    await settle(); // anything still in flight from an earlier test lands before the spies go on
    const spies = [vi.spyOn(console, 'log').mockImplementation(cap), vi.spyOn(console, 'warn').mockImplementation(cap), vi.spyOn(console, 'error').mockImplementation(cap)];
    try {
      await post(
        submission({
          childName: 'Ruqayyah Secretname',
          parentName: 'Parent Secretname',
          email: 'private@example.org',
          message: 'A sentence nobody else should ever read.',
        }),
      );
      await settle();
    } finally {
      for (const s of spies) s.mockRestore();
    }
    const log = seen.join('\n');
    // The positive control FIRST: without it this passes against a route that logs nothing at all,
    // and would keep passing after somebody removed the logging and added a `console.log(body)`.
    expect(log).toContain('inquiry');
    expect(log).toContain('stored');
    for (const secret of ['Secretname', 'private@example.org', 'nobody else should ever read', '07700 900123']) {
      expect(log, `“${secret}” reached a log line`).not.toContain(secret);
    }
  });

  it('keeps the body out of the audit trail too — it is attacker-controlled, so it is also an injection sink', async () => {
    openForm();
    await post(submission({ childName: 'Khadija Secretname', message: 'A sentence nobody else should ever read.' }));
    const trail = JSON.stringify(app.dbmod.db.select().from(auditLog).all());
    expect(trail).toContain('inquiry.received'); // the control: a row was written
    expect(trail).toContain('public');
    expect(trail).not.toContain('Secretname');
    expect(trail).not.toContain('nobody else should ever read');
  });

  it('tells the office, and tells the sinks it cannot see nothing at all', async () => {
    openForm();
    await post(submission({ childName: 'Sumayyah Ismail' }));
    await settle();
    const alerts = calls.filter((c) => c.url.endsWith('/api/fabric/alert'));
    expect(alerts).toHaveLength(1);
    // `raiseAlert` posts publicText unconditionally, and the platform alert channel is a third-party
    // sink (§14). The per-event webhook-naming exception is granted to `payment-received` ALONE and
    // is deliberately not extended here: consent to being told a payment landed is not consent to
    // publishing the name of a child whose family only asked a question.
    const text = JSON.stringify(alerts[0].body);
    expect(text).toContain('1 new admission inquiry');
    expect(text).not.toContain('Sumayyah');
    expect(text).not.toContain('Ismail');
  });
});

describe('the embed snippet', () => {
  it('points at the embed page, not at the hosted one', async () => {
    openForm({ embedOrigins: ['https://masjid.example'] });
    const js = await http.inject({ method: 'GET', url: '/public/inquiry.js', headers: { host: 'students.masjid.example' } });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toContain('javascript');
    expect(js.body).toContain('/public/inquiry/embed');
    expect(js.body).toContain('students.masjid.example');
  });
});
