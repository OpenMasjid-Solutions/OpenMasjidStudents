// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Process configuration. The OpenMasjidOS Fabric values are read on EVERY process
 * start and NEVER persisted to the data volume — that is the restore/migration
 * resilience the platform requires (CLAUDE.md §12, OpenMasjidAPPS BUILDING_AN_APP §7).
 * Standalone (no platform) is a first-class mode: every field below can be empty.
 */
import path from 'node:path';
import { basePathFrom } from './http/basePath';

const env = process.env;

function str(v: string | undefined): string {
  return v && v.trim() !== '' ? v.trim() : '';
}

export const config = {
  /** Kept in step with the repo-root VERSION file + manifest.yaml (CLAUDE.md §19). */
  version: '0.40.0',
  port: Number(env.PORT) || 8080,
  /** SQLite DB, attachments, and generated report/transcript PDFs live here. */
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

  // ── Install settings (also editable in-app later) ───────────────────────────
  schoolName: str(env.SCHOOL_NAME),
  currency: (str(env.CURRENCY) || 'usd').toLowerCase(),
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
