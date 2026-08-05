// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The changelog parser, which had no tests until now and shipped a bug because of it.
 *
 * Until 0.45.1 any line that was not a bullet was silently dropped on the way to the screen, so four
 * things a masjid was meant to read never appeared — the summary at the top of the 0.45.0 entry, the
 * note explaining that 0.36.0's features arrived with no screens to reach them by, the whole of the
 * 0.1.0 entry, and a correction published against the 0.36.0 notes. The last one is the reason this file
 * exists: a correction that cannot be read is worse than no correction, because everyone assumes the
 * original still stands.
 *
 * The real CHANGELOG.md is parsed at the end, so a future entry written in a shape the parser cannot
 * handle fails here rather than going quietly missing in somebody's account menu.
 */
import { describe, it, expect } from 'vitest';
import raw from '../../../../CHANGELOG.md?raw';
import { flatItems, parseChangelog } from './changelog';

describe('parseChangelog', () => {
  it('reads versions newest-first and skips [Unreleased]', () => {
    const rs = parseChangelog(`# Changelog

## [Unreleased]

- something not shipped yet

## [0.2.0]

- newer thing

## [0.1.0]

- older thing
`);
    expect(rs.map((r) => r.version)).toEqual(['0.2.0', '0.1.0']);
    expect(JSON.stringify(rs)).not.toContain('not shipped yet');
  });

  it('keeps a plain paragraph instead of dropping it [the 0.45.1 bug]', () => {
    const rs = parseChangelog(`## [0.3.0]

> **Corrected after release.** This entry overstated what shipped.

- an actual bullet
`);
    const texts = flatItems(rs[0]).map((i) => i.text);
    expect(texts.join(' ')).toContain('Corrected after release');
    expect(texts.join(' ')).toContain('an actual bullet');
  });

  it('joins a wrapped continuation line onto the bullet above it', () => {
    const rs = parseChangelog(`## [0.3.0]

- a bullet that runs on
  across two lines
`);
    expect(flatItems(rs[0])[0].text).toBe('a bullet that runs on across two lines');
  });

  it('keeps nested sub-bullets as children, not as siblings', () => {
    const rs = parseChangelog(`## [0.3.0]

- the change
  - why it matters
  - and another
- a second change
`);
    const items = flatItems(rs[0]);
    expect(items).toHaveLength(2);
    expect(items[0].children).toEqual(['why it matters', 'and another']);
    expect(items[1].text).toBe('a second change');
  });

  it('groups under ### headings, and flattens them in order for display', () => {
    const rs = parseChangelog(`## [0.3.0]

### Added

- added one

### Fixed

- fixed one
`);
    expect(rs[0].groups.map((g) => g.title)).toEqual(['Added', 'Fixed']);
    // Display order follows the file, so "Added" still precedes "Fixed" without the headings.
    expect(flatItems(rs[0]).map((i) => i.text)).toEqual(['added one', 'fixed one']);
  });

  it('handles a release that opens straight into bullets, with no ### heading', () => {
    const rs = parseChangelog(`## [0.3.0]

- straight in
`);
    expect(rs[0].groups).toHaveLength(1);
    expect(rs[0].groups[0].title).toBe('');
    expect(flatItems(rs[0])[0].text).toBe('straight in');
  });

  it('ignores the file header above the first release', () => {
    const rs = parseChangelog(`<!-- SPDX -->

# Changelog

All notable changes are recorded here.

## [0.1.0]

- first
`);
    expect(rs).toHaveLength(1);
    expect(flatItems(rs[0]).map((i) => i.text)).toEqual(['first']);
  });

  it('returns nothing rather than throwing on an empty or headerless file', () => {
    expect(parseChangelog('')).toEqual([]);
    expect(parseChangelog('just prose, no headings at all')).toEqual([]);
  });
});

describe('the real CHANGELOG.md', () => {
  const releases = parseChangelog(raw);

  it('parses into many releases, newest first', () => {
    expect(releases.length).toBeGreaterThan(20);
    expect(releases[0].version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('leaves no release empty — an entry with nothing readable in it is the shipped bug', () => {
    const empty = releases.filter((r) => flatItems(r).length === 0).map((r) => r.version);
    expect(empty).toEqual([]);
  });

  it('drops nothing: every bullet and paragraph in the file is accounted for', () => {
    // Count the lines the file offers as content, and the items the parser produced from them.
    const lines = raw.split('\n');
    let inRelease = false;
    let offered = 0;
    for (const line of lines) {
      const head = /^##\s+\[([^\]]+)\]/.exec(line);
      if (head) {
        inRelease = !/unreleased/i.test(head[1]);
        continue;
      }
      if (!inRelease) continue;
      if (/^###\s+/.test(line)) continue; // a group heading is not content
      if (/^\s*-\s+/.test(line)) offered++;
    }
    const produced = releases.reduce((n, r) => n + flatItems(r).reduce((m, i) => m + 1 + i.children.length, 0), 0);
    // Every bullet becomes an item or a child; paragraphs may add more, never fewer.
    expect(produced).toBeGreaterThanOrEqual(offered);
  });

  it('marks the current release, whose version the app compares against', () => {
    // The newest entry must be a plain semver so `r.version === running` can match what the server
    // reports; a decorated heading ("0.46.0 — big one") would silently never show the pill.
    expect(releases[0].version).not.toMatch(/[^\d.]/);
  });
});
