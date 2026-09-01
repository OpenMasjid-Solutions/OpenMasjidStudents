// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The phone formatter is used as an as-you-type mask, so the partial states matter as much as the
 * finished one — and the load-bearing rule is that it never eats a number it doesn't recognize.
 */
import { describe, it, expect } from 'vitest';
import { formatUsPhone, telHref } from './phone';

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

describe('telHref', () => {
  /**
   * IT RETURNS THE WHOLE HREF, scheme included (0.48.0).
   *
   * It used to return bare digits, so every caller had to write `href={`tel:${telHref(x)}`}` — and one of
   * them forgot. Without the scheme the browser reads it as a RELATIVE PATH and resolves it against the
   * app's `<base href>`, so tapping a number in the no-email list navigated to `/students/4453062685`
   * instead of dialling. Hence the scheme assertion on every case below: it is the part that was missing.
   */
  it('is a complete tel: URI', () => {
    expect(telHref('(555) 123-4567')).toBe('tel:5551234567');
    // Never a bare number, which a browser would treat as a path.
    expect(telHref('(555) 123-4567').startsWith('tel:')).toBe(true);
  });

  it('strips the formatting a dialler might choke on', () => {
    expect(telHref('555.123.4567 ')).toBe('tel:5551234567');
    expect(telHref(' (555)1234567')).toBe('tel:5551234567');
  });

  it('keeps a country code the person typed', () => {
    expect(telHref('+44 20 7946 0958')).toBe('tel:+442079460958');
  });

  it('is empty for nothing, so no dead link is rendered', () => {
    // Empty rather than "tel:" — a caller checks for a falsy value to render plain text instead of a link.
    expect(telHref(null)).toBe('');
    expect(telHref('')).toBe('');
    expect(telHref(undefined)).toBe('');
  });
});
