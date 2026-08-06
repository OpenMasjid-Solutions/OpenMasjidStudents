// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The version a release claims to be, checked in every place that claims it.
 *
 * This exists because of a real, shipped bug: `config.version` was a hand-typed literal, the §19 bump
 * list did not mention it, and so v0.41.0 and v0.42.0 both told the office they were running 0.40.0 —
 * in the account menu and at the top of the release notes. That is the one string a masjid uses to
 * check whether an update landed, so being wrong about it undermines every other release note.
 *
 * Six files have to agree, and until now nothing verified that. A release with a half-finished bump now
 * fails here rather than in somebody's account menu:
 *
 *   VERSION · manifest.yaml · root package.json · packages/server · packages/web · what the server reports
 *
 * The point is the AGREEMENT, not any particular number, so there is nothing to update here at release
 * time — which is exactly why it will keep working.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../src/config';

/** The repo root, from packages/server/test. */
const root = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
const pkgVersion = (rel: string) => (JSON.parse(read(rel)) as { version: string }).version;

describe('every place that states the version agrees', () => {
  const version = read('VERSION').trim();
  /**
   * The dev branch carries a semver PRERELEASE (`0.46.0-dev.3`); `main` carries a plain release.
   *
   * That is not cosmetic. OpenMasjidOS detects an app update by comparing the catalog's `version`
   * against the installed one, so while the dev entry declared the same version as stable there was
   * nothing observable to compare and development-channel updates simply never fired. Each dev build
   * now gets its own version, and CI publishes an image tag to match.
   *
   * `base` is the release the work is heading toward, and it is what the CHANGELOG is filed under — a
   * heading per dev build would be noise nobody reads.
   */
  const base = version.replace(/-.*$/, '');
  const isPrerelease = version !== base;

  it('VERSION is a release, or a -dev.N prerelease of one', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+(-dev\.\d+)?$/);
  });

  it('the three package.json files match VERSION', () => {
    expect(pkgVersion('package.json')).toBe(version);
    expect(pkgVersion('packages/server/package.json')).toBe(version);
    expect(pkgVersion('packages/web/package.json')).toBe(version);
  });

  it('manifest.yaml — what the App Store shows — matches VERSION', () => {
    // Matched with a regex rather than a YAML parse to keep this test dependency-free; the manifest's
    // `version:` is a plain top-level scalar.
    const m = /^version:\s*(\S+)\s*$/m.exec(read('manifest.yaml'));
    expect(m?.[1]).toBe(version);
  });

  it('the server REPORTS that version — the number an admin actually sees', () => {
    // Reads packages/server/package.json at runtime (see config.readVersion), so this also proves the
    // path resolves — the same relative path the built image uses.
    expect(config.version).toBe(version);
    expect(config.version).not.toBe('0.0.0'); // the "could not read it" fallback
  });

  it('the CHANGELOG has an entry for the release this version belongs to', () => {
    // A release whose notes were forgotten now also fails, since What's new is built from this file.
    // Checked against the BASE version so `0.46.0-dev.3` is satisfied by the `## [0.46.0]` entry: the
    // notes describe the release being worked toward, and filing one heading per dev build would leave
    // a masjid scrolling through build numbers to find what actually changed.
    expect(read('CHANGELOG.md')).toContain(`## [${base}]`);
  });

  /**
   * The compose pin is checked for SHAPE, not for equality with VERSION.
   *
   * It cannot be equality: §19 bumps the version, pushes, waits for the image, and only then pins the
   * digest — so between steps 1 and 4 the compose legitimately still names the previous release, which
   * is exactly when CI runs. A test that fails on every release's first push is a test that gets
   * deleted. What is worth asserting is that the line never regresses to an ARBITRARY floating tag,
   * since a masjid installing from a moving tag gets a build nobody audited.
   *
   * Two forms are sanctioned, one per update channel (CLAUDE.md "Branching policy"):
   *   a digest-pinned release          — what `main` carries; the only thing a stable install gets
   *   the exact `:X.Y.Z-dev.N` tag     — on the `dev` branch, matching this VERSION
   *
   * NO moving tag is acceptable in either. `:dev` used to be allowed here and that was the bug: the
   * catalog embeds this compose, and a tag that silently moves gave OpenMasjidOS nothing observable to
   * compare, so it could neither notify anyone nor find anything to update to.
   *
   * On dev this is checked for EQUALITY with VERSION, not just for shape — a stale tag would make every
   * dev host install the previous build while the catalog advertised the new version, which is a lie
   * that looks exactly like success. Note what this test cannot see: which branch it is on. That half is
   * enforced where the ref is known (build-image.yml). Neither check is sufficient alone.
   */
  it('the compose image is a digest-pinned release, or this exact prerelease tag', () => {
    const m = /^\s*image:\s*(\S+)\s*$/m.exec(read('docker-compose.yml'));
    const img = m?.[1] ?? '';
    if (isPrerelease) {
      expect(img).toBe(`ghcr.io/openmasjid-solutions/openmasjidstudents:${version}`);
    } else {
      expect(img).toMatch(/^ghcr\.io\/openmasjid-solutions\/openmasjidstudents:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
    }
  });

  it('every service image is pinned — no floating tag anywhere in the compose', () => {
    // The catalog runs the whole file, so a second service on `:latest` would be just as unreproducible
    // as the first. There is one service today; this fails the moment that stops being true.
    const lines = read('docker-compose.yml').split('\n').filter((l) => /^\s*image:/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l).not.toMatch(/:(dev|latest)\s*$/);
    }
  });
});
