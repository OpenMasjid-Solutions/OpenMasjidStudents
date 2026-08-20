// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The tunnel base-path helpers [OMS-014].
 *
 * `BASE` is read once at module load from `window.__OMOS_BASE__`, which the server injects into the
 * page, so each case re-imports the module with a different window. That is the point of testing it:
 * every in-app URL the client builds — API calls, links, and the post-invite redirect — goes through
 * `withBase`, and a path that skips it lands OUTSIDE the app when OpenMasjidOS serves us under a
 * prefix. The session cookie is Path-scoped to that same prefix, so such a URL is also somewhere the
 * cookie is not sent, which is what made the InviteAccept bug look like a failed signup.
 *
 * There is no component-test infrastructure in this workspace (no jsdom, no testing-library), so this
 * pins the helper rather than the screen. Adding either for a one-line redirect fix would be a bigger
 * change than the fix.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

type BaseModule = typeof import('./base');

/** Load a fresh copy of base.ts with `window.__OMOS_BASE__` set to `injected`. */
async function loadWithBase(injected: string | undefined): Promise<BaseModule> {
  vi.resetModules();
  // The module guards on `typeof window !== 'undefined'`; under the node environment there is none,
  // so we provide exactly the shape it reads.
  (globalThis as { window?: unknown }).window = injected === undefined ? {} : { __OMOS_BASE__: injected };
  return import('./base');
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.resetModules();
});

describe('withBase', () => {
  it('prefixes in-app paths when served under a tunnel prefix', async () => {
    const { BASE, withBase } = await loadWithBase('/students');
    expect(BASE).toBe('/students');
    // The exact call the post-invite redirect makes — it must stay inside the app.
    expect(withBase('/')).toBe('/students/');
    expect(withBase('/family')).toBe('/students/family');
    expect(withBase('/trpc')).toBe('/students/trpc');
    expect(withBase('/statements/family/fam_1')).toBe('/students/statements/family/fam_1');
  });

  it('is a no-op at the root (direct LAN access, no tunnel)', async () => {
    const { BASE, withBase } = await loadWithBase('');
    expect(BASE).toBe('');
    expect(withBase('/')).toBe('/');
    expect(withBase('/family')).toBe('/family');
  });

  it('treats a missing injection as the root', async () => {
    const { BASE, withBase } = await loadWithBase(undefined);
    expect(BASE).toBe('');
    expect(withBase('/family')).toBe('/family');
  });

  it('normalizes a trailing slash and a missing leading slash', async () => {
    expect((await loadWithBase('/students/')).BASE).toBe('/students');
    expect((await loadWithBase('students')).BASE).toBe('/students');
    expect((await loadWithBase('  /students  ')).BASE).toBe('/students');
  });

  it('leaves a relative or absolute-URL path alone', async () => {
    const { withBase } = await loadWithBase('/students');
    expect(withBase('assets/logo.png')).toBe('assets/logo.png');
    expect(withBase('https://stripe.com/x')).toBe('https://stripe.com/x');
  });
});

describe('stripBase', () => {
  it('removes the prefix so client-side route matching is prefix-agnostic', async () => {
    const { stripBase } = await loadWithBase('/students');
    expect(stripBase('/students/family/invite')).toBe('/family/invite');
    expect(stripBase('/students')).toBe('/');
    expect(stripBase('/students/')).toBe('/');
  });

  it('leaves a path that does not carry the prefix untouched', async () => {
    const { stripBase } = await loadWithBase('/students');
    // Must not chop a prefix-LIKE segment: /studentsomething is a different path.
    expect(stripBase('/studentsomething')).toBe('/studentsomething');
    expect(stripBase('/family')).toBe('/family');
  });

  it('is identity at the root', async () => {
    const { stripBase } = await loadWithBase('');
    expect(stripBase('/family/invite')).toBe('/family/invite');
    expect(stripBase('/')).toBe('/');
  });
});
