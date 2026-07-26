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
import { describe, it, expect } from 'vitest';
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
