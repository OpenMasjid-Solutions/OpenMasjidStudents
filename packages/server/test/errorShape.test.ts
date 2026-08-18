// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * NO RAW ERROR REACHES A USER (§15) — found missing in the 0.50.0 pre-release audit.
 *
 * tRPC was initialised with no `errorFormatter`, so anything that threw without being a `TRPCError`
 * had its own message serialised to the client: a Drizzle constraint string naming columns, a Stripe
 * SDK message, a `TypeError` with a property path. Over the tunnel, that reached a parent.
 *
 * DRIVEN THROUGH REAL HTTP, not `createCaller`. That distinction is the whole test: `createCaller`
 * invokes the procedure directly and never runs the formatter, so a `createCaller` version of this
 * file would fail while the code was correct — and, worse, would pass while the formatter was deleted
 * from `initTRPC`. What a client receives is a serialised HTTP response, so that is what is asserted.
 *
 * Both halves of the rule are pinned, because a formatter that scrubbed everything would be its own
 * bug: this app's refusals are carefully worded sentences and they must survive untouched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { TRPCError } from '@trpc/server';
import { freshApp } from './harness';

let app: Awaited<ReturnType<typeof freshApp>>;
let http: FastifyInstance;

beforeAll(async () => {
  app = await freshApp();
  const { router, publicProcedure } = await import('../src/trpc/trpc');
  const probe = router({
    // Not a TRPCError — the shape every accidental failure takes.
    boom: publicProcedure.query(() => {
      throw new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: students.student_code');
    }),
    // A deliberate refusal, worded for the person reading it.
    nope: publicProcedure.query(() => {
      throw new TRPCError({ code: 'CONFLICT', message: 'Those lines have changed since this screen loaded.' });
    }),
  });
  http = Fastify();
  await http.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    // Mounted exactly as index.ts mounts the real router, so the formatter under test is the one
    // production uses rather than one this file configured.
    trpcOptions: { router: probe, createContext: () => ({}) } as unknown as FastifyTRPCPluginOptions<typeof probe>['trpcOptions'],
  });
  await http.ready();
});
afterAll(async () => {
  await http?.close();
});

const call = (proc: string) => http.inject({ method: 'GET', url: `/trpc/${proc}` });

describe('what an error says to the client', () => {
  it('replaces an unhandled throw with one plain sentence', async () => {
    const body = (await call('boom')).body;
    expect(body).toContain('Something went wrong at our end');
    // The internals are gone: no driver code, no table, no column.
    expect(body).not.toContain('SQLITE_CONSTRAINT');
    expect(body).not.toContain('student_code');
  });

  it('leaves a deliberate refusal exactly as written', async () => {
    expect((await call('nope')).body).toContain('Those lines have changed since this screen loaded.');
  });

  /** The app's real routers, so the formatter cannot later be broadened into scrubbing the sentences
   *  people are meant to read. Goes through the real appRouter over real HTTP. */
  it('keeps the app’s own friendly refusals', async () => {
    const real = Fastify();
    const { appRouter } = await import('../src/trpc/router');
    const { createContext } = await import('../src/trpc/trpc');
    await real.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      trpcOptions: { router: appRouter, createContext } as unknown as FastifyTRPCPluginOptions<typeof appRouter>['trpcOptions'],
    });
    await real.ready();
    // Unauthenticated: a written sentence, not a stack and not the generic fallback.
    const body = (await real.inject({ method: 'GET', url: '/trpc/settings.get' })).body;
    expect(body).toContain('sign in');
    expect(body).not.toContain('Something went wrong at our end');
    await real.close();
  });
});

describe('what an error response carries besides the message', () => {
  /**
   * NO STACK TRACE, EVER. tRPC omits it when NODE_ENV is 'production' and the Dockerfile sets that —
   * so this was never live in a shipped container. But it is one environment variable standing between
   * a parent on the internet and our absolute file paths plus the original error text, and a dev server
   * reachable over the tunnel is precisely where that variable is wrong. Stripped in the formatter, so
   * it does not depend on the environment at all.
   */
  it('never includes a stack, whatever the error', async () => {
    for (const proc of ['boom', 'nope']) {
      const body = (await call(proc)).body;
      expect(body).not.toContain('"stack"');
      expect(body).not.toContain('node_modules');
      expect(body).not.toContain('SQLITE_CONSTRAINT');
    }
  });

  /** The parts a client legitimately needs are still there — this is a scrub, not a blackout. */
  it('still says what kind of failure it was', async () => {
    const body = (await call('nope')).body;
    expect(body).toContain('CONFLICT');
    expect(body).toContain('httpStatus');
  });
});
