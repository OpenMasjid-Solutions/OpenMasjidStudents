// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * INK ON FILLED ELEMENTS, MEASURED (0.52.0-dev.18).
 *
 * The OpenMasjid app UI/UX spec §7 says to check contrast on FILLED elements specifically, "because
 * that is where it fails, and a delete button is the worst place for it to" — and §3 says to set an
 * accent's ink in the same breath as its fill. Both were wrong here, and both were invisible:
 *
 *  - `applyAccent` set `--color-primary` / `--color-btn` and NOT `--color-on-primary`. In the LIGHT
 *    theme the stylesheet's ink is white (light's own primary is a deep blue), so switching to any
 *    other accent left white on a bright fill: gold 1.67:1, teal 1.86, sky 2.14, violet 2.72. Four of
 *    five accents, every filled button. Dark was fine, which is why nobody developing in the default
 *    theme would ever see it.
 *  - `.btn--danger` hardcoded `#fff`. Dark's danger is a light red, so that is 2.77:1 on every
 *    destructive button in the app.
 *
 * This test COMPUTES the ratios rather than asserting the hex values somebody typed. Asserting the
 * values would pass against a palette that is internally consistent and unreadable, which is exactly
 * the state it is here to prevent — and it means a future accent added to the table is checked by
 * arithmetic rather than by whoever reviews the diff.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ACCENTS } from '../lib/prefs';

const here = fileURLToPath(new URL('.', import.meta.url));
const tokens = readFileSync(`${here}tokens.css`, 'utf8');

/** WCAG 2.x relative luminance. */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const part = (i: number) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * part(0) + 0.7152 * part(2) + 0.0722 * part(4);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** A token's value inside a given selector block of tokens.css. */
function tokenIn(selector: string, name: string): string {
  const start = tokens.indexOf(selector);
  expect(start, `${selector} not found in tokens.css`).toBeGreaterThan(-1);
  const block = tokens.slice(start, tokens.indexOf('}', start));
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
  expect(m, `${name} missing from ${selector}`).toBeTruthy();
  return m![1]!;
}

/** AA for normal text. Every one of these is a button label. */
const AA = 4.5;

describe('every accent carries readable ink', () => {
  it('defines onPrimary for all five', () => {
    expect(Object.keys(ACCENTS).sort()).toEqual(['cyan', 'gold', 'sky', 'teal', 'violet']);
    for (const [id, a] of Object.entries(ACCENTS)) {
      expect(a.onPrimary, `${id} has no onPrimary`).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('meets AA on its own fill', () => {
    for (const [id, a] of Object.entries(ACCENTS)) {
      const ratio = contrast(a.onPrimary, a.primary);
      expect(ratio, `${id}: ${a.onPrimary} on ${a.primary} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
    }
  });

  it('meets AA on its HOVER fill too — a button is still read while the pointer is on it', () => {
    for (const [id, a] of Object.entries(ACCENTS)) {
      const ratio = contrast(a.onPrimary, a.hover);
      expect(ratio, `${id} hover: ${a.onPrimary} on ${a.hover} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
    }
  });

  it('would FAIL with the stylesheet ink, which is the bug this exists for', () => {
    // The positive control. Without it, the three tests above pass just as happily against a table
    // where every onPrimary was copied from the fill's own theme and nothing was ever switched.
    const lightInk = tokenIn('[data-theme="light"]', '--color-on-primary');
    const bad = Object.entries(ACCENTS).filter(([id]) => id !== 'cyan').map(([, a]) => contrast(lightInk, a.primary));
    expect(bad.every((r) => r < AA)).toBe(true);
  });
});

describe('applyAccent applies the ink, not just the fill', () => {
  /**
   * THE HALF THAT ACTUALLY CAUGHT THE ORIGINAL BUG, and it is a SOURCE-SHAPE test for the reason
   * `paintCost.test.ts` gives: there is no jsdom in this workspace, so `applyAccent` cannot be run
   * against a document. Every assertion above is about the TABLE — and the table was never the
   * problem. The values were right; the function set five custom properties and not the sixth.
   */
  const src = readFileSync(`${here}../lib/prefs.ts`, 'utf8');
  const body = src.slice(src.indexOf('export function applyAccent'), src.indexOf('export function applyWallpaper'));

  it('SETS --color-on-primary wherever it sets the fill', () => {
    expect(body).toContain("setProperty('--color-btn'");
    expect(body).toContain("setProperty('--color-on-primary'");
  });

  it('REMOVES it again on the default accent, or the pair comes apart the other way', () => {
    // Clearing the fill back to the stylesheet while leaving a bright accent's near-black ink behind
    // is the same bug mirrored: dark ink on light's deep-blue primary.
    expect(body).toContain("removeProperty('--color-btn'");
    expect(body).toContain("removeProperty('--color-on-primary'");
  });
});

describe('the danger fill carries readable ink', () => {
  it('defines --color-on-danger in both themes, and both meet AA', () => {
    for (const theme of ['[data-theme="dark"]', '[data-theme="light"]']) {
      const fill = tokenIn(theme, '--color-danger');
      const ink = tokenIn(theme, '--color-on-danger');
      const ratio = contrast(ink, fill);
      expect(ratio, `${theme}: ${ink} on ${fill} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
    }
  });

  it('white on the DARK theme’s danger fails — which is what shipped until now', () => {
    expect(contrast('#FFFFFF', tokenIn('[data-theme="dark"]', '--color-danger'))).toBeLessThan(AA);
  });

  it('no destructive button hardcodes its ink', () => {
    // `app.css` is a verbatim port and still says `color: #fff`; `shell.css` is where the deviation
    // lives (§15), so what matters is that SOMETHING later sets the token. Asserting the override
    // exists is what a re-sync of app.css cannot quietly undo.
    const shell = readFileSync(`${here}shell.css`, 'utf8');
    const rule = shell.slice(shell.indexOf('.btn--danger'));
    expect(rule).toContain('var(--color-on-danger)');
  });
});
