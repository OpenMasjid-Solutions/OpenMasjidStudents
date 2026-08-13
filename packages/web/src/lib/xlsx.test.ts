// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The hand-rolled .xlsx reader (xlsx.ts).
 *
 * The fixtures are REAL workbooks, assembled here byte by byte — a ZIP with correct headers and CRCs,
 * holding the XML parts Excel writes. That is the point: a mocked reader would prove nothing about a
 * format whose whole difficulty is that dates are numbers, strings live in a separate table, and the
 * bytes are compressed. Both storage methods a ZIP can use are covered, since which one a workbook
 * uses is not ours to choose.
 *
 * The awkward real-world cases pinned here are the ones that would silently corrupt a roster: a
 * date-formatted cell (a birthday is stored as 38844), a sparse row (a blank middle column must not
 * shift every field after it), and a blank first tab.
 */
import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { parseXlsx, XlsxError } from './xlsx';

// ── A minimal ZIP writer, so the fixtures are files Excel itself would accept ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** `parts` → a ZIP archive. `deflate` picks the storage method, which the reader must handle either way. */
function zip(parts: Record<string, string>, opts: { deflate?: boolean } = {}): ArrayBuffer {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const [name, text] of Object.entries(parts)) {
    const raw = enc.encode(text);
    const body = opts.deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
    const method = opts.deflate ? 8 : 0;
    const nameBytes = enc.encode(name);
    const crc = crc32(raw);

    const local = new Uint8Array(30 + nameBytes.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(body, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const dirSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, dirSize, true);
  ev.setUint32(16, offset, true);

  const all = [...locals, ...centrals, eocd];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out.buffer;
}

// ── Workbook parts ─────────────────────────────────────────────────────────────
const RELS = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="…/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="…/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`;

const workbook = (sheets: string[]) =>
  `<?xml version="1.0"?><workbook><sheets>${sheets.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;

/** Style 0 is General; style 1 is a date format, which is the only way a cell says "birthday". */
const STYLES = `<?xml version="1.0"?><styleSheet><numFmts count="1"><numFmt numFmtId="165" formatCode="0.00&quot; days&quot;"/></numFmts><cellStyleXfs count="1"><xf numFmtId="14"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="165"/></cellXfs></styleSheet>`;

const strings = (values: string[]) => `<?xml version="1.0"?><sst count="${values.length}">${values.map((v) => `<si><t>${v}</t></si>`).join('')}</sst>`;

const sheet = (rows: string) => `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`;

/** The shape a QuickSchools export has: a header row, a student, and two guardian-only rows under them. */
const ROSTER_STRINGS = [
  'Student Name',
  'Homeroom',
  'Birthday',
  'Parent / Guardian',
  'Relationship',
  'Cell Phone',
  'Abrar Aadi',
  'Oola (1st Year)',
  'Shyd Chowdhury',
  'Relative',
  '(718) 427-5235',
  'Farhana Sharmin',
  'Mother',
  '(718) 427-0178',
];
const s = (i: number) => `<c r="${'ABCDEF'[i % 6]}${Math.floor(i / 6) + 1}" t="s"><v>`;

const ROSTER = zip({
  'xl/workbook.xml': workbook(['Roster']),
  'xl/_rels/workbook.xml.rels': RELS,
  'xl/sharedStrings.xml': strings(ROSTER_STRINGS),
  'xl/styles.xml': STYLES,
  'xl/worksheets/sheet1.xml': sheet(
    `<row r="1">${[0, 1, 2, 3, 4, 5].map((i) => `${s(i)}${i}</v></c>`).join('')}</row>` +
      // 38817 is 2006-04-10 as an Excel serial, wearing the date style (index 1).
      `<row r="2"><c r="A2" t="s"><v>6</v></c><c r="B2" t="s"><v>7</v></c><c r="C2" s="1"><v>38817</v></c><c r="D2" t="s"><v>8</v></c><c r="E2" t="s"><v>9</v></c><c r="F2" t="s"><v>10</v></c></row>` +
      // Guardian-only rows: no name, no homeroom, no birthday. The blank middle columns are simply
      // absent from the XML, which is what makes the `r` reference load-bearing.
      `<row r="3"><c r="D3" t="s"><v>11</v></c><c r="E3" t="s"><v>12</v></c><c r="F3" t="s"><v>13</v></c></row>`,
  ),
  'xl/worksheets/sheet2.xml': sheet(''),
});

describe('parseXlsx', () => {
  it('reads a workbook the way parseCsv reads a file: header row, then data rows', async () => {
    const g = await parseXlsx(ROSTER);
    expect(g.headers).toEqual(['Student Name', 'Homeroom', 'Birthday', 'Parent / Guardian', 'Relationship', 'Cell Phone']);
    expect(g.rows).toHaveLength(2);
    expect(g.rows[0]).toEqual(['Abrar Aadi', 'Oola (1st Year)', '2006-04-10', 'Shyd Chowdhury', 'Relative', '(718) 427-5235']);
  });

  /** The one that would corrupt a roster silently: guardian columns must stay in their own columns. */
  it('keeps a sparse row in its columns instead of shifting the cells left', async () => {
    const g = await parseXlsx(ROSTER);
    expect(g.rows[1]).toEqual(['', '', '', 'Farhana Sharmin', 'Mother', '(718) 427-0178']);
  });

  it('reads a date-formatted cell as an ISO date, not the serial number underneath it', async () => {
    // A birthday is stored as a count of days; only the cell's style says it is a date at all.
    const g = await parseXlsx(ROSTER);
    expect(g.rows[0][2]).toBe('2006-04-10');
  });

  it('handles both ZIP storage methods, because a workbook picks its own', async () => {
    const parts = {
      'xl/workbook.xml': workbook(['Roster']),
      'xl/_rels/workbook.xml.rels': RELS,
      'xl/sharedStrings.xml': strings(['Name', 'Yusuf Ismail']),
      'xl/worksheets/sheet1.xml': sheet('<row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c></row>'),
    };
    for (const deflate of [false, true]) {
      const g = await parseXlsx(zip(parts, { deflate }));
      expect(g.rows).toEqual([['Yusuf Ismail']]);
    }
  });

  it('skips a blank first tab rather than reporting an empty file', async () => {
    const g = await parseXlsx(
      zip({
        'xl/workbook.xml': workbook(['Notes', 'Roster']),
        'xl/_rels/workbook.xml.rels': RELS,
        'xl/sharedStrings.xml': strings(['Name', 'Sara Ismail']),
        'xl/worksheets/sheet1.xml': sheet(''),
        'xl/worksheets/sheet2.xml': sheet('<row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c></row>'),
      }),
    );
    expect(g.rows).toEqual([['Sara Ismail']]);
  });

  it('reads the cell kinds a real export mixes: inline strings, numbers, formulas and booleans', async () => {
    const g = await parseXlsx(
      zip({
        'xl/workbook.xml': workbook(['Roster']),
        'xl/_rels/workbook.xml.rels': RELS,
        'xl/styles.xml': STYLES,
        'xl/worksheets/sheet1.xml': sheet(
          '<row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>Amount</t></is></c><c r="C1" t="inlineStr"><is><t>Paid</t></is></c><c r="D1" t="inlineStr"><is><t>Days</t></is></c></row>' +
            // A formula keeps its cached result; a number-formatted-as-a-number stays a number; and
            // style 2 has a d in "days" inside quotes, which must NOT make it a date.
            '<row r="2"><c r="A2" t="str"><f>B1</f><v>Yusuf &amp; Sara</v></c><c r="B2"><v>350</v></c><c r="C2" t="b"><v>1</v></c><c r="D2" s="2"><v>38817</v></c></row>',
        ),
      }),
    );
    expect(g.rows[0]).toEqual(['Yusuf & Sara', '350', 'TRUE', '38817']);
  });

  it('joins the runs of a rich-text string instead of keeping only the first', async () => {
    const g = await parseXlsx(
      zip({
        'xl/workbook.xml': workbook(['Roster']),
        'xl/_rels/workbook.xml.rels': RELS,
        'xl/sharedStrings.xml': `<?xml version="1.0"?><sst><si><t>Name</t></si><si><r><t>Abdul </t></r><r><t xml:space="preserve">Wahid</t></r></si></sst>`,
        'xl/worksheets/sheet1.xml': sheet('<row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c></row>'),
      }),
    );
    expect(g.rows).toEqual([['Abdul Wahid']]);
  });

  it('follows the relationships rather than assuming the first tab is sheet1.xml', async () => {
    // Tab order reversed: the first tab points at sheet2.xml, which is where the roster is.
    const g = await parseXlsx(
      zip({
        'xl/workbook.xml': `<?xml version="1.0"?><workbook><sheets><sheet name="Roster" sheetId="1" r:id="rId2"/><sheet name="Old" sheetId="2" r:id="rId1"/></sheets></workbook>`,
        'xl/_rels/workbook.xml.rels': RELS,
        'xl/sharedStrings.xml': strings(['Name', 'Left behind', 'Bilal Farooqi']),
        'xl/worksheets/sheet1.xml': sheet('<row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c></row>'),
        'xl/worksheets/sheet2.xml': sheet('<row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c></row>'),
      }),
    );
    expect(g.rows).toEqual([['Bilal Farooqi']]);
  });

  it('reads the 1904 date system four years later, not four years wrong', async () => {
    const g = await parseXlsx(
      zip({
        'xl/workbook.xml': `<?xml version="1.0"?><workbook><workbookPr date1904="1"/><sheets><sheet name="R" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        'xl/_rels/workbook.xml.rels': RELS,
        'xl/styles.xml': STYLES,
        'xl/sharedStrings.xml': strings(['Birthday']),
        'xl/worksheets/sheet1.xml': sheet('<row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" s="1"><v>37355</v></c></row>'),
      }),
    );
    expect(g.rows).toEqual([['2006-04-10']]);
  });
});

describe('files we cannot read say so', () => {
  it('names the old binary .xls instead of reporting an empty file', async () => {
    const ole2 = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array(40).fill(0)]);
    await expect(parseXlsx(ole2.buffer)).rejects.toMatchObject({ code: 'oldXls' });
  });

  it('rejects something that is not an archive at all', async () => {
    await expect(parseXlsx(new TextEncoder().encode('Name,Class\nYusuf,Hifz 1\n').buffer as ArrayBuffer)).rejects.toBeInstanceOf(XlsxError);
  });

  it('rejects an archive with no worksheet in it', async () => {
    await expect(parseXlsx(zip({ 'docProps/app.xml': '<Properties/>' }))).rejects.toMatchObject({ code: 'noSheet' });
  });
});
