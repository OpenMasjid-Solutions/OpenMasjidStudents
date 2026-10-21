// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Server-side sessions (CLAUDE.md §12). The cookie carries an opaque CSPRNG token;
 * we persist only its SHA-256 so a stolen DB row can't be replayed as a cookie.
 * HTTP-only + SameSite=Lax; Secure when the browser hop is HTTPS. Tokens/values are
 * never logged.
 */
import { randomBytes, createHash } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import type { CookieSerializeOptions } from '@fastify/cookie';
import { db } from '../db';
import { config } from '../config';
import { sessions, users, type Role, type Session } from '../db/schema';
import { rid } from '../db/ids';
import { mountFor } from '../http/basePath';
import type { Origin } from '../security/origin';

export const COOKIE = 'students_session';

const TOKEN_BYTES = 32;
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h for a local password login
export const SSO_SESSION_TTL_MS = 60 * 60 * 1000; //  1h cap for an SSO-minted session (§12)

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface NewSession {
  userId?: string | null;
  role: Role;
  source: 'local' | 'sso';
  username?: string | null;
  ttlMs?: number;
  /** Key the row on this token instead of a fresh one — only the platform access token (`sessionFromRequest`). */
  token?: string;
}

/** Create a session row; returns the RAW token for the cookie (never stored/logged). */
export function createSession(s: NewSession): { token: string } {
  const token = s.token ?? randomBytes(TOKEN_BYTES).toString('base64url');
  const now = new Date();
  // A supplied token is re-minted on expiry (and two tabs may mint at once), so replace, not collide.
  if (s.token) destroySession(token);
  db.insert(sessions)
    .values({
      id: rid('ses'),
      tokenHash: hashToken(token),
      userId: s.userId ?? null,
      role: s.role,
      source: s.source,
      username: s.username ?? null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + (s.ttlMs ?? SESSION_TTL_MS)),
      lastSeenAt: now,
    })
    .run();
  return { token };
}

/** Resolve a cookie token to a live session, or null. Expired rows are cleaned up.
 *  For LOCAL sessions we re-check the backing user EVERY request, so disabling an
 *  account or changing its role takes effect immediately (not only at expiry) — and
 *  the LIVE role is used, never the copy frozen on the session row (CLAUDE.md §12/§14).
 *  SSO sessions have no user row (capped 1h, admin) and pass through unchanged. */
export function getSession(token: string | undefined): Session | null {
  if (!token) return null;
  const row = db.select().from(sessions).where(eq(sessions.tokenHash, hashToken(token))).get();
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) {
    destroySession(token);
    return null;
  }
  if (row.userId) {
    const user = db.select().from(users).where(eq(users.id, row.userId)).get();
    if (!user || user.status !== 'active') {
      destroySession(token);
      return null;
    }
    if (user.role !== row.role) return { ...row, role: user.role }; // reflect a role change now
  }
  return row;
}

export function touchSession(token: string): void {
  db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.tokenHash, hashToken(token))).run();
}

export function destroySession(token: string | undefined): void {
  if (token) db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token))).run();
}

/** Housekeeping — drop expired rows (called on boot; a scheduler can repeat it). */
export function purgeExpiredSessions(): void {
  db.delete(sessions).where(lt(sessions.expiresAt, new Date())).run();
}

/** The session cookie's Path — scoped to the mount prefix the request arrived under (e.g. "/students")
 *  so the token is NEVER sent to sibling apps sharing the OS Cloudflare-tunnel domain (/donations,
 *  /kiosk…); "/" when served at the root (standalone / LAN own-port). Every authenticated request rides
 *  the server-injected `<base href>`, which is built from the SAME per-request mount (index.ts), so it
 *  always lands under this prefix. Set + clear MUST use the same value (RFC 6265 path-match), hence one
 *  function (§14 defense-in-depth). Pass `req.raw`. */
export function cookiePathFor(raw: object | undefined): string {
  return mountFor(raw, config.basePath) || '/';
}

/** Cookie options. `https` reflects whether the browser hop is HTTPS (§ origin.ts); `cookiePath` is `cookiePathFor`. */
export function cookieOptions(at: { https: boolean; cookiePath: string }, ttlMs = SESSION_TTL_MS): CookieSerializeOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: at.https,
    path: at.cookiePath,
    maxAge: Math.floor(ttlMs / 1000),
  };
}

// ── The admin, from outside the masjid, through OpenMasjidOS ─────────────────
/**
 * The platform cookie. Through the tunnel the OpenMasjidOS ingress removes every platform cookie a
 * browser sends and puts back exactly one: THIS app's access token, and only while it is valid — the
 * admin's two-step-verified remote session is live, managing from outside is on, nothing has changed
 * the second factor (core `system/app-access.ts` `cookieHeaderForApp`). So its presence on a tunnel
 * request is the platform vouching for that request, afresh, every time.
 */
export const PLATFORM_COOKIE = 'omos_session';

/**
 * OpenMasjidOS's per-app ACCESS-token shape (core `auth/sessions.ts` `APP_TOKEN_RE`). Its dashboard
 * session tokens are bare base64url with no dots, so this shape can never be one — which matters:
 * the platform's sign-on check accepts a password-only LAN dashboard session too, and only an access
 * token proves the second factor. Off the tunnel nothing strips cookies, so this is what keeps a LAN
 * dashboard cookie, typed at a port reachable from the internet, from becoming a remote admin.
 */
const ACCESS_TOKEN = /^a1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;

/** The platform access token a request carries, if it has that shape. */
export function platformAccessToken(cookies: Record<string, string | undefined> | undefined): string | null {
  const v = cookies?.[PLATFORM_COOKIE];
  return v && ACCESS_TOKEN.test(v) ? v : null;
}

/**
 * Which session a request is, and whether the PLATFORM vouches for it (CLAUDE.md §12.4).
 *
 * A remote admin session has no cookie of ours: its row is keyed on the access token itself
 * (`auth.session` mints it), so it can only be presented by a request that still carries that token —
 * i.e. one the ingress let through as valid. Sign out of the remote dashboard, switch managing from
 * outside off, change the second factor, and the very next request arrives without it: the session is
 * gone with no call to the platform and no clock to wait out. Everything else is the ordinary
 * `students_session` cookie, which the origin policy goes on refusing for an admin over the tunnel.
 */
export function sessionFromRequest(
  req: { cookies?: Record<string, string | undefined> },
  origin: Origin,
): { token: string | undefined; session: Session | null; platformVouched: boolean } {
  if (origin === 'tunnel') {
    const access = platformAccessToken(req.cookies);
    const s = access ? getSession(access) : null;
    if (access && s && s.source === 'sso') return { token: access, session: s, platformVouched: true };
  }
  const token = req.cookies?.[COOKIE];
  return { token, session: getSession(token), platformVouched: false };
}
