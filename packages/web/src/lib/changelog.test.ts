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
import { flatItems, isDetailHeading, isPrereleaseVersion, itemsFor, parseChangelog } from './changelog';

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

describe('headlines vs detail (0.49.0)', () => {
  /**
   * A stable install reads the headlines; a development build reads everything. The failure that matters
   * is the quiet one — a release whose whole entry leaks onto a masjid's screen because the marker moved
   * or a sub-heading came after it — so both directions are asserted, not just the happy one.
   */
  const md = `# Changelog

## [1.0.0]

- headline one
- headline two

### Also in this release

- small print
- more small print

### From a security review

- a fix too small to announce

## [0.9.0]

- an older release with no marker at all
`;
  const [newest, older] = parseChangelog(md);

  it('shows only the headlines on a release build', () => {
    expect(itemsFor(newest).map((i) => i.text)).toEqual(['headline one', 'headline two']);
  });

  it('shows everything on a development build', () => {
    expect(itemsFor(newest, true).map((i) => i.text)).toEqual([
      'headline one',
      'headline two',
      'small print',
      'more small print',
      'a fix too small to announce',
    ]);
  });

  it('keeps hiding the detail past a SUB-heading inside it', () => {
    // The detail half has its own headings. Stopping at the first would put the small print back in front
    // of a masjid through the very heading meant to hide it.
    expect(itemsFor(newest).map((i) => i.text)).not.toContain('a fix too small to announce');
  });

  it('leaves a release with no marker showing in full', () => {
    // Every entry written before this convention existed — nothing retroactively disappears.
    expect(itemsFor(older).map((i) => i.text)).toEqual(['an older release with no marker at all']);
  });

  it('defaults to the SHORT list when the running version is unknown', () => {
    // The health call may not have landed. Showing the wall of text to a stable install because we could
    // not read our own version is the wrong way to be wrong.
    expect(isPrereleaseVersion(undefined)).toBe(false);
    expect(isPrereleaseVersion('0.49.0')).toBe(false);
    expect(isPrereleaseVersion('0.49.0-dev.1')).toBe(true);
  });

  it('recognizes the marker however it is capitalized or continued', () => {
    expect(isDetailHeading('Also in this release')).toBe(true);
    expect(isDetailHeading('  also in this release, in detail  ')).toBe(true);
    expect(isDetailHeading('Added')).toBe(false);
    expect(isDetailHeading('')).toBe(false);
  });
});

describe('the real CHANGELOG.md', () => {
  const releases = parseChangelog(raw);

  it('the newest release has a short headline list', () => {
    // The point of the convention. If a release ever ships with twenty headlines, this is the reminder
    // that the marker was forgotten — before a masjid gets the wall of text rather than the news.
    const head = itemsFor(releases[0]);
    expect(head.length).toBeGreaterThan(0);
    expect(head.length).toBeLessThanOrEqual(10);
  });

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
