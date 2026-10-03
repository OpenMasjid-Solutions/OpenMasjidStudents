// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * EVERY STRING IN en.json CAN BE REACHED BY SOMETHING (0.52.0-dev.19).
 *
 * `en.json` is 1,600 strings and the only thing that ever deleted one was somebody remembering. When
 * a screen is rewritten the code goes and the words stay, and a dead string is not harmless: it is
 * read in review as evidence that a feature still exists, and it is translated — by a volunteer, into
 * Arabic and Urdu, for a button nobody can press.
 *
 * This found four when it was written. `readmission.openAll` ("Ask every active student") and
 * `readmission.opened` were orphaned by 0.52.0-dev.15, which moved opening a year into the rollover;
 * `record.title` and `admissions.alreadyHaveShort` had simply outlived their screens.
 *
 * ── Two ways a key is legitimately used, and the second is why a naive scan is wrong ──
 *
 *  1. literally — `t('admissions.formTitle')`
 *  2. BUILT AT RUNTIME — ``t(`admissions.state.${row.state}`)``
 *
 * A scan that only looked for the literal would call every state label dead. So a key also counts as
 * reachable when some prefix of it appears before a `${` in a template literal anywhere in the app.
 * That is how §9's generated-key rule is honoured rather than fought.
 *
 * ── And plural suffixes belong to i18next, not to the code ──
 *
 * `t('structure.nClasses', { count })` resolves `structure.nClasses_one` or `_other` itself; neither
 * suffix is ever written down. They are stripped before the check — which is also what makes the
 * stale `_plural` suffix (i18next v3, and this app is on v24) visible as the bug it was rather than
 * disappearing into the noise.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import en from './en.json';

const src = fileURLToPath(new URL('../..', import.meta.url));

/** Every .ts/.tsx under packages/web/src, except the locale files themselves. */
function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'i18n') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

const blob = sources(src)
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

/**
 * `admissions.state.` from ``t(`admissions.state.${x}`)`` — every runtime-built key prefix.
 *
 * Only a capture ending in `.` or `_` counts. Template literals are everywhere in a codebase and most
 * of them are not i18n: `` `H${row}` `` in the spreadsheet writer captured "H", and a one-letter
 * prefix would then quietly mark every key beginning with that letter as reachable. Requiring the
 * namespace separator is what keeps this test from excusing the orphans it exists to find.
 */
const prefixes = [...blob.matchAll(/`([a-zA-Z0-9_.]+?)\$\{/g)].map((m) => m[1]!).filter((p) => /[._]$/.test(p));

const PLURAL = /_(one|other|zero|two|few|many)$/;

function flatten(obj: Record<string, unknown>, path = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const p = path ? `${path}.${k}` : k;
    return v && typeof v === 'object' ? flatten(v as Record<string, unknown>, p) : [p];
  });
}

/**
 * Keys that are real but unreachable by the two rules above. Empty, and a line added here needs a
 * reason beside it — the point of the test is that the list stays empty.
 */
const ALLOWED: string[] = [];

describe('en.json carries no dead strings', () => {
  const keys = flatten(en as unknown as Record<string, unknown>);

  it('has enough keys and prefixes for this test to mean anything', () => {
    // The positive control. Both halves silently degrade to "everything passes" — a broken file walk
    // gives an empty blob and marks every key dead (loud), but a prefix list that matched everything
    // would mark every key alive (silent), which is the direction worth pinning.
    expect(keys.length).toBeGreaterThan(1_000);
    expect(prefixes.length).toBeGreaterThan(20);
    expect(prefixes.every((p) => /[._]$/.test(p))).toBe(true);
  });

  it('can reach every one of them', () => {
    // A suffix is i18next's ONLY when the key has a plural sibling. `billing.ch_other` is the payment
    // channel "Other" and has no `_one` beside it; stripping its suffix invents `billing.ch`, a key
    // that does not exist and cannot be reached — which is how this test's first draft reported a
    // phantom orphan. i18next always needs at least the `_one`/`_other` pair, so "has a sibling" is
    // the thing that actually distinguishes the two.
    const plurals = new Set<string>();
    for (const k of keys) {
      const base = k.replace(PLURAL, '');
      if (base !== k && keys.some((o) => o !== k && o.replace(PLURAL, '') === base)) plurals.add(k);
    }

    const orphans = keys
      .map((k) => (plurals.has(k) ? k.replace(PLURAL, '') : k))
      .filter((k, i, a) => a.indexOf(k) === i)
      .filter((k) => !ALLOWED.includes(k))
      .filter((k) => !blob.includes(`'${k}'`) && !blob.includes(`"${k}"`) && !blob.includes(`\`${k}\``))
      .filter((k) => !prefixes.some((p) => k.startsWith(p)));

    expect(orphans).toEqual([]);
  });

  it('uses i18next v4 plural suffixes, not the v3 `_plural`', () => {
    // `billing.yearPerTermExcluded_plural` existed for releases and never rendered: v24 asks for
    // `_one`/`_other`, so every count fell back to the singular — "2 per-term fee".
    expect(flatten(en as unknown as Record<string, unknown>).filter((k) => k.endsWith('_plural'))).toEqual([]);
  });
});
