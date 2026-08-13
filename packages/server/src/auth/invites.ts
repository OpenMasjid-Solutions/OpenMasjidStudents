// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Parent-portal invite minting (CLAUDE.md §12). Shared by the finance/admin "invite" action and the
 * admissions one-click enroll (which auto-invites). The RAW token rides only in the returned link
 * (never logged/stored — only its SHA-256 hash is persisted, like a session cookie); single-use,
 * 7-day expiry. Kept free of tRPC ctx so both callers can reuse it.
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { guardians, guardianUsers, invites } from '../db/schema';
import { rid } from '../db/ids';
import { hashToken } from './sessions';
import { usernameTaken } from './usernames';
import { config } from '../config';
import { cachedPublicUrl } from '../fabric/platform';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (§12)

/**
 * The parent-portal invite/signup base, or '' when we don't have an absolute one.
 *
 * TWO sources, in order of trust:
 *  1. `GET /api/fabric/site` (cached) — the LIVE public URL. Authoritative, and correct even when
 *     the env mirror below was written before the admin exposed the app.
 *  2. `OPENMASJID_PUBLIC_URL` — the mirror the platform writes into our .env at install. It is
 *     EMPTY on a fresh install, because exposure is opt-in, which is exactly why (1) exists.
 *
 * Deliberately NOT a third fallback to the request's Host: that yields an RFC1918 LAN URL, and
 * emailing a parent a link they cannot open from home is worse than not emailing them at all. When
 * this returns '' the caller degrades to a copy/print link and says so.
 */
export function portalBase(): string {
  const live = cachedPublicUrl();
  if (live) return live.replace(/\/+$/, '');
  return config.omosPublicUrl ? config.omosPublicUrl.replace(/\/+$/, '') : '';
}

export type MintResult =
  | { ok: true; token: string; url: string; email: string; guardianName: string }
  | { ok: false; reason: 'guardian_not_found' | 'no_email' | 'already_account' | 'email_taken' };

/** Create a single-use invite for a guardian, or explain why it can't be created. Does NOT send the
 *  email or write an audit entry — the caller owns those (they have the actor + i18n/friendly errors). */
export function mintInvite(guardianId: string, createdByUserId: string | null): MintResult {
  const g = db.select().from(guardians).where(eq(guardians.id, guardianId)).get();
  if (!g) return { ok: false, reason: 'guardian_not_found' };
  const email = (g.email ?? '').trim().toLowerCase();
  if (!email) return { ok: false, reason: 'no_email' };
  if (db.select({ userId: guardianUsers.userId }).from(guardianUsers).where(eq(guardianUsers.guardianId, g.id)).get()) return { ok: false, reason: 'already_account' };
  // Case-insensitively (auth/usernames.ts): a staff account created as `Office@masjid.org` holds the
  // same login as this guardian's `office@masjid.org`, and minting an invite for it would build a
  // second account that could never be signed into.
  if (usernameTaken(db, email)) return { ok: false, reason: 'email_taken' };
  const token = randomBytes(32).toString('base64url');
  const ts = new Date();
  db.insert(invites).values({ id: rid('inv'), tokenHash: hashToken(token), guardianId: g.id, createdByUserId, createdAt: ts, expiresAt: new Date(ts.getTime() + INVITE_TTL_MS) }).run();
  return { ok: true, token, url: `${portalBase()}/family/invite?token=${token}`, email, guardianName: g.name };
}
