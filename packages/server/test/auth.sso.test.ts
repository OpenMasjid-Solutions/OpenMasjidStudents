// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * SSO fast-path (CLAUDE.md §12): when embedded in OpenMasjidOS on the LAN, a valid
 * platform session mints a short-lived local admin session. Isolated in its own file
 * so the Fabric env is present before config is imported.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { freshApp, makeCtx } from './harness';

let app: Awaited<ReturnType<typeof freshApp>>;

beforeAll(async () => {
  app = await freshApp({ fabric: true });
});
afterEach(() => vi.unstubAllGlobals());

function mockPlatform(body: unknown, ok = true) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response));
}
const caller = (o: Parameters<typeof makeCtx>[0]) => {
  const { ctx, cookies } = makeCtx(o);
  return { c: app.appRouter.createCaller(ctx), cookies };
};

describe('SSO fast-path', () => {
  it('mints an admin session from a valid platform session on the LAN', async () => {
    mockPlatform({ authenticated: true, username: 'Br. Yusuf' });
    const { c, cookies } = caller({ origin: 'lan', https: true, cookieHeader: 'omos_session=abc' });
    const s = await c.auth.session();
    expect(s.authenticated).toBe(true);
    expect(s.user).toMatchObject({ role: 'admin', source: 'sso', username: 'Br. Yusuf' });
    expect(cookies).toHaveLength(1); // a local session cookie is minted
  });

  it('does NOT do SSO over the tunnel without the platform’s access token (remoteAdmin.test.ts has the rest)', async () => {
    mockPlatform({ authenticated: true, username: 'Br. Yusuf' });
    const { c, cookies } = caller({ origin: 'tunnel' });
    const s = await c.auth.session();
    expect(s.authenticated).toBe(false);
    expect(cookies).toHaveLength(0);
  });

  it('does not authenticate when the platform reports no session', async () => {
    mockPlatform({ authenticated: false });
    const { c } = caller({ origin: 'lan' });
    const s = await c.auth.session();
    expect(s.authenticated).toBe(false);
    expect(s.setupRequired).toBe(true); // no local user + no SSO → first-run
  });
});
