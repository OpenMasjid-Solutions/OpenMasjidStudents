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
  process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'omos-students-test-'));
  process.env.OPENMASJID_BASE_URL = opts.fabric ? 'http://platform.test' : '';
  process.env.OPENMASJID_APP_SECRET = opts.fabric ? 'test-secret' : '';
  // The install-time mirror of the tunnel URL. Set it when a test needs invite/reset links to have an
  // absolute base without standing up a fake /api/fabric/site.
  process.env.OPENMASJID_PUBLIC_URL = opts.publicUrl ?? '';
  const dbmod = await import('../src/db');
  dbmod.runMigrations(path.resolve(process.cwd(), 'drizzle'));
  const { appRouter } = await import('../src/trpc/router');
  const trpc = await import('../src/trpc/trpc');
  return { appRouter, trpc, dbmod };
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
