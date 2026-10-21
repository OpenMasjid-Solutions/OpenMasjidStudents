// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * THE MOUNT PREFIX THROUGH THE TUNNEL, over real HTTP (CLAUDE.md §12).
 *
 * OpenMasjidOS serves this app at `https://<apps' hostname>/<path>/…` and forwards the prefix unstripped.
 * `OPENMASJID_PUBLIC_URL` is empty for an app that is not shared online — which the remote dashboard
 * still opens, for the admin — so the prefix was never stripped and everything built from it pointed at
 * the platform's own dashboard. These requests go through the real `rewriteUrl` (`mountRewriter('')`,
 * the env mirror empty) carrying what Cloudflare and the ingress put on one.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { freshApp } from './harness';
import { sessions, users } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let http: FastifyInstance;

beforeAll(async () => {
  app = await freshApp();
  const { appRouter } = await import('../src/trpc/router');
  const { createContext } = await import('../src/trpc/trpc');
  const { mountRewriter } = await import('../src/http/basePath');
  const { registerPublicInquiryRoutes } = await import('../src/admissions/publicRoutes');
  http = Fastify({ maxParamLength: 5000, rewriteUrl: mountRewriter('') });
  await http.register(fastifyCookie);
  await http.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router: appRouter, createContext } as unknown as FastifyTRPCPluginOptions<typeof appRouter>['trpcOptions'],
  });
  registerPublicInquiryRoutes(http);
  await http.ready();
  (await import('../src/settings')).setAdmissions({ publicForm: true, open: true });
});
afterAll(async () => {
  await http.close();
});
beforeEach(() => {
  for (const t of [sessions, users]) app.dbmod.db.delete(t).run();
});

const TUNNEL = { 'cf-ray': 'abc123-LHR', 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.20' };
const paths = (h: string | string[] | undefined) => [h ?? []].flat().map((c) => /Path=([^;]+)/.exec(c)?.[1]);

async function finance(username: string) {
  const { hashPassword } = await import('../src/auth/passwords');
  const ts = new Date();
  app.dbmod.db
    .insert(users)
    .values({ id: `usr_${username}`, username, passwordHash: await hashPassword('a-strong-passphrase-123'), role: 'finance', status: 'active', mustChangePassword: false, createdAt: ts, updatedAt: ts })
    .run();
}
const post = (url: string, headers: Record<string, string>, body: unknown) =>
  http.inject({ method: 'POST', url, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });

describe('a page and a sign-in under the prefix', () => {
  it('a public page under it posts back under it', async () => {
    const res = await http.inject({ method: 'GET', url: '/students/public/inquiry', headers: TUNNEL });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"/students/public/inquiry"');
  });

  it('a password sign-in from outside (finance) gets a cookie scoped to the prefix, Secure', async () => {
    await finance('fin');
    const res = await post('/students/trpc/auth.login', TUNNEL, { username: 'fin', password: 'a-strong-passphrase-123' });
    expect(res.statusCode).toBe(200);
    const set = String(res.headers['set-cookie']);
    expect(set).toContain('students_session=');
    expect(paths(res.headers['set-cookie'])).toEqual(['/students']);
    expect(set).toContain('Secure');
  });
});

/**
 * THE COOKIE PATH. On the tunnel's one hostname the platform strips only ITS cookies, so a session of
 * ours at Path=/ would ride to every other app's server. Through the tunnel it is scoped to the mount;
 * the LAN keeps exactly what it had (the env prefix, "/" when there is none).
 */
describe('the session cookie’s Path', () => {
  it('signing out through the tunnel clears it at the mount AND at "/"', async () => {
    expect(paths((await post('/students/trpc/auth.logout', TUNNEL, {})).headers['set-cookie']).sort()).toEqual(['/', '/students']);
  });

  it('on the LAN, the cookie is set and cleared at "/" exactly as before', async () => {
    expect(paths((await post('/trpc/auth.logout', {}, {})).headers['set-cookie'])).toEqual(['/']);
    await finance('lanfin');
    const res = await post('/trpc/auth.login', {}, { username: 'lanfin', password: 'a-strong-passphrase-123' });
    expect(paths(res.headers['set-cookie'])).toEqual(['/']);
  });
});
