// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The phone formatter is used as an as-you-type mask, so the partial states matter as much as the
 * finished one — and the load-bearing rule is that it never eats a number it doesn't recognise.
 */
import { describe, it, expect } from 'vitest';
import { formatUsPhone } from './phone';

describe('formatUsPhone', () => {
  it('formats a 10-digit US number however it was written', () => {
    for (const raw of ['5551234567', '555-123-4567', '555.123.4567', '(555)1234567', ' 555 123 4567 ']) {
      expect(formatUsPhone(raw)).toBe('(555) 123-4567');
    }
  });

  it('formats as far as it can while typing', () => {
    expect(formatUsPhone('5')).toBe('5');
    expect(formatUsPhone('555')).toBe('555');
    expect(formatUsPhone('5551')).toBe('(555) 1');
    expect(formatUsPhone('555123')).toBe('(555) 123');
    expect(formatUsPhone('5551234')).toBe('(555) 123-4');
  });

  it('keeps a US number pasted with its country code readable', () => {
    expect(formatUsPhone('15551234567')).toBe('1 (555) 123-4567');
  });

  it('leaves an international number exactly as typed', () => {
    expect(formatUsPhone('+44 20 7946 0958')).toBe('+44 20 7946 0958');
    expect(formatUsPhone('+1 555 123 4567')).toBe('+1 555 123 4567');
  });

  it('leaves anything too long for a US number alone rather than truncating it', () => {
    // An extension, or a number from somewhere we don't format. Losing digits would be worse than
    // showing them unformatted.
    expect(formatUsPhone('5551234567 x210')).toBe('5551234567 x210');
    expect(formatUsPhone('0044 20 7946 0958')).toBe('0044 20 7946 0958');
  });

  it('handles nothing at all', () => {
    expect(formatUsPhone('')).toBe('');
    expect(formatUsPhone(null)).toBe('');
    expect(formatUsPhone(undefined)).toBe('');
  });

  it('is stable — formatting an already-formatted number changes nothing', () => {
    expect(formatUsPhone('(555) 123-4567')).toBe('(555) 123-4567');
    expect(formatUsPhone(formatUsPhone('5551234567'))).toBe('(555) 123-4567');
  });
});
