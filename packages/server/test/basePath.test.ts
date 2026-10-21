// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Tunnel base-path helpers (CLAUDE.md §12/§15): deriving the mount prefix from the public URL and
 * stripping it from incoming requests so routes stay root-relative on the LAN and behind the tunnel.
 * Pure functions — no DB, so a direct import (no harness) is fine.
 */
import { describe, it, expect } from 'vitest';
import { basePathFrom, stripBasePath, mountOf, mountRewriter, mountFor } from '../src/http/basePath';

describe('basePathFrom', () => {
  it('extracts the path prefix from the public URL', () => {
    expect(basePathFrom('https://omos.example.org/students')).toBe('/students');
    expect(basePathFrom('https://omos.example.org/students/')).toBe('/students'); // trailing slash trimmed
    expect(basePathFrom('https://omos.example.org/apps/students')).toBe('/apps/students'); // admin-renamed path
  });
  it('is empty for a bare host, an unset URL, or garbage', () => {
    expect(basePathFrom('https://omos.example.org')).toBe('');
    expect(basePathFrom('https://omos.example.org/')).toBe('');
    expect(basePathFrom('')).toBe('');
    expect(basePathFrom('not a url')).toBe('');
  });
});

describe('stripBasePath', () => {
  const B = '/students';
  it('strips the prefix from tunnel requests so routes stay root-relative', () => {
    expect(stripBasePath('/students/trpc', B)).toBe('/trpc');
    expect(stripBasePath('/students/assets/index.js', B)).toBe('/assets/index.js');
    expect(stripBasePath('/students/api/stripe/webhook', B)).toBe('/api/stripe/webhook');
    expect(stripBasePath('/students', B)).toBe('/'); // the bare app root
    expect(stripBasePath('/students?x=1', B)).toBe('/?x=1'); // bare prefix + query
    expect(stripBasePath('/students/family/invite?token=abc', B)).toBe('/family/invite?token=abc');
  });
  it('passes root (LAN) requests through unchanged', () => {
    expect(stripBasePath('/trpc', B)).toBe('/trpc'); // a LAN request has no prefix
    expect(stripBasePath('/', B)).toBe('/');
    // Does not strip a lookalike that only shares the prefix as a substring.
    expect(stripBasePath('/students-hub/x', B)).toBe('/students-hub/x');
  });
  it('is a passthrough when there is no base (standalone)', () => {
    expect(stripBasePath('/trpc', '')).toBe('/trpc');
    expect(stripBasePath('/students/trpc', '')).toBe('/students/trpc');
  });
});

/**
 * THE MOUNT IS READ OFF A TUNNEL REQUEST (remote access). The env mirror is empty for an app that is
 * not shared online — which OpenMasjidOS still serves to the admin at `/<path>/` from the remote
 * dashboard — so stripping only the env prefix sent the shell out with `<base href="/">` and the
 * page loaded its script from the platform's dashboard: a white screen.
 */
describe('mountOf', () => {
  it('through the tunnel, takes the first segment as the mount even with no env prefix', () => {
    expect(mountOf('/students/assets/index.js', '', true)).toEqual({ url: '/assets/index.js', base: '/students' });
    expect(mountOf('/students/trpc/auth.session', '', true)).toEqual({ url: '/trpc/auth.session', base: '/students' });
    expect(mountOf('/students', '', true)).toEqual({ url: '/', base: '/students' });
    expect(mountOf('/students?x=1', '', true)).toEqual({ url: '/?x=1', base: '/students' });
  });
  it('through the tunnel, follows a renamed path the env mirror has not caught up with', () => {
    expect(mountOf('/school/trpc', '/students', true)).toEqual({ url: '/trpc', base: '/school' });
  });
  it('never reflects a first segment that is not an app path', () => {
    for (const url of ['/Students/x', '/%3Cscript%3E/x', '/_omos/open', '/"x/', '/']) {
      expect(mountOf(url, '', true).base).toBe('');
    }
  });
  it('on the LAN, is exactly the env prefix, as before', () => {
    expect(mountOf('/family/register', '', false)).toEqual({ url: '/family/register', base: '' });
    expect(mountOf('/trpc', '/students', false)).toEqual({ url: '/trpc', base: '/students' });
    expect(mountOf('/students/trpc', '/students', false)).toEqual({ url: '/trpc', base: '/students' });
  });
  it('the rewriter remembers each request’s own mount', () => {
    const rewrite = mountRewriter('');
    const tunnel = { url: '/students/trpc', headers: { 'cf-ray': 'x' } };
    const lan = { url: '/trpc', headers: {} };
    expect(rewrite(tunnel)).toBe('/trpc');
    expect(rewrite(lan)).toBe('/trpc');
    expect(mountFor(tunnel, '?')).toBe('/students');
    expect(mountFor(lan, '?')).toBe('');
    expect(mountFor({}, 'fallback')).toBe('fallback');
  });
});
