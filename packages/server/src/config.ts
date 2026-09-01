// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Process configuration. The OpenMasjidOS Fabric values are read on EVERY process
 * start and NEVER persisted to the data volume — that is the restore/migration
 * resilience the platform requires (CLAUDE.md §12, OpenMasjidAPPS BUILDING_AN_APP §7).
 * Standalone (no platform) is a first-class mode: every field below can be empty.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { basePathFrom } from './http/basePath';

const env = process.env;

function str(v: string | undefined): string {
  return v && v.trim() !== '' ? v.trim() : '';
}

/**
 * The running version, READ from this package's own package.json — never typed here.
 *
 * It was a hand-maintained literal until 0.42.1, and it drifted: the §19 release runbook lists the
 * files to bump and this was not one of them, so 0.41.0 and 0.42.0 both shipped telling the office they
 * were on 0.40.0. A version number that is only correct when someone remembers is not a version number,
 * and it is the one string a masjid uses to tell whether an update actually landed.
 *
 * `../package.json` resolves identically in dev and in the image, because `src/` and `dist/` sit at the
 * same depth inside `packages/server` — and the runtime stage copies that package.json anyway, since
 * `npm ci` needs it. `test/version.test.ts` asserts this agrees with VERSION and manifest.yaml, so
 * drift now fails CI instead of quietly misinforming a masjid.
 *
 * '0.0.0' rather than a plausible-looking guess if it cannot be read: unknown is honest, and visibly
 * wrong beats confidently wrong.
 */
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const config = {
  version: readVersion(),
  port: Number(env.PORT) || 8080,
  /** The SQLite database and its 30-minute snapshot live here. */
  dataDir: str(env.DATA_DIR) || path.resolve(process.cwd(), 'data'),
  /** Built web UI directory. Set in production (Docker → /app/public); empty in dev
   *  where Vite serves the UI and proxies the API. */
  publicDir: str(env.PUBLIC_DIR),

  // ── OpenMasjidOS Fabric (injected by the platform; empty when standalone) ────
  omosBaseUrl: str(env.OPENMASJID_BASE_URL),
  omosAppId: str(env.OPENMASJID_APP_ID),
  omosAppSecret: str(env.OPENMASJID_APP_SECRET),
  /** Public HTTPS URL from the OS Cloudflare tunnel; empty when not exposed. */
  omosPublicUrl: str(env.OPENMASJID_PUBLIC_URL),

  /**
   * Which OpenMasjidOS Stripe account to charge through, when the install wants to pin it (§13.1).
   *
   * The only env-provided install setting left. `SCHOOL_NAME` and `CURRENCY` used to sit here and were
   * removed in 0.51.0: nothing read them. The school name and currency are collected by the first-run
   * setup and live in the settings table (`getSchoolName`, `getCurrency`), which is the org rule — the
   * platform injects no masjid profile and each app owns its own config (§10) — so an env var for either
   * was a documented knob that did nothing.
   */
  stripeAccount: str(env.STRIPE_ACCOUNT),

  // The URL-path prefix the OS Cloudflare tunnel serves us under (e.g. "/students"),
  // derived from the public URL's pathname — the OS forwards the FULL prefix WITHOUT
  // stripping it, so we strip it ourselves before routing (see index.ts rewriteUrl) and
  // inject it into the page as `window.__OMOS_BASE__` + a matching `<base href>`. Empty
  // when standalone / not exposed → the app serves at the root exactly as before.
  basePath: basePathFrom(str(env.OPENMASJID_PUBLIC_URL)),
};

/** True when the platform has wired us into the Fabric (base URL + our secret). */
export const fabricConfigured = (): boolean => config.omosBaseUrl !== '' && config.omosAppSecret !== '';
