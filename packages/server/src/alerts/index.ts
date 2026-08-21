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
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db';
import { alertRecipients, students } from '../db/schema';
import { formatMoney } from '../db/money';
import { raiseAlert, notifyPlatform, type AlertId, type AlertLevel } from '../fabric/platform';
import { sendAlert } from '../mail/notify';
import { notifyStaff, notifyGroups } from '../whatsapp';
import { waStaffAlert } from '../whatsapp/templates';
import { getSetting, setSetting, SETTING_KEYS } from '../settings';
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
 * WHO AN ALERT IS ABOUT: the CHILD, not the household (0.50.0-dev.14).
 *
 * Every one of these used to say "the Ismail family paid $250" or "3 families are past due", and that
 * was one indirection away from the thing the app actually bills. **Invoices and payments are per
 * STUDENT** (§9) — a household is the collecting unit, nothing more — so a household label makes an
 * office do a lookup the alert could have done for them, and it makes the useful number disappear: a
 * family total says a household owes $430 without saying that $430 is Yusuf's two missed months and
 * Maryam is square.
 *
 * It is also a label that does not identify anything on its own. `families.name` is DERIVED from the
 * children's surnames (`people/household.ts`), so a madrasah with four Ismail households has four
 * alerts about "the Ismail family", and a mixed household reads "Farooqi / Ismail" — which names a
 * child who may not be the one who is behind.
 *
 * The privacy line does not move: this is the `text` variant, which goes only to addresses an admin
 * typed, to staff numbers an admin entered, and to a group an admin ticked `detail` for. A child's
 * name beside an amount was already allowed there. `publicText` still names nobody, and neither may
 * ever carry a Student ID (§14).
 */

/** One child, by name. 'A student' when the row cannot be read — an alert is still worth sending. */
export function studentName(studentId: string): string {
  return db.select({ n: students.fullName }).from(students).where(eq(students.id, studentId)).get()?.n || 'A student';
}

/**
 * The children a household-level fact covers: "Yusuf Ismail", "Yusuf and Maryam Ismail".
 *
 * A CARD and an AUTOPAY enrollment genuinely belong to the household — one adult holds the card for all
 * their children, and "Yusuf's card was declined" would be a lie about whose card it is. So those
 * alerts name the children the card is FOR, which is what an office chases and what their records are
 * keyed by, without claiming the child owns the payment method.
 */
export function childrenOf(familyId: string, max = 4): string {
  const kids = db
    .select({ n: students.fullName })
    .from(students)
    .where(and(eq(students.familyId, familyId), eq(students.status, 'active')))
    .orderBy(asc(students.fullName))
    .all()
    .map((r) => r.n);
  return joinNames(kids, max) || 'a family with no active students';
}

/**
 * The per-child breakdown: "Yusuf Ismail $150.00 and Maryam Ismail $100.00".
 *
 * One card charge covering several children is recorded as one row per child (§9), so this is what
 * actually happened rather than a total that hides it. A single child renders as just their name and
 * amount, which is the common case and reads like a sentence.
 */
export function studentAmounts(shares: { studentId: string; amountCents: number }[], currency: string, max = 4): string {
  const named = shares.map((s) => `${studentName(s.studentId)} ${formatMoney(s.amountCents, currency)}`);
  return joinNames(named, max) || 'a student';
}

/** "a", "a and b", "a, b and c", "a, b and 3 others" — the last one so six children do not fill a page. */
function joinNames(parts: string[], max: number): string {
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0];
  if (parts.length <= max) return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `${parts.slice(0, max).join(', ')} and ${parts.length - max} ${parts.length - max === 1 ? 'other' : 'others'}`;
}

export interface AlertMessage {
  /** A short subject line — "Autopay switched off". */
  title: string;
  /**
   * For the addresses the office listed, by email. One or two plain sentences: what happened, and what
   * to do about it. MAY name a person and the amount — an alert that cannot say who it is about is not
   * actionable, and these addresses were typed in by an admin.
   *
   * The person is the STUDENT: use `studentName` / `studentAmounts` / `childrenOf` above rather than a
   * household label, which names four different households identically and hides the per-child split
   * the money was actually recorded as.
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
/**
 * Alerts that fire per EXTERNAL FAILURE rather than per human action — and how long one of them
 * speaks for (0.51.0-dev.6).
 *
 * This gate exists because OpenMasjidOS removed the 60-second per-recipient cooldown that had been
 * quietly absorbing exactly this, and OpenMasjidKiosk found out the expensive way: its
 * `payment-failed` alert fired once per refused card, so an expired key on a Friday meant one message
 * per person who tried to give, for the whole of jummah. Nothing bounds that any more, and three of
 * our own alerts have the same shape:
 *
 *  • `lookup-lockout` — one per Student ID locked. The per-ID guard means one alert per ID, which is
 *    no bound at all against the thing it exists to detect: somebody sweeping IDs locks a new one
 *    every few minutes, and fifty locked IDs was fifty alerts.
 *  • `payment-recovered` — raised **per PaymentIntent** inside the reconcile loop. A first reconcile
 *    looks back 35 days, so a masjid whose broker path had been broken gets one alert per recovered
 *    payment: dozens, in one pass, all saying the same thing.
 *  • `login-blocked` — one per account name. Bounded by the number of real staff accounts, so a
 *    handful rather than a storm, but the same class and cheap to include.
 *
 * NOT a blanket cooldown, deliberately. Two refunds in an afternoon are two things an office needs to
 * see, and suppressing the second because it resembles the first would be worse than the noise. Only
 * events that can fire faster than a person can cause them are listed.
 *
 * THE HELD COUNT IS THE POINT, not a consolation. For ID sweeping the number IS the signal — "one ID
 * was locked" and "forty-seven were" call for completely different reactions — so a suppressed alert
 * increments a counter and the next one that gets through reports it. Suppressing silently would be
 * the same invisible-failure shape this whole release has been about removing.
 */
const STORM_WINDOW_MS: Partial<Record<AlertEvent, number>> = {
  'lookup-lockout': 30 * 60_000,
  'payment-recovered': 30 * 60_000,
  'login-blocked': 30 * 60_000,
};

interface StormState {
  /** When this event last actually spoke. */
  at: number;
  /** How many have been suppressed since. */
  held: number;
}

/** Read/write in the settings table rather than a module variable, so a container restart cannot
 *  discard it. That is not a hypothetical concern: half of the platform's own WhatsApp outage was
 *  pacing state that a restart threw away, and holding this in memory would repeat the mistake. */
function stormRead(): Record<string, StormState> {
  try {
    const raw = getSetting(SETTING_KEYS.alertStorm);
    return raw ? (JSON.parse(raw) as Record<string, StormState>) : {};
  } catch {
    return {};
  }
}

/**
 * May this alert speak? Returns the number of siblings it should mention, or null to stay quiet.
 *
 * `0` means "speak, nothing was held" — distinct from `null`, which means "say nothing at all". A
 * caller that treated those the same would either suppress every alert or none.
 */
function stormGate(event: AlertEvent, now = Date.now()): number | null {
  const window = STORM_WINDOW_MS[event];
  if (!window) return 0; // not storm-prone: always speaks, nothing to report
  const all = stormRead();
  const prev = all[event];
  if (prev && now - prev.at < window) {
    all[event] = { at: prev.at, held: (prev.held ?? 0) + 1 };
    setSetting(SETTING_KEYS.alertStorm, JSON.stringify(all));
    return null;
  }
  const held = prev?.held ?? 0;
  all[event] = { at: now, held: 0 };
  setSetting(SETTING_KEYS.alertStorm, JSON.stringify(all));
  return held;
}

export async function alertStaff(event: AlertEvent, msg: AlertMessage): Promise<void> {
  const spec = SPEC[event];
  try {
    /**
     * The storm gate, before ANY fan-out — email, the platform channel, the webhook, WhatsApp and the
     * groups alike. All five have the same problem with fifty copies of one sentence, and gating one
     * channel would leave the office's inbox filling while their phone stayed quiet, or the reverse.
     */
    const held = stormGate(event);
    if (held === null) {
      log.info('staff alert suppressed — one already went recently', { event });
      return;
    }
    if (held > 0) {
      // Appended to BOTH texts: a count names nobody, so it clears §14 on the public side too, and it
      // is the half of the message an office most needs on a sweep.
      const more = ` (and ${held} more like it in the last half hour)`;
      msg = { ...msg, text: msg.text + more, publicText: msg.publicText + more };
    }
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
