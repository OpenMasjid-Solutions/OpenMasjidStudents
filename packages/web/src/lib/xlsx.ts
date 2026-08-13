// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Reading a .xlsx in the browser, with no spreadsheet library (0.48.0).
 *
 * Offices do not have CSVs, they have workbooks. "Save as CSV first" was a step that lost people, and
 * it is the step where a date column gets reformatted by hand — which is exactly where 03/04 quietly
 * becomes the wrong day. So the import takes the file the office actually has.
 *
 * HAND-ROLLED, for the same reason parseCsv is (csv.ts): a spreadsheet reader that handles everything
 * is a very large dependency, and all this needs is the first sheet's cells as text. A .xlsx is a ZIP
 * of XML, and the browser already has both halves of that — `DecompressionStream` inflates, and the
 * XML this reads is machine-generated and regular enough to scan without a DOM parser (which also
 * keeps the reader testable outside a browser).
 *
 * What it deliberately does NOT do: formulas (the cached result is used), merged-cell spilling, charts,
 * styles beyond "is this cell formatted as a date", or the old binary .xls (detected and refused with a
 * message that says what to do instead). Anything it cannot read is an error the office can act on —
 * never a silently short or shifted grid, because the dialog maps columns by index.
 */
import { parseCsv, shapeGrid, type Grid } from './csv';

/** A file we cannot read, with a code the dialog turns into one friendly sentence. */
export class XlsxError extends Error {
  constructor(readonly code: 'notZip' | 'oldXls' | 'zip64' | 'noInflate' | 'tooBig' | 'noSheet' | 'compression') {
    super(code);
    this.name = 'XlsxError';
  }
}

/** A single XML part this size is not a roster (and a zip bomb inflates from almost nothing). */
const MAX_PART_BYTES = 64 * 1024 * 1024;

// ── ZIP ────────────────────────────────────────────────────────────────────────
const u16 = (v: DataView, o: number) => v.getUint16(o, true);
const u32 = (v: DataView, o: number) => v.getUint32(o, true);

interface ZipEntry {
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  offset: number;
}

/**
 * The ZIP central directory: name → where its bytes are.
 *
 * Read from the directory at the END of the file rather than by walking local headers, because that is
 * the authoritative copy — an entry written as a stream leaves its sizes as zero in the local header
 * and fills them in only here.
 */
function readDirectory(buf: ArrayBuffer): Map<string, ZipEntry> {
  const bytes = new Uint8Array(buf);
  if (bytes.length < 22) throw new XlsxError('notZip');
  // The old binary .xls is an OLE2 compound file, not a ZIP. Worth naming: an office renaming .xls to
  // .xlsx is a real thing, and "that file has no rows" would be a lie about why.
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) throw new XlsxError('oldXls');
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new XlsxError('notZip');

  const view = new DataView(buf);
  // The end-of-central-directory record sits behind a comment of unknown length, so scan back for it.
  let eocd = -1;
  const floor = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= floor; i--) {
    if (u32(view, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError('notZip');

  const count = u16(view, eocd + 10);
  const dirOffset = u32(view, eocd + 16);
  // ZIP64 means >65535 parts or >4 GB, neither of which a student roster is. Refuse rather than
  // misread the truncated 32-bit fields as real offsets.
  if (count === 0xffff || dirOffset === 0xffffffff) throw new XlsxError('zip64');

  const out = new Map<string, ZipEntry>();
  let p = dirOffset;
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || u32(view, p) !== 0x02014b50) throw new XlsxError('notZip');
    const nameLen = u16(view, p + 28);
    const extraLen = u16(view, p + 30);
    const commentLen = u16(view, p + 32);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    out.set(name, {
      method: u16(view, p + 10),
      compressedSize: u32(view, p + 20),
      uncompressedSize: u32(view, p + 24),
      offset: u32(view, p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// `Uint8Array<ArrayBuffer>` rather than a plain Uint8Array: a stream will only take bytes backed by a
// real ArrayBuffer, not a possibly-shared one, and every view here comes from the file's own buffer.
async function inflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  // Present in every browser that can run this app, and in Node 18+ (so the tests exercise the real
  // path). A missing one is worth naming rather than crashing on `undefined`.
  if (typeof DecompressionStream === 'undefined') throw new XlsxError('noInflate');
  // Typed as BufferSource to match what a DecompressionStream accepts on its writable end.
  const src = new ReadableStream<BufferSource>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
  const out = await new Response(src.pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
  return new Uint8Array(out);
}

/** One part of the archive, as text. A part that isn't there is '' — most are optional. */
async function readPart(buf: ArrayBuffer, dir: Map<string, ZipEntry>, name: string): Promise<string> {
  const e = dir.get(name);
  if (!e) return '';
  if (e.uncompressedSize > MAX_PART_BYTES) throw new XlsxError('tooBig');
  const view = new DataView(buf);
  if (u32(view, e.offset) !== 0x04034b50) throw new XlsxError('notZip');
  const start = e.offset + 30 + u16(view, e.offset + 26) + u16(view, e.offset + 28);
  const raw = new Uint8Array(buf).subarray(start, start + e.compressedSize);
  if (e.method === 0) return new TextDecoder().decode(raw);
  if (e.method !== 8) throw new XlsxError('compression');
  return new TextDecoder().decode(await inflateRaw(raw));
}

// ── XML ────────────────────────────────────────────────────────────────────────
/**
 * Every `<tag …>…</tag>` (and `<tag/>`) in document order, as its attributes and its inner text.
 *
 * Assumes a tag never nests inside itself, which holds for every element this reader touches
 * (sheet, si, t, row, c, v, is, xf, numFmt). Attribute values containing a literal `>` would also
 * confuse it — serializers escape those, and the worst case is a number format read as not-a-date,
 * which shows the office the underlying number instead of guessing wrong about a date.
 */
function elements(xml: string, tag: string): { attrs: string; inner: string }[] {
  const out: { attrs: string; inner: string }[] = [];
  const open = new RegExp(`<${tag}(?=[\\s/>])([^>]*)>`, 'g');
  const close = `</${tag}>`;
  let m: RegExpExecArray | null;
  while ((m = open.exec(xml))) {
    const attrs = m[1] ?? '';
    if (attrs.endsWith('/')) {
      out.push({ attrs: attrs.slice(0, -1), inner: '' });
      continue;
    }
    const from = m.index + m[0].length;
    const end = xml.indexOf(close, from);
    if (end < 0) break;
    out.push({ attrs, inner: xml.slice(from, end) });
    open.lastIndex = end + close.length;
  }
  return out;
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  return m ? m[1] : undefined;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (full, code: string) => {
    if (code[0] !== '#') return NAMED[code] ?? full;
    const n = code[1] === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : full;
  });
}

/** The text of an element that may hold `<t>` runs (a shared string, or an inline one). */
const runText = (inner: string): string =>
  elements(inner, 't')
    .map((t) => decodeXml(t.inner))
    .join('');

// ── Styles: which cells are dates ──────────────────────────────────────────────
/** Excel's reserved date/time number formats. Anything else numbered is a custom format, read below. */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/**
 * The style indexes that mean "this number is a date".
 *
 * A date in a spreadsheet is not a date, it is a number wearing a format — 2006-05-07 is stored as
 * 38844. The format is therefore the ONLY thing that distinguishes a birthday from a fee amount, so
 * the styles have to be read to get a DOB column out of a workbook at all.
 */
function dateStyles(xml: string): Set<number> {
  const custom = new Map<number, string>();
  for (const f of elements(xml, 'numFmt')) {
    const id = Number(attr(f.attrs, 'numFmtId'));
    if (Number.isInteger(id)) custom.set(id, decodeXml(attr(f.attrs, 'formatCode') ?? ''));
  }
  const isDate = (id: number): boolean => {
    const code = custom.get(id);
    if (code === undefined) return BUILTIN_DATE_FORMATS.has(id);
    // Quoted literals, escaped characters and [red]/[$-409] sections come out first, so `0.00" days"`
    // is not read as a date because of the d in "days".
    const bare = code.replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '').replace(/\\./g, '');
    return /[ymdhs]/i.test(bare);
  };
  const out = new Set<number>();
  // Only cellXfs — cellStyleXfs holds the same <xf> elements for named styles, and a cell's `s` is an
  // index into cellXfs alone.
  const block = elements(xml, 'cellXfs')[0];
  if (!block) return out;
  elements(block.inner, 'xf').forEach((xf, i) => {
    const id = Number(attr(xf.attrs, 'numFmtId') ?? '0');
    if (Number.isInteger(id) && isDate(id)) out.add(i);
  });
  return out;
}

/**
 * An Excel date serial as an ISO date.
 *
 * Counting from 1899-12-30 rather than 1900-01-01 is what absorbs Excel's deliberate 1900 leap-year
 * bug (it believes in a 29 February 1900), so every real date from 1900-03-01 onwards — which is every
 * date of birth an office will ever type — comes out right.
 *
 * Any time component is dropped: what this reads dates for is a birthday column.
 */
function serialToIso(serial: number, date1904: boolean): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return new Date(epoch + Math.floor(serial) * 86_400_000).toISOString().slice(0, 10);
}

// ── Cells ──────────────────────────────────────────────────────────────────────
/** "BC12" → 54. The letters are the column; the digits are the row and are not our business here. */
function columnIndex(ref: string): number {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
    else if (c >= 97 && c <= 122) n = n * 26 + (c - 96);
    else break;
  }
  return n - 1;
}

interface SheetContext {
  shared: string[];
  dates: Set<number>;
  date1904: boolean;
}

function cellText(cell: { attrs: string; inner: string }, ctx: SheetContext): string {
  const type = attr(cell.attrs, 't') ?? 'n';
  if (type === 'inlineStr') return runText(cell.inner);
  const v = elements(cell.inner, 'v')[0];
  const raw = v ? decodeXml(v.inner).trim() : '';
  if (type === 's') {
    const i = Number(raw);
    return Number.isInteger(i) && i >= 0 && i < ctx.shared.length ? ctx.shared[i] : '';
  }
  if (type === 'str') return raw; // a formula's cached text result
  if (type === 'd') return raw.slice(0, 10); // ISO-dated cell (some writers use these)
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
  if (type === 'e') return ''; // #REF!, #N/A — nothing an import can use
  if (raw === '') return '';
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  const style = Number(attr(cell.attrs, 's') ?? '0');
  if (n > 0 && Number.isInteger(style) && ctx.dates.has(style)) return serialToIso(n, ctx.date1904);
  return String(n);
}

/** One worksheet's cells. Sparse cells are filled from their `r` reference, so a blank column in the
 *  middle of a row cannot shift every field after it. */
function sheetCells(xml: string, ctx: SheetContext): string[][] {
  const body = elements(xml, 'sheetData')[0]?.inner ?? '';
  return elements(body, 'row').map((row) => {
    const cells: string[] = [];
    let next = 0;
    for (const c of elements(row.inner, 'c')) {
      const ref = attr(c.attrs, 'r');
      const at = ref ? columnIndex(ref) : -1;
      const i = at >= 0 ? at : next;
      next = i + 1;
      while (cells.length < i) cells.push('');
      cells[i] = cellText(c, ctx);
    }
    return cells;
  });
}

// ── Workbook ───────────────────────────────────────────────────────────────────
/** The worksheet parts, in the order the tabs appear. Resolved through the relationships, because the
 *  first tab is not reliably sheet1.xml — a workbook whose sheets were reordered proves it. */
function sheetPaths(workbook: string, rels: string, dir: Map<string, ZipEntry>): string[] {
  const target = new Map<string, string>();
  for (const r of elements(rels, 'Relationship')) {
    const id = attr(r.attrs, 'Id');
    const to = attr(r.attrs, 'Target');
    if (id && to) target.set(id, decodeXml(to));
  }
  const paths: string[] = [];
  for (const s of elements(workbook, 'sheet')) {
    const id = attr(s.attrs, 'r:id') ?? attr(s.attrs, 'id');
    const to = id ? target.get(id) : undefined;
    if (!to) continue;
    const path = to.startsWith('/') ? to.slice(1) : `xl/${to.replace(/^\.\//, '')}`;
    if (dir.has(path)) paths.push(path);
  }
  // A workbook we could not follow still has its sheets on disk under a predictable prefix.
  if (paths.length === 0) {
    for (const name of dir.keys()) if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) paths.push(name);
    paths.sort((a, b) => (Number(a.match(/\d+/)![0]) || 0) - (Number(b.match(/\d+/)![0]) || 0));
  }
  return paths;
}

/**
 * A .xlsx → the same header row + data rows `parseCsv` produces, so the import dialog treats both the
 * same way from here on.
 *
 * The FIRST SHEET WITH ROWS wins, not simply the first sheet: a stray empty tab in front of the data
 * is common, and "that file has no rows" would be a confusing thing to tell someone looking at a
 * workbook that plainly has some.
 */
export async function parseXlsx(data: ArrayBuffer): Promise<Grid> {
  const dir = readDirectory(data);
  const workbook = await readPart(data, dir, 'xl/workbook.xml');
  if (!workbook && !dir.has('xl/worksheets/sheet1.xml')) throw new XlsxError('noSheet');

  const ctx: SheetContext = {
    shared: elements(await readPart(data, dir, 'xl/sharedStrings.xml'), 'si').map((si) => runText(si.inner)),
    dates: dateStyles(await readPart(data, dir, 'xl/styles.xml')),
    // The 1904 date system is old-Mac Excel. Rare, but a workbook saved under it is four years out.
    date1904: ['1', 'true'].includes(attr(elements(workbook, 'workbookPr')[0]?.attrs ?? '', 'date1904') ?? ''),
  };

  const paths = sheetPaths(workbook, await readPart(data, dir, 'xl/_rels/workbook.xml.rels'), dir);
  if (paths.length === 0) throw new XlsxError('noSheet');
  for (const path of paths) {
    const grid = shapeGrid(sheetCells(await readPart(data, dir, path), ctx));
    if (grid.headers.length > 0 && grid.rows.length > 0) return grid;
  }
  return { headers: [], rows: [] };
}

/**
 * Read whatever the office picked — a workbook or a CSV — by looking at the BYTES, not the extension.
 *
 * A file's name is the least reliable thing about it: offices rename .xls to .xlsx, and "export CSV"
 * buttons produce files called .xlsx. Sniffing means either mistake still imports instead of
 * producing a grid of nonsense, which matters more here than usual because the dialog maps columns by
 * position.
 */
export async function parseSpreadsheet(file: File): Promise<Grid> {
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 4));
  if (head[0] === 0x50 && head[1] === 0x4b) return parseXlsx(buf);
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) throw new XlsxError('oldXls');
  return parseCsv(new TextDecoder().decode(buf));
}
