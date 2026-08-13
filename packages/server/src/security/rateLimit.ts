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

/** Shared instance used by the auth router — keyed on the real client IP. */
export const loginLimiter = new LoginLimiter();

/**
 * Login failures per ACCOUNT NAME, whatever they come from (§14: "per-IP and per-account", 0.48.0).
 *
 * The per-IP limiter above cannot see a distributed spray: finance and parent accounts are reachable
 * over the Cloudflare tunnel, a parent's username is just their email address, and a few hundred hosts
 * making eight attempts each never trips a per-IP counter. This bounds what the whole internet may try
 * against ONE name.
 *
 * Looser than the per-IP limiter on purpose. The key is a value the caller supplies, so a tight limit
 * would be a denial-of-service tool aimed at a named admin; 25 failures in 15 minutes is far past honest
 * mistyping and far short of what guessing a password needs. Locked accounts can still be reset by email.
 */
export const loginAccountLimiter = new LoginLimiter({ maxFailures: 25, windowMs: 15 * 60_000, blockMs: 15 * 60_000 });

/** Parent-portal invite acceptance — internet-facing, so per-IP throttled (§14). Tokens are
 *  256-bit and unguessable; this just caps abusive hammering of the accept endpoint. */
export const inviteAcceptLimiter = new LoginLimiter({ maxFailures: 10, windowMs: 15 * 60_000, blockMs: 15 * 60_000 });

/** A fixed-window per-key counter for PUBLIC submissions — counts EVERY call (not just failures),
 *  unlike LoginLimiter. Used where the endpoint itself must be capped rather than its failures: a
 *  password-reset request and parent self-registration (§14). In-process; resets by window. `allow`
 *  returns false once the cap is hit for the current window. */
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

// (`applyBurstLimiter` / `applyDailyLimiter` lived here until 0.48.0 — the burst and daily caps for the
// public admissions form, which went with the academics in v0.35.0. Nothing had referenced them since.)

/**
 * Per-student-ID lockout — THE compensating control for the whole student-ID surface (§11.2, §14).
 *
 * A student ID is `ABC1234` — 3 letters derived from the first name plus 4 digits — and since 0.39.0
 * it is the only identifier in the payment flow; there is no PIN behind it. That makes this limiter,
 * not a secret, what stops someone sweeping the ID space: 6 failed probes/hour on a given code, then
 * that code is locked for an hour and an alert is raised. Keyed on the SUPPLIED code; a success
 * resets it.
 *
 * Every secret-less code probe shares this one bucket on purpose — the kiosk's confirm-the-name step,
 * the Fabric balance lookup, and parent self-registration are all the same guess against the same
 * identifier, so laundering failures by switching endpoints must not work.
 */
export const codeLookupLimiter = new LoginLimiter({ maxFailures: 6, windowMs: 60 * 60_000, blockMs: 60 * 60_000 });

/** Password-reset REQUESTS — per-IP fixed-window cap so the endpoint can't be used to bomb an inbox
 *  or probe for accounts (§12/§14). Counts every call. */
export const resetRequestLimiter = new SubmitLimiter(5, 15 * 60_000); // 5 / 15 min
/** Password-reset CONFIRM — per-IP throttle on token submission, like invite accept (tokens are
 *  256-bit + unguessable; this just caps hammering). */
export const resetConfirmLimiter = new LoginLimiter({ maxFailures: 10, windowMs: 15 * 60_000, blockMs: 15 * 60_000 });

/** Parent self-registration — per-IP fixed-window cap (§12/§14): the endpoint takes a student ID, so
 *  it's throttled per IP on top of the per-code lockout `codeLookupLimiter` enforces on the ID. */
export const registerLimiter = new SubmitLimiter(8, 15 * 60_000); // 8 / 15 min
