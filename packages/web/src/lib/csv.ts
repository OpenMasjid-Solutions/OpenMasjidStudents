// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** CSV export with formula-injection escaping (CLAUDE.md §14): a cell starting with = + - @ (or a
 *  tab/CR) is prefixed with a quote so spreadsheets don't execute it; commas/quotes/newlines are
 *  RFC-4180 quoted. Used by the Report Creator (and any CSV export). */

/** The characters that make a spreadsheet treat a cell as a formula rather than text. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

function escapeCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (FORMULA_LEAD.test(s)) s = `'${s}`; // neutralize a leading formula trigger
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Undo `escapeCell`'s formula guard when reading a file back (0.52.0).
 *
 * The guard is a §14 security control and it stays: a guardian named `=cmd|…` or a memo pasted by a
 * parent must not execute when the office opens the export. But the moment a template is exported
 * PRE-FILLED with real data for the office to edit and upload back (§4a Phase 1), the guard becomes a
 * round-trip bug — a `+44…` phone number and a negative amount both come back with a `'` welded to the
 * front, and get stored that way.
 *
 * **The fix belongs in the reader, not the writer.** Dropping the prefix on the way out would remove the
 * control; this reverses it on the way in, which is the only place that knows the file is ours to undo.
 *
 * It strips a leading `'` **only when a formula character follows it**, which is precisely what
 * `escapeCell` can produce. That condition is the whole care in this function: `'Abd Allah` and
 * `'Uthmān` are ordinary ways to write a name in this app's own audience, and an unconditional strip
 * would quietly rename children.
 *
 * One cell stays ambiguous and always will: a value that genuinely IS `'+1` is indistinguishable from
 * an escaped `+1`, because `escapeCell` tests the first character and for `'+1` that is the apostrophe,
 * which is not a formula lead — so it exports unchanged. Resolved toward the common case (a phone
 * number the office exported and re-imported), and pinned by a test rather than left to be found.
 */
export function unescapeCell(s: string): string {
  return s.startsWith("'") && FORMULA_LEAD.test(s.slice(1)) ? s.slice(1) : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers.map(escapeCell).join(','), ...rows.map((r) => r.map(escapeCell).join(','))].join('\r\n');
}

/** A parsed table: the header row, and every data row padded/truncated to its width. */
export interface Grid {
  headers: string[];
  rows: string[][];
}

/**
 * The raw cells of a file → a header row + data rows, trimmed and rectangular.
 *
 * Shared by both readers (CSV here, XLSX in xlsx.ts) so the two cannot disagree about what the first
 * row means or how a short row is padded — the import dialog maps columns BY INDEX, so a difference
 * of one column between the two paths would silently shift every field.
 *
 * Fully blank rows are dropped (a spreadsheet is full of them, and a trailing one is not a student);
 * the first row with anything in it is the header.
 *
 * It is also where the formula guard is undone (`unescapeCell`), for the same reason it is where the
 * shape is decided: both readers land here, so a file exported by this app round-trips identically
 * whether it comes back as .csv or .xlsx.
 */
export function shapeGrid(cells: string[][]): Grid {
  const clean = (v: string | undefined) => unescapeCell((v ?? '').trim());
  const nonEmpty = cells.filter((r) => r.some((v) => (v ?? '').trim() !== ''));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };
  const headers = nonEmpty[0].map(clean);
  const width = headers.length;
  const rows = nonEmpty.slice(1).map((r) => Array.from({ length: width }, (_, i) => clean(r[i])));
  return { headers, rows };
}

/** Parse a CSV file into a header row + data rows (RFC 4180: double-quoted fields, "" escapes, and
 *  newlines inside quotes). Hand-rolled deliberately — a spreadsheet export is the one input we
 *  cannot control the shape of, and this is far less weight than a parser dependency.
 *
 *  Tolerates CRLF or LF, a UTF-8 BOM, and trailing blank lines. Ragged rows are padded/truncated to
 *  the header width so a short final row can't shift every column. */
export function parseCsv(text: string): Grid {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } // "" → a literal quote
        else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(cell); cell = ''; continue; }
    if (c === '\r') { if (src[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += c;
  }
  // Flush the last cell/row unless the file ended on a clean newline.
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }

  return shapeGrid(rows);
}

/** Best-effort header → field matching for the import dialog. Exact label/key wins, then a known
 *  alias, then a loose contains match. Returns a map of fieldKey → header index (or -1).
 *  The dialog ALWAYS shows the result for confirmation — this only saves typing, it never decides. */
export function autoMatchColumns(
  headers: string[],
  fields: { key: string; label: string; aliases: string[] }[],
): Record<string, number> {
  const norm = (s: string) => s.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  const normalized = headers.map(norm);
  const taken = new Set<number>();
  const out: Record<string, number> = {};

  const claim = (key: string, idx: number) => { out[key] = idx; taken.add(idx); };
  const find = (pred: (h: string) => boolean) => normalized.findIndex((h, i) => !taken.has(i) && pred(h));

  // Exact matches first across ALL fields, so a precise header is never stolen by a loose one.
  for (const f of fields) {
    const i = find((h) => h === norm(f.label) || h === norm(f.key));
    if (i >= 0) claim(f.key, i);
  }
  for (const f of fields) {
    if (out[f.key] !== undefined) continue;
    const i = find((h) => f.aliases.some((a) => h === norm(a)));
    if (i >= 0) claim(f.key, i);
  }
  for (const f of fields) {
    if (out[f.key] !== undefined) continue;
    const i = find((h) => h.length >= 3 && (h.includes(norm(f.label)) || f.aliases.some((a) => norm(a).length >= 3 && h.includes(norm(a)))));
    if (i >= 0) claim(f.key, i);
  }
  for (const f of fields) if (out[f.key] === undefined) out[f.key] = -1;
  return out;
}

/** Trigger a client-side download of `csv` as `filename`. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }); // BOM so Excel reads UTF-8
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
