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
    return reply.header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-store').send(html);
  });
}
