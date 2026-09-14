// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * ONE-TIME LINK TOKENS — minting, hashing, expiry and single use, in one place (CLAUDE.md §14, §16).
 *
 * There are four of these in the app now: a parent-portal invite, a password reset, an admission form
 * link and a re-admission form link. They are the same object with different rows behind them —
 * CSPRNG, single-use, expiring, and **only the SHA-256 hash stored**, so a stolen database row cannot
 * be replayed as a link — and until 0.52.0-dev.9 that object was written out three times.
 *
 * `docs/ADMISSIONS.md` §1.3 says to extract rather than copy, and the reason is worth keeping: a
 * second implementation is a second place to get expiry, single-use or hashing wrong, and these links
 * are reachable from the internet. Three copies is already how one of them silently stops checking
 * `used_at`.
 *
 * **What this file does NOT do is decide who may have a link, or what redeeming one lets them do.**
 * Those are per-row questions and stay with the row: `auth/invites.ts` checks that a guardian has an
 * email and no account yet, and `admissions/readmission.ts` checks that a child is still active. This
 * is the envelope, not the letter.
 */
import { randomBytes } from 'node:crypto';
import { hashToken } from './sessions';

export { hashToken };

/**
 * A fresh link token.
 *
 * 32 bytes — 256 bits — base64url, which is what sessions, invites and resets already use. The RAW
 * token rides only in the link that goes out; nothing stores it, nothing logs it, and it cannot be
 * recovered from what IS stored. A token that has to be re-sent is a NEW token.
 */
export function mintToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

/** How long each kind of link is good for. An admission or re-admission form is filled in by a
 *  family at their own pace over an evening or a fortnight, so it is generous where an invite is
 *  not — but bounded, because a link that never expires is a credential. */
export const ADMISSION_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface TokenRow {
  expiresAt: Date;
  usedAt: Date | null;
}

export type TokenState = 'ok' | 'unknown' | 'expired' | 'used';

/**
 * Is this row a link somebody may still act on?
 *
 * Separated from the lookup so every caller answers the three failure modes the same way, and so a
 * screen can tell a family "that link has already been used" rather than "not found" — which for a
 * token link is a genuinely different thing and the one case where saying which is helpful rather
 * than a disclosure. There is nothing to enumerate: a 256-bit token is not guessable, so telling its
 * holder why it failed reveals nothing to anybody who did not already have it.
 */
export function tokenState(row: TokenRow | undefined | null, now = new Date()): TokenState {
  if (!row) return 'unknown';
  if (row.usedAt) return 'used';
  if (row.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'ok';
}
