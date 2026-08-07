// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The browser's date formatter (0.47.0).
 *
 * This deliberately duplicates the server's `formatDate`, so what is worth testing is that the two
 * still AGREE: the year view renders a date in the browser while the printed sheet renders the same
 * date on the server, and a masjid seeing 04/03 on screen and 03/04 on paper would have no way to
 * tell which was right. The expected strings below are copied from the server's own test.
 */
import { describe, it, expect } from 'vitest';
import { formatDate, type DateFormat } from './dates';

describe('formatDate', () => {
  it('matches the server for every configured format', () => {
    const expected: Record<DateFormat, string> = {
      iso: '2026-03-04',
      us: '03/04/2026',
      uk: '04/03/2026',
      long: '4 Mar 2026',
    };
    for (const [fmt, out] of Object.entries(expected)) {
      expect(formatDate('2026-03-04', fmt as DateFormat)).toBe(out);
    }
  });

  it('defaults to ISO when nothing is configured', () => {
    expect(formatDate('2026-03-04')).toBe('2026-03-04');
  });

  it('renders a blank rather than "Invalid Date" for anything that is not a stored date', () => {
    // A DOB is optional by design, so the common case here is simply absent.
    for (const v of [null, undefined, '', '   ', 'not a date', '2026-3-4']) {
      expect(formatDate(v as string, 'uk')).toBe('');
    }
  });

  it('drops the leading zero on the day in the long form, but not in the numeric ones', () => {
    expect(formatDate('2026-12-05', 'long')).toBe('5 Dec 2026');
    expect(formatDate('2026-12-05', 'uk')).toBe('05/12/2026');
  });
});
