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

  it('VERSION looks like a semver release', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
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

  it('the CHANGELOG has an entry for this version', () => {
    // A release whose notes were forgotten now also fails, since What's new is built from this file.
    expect(read('CHANGELOG.md')).toContain(`## [${version}]`);
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
   *   a digest-pinned release  — what `main` carries, and the only thing a stable install ever gets
   *   exactly `:dev`           — the moving development tag, on the `dev` branch
   *
   * `:dev` is the one mutable tag the org accepts, and only because opting into it is an explicit
   * choice in OpenMasjidOS. Note what this test can and cannot see: it knows the two shapes are
   * legitimate, but not which branch it is running on, so it cannot catch a `:dev` compose reaching a
   * release. That half is enforced where the branch is actually known — build-image.yml refuses to
   * publish a v* tag whose compose is not digest-pinned. Neither check is sufficient alone.
   */
  it('the compose image is a digest-pinned release or the moving :dev tag', () => {
    const m = /^\s*image:\s*(\S+)\s*$/m.exec(read('docker-compose.yml'));
    expect(m?.[1]).toMatch(
      /^ghcr\.io\/openmasjid-solutions\/openmasjidstudents:(?:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}|dev)$/,
    );
  });
});
