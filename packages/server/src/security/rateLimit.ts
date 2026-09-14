// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * In-process rate limiting (CLAUDE.md §12, §14). Keyed on the REAL TCP peer, never a
 * client-supplied X-Forwarded-For (which could be spoofed to bypass the limit) — see
 * `security/origin.ts` `rateLimitKey`, which is the one place a request becomes a key.
 *
 * ── THE MAP MUST NOT FORGIVE UNDER FLOOD (0.52.0, §4a Phase 2) ──────────────
 *
 * Both classes below are bounded Maps, because this runs on a Raspberry Pi and a distributed flood of
 * distinct keys would otherwise grow one without limit. Until now that bound was "evict oldest-first,
 * unconditionally", and the comment beside it called dropping a bucket a safe direction because it
 * "only forgives a counter".
 *
 * **It forgives a BLOCK, and a block is the control.** The repo's own test asserted the consequence
 * out loud: flood 50,200 junk keys and a key that was at its cap is allowed again. Two live surfaces
 * were bypassable by exactly that, with no secret needed:
 *
 *   - `codeLookupLimiter` — THE compensating control for the whole Student ID surface (§11.2, §14),
 *     which has no secret behind it. It is keyed on the SUPPLIED code, so the attacker generates the
 *     flood for free: sweep enough codes and the locked ones unlock themselves.
 *   - the public admissions inquiry form (§4a Phase 2), whose per-IP key an attacker also chooses,
 *     and which is the surface most likely to see 50,000 distinct keys in an hour.
 *
 * So eviction is now ordered and A LIVE PENALTY IS NEVER DROPPED: dead entries first, then entries
 * carrying no live block, oldest-first. Partial counters can still be forgiven under flood — that is
 * the only give left, and it is the cheap half. When nothing can be dropped the map stops admitting
 * NEW keys rather than growing, and the two classes answer that saturation differently on purpose:
 *
 *   - `SubmitLimiter` FAILS CLOSED (a new key is refused). It guards public, unauthenticated
 *     submission surfaces, where refusing costs a masjid some inquiries for an hour.
 *   - `LoginLimiter` stops TRACKING the new key (it is allowed through, unthrottled). Failing closed
 *     there would lock every parent and every staff member out of the app they pay their fees in, and
 *     it is the layer that already has a second one behind it — `loginAccountLimiter` is keyed on the
 *     account name, which an attacker rotating IPs is not touching.
 *
 * Memory is bounded either way, which is what the eviction was for.
 */
export interface LimiterOpts {
  maxFailures?: number;
  windowMs?: number;
  blockMs?: number;
}

/** Hard ceiling on distinct keys any in-process limiter map may hold — a backstop against a
 *  distributed flood (or IPv6-prefix rotation) growing the map unbounded on a small Pi. Well above
 *  any legitimate working set: a masjid's whole roster of households is three digits. */
const MAX_KEYS = 50_000;

/**
 * Bound a limiter map without ever dropping a live penalty.
 *
 * Insertion order is the eviction order within each pass (Map preserves it), so this is oldest-first
 * among the entries it is allowed to touch. Two passes, and the order between them is the point:
 *
 *   1. entries that are completely dead — nothing is being remembered about them anyway;
 *   2. entries carrying no live block — a partial counter, which is the cheap thing to forgive.
 *
 * An entry under a live block is never dropped, so the map can legitimately stay above MAX_KEYS. The
 * caller checks its own size afterwards and stops admitting new keys rather than growing.
 */
function prune<T>(m: Map<string, T>, dead: (e: T) => boolean, blocked: (e: T) => boolean): void {
  if (m.size <= MAX_KEYS) return;
  for (const [k, e] of m) {
    if (m.size <= MAX_KEYS) return;
    if (dead(e)) m.delete(k);
  }
  for (const [k, e] of m) {
    if (m.size <= MAX_KEYS) return;
    if (!blocked(e)) m.delete(k);
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

  /** How many distinct keys are being remembered. Exposed so the bound can be asserted rather than
   *  assumed — an unbounded limiter map is a memory fault on a Pi, and a silent one. */
  get size(): number {
    return this.hits.size;
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
      if (!e) {
        prune(
          this.hits,
          (x) => x.blockedUntil <= now && x.windowResetAt <= now,
          (x) => x.blockedUntil > now,
        );
        // Saturated with live blocks. Stop TRACKING this key rather than growing the map — see the
        // header: locking every parent out of the portal is the worse failure for an auth surface,
        // and `loginAccountLimiter` is still watching the name an attacker is actually guessing.
        if (this.hits.size >= MAX_KEYS) return;
      }
      e = { count: 0, windowResetAt: now + this.windowMs, blockedUntil: 0 };
      this.hits.set(key, e);
    }
    e.count += 1;
    if (e.count >= this.maxFailures) {
      e.blockedUntil = now + this.blockMs;
      e.count = 0;
      e.windowResetAt = now + this.blockMs;
    }
  }

  succeed(key: string): void {
    this.hits.delete(key);
  }
}

/** Shared instance used by the auth router — keyed on the real client IP, folded to a /64 for IPv6
 *  (`rateLimitKey`), because a single IPv6 allocation is otherwise 2^64 free buckets. */
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
 *  password-reset request, parent self-registration, and the public admissions inquiry form (§14).
 *  In-process; resets by window. `allow` returns false once the cap is hit for the current window. */
export class SubmitLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** How many distinct keys are being remembered (see LoginLimiter.size). */
  get size(): number {
    return this.hits.size;
  }

  allow(key: string, now = Date.now()): boolean {
    let e = this.hits.get(key);
    if (!e || e.resetAt <= now) {
      if (!e) {
        prune(
          this.hits,
          (x) => x.resetAt <= now,
          (x) => x.count >= this.max,
        );
        // Saturated with keys that are ALL at their cap — tens of thousands of distinct sources each
        // submitting their fill, which is an attack and not a Sunday. FAIL CLOSED: this guards
        // unauthenticated public surfaces, where the cost of refusing is some inquiries lost for an
        // hour, and the cost of admitting is a limiter that is decorative exactly when it matters.
        if (this.hits.size >= MAX_KEYS) return false;
      }
      e = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, e);
    }
    if (e.count >= this.max) return false;
    e.count += 1;
    return true;
  }
}

/**
 * A whole-install ceiling, counted rather than keyed (§4a Phase 2, docs/ADMISSIONS.md §2).
 *
 * The per-key limiters above bound what one source may do. Nothing bounds what a thousand sources may
 * do between them, and "a flooded office is a broken office" — three thousand junk inquiries is a
 * screen nobody can find the real family in, which is a denial of service against the madrasah rather
 * than against the server. So one counter for the whole install over a calendar day, above which the
 * surface answers exactly as it always does and stores nothing. §14's no-enumeration rule covers being
 * over the ceiling too: the response must not reveal that it is.
 *
 * The day is derived from the caller's clock rather than stored, so a restart neither resets the
 * ceiling to zero mid-afternoon nor carries yesterday's; in-process because an install is one process.
 */
export class DailyCeiling {
  private day = '';
  private count = 0;
  constructor(private readonly max: number) {}

  /** The count so far today — for the office's own diagnostics, never for the response. */
  get used(): number {
    return this.count;
  }

  allow(now = Date.now()): boolean {
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.count = 0;
    }
    if (this.count >= this.max) return false;
    this.count += 1;
    return true;
  }
}

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
 * identifier, so laundering failures by switching endpoints must not work. Nor, since 0.52.0, by
 * flooding the map with codes until the locked ones are evicted (see the header).
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
