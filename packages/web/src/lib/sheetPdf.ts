// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Turning one of this app's printable documents into a PDF, in the browser (0.48.0).
 *
 * WHY THIS EXISTS, precisely. On a phone the office wants to send a statement to a parent, and the way to
 * do that is the OS share sheet. `window.print()` gets close — both iOS and Android can save a print to
 * PDF — but **iOS Safari stamps its own header and footer onto anything it prints** (the date, the page
 * title, the URL) and there is no way to turn that off. A masjid's statement should not go out with
 * Safari's furniture on it. A PDF we build ourselves has no such stamp.
 *
 * It reads the document we already serve rather than re-describing it: `parseSheet` walks the HTML our own
 * builders emit (billing/statements.ts and friends) and turns it into blocks, and `layout` draws them. That
 * keeps ONE source for what a statement says — a second layout would drift from the printed one, which was
 * the main objection to doing this at all.
 *
 * DELIBERATELY LATIN-ONLY. pdf-lib's built-in fonts are WinAnsi, so anything outside Latin-1 cannot be
 * encoded; embedding a Unicode font would need fontkit plus a ~400KB face, and no JS PDF library does
 * Arabic shaping or bidi anyway, so an Arabic-script name would come out as disconnected letters in the
 * wrong order — worse than not offering it. Madrasa rosters here are transliterated ("Abdul Wahid Raufi"),
 * which WinAnsi covers. `safeText` is the guard: it substitutes the typographic characters our documents
 * actually use and, for anything else, reports that this document cannot be rendered — the caller then
 * falls back to printing, which shapes every script correctly.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';

/** Letter, in points, with the same half-inch margin the documents' own `@page` rule uses. */
const PAGE = { width: 612, height: 792, margin: 36 };

export class SheetPdfError extends Error {
  constructor(readonly code: 'unsupported_text' | 'empty') {
    super(code);
    this.name = 'SheetPdfError';
  }
}

// ── Text ───────────────────────────────────────────────────────────────────────
/** The characters our documents use that WinAnsi does not have, and what to write instead. */
const SUBS: Record<string, string> = {
  '—': '—', // em dash — WinAnsi HAS this; listed so the intent is explicit
  '→': '->',
  '✓': 'Y', // ✓ a paid tick
  '●': '*', // ● still owed
  '○': 'o', // ○ carried forward
  '½': '½', // ½ — also in WinAnsi
  '…': '...',
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '•': '-',
  ' ': ' ',
};

/**
 * `text` as something a WinAnsi font can draw, or a throw if it genuinely cannot be.
 *
 * Refusing beats mangling: a name rendered as `????` on a document a family keeps is worse than the
 * caller quietly falling back to the print dialog, which handles every script properly.
 */
export function safeText(text: string): string {
  let out = '';
  for (const ch of text) {
    const sub = SUBS[ch];
    if (sub !== undefined) {
      out += sub;
      continue;
    }
    const code = ch.codePointAt(0)!;
    // Latin-1 printable ranges, plus tab/newline which the layout handles itself.
    if (code === 9 || code === 10 || (code >= 32 && code <= 126) || (code >= 160 && code <= 255)) {
      out += ch;
      continue;
    }
    throw new SheetPdfError('unsupported_text');
  }
  return out;
}

/** Split `text` into lines that fit `width` at `size`. Breaks on spaces; a single over-long word is cut. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= width || !line) {
        line = candidate;
        continue;
      }
      lines.push(line);
      line = word;
    }
    lines.push(line);
  }
  return lines.length ? lines : [''];
}

// ── The document, as blocks ────────────────────────────────────────────────────
export type Block =
  | { kind: 'title'; text: string; sub?: string; aside?: string; logo?: string }
  | { kind: 'heading'; text: string }
  | { kind: 'para'; text: string; muted?: boolean }
  | { kind: 'boxed'; text: string }
  | { kind: 'card'; label: string; value: string }
  | { kind: 'table'; head: string[]; rows: string[][]; numeric: boolean[] }
  | { kind: 'footer'; lines: string[] };

const clean = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Our own printable HTML → blocks.
 *
 * Scoped to the markup THIS app emits — it is not a general HTML renderer, and does not pretend to be.
 * Anything it does not recognise is skipped rather than guessed at, so a new element appears as a gap
 * rather than as garbage; the four documents are covered by tests that assert their real output.
 */
export function parseSheet(html: string): Block[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const sheet = doc.querySelector('.sheet') ?? doc.body;
  const blocks: Block[] = [];

  const header = sheet.querySelector('header');
  if (header) {
    blocks.push({
      kind: 'title',
      text: clean(header.querySelector('h1')?.textContent),
      sub: clean(header.querySelector('.sub')?.textContent) || undefined,
      aside: clean(header.querySelector('.printed')?.textContent) || undefined,
      logo: header.querySelector('img.logo')?.getAttribute('src') ?? undefined,
    });
  }

  const walk = (root: Element) => {
    for (const el of Array.from(root.children)) {
      const tag = el.tagName.toLowerCase();
      const cls = el.classList;
      // Screen-only chrome, and the header we have already taken.
      if (tag === 'header' || tag === 'style' || tag === 'script' || cls.contains('toolbar') || cls.contains('phone-tip')) continue;

      if (tag === 'footer') {
        blocks.push({ kind: 'footer', lines: Array.from(el.children).map((c) => clean(c.textContent)).filter(Boolean) });
        continue;
      }
      if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
        blocks.push({ kind: 'heading', text: clean(el.textContent) });
        continue;
      }
      if (tag === 'table') {
        const head = Array.from(el.querySelectorAll('thead th')).map((th) => clean(th.textContent));
        const numeric = Array.from(el.querySelectorAll('thead th')).map((th) => th.classList.contains('num'));
        const rows = Array.from(el.querySelectorAll('tbody tr')).map((tr) => Array.from(tr.children).map((td) => clean(td.textContent)));
        if (rows.length || head.length) blocks.push({ kind: 'table', head, rows, numeric });
        continue;
      }
      if (cls.contains('idcard')) {
        blocks.push({ kind: 'card', label: clean(el.querySelector('.lbl')?.textContent), value: clean(el.querySelector('.code')?.textContent) });
        continue;
      }
      // The tinted callouts — a balance, the please-check notice, the office-copy warning.
      if (cls.contains('balance') || cls.contains('check') || cls.contains('note')) {
        blocks.push({ kind: 'boxed', text: clean(el.textContent) });
        continue;
      }
      if (tag === 'p') {
        const text = clean(el.textContent);
        if (text) blocks.push({ kind: 'para', text, muted: cls.contains('muted') || cls.contains('hint') || cls.contains('idcopy') });
        continue;
      }
      if (tag === 'ul' || tag === 'ol') {
        for (const li of Array.from(el.children)) {
          const text = clean(li.textContent);
          if (text) blocks.push({ kind: 'para', text: `• ${text}` });
        }
        continue;
      }
      // A wrapper (section, div.idrow, div.signup…): keep walking rather than flattening its text, so the
      // structure inside it is still recognised.
      if (el.children.length) walk(el);
      else {
        const text = clean(el.textContent);
        if (text) blocks.push({ kind: 'para', text });
      }
    }
  };
  walk(sheet);
  return blocks;
}

// ── Drawing ────────────────────────────────────────────────────────────────────
interface Ink {
  body: RGB;
  muted: RGB;
  rule: RGB;
  accent: RGB;
}

/** The masjid's accent colour, read off the document itself so the PDF is ruled like the printed page. */
function inkFrom(html: string): Ink {
  const m = /--teal:\s*(#[0-9a-fA-F]{3,6})/.exec(html);
  const hex = m?.[1] ?? '#0f766e';
  const full = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
  const n = parseInt(full.slice(1), 16);
  return {
    body: rgb(0.1, 0.1, 0.1),
    muted: rgb(0.4, 0.4, 0.4),
    rule: rgb(0.8, 0.8, 0.8),
    accent: rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255),
  };
}

/** Lay the blocks onto pages. One column, top to bottom — these are documents, not layouts. */
async function layout(pdf: PDFDocument, blocks: Block[], ink: Ink, logoData?: string): Promise<void> {
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const inner = PAGE.width - PAGE.margin * 2;

  let page: PDFPage = pdf.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - PAGE.margin;

  /** Room for `need` points, or a new page. */
  const room = (need: number) => {
    if (y - need >= PAGE.margin) return;
    page = pdf.addPage([PAGE.width, PAGE.height]);
    y = PAGE.height - PAGE.margin;
  };
  const text = (s: string, opts: { size?: number; font?: PDFFont; color?: RGB; x?: number; width?: number; gap?: number }) => {
    const size = opts.size ?? 10;
    const f = opts.font ?? font;
    const lines = wrap(safeText(s), f, size, opts.width ?? inner);
    for (const line of lines) {
      room(size * 1.35);
      page.drawText(line, { x: opts.x ?? PAGE.margin, y: y - size, size, font: f, color: opts.color ?? ink.body });
      y -= size * 1.35;
    }
    y -= opts.gap ?? 0;
  };

  for (const b of blocks) {
    switch (b.kind) {
      case 'title': {
        if (logoData) {
          try {
            const img = logoData.includes('image/png') ? await pdf.embedPng(logoData) : await pdf.embedJpg(logoData);
            const h = 34;
            const w = (img.width / img.height) * h;
            room(h + 6);
            page.drawImage(img, { x: PAGE.margin, y: y - h, width: w, height: h });
            y -= h + 6;
          } catch {
            // A logo that will not embed is not worth failing a statement over.
          }
        }
        text(b.text, { size: 17, font: bold, color: ink.accent });
        if (b.sub) text(b.sub, { size: 10, color: ink.muted });
        if (b.aside) text(b.aside, { size: 9, color: ink.muted });
        room(10);
        page.drawLine({ start: { x: PAGE.margin, y: y - 4 }, end: { x: PAGE.width - PAGE.margin, y: y - 4 }, thickness: 1.5, color: ink.accent });
        y -= 14;
        break;
      }
      case 'heading':
        y -= 6;
        text(b.text.toUpperCase(), { size: 8.5, font: bold, color: ink.muted, gap: 2 });
        break;
      case 'para':
        text(b.text, { size: 9.5, color: b.muted ? ink.muted : ink.body, gap: 4 });
        break;
      case 'boxed': {
        y -= 4;
        const size = 9;
        const lines = wrap(safeText(b.text), font, size, inner - 16);
        const h = lines.length * size * 1.35 + 12;
        room(h + 6);
        page.drawRectangle({ x: PAGE.margin, y: y - h, width: inner, height: h, borderColor: ink.accent, borderWidth: 1 });
        let ty = y - 8;
        for (const line of lines) {
          page.drawText(line, { x: PAGE.margin + 8, y: ty - size, size, font, color: ink.body });
          ty -= size * 1.35;
        }
        y -= h + 8;
        break;
      }
      case 'card': {
        room(34);
        page.drawRectangle({ x: PAGE.margin, y: y - 30, width: inner, height: 30, borderColor: ink.accent, borderWidth: 1 });
        page.drawText(safeText(b.label), { x: PAGE.margin + 8, y: y - 12, size: 8, font, color: ink.muted });
        page.drawText(safeText(b.value), { x: PAGE.margin + 8, y: y - 25, size: 13, font: bold, color: ink.body });
        y -= 36;
        break;
      }
      case 'table': {
        const cols = Math.max(b.head.length, ...b.rows.map((r) => r.length), 1);
        const w = inner / cols;
        const size = 8.5;
        if (b.head.length) {
          room(size * 1.6);
          b.head.forEach((h, i) => {
            page.drawText(safeText(h).toUpperCase().slice(0, 40), { x: PAGE.margin + i * w + 2, y: y - size, size: 7.5, font: bold, color: ink.muted });
          });
          y -= size * 1.6;
        }
        for (const row of b.rows) {
          // Every cell wrapped, and the row as tall as its tallest cell — a long fee note must not print
          // over the row beneath it.
          const cells = row.map((c, i) => wrap(safeText(c), font, size, w - 4 - (b.numeric[i] ? 0 : 0)));
          const h = Math.max(...cells.map((c) => c.length)) * size * 1.3 + 3;
          room(h);
          cells.forEach((lines, i) => {
            lines.forEach((line, n) => {
              const tw = font.widthOfTextAtSize(line, size);
              const x = b.numeric[i] ? PAGE.margin + (i + 1) * w - 2 - tw : PAGE.margin + i * w + 2;
              page.drawText(line, { x, y: y - size - n * size * 1.3, size, font, color: ink.body });
            });
          });
          y -= h;
          page.drawLine({ start: { x: PAGE.margin, y: y + 1 }, end: { x: PAGE.width - PAGE.margin, y: y + 1 }, thickness: 0.4, color: ink.rule });
        }
        y -= 8;
        break;
      }
      case 'footer': {
        y -= 10;
        page.drawLine({ start: { x: PAGE.margin, y: y }, end: { x: PAGE.width - PAGE.margin, y }, thickness: 0.5, color: ink.rule });
        y -= 10;
        for (const line of b.lines) text(line, { size: 8, color: ink.muted });
        break;
      }
    }
  }
}

/**
 * One of this app's printable documents → PDF bytes.
 *
 * `title` becomes the PDF's own title, which is what a share sheet and a mail attachment show.
 */
export async function sheetToPdf(html: string, title: string): Promise<Uint8Array> {
  const blocks = parseSheet(html);
  if (!blocks.length) throw new SheetPdfError('empty');
  const pdf = await PDFDocument.create();
  pdf.setTitle(safeText(title));
  pdf.setCreator('OpenMasjid Students');
  const logo = blocks.find((b) => b.kind === 'title') as Extract<Block, { kind: 'title' }> | undefined;
  await layout(pdf, blocks, inkFrom(html), logo?.logo);
  return pdf.save();
}
