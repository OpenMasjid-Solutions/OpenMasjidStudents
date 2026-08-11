// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Entry point: a Fastify server that serves the tRPC API and (in production) the
 * built web app. Plain routes for /fabric, /api/stripe/webhook and /apply are
 * registered before the SPA fallback in later slices — each excluded from session
 * middleware but gated by its own checks (CLAUDE.md §16). Slice 1 boots the DB
 * (migrate-on-boot), mounts tRPC, and serves a health check.
 */
import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { config } from './config';
import { makeLog } from './logger';
import { runMigrations } from './db';
import { purgeExpiredSessions } from './auth/sessions';
import { appRouter, type AppRouter } from './trpc/router';
import { createContext } from './trpc/trpc';
import { registerStatementRoutes } from './billing/statementRoutes';
import { registerFabricProvider } from './fabric/provider';
import { refreshSiteInfo } from './fabric/platform';
import { backfillStudentCodes } from './billing/studentCodes';
import { ensureDefaultSchool } from './schools';
import { getSchoolLogo, parseLogoDataUri } from './settings';
import { loadStripeKeys } from './payments/stripe';
import { startSchedulers } from './payments/scheduler';
import { stripBasePath } from './http/basePath';

const log = makeLog('main');

// Paths served/handled outside the SPA (the web app is a client-side router).
const NON_SPA_PREFIXES = ['/trpc', '/api', '/fabric', '/statements', '/healthz'];

async function main(): Promise<void> {
  // Apply committed migrations before accepting traffic, then clear stale sessions.
  runMigrations();
  purgeExpiredSessions();
  // Best-effort (never blocks boot): fetch the chosen account's Stripe keys from the Fabric. There is
  // NO Stripe webhook — payments record via the Fabric record-payment calls, the portal's
  // confirm-on-return, autopay's synchronous confirm, and the daily reconciliation (§11.4).
  void loadStripeKeys();
  // Learn our public URL from the platform (manifest `domain: true`). Best-effort and never blocks:
  // invite/reset links need an absolute, off-network base, and OPENMASJID_PUBLIC_URL is empty until
  // an admin turns on Remote access — so asking is the difference between an invite that sends and
  // one that silently doesn't. The scheduler keeps it fresh.
  void refreshSiteInfo();
  // Give a kiosk ID to any student that predates the column. Idempotent and a no-op once done, so it
  // lives here rather than in a migration — assigning unique codes needs collision retries, which is
  // application logic, not something to write in SQL.
  backfillStudentCodes();
  // Make sure a school exists and nothing is left unscoped (0.47.0). Migration 0032 covers an install
  // that had data; this covers a brand-new database and anything the migration could not see.
  ensureDefaultSchool();
  startSchedulers(); // daily autopay run + reconciliation + public-URL refresh (no-op standalone)

  // The tunnel mount prefix (e.g. "/students"); "" when standalone / served at the root.
  const BASE = config.basePath;

  const app = Fastify({
    logger: false, // we log ourselves and never log secrets (CLAUDE.md §14)
    bodyLimit: 1_048_576, // 1 MiB JSON cap (uploads get their own limit later)
    // tRPC httpBatchLink batches queries into ONE GET whose path is the comma-joined
    // procedure list (e.g. records.fieldDefsList,records.notesForStudent,…). Fastify's
    // default maxParamLength (100) truncates that to a 414, silently failing the batch —
    // so raise it. (Caught by driving the student detail in a browser; createCaller tests
    // bypass HTTP and never hit this.)
    maxParamLength: 5000,
    // Base-path awareness (manifest tunnel: true): when OpenMasjidOS exposes us behind its
    // Cloudflare tunnel it forwards the FULL admin-chosen path prefix (e.g. /students)
    // WITHOUT stripping it, so requests arrive as /students/trpc, /students/assets/x,
    // /students/api/stripe/webhook, etc. We strip it here, before routing, so every route
    // below stays written at the root and works identically on the LAN (no prefix) and
    // behind the tunnel. Empty prefix = nothing to strip (standalone). (Mirrors the family
    // pattern in OpenMasjidDonations.)
    rewriteUrl: (req) => stripBasePath(req.url ?? '/', BASE),
  });

  await app.register(fastifyCookie);

  // Tolerate an empty JSON body (some clients POST no body) — parse it to `undefined` rather than
  // erroring; all other JSON routes get the parsed object. (There is no Stripe webhook, so we no
  // longer need the exact raw bytes for signature verification.)
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  app.get('/healthz', async () => ({ ok: true }));

  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router: appRouter, createContext } as FastifyTRPCPluginOptions<AppRouter>['trpcOptions'],
  });

  // Authed printable family statements (admin LAN-only / finance LAN+tunnel; §5, §14).
  registerStatementRoutes(app);

  // Fabric provider /fabric/billing/* (§11): secret-gated, tunnel-blocked; the students/billing capability.
  registerFabricProvider(app);

  /**
   * The school logo, as an image. Deliberately UNAUTHENTICATED, like the appearance relay: a
   * madrasa's own logo is public branding, not data about anybody, and email is the reason this
   * route exists at all — the platform's mail endpoint takes no attachments, so an emailed
   * statement or receipt can only show the logo by fetching an absolute URL. Printed statements
   * don't use this route; they inline the bytes so a sheet prints correctly with no network.
   *
   * The stored value is re-validated (magic bytes) on the way out, so the content type served is
   * one we have actually verified rather than whatever a settings row claims (§14).
   */
  app.get('/api/logo', async (_req, reply) => {
    const logo = getSchoolLogo();
    const parsed = logo ? parseLogoDataUri(logo) : null;
    if (!parsed) return reply.code(404).send({ error: 'no_logo' });
    return reply
      .header('content-type', parsed.mime)
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('x-content-type-options', 'nosniff')
      // Short cache: an admin who replaces the logo should see it change, but a busy statement page
      // shouldn't refetch it per render.
      .header('cache-control', 'public, max-age=300')
      .send(parsed.bytes);
  });

  // Same-origin appearance relay (CLAUDE.md §15). The parent portal + staff surfaces INHERIT the OS
  // dashboard's wallpaper + light/dark. The OS exposes GET /api/public/appearance (theme/wallpaper/
  // accent), but a browser can't fetch it directly: on the LAN it's a different origin + plain HTTP
  // (mixed content from our HTTPS page), and it isn't our origin over the tunnel. So the browser polls
  // US (same origin) and we fetch the platform server-to-server. No secrets; open (no auth), like /apply.
  // A tiny cache so many portal tabs polling every 45s don't each trigger an outbound hop, and a
  // slow OS response can't pile up. Only successful responses are cached; errors return {} and retry.
  let appearanceCache: { at: number; body: Record<string, unknown> } | null = null;
  const APPEARANCE_TTL_MS = 10_000;
  app.get('/api/public/appearance', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    if (!config.omosBaseUrl) return {}; // standalone — nothing to inherit
    const now = Date.now();
    if (appearanceCache && now - appearanceCache.at < APPEARANCE_TTL_MS) return appearanceCache.body;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await fetch(`${config.omosBaseUrl}/api/public/appearance`, { signal: ctrl.signal, redirect: 'error' });
      if (!res.ok) return {};
      const body = (await res.json()) as Record<string, unknown>;
      appearanceCache = { at: now, body };
      return body;
    } catch {
      return {}; // platform offline / slow — the #omos fragment (if any) already themed us
    } finally {
      clearTimeout(t); // clear AFTER the body read so the 4s deadline bounds the whole exchange
    }
  });

  // Production: serve the built web UI + SPA fallback. In dev, Vite serves the UI
  // (config.publicDir is empty), so this whole block is skipped.
  if (config.publicDir && fs.existsSync(path.join(config.publicDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: config.publicDir, index: false });
    // Inject the base path so the relative-built Vite assets (base: './') resolve under the tunnel
    // prefix, and the client can build prefix-aware API/nav URLs (window.__OMOS_BASE__). Fixed per
    // deployment (BASE is constant), so we inject once. `<base href="/">` when served at the root.
    const rawIndex = fs
      .readFileSync(path.join(config.publicDir, 'index.html'), 'utf8')
      .replace('<head>', `<head>\n    <base href="${BASE}/">\n    <script>window.__OMOS_BASE__=${JSON.stringify(BASE)}</script>`);
    /**
     * The SPA shell, and it MUST NOT be cached (0.48.0).
     *
     * It was sent with no `cache-control`, no `etag` and no `last-modified` — nothing at all. A response
     * with neither a directive nor a validator is one a browser may hold in its cache and reuse without
     * ever asking again (heuristic freshness), and that is what turns an update into a no-op: Vite gives
     * every asset a content-hashed name, so a stale `index.html` keeps pointing at the OLD bundle, which
     * the browser also still has. The result is the previous UI running against the new server — and
     * because the version in the account menu comes from the SERVER, it reports the new one, so the app
     * looks updated while none of the new screens exist. It cost a whole debugging session to find.
     *
     * `no-store` rather than `no-cache`: this document is 1 KB, it is fetched once per page load, and it
     * is the one file that decides which build the browser runs. There is nothing to gain by caching it
     * and an entire release to lose. The hashed assets it points at stay cacheable, which is the whole
     * point of hashing them.
     */
    const sendIndex = (_req: unknown, reply: import('fastify').FastifyReply) =>
      reply.type('text/html').header('cache-control', 'no-store, must-revalidate').send(rawIndex);
    // Serve the SPA index at the root explicitly — @fastify/static with index:false
    // returns 403 for a bare directory request, so it never reaches the fallback below.
    app.get('/', sendIndex);
    app.setNotFoundHandler((req, reply) => {
      const url = req.url.split('?')[0];
      const isAsset = path.extname(url) !== '';
      const isApi = NON_SPA_PREFIXES.some((p) => url === p || url.startsWith(p + '/'));
      if (req.method === 'GET' && !isAsset && !isApi) {
        // Through the same helper as `/`, so the no-store header above cannot apply to one entry point
        // and not the other — a deep link like /family or /billing is how most people arrive.
        sendIndex(req, reply);
        return;
      }
      reply.code(404).send({ error: 'Not found.' });
    });
  }

  await app.listen({ host: '0.0.0.0', port: config.port });
  log.info(
    `OpenMasjid Students on :${config.port} — ${config.publicDir ? 'serving UI' : 'API only (Vite serves the UI in dev)'}, ` +
      `${config.omosBaseUrl ? 'Fabric linked' : 'standalone'}`,
  );
}

main().catch((err) => {
  log.error('failed to start', err);
  process.exit(1);
});
