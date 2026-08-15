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
 * server — randomised gaps, typing indicators, per-recipient cooldowns, rolling hourly and daily
 * caps, quiet hours. That queue is the entire defence for a number WhatsApp does not officially
 * permit and can restrict at any time, and it only works because nothing goes around it. Two things
 * follow, and they are design constraints rather than cautions:
 *
 *   • **`queued` is not `sent`.** Delivery is seconds to minutes away and hours inside quiet hours.
 *     Nothing blocks on a send, no screen says "sent", and no flow waits for one to arrive.
 *   • **The allowance belongs to the NUMBER, not to us.** Every other installed app draws on the same
 *     daily cap, so nothing here is designed as a broadcast. One recipient per call, always.
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
import { and, eq, inArray, lt } from 'drizzle-orm';
import { db } from '../db';
import { families, guardians, guardianFamilies, students, users, whatsappLog } from '../db/schema';
import { rid } from '../db/ids';
import { getCurrency, getWhatsApp } from '../settings';
import { pausedFor, testFamilyId } from '../settings/testStudent';
import { fabricConfigured } from '../config';
import { sendPlatformWhatsApp, whatsappStatus, type WhatsAppStatus } from '../fabric/platform';
import { toE164 } from './numbers';
import { renderText, type WaTextKey, type WaVars } from './templates';
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

// ── The log ─────────────────────────────────────────────────────────────────
interface LogRow {
  event: string;
  recipientKind: 'guardian' | 'staff';
  recipientId: string;
  familyId?: string | null;
  status: 'queued' | 'failed' | 'skipped';
  reason?: string | null;
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
      createdAt: new Date(),
    })
    .run();
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
    reason: res.queued ? null : res.reason,
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
      writeLog({ event, recipientKind: 'staff', recipientId: s.userId, status: res.queued ? 'queued' : 'failed', reason: res.queued ? null : res.reason });
      if (res.queued) queued++;
    }
    log.info('whatsapp staff notify', { event, recipients: to.length, queued });
    return queued;
  } catch (e) {
    log.warn('whatsapp staff notify failed', { event, error: (e as Error).message });
    return 0;
  }
}
