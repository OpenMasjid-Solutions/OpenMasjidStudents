// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Entry point: a Fastify server that serves the tRPC API and (in production) the built web app.
 *
 * The plain (non-tRPC) routes are registered BEFORE the SPA fallback, each excluded from the session
 * middleware and gated by its own checks (CLAUDE.md §16): `/fabric/*` by the app secret, the printable
 * documents by cookie + role + origin, and the branding/PWA files by nothing, because they carry the
 * madrasah's public name and logo and nothing else. There is no Stripe webhook (§13.4).
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
import { registerFabricCommands } from './fabric/commands';
import { refreshSiteInfo } from './fabric/platform';
import { backfillStudentCodes } from './billing/studentCodes';
import { ensureDefaultSchool } from './schools';
import { getSchoolLogo, getSchoolName, parseLogoDataUri } from './settings';
import { loadStripeKeys } from './payments/stripe';
import { startSchedulers } from './payments/scheduler';
import { stripBasePath } from './http/basePath';
import { buildManifest } from './http/manifest';

const log = makeLog('main');

// Paths served/handled outside the SPA (the web app is a client-side router).
/**
 * Prefixes the SPA fallback must NOT answer for — anything here 404s instead of serving the shell.
 *
 * All FOUR printable-document prefixes belong here, not just `/statements`. `billing/statementRoutes.ts`
 * serves `/statements/family/:id`, `/sheets/family/:id`, `/sheets/ids/:id` and `/invoices/:id`; only
 * the first was listed, so a mistyped or stale link to one of the other three answered `200` with the
 * app shell. Nothing leaks (the shell is `no-store` and carries no data) but the office sees the app
 * appear in a print dialog instead of an error, which is a worse thing to debug than a 404.
 */
const NON_SPA_PREFIXES = ['/trpc', '/api', '/fabric', '/statements', '/sheets', '/invoices', '/healthz'];

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

  // Fabric admin commands /fabric/commands/run (0.50.0-dev.15): same gate, plus the platform-only
  // caller header. NOT a Fabric capability — `commands` is reserved precisely so no other app can
  // reach this handler through the broker.
  registerFabricCommands(app);

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

  /**
   * The web app manifest — what a phone reads when somebody adds this to their home screen (0.48.0).
   *
   * SERVED RATHER THAN STATIC, for one reason worth the route: the NAME. A parent's home screen should say
   * "Madani Academy", not "OpenMasjid Students" — they are adding their madrasah, not a piece of software
   * — and only the server knows what the masjid called itself. Everything else here could have been a file.
   *
   * THE ICON IS THE MASJID'S OWN LOGO when one is set, falling back to this app's logo — the full artwork
   * with STUDENTS on it — when it is not. Which icons are declared decides whether a phone will offer to
   * INSTALL the app at all, so that logic (and the measuring of the logo it depends on) lives in
   * `http/manifest.ts` where it is tested.
   *
   * Unauthenticated, like the logo route above: it carries the madrasah's public name and nothing else, and
   * a manifest that 401s is a manifest the phone ignores.
   */
  app.get('/manifest.webmanifest', async (_req, reply) => {
    // Re-validated by magic bytes on the way out, exactly as /api/logo does — the manifest declares a
    // `type`, and it must be one we have actually verified rather than what a settings row claims (§14).
    const logo = getSchoolLogo();
    return reply
      .header('content-type', 'application/manifest+json; charset=utf-8')
      .header('cache-control', 'public, max-age=300')
      .send(JSON.stringify(buildManifest({ schoolName: getSchoolName(), logo: logo ? parseLogoDataUri(logo) : null })));
  });

  /**
   * The service worker.
   *
   * A route only to control the CACHING. Everything else about it is in `packages/web/public/sw.js`, which
   * caches nothing of the app on purpose (see its header). `no-store` because the worker script is the one
   * file that must never be held: a stale worker is the thing that outlives an update, and this app already
   * shipped a shell-caching bug once (0.48.0-dev.24). Browsers revalidate it themselves, but saying so
   * costs a line and removes the question.
   */
  app.get('/sw.js', async (_req, reply) => {
    const file = path.join(config.publicDir || '', 'sw.js');
    if (!config.publicDir || !fs.existsSync(file)) return reply.code(404).send({ error: 'no_sw' });
    return reply
      .header('content-type', 'text/javascript; charset=utf-8')
      .header('cache-control', 'no-store, must-revalidate')
      // Belt and braces: a worker served from here may only ever control this app's own paths. `${BASE}/`
      // is "/" at the root and "/students/" behind the tunnel, which is the scope registerSW.ts asks for.
      .header('service-worker-allowed', `${BASE}/`)
      .send(fs.readFileSync(file, 'utf8'));
  });

  /**
   * The iOS home-screen icon (0.48.0).
   *
   * A ROUTE rather than the static file, because iOS reads NONE of the manifest's icons — `apple-touch-icon`
   * is the only one Safari looks at — so the masjid's logo can only reach an iPhone through this. It cannot
   * be done by rewriting index.html either: that is read once at boot, and a logo uploaded afterwards would
   * never appear.
   *
   * PNG and JPEG only. Safari has not reliably taken a WebP touch icon, and the bundled mark is a better
   * outcome than a home screen showing a screenshot of the page. Registered before the static plugin, so it
   * takes precedence over the file of the same name — which is exactly what it falls back to.
   */
  app.get('/apple-touch-icon.png', async (_req, reply) => {
    const logo = getSchoolLogo();
    const parsed = logo ? parseLogoDataUri(logo) : null;
    if (parsed && parsed.mime !== 'image/webp') {
      return reply
        .header('content-type', parsed.mime)
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'public, max-age=300')
        .send(parsed.bytes);
    }
    const bundled = path.join(config.publicDir, 'apple-touch-icon.png');
    if (!config.publicDir || !fs.existsSync(bundled)) return reply.code(404).send({ error: 'no_icon' });
    return reply.header('content-type', 'image/png').header('cache-control', 'public, max-age=300').send(fs.readFileSync(bundled));
  });

  // Same-origin appearance relay (CLAUDE.md §15). The parent portal + staff surfaces INHERIT the OS
  // dashboard's wallpaper + light/dark. The OS exposes GET /api/public/appearance (theme/wallpaper/
  // accent), but a browser can't fetch it directly: on the LAN it's a different origin + plain HTTP
  // (mixed content from our HTTPS page), and it isn't our origin over the tunnel. So the browser polls
  // US (same origin) and we fetch the platform server-to-server. No secrets, and open like the logo route:
  // it carries a theme, not data about anybody.
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
    /**
     * `nosniff` and `no-referrer` alongside the cache directive (0.48.0).
     *
     * The shell had neither. `nosniff` costs nothing and removes a whole class of content-type confusion.
     * `no-referrer` is the one that matters here: the invite, reset and register pages carry a
     * single-use TOKEN in the query string, and the portal's pay page loads Stripe's script from another
     * origin. Modern browsers default to `strict-origin-when-cross-origin`, which strips the path — but
     * that is a default, not a promise, and older webviews (which is what a parent's phone may be) still
     * send the full URL on a same-protocol cross-origin request. A token in someone else's logs cannot be
     * un-leaked, so the header is stated rather than assumed.
     *
     * Deliberately NOT `X-Frame-Options`/`frame-ancestors` here: whether OpenMasjidOS embeds an app in
     * its dashboard is the platform's business, and guessing wrong would break the whole UI rather than
     * one page. The printed documents, which are ours alone, do set `frame-ancestors 'none'`.
     */
    const sendIndex = (_req: unknown, reply: import('fastify').FastifyReply) =>
      reply
        .type('text/html')
        .header('cache-control', 'no-store, must-revalidate')
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer')
        .send(rawIndex);
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
