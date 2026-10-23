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
import { parseCsv, autoMatchColumns, toCsv, unescapeCell } from './csv';

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

  /**
   * The headers of a real QuickSchools export, which is the file offices actually arrive with.
   *
   * These labels and aliases MIRROR people/import.ts' IMPORT_FIELDS — the server owns them, and it
   * cannot be imported here (it opens the database at module load). The server suite asserts the
   * aliases this leans on still exist, so a drift breaks there rather than silently passing here.
   */
  it('maps a real export’s headers — none of which are words we chose', () => {
    const canonical = [
      { key: 'fullName', label: 'Full name', aliases: ['name', 'full name', 'fullname', 'student', 'student name', 'first name', 'child', 'child name'] },
      { key: 'dob', label: 'Date of birth', aliases: ['dob', 'birthdate', 'birthday', 'date of birth', 'birth date'] },
      { key: 'className', label: 'Class', aliases: ['class', 'section', 'level', 'grade', 'homeroom'] },
      { key: 'guardianName', label: 'Guardian name', aliases: ['guardian', 'parent', 'father', 'mother', 'guardian name'] },
      { key: 'guardianRelation', label: 'Relationship', aliases: ['relationship', 'relation', 'guardian relationship', 'parent relationship'] },
      { key: 'guardianPhone', label: 'Guardian phone', aliases: ['phone', 'mobile', 'cell', 'guardian phone', 'contact'] },
      { key: 'guardianEmail', label: 'Guardian email', aliases: ['email', 'guardian email', 'e-mail'] },
    ];
    const m = autoMatchColumns(['Student Name', 'Homeroom', 'Birthday', 'Parent / Guardian', 'Relationship', 'Cell Phone', 'Email'], canonical);
    expect(m).toMatchObject({ fullName: 0, className: 1, dob: 2, guardianName: 3, guardianRelation: 4, guardianPhone: 5, guardianEmail: 6 });
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

describe('the formula guard round-trips (0.52.0)', () => {
  /**
   * The guard is a §14 control and it stays. What changed is that a template exported PRE-FILLED with
   * the office's own data (§4a Phase 1) is meant to be edited and uploaded back — and until now a
   * `+44…` phone and a negative amount came back with a `'` welded to the front and were stored that
   * way. The fix reverses it in the READER, where the file is known to be ours.
   */
  it('gives back exactly what went in, for every character the guard fires on', () => {
    const originals = ['=SUM(A1:A9)', '+44 7700 900123', '-25.00', '@handle'];
    const back = parseCsv(toCsv(['Value'], originals.map((v) => [v])));
    expect(back.rows.map((r) => r[0])).toEqual(originals);
  });

  it('DOES NOT strip an apostrophe that is part of the name', () => {
    // The whole care in this fix. An unconditional strip would rename children in this app's own
    // audience: a leading apostrophe is an ordinary way to write the ayn.
    for (const name of ["'Abd Allah", "'Uthman", "'Aisha"]) {
      expect(unescapeCell(name)).toBe(name);
      expect(parseCsv(toCsv(['Name'], [[name]])).rows[0][0]).toBe(name);
    }
  });

  it("resolves the one ambiguous cell toward the common case, and that is a deliberate loss", () => {
    // A literal apostrophe followed by a formula character is indistinguishable from an escaped one:
    // escapeCell tests the FIRST character, and for "'+1" that is the apostrophe, which is not a
    // formula lead — so it exports unchanged and reads back exactly like an escaped "+1".
    //
    // Pinned here rather than left to be discovered. One side of this is a phone number the office
    // exported and re-imported; the other is somebody typing an apostrophe in front of a plus sign.
    expect(toCsv(['A'], [["'+1"]])).toContain("'+1");
    expect(unescapeCell("'+1")).toBe('+1');
  });

  it('leaves an ordinary cell alone', () => {
    expect(unescapeCell('Yusuf Ismail')).toBe('Yusuf Ismail');
    expect(unescapeCell('')).toBe('');
    expect(unescapeCell("'")).toBe("'");
  });
});
