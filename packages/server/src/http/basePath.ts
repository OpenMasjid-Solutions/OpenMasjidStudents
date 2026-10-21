// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Tunnel base-path helpers (CLAUDE.md §12/§15). When OpenMasjidOS exposes the app behind its
 * Cloudflare tunnel it serves us under an admin-chosen prefix (default "/students") and forwards the
 * FULL prefix WITHOUT stripping it. We strip it before routing, so every route stays written at the
 * root and behaves identically on the LAN (no prefix) and behind the tunnel — and remember, per
 * request, which prefix it was (`mountOf`), so everything that builds a URL or a cookie Path for that
 * request uses the same one. Unit-tested.
 */

/** The path prefix of a public URL, without a trailing slash (e.g. "/students"); "" for a bare host,
 *  an unset URL, or anything unparseable. This is the app's tunnel mount path. */
export function basePathFrom(publicUrl: string): string {
  if (!publicUrl) return '';
  try {
    const p = new URL(publicUrl).pathname.replace(/\/+$/, '');
    return p === '/' ? '' : p;
  } catch {
    return '';
  }
}

/** Strip the mount prefix from an incoming request URL. Empty base = passthrough. Handles the exact
 *  path, sub-paths, and a bare-prefix-with-query (e.g. "/students?x" → "/?x"). */
export function stripBasePath(url: string, base: string): string {
  if (!base) return url;
  if (url === base) return '/';
  if (url.startsWith(base + '/')) return url.slice(base.length);
  if (url.startsWith(base + '?')) return '/' + url.slice(base.length);
  return url;
}

/** OpenMasjidOS's app-path shape (`apps/paths.ts` `isAppPathShape`) — the only first segment its ingress routes. */
const TUNNEL_MOUNT = /^\/([a-z0-9][a-z0-9-]{0,79})(?=[/?]|$)/;

/**
 * Where ONE request is mounted, and its URL with the mount removed.
 *
 * THROUGH THE TUNNEL THE MOUNT IS READ FROM THE REQUEST, because the env mirror is wrong exactly when
 * remote access matters. OpenMasjidOS serves an app at `/<its path>/…` and forwards that prefix
 * unstripped — and since remote administration it does so for an app that is NOT shared online too,
 * to the admin who pressed Open. `OPENMASJID_PUBLIC_URL` is empty for such an app (it is written only
 * for a shared one) and stale after an admin renames the path until the container restarts, and the
 * Fabric site lookup is cold on the first request after boot. Behind any of those the shell went out
 * with `<base href="/">`, so its script loaded from the platform's dashboard: a white screen. The
 * ingress routes only `/<seg>` and `/<seg>/…` of an app's own path, so the first segment of a `cf-ray`
 * request IS our mount; the shape check keeps anything else (a `cf-ray` typed on the LAN) from being
 * reflected into the page.
 *
 * Everywhere else, the env prefix exactly as before, so the LAN does not change.
 */
export function mountOf(url: string, envBase: string, viaTunnel: boolean): { url: string; base: string } {
  const m = viaTunnel ? TUNNEL_MOUNT.exec(url) : null;
  const base = m ? `/${m[1]}` : envBase;
  return { url: stripBasePath(url, base), base };
}

/** Each in-flight request's mount, recorded where the URL is rewritten. */
const mounts = new WeakMap<object, string>();

/** Fastify's `rewriteUrl` (index.ts): strip the request's mount before routing, and remember it. */
export function mountRewriter(envBase: string) {
  return (req: { url?: string; headers: Record<string, unknown> }): string => {
    const { url, base } = mountOf(req.url ?? '/', envBase, !!req.headers['cf-ray']);
    mounts.set(req, base);
    return url;
  };
}

/** The mount a request arrived under (pass `req.raw`), or `fallback` for one that never passed `rewriteUrl`. */
export function mountFor(raw: object | undefined, fallback: string): string {
  return (raw && mounts.get(raw)) ?? fallback;
}
