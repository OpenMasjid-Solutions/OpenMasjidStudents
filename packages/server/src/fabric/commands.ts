// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Admin commands over WhatsApp — `POST /fabric/commands/run` (0.50.0-dev.15).
 *
 * An authorised admin messages the masjid's own WhatsApp number with `!students` and OpenMasjidOS runs
 * one of the commands declared in our `manifest.yaml`. **The platform owns everything except the
 * doing**: who may run what, the numbered menu, the confirmation step, the formatting. We are handed
 * one command id and asked to answer in plain text.
 *
 * WHAT WE DECLARE, AND WHY IT IS ONLY THIS. One command, `stats` — a read. Two rules shaped that:
 *
 *   1. **The reply lands in a chat that keeps a copy forever**, on whichever phone is authorised
 *      today. It is the platform's own stated reason for refusing to expose app logs, and it applies
 *      just as much to a roster of families who are behind. So the answer is counts and totals
 *      (`billing/stats.ts` enforces that end) and never a list of who.
 *   2. **Nothing here writes.** A command that moved money would need `confirm: true` and would still
 *      be the wrong shape for this channel — see the follow-up note below, and §14: a WhatsApp number
 *      can be banned overnight, so nothing important may depend on one.
 *
 * SECURITY (§11.1's rules, same as the billing provider — the guard is deliberately the same shape):
 *   • tunnel origin gets 404 before anything else, so this is LAN-only twice over (the OS does not
 *     route `/fabric/*` through the tunnel either);
 *   • our OWN `OPENMASJID_APP_SECRET`, constant-time compared — the platform proves the call is
 *     genuine by presenting the secret only it and we know;
 *   • `X-OpenMasjid-Caller-App` must be exactly `omos:platform`. That value can never be an app id,
 *     because the colon is outside the charset every app id is validated against — so it identifies
 *     the platform by construction rather than by convention. Checking it matters: without it, any
 *     OTHER app holding a broker path to us could reach this handler, which is why the platform makes
 *     `commands` a reserved capability that cannot appear in `fabric.provides`.
 *
 * ON FOLLOW-UP QUESTIONS (platform 0.51.0-dev.11). A reply may carry `followUp.token` and the sender's
 * next message comes back to us as an answer, so a multi-step flow need not make an admin prefix every
 * line with `!`. We use none, and `stats` could not want one — but the reason to be careful is written
 * here because the next command might: **the exchange can end without us and with no notification** —
 * three minutes idle, fifteen total, twelve turns, the sender typing exit/cancel/done, or starting any
 * new `!`. For an app that moves money that is not a nicety. A flow like "record a payment → which
 * student? → how much?" that wrote a row at step two and then went silent would leave money attributed
 * to nobody, and a payment is immutable once written (§9). Apply on the last answer, or keep a draft
 * with its own expiry.
 *
 * THE BUDGET: 10 seconds and 16 KB, because a volunteer is holding a phone. `tuitionStats` is a
 * handful of aggregate queries against SQLite on the same box; anything that could not promise that
 * would have to start work and say so rather than block.
 */

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { classifyOrigin } from '../security/origin';
import { formatMoney } from '../db/money';
import { tuitionStats } from '../billing/stats';
import { getSchoolName } from '../settings';
import { hasAnyUser } from '../auth/firstRun';
import { formatDate } from '../settings/dates';
import { MONTH_NAMES } from '../billing/period';
import { audit } from '../audit';
import { makeLog } from '../logger';

const log = makeLog('commands');

/** The one value the platform ever sends as its identity. Never an app id — the colon cannot be one. */
const PLATFORM_CALLER = 'omos:platform';

/** The platform trims and caps our answer anyway; staying inside it keeps the message ours. */
const MAX_TEXT = 1000;

function secretOk(provided: string | undefined): boolean {
  const secret = config.omosAppSecret;
  if (!secret || !provided) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const Body = z.object({
  command: z.string().trim().min(1).max(64),
  /** Present only for a command that declared an `argument`. Ours does not, so it is ignored. */
  text: z.string().max(1000).optional(),
  /** The platform's own id for this run; logged, never echoed to a person. */
  requestId: z.string().max(128).optional(),
  locale: z.string().max(16).optional(),
  /** Set when a reply of ours asked a follow-up question. We never ask one, so it should never arrive. */
  followUpToken: z.string().max(128).optional(),
});

/**
 * The `stats` answer.
 *
 * Written to be read on a phone, in the app's own voice (§15: the treasurer is a volunteer, not an
 * accountant). Blank lines group it, because the platform collapses runs of them but keeps single
 * ones — so this survives its own formatting rules.
 *
 * Every line is a total or a count. That is the invariant, not a style choice: see the module header.
 */
export function statsMessage(asOf: string): string {
  const s = tuitionStats(asOf);
  const money = (c: number) => formatMoney(c, s.currency);
  const month = MONTH_NAMES[Number(s.periodKey.slice(5, 7)) - 1] ?? s.periodKey;

  const lines = [
    `${getSchoolName()} — tuition, ${formatDate(s.asOf)}`,
    '',
    `In this month: ${money(s.collectedThisMonthCents)} from ${s.paymentsThisMonth} ${s.paymentsThisMonth === 1 ? 'payment' : 'payments'}`,
    `Billed for ${month}: ${money(s.billedThisPeriodCents)}`,
    '',
    `Outstanding: ${money(s.outstandingCents)}`,
  ];
  // Only when there is one. A line reading "Paid ahead: $0.00" every day teaches an admin to skim.
  if (s.creditCents > 0) lines.push(`Paid ahead: ${money(s.creditCents)}`);
  lines.push(
    s.pastDueStudents === 0
      ? 'Past due: nobody'
      : `Past due: ${s.pastDueStudents} ${s.pastDueStudents === 1 ? 'student' : 'students'}, ${money(s.pastDueCents)}`,
  );
  lines.push(
    '',
    `Students: ${s.activeStudents} active in ${s.households} ${s.households === 1 ? 'household' : 'households'}`,
    `Autopay: ${s.autopayHouseholds} ${s.autopayHouseholds === 1 ? 'household' : 'households'}`,
  );
  // Worth a line only when it can be wrong: a reconciliation that has never run is the state that
  // silently loses a kiosk payment, and one that ran days ago says the scheduler has stopped.
  lines.push(s.lastReconcileAt ? `Checked with Stripe: ${formatDate(s.lastReconcileAt.slice(0, 10))}` : 'Checked with Stripe: not yet');

  // Names are the one thing this must not carry, so say where they are instead.
  if (s.pastDueStudents > 0) lines.push('', 'Open the app to see who is behind.');

  return lines.join('\n').slice(0, MAX_TEXT);
}

export function registerFabricCommands(app: FastifyInstance): void {
  app.post('/fabric/commands/run', async (req, reply) => {
    // Tunnel first, before the secret is even looked at — the same order the billing provider uses, so
    // a remote caller learns nothing about whether this route exists.
    if (classifyOrigin(req) === 'tunnel') return reply.code(404).send({ ok: false, code: 'unknown_command' });

    const presented = req.headers['x-openmasjid-app-secret'];
    if (!secretOk(Array.isArray(presented) ? presented[0] : presented)) {
      return reply.code(401).send({ ok: false, error: 'Invalid app secret.' });
    }
    const caller = req.headers['x-openmasjid-caller-app'];
    if ((Array.isArray(caller) ? caller[0] : caller) !== PLATFORM_CALLER) {
      // A real app id can never equal `omos:platform`, so this is another app reaching for a handler
      // that is not a Fabric capability. 403, not 404: it is an authorisation answer.
      return reply.code(403).send({ ok: false, error: 'Only OpenMasjidOS may run commands.' });
    }

    const parsed = Body.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'That request could not be read.' });
    const { command, requestId } = parsed.data;

    // Nothing works before an admin has set the school up — there are no students, no currency and no
    // school name to answer with, and "0 students, $0.00" would read as a broken install rather than an
    // unfinished one. 503 is the platform's "still starting" answer and is the closest true thing.
    if (!hasAnyUser()) {
      return reply.code(503).send({ ok: false, code: 'not_ready', error: 'This madrasah’s tuition app has not been set up yet.' });
    }

    if (command !== 'stats') {
      // Everything the manifest does not declare. The platform re-checks its own list before calling,
      // so this is the belt to that braces — and it must be the documented shape, or the admin gets
      // "something went wrong" instead of "no such command".
      return reply.code(404).send({ ok: false, code: 'unknown_command' });
    }

    try {
      const today = new Date().toISOString().slice(0, 10);
      const text = statsMessage(today);
      // The reply itself is never logged — it is a financial summary, and a log is the copy that
      // outlives the conversation (§14). Ids and the outcome only.
      log.info('command run', { command, requestId: requestId ?? null, chars: text.length });
      // An audit row, because "who asked the server for the numbers, and when" belongs in the trail
      // even though nothing changed. The platform is the actor: it will not tell us which phone it
      // was, deliberately, and inventing a name would be worse than naming the channel.
      audit({ userId: null, role: 'fabric', name: 'WhatsApp command' }, 'command.run', { entity: 'settings', detail: { command } });
      return reply.send({ ok: true, text });
    } catch (e) {
      log.warn('command failed', { command, error: (e as Error).message });
      // A sentence a person can act on, never the exception (§15) — this one is read off a phone.
      return reply.send({ ok: false, error: 'The numbers could not be worked out just now. Try again in a moment.' });
    }
  });
}
