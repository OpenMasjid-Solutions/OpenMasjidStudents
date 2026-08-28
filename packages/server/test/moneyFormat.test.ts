// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * `formatMoney` builds one `Intl.NumberFormat` per currency, not one per amount (0.51.0-dev.16).
 *
 * It built a fresh formatter on every call, and it is called once per amount in everything this app
 * prints: a household statement, a per-child invoice, a class of ID sheets, a season's ledger as CSV.
 * Constructing a formatter costs an order of magnitude more than formatting a number with one that
 * already exists (locale resolution plus pattern lookup), so on the documents with the most rows the
 * constructor was most of the work.
 *
 * A performance property can only be asserted by counting, so that is what this does — with a real
 * subclass rather than a spy, because these are called with `new`. The browser half of the same fix,
 * where the counts are far larger, is pinned in `web/src/lib/money.test.ts`.
 *
 * Every currency here is one no other test in this file uses: the cache is module state, so a code
 * already formatted would make the assertion pass without proving anything.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { formatMoney, fromCents } from '../src/db/money';

describe('formatMoney', () => {
  it('still formats an amount as currency', () => {
    expect(formatMoney(35000, 'usd')).toContain('350');
    expect(formatMoney(-5000, 'usd')).toMatch(/-|\(/);
  });

  it('falls back readably on a currency this runtime does not know', () => {
    expect(formatMoney(1000, 'zzz')).toContain('ZZZ');
    expect(formatMoney(1000, 'zzz')).toContain('10.00');
  });

  it('converts cents to major units', () => {
    expect(fromCents(35000)).toBe(350);
  });
});

describe('formatMoney — one formatter per currency', () => {
  const real = Intl.NumberFormat;
  let built = 0;

  beforeEach(() => {
    built = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a counting test double for a constructor
    (Intl as any).NumberFormat = class extends real {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- forwards whatever the real signature takes
      constructor(...args: any[]) {
        built++;
        super(...(args as []));
      }
    };
  });
  afterEach(() => {
    Intl.NumberFormat = real;
  });

  // The regression this file exists for: one statement, one formatter.
  it('builds one formatter for a document full of amounts', () => {
    const rows = Array.from({ length: 60 }, (_, i) => formatMoney((i + 1) * 1000, 'gbp'));
    expect(built).toBe(1);
    expect(rows[0]).not.toBe(rows[1]); // and every amount really was formatted
  });

  it('reuses it on the next document', () => {
    formatMoney(100, 'jpy');
    const first = built;
    for (let i = 0; i < 25; i++) formatMoney(i, 'jpy');
    expect(built).toBe(first);
  });

  it('does not build a second formatter for the same currency written differently', () => {
    formatMoney(100, 'chf');
    formatMoney(100, 'CHF');
    formatMoney(100, 'Chf');
    expect(built).toBe(1);
  });

  it('remembers an unknown code too, so a bad setting is not a throw per amount', () => {
    expect(formatMoney(1000, 'qqq')).toContain('QQQ');
    expect(formatMoney(2000, 'qqq')).toContain('QQQ');
    expect(formatMoney(3000, 'qqq')).toContain('QQQ');
    expect(built).toBe(1);
  });

  it('keeps currencies apart', () => {
    formatMoney(100, 'sek');
    formatMoney(100, 'nok');
    expect(built).toBe(2);
  });
});
