// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Date display and input (0.47.0 — settings/dates.ts).
 *
 * The invariant that everything else rests on: STORAGE IS ALWAYS ISO. The setting moves only what a
 * human reads and what a human may type. If a future change ever lets a non-ISO string reach the
 * database, sorting breaks silently (dates are compared as text throughout) and `03/04` becomes two
 * different days depending on who is looking.
 *
 * EVERY CALL HERE PASSES ITS FORMAT EXPLICITLY, and has to. Both functions default that argument to
 * `getDateFormat()`, which reads the settings table — and a default argument is evaluated before the
 * body, so even `formatDate('')` would touch the database. This file has no harness and wants none:
 * these are pure functions and the point is to test them as such. Omitting the format made the suite
 * pass on a machine that happened to have a database and fail on a clean checkout, which is exactly
 * what it did on CI for the whole of 0.47.0. The setting-reading path is covered where a database
 * genuinely exists — import.test.ts, statements.test.ts and onboardingSheet.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { DATE_FORMATS, DATE_FORMAT_SAMPLES, formatDate, parseDateInput } from '../src/settings/dates';

describe('formatDate', () => {
  it('writes the same stored date each configured way', () => {
    expect(formatDate('2026-03-04', 'iso')).toBe('2026-03-04');
    expect(formatDate('2026-03-04', 'us')).toBe('03/04/2026');
    expect(formatDate('2026-03-04', 'uk')).toBe('04/03/2026');
    expect(formatDate('2026-03-04', 'long')).toBe('4 Mar 2026');
  });

  it('every advertised option renders its own sample', () => {
    // The settings screen SHOWS these rather than describing them, so a sample that did not match
    // what the option actually produces would be a lie in the one place it matters.
    for (const f of DATE_FORMATS) expect(formatDate('2026-03-04', f)).toBe(DATE_FORMAT_SAMPLES[f]);
  });

  it('renders a blank for anything that is not a stored date', () => {
    // A DOB is optional by design (§14), so absent must read as empty, never "Invalid Date".
    for (const v of [null, undefined, '', 'not a date', '2026-3-4']) expect(formatDate(v as string, 'iso')).toBe('');
  });
});

describe('parseDateInput', () => {
  it('always accepts ISO, whatever the format is set to', () => {
    // Non-negotiable: this app writes ISO, so a file exported from it must always re-import.
    for (const f of DATE_FORMATS) expect(parseDateInput('2026-03-04', f)).toBe('2026-03-04');
  });

  it('reads an ambiguous slashed date in the configured order', () => {
    expect(parseDateInput('03/04/2026', 'us')).toBe('2026-03-04');
    expect(parseDateInput('03/04/2026', 'uk')).toBe('2026-04-03');
    // `iso` and `long` have no slashed form of their own, so they fall back to month-first.
    expect(parseDateInput('03/04/2026', 'iso')).toBe('2026-03-04');
  });

  it('lets the numbers win when only one reading is possible', () => {
    // 25 cannot be a month, so this is the 25th even on a month-first install — the office pasting a
    // column from elsewhere is better served by the obvious answer than by an error.
    expect(parseDateInput('25/03/2026', 'us')).toBe('2026-03-25');
    expect(parseDateInput('12/25/2026', 'uk')).toBe('2026-12-25');
  });

  it('round-trips the long format it prints', () => {
    expect(parseDateInput(formatDate('2026-03-04', 'long'), 'long')).toBe('2026-03-04');
    expect(parseDateInput('4 March 2026', 'long')).toBe('2026-03-04');
  });

  it('accepts dots and dashes as separators', () => {
    expect(parseDateInput('4.3.2026', 'uk')).toBe('2026-03-04');
    expect(parseDateInput('4-3-2026', 'uk')).toBe('2026-03-04');
  });

  it('rejects three plausible numbers that are not a calendar date', () => {
    // The whole reason parsing is not a regex: 2026-02-30 matches the shape and is not a day.
    expect(parseDateInput('2026-02-30', 'iso')).toBeNull();
    expect(parseDateInput('31/02/2026', 'uk')).toBeNull();
    expect(parseDateInput('13/13/2026', 'us')).toBeNull();
  });

  it('rejects anything that is not a date at all, and reads blank as absent', () => {
    for (const v of ['sometime in 2015', 'N/A', '2026', 'March']) expect(parseDateInput(v, 'iso')).toBeNull();
    // Empty is NOT an error — a DOB column is allowed to be blank.
    for (const v of ['', '   ', null, undefined]) expect(parseDateInput(v as string, 'iso')).toBeNull();
  });

  it('refuses a year outside anything a madrasah would record', () => {
    expect(parseDateInput('1899-01-01', 'iso')).toBeNull();
    expect(parseDateInput('2201-01-01', 'iso')).toBeNull();
  });
});
