// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { describe, it, expect } from 'vitest';
import { DailyCeiling, LoginLimiter, SubmitLimiter } from './rateLimit';
import { foldIpForKey } from './origin';

describe('LoginLimiter', () => {
  it('allows attempts until the failure threshold, then blocks', () => {
    const l = new LoginLimiter({ maxFailures: 3, windowMs: 60_000, blockMs: 60_000 });
    const now = 1_000_000; // fixed clock (Date.now would break determinism)
    const key = '10.0.0.5';
    expect(l.retryAfterMs(key, now)).toBe(0);
    l.fail(key, now);
    l.fail(key, now);
    expect(l.retryAfterMs(key, now)).toBe(0); // 2 failures — still allowed
    l.fail(key, now); // 3rd → blocked
    expect(l.retryAfterMs(key, now)).toBeGreaterThan(0);
  });

  it('clears the block after it expires', () => {
    const l = new LoginLimiter({ maxFailures: 1, windowMs: 60_000, blockMs: 30_000 });
    const now = 5_000_000;
    l.fail('k', now);
    expect(l.retryAfterMs('k', now)).toBe(30_000);
    expect(l.retryAfterMs('k', now + 30_001)).toBe(0);
  });

  it('a success resets the counter', () => {
    const l = new LoginLimiter({ maxFailures: 2, windowMs: 60_000, blockMs: 60_000 });
    const now = 9_000_000;
    l.fail('peer', now);
    l.succeed('peer');
    l.fail('peer', now); // back to 1 failure, not blocked
    expect(l.retryAfterMs('peer', now)).toBe(0);
  });

  it('keys are independent (one peer cannot block another)', () => {
    const l = new LoginLimiter({ maxFailures: 1, windowMs: 60_000, blockMs: 60_000 });
    const now = 2_000_000;
    l.fail('attacker', now);
    expect(l.retryAfterMs('attacker', now)).toBeGreaterThan(0);
    expect(l.retryAfterMs('victim', now)).toBe(0);
  });
});

describe('SubmitLimiter', () => {
  it('caps submissions per key within the window', () => {
    const l = new SubmitLimiter(2, 60_000);
    const now = 1_000_000;
    expect(l.allow('ip', now)).toBe(true);
    expect(l.allow('ip', now)).toBe(true);
    expect(l.allow('ip', now)).toBe(false); // 3rd in-window blocked
    expect(l.allow('ip', now + 60_001)).toBe(true); // new window
  });

  /**
   * THE INVERSION (0.52.0, §4a Phase 2). This test asserted the OPPOSITE until now — that k0 is
   * allowed again after the flood — and was right about what the code did. The code was the bug: the
   * key an attacker floods with is one they choose, so "evict oldest-first" made every per-key limit
   * in the app self-clearing. Delete the ordered `prune` in rateLimit.ts and this goes red.
   */
  it('does NOT forgive a key at its cap under a flood of distinct keys', () => {
    const l = new SubmitLimiter(1, 3_600_000); // 1/hour so nothing expires during the test
    const now = 1_000_000; // fixed clock — a real one would let the window expire mid-flood
    expect(l.allow('k0', now)).toBe(true);
    expect(l.allow('k0', now)).toBe(false); // k0 is now at its cap
    for (let i = 0; i < 50_200; i++) l.allow('flood-' + i, now);
    expect(l.allow('k0', now)).toBe(false); // still capped — the flood bought nothing
  });

  it('stays bounded under that flood, and fails closed once it is full', () => {
    const l = new SubmitLimiter(1, 3_600_000);
    const now = 2_000_000;
    for (let i = 0; i < 50_200; i++) l.allow('flood-' + i, now);
    // Every entry is at its cap, so none may be dropped — the map stops admitting instead of growing.
    expect(l.size).toBeLessThanOrEqual(50_000);
    expect(l.allow('someone-new', now)).toBe(false); // public surfaces fail CLOSED (see the header)
  });

  it('forgives a partial counter rather than a live cap, when it has to choose', () => {
    const l = new SubmitLimiter(3, 3_600_000); // room for a partial count below the cap
    const now = 3_000_000;
    l.allow('partial', now); // 1 of 3 — a counter, not a cap
    l.allow('capped', now);
    l.allow('capped', now);
    l.allow('capped', now); // 3 of 3 — at its cap
    for (let i = 0; i < 50_200; i++) l.allow('flood-' + i, now); // each flood key: 1 of 3, evictable
    expect(l.size).toBeLessThanOrEqual(50_000);
    expect(l.allow('capped', now)).toBe(false); // the cap survived the flood
  });
});

describe('LoginLimiter under flood', () => {
  it('keeps a live block while the map is being flooded', () => {
    const l = new LoginLimiter({ maxFailures: 2, windowMs: 3_600_000, blockMs: 3_600_000 });
    const now = 4_000_000;
    l.fail('victim', now);
    l.fail('victim', now); // blocked for an hour
    expect(l.retryAfterMs('victim', now)).toBeGreaterThan(0);
    // The Student ID lockout is keyed on the SUPPLIED code, so an attacker sweeping codes generates
    // this flood for free — which is what made the old eviction a bypass rather than a memory bound.
    for (let i = 0; i < 50_200; i++) l.fail('flood-' + i, now);
    expect(l.retryAfterMs('victim', now)).toBeGreaterThan(0);
    expect(l.size).toBeLessThanOrEqual(50_000);
  });

  it('a dead entry is dropped before a live one', () => {
    const l = new LoginLimiter({ maxFailures: 1, windowMs: 1_000, blockMs: 1_000 });
    const t0 = 5_000_000;
    l.fail('expired', t0); // blocked, but only for a second
    const later = t0 + 10_000; // by now that block is dead
    l.fail('live', later); // blocked at `later`
    for (let i = 0; i < 50_200; i++) l.fail('flood-' + i, later);
    expect(l.retryAfterMs('live', later)).toBeGreaterThan(0);
    expect(l.size).toBeLessThanOrEqual(50_000);
  });
});

describe('foldIpForKey', () => {
  it('leaves an IPv4 address alone — one address is one host', () => {
    expect(foldIpForKey('203.0.113.7')).toBe('203.0.113.7');
    expect(foldIpForKey('::ffff:203.0.113.7')).toBe('203.0.113.7'); // IPv4 wearing an IPv6 hat
  });

  it('folds IPv6 to its /64, so one customer is one bucket', () => {
    // The whole reason this exists: these are 2^64 distinct addresses one household can present,
    // and without folding they are 2^64 distinct limiter keys.
    const a = foldIpForKey('2001:db8:1234:5678:aaaa:bbbb:cccc:dddd');
    const b = foldIpForKey('2001:db8:1234:5678:1:2:3:4');
    expect(a).toBe(b);
    expect(a).toBe('2001:db8:1234:5678::/64');
  });

  it('a different /64 is a different bucket (folding must not merge neighbours)', () => {
    expect(foldIpForKey('2001:db8:1234:5678::1')).not.toBe(foldIpForKey('2001:db8:1234:9999::1'));
  });

  it('reads compressed and zero-padded forms as the same address', () => {
    expect(foldIpForKey('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(foldIpForKey('2001:db8::1'));
    expect(foldIpForKey('2001:DB8::1')).toBe('2001:db8:0:0::/64'); // case is not part of an address
    expect(foldIpForKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64'); // a zone id is about us, not the peer
    // The key is the four groups as written out, not a re-compressed address — it is a bucket name,
    // and one spelling per prefix is the only property that matters. A `:` and a `/64` in it also
    // mean it can never collide with an IPv4 key or with an unparseable one keyed on itself.
  });

  it('keys an unreadable address on itself rather than guessing (the strict direction)', () => {
    // Guessing would be the dangerous failure: two clients folded into one bucket is a limiter that
    // blocks the wrong person. Its own bucket can only ever be correct-or-stricter.
    expect(foldIpForKey('2001:db8::1::2')).toBe('2001:db8::1::2');
    expect(foldIpForKey('nonsense')).toBe('nonsense');
    expect(foldIpForKey('')).toBe('unknown');
    expect(foldIpForKey(undefined)).toBe('unknown');
  });
});

describe('DailyCeiling', () => {
  it('counts to its ceiling and then refuses for the rest of the day', () => {
    const c = new DailyCeiling(2);
    const noon = Date.parse('2026-09-14T12:00:00Z');
    expect(c.allow(noon)).toBe(true);
    expect(c.allow(noon)).toBe(true);
    expect(c.allow(noon)).toBe(false);
    expect(c.allow(noon + 11 * 3_600_000)).toBe(false); // 11pm the same day
  });

  it('starts again on the next day', () => {
    const c = new DailyCeiling(1);
    const day1 = Date.parse('2026-09-14T23:00:00Z');
    expect(c.allow(day1)).toBe(true);
    expect(c.allow(day1)).toBe(false);
    expect(c.allow(Date.parse('2026-09-15T01:00:00Z'))).toBe(true);
  });
});
