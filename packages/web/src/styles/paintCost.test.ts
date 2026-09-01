// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Two paint-cost invariants that live in the stylesheets, and can only be caught here (0.51.0-dev.16).
 *
 * Both are the same shape of bug: a rule in one file corrected by a rule in another, where losing the
 * correction is SILENT — nothing throws, nothing looks wrong, the app just goes back to spending its
 * frame budget on blur. `app.css` and `glass.css` are verbatim ports kept re-syncable with
 * OpenMasjidOS (§15), so `shell.css` is where the corrections have to live, and a re-sync that drops or
 * reorders them is exactly the accident worth failing the build over.
 *
 * These read the authored CSS rather than a rendered page because there is no jsdom in this workspace
 * (see WhatsNew.test.tsx) — and because the invariants are about what the stylesheet SAYS, which is the
 * thing a re-sync changes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SCROLLING_ATTR } from '../lib/scrollIdle';

const here = fileURLToPath(new URL('.', import.meta.url));
const read = (f: string) => readFileSync(`${here}${f}`, 'utf8');

/** In `main.tsx`'s import order, so "which rule wins" is answerable. */
const SHEETS = ['glass.css', 'app.css', 'shell.css', 'admin.css', 'family.css'] as const;

/** The body of the block that starts at or after `from`, brace-matched — `@keyframes` and `@media`
 *  both nest, so a regex cannot find their end. */
function braceBlock(css: string, from: number): string {
  const open = css.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  return '';
}

/** The body of a named `@keyframes` block, or null if this sheet does not define it. */
function keyframesBody(css: string, name: string): string | null {
  const at = css.search(new RegExp(`@keyframes\\s+${name}\\s*\\{`));
  return at < 0 ? null : braceBlock(css, at);
}

/**
 * The `animation` shorthand that actually applies to a window's entrance.
 *
 * A crude cascade: most classes in the selector wins, later file breaks a tie. That is enough here
 * because the only two candidates are `.win-enter` (app.css) and `.win.win-enter` (shell.css), and it
 * means the test resolves the winner the way a browser would rather than being told which file to read.
 */
function winningWindowAnimation(): { keyframes: string; from: string } {
  const found: Array<{ keyframes: string; from: string; classes: number }> = [];
  for (const file of SHEETS) {
    const css = read(file);
    const rule = /([^{}]*\bwin-enter\b[^{}]*)\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = rule.exec(css))) {
      const anim = /animation\s*:\s*([A-Za-z_][\w-]*)/.exec(m[2]);
      if (!anim) continue;
      found.push({ keyframes: anim[1], from: file, classes: (m[1].match(/\./g) ?? []).length });
    }
  }
  if (found.length === 0) throw new Error('no rule animates .win-enter — the window entrance has gone missing');
  // Most classes in the selector wins; a later sheet breaks a tie (SHEETS is main.tsx's import order).
  return found.reduce((a, b) => (b.classes >= a.classes ? b : a));
}

describe("a window's entrance", () => {
  /**
   * The regression this exists for, and the reason is the part that is easy to lose.
   *
   * `winIn` (app.css) animates `filter: blur(6px) → blur(0)` alongside its opacity and transform. The
   * 240ms of full-window re-blur is the smaller half. The animation is declared `both`, so the FINAL
   * keyframe's value stays applied for the life of the window — and `filter: blur(0)` is not the same
   * as no filter: it holds a render surface and makes `.win` a backdrop root, so every frosted element
   * inside it was blurring the window's own scrolling content, dirty on every frame, permanently, for a
   * blur of zero pixels. Deleting shell.css's override sends `.win-enter` back to `winIn` and this goes
   * red.
   */
  it('animates nothing that forces a re-raster per frame', () => {
    const { keyframes } = winningWindowAnimation();
    const body = SHEETS.map((f) => keyframesBody(read(f), keyframes)).find((b) => b !== null);
    expect(body, `@keyframes ${keyframes} is referenced but not defined`).not.toBeNull();
    expect(body).not.toMatch(/(^|[\s;{])filter\s*:/);
    expect(body).not.toMatch(/backdrop-filter\s*:/);
  });

  it('still animates — the fix was to drop the filter, not the entrance', () => {
    const { keyframes } = winningWindowAnimation();
    const body = SHEETS.map((f) => keyframesBody(read(f), keyframes)).find((b) => b !== null) ?? '';
    expect(body).toMatch(/opacity\s*:/);
    expect(body).toMatch(/transform\s*:/);
  });

  /**
   * A MEDIA QUERY ADDS NO SPECIFICITY, which is what makes this worth a test rather than a comment.
   * app.css switches the entrance off under `prefers-reduced-motion` as `.win-enter` — one class — so
   * an override written as `.win.win-enter` wins inside that media query too, and hands the animation
   * back to exactly the people who asked not to have one. Overriding a ported rule means overriding
   * every branch of it, and nothing else in the build would notice if this branch went missing.
   */
  it('is switched off again under prefers-reduced-motion, at the overriding specificity', () => {
    const css = read('shell.css');
    const at = css.search(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(at, 'shell.css overrides .win-enter but has no reduced-motion branch').toBeGreaterThan(-1);
    const block = braceBlock(css, at);
    // At two classes, so it out-specifies the override above the way that override out-specifies app.css.
    expect(block).toMatch(/\.win\.win-enter\s*\{\s*animation:\s*none/);
  });
});

describe('the frosted-surface cap', () => {
  /**
   * glass.css caps a `.glass` nested in a `.glass` and never touches `.glass-inset` — which is on every
   * input, select and inset panel in the staff shell, ~27 of them inside one family's billing record.
   * Each is its own blur surface, and they were all in one scrolling container.
   */
  it('covers an inset inside every kind of glass ancestor', () => {
    const css = read('shell.css');
    for (const ancestor of ['.glass', '.glass-raised', '.glass-dock', '.glass-inset']) {
      const rule = new RegExp(`\\${ancestor} \\.glass-inset[^,{]*[,{]`);
      expect(css, `nothing caps .glass-inset inside ${ancestor}`).toMatch(rule);
    }
    // …and the block those selectors head actually turns the blur off.
    expect(css).toMatch(/\.glass-inset \.glass-inset[^{]*\{[^}]*backdrop-filter:\s*none/);
  });

  it('leaves the ported file its own opt-out rather than overriding it', () => {
    expect(read('shell.css')).toMatch(/\.glass-inset:not\(\.glass-allow-nested-blur\)/);
  });
});

describe('ambient motion during a scroll', () => {
  /**
   * Two files holding one fact. `lib/scrollIdle.ts` writes the attribute; shell.css selects on it.
   * Rename it on either side and the pause silently never happens again — no error, no visible change,
   * just the frame cost quietly back. This is the only thing that can notice.
   */
  it('pauses the aurora on the attribute scrollIdle actually writes', () => {
    const css = read('shell.css');
    expect(css).toMatch(new RegExp(`html\\[${SCROLLING_ATTR}\\][^{]*\\.scene::before`));
    expect(css).toMatch(new RegExp(`html\\[${SCROLLING_ATTR}\\][\\s\\S]{0,200}animation-play-state:\\s*paused`));
  });
});
