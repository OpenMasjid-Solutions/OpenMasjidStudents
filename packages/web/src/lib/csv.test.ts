// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * CSV parsing, export escaping, and the import dialog's column auto-matcher.
 *
 * A spreadsheet export is the one input whose shape we do not control, so the parser is pinned
 * against the awkward real-world cases: quoted commas, embedded newlines, doubled quotes, CRLF,
 * a UTF-8 BOM, and ragged rows.
 */
import { describe, it, expect } from 'vitest';
import { parseCsv, autoMatchColumns, toCsv } from './csv';

describe('parseCsv', () => {
  it('parses a plain file with CRLF', () => {
    const r = parseCsv('First,Last\r\nYusuf,Ismail\r\nSara,Ismail\r\n');
    expect(r.headers).toEqual(['First', 'Last']);
    expect(r.rows).toEqual([['Yusuf', 'Ismail'], ['Sara', 'Ismail']]);
  });

  it('handles LF-only files and a trailing newline-less last row', () => {
    const r = parseCsv('First,Last\nYusuf,Ismail');
    expect(r.rows).toEqual([['Yusuf', 'Ismail']]);
  });

  it('strips a UTF-8 BOM from the first header', () => {
    const r = parseCsv('﻿First,Last\nA,B');
    expect(r.headers).toEqual(['First', 'Last']);
  });

  it('keeps commas and newlines inside quoted cells', () => {
    const r = parseCsv('Name,Note\n"Ismail, Yusuf","line1\nline2"\n');
    expect(r.rows).toEqual([['Ismail, Yusuf', 'line1\nline2']]);
  });

  it('unescapes doubled quotes', () => {
    const r = parseCsv('Name\n"He said ""hi"""\n');
    expect(r.rows).toEqual([['He said "hi"']]);
  });

  it('pads a short row and truncates a long one to the header width', () => {
    const r = parseCsv('A,B,C\n1,2\n1,2,3,4\n');
    expect(r.rows).toEqual([['1', '2', ''], ['1', '2', '3']]);
  });

  it('ignores blank lines, including trailing ones', () => {
    const r = parseCsv('A,B\n1,2\n\n\n');
    expect(r.rows).toEqual([['1', '2']]);
  });

  it('returns nothing for an empty or whitespace-only file', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] });
    expect(parseCsv('\n\n')).toEqual({ headers: [], rows: [] });
  });
});

describe('autoMatchColumns', () => {
  const fields = [
    { key: 'firstName', label: 'First name', aliases: ['first', 'first name', 'given name', 'name'] },
    { key: 'lastName', label: 'Last name', aliases: ['last', 'last name', 'surname'] },
    { key: 'amount', label: 'Amount', aliases: ['amount', 'paying', 'fee', 'tuition'] },
    { key: 'guardianPhone', label: 'Guardian phone', aliases: ['phone', 'mobile', 'contact'] },
  ];

  it('matches exact labels regardless of case and separators', () => {
    const m = autoMatchColumns(['FIRST_NAME', 'last name', 'Amount'], fields);
    expect(m.firstName).toBe(0);
    expect(m.lastName).toBe(1);
    expect(m.amount).toBe(2);
  });

  it('matches known aliases — "Paying" is the column the office actually uses', () => {
    const m = autoMatchColumns(['Student', 'Paying', 'Father'], fields);
    expect(m.amount).toBe(1);
  });

  it('never assigns one header to two fields', () => {
    const m = autoMatchColumns(['Name'], fields);
    const claimed = Object.values(m).filter((i) => i >= 0);
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it('reports -1 for anything it cannot place, so the dialog can prompt', () => {
    const m = autoMatchColumns(['Wholly Unrelated'], fields);
    expect(m.amount).toBe(-1);
    expect(m.lastName).toBe(-1);
  });

  it('prefers an exact match over a loose one even when the loose column comes first', () => {
    // "Phone number" would loosely match guardianPhone, but "Guardian phone" is exact.
    const m = autoMatchColumns(['Phone number', 'Guardian phone'], fields);
    expect(m.guardianPhone).toBe(1);
  });
});

describe('toCsv keeps the export safe to open', () => {
  it('neutralises a leading formula trigger (CLAUDE.md §14)', () => {
    const csv = toCsv(['Name'], [['=SUM(A1:A9)'], ['+1'], ['-2'], ['@x']]);
    for (const line of csv.split('\r\n').slice(1)) expect(line.startsWith("'")).toBe(true);
  });

  it('RFC-4180 quotes commas, quotes and newlines', () => {
    expect(toCsv(['A'], [['x,y']])).toContain('"x,y"');
    expect(toCsv(['A'], [['he "said"']])).toContain('"he ""said"""');
  });
});
