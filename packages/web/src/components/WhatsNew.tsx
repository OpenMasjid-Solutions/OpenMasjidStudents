// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * "What's new" — the release notes, in the app.
 *
 * The changelog is BUNDLED, not fetched: `?raw` inlines the repo's CHANGELOG.md at build time, so what
 * a masjid reads is exactly the changelog of the version they are running. Reading it from disk at
 * runtime would mean shipping the file into the image and keeping a route to serve it, and it could
 * drift from the running build; a fetch would mean a spinner and a failure mode for a page of text.
 *
 * LAYOUT — matched to OpenMasjid Kiosk's release notes (`web/src/whatsnew.tsx` there) so the two apps
 * read alike from the same platform: one intro line, then a single flat scroll of releases separated by
 * hairlines, each headed by its version with a green "You're on this" pill against the running build.
 *
 * What that replaced: every release used to be its own glass card with a "Show what changed"
 * collapsible, so reading two releases took two clicks and the window opened on a stack of lids rather
 * than on the news. The `### Added` / `### Fixed` sub-headings are flattened for the same reason Kiosk
 * has no concept of them — the bullets say what they are ("Fixed: …", "New: …"), and the heading tier
 * was chrome around six older entries. No bullet is dropped; only the grouping label is.
 *
 * The PARSER (lib/changelog.ts) is deliberately not Kiosk's: ours keeps nested sub-bullets and, since
 * 0.45.1, keeps plain paragraphs too. Matching the look is the ask; adopting a weaker parser would undo
 * a shipped fix.
 *
 * The markdown becomes REACT ELEMENTS, never HTML. There is no `dangerouslySetInnerHTML` in the app and
 * this is not the place to introduce one.
 */
import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import raw from '../../../../CHANGELOG.md?raw';
import { trpc } from '../lib/trpc';
import { isPrereleaseVersion, itemsFor, parseChangelog, type Release } from '../lib/changelog';

/** `**bold**` and `` `code` `` → elements. Everything else is text, including any markdown this does
 *  not know about — a stray asterisk is a cosmetic wart; swallowing a sentence is a bug. */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // One pass over both patterns, so `**a `b`**` cannot desynchronise two separate passes.
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<strong key={`${keyBase}-b${i}`}>{m[1]}</strong>);
    else out.push(<code key={`${keyBase}-c${i}`}>{m[2]}</code>);
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * The notes themselves. Pure — takes the parsed releases and the running version, touches no network —
 * so the layout can be rendered and asserted in a test (see WhatsNew.test.tsx), which is the only way
 * to keep "flat single list per release" from quietly regressing into cards again.
 */
export function ReleaseNotes({ releases, running }: { releases: Release[]; running?: string }) {
  const { t } = useTranslation();
  /**
   * How much to show (0.49.0). A masjid on the stable channel gets the headlines; a development build
   * gets everything, because whoever is running one is testing it. The changelog marks the boundary with
   * `### Also in this release` (lib/changelog.ts) — one file, both audiences.
   *
   * Decided from the RUNNING version rather than a build-time flag, so a dev image and a release image
   * are the same code answering the same question about themselves.
   */
  const detail = isPrereleaseVersion(running);
  return (
    <div className="win-content whats-new">
      {/* The window's own title bar already says "What's new"; this is the line beneath it. */}
      <p className="wn-intro">
        {running ? t('whatsNew.introRunning', { version: running }) : t('whatsNew.intro')}
      </p>

      {releases.map((r) => (
        <section className="wn-release" key={r.version}>
          <h3 className="wn-version">
            {r.version}
            {r.version === running && <span className="pill pill--ok">{t('whatsNew.thisOne')}</span>}
          </h3>
          <ul className="wn-list">
            {itemsFor(r, detail).map((it, ii) => (
              <li key={`${r.version}-${ii}`}>
                {inline(it.text, `${r.version}-${ii}`)}
                {it.children.length > 0 && (
                  <ul className="wn-list wn-sub">
                    {it.children.map((c, ci) => (
                      <li key={`${r.version}-${ii}-${ci}`}>{inline(c, `${r.version}-${ii}-${ci}`)}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function WhatsNew() {
  const health = trpc.health.useQuery(undefined, { retry: false });
  const releases = useMemo(() => parseChangelog(raw), []);
  return <ReleaseNotes releases={releases} running={health.data?.version} />;
}
