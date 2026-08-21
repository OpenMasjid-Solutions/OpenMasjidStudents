// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * WhatsApp (0.50.0) — the ONE place that decides whether a message goes out, and to whom.
 *
 * The same shape as alerts/index.ts, for the same reason: a channel with several call sites and
 * several switches becomes a channel where one caller forgets one switch, and here that mistake
 * messages two hundred families. So every send in the app funnels through `notifyFamily` or
 * `notifyStaff`, and neither of them trusts its caller to have checked anything.
 *
 * ── HOW A MESSAGE IS SENT ────────────────────────────────────────────────────
 * We never touch the gateway. OpenMasjidOS owns the WhatsApp connection (a self-hosted OpenWA
 * install, linked to the masjid's own phone) and runs ONE paced queue shared by every app on the
 * server — randomized gaps, typing indicators, per-recipient cooldowns, rolling hourly and daily
 * caps. That queue is the entire defense for a number WhatsApp does not officially permit and can
 * restrict at any time, and it only works because nothing goes around it. Two things follow, and they
 * are design constraints rather than cautions:
 *
 *   • **`queued` is not `sent`.** Delivery is seconds to minutes away, longer once the hour's or the
 *     day's allowance is spent. Nothing blocks on a send and no flow waits for one to arrive. Since
 *     0.51.0 the log can at least SAY what happened afterwards — see `refreshWhatsappOutcomes`.
 *   • **The allowance belongs to the NUMBER, not to us.** Every other installed app draws on the same
 *     daily cap, so nothing here is designed as a broadcast. One recipient per call, always.
 *
 * **THERE ARE NO QUIET HOURS** (platform 0.51.1). There were, 21:00–07:00, and they applied to every
 * message on the shared queue — including staff alerts, which is the one case where waiting until
 * morning defeats the purpose: a declined card at nine on a Sunday reaches a treasurer's phone
 * precisely because it will not reach their inbox. They were also half of a real outage. The window
 * was evaluated in UTC while the masjid was not, so every evening message was held; the queue was
 * memory-only, so each container restart destroyed the backlog. Accepted, logged as queued, delivered
 * never. The platform removed the window and made the queue durable. A message now goes out when the
 * pacing lets it, whatever the hour.
 *
 * ── WHAT NEVER GOES BY WHATSAPP ──────────────────────────────────────────────
 * Nothing auth-critical: no invite links, no password resets, no verification codes, no one-time
 * anything. Those go by EMAIL, which has a real provider behind it. A WhatsApp number can be banned
 * overnight, and the day it is must not be the day nobody can get into their account.
 *
 * ── THE GATES, IN ORDER ──────────────────────────────────────────────────────
 * The first three are global and are checked ONCE per event, before any recipient is looked at —
 * otherwise a switch that is off would write two hundred "skipped" rows every time an invoice run
 * finishes. The rest are per person.
 *
 *   1. the master switch (off until an admin turns the feature on)
 *   2. the gateway says it can send (`ready`)
 *   3. this event is switched on
 *   4. the parent pause — which NARROWS the recipients to the test student's household rather than
 *      stopping the send, because that is exactly what the test student is for
 *   5. this person has not opted out            ← never overridden, by anything
 *   6. their number can be read as E.164
 *
 * Message BODIES are never logged and never stored (§14): they routinely carry a child's name and a
 * family's fees. The log holds the event, an id, the time and the outcome.
 */
import { and, eq, gte, inArray, isNotNull, lt } from 'drizzle-orm';
import { db } from '../db';
import { families, guardians, guardianFamilies, students, users, whatsappLog } from '../db/schema';
import { rid } from '../db/ids';
import { getCurrency, getSchoolName, getWhatsApp } from '../settings';
import { pausedFor, testFamilyId } from '../settings/testStudent';
import { fabricConfigured } from '../config';
import { sendPlatformWhatsApp, sendPlatformWhatsAppGroup, whatsappGroups, whatsappMessageStatus, whatsappStatus, type WhatsAppGroupList, type WhatsAppStatus } from '../fabric/platform';
import { toE164 } from './numbers';
import { renderText, waStaffAlert, type WaTextKey, type WaVars } from './templates';
import { familyBalance } from '../billing/ledger';
import { formatMoney } from '../db/money';
import { givenName } from '../people/names';
import { portalBase } from '../auth/invites';
import { makeLog } from '../logger';

/** Ids and counts only — never a number, never a body (§14). */
const log = makeLog('whatsapp');

/**
 * The parent-facing events an office can switch on.
 *
 * SEVEN, and every one of them exists on EMAIL as well (0.50.0-dev.5). The first three were simply
 * the messages the app already sent; the other four were the gaps a madrasah notices as soon as it
 * starts using this — a bill nobody was told about, a card charge that arrived unannounced, a card
 * that expired and quietly broke autopay, and money going back with no confirmation.
 *
 * They are added to BOTH channels rather than to WhatsApp alone, deliberately. Email is the reliable
 * channel and the one a household with no phone number still has; a notification type that existed
 * only on WhatsApp would be one those families could never receive. Each has its own switch on each
 * channel, and every one of them defaults OFF — a madrasah that updates on a Tuesday must not start
 * messaging two hundred families on the Wednesday because we added a feature.
 *
 * Volume was the deciding factor in what is NOT here. The sending allowance belongs to the masjid's
 * number and is shared with every other app, so each of these had to earn its place: `invoice-ready`
 * and `autopay-upcoming` are once a month, `card-expiring` is once a year per card, and the rest are
 * per event and rare. A "your balance changed" message would have been none of those things.
 *
 * Ids are stored in the settings row, so renaming one silently switches it off. Add, don't rename.
 */
export const WA_PARENT_EVENTS = ['invoice-ready', 'receipt', 'past-due', 'autopay-upcoming', 'autopay-failed', 'card-expiring', 'payment-refunded'] as const;
export type WaParentEvent = (typeof WA_PARENT_EVENTS)[number];

export function isParentEvent(v: unknown): v is WaParentEvent {
  return typeof v === 'string' && (WA_PARENT_EVENTS as readonly string[]).includes(v);
}

/**
 * Would this event message anybody if it fired right now? (The master switch and the toggle — not the
 * gateway, which needs a network call.)
 *
 * Exported for exactly one caller: the past-due job, which decides whether to walk the overdue list at
 * all. Chasing was gated solely on the EMAIL switch, so a madrasah that wanted reminders by WhatsApp
 * only would have had a job that never ran and a screen that said nothing was overdue.
 */
export function parentEventOn(event: WaParentEvent): boolean {
  const cfg = getWhatsApp();
  return cfg.enabled && fabricConfigured() && !!cfg.events[event];
}

// ── Is the gateway there? ────────────────────────────────────────────────────
/**
 * Cached, because a send must not pay for a status round-trip and because a settings screen asks for
 * it on every render. Refreshed by the scheduler and by the Settings screen's own button.
 *
 * A missing cache is NOT treated as "available": an app that has never successfully asked must not
 * start sending on the assumption that it can.
 */
let statusCache: { at: number; status: WhatsAppStatus } | null = null;
const STATUS_TTL_MS = 5 * 60_000;

export async function refreshWhatsAppStatus(): Promise<WhatsAppStatus> {
  const status = await whatsappStatus();
  statusCache = { at: Date.now(), status };
  return status;
}

/** The last known status, refreshing it when the cache is cold or stale. */
export async function currentWhatsAppStatus(): Promise<WhatsAppStatus> {
  if (statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.status;
  return refreshWhatsAppStatus();
}

/** For a synchronous caller (a settings read that must not block). Null = we have never asked. */
export function cachedWhatsAppStatus(): WhatsAppStatus | null {
  return statusCache?.status ?? null;
}

/** Only used by tests and by an account switch — never in normal operation. */
export function resetWhatsAppStatusCache(): void {
  statusCache = null;
}

/**
 * The groups this app may post into — a confirmed list, or a reason we could not get one.
 *
 * Not cached: approval is the admin's to withdraw at any moment, this is only ever read by an admin
 * settings screen, and a stale "yes you may" is the one answer worth paying a network hop to avoid.
 *
 * The switch being off is `ok: true` with nothing in it, not a failure: we know the answer without
 * asking, and it is "none". That distinction is the whole point of the type — see `WhatsAppGroupList`.
 */
export async function approvedGroups(): Promise<WhatsAppGroupList> {
  if (!getWhatsApp().enabled) return { ok: true, groups: [] };
  if (!fabricConfigured()) return { ok: false, reason: 'no_platform' };
  return whatsappGroups();
}

/**
 * Is this id one the admin has approved RIGHT NOW? The one place that question is answered.
 *
 * It was answered in three places that disagreed: `groupSet` checked, `testGroup` did not, and the
 * send path did not either. Two of those were defensible on their own — the platform refuses an
 * unapproved id with 403 before it queues anything, so nothing could actually leak — but "the rule
 * lives in one place" is what stops the next caller getting it wrong, and a check that exists in one
 * of three sibling functions reads like an oversight in the other two (CLAUDE.md §20).
 *
 * `null` means we could not ask. Callers must not read that as "no" and must not read it as "yes":
 * `groupSet` refuses with a different sentence, because telling an admin their group is unapproved
 * when the truth is that OpenMasjidOS did not answer sends them to fix the wrong thing.
 */
export async function groupIsApproved(groupId: string): Promise<boolean | null> {
  const list = await approvedGroups();
  if (!list.ok) return null;
  return list.groups.some((g) => g.id === groupId);
}

// ── The log ─────────────────────────────────────────────────────────────────
interface LogRow {
  event: string;
  /** `group` is an announcement — see `announceToGroup` for why it is a path of its own. */
  recipientKind: 'guardian' | 'staff' | 'group';
  recipientId: string;
  familyId?: string | null;
  status: 'queued' | 'failed' | 'skipped';
  reason?: string | null;
  /** The platform's own message id, when it gave us one (0.51.0) — the handle for asking what
   *  became of it. Only ever present on a `queued` row; a skip never reached the platform. */
  platformId?: string | null;
}

function writeLog(row: LogRow): void {
  db.insert(whatsappLog)
    .values({
      id: rid('wal'),
      event: row.event,
      recipientKind: row.recipientKind,
      recipientId: row.recipientId,
      familyId: row.familyId ?? null,
      status: row.status,
      reason: row.reason ?? null,
      platformId: row.platformId ?? null,
      createdAt: new Date(),
    })
    .run();
}

// ── Volume: OURS to bound now (0.51.0-dev.5) ────────────────────────────────
/**
 * HOW MANY PARENT MESSAGES THIS APP WILL SEND, per hour and per day.
 *
 * **The platform used to refuse to send too much, and as of 0.51.1 it does not.** Quiet hours, the
 * hourly and daily caps, the per-recipient cooldown, the group cooldown, the warm-up ramp and the
 * random 6–20s gap are all gone; a typing indicator is the only pause left. Every message handed over
 * now goes out within seconds. That was the right call for the platform — its pacing was causing
 * head-of-line blocking across every app — but it moves the whole of this responsibility here, and
 * this app is exactly the shape that gets a number banned if nobody is holding it: an invoice run
 * loops EVERY household (`billing/invoices.ts`), and so does the past-due chase.
 *
 * Two hundred messages to two hundred numbers in one burst, from a client WhatsApp does not permit,
 * is how a masjid loses the number their parents are reachable on — permanently, with no appeal.
 *
 * THE DEFAULTS ARE THE PLATFORM'S OLD ONES (12/hour, 60/day) and that is deliberate rather than lazy:
 * they were its considered judgment about what a linked number tolerates, and inheriting them means
 * removing the platform's cap changes nothing about what this app actually sends until an office
 * decides otherwise. They are low for a 200-family roster, and that is the honest shape of WhatsApp as
 * a channel rather than a limitation to design around.
 *
 * WHAT A CAPPED MESSAGE COSTS IS SMALL, and it is the reason a hard cap is safe here: every parent
 * event exists on EMAIL too and defaults there (§9). A message we decline to send is a notice that
 * arrived by email and not also by WhatsApp — a degraded nicety, not a lost notification.
 *
 * WHAT IS NOT CAPPED, and why:
 *   • **Staff alerts and group alerts.** A handful of recipients, and a declined card must never be
 *     dropped because an invoice run spent the budget first. Starving the alert channel to protect the
 *     bulk channel would be exactly the wrong way round.
 *   • **A test send, and the missing-email outreach.** Both are a person pressing a button, and the
 *     outreach is already bounded at 50 per press with the screen saying so. They COUNT toward the
 *     budget — they are real traffic on the number — but they are not refused, because a control whose
 *     entire purpose is to prove the channel works must not be silently disabled by a quota.
 */
export const WA_CAP_DEFAULTS = { hourly: 12, daily: 60 } as const;

/**
 * How many parent messages we have handed over inside `windowMs`.
 *
 * Counted from `whatsapp_log`, which already records every send with a timestamp — so the log IS the
 * rate-limit ledger and there is no second place for the two to disagree. It also means the budget
 * survives a restart for free, which an in-memory counter would not: the platform's own outage last
 * week was half caused by pacing state that a container restart threw away.
 *
 * `skipped` rows do not count. Nothing was sent, so nothing was spent.
 */
function parentSendsSince(windowMs: number): number {
  const since = new Date(Date.now() - windowMs);
  return db
    .select({ id: whatsappLog.id })
    .from(whatsappLog)
    .where(and(eq(whatsappLog.recipientKind, 'guardian'), inArray(whatsappLog.status, ['queued', 'sent', 'expired']), gte(whatsappLog.createdAt, since)))
    .all().length;
}

/** Which budget, if either, is spent right now. Exported so the settings screen can say so — a cap
 *  that silently stops an invoice run is another invisible failure, which is the whole thing we have
 *  been digging out of. */
export function capState(): { blocked: 'hour' | 'day' | null; hourUsed: number; dayUsed: number; hourly: number; daily: number } {
  const cfg = getWhatsApp();
  const hourly = cfg.hourlyCap ?? WA_CAP_DEFAULTS.hourly;
  const daily = cfg.dailyCap ?? WA_CAP_DEFAULTS.daily;
  const hourUsed = parentSendsSince(3_600_000);
  const dayUsed = parentSendsSince(86_400_000);
  // Day first: it is the one an office should act on, and reporting "the hour is full" when the day is
  // also full sends them to wait an hour for nothing.
  const blocked = dayUsed >= daily ? 'day' : hourUsed >= hourly ? 'hour' : null;
  return { blocked, hourUsed, dayUsed, hourly, daily };
}

/**
 * Ask the platform what became of the messages still sitting at `queued` (0.51.0).
 *
 * WHY THIS EXISTS. `queued` used to be the last thing this app could ever say, and a masjid then hit
 * the failure that design cannot explain: every send accepted, nothing delivered for over a day, no
 * error anywhere. Our log said "queued" with total confidence and there was nothing in the world to
 * contradict it. OpenMasjidOS 0.51.1 reports outcomes, so the log can finally finish its sentences.
 *
 * FOUR RULES, each of them load-bearing:
 *
 *  1. **Only rows we have a handle for.** No `platform_id` means an older platform or a `skipped` row,
 *     and those stay `queued` for good — which is honest, because we still do not know.
 *  2. **Oldest first, and bounded per pass.** Oldest because those are the rows nearest the end of the
 *     platform's retention, and bounded so a backlog cannot turn one tick into a flood.
 *
 *     The numbers were relaxed in 0.51.0-dev.6, when the platform fixed two things it had told us
 *     wrongly: the outcome history is **500 per app for 24 hours**, not 200 shared across every app
 *     (a 200-family invoice run used to evict every other app's records AND our own oldest, which are
 *     the ones most likely to have failed), and **reads no longer count against the send budget** —
 *     they have their own 600/minute ceiling, so a polling burst can no longer refuse a message. A
 *     day of this app's traffic is capped at 60 parent messages, so it now fits inside 500 several
 *     times over and there is nothing to race.
 *  3. **`unknown` settles the row, and does not retry.** A 404 is "past the end of that buffer, or
 *     never ours" — a permanent answer. Left as `queued` it would be re-asked every five minutes for
 *     as long as the row lives.
 *  4. **Anything else leaves the row alone.** An unreachable platform must never be written down as a
 *     delivery failure; the next pass asks again.
 *
 * Best-effort throughout. Nothing waits on this and no send is retried because of it.
 */
export async function refreshWhatsappOutcomes(limit = 100): Promise<{ checked: number; settled: number }> {
  if (!fabricConfigured() || !getWhatsApp().enabled) return { checked: 0, settled: 0 };
  // Cheap guard against asking an older platform 40 times per tick for a route it does not have.
  const status = await currentWhatsAppStatus();
  if (!status.outcomes) return { checked: 0, settled: 0 };

  const pending = db
    .select({ id: whatsappLog.id, platformId: whatsappLog.platformId })
    .from(whatsappLog)
    .where(and(eq(whatsappLog.status, 'queued'), isNotNull(whatsappLog.platformId)))
    .orderBy(whatsappLog.createdAt)
    .limit(limit)
    .all();

  let settled = 0;
  for (const row of pending) {
    if (!row.platformId) continue;
    const got = await whatsappMessageStatus(row.platformId);
    if (!got.ok) {
      if (!got.unknown) continue; // transient — ask again next pass
      // The platform can no longer say. Record that rather than asking for ever.
      db.update(whatsappLog).set({ status: 'failed', reason: 'outcome_unknown' }).where(eq(whatsappLog.id, row.id)).run();
      settled++;
      continue;
    }
    if (got.state === 'queued') continue; // genuinely still waiting its turn in the pacing
    db.update(whatsappLog)
      .set({ status: got.state === 'sent' ? 'sent' : got.state === 'expired' ? 'expired' : 'failed', reason: got.reason })
      .where(eq(whatsappLog.id, row.id))
      .run();
    settled++;
  }
  if (settled) log.info('whatsapp outcomes settled', { checked: pending.length, settled });
  return { checked: pending.length, settled };
}

/** Drop rows older than `days`. Called from the scheduler — this is an operational trail, not a
 *  record anybody bills from, and an install that has run for years should not carry every line. */
export function pruneWhatsappLog(days = 120): number {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  return db.delete(whatsappLog).where(lt(whatsappLog.createdAt, cutoff)).run().changes;
}

// ── Who can be messaged ─────────────────────────────────────────────────────
export interface WaRecipient {
  guardianId: string;
  name: string;
  familyId: string;
  /** The E.164 form, or null when the stored number can't be read (numbers.ts). */
  to: string | null;
  /** Do we also have an address for this person? Decides whether the message points at their email. */
  hasEmail: boolean;
  optedOut: boolean;
}

/** Every guardian on a household, with the two facts that decide whether they can be messaged. */
export function familyRecipients(familyId: string): WaRecipient[] {
  const country = getWhatsApp().defaultCountry;
  return db
    .select({
      id: guardians.id,
      name: guardians.name,
      phone: guardians.phone,
      phoneCountry: guardians.phoneCountry,
      email: guardians.email,
      optOut: guardians.waOptOut,
    })
    .from(guardianFamilies)
    .innerJoin(guardians, eq(guardians.id, guardianFamilies.guardianId))
    .where(eq(guardianFamilies.familyId, familyId))
    .all()
    .map((g) => ({
      guardianId: g.id,
      name: g.name,
      familyId,
      to: toE164(g.phone, g.phoneCountry || country),
      hasEmail: (g.email ?? '').includes('@'),
      optedOut: !!g.optOut,
    }));
}

/**
 * Everything a message about this household can be filled in with.
 *
 * Assembled ONCE per household rather than per recipient — the household's name, its children and its
 * balance are the same for both parents; only the "check your email" line differs, and that is
 * decided at render time (`renderText`).
 *
 * `[balance]` is the DERIVED balance, like everywhere else in this app (§9): a figure that is computed
 * at the moment of sending cannot go stale against the ledger the way a stored one would.
 */
export function familyVars(familyId: string): WaVars {
  const fam = db.select({ name: families.name }).from(families).where(eq(families.id, familyId)).get();
  const kids = db
    .select({ fullName: students.fullName })
    .from(students)
    .where(and(eq(students.familyId, familyId), eq(students.status, 'active')))
    .orderBy(students.fullName)
    .all();
  const bal = familyBalance(familyId);
  return {
    family: fam?.name ?? 'your family',
    // First names only: this is a message to their own parent, and a household's own children do not
    // need surnames — "Yusuf and Maryam" is how the family says it (people/names.ts).
    children: kids.map((k) => givenName(k.fullName)).filter(Boolean),
    balance: formatMoney(Math.max(0, bal.owedCents), getCurrency()),
    // Empty when this install has no public address yet — a portal link that resolves to a LAN
    // address is worse than no link at all for a parent reading this at home.
    portal: portalBase() ? `${portalBase()}/family` : '',
  };
}

// ── Sending ─────────────────────────────────────────────────────────────────
export interface WaOutcome {
  queued: number;
  /** Every recipient we deliberately did not write to, by reason — what the office is shown. */
  skipped: Record<string, number>;
  /** Set when the whole event was stopped before any recipient was considered. */
  blocked?: 'off' | 'unavailable' | 'event_off';
}

const nothing = (blocked: WaOutcome['blocked']): WaOutcome => ({ queued: 0, skipped: {}, blocked });

function bump(o: WaOutcome, reason: string): void {
  o.skipped[reason] = (o.skipped[reason] ?? 0) + 1;
}

/**
 * The three global gates, checked once. Returns null when the event may proceed.
 *
 * `event: null` is the office pressing a button (the outreach, a test send) — there is no per-event
 * toggle for those, and the master switch plus the gateway are still checked.
 */
async function globalGate(event: WaParentEvent | null): Promise<WaOutcome['blocked'] | null> {
  const cfg = getWhatsApp();
  if (!cfg.enabled || !fabricConfigured()) return 'off';
  if (event && !cfg.events[event]) return 'event_off';
  const status = await currentWhatsAppStatus();
  if (!status.available) return 'unavailable';
  return null;
}

/** One message to one guardian, with the per-person gates. Never throws. */
async function queueGuardian(event: string, r: WaRecipient, text: string): Promise<boolean> {
  if (r.optedOut) {
    writeLog({ event, recipientKind: 'guardian', recipientId: r.guardianId, familyId: r.familyId, status: 'skipped', reason: 'opted_out' });
    return false;
  }
  if (!r.to) {
    writeLog({ event, recipientKind: 'guardian', recipientId: r.guardianId, familyId: r.familyId, status: 'skipped', reason: 'no_number' });
    return false;
  }
  const res = await sendPlatformWhatsApp(r.to, text);
  writeLog({
    event,
    recipientKind: 'guardian',
    recipientId: r.guardianId,
    familyId: r.familyId,
    status: res.queued ? 'queued' : 'failed',
    // The platform's own sentence when it refused, in preference to our status code: "That phone
    // number needs a country code" tells an office what to do and `http_400` does not.
    reason: res.queued ? (res.note ?? null) : (res.message ?? res.reason),
    platformId: res.queued ? (res.id ?? null) : null,
  });
  return res.queued;
}

/**
 * Message a household about one of the parent events.
 *
 * The TEXT is rendered here rather than handed in by the caller (0.50.0-dev.4). It has to be, now
 * that an office can rewrite the wording: the tags a template may use — the household's children, its
 * balance, the portal link — are facts about the household, and a caller in `mail/notify.ts` holds
 * none of them. Doing it here also means the "we've emailed you the details" line is decided per
 * RECIPIENT, which is the honest version: a household routinely has one parent with an address on
 * file and one without.
 *
 * `textKey` is separate from `event` because one event can have more than one message — an autopay
 * failure reads differently on the third strike, and an office rewriting one wants to rewrite the
 * other differently (whatsapp/templates.ts).
 *
 * Fire-and-forget from the caller's point of view: never throws, and a failure to message never fails
 * the payment, invoice or reminder that triggered it. Call sites use `void notifyFamily(...)`.
 */
export async function notifyFamily(event: WaParentEvent, familyId: string, textKey: WaTextKey, extra: Partial<WaVars> = {}): Promise<WaOutcome> {
  try {
    const blocked = await globalGate(event);
    if (blocked) return nothing(blocked);

    const out: WaOutcome = { queued: 0, skipped: {} };
    // The pause NARROWS rather than stops: the test student's household still hears everything, which
    // is the only way to try a real message without letting it reach a real roster.
    if (pausedFor(getWhatsApp().paused, familyId)) {
      // Deliberately unlogged and uncounted per household: a paused install would otherwise write a
      // row for every family on every event, and "we are paused" is a fact about the install, not
      // about any one of them.
      return { queued: 0, skipped: { paused: 1 } };
    }

    /**
     * OUR OWN VOLUME BOUND — checked per household, because the caller is a loop over the roster.
     *
     * The platform stopped capping anything in 0.51.1, so an invoice run for 200 families would hand
     * over 200 messages that all go out within seconds. See `WA_CAP_DEFAULTS` for why that is the way
     * a masjid loses its number, and why refusing is affordable: every parent event goes by email too,
     * so a capped message is a notice that arrived on one channel instead of two.
     *
     * Logged per household rather than swallowed. A cap that silently truncates an invoice run is the
     * same invisible-failure shape this app has just spent a release digging out of, and the settings
     * screen reads these rows.
     */
    const cap = capState();
    if (cap.blocked) {
      writeLog({ event, recipientKind: 'guardian', recipientId: familyId, familyId, status: 'skipped', reason: `cap_${cap.blocked}` });
      return { queued: 0, skipped: { [`cap_${cap.blocked}`]: 1 } };
    }

    const vars = { ...familyVars(familyId), ...extra };
    for (const r of familyRecipients(familyId)) {
      if (await queueGuardian(event, r, renderText(textKey, vars, { hasEmail: r.hasEmail }))) out.queued++;
      else bump(out, r.optedOut ? 'opted_out' : r.to ? 'failed' : 'no_number');
    }
    log.info('whatsapp family notify', { event, queued: out.queued });
    return out;
  } catch (e) {
    log.warn('whatsapp family notify failed', { event, error: (e as Error).message });
    return { queued: 0, skipped: { error: 1 } };
  }
}

/**
 * Message ONE guardian directly — the office pressing a button (the missing-email outreach, a test).
 *
 * Separate from `notifyFamily` because the gates genuinely differ: there is no per-event toggle for
 * something a person just asked for, and a skip here is worth a log row because somebody is standing
 * in front of a screen waiting to be told what happened.
 *
 * It still respects the pause and the opt-out. The pause because "do not write to anybody while I am
 * setting this up" has to mean that or it means nothing — and the test student is the way through it.
 * The opt-out because a person said no, and no button in an admin screen outranks that.
 */
export async function notifyGuardian(event: string, r: WaRecipient, text: string): Promise<'queued' | 'paused' | 'opted_out' | 'no_number' | 'failed'> {
  try {
    const blocked = await globalGate(null);
    if (blocked) return 'failed';
    if (pausedFor(getWhatsApp().paused, r.familyId)) {
      writeLog({ event, recipientKind: 'guardian', recipientId: r.guardianId, familyId: r.familyId, status: 'skipped', reason: 'paused' });
      return 'paused';
    }
    if (r.optedOut) {
      writeLog({ event, recipientKind: 'guardian', recipientId: r.guardianId, familyId: r.familyId, status: 'skipped', reason: 'opted_out' });
      return 'opted_out';
    }
    if (!r.to) {
      writeLog({ event, recipientKind: 'guardian', recipientId: r.guardianId, familyId: r.familyId, status: 'skipped', reason: 'no_number' });
      return 'no_number';
    }
    return (await queueGuardian(event, r, text)) ? 'queued' : 'failed';
  } catch (e) {
    log.warn('whatsapp guardian notify failed', { event, error: (e as Error).message });
    return 'failed';
  }
}

// ── Groups (0.50.0) ─────────────────────────────────────────────────────────
/**
 * STAFF ALERTS to a WhatsApp group the masjid's admin approved for this app — "the finance group gets
 * every payment alert".
 *
 * A GROUP IS A STAFF CHANNEL HERE, not a parent one, and that is the whole design. It is the same
 * audience as the office's alert inbox and the same audience as a staff member's own number: the
 * events are `ALERT_EVENTS` (alerts/index.ts), subscribed per group by an admin, and there is
 * deliberately no way to send a PARENT event or a free-typed message to a group. A family's receipt,
 * bill or balance is their own business and never an announcement — the platform's rule, and the
 * reason the two paths never meet in the type system: per-family sends call `sendPlatformWhatsApp`,
 * which cannot name a group, and this calls `sendPlatformWhatsAppGroup`, which cannot name a person.
 *
 * WHICH TEXT A GROUP GETS IS THE ADMIN'S CHOICE, and it defaults to the careful one. An alert carries
 * two (§9): `text`, which may name a household and an amount and is what makes it actionable, and
 * `publicText`, which names nobody. An admin approving a group and ticking these events is doing the
 * same deliberate thing as typing an address into the alert list — but this app cannot see who is IN
 * a group, and the wrong group is one mis-click away. So `detail` is off until somebody turns it on
 * in front of a sentence explaining it: the cost of that default being wrong is a vaguer message, and
 * the cost of the opposite is two hundred parents reading a family's balance.
 *
 * The PARENT PAUSE does not apply, exactly as it does not for a staff member's own number: it is a
 * switch about writing to families, and an office that paused parent messages while importing a
 * roster still wants to know when a card fails.
 */
export async function notifyGroups(event: string, msg: { title: string; text: string; publicText: string }): Promise<number> {
  try {
    const cfg = getWhatsApp();
    if (!cfg.enabled || !fabricConfigured()) return 0;
    const subscribed = Object.entries(cfg.groupAlerts).filter(([, g]) => g.events.includes(event));
    if (!subscribed.length) return 0;
    const status = await currentWhatsAppStatus();
    if (!status.available) return 0;

    let queued = 0;
    for (const [groupId, g] of subscribed) {
      // The same terse shape a staff number gets (whatsapp/templates.ts `waStaffAlert`): no greeting
      // and no school name. This is an operational notice to people who have to act on it, arriving
      // on the masjid's own number — the sender is already obvious and a salam is a line to scroll
      // past. `detail` is the only thing that varies.
      const body = waStaffAlert(msg.title, g.detail ? msg.text : msg.publicText);
      const res = await sendPlatformWhatsAppGroup(groupId, body);
      writeLog({ event, recipientKind: 'group', recipientId: groupId, status: res.queued ? 'queued' : 'failed', reason: res.queued ? (res.note ?? null) : res.reason, platformId: res.queued ? (res.id ?? null) : null });
      if (res.queued) queued++;
    }
    // Ids and counts only — never the alert text (§14).
    log.info('whatsapp group alerts', { event, groups: subscribed.length, queued });
    return queued;
  } catch (e) {
    log.warn('whatsapp group alert failed', { event, error: (e as Error).message });
    return 0;
  }
}

/**
 * "Does this group actually receive?" — the same question the per-recipient alert test answers.
 *
 * A FIXED test message rather than anything typed: this is not a composer, and a box that posts
 * arbitrary text to a parents group is exactly the misuse the design rules out. It ignores the event
 * subscriptions on purpose — an admin who has just approved a group wants to confirm the plumbing
 * before deciding what should flow through it.
 */
export async function testGroup(groupId: string): Promise<'queued' | 'off' | 'unavailable' | 'unapproved' | 'failed'> {
  try {
    const cfg = getWhatsApp();
    if (!cfg.enabled || !fabricConfigured()) return 'off';
    const status = await currentWhatsAppStatus();
    if (!status.available) return 'unavailable';
    // The same check `groupSet` makes, from the same helper. This used to be the one group path with
    // no approval check at all: harmless in effect (the platform 403s an unapproved id before it
    // queues anything) but it meant an admin-supplied id went out to the platform unexamined, and it
    // made the three group paths disagree about a rule that has exactly one answer.
    if ((await groupIsApproved(groupId)) === false) return 'unapproved';
    // Terse, like the alerts it is standing in for — and it must READ like one, or it is not a test of
    // anything. No salam, no letterhead.
    const res = await sendPlatformWhatsAppGroup(groupId, waStaffAlert('Test', 'Staff alerts will reach this group. No reply is needed.'));
    writeLog({ event: 'test', recipientKind: 'group', recipientId: groupId, status: res.queued ? 'queued' : 'failed', reason: res.queued ? (res.note ?? null) : res.reason, platformId: res.queued ? (res.id ?? null) : null });
    return res.queued ? 'queued' : 'failed';
  } catch (e) {
    log.warn('whatsapp group test failed', { error: (e as Error).message });
    return 'failed';
  }
}

// ── Staff ───────────────────────────────────────────────────────────────────
export interface WaStaffRecipient {
  userId: string;
  name: string;
  to: string | null;
}

/** Active staff who asked to hear about this alert on WhatsApp. An account with no number is simply
 *  not a recipient — there is nothing to tell them and nothing to report. */
export function staffRecipientsFor(event: string): WaStaffRecipient[] {
  const country = getWhatsApp().defaultCountry;
  return db
    .select({ id: users.id, username: users.username, displayName: users.displayName, phone: users.phone, phoneCountry: users.phoneCountry, waEvents: users.waEvents })
    .from(users)
    .where(and(inArray(users.role, ['admin', 'finance']), eq(users.status, 'active')))
    .all()
    .filter((u) => !!u.phone && (u.waEvents ?? []).includes(event))
    .map((u) => ({ userId: u.id, name: u.displayName?.trim() || u.username, to: toE164(u.phone, u.phoneCountry || country) }));
}

/**
 * Tell the staff who asked to hear about this alert.
 *
 * The parent PAUSE does not apply — it is a switch about writing to families, and an office that
 * paused parent messages while importing a roster still wants to know when a card fails. The master
 * switch does apply: off means the feature does not exist on this install.
 *
 * Called only from alerts/index.ts, which stays the one place that decides who hears about an event.
 */
export async function notifyStaff(event: string, text: string): Promise<number> {
  try {
    const cfg = getWhatsApp();
    if (!cfg.enabled || !fabricConfigured()) return 0;
    const to = staffRecipientsFor(event);
    if (!to.length) return 0;
    const status = await currentWhatsAppStatus();
    if (!status.available) return 0;

    let queued = 0;
    for (const s of to) {
      if (!s.to) {
        writeLog({ event, recipientKind: 'staff', recipientId: s.userId, status: 'skipped', reason: 'no_number' });
        continue;
      }
      const res = await sendPlatformWhatsApp(s.to, text);
      writeLog({ event, recipientKind: 'staff', recipientId: s.userId, status: res.queued ? 'queued' : 'failed', reason: res.queued ? (res.note ?? null) : res.reason, platformId: res.queued ? (res.id ?? null) : null });
      if (res.queued) queued++;
    }
    log.info('whatsapp staff notify', { event, recipients: to.length, queued });
    return queued;
  } catch (e) {
    log.warn('whatsapp staff notify failed', { event, error: (e as Error).message });
    return 0;
  }
}
