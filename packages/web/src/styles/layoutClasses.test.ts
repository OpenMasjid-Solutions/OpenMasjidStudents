// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * ONE INVARIANT ABOUT A CLASS THAT LOOKS SAFE TO BORROW AND IS NOT (0.52.0-dev.11).
 *
 * `ul.picker-list` is a DROPDOWN. It is `position: absolute`, `top: 100%`, `z-index: 40`, and its
 * `:has()` companions lift the whole containing section to `z-index: 30` so it can paint over what
 * follows. All of that is correct for a list that floats under a combobox and catastrophic for a list
 * laid out in the page: the list leaves flow, its section collapses to the height of its heading, and
 * the list is drawn on top of whatever comes next.
 *
 * It was borrowed three times in one release — the inquiry's parent details (which landed on top of
 * the school and year selects, in the screenshot that started this fix), the admissions settings'
 * origin list, and a student's office notes — because in a component it reads as "a styled list", and
 * nothing about the name says otherwise. `ul.data-list` is the in-flow one.
 *
 * This is a SOURCE-SHAPE test for the same reason `paintCost.test.ts` is: there is no jsdom in this
 * workspace, the failure is silent, and what has to hold is what the source SAYS. It is deliberately
 * an allow-list of files rather than a count — a count passes the moment somebody deletes one misuse
 * and adds another.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const src = fileURLToPath(new URL('..', import.meta.url));

/** Every .tsx under packages/web/src, recursively. */
function components(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) components(p, out);
    else if (e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/**
 * The files allowed to render `picker-list` — i.e. the ones where it really is a floating dropdown
 * under an input. Adding a file here is a claim that it is a combobox popup; if it is a list of rows
 * in the page, it wants `data-list` instead.
 */
const DROPDOWNS = ['StudentPicker.tsx'];

describe('picker-list is a dropdown, not a list style', () => {
  it('is used only where a list genuinely floats under an input', () => {
    const offenders = components(src)
      .filter((f) => {
        const body = readFileSync(f, 'utf8');
        // Only className usage counts — a comment naming the class (there is one, explaining exactly
        // this) is documentation, not markup.
        return /className=\{?["'`][^"'`]*\bpicker-list\b/.test(body);
      })
      .map((f) => f.slice(src.length).replace(/\\/g, '/'))
      .filter((f) => !DROPDOWNS.some((allowed) => f.endsWith(allowed)));

    expect(offenders).toEqual([]);
  });

  it('still defines both classes, so neither fix can be lost by deleting a rule', () => {
    const css = readFileSync(join(src, 'styles', 'admin.css'), 'utf8');
    // The dropdown must stay absolutely positioned (that is what makes it a dropdown)…
    expect(css).toMatch(/ul\.picker-list\s*\{[^}]*position:\s*absolute/);
    // …and the in-flow one must exist and must NOT be, or the fix is cosmetic.
    const dataList = css.slice(css.indexOf('ul.data-list {'));
    expect(dataList).toBeTruthy();
    expect(dataList.slice(0, dataList.indexOf('}'))).not.toMatch(/position:\s*absolute/);
  });
});
