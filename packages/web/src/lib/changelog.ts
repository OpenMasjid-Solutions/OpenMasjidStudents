// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Parsing CHANGELOG.md into releases for the in-app "What's new".
 *
 * Split out of the component so it can be tested on its own, which it badly needed: this parser had no
 * tests, and a bug in it SHIPPED. Until 0.45.1 a line that was not a bullet was silently dropped, so
 * four things a masjid was meant to read never reached the screen — including a correction published
 * against the 0.36.0 notes, which existed precisely to say what that release had really delivered. The
 * rule below ("an unrecognised line joins the item above rather than vanishing") is the fix, and the
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
