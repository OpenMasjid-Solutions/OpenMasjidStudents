// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The printable-document → PDF converter (sheetPdf.ts).
 *
 * It exists because iOS Safari stamps its own header and footer onto anything it prints and cannot be told
 * not to; a statement reaching a parent with Safari's furniture on it is not acceptable, and a PDF we build
 * has no stamp.
 *
 * What is worth testing here is the part that could silently produce a WRONG document:
 *  - `safeText` must REFUSE text the built-in fonts cannot encode rather than writing `????` across a
 *    family's name. The caller falls back to printing, which shapes every script properly.
 *  - line wrapping must not lose words, because a wrapped fee note that drops its tail is a document that
 *    reads as if the office wrote something else.
 * `parseSheet` needs a DOM and is exercised by the browser; the pure helpers are what run here.
 */
import { describe, it, expect } from 'vitest';
import { safeText, SheetPdfError } from './sheetPdf';

describe('safeText', () => {
  it('passes the Latin text a madrasa roster actually holds', () => {
    for (const name of ['Abdul Wahid Raufi', 'Yusuf Ismail', "O'Brien", 'Zoë Müller', 'Hafiza Bíbí']) {
      expect(safeText(name)).toBe(name);
    }
  });

  it('substitutes the typographic characters our own documents use', () => {
    // Written by our builders, and all of them WinAnsi-encodable or mapped.
    expect(safeText('Tuition — July 2026')).toBe('Tuition — July 2026');
    expect(safeText('don’t')).toBe("don't");
    expect(safeText('a · b')).toBe('a · b');
    expect(safeText('½')).toBe('½');
    expect(safeText('go →')).toBe('go ->');
    expect(safeText('a…b')).toBe('a...b');
  });

  /**
   * The important one. A name in Arabic script CANNOT be drawn by a built-in PDF font, and no JS PDF
   * library does Arabic shaping or bidi anyway — so the honest answer is to refuse the whole document and
   * let the caller print instead, not to emit a row of question marks where a child's name should be.
   */
  it('refuses text it cannot draw, rather than mangling it', () => {
    for (const bad of ['يوسف', '优素福', 'Ｙusuf']) {
      expect(() => safeText(bad)).toThrow(SheetPdfError);
    }
    // …and the code says which failure it is, so the caller can fall back rather than guess.
    try {
      safeText('يوسف');
    } catch (e) {
      expect((e as SheetPdfError).code).toBe('unsupported_text');
    }
  });

  it('keeps the newlines the layout depends on', () => {
    expect(safeText('one\ntwo')).toBe('one\ntwo');
  });
});
