// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The statement ROUTE, over real HTTP [OMS-011, OMS-012, OMS-018].
 *
 * `statements.test.ts` covers the HTML builder. Nothing covered the route itself, which is where the
 * access wall actually lives: `/statements/*` is registered before the SPA fallback and excluded from
 * the tRPC session middleware, so it gates itself from the cookie on every request. A regression there
 * would not be caught by any procedure test — and this page carries every child's Student ID plus the
 * family's payment history.
 *
 * Driven through a real Fastify instance with `inject`, the way fabric.test.ts drives the provider.
 * That is deliberate: this file is a first step at closing the audit's OMS-018 gap (the boot path had
 * no HTTP-level tests at all), and it is the coverage that made hardening this route safe to ship.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { freshApp } from './harness';
import { paymentAllocations, payments, invoiceItems, invoices, students, families, sessions, users } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let http: FastifyInstance;
let sessionsMod: typeof import('../src/auth/sessions');
let settingsMod: typeof import('../src/settings');

/** A real 1x1 PNG — the logo setter validates magic bytes, so a placeholder string will not do. */
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

beforeAll(async () => {
  app = await freshApp();
  sessionsMod = await import('../src/auth/sessions');
  settingsMod = await import('../src/settings');
  const { registerStatementRoutes } = await import('../src/billing/statementRoutes');
  http = Fastify();
  await http.register(fastifyCookie); // the route reads req.cookies, as index.ts arranges
  registerStatementRoutes(http);
  await http.ready();
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, invoiceItems, invoices, students, families, sessions, users]) db.delete(t).run();
});

/** A live session cookie for a role. */
function cookieFor(role: Role): string {
  const { token } = sessionsMod.createSession({ userId: null, role, source: 'sso', username: role });
  return `${sessionsMod.COOKIE}=${token}`;
}

/** One household with one child, so there is something to render. */
function household(fullName = 'Yusuf Ismail') {
  const { db } = app.dbmod;
  const ts = new Date();
  db.insert(families).values({ id: 'fam_1', name: 'Ismail family', status: 'active', createdAt: ts, updatedAt: ts }).run();
  db.insert(students).values({ id: 'stu_1', familyId: 'fam_1', fullName, status: 'active', studentCode: 'YUS1234', createdAt: ts, updatedAt: ts }).run();
  return 'fam_1';
}

const get = (familyId: string, opts: { cookie?: string; tunnel?: boolean } = {}) =>
  http.inject({
    method: 'GET',
    url: `/statements/family/${familyId}`,
    headers: {
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      // `cf-ray` is the genuine-Cloudflare signal origin.ts classifies as `tunnel`.
      ...(opts.tunnel ? { 'cf-ray': 'test-ray' } : {}),
    },
  });

/** The Student ID sheet (0.48.0) shares the gate. It lists EVERY child's ID, so it is if anything the
 *  most worth confirming is behind it — a leak there is the whole install, not one household. */
const getIds = (scope: string, opts: { cookie?: string; tunnel?: boolean } = {}) =>
  http.inject({
    method: 'GET',
    url: `/sheets/ids/${scope}`,
    headers: {
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.tunnel ? { 'cf-ray': 'test-ray' } : {}),
    },
  });

describe('GET /sheets/ids/:id — the access wall', () => {
  it('serves admin on the LAN and finance from either origin', async () => {
    household();
    expect((await getIds('all', { cookie: cookieFor('admin') })).statusCode).toBe(200);
    expect((await getIds('all', { cookie: cookieFor('finance') })).statusCode).toBe(200);
    expect((await getIds('all', { cookie: cookieFor('finance'), tunnel: true })).statusCode).toBe(200);
  });

  it('refuses an admin over the tunnel, a parent, and no session — and leaks no ID in the refusal', async () => {
    household();
    for (const res of [
      await getIds('all', { cookie: cookieFor('admin'), tunnel: true }),
      await getIds('all', { cookie: cookieFor('parent') }),
      await getIds('all'),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('YUS1234');
    }
  });

  it('404s a school that does not exist rather than falling back to every student', async () => {
    household();
    const res = await getIds('sch_nope', { cookie: cookieFor('admin') });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('YUS1234');
  });

  it('renders the roster under the same hardened headers as the statement', async () => {
    household();
    const res = await getIds('all', { cookie: cookieFor('admin') });
    expect(res.body).toContain('YUS1234');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(String(res.headers['content-security-policy'])).toContain("default-src 'none'");
  });
});

describe('GET /statements/family/:id — the access wall', () => {
  it('serves admin on the LAN and finance from either origin', async () => {
    const fam = household();
    expect((await get(fam, { cookie: cookieFor('admin') })).statusCode).toBe(200);
    expect((await get(fam, { cookie: cookieFor('finance') })).statusCode).toBe(200);
    expect((await get(fam, { cookie: cookieFor('finance'), tunnel: true })).statusCode).toBe(200);
  });

  it('refuses an admin session presented over the tunnel (§12.4)', async () => {
    const fam = household();
    const res = await get(fam, { cookie: cookieFor('admin'), tunnel: true });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('YUS1234'); // no Student ID leaks in the refusal
  });

  it('refuses a parent, and anyone with no session at all', async () => {
    const fam = household();
    expect((await get(fam, { cookie: cookieFor('parent') })).statusCode).toBe(403);
    expect((await get(fam)).statusCode).toBe(403);
    expect((await get(fam, { cookie: `${sessionsMod.COOKIE}=not-a-real-token` })).statusCode).toBe(403);
  });

  it('404s an unknown family for an authorized caller', async () => {
    household();
    expect((await get('fam_nope', { cookie: cookieFor('finance') })).statusCode).toBe(404);
  });
});

describe('GET /statements/family/:id — response hardening [OMS-012]', () => {
  it('sets a CSP that blocks external loads, framing and form posts', async () => {
    const fam = household();
    const res = await get(fam, { cookie: cookieFor('admin') });
    const csp = res.headers['content-security-policy'] as string;

    expect(csp).toContain("default-src 'none'"); // no external fetch/img/script channel
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    // data: images must stay allowed or the inlined logo and the QR code both break.
    expect(csp).toContain('img-src data:');
  });

  it('sets nosniff, no-referrer, and no-store', async () => {
    const fam = household();
    const res = await get(fam, { cookie: cookieFor('admin') });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('renders the QR and an inlined logo under that CSP', async () => {
    const fam = household();
    settingsMod.setSchoolLogo(PNG_1PX);
    const res = await get(fam, { cookie: cookieFor('admin') });
    expect(res.statusCode).toBe(200);
    // Both images are data: URIs, which is exactly what `img-src data:` permits.
    expect(res.body).toContain('src="data:image/png;base64,'); // the QR code
    expect(res.body).toContain(PNG_1PX); // the logo, unchanged by esc() over its permitted alphabet
    settingsMod.setSchoolLogo(null);
  });
});

describe('GET /statements/family/:id — escaping [OMS-011]', () => {
  it('escapes a hostile student name rather than emitting markup', async () => {
    const fam = household('<script>alert(1)</script> Ismail');
    const res = await get(fam, { cookie: cookieFor('admin') });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;');
  });

  it('escapes a payment memo, which a parent can type at the kiosk', async () => {
    const fam = household();
    const { db } = app.dbmod;
    const ts = new Date();
    // `payerNote` from the Fabric record-payment lands in `memo` — parent-supplied, staff-read.
    db.insert(payments)
      .values({
        id: 'pay_1',
        studentId: 'stu_1',
        amountCents: 5000,
        channel: 'kiosk',
        occurredAt: ts,
        memo: '"><img src=x onerror=alert(1)>',
        idempotencyKey: 'pi_test_1',
        createdAt: ts,
      })
      .run();

    const res = await get(fam, { cookie: cookieFor('admin') });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('<img src=x onerror=alert(1)>');
    expect(res.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
