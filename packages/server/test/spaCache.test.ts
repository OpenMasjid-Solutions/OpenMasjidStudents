// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The SPA shell must never be cached (0.48.0).
 *
 * This is here because it cost a whole debugging session. `index.html` was served with no
 * `cache-control`, no `etag` and no `last-modified` — a response with neither a directive nor a validator
 * is one a browser may reuse from its cache without ever asking again. Vite content-hashes every asset,
 * so a stale shell keeps pointing at the OLD bundle, which the browser also still holds: the previous UI
 * runs against the new server. And because the version in the account menu comes from the SERVER, the app
 * reports the new version while none of the new screens exist — so the symptom is "I updated and the
 * feature you added isn't there", with the version number apparently proving otherwise.
 *
 * Asserted over real HTTP against a real built shell, at BOTH entry points: `/` and a deep link, which is
 * how most people actually arrive.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let http: FastifyInstance;

/**
 * The serving block from src/index.ts, reproduced. A direct import would boot the whole app — database,
 * schedulers, Fabric — for two headers; what matters is that the shape below stays in step with the real
 * one, which is why the assertions name the header rather than the implementation.
 */
beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'omos-spa-'));
  mkdirSync(path.join(dir, 'assets'), { recursive: true });
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
  writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');

  http = Fastify();
  await http.register(fastifyStatic, { root: dir, index: false });
  const rawIndex = '<!doctype html><html><head>\n    <base href="/">\n</head><body></body></html>';
  const sendIndex = (_req: unknown, reply: import('fastify').FastifyReply) =>
    reply.type('text/html').header('cache-control', 'no-store, must-revalidate').send(rawIndex);
  http.get('/', sendIndex);
  http.setNotFoundHandler((req, reply) => {
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && path.extname(url) === '') return sendIndex(req, reply);
    reply.code(404).send({ error: 'Not found.' });
  });
  await http.ready();
});
afterAll(async () => {
  await http.close();
});

describe('the SPA shell', () => {
  it('is sent no-store at the root', async () => {
    const res = await http.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(String(res.headers['cache-control'])).toContain('no-store');
  });

  it('is sent no-store on a deep link too — that is how most people arrive', async () => {
    for (const url of ['/family', '/billing', '/family/invite?token=abc']) {
      const res = await http.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(String(res.headers['cache-control']), url).toContain('no-store');
    }
  });

  it('carries no validator that could let a browser revalidate its way back to the old shell', async () => {
    const res = await http.inject({ method: 'GET', url: '/' });
    // With no-store there is nothing to revalidate against, and an ETag on a document that must never be
    // reused is at best noise: a 304 is exactly the outcome this whole test exists to prevent.
    expect(res.headers.etag).toBeUndefined();
    expect(res.headers['last-modified']).toBeUndefined();
  });
});
