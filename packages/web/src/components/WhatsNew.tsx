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
 * The markdown is rendered into REACT ELEMENTS, never into HTML. There is no `dangerouslySetInnerHTML`
 * anywhere in the app and this is not the place to introduce one: the parser below handles the small
 * subset the changelog actually uses (version headings, group headings, bullets, nested bullets, bold
 * and code) and anything it does not recognise stays visible as plain text rather than disappearing.
 */
import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import raw from '../../../../CHANGELOG.md?raw';
import { trpc } from '../lib/trpc';

interface Item {
  text: string;
  children: string[];
}
interface Group {
  title: string;
  items: Item[];
}
interface Release {
  version: string;
  groups: Group[];
}

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
 * Parse the changelog into releases.
 *
 * Deliberately forgiving: an unrecognised line is appended to whatever item is open (which is how the
 * wrapped continuation lines in our own file are meant to read) rather than dropped. `[Unreleased]` is
 * skipped — it describes work a masjid does not have yet.
 */
function parseChangelog(md: string): Release[] {
  const releases: Release[] = [];
  let release: Release | null = null;
  let group: Group | null = null;
  let item: Item | null = null;

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
    // A wrapped continuation line: it belongs to whatever bullet is open.
    const cont = line.trim();
    if (cont && item) {
      if (item.children.length) item.children[item.children.length - 1] += ` ${cont}`;
      else item.text += ` ${cont}`;
    }
  }
  return releases;
}

export function WhatsNew() {
  const { t } = useTranslation();
  const health = trpc.health.useQuery(undefined, { retry: false });
  const releases = useMemo(() => parseChangelog(raw), []);
  const running = health.data?.version;

  return (
    <div className="win-content whats-new">
      <section className="section glass" style={{ padding: '1rem 1.1rem' }}>
        <div className="section-head">
          <h2><Sparkles size={16} /> {t('whatsNew.title')}</h2>
          {running && <span className="chip is-muted">{t('whatsNew.running', { version: running })}</span>}
        </div>
        <p className="hint" style={{ marginBlockStart: 0 }}>{t('whatsNew.intro')}</p>
      </section>

      {releases.map((r, ri) => (
        <section key={r.version} className="section glass" style={{ padding: '1rem 1.1rem' }}>
          <div className="section-head">
            <h3 style={{ margin: 0, fontSize: '1.05rem' }}>{t('whatsNew.version', { version: r.version })}</h3>
            {r.version === running && <span className="chip">{t('whatsNew.thisOne')}</span>}
          </div>
          {/* The newest release is open; older ones fold away so the window opens on what changed
              rather than on a wall of history. */}
          <details open={ri === 0}>
            <summary className="wn-summary">{ri === 0 ? t('whatsNew.hideDetails') : t('whatsNew.showDetails')}</summary>
            {r.groups.map((g, gi) => (
              <div key={`${r.version}-${gi}`} style={{ marginBlockStart: '0.6rem' }}>
                {g.title && <h4 className="wn-group">{g.title}</h4>}
                <ul className="wn-list">
                  {g.items.map((it, ii) => (
                    <li key={`${r.version}-${gi}-${ii}`}>
                      {inline(it.text, `${r.version}-${gi}-${ii}`)}
                      {it.children.length > 0 && (
                        <ul className="wn-list wn-sub">
                          {it.children.map((c, ci) => (
                            <li key={`${r.version}-${gi}-${ii}-${ci}`}>{inline(c, `${r.version}-${gi}-${ii}-${ci}`)}</li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </details>
        </section>
      ))}
    </div>
  );
}
