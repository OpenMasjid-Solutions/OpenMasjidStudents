// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The release-notes LAYOUT, rendered for real.
 *
 * The notes were rebuilt to match OpenMasjid Kiosk's: one flat scroll of releases separated by
 * hairlines, each with its version and a green "You're on this" pill — replacing per-release glass
 * cards with "Show what changed" collapsibles. That is a shape, and a shape is exactly the kind of
 * thing that drifts back: the next person to add a section here will reach for `<section class="glass">`
 * because that is what the rest of the admin looks like.
 *
 * So this asserts the shape, not the prose. `renderToStaticMarkup` needs no DOM, which is why there is
 * no jsdom in this workspace; importing `../lib/i18n` initialises i18next synchronously so the real
 * English strings resolve rather than bare keys.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import '../lib/i18n';
import { ReleaseNotes } from './WhatsNew';
import { parseChangelog } from '../lib/changelog';

const SAMPLE = parseChangelog(`## [0.46.0]

### Added

- **A new thing.** With \`code\` in it.
  - why it matters

### Fixed

- **A fixed thing.**

## [0.45.0]

- **An older thing.**
`);

const render = (running?: string) => renderToStaticMarkup(<ReleaseNotes releases={SAMPLE} running={running} />);

describe('the Kiosk-style layout', () => {
  it('renders one flat list per release — not a card or a collapsible each', () => {
    const html = render('0.46.0');
    expect(html.match(/class="wn-release"/g)).toHaveLength(2);
    // One <ul class="wn-list"> per release at the top level; the third is the nested sub-list.
    expect(html.match(/class="wn-list"/g)).toHaveLength(2);
    expect(html).not.toContain('<details');
    expect(html).not.toContain('wn-summary');
    expect(html).not.toContain('section glass');
  });

  it('flattens ### groups into that one list, keeping file order', () => {
    const html = render();
    expect(html).not.toContain('wn-group');
    expect(html).not.toContain('>Added<');
    expect(html).not.toContain('>Fixed<');
    expect(html.indexOf('A new thing')).toBeLessThan(html.indexOf('A fixed thing'));
  });

  it('puts the green pill on the running version and nowhere else', () => {
    const html = render('0.46.0');
    expect(html.match(/pill pill--ok/g)).toHaveLength(1);
    expect(html).toContain('You’re on this');
    // It must sit inside the 0.46.0 heading, not the 0.45.0 one.
    const h = html.slice(html.indexOf('0.46.0'), html.indexOf('0.45.0'));
    expect(h).toContain('pill--ok');
  });

  it('shows no pill at all when the running version is unknown', () => {
    expect(render()).not.toContain('pill--ok');
  });

  it('leads with the intro line, naming the running version when there is one', () => {
    expect(render('0.46.0')).toContain('up to the v0.46.0 you’re running');
    expect(render()).toContain('Release notes for OpenMasjid Students.');
  });

  it('keeps version headings as bare numbers, matching the screenshot', () => {
    const html = render('0.46.0');
    expect(html).toContain('<h3 class="wn-version">0.46.0');
    expect(html).not.toContain('Version 0.46.0'); // the old "Version {{n}}" wording is gone
  });

  it('renders bold and code as elements, and keeps nested notes nested', () => {
    const html = render();
    expect(html).toContain('<strong>A new thing.</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('wn-list wn-sub');
    expect(html).toContain('why it matters');
  });

  it('never emits raw HTML from a release note', () => {
    const hostile = parseChangelog('## [9.9.9]\n\n- <img src=x onerror=alert(1)> and **bold**\n');
    const html = renderToStaticMarkup(<ReleaseNotes releases={hostile} running="9.9.9" />);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
    expect(html).toContain('<strong>bold</strong>');
  });
});
