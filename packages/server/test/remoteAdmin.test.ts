// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * THE ADMIN, FROM OUTSIDE THE MASJID, THROUGH OPENMASJIDOS — over real HTTP (CLAUDE.md §5, §12.4).
 *
 * The remote dashboard's Open sends the admin to `https://<apps' hostname>/students/`, with a per-app
 * ACCESS token in `omos_session` that the platform's ingress forwards to us — and forwards ONLY while it
 * is valid (the admin's two-step-verified remote session is live, managing from outside is on). Admin
 * was LAN-only outright, so SSO never ran from outside and the admin was asked for a password that would
 * then be refused. Now the platform's word — the access token, on THIS request — is what admits an admin
 * over the tunnel, and nothing else is.
 *
 * Every request goes through the real `rewriteUrl` with the env mirror EMPTY (`mountRewriter('')`, as for
 * an app not shared online — tunnelMount.test.ts has the prefix itself) and carries what Cloudflare and
 * the ingress put on one: `cf-ray` and `x-forwarded-proto: https`.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { freshApp } from './harness';
import { sessions, users, families, students } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let http: FastifyInstance;

/** An access token of the platform's shape (`a1.<22>.<43>`), and a LAN dashboard token (no dots). */
const ACCESS = `a1.${'h'.repeat(22)}.${'m'.repeat(43)}`;
const LAN_DASHBOARD = 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5';

/** Every cookie header the platform's sign-on check was asked about. */
let probes: string[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  app = await freshApp({ fabric: true });
  const { appRouter } = await import('../src/trpc/router');
  const { createContext } = await import('../src/trpc/trpc');
  const { mountRewriter } = await import('../src/http/basePath');
  const { registerStatementRoutes } = await import('../src/billing/statementRoutes');
  // As index.ts builds it, with the env mirror EMPTY — the app is not shared online.
  http = Fastify({ maxParamLength: 5000, rewriteUrl: mountRewriter('') });
  await http.register(fastifyCookie);
  await http.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router: appRouter, createContext } as unknown as FastifyTRPCPluginOptions<typeof appRouter>['trpcOptions'],
  });
  registerStatementRoutes(http);
  await http.ready();
  // The platform: it vouches for the access token, and — like the real one — for a LAN dashboard
  // session too, which is exactly why only the access token may be put to it from outside.
  globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) {
      const cookie = init?.headers?.cookie ?? '';
      probes.push(cookie);
      const ok = cookie === `omos_session=${ACCESS}` || cookie.includes(`omos_session=${LAN_DASHBOARD}`);
      return { ok: true, status: 200, json: async () => (ok ? { authenticated: true, username: 'Hasan' } : { authenticated: false }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }) as unknown as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await http.close();
});

beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [sessions, students, families, users]) db.delete(t).run();
  probes = [];
});

const TUNNEL = { 'cf-ray': 'abc123-LHR', 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' };
const get = (url: string, cookie?: string) =>
  http.inject({ method: 'GET', url, headers: { ...TUNNEL, ...(cookie ? { cookie } : {}) } });
const sessionOf = async (cookie?: string) => JSON.parse((await get('/students/trpc/auth.session', cookie)).body).result.data;

describe('opened from the remote dashboard', () => {
  it('is signed in as admin with no password, under the prefix', async () => {
    const s = await sessionOf(`omos_session=${ACCESS}`);
    expect(s).toMatchObject({ authenticated: true, origin: 'tunnel', user: { role: 'admin', source: 'sso' } });
  });

  it('asks the platform about the access token and NOTHING else the browser sent', async () => {
    await sessionOf(`students_session=x; other=y; omos_session=${ACCESS}`);
    expect(probes).toEqual([`omos_session=${ACCESS}`]);
  });

  it('sets no cookie of its own — the session lives only while the platform forwards the token', async () => {
    const res = await get('/students/trpc/auth.session', `omos_session=${ACCESS}`);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('every admin screen works from outside while the token comes with the request', async () => {
    await sessionOf(`omos_session=${ACCESS}`);
    const res = await get('/students/trpc/settings.get', `omos_session=${ACCESS}`);
    expect(res.statusCode).toBe(200);
  });

  it('…and stops the moment it does not (signed out of the dashboard, door shut, factor changed)', async () => {
    await sessionOf(`omos_session=${ACCESS}`);
    // The ingress strips an invalid token rather than forwarding it, so "revoked" arrives as "absent".
    expect((await get('/students/trpc/settings.get')).statusCode).toBe(401);
  });

  it('the printed documents open too', async () => {
    const ts = new Date();
    app.dbmod.db.insert(families).values({ id: 'fam_r', name: 'Ismail family', status: 'active', createdAt: ts, updatedAt: ts }).run();
    app.dbmod.db.insert(students).values({ id: 'stu_r', familyId: 'fam_r', fullName: 'Yusuf Ismail', status: 'active', studentCode: 'YUS1234', createdAt: ts, updatedAt: ts }).run();
    await sessionOf(`omos_session=${ACCESS}`);
    expect((await get('/students/statements/family/fam_r', `omos_session=${ACCESS}`)).statusCode).toBe(200);
    expect((await get('/students/statements/family/fam_r')).statusCode).toBe(403);
  });

  it('two tabs minting from the same token at once replace each other rather than collide', () => {
    const { createSession, getSession } = app.sessionsMod;
    createSession({ role: 'admin', source: 'sso', username: 'Hasan', token: ACCESS });
    expect(() => createSession({ role: 'admin', source: 'sso', username: 'Hasan', token: ACCESS })).not.toThrow();
    expect(getSession(ACCESS)?.role).toBe('admin');
  });
});

describe('what still does NOT make an admin from outside', () => {
  it('a LAN dashboard session — password only — is never put to the platform over the tunnel', async () => {
    const s = await sessionOf(`omos_session=${LAN_DASHBOARD}`);
    expect(s.authenticated).toBe(false);
    expect(probes).toEqual([]);
  });

  it('an admin session of our own, made on the LAN, stays refused over the tunnel', async () => {
    const { createSession, COOKIE } = app.sessionsMod;
    const { token } = createSession({ role: 'admin', source: 'sso', username: 'lan' });
    expect((await get('/students/trpc/settings.get', `${COOKIE}=${token}`)).statusCode).toBe(403);
    expect(await sessionOf(`${COOKIE}=${token}`)).toMatchObject({ authenticated: false, adminBlocked: true });
  });

  it('the remote row presented as our own cookie is refused — only the platform cookie vouches', async () => {
    const { COOKIE } = app.sessionsMod;
    await sessionOf(`omos_session=${ACCESS}`);
    expect((await get('/students/trpc/settings.get', `${COOKIE}=${ACCESS}`)).statusCode).toBe(403);
  });

  /**
   * `sessionFromRequest` requires BOTH an access-token-shaped cookie and `source === 'sso'`, and the
   * second half has no counter-example reachable through the app: our own tokens are
   * `randomBytes().toString('base64url')`, which has no dots, so one can never match `a1.<22>.<43>`
   * and `getSession(access)` can never find a local session. That is exactly why this test builds the
   * row by hand — a defense-in-depth check nothing can reach is a check nothing would catch the
   * removal of, and a mutation run proved that: deleting `s.source === 'sso'` left the suite green.
   * It becomes load-bearing the moment session tokens change shape, which is a one-line change
   * somebody will make without reading this file.
   */
  it('a LOCAL session stored under an access-token-shaped token still does not vouch', async () => {
    const { createSession } = app.sessionsMod;
    createSession({ role: 'admin', source: 'local', username: 'boss', token: ACCESS });
    expect((await get('/students/trpc/settings.get', `omos_session=${ACCESS}`)).statusCode).toBe(401);
  });

  it('password sign-in for an admin is still refused from outside', async () => {
    const { hashPassword } = await import('../src/auth/passwords');
    const ts = new Date();
    app.dbmod.db
      .insert(users)
      .values({ id: 'usr_a', username: 'boss', passwordHash: await hashPassword('a-strong-passphrase-123'), role: 'admin', status: 'active', mustChangePassword: false, createdAt: ts, updatedAt: ts })
      .run();
    const res = await http.inject({
      method: 'POST',
      url: '/students/trpc/auth.login',
      headers: { ...TUNNEL, 'content-type': 'application/json' },
      payload: JSON.stringify({ username: 'boss', password: 'a-strong-passphrase-123' }),
    });
    expect(res.statusCode).toBe(401);
  });
});
