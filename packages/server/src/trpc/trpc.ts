// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * tRPC init, request context, and the role + origin middleware (CLAUDE.md §5, §12.4).
 * EVERY authenticated procedure is built from `requireAuth`, which enforces BOTH the
 * required role AND the access-origin policy (admin = LAN only) — server-side, never
 * only in the UI. Per-procedure origin overrides are forbidden (add a role-scoped
 * procedure below instead of hand-rolling checks).
 */
import { initTRPC, TRPCError } from '@trpc/server';
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';
import { eq } from 'drizzle-orm';
import { classifyOrigin, isHttpsRequest, roleAllowedFromOrigin, type Origin } from '../security/origin';
import { getSession, touchSession, COOKIE } from '../auth/sessions';
import { db } from '../db';
import { users, type Role, type Session } from '../db/schema';

export function createContext({ req, res }: CreateFastifyContextOptions) {
  const origin: Origin = classifyOrigin(req);
  const token = req.cookies?.[COOKIE];
  const session = getSession(token);
  return { req, res, origin, https: isHttpsRequest(req), token, session };
}
export type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
export const middleware = t.middleware;

/** Build a middleware that requires a live session, an allowed role, and a permitted
 *  origin. `allowed = 'any'` means any authenticated role. */
function requireAuth(allowed: readonly Role[] | 'any') {
  return middleware(({ ctx, next }) => {
    const session = ctx.session;
    if (!session) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Please sign in.' });

    // Origin policy at session-USE time (not just at login): a LAN-minted admin cookie
    // presented over the tunnel is refused (§12.4).
    if (!roleAllowedFromOrigin(session.role, ctx.origin)) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Admin access only works on the masjid network.',
      });
    }

    if (allowed !== 'any' && !allowed.includes(session.role)) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'You don’t have access to that.' });
    }

    if (ctx.token) touchSession(ctx.token);
    return next({ ctx: { ...ctx, session: session as Session, user: session } });
  });
}

export const protectedProcedure = t.procedure.use(requireAuth('any'));
export const adminProcedure = t.procedure.use(requireAuth(['admin']));
export const financeProcedure = t.procedure.use(requireAuth(['finance']));
export const parentProcedure = t.procedure.use(requireAuth(['parent']));
/** Directory + billing reads/writes that finance shares with admin (§5). */
export const adminOrFinanceProcedure = t.procedure.use(requireAuth(['admin', 'finance']));

/** The audit actor for the current session (§14) — SSO admins have no user row. */
export function auditActor(ctx: Context): { userId: string | null; role: string; name: string | null } {
  return {
    userId: ctx.session?.userId ?? null,
    role: ctx.session?.role ?? 'unknown',
    name: ctx.session?.username ?? null,
  };
}

/**
 * Who to NAME on a money row — `payments.recorded_by_name` (§9).
 *
 * Deliberately NOT `auditActor`. The audit log wants the account identity, which is the username: it
 * is unique, it is what an admin disables, and it is the right thing for a forensic trail. A payment
 * row is read by the OFFICE, asking "who took this cash?", and the useful answer is the person's name
 * — which staff accounts are created with (Staff → Name). So: the display name when there is one, the
 * username when there isn't.
 *
 * An OpenMasjidOS SSO session has no local account, so there is no name of ours to use and it is
 * recorded as plain "Admin". The platform does send a username, but it is untrusted display text from
 * another system (§12) and this value is stored forever on an immutable money row.
 */
export function recordingActor(ctx: Context): { userId: string | null; role: string; name: string | null } {
  const base = auditActor(ctx);
  if (!ctx.session) return base;
  if (ctx.session.source === 'sso') return { ...base, name: 'Admin' };
  if (!base.userId) return base;
  const row = db.select({ displayName: users.displayName, username: users.username }).from(users).where(eq(users.id, base.userId)).get();
  return { ...base, name: row?.displayName?.trim() || row?.username || base.name };
}
