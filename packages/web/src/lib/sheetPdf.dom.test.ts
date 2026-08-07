// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The full document → PDF pipeline (sheetPdf.ts), against the markup our own builders emit.
 *
 * `parseSheet` needs a DOM, hence the environment line above — happy-dom is a devDependency and is not
 * shipped. Without it the riskiest half of this feature would go out untested, and what it produces is a
 * document a family keeps.
 *
 * The FIXTURE mirrors a real printable: the same header/h1/.sub/.printed, the same section > h2 > table
 * shape, an .idcard, a .note callout and a footer. Screen-only chrome (.toolbar, .phone-tip) is in it on
 * purpose — a Print button rendered into a shared PDF would be the obvious tell that this is a screenshot
 * of a web page rather than a document.
 */
import { describe, it, expect } from 'vitest';
import { parseSheet, sheetToPdf } from './sheetPdf';

const SHEET = `<!doctype html><html><head><style>:root { --teal:#0f766e; }</style></head><body>
<div class="sheet">
  <div class="toolbar"><button class="btn" onclick="window.print()">Print</button></div>
  <p class="phone-tip">On a phone, Print opens your phone&rsquo;s own print preview.</p>
  <header>
    <div class="brand">
      <div>
        <h1>An-Noor Weekend School</h1>
        <div class="sub">Student IDs</div>
      </div>
      <span class="printed muted">Printed 7 Aug 2026<br />21 students</span>
    </div>
  </header>
  <p class="intro">Every child&rsquo;s Student ID, by class.</p>
  <section>
    <h2>Maktab &mdash; Oola <span class="count">2</span></h2>
    <table>
      <thead><tr><th>Name</th><th class="idcol">Student ID</th><th class="num">Owes</th></tr></thead>
      <tbody>
        <tr><td>Abrar Aadi</td><td class="idcol"><span class="code">ABR7289</span></td><td class="num">$350.00</td></tr>
        <tr><td>Abyad Mahmood</td><td class="idcol"><span class="code">ABY0010</span></td><td class="num">$0.00</td></tr>
      </tbody>
    </table>
  </section>
  <section>
    <h2>Student ID</h2>
    <div class="idrow"><div class="idcard"><div class="lbl">Yusuf</div><div class="code">YUS1234</div></div></div>
    <p class="idcopy">This is how a payment finds your child.</p>
  </section>
  <div class="note"><b>Office copy.</b> A Student ID is all somebody needs to look up what a child owes.</div>
  <footer>
    <div>An-Noor Weekend School &middot; Correct as of 7 Aug 2026</div>
    <div>801 Main Street &middot; (555) 123-4567</div>
  </footer>
</div>
</body></html>`;

describe('parseSheet', () => {
  const blocks = parseSheet(SHEET);

  it('reads the document in order, as blocks', () => {
    expect(blocks.map((b) => b.kind)).toEqual(['title', 'para', 'heading', 'table', 'heading', 'card', 'para', 'boxed', 'footer']);
  });

  it('takes the letterhead out of the header, logo aside', () => {
    const title = blocks[0] as Extract<(typeof blocks)[number], { kind: 'title' }>;
    expect(title.text).toBe('An-Noor Weekend School');
    expect(title.sub).toBe('Student IDs');
    expect(title.aside).toContain('Printed 7 Aug 2026');
  });

  /** The tell that this is a document and not a screenshot of a web page. */
  it('leaves the screen-only chrome out', () => {
    const all = JSON.stringify(blocks);
    expect(all).not.toContain('window.print');
    expect(all).not.toContain('On a phone');
    // The Print button's own label must not survive either.
    expect(blocks.some((b) => b.kind === 'para' && b.text === 'Print')).toBe(false);
  });

  it('keeps a table whole, with its right-aligned money columns marked', () => {
    const table = blocks.find((b) => b.kind === 'table') as Extract<(typeof blocks)[number], { kind: 'table' }>;
    expect(table.head).toEqual(['Name', 'Student ID', 'Owes']);
    expect(table.rows).toEqual([
      ['Abrar Aadi', 'ABR7289', '$350.00'],
      ['Abyad Mahmood', 'ABY0010', '$0.00'],
    ]);
    // `.num` is how our builders mark a money column; the PDF right-aligns those.
    expect(table.numeric).toEqual([false, false, true]);
  });

  it('reads a Student ID card as a card, not as loose text', () => {
    const card = blocks.find((b) => b.kind === 'card') as Extract<(typeof blocks)[number], { kind: 'card' }>;
    expect(card).toMatchObject({ label: 'Yusuf', value: 'YUS1234' });
  });

  it('keeps the footer’s lines separate', () => {
    const footer = blocks.at(-1) as Extract<(typeof blocks)[number], { kind: 'footer' }>;
    expect(footer.lines).toHaveLength(2);
    expect(footer.lines[1]).toContain('(555) 123-4567');
  });
});

/**
 * The words actually DRAWN onto the page, read back out of the finished PDF.
 *
 * Two things stand between the bytes and a readable assertion, and both were found by trying: pdf-lib
 * flate-compresses its content streams, and it writes text as HEX strings (`<416E2D4E6F6F72> Tj`, which is
 * "An-Noor"). So a plain grep of the file can never match a name, however correct the document is.
 *
 * Doing the work here rather than settling for "it returned some bytes" is the point: this is the only
 * assertion in the suite that proves a family's name reached the page.
 */
async function drawnText(bytes: Uint8Array): Promise<string> {
  const streams = await inflatedText(bytes);
  let out = '';
  for (const m of streams.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
    const hex = m[1];
    let s = '';
    for (let i = 0; i + 1 < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    out += `${s}\n`;
  }
  return out;
}

/** Every flate stream in the PDF, inflated and concatenated. */
async function inflatedText(bytes: Uint8Array): Promise<string> {
  const latin = new TextDecoder('latin1').decode(bytes);
  let out = '';
  let at = 0;
  for (;;) {
    const flate = latin.indexOf('/FlateDecode', at);
    if (flate < 0) break;
    const open = latin.indexOf('stream', flate);
    const close = latin.indexOf('endstream', open);
    if (open < 0 || close < 0) break;
    // `stream` is followed by an end-of-line before the data. The trailing boundary is not worth guessing
    // exactly — a byte either way breaks the deflate stream — so try the plausible ones and keep whichever
    // inflates. (My first attempt assumed one and silently inflated nothing.)
    const from = open + 'stream'.length + 1;
    for (const end of [close, close - 1, close - 2]) {
      try {
        const src = new ReadableStream<BufferSource>({
          start(c) {
            c.enqueue(bytes.slice(from, end));
            c.close();
          },
        });
        out += new TextDecoder('latin1').decode(await new Response(src.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
        break;
      } catch {
        // Not every flate stream is text (the cross-reference table is one); try the next boundary.
      }
    }
    at = close + 1;
  }
  return out;
}

describe('sheetToPdf', () => {
  it('produces a real PDF with the document’s own text drawn into it', async () => {
    const bytes = await sheetToPdf(SHEET, 'Student IDs — An-Noor');
    // The file signature, so this is a PDF rather than something that merely did not throw.
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(1000);

    const drawn = await drawnText(bytes);
    expect(drawn).toContain('ABR7289');
    expect(drawn).toContain('An-Noor Weekend School');
    expect(drawn).toContain('Abrar Aadi');
    expect(drawn).toContain('YUS1234');
    // The money column, right-aligned but present.
    expect(drawn).toContain('$350.00');
    // And none of the screen's own furniture.
    expect(drawn).not.toContain('window.print');
    expect(drawn).not.toContain('On a phone');
  });

  it('refuses a document holding text the built-in fonts cannot draw', async () => {
    // A name in Arabic script. The caller falls back to the print dialog, which shapes it correctly.
    await expect(sheetToPdf(SHEET.replace('Abrar Aadi', 'يوسف'), 'x')).rejects.toMatchObject({ code: 'unsupported_text' });
  });

  it('refuses an empty document rather than sharing a blank page', async () => {
    await expect(sheetToPdf('<html><body></body></html>', 'x')).rejects.toMatchObject({ code: 'empty' });
  });
});
