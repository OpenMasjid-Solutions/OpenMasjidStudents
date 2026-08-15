// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Staff alerts (0.44.0) — ONE place that decides who hears about an event, and how.
 *
 * There were two channels before this, and both could be silently dead. `notifyPlatform` posts to the
 * masjid's webhook, which most installs never configure. `raiseAlert` reaches OpenMasjidOS, which can
 * email the platform admin — but only for ids declared in our manifest AND present in the catalog entry
 * the masjid installed from, so a newly-declared id answers 400 until a release lands. Neither reaches
 * the person a madrasa actually wants told: the treasurer, the imām, whoever chases a failed card.
 *
 * So an alert now fans out to FIVE places, each best-effort and independent:
 *   1. the addresses the office listed in Settings → Email alerts (this app's own email, always works
 *      once OpenMasjidOS can send mail at all);
 *   2. the OpenMasjidOS alert channel, when the event maps to a declared id;
 *   3. the masjid webhook, for the routine ones that would flood an alert channel;
 *   4. the WhatsApp numbers of staff who asked for this alert (0.50.0) — the one channel that finds a
 *      treasurer who is nowhere near an inbox, which is most evenings and every Sunday;
 *   5. any WhatsApp GROUP an admin subscribed to this alert (0.50.0) — a masjid's finance group, where
 *      the people who chase a failed card already talk to each other.
 *
 * WHAT AN ALERT MAY SAY. These emails go to addresses an ADMIN typed, so they may name a household
 * ("the Ismail family") and an amount — without that they are unactionable, which is the state the old
 * webhook text was stuck in. What they must never carry: a Student ID (it is a payment credential —
 * §14), card details, or anything from a payment proof. Nothing here is logged beyond the event id and
 * a count (§14: no PII in logs).
 */
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { alertRecipients, families } from '../db/schema';
import { raiseAlert, notifyPlatform, type AlertId, type AlertLevel } from '../fabric/platform';
import { sendAlert } from '../mail/notify';
import { notifyStaff, notifyGroups } from '../whatsapp';
import { waStaffAlert } from '../whatsapp/templates';
import { makeLog } from '../logger';

const log = makeLog('alerts');

/** The events an office can subscribe an address to. Ids are stored in `alert_recipients.events`, so
 *  renaming one silently unsubscribes everybody — add, don't rename. */
export const ALERT_EVENTS = [
  'payment-received',
  'autopay-failed',
  'autopay-disabled',
  'lookup-lockout',
  'payment-recovered',
  'payment-short',
  'invoices-generated',
  'past-due',
  'payment-refunded',
  'login-blocked',
] as const;
export type AlertEvent = (typeof ALERT_EVENTS)[number];

interface EventSpec {
  /** The manifest alert id this maps to, when OpenMasjidOS knows about it (§ manifest `alerts:`). */
  platform: AlertId | null;
  /** Also post to the masjid webhook? Reserved for the routine, high-volume events. */
  webhook: boolean;
  level: AlertLevel;
  /** Does a NEWLY-ADDED recipient get this one by default? */
  defaultOn: boolean;
}

/**
 * Per-event routing and defaults.
 *
 * `defaultOn` is the whole design of this feature in one column: the events that cost a masjid money
 * or hide an attack are on for a new recipient, and `payment-received` is not — one email per payment
 * on a busy Sunday is how somebody ends up filtering all of it to a folder, alerts that matter
 * included. It stays available for the small madrasa that genuinely wants every payment in an inbox.
 */
const SPEC: Record<AlertEvent, EventSpec> = {
  'payment-received': { platform: null, webhook: true, level: 'info', defaultOn: false },
  'autopay-failed': { platform: null, webhook: false, level: 'warning', defaultOn: false },
  'autopay-disabled': { platform: 'autopay-disabled', webhook: false, level: 'error', defaultOn: true },
  'lookup-lockout': { platform: 'lookup-lockout', webhook: false, level: 'warning', defaultOn: true },
  'payment-recovered': { platform: 'reconcile-recovered', webhook: false, level: 'info', defaultOn: true },
  'payment-short': { platform: 'payment-short', webhook: false, level: 'error', defaultOn: true },
  'invoices-generated': { platform: null, webhook: false, level: 'info', defaultOn: false },
  // Who is behind (0.48.0). `defaultOn`, because an unpaid bill nobody chases is the thing this whole
  // app exists to stop — and it is a DIGEST on the office's own cadence, not one email per family, so it
  // cannot flood an inbox the way `payment-received` would.
  'past-due': { platform: 'past-due', webhook: false, level: 'warning', defaultOn: true },
  // Money leaving (0.48.0). `defaultOn` and `error`-level not because a refund is a fault — it is an
  // ordinary, correct thing for an office to do — but because it is the one action here that sends money
  // OUT, and whoever runs the madrasah's books should learn of it without having to go looking. Volume is
  // no concern: a refund is rare, unlike `payment-received`.
  'payment-refunded': { platform: 'payment-refunded', webhook: false, level: 'warning', defaultOn: true },
  /**
   * Somebody is grinding one account's password (0.48.0).
   *
   * `platform: null` — our own email ONLY, and deliberately so. A platform alert id is answered
   * `400 Unknown alert` until the catalog entry a masjid installed from declares it, which is how
   * `payment-short` vanished for a whole release; and this is the one event whose volume an attacker
   * chooses, so keeping it on the channel we control (and that an admin can unsubscribe from in one place)
   * is the right home for it. `defaultOn`, because a password being ground is exactly what nobody notices.
   */
  'login-blocked': { platform: null, webhook: false, level: 'warning', defaultOn: true },
};

/** The events a newly-added recipient starts with. */
export function defaultEvents(): AlertEvent[] {
  return ALERT_EVENTS.filter((e) => SPEC[e].defaultOn);
}

/**
 * Every OpenMasjidOS alert id this app can actually raise.
 *
 * Exported so a test can hold it against `manifest.yaml`: an id missing from the manifest is answered
 * 400 "Unknown alert" and dropped, and because `raiseAlert` is fail-soft that is completely invisible.
 * It already happened once — `payment-short` was added to the union in 0.43.0 and to the manifest in
 * 0.44.0, so every one of those alerts vanished in between.
 */
export function platformAlertIds(): AlertId[] {
  return [...new Set(ALERT_EVENTS.map((e) => SPEC[e].platform).filter((id): id is AlertId => id !== null))];
}

/** Is this a real event id? (Used to filter anything hand-edited or left over from an older build.) */
export function isAlertEvent(v: unknown): v is AlertEvent {
  return typeof v === 'string' && (ALERT_EVENTS as readonly string[]).includes(v);
}

export interface AlertRecipientView {
  id: string;
  email: string;
  label: string | null;
  events: AlertEvent[];
}

/** Every recipient, with unknown event ids filtered out so a stale row can't widen what it receives. */
export function listRecipients(): AlertRecipientView[] {
  return db
    .select()
    .from(alertRecipients)
    .orderBy(alertRecipients.email)
    .all()
    .map((r) => ({ id: r.id, email: r.email, label: r.label, events: (r.events ?? []).filter(isAlertEvent) }));
}

/** The addresses subscribed to one event. */
function recipientsFor(event: AlertEvent): string[] {
  return listRecipients()
    .filter((r) => r.events.includes(event))
    .map((r) => r.email);
}

/**
 * The household's own label ("Ismail family") for an alert body, or 'A family' when it can't be read.
 *
 * Naming the household is what makes an alert actionable — "a family's card failed" tells nobody which
 * card to chase. It is a derived surname label, never a Student ID and never a child's full record
 * (§14), and it only ever goes to addresses an admin listed.
 */
export function householdName(familyId: string): string {
  return db.select({ name: families.name }).from(families).where(eq(families.id, familyId)).get()?.name || 'A family';
}

export interface AlertMessage {
  /** A short subject line — "Autopay switched off". */
  title: string;
  /**
   * For the addresses the office listed, by email. One or two plain sentences: what happened, and what
   * to do about it. MAY name the household and the amount — an alert that cannot say who it is about is
   * not actionable, and these addresses were typed in by an admin.
   */
  text: string;
  /**
   * For the masjid WEBHOOK and the OpenMasjidOS alert channel — and therefore NO household, no child,
   * and no name-beside-an-amount (§14). Both are third-party sinks: a webhook is usually a Slack or
   * Discord channel, and the platform's alert delivery is not ours to reason about. An amount on its
   * own is fine; that is where the line has always been.
   *
   * Required rather than defaulted to `text`, deliberately: a default would leak a family's name into a
   * chat channel the first time somebody forgot this field, and nothing would ever surface it.
   */
  publicText: string;
}

/**
 * Tell whoever should know. Fire-and-forget from the caller's point of view: never throws, and a
 * failure to notify never fails the operation that triggered it.
 *
 * Deliberately does NOT await the individual sends in the caller's critical path — call sites use
 * `void alertStaff(...)`. The platform's mail endpoint takes one recipient per call, so a masjid with
 * five recipients means five sequential HTTP calls; that belongs after the response, not in it.
 */
export async function alertStaff(event: AlertEvent, msg: AlertMessage): Promise<void> {
  const spec = SPEC[event];
  try {
    // Both platform channels get the de-identified text (§14) — only our own email may name a family.
    if (spec.platform) void raiseAlert(spec.platform, msg.publicText, { title: msg.title, level: spec.level });
    if (spec.webhook) void notifyPlatform(msg.publicText, { title: msg.title, level: spec.level === 'error' ? 'error' : spec.level === 'warning' ? 'warn' : 'info' });

    // WhatsApp to the staff who subscribed (0.50.0). It carries `text`, the same wording the alert
    // EMAIL carries — see whatsapp/templates.ts `waStaffAlert` for why that is not a §14 regression:
    // the recipients are numbers an admin typed, on a gateway the masjid runs itself, and an alert
    // that cannot name the family is not actionable. Not awaited, for the same reason as the two
    // above — the queue paces sends, and none of this belongs in a caller's critical path.
    void notifyStaff(event, waStaffAlert(msg.title, msg.text));
    // …and to any WhatsApp GROUP an admin subscribed to this alert — a finance group that wants every
    // payment. Handed BOTH texts rather than one: an admin can see who is in a group and this app
    // cannot, so which of the two a group gets is their decision, defaulting to the one that names
    // nobody (whatsapp/index.ts `notifyGroups`).
    void notifyGroups(event, msg);

    const to = recipientsFor(event);
    if (!to.length) return;
    let sent = 0;
    for (const email of to) if (await sendAlert(email, msg.title, msg.text)) sent++;
    // Ids and counts only — never an address, never the body (§14).
    log.info('staff alert sent', { event, recipients: to.length, sent });
  } catch (e) {
    log.warn('staff alert failed', { event, error: (e as Error).message });
  }
}

/** Send one recipient the "does this reach you?" probe from Settings. Returns whether it sent. */
export async function sendAlertTest(recipientId: string): Promise<boolean> {
  const r = db.select().from(alertRecipients).where(eq(alertRecipients.id, recipientId)).get();
  if (!r) return false;
  return sendAlert(r.email, 'Test alert', 'This is a test alert from your madrasa’s tuition app. If you received it, alerts will reach you here.');
}
