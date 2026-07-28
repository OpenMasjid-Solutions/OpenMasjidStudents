// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Age is shown next to a child's name in the directory, so the boundary cases are the ones that get
 * noticed: the day before a birthday, the day of it, and a date of birth nobody has filled in.
 */
import { describe, it, expect } from 'vitest';
import { ageFromDob } from './age';

/** A fixed "today" — local noon, so nothing here depends on the machine's timezone. */
const today = new Date(2026, 6, 28, 12, 0, 0); // 2026-07-28

describe('ageFromDob', () => {
  it('counts whole years', () => {
    expect(ageFromDob('2016-07-14', today)).toBe(10);
    expect(ageFromDob('2020-01-01', today)).toBe(6);
  });

  it('does not count a birthday that has not arrived yet this year', () => {
    expect(ageFromDob('2016-07-29', today)).toBe(9); // tomorrow
    expect(ageFromDob('2016-12-31', today)).toBe(9);
  });

  it('counts the birthday itself', () => {
    expect(ageFromDob('2016-07-28', today)).toBe(10);
  });

  it('is null when there is no date of birth to work from', () => {
    expect(ageFromDob(null, today)).toBeNull();
    expect(ageFromDob(undefined, today)).toBeNull();
    expect(ageFromDob('', today)).toBeNull();
    expect(ageFromDob('14/07/2016', today)).toBeNull();
    expect(ageFromDob('2016-13-01', today)).toBeNull();
  });

  it('shows nothing rather than a negative age for a date typed in the future', () => {
    expect(ageFromDob('2030-01-01', today)).toBeNull();
  });

  it('reads the date by its parts, so it never shifts a day by timezone', () => {
    // A UTC-parsed '2016-01-01' becomes 2015-12-31 anywhere west of Greenwich, which would report a
    // child as a year older every New Year's Eve.
    expect(ageFromDob('2016-01-01', new Date(2026, 0, 1, 0, 30))).toBe(10);
  });

  it('handles a newborn', () => {
    expect(ageFromDob('2026-07-01', today)).toBe(0);
  });
});
