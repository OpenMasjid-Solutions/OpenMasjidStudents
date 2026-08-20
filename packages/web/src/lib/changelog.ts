// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Parsing CHANGELOG.md into releases for the in-app "What's new".
 *
 * Split out of the component so it can be tested on its own, which it badly needed: this parser had no
 * tests, and a bug in it SHIPPED. Until 0.45.1 a line that was not a bullet was silently dropped, so
 * four things a masjid was meant to read never reached the screen — including a correction published
 * against the 0.36.0 notes, which existed precisely to say what that release had really delivered. The
 * rule below ("an unrecognized line joins the item above rather than vanishing") is the fix, and the
 * tests beside this file are what keep it fixed.
 *
 * It handles only the constructs our changelog actually uses — version headings, group headings,
 * bullets, nested bullets, wrapped continuation lines — and is deliberately not a Markdown library.
 * Everything it returns is plain text; the component turns it into React elements, so there is no
 * `dangerouslySetInnerHTML` anywhere in this path and no release note can inject markup.
 */

export interface ChangelogItem {
  text: string;
  children: string[];
}
export interface ChangelogGroup {
  /** An `###` heading such as "Added" / "Fixed". Empty when a release opens straight into bullets. */
  title: string;
  items: ChangelogItem[];
}
export interface Release {
  version: string;
  groups: ChangelogGroup[];
}

/**
 * The heading that separates the headlines from the small print (0.49.0).
 *
 * A release note has two audiences and they want opposite things. A masjid on the STABLE channel wants
 * the few things that changed for them — the rest is a wall of text that makes the first line as easy to
 * skip as the last. Whoever is running the DEVELOPMENT channel is testing the build and wants all of it,
 * including the fixes too small to announce.
 *
 * So one changelog, one file, with everything in it — and a marker in the middle. Bullets before
 * `### Also in this release` are the headlines; everything from that heading onward is detail, shown only
 * on a prerelease build. Written this way rather than as two files because a second file is one somebody
 * forgets to update, and because the full history has to stay readable on GitHub, where both halves show.
 */
const DETAIL_HEADING = /^also in this release\b/i;

/** Is this heading the marker above? Exported so the CHANGELOG's own convention is testable. */
export function isDetailHeading(title: string): boolean {
  return DETAIL_HEADING.test(title.trim());
}

/** Does a version string name a development build (`0.49.0-dev.1`) rather than a release? */
export function isPrereleaseVersion(version: string | undefined | null): boolean {
  return !!version && version.includes('-');
}

/**
 * Parse the changelog, newest first.
 *
 * `[Unreleased]` is skipped — it describes work the masjid running this build does not have yet, so
 * showing it would promise features that are not there.
 */
export function parseChangelog(md: string): Release[] {
  const releases: Release[] = [];
  let release: Release | null = null;
  let group: ChangelogGroup | null = null;
  let item: ChangelogItem | null = null;

  for (const line of md.split('\n')) {
    const version = /^##\s+\[([^\]]+)\]/.exec(line);
    if (version) {
      const label = version[1];
      release = /unreleased/i.test(label) ? null : { version: label, groups: [] };
      if (release) releases.push(release);
      group = null;
      item = null;
      continue;
    }
    if (!release) continue;
    const heading = /^###\s+(.+)$/.exec(line);
    if (heading) {
      group = { title: heading[1].trim(), items: [] };
      release.groups.push(group);
      item = null;
      continue;
    }
    const nested = /^\s{2,}-\s+(.+)$/.exec(line);
    if (nested && item) {
      item.children.push(nested[1].trim());
      continue;
    }
    const bullet = /^-\s+(.+)$/.exec(line);
    if (bullet) {
      // A release can open with bullets before any `###` heading; give them an untitled group.
      if (!group) {
        group = { title: '', items: [] };
        release.groups.push(group);
      }
      item = { text: bullet[1].trim(), children: [] };
      group.items.push(item);
      continue;
    }
    // Anything else: a wrapped continuation of the bullet above, or standalone prose. It joins the
    // open item rather than being discarded — see the note at the top of this file.
    const cont = line.trim();
    if (cont && item) {
      if (item.children.length) item.children[item.children.length - 1] += ` ${cont}`;
      else item.text += ` ${cont}`;
    } else if (cont) {
      // Prose before any bullet in this release (an intro paragraph). Becomes its own item so it is
      // still read, which is exactly what 0.45.1 fixed.
      if (!group) {
        group = { title: '', items: [] };
        release.groups.push(group);
      }
      item = { text: cont, children: [] };
      group.items.push(item);
    }
  }
  return releases;
}

/** Every bullet of a release as one flat list, the way the notes are displayed (groups are a heading
 *  tier we no longer render — see WhatsNew.tsx). */
export function flatItems(r: Release): ChangelogItem[] {
  return r.groups.flatMap((g) => g.items);
}

/**
 * What THIS build should show: the headlines always, the detail only on a development build.
 *
 * `detail` defaults to false, and that default is the safe direction — a stable install whose version we
 * could not read (the health call had not landed yet) gets the short list rather than the long one. The
 * opposite default would leak the wall of text into exactly the place this exists to keep it out of.
 */
export function itemsFor(r: Release, detail = false): ChangelogItem[] {
  if (detail) return flatItems(r);
  const out: ChangelogItem[] = [];
  for (const g of r.groups) {
    // EVERYTHING from the marker onward, not just that one group. A release's detail half has its own
    // sub-headings ("From a security review…"), and stopping at the first of those would put the small
    // print back in front of a masjid — through the very heading meant to hide it.
    if (isDetailHeading(g.title)) break;
    out.push(...g.items);
  }
  return out;
}
