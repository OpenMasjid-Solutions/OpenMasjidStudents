// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * In-process login brute-force limiter (CLAUDE.md §12, §14). Keyed on the REAL TCP
 * peer, never a client-supplied X-Forwarded-For (which could be spoofed to bypass
 * the limit). Fixed window of failures, then a temporary block. Success resets.
 */
export interface LimiterOpts {
  maxFailures?: number;
  windowMs?: number;
  blockMs?: number;
}

/** Hard ceiling on distinct keys any in-process limiter map may hold — a backstop against a
 *  distributed flood (or IPv6-prefix rotation) growing the map unbounded on a small Pi. Well above
 *  any legitimate working set. */
const MAX_KEYS = 50_000;

/** Bound a limiter map by evicting oldest entries first (Map preserves insertion order). Amortized
 *  O(overflow), never a full O(n) scan on the hot path. Dropping a bucket only forgives a counter. */
function evictOldest(m: Map<string, unknown>): void {
  while (m.size > MAX_KEYS) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
}

interface Entry {
  count: number;
  windowResetAt: number;
  blockedUntil: number;
}

export class LoginLimiter {
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly blockMs: number;
  private readonly hits = new Map<string, Entry>();

  constructor(opts: LimiterOpts = {}) {
    this.maxFailures = opts.maxFailures ?? 8;
    this.windowMs = opts.windowMs ?? 15 * 60_000;
    this.blockMs = opts.blockMs ?? 15 * 60_000;
  }

  /** Milliseconds the caller must wait, or 0 if allowed to try now. */
  retryAfterMs(key: string, now = Date.now()): number {
    const e = this.hits.get(key);
    if (!e) return 0;
    if (e.blockedUntil > now) return e.blockedUntil - now;
    return 0;
  }

  fail(key: string, now = Date.now()): void {
    let e = this.hits.get(key);
    if (!e || e.windowResetAt <= now) {
      e = { count: 0, windowResetAt: now + this.windowMs, blockedUntil: 0 };
      this.hits.set(key, e);
    }
    e.count += 1;
    if (e.count >= this.maxFailures) {
      e.blockedUntil = now + this.blockMs;
      e.count = 0;
      e.windowResetAt = now + this.blockMs;
    }
    // Hard cap: if a flood of distinct keys (many source IPs) keeps entries un-expired, the scan
    // above frees nothing — so bound the map by evicting oldest-first (Map keeps insertion order).
    // Evicting a counter only ever FORGIVES it (safe failure direction).
    evictOldest(this.hits);
  }

  succeed(key: string): void {
    this.hits.delete(key);
  }
}

/** Shared instance used by the auth router. */
export const loginLimiter = new LoginLimiter();

/** Parent-portal invite acceptance — internet-facing, so per-IP throttled (§14). Tokens are
 *  256-bit and unguessable; this just caps abusive hammering of the accept endpoint. */
export const inviteAcceptLimiter = new LoginLimiter({ maxFailures: 10, windowMs: 15 * 60_000, blockMs: 15 * 60_000 });

/** A fixed-window per-key counter for PUBLIC submissions — counts EVERY call (not just failures),
 *  unlike LoginLimiter. Used to cap the anonymous /apply form per IP (§14). In-process; resets by
 *  window. `allow` returns false once the cap is hit for the current window. */
export class SubmitLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    let e = this.hits.get(key);
    if (!e || e.resetAt <= now) {
      e = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, e);
    }
    if (e.count >= this.max) return false;
    e.count += 1;
    // Bound the map by evicting oldest-first — the only cleanup needed. A stale (expired) entry that
    // lingers is harmless (it's reset on next access), and the hard cap keeps total memory bounded
    // even under a distributed flood of distinct IPs (§14; Pi target). O(1) amortized, no O(n) scan.
    evictOldest(this.hits);
    return true;
  }
}

/** Public admissions form: a short-window burst cap and a daily cap, both per real client IP (§14). */
export const applyBurstLimiter = new SubmitLimiter(5, 10 * 60_000); // 5 / 10 min
export const applyDailyLimiter = new SubmitLimiter(20, 24 * 60 * 60_000); // 20 / day

/** Per-PIN lookup lockout for the Fabric name+PIN payment lookup (§14): 10 failed matches/hour on a
 *  given PIN → that PIN is temporarily locked (and finance is notified). Compensates for the PIN's
 *  low entropy. Keyed by the SUPPLIED pin; a success resets it. */
export const pinLookupLimiter = new LoginLimiter({ maxFailures: 10, windowMs: 60 * 60_000, blockMs: 60 * 60_000 });

/**
 * Per-student-ID lockout for the kiosk's confirm-the-name step (§11.2, §14).
 *
 * A student ID is `ABC1234` — 3 letters derived from the first name plus 4 digits — so it is far more
 * guessable than a PIN, and a successful probe reveals a first name + last initial. That makes this
 * the app's cheapest name-enumeration surface, so it is capped HARDER than the PIN (6 tries, not 10)
 * and keyed on the supplied code. A success resets it.
 *
 * Note it is deliberately NOT reset by a later successful PIN lookup: the two are separate probes,
 * and someone sweeping codes should not be able to launder their failures with one good login.
 */
export const codeLookupLimiter = new LoginLimiter({ maxFailures: 6, windowMs: 60 * 60_000, blockMs: 60 * 60_000 });

/** Password-reset REQUESTS — per-IP fixed-window cap so the endpoint can't be used to bomb an inbox
 *  or probe for accounts (§12/§14). Counts every call. */
export const resetRequestLimiter = new SubmitLimiter(5, 15 * 60_000); // 5 / 15 min
/** Password-reset CONFIRM — per-IP throttle on token submission, like invite accept (tokens are
 *  256-bit + unguessable; this just caps hammering). */
export const resetConfirmLimiter = new LoginLimiter({ maxFailures: 10, windowMs: 15 * 60_000, blockMs: 15 * 60_000 });

/** Parent self-registration — per-IP fixed-window cap (§12/§14): the endpoint takes a name + PIN, so
 *  it's throttled per IP (on top of the per-PIN lockout that pinLookupLimiter enforces on the PIN). */
export const registerLimiter = new SubmitLimiter(8, 15 * 60_000); // 8 / 15 min
