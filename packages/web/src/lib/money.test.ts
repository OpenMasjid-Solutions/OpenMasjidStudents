// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The two money parsers, and specifically the split between them.
 *
 * `parseCents` refuses negatives on purpose — a payment, a fee-plan price, a per-student override and
 * a discount are all amounts owed, where a minus sign is a typo. A CHARGE is the one place a negative
 * is meaningful: an invoice line is immutable once written (§9), so a credit, refund or scholarship is
 * expressed as a second, negative charge. Using the wrong parser there silently disables the whole
 * credit path — the form just never submits — which is exactly the bug these tests pin down.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseCents, parseSignedCents, formatMoney } from './money';

describe('parseCents — amounts that are owed', () => {
  it('parses dollars and cents to integer cents', () => {
    expect(parseCents('35')).toBe(3500);
    expect(parseCents('35.50')).toBe(3550);
    expect(parseCents(' 12.05 ')).toBe(1205);
  });

  it('rounds rather than truncating, so a half cent cannot vanish', () => {
    expect(parseCents('0.005')).toBe(1);
    expect(parseCents('10.994')).toBe(1099);
  });

  it('refuses a negative amount', () => {
    expect(parseCents('-50')).toBeNull();
    expect(parseCents('-0.01')).toBeNull();
  });

  it('refuses nonsense', () => {
    expect(parseCents('abc')).toBeNull();
    expect(parseCents('1.2.3')).toBeNull();
  });
});

describe('parseSignedCents — charges, which may credit', () => {
  it('parses positives the same way', () => {
    expect(parseSignedCents('35')).toBe(3500);
    expect(parseSignedCents('35.50')).toBe(3550);
  });

  // The regression this file exists for.
  it('ACCEPTS a negative amount — this is how a credit or scholarship is issued', () => {
    expect(parseSignedCents('-50')).toBe(-5000);
    expect(parseSignedCents('-12.75')).toBe(-1275);
  });

  it('returns null for blank input rather than 0, so an empty field is not a zero charge', () => {
    expect(parseSignedCents('')).toBeNull();
    expect(parseSignedCents('   ')).toBeNull();
  });

  it('returns 0 for an explicit zero — the server refuses it with a clear message', () => {
    expect(parseSignedCents('0')).toBe(0);
  });

  it('refuses nonsense and infinities', () => {
    expect(parseSignedCents('abc')).toBeNull();
    expect(parseSignedCents('Infinity')).toBeNull();
    expect(parseSignedCents('-Infinity')).toBeNull();
  });
});

describe('formatMoney', () => {
  it('formats cents as currency', () => {
    expect(formatMoney(35000, 'usd')).toContain('350');
    expect(formatMoney(0, 'usd')).toContain('0');
  });

  it('shows a negative as negative (a credit line must not read as a charge)', () => {
    expect(formatMoney(-5000, 'usd')).toMatch(/-|\(/);
  });

  it('falls back readably on an unknown currency code instead of throwing', () => {
    expect(formatMoney(1000, 'zzz')).toContain('ZZZ');
  });
});

/**
 * The formatter is built once per currency, not once per amount.
 *
 * This is a performance property, so it is asserted the only way a performance property can be: by
 * counting the constructor. `formatMoney` runs once per money cell, and the screens that matter have
 * hundreds of them — a billing record is every invoice, every line of every invoice and every payment;
 * the year view is every child times twelve months — with the whole lot re-rendered on each keystroke
 * in any form beside them. Constructing an `Intl.NumberFormat` costs an order of magnitude more than
 * formatting a number with one that exists, so the count is the thing worth pinning.
 *
 * A real subclass rather than a spy, because these are called with `new`. Every currency below is one
 * no earlier test in this file has used: the cache is module state, so a code already formatted would
 * make the assertion pass without proving anything.
 */
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

  it('builds one formatter for many amounts in the same currency', () => {
    const out = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => formatMoney(n * 1000, 'gbp'));
    expect(built).toBe(1);
    expect(out[0]).not.toBe(out[1]); // and it really did format each amount
  });

  it('reuses the cached formatter on a later render', () => {
    formatMoney(100, 'jpy');
    const first = built;
    for (let i = 0; i < 20; i++) formatMoney(i, 'jpy');
    expect(built).toBe(first);
  });

  it('does not build a second formatter for the same currency written differently', () => {
    formatMoney(100, 'chf');
    formatMoney(100, 'CHF');
    formatMoney(100, 'Chf');
    expect(built).toBe(1);
  });

  it('remembers an unknown code too, so a bad setting is not a throw per cell', () => {
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
