// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Test harness: spin up the real router against a throwaway SQLite file, and build
 * fake tRPC contexts to exercise the role + origin middleware. Env is set BEFORE any
 * src module is imported (config reads it at import), so imports here are dynamic.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function freshApp(opts: { fabric?: boolean; publicUrl?: string } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'omos-students-test-'));
  process.env.DATA_DIR = dataDir;
  process.env.OPENMASJID_BASE_URL = opts.fabric ? 'http://platform.test' : '';
  process.env.OPENMASJID_APP_SECRET = opts.fabric ? 'test-secret' : '';
  // The install-time mirror of the tunnel URL. Set it when a test needs invite/reset links to have an
  // absolute base without standing up a fake /api/fabric/site.
  process.env.OPENMASJID_PUBLIC_URL = opts.publicUrl ?? '';
  const dbmod = await import('../src/db');

  /**
   * Are we actually on the throwaway database?
   *
   * `config.ts` reads the environment ONCE, at import, and `db/index.ts` opens the file at import too —
   * so a test file with a STATIC import that reaches either of them (most of `src/` does, two or three
   * hops down) has already frozen `dataDir` to the default `./data` before this function runs. Every
   * query then goes to the developer's own local database, and a `beforeEach` that clears tables clears
   * THAT one. It fails silently and looks like a passing test.
   *
   * It happened while writing the 0.48.0 settings tests, via `people/sheetText → billing/statements →
   * db`. This turns it into a loud failure naming the fix, which is to import the module under test
   * dynamically inside `beforeAll`, as every other test file here does.
   */
  const { config } = await import('../src/config');
  if (path.resolve(config.dataDir) !== path.resolve(dataDir)) {
    throw new Error(
      `freshApp: the app is bound to ${config.dataDir}, not this test's temp directory. ` +
        'Something imported src/ before freshApp() ran — move that import inside beforeAll() and use await import().',
    );
  }
  dbmod.runMigrations(path.resolve(process.cwd(), 'drizzle'));
  const { appRouter } = await import('../src/trpc/router');
  const trpc = await import('../src/trpc/trpc');
  // Session minting/reading, for the tests that assert an account was actually SIGNED OUT — a revocation
  // has no other observable effect, so `createSession` + `getSession` is the only way to see it.
  const sessionsMod = await import('../src/auth/sessions');
  return { appRouter, trpc, dbmod, sessionsMod };
}

export interface CtxOpts {
  origin?: 'lan' | 'tunnel';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake session shape for middleware tests
  session?: any;
  token?: string;
  peer?: string;
  cookieHeader?: string;
  https?: boolean;
}

/** A minimal Context stand-in + a record of any cookies the procedure set. */
export function makeCtx(o: CtxOpts = {}) {
  const cookies: Array<{ name: string; value: string; opts: unknown }> = [];
  const req = {
    headers: {
      ...(o.cookieHeader ? { cookie: o.cookieHeader } : {}),
      ...(o.origin === 'tunnel' ? { 'cf-ray': 'test-ray' } : {}),
    },
    socket: { remoteAddress: o.peer ?? '127.0.0.1' },
  };
  const res = {
    setCookie: (name: string, value: string, opts: unknown) => cookies.push({ name, value, opts }),
    clearCookie: () => {},
  };
  const ctx = {
    req,
    res,
    origin: o.origin ?? 'lan',
    https: o.https ?? false,
    token: o.token,
    session: o.session ?? null,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cast the stand-in to the real Context in tests
  return { ctx: ctx as any, cookies };
}
