// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Grouping the year view into one block PER CLASS (0.48.0).
 *
 * This is what makes the printed page behave: each block renders as its own `<tbody>`, and
 * `break-inside: avoid` on that element is what keeps a class together — so a sheet holds as many WHOLE
 * classes as fit, and a class that does not fit starts a page of its own.
 *
 * Which means a grouping bug is a PRINTING bug, and an invisible one: rows silently merged into the wrong
 * block would page-break in the wrong place, and the only symptom is a class split across two sheets with
 * no heading on the second. Hence the cases below — particularly the two that used to be handled by
 * comparing consecutive rows inline, where a null id and a repeated class name are the traps.
 */
import { describe, it, expect } from 'vitest';
import { classBlocks } from './YearView';

interface Row {
  courseId: string | null;
  courseName: string | null;
  classId: string | null;
  className: string | null;
  name: string;
}
const row = (courseId: string | null, courseName: string | null, classId: string | null, className: string | null, name: string): Row =>
  ({ courseId, courseName, classId, className, name });

/** Two courses: Aalim with two classes, Hifz with one. Sorted as the server sends them. */
const ROSTER: Row[] = [
  row('crs_a', 'Aalim Course', 'cls_1', 'Oola (1st Year)', 'Abrar'),
  row('crs_a', 'Aalim Course', 'cls_1', 'Oola (1st Year)', 'Ahmad'),
  row('crs_a', 'Aalim Course', 'cls_2', 'Thaania (2nd Year)', 'Abidur'),
  row('crs_h', 'Hifz', 'cls_3', 'Hifz 1', 'Bilal'),
];

describe('classBlocks', () => {
  it('makes one block per class, in order', () => {
    const blocks = classBlocks(ROSTER);
    expect(blocks.map((b) => b.className)).toEqual(['Oola (1st Year)', 'Thaania (2nd Year)', 'Hifz 1']);
    expect(blocks.map((b) => b.rows.length)).toEqual([2, 1, 1]);
  });

  it('prints the course heading once, on its first class', () => {
    const blocks = classBlocks(ROSTER);
    expect(blocks.map((b) => b.startsCourse)).toEqual([true, false, true]);
  });

  it('keeps every row, exactly once', () => {
    // The property that matters most: a printed roster that quietly loses or repeats a child is worse
    // than one that paginates badly.
    const names = classBlocks(ROSTER).flatMap((b) => b.rows.map((r) => r.name));
    expect(names).toEqual(['Abrar', 'Ahmad', 'Abidur', 'Bilal']);
  });

  it('gives unplaced children a block, with a heading', () => {
    // Both ids null. `startsCourse` is a flag rather than "is the name non-null" precisely so this
    // heading is not silently dropped — an unplaced course has no name.
    const blocks = classBlocks([row(null, null, null, null, 'Nobody'), row(null, null, null, null, 'Also nobody')]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].startsCourse).toBe(true);
    expect(blocks[0].courseName).toBeNull();
    expect(blocks[0].rows).toHaveLength(2);
  });

  it('does not merge same-named classes from different courses', () => {
    // Two courses can each have a "Year 1". Grouping on the NAME would print them as one class, and the
    // page break would fall in the wrong place.
    const blocks = classBlocks([
      row('crs_a', 'Aalim', 'cls_1', 'Year 1', 'A'),
      row('crs_h', 'Hifz', 'cls_9', 'Year 1', 'B'),
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.startsCourse)).toEqual([true, true]);
  });

  it('gives every block a distinct key', () => {
    // React keys, and two unplaced groups in different courses would otherwise collide.
    const blocks = classBlocks([...ROSTER, row(null, null, null, null, 'Nobody')]);
    expect(new Set(blocks.map((b) => b.key)).size).toBe(blocks.length);
  });

  it('returns nothing for an empty roster', () => {
    expect(classBlocks([])).toEqual([]);
  });
});
