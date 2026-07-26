// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** CSV export with formula-injection escaping (CLAUDE.md §14): a cell starting with = + - @ (or a
 *  tab/CR) is prefixed with a quote so spreadsheets don't execute it; commas/quotes/newlines are
 *  RFC-4180 quoted. Used by the Report Creator (and any CSV export). */

function escapeCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralize a leading formula trigger
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers.map(escapeCell).join(','), ...rows.map((r) => r.map(escapeCell).join(','))].join('\r\n');
}

/** Parse a CSV file into a header row + data rows (RFC 4180: double-quoted fields, "" escapes, and
 *  newlines inside quotes). Hand-rolled deliberately — a spreadsheet export is the one input we
 *  cannot control the shape of, and this is far less weight than a parser dependency.
 *
 *  Tolerates CRLF or LF, a UTF-8 BOM, and trailing blank lines. Ragged rows are padded/truncated to
 *  the header width so a short final row can't shift every column. */
export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
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

  const nonEmpty = rows.filter((r) => r.some((v) => v.trim() !== ''));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };
  const headers = nonEmpty[0].map((h) => h.trim());
  const width = headers.length;
  const data = nonEmpty.slice(1).map((r) => Array.from({ length: width }, (_, i) => (r[i] ?? '').trim()));
  return { headers, rows: data };
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
