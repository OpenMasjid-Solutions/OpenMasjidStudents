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
}

/** Create a session row; returns the RAW token for the cookie (never stored/logged). */
export function createSession(s: NewSession): { token: string } {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const now = new Date();
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
