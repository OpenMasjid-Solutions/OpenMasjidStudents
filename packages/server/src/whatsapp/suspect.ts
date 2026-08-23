// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * MESSAGES WE WERE TOLD WERE SENT, AND MAY NOT HAVE BEEN — the one place that decides what this app does
 * about that (0.51.0-dev.9, platform 0.51.2).
 *
 * WHAT HAPPENED, because the design follows from it. A masjid's WhatsApp session expired on its own,
 * OpenMasjidOS did not notice, and for over a day every app got `202 {queued}` and every message was
 * recorded `sent` while the gateway delivered none of them. The platform now detects that within about
 * ten minutes, but there is a residual window in which messages are reported sent and are not delivered
 * — and the platform cannot resend them, because it deletes a message's contents the moment it hands
 * them to the gateway. `GET /api/fabric/whatsapp/suspect` hands us the time windows; we hold the source
 * data, so the decision is ours.
 *
 * ── WHAT WE DO, AND THE THREE THINGS WE DELIBERATELY DO NOT ──────────────────
 *
 * WE RE-LABEL, WE DO NOT RESEND. The office's queue log said `Sent` for those rows, and that is the
 * defect: a screen asserting delivery it cannot vouch for is worse than one admitting ignorance, because
 * somebody reads it and decides not to phone the family. So a covered row becomes `unknown`, which the
 * log already renders as "may not have arrived", and the summary below tells an office how many and about
 * what. Everything after that is a human decision made with the app's ordinary buttons.
 *
 * 1. **We do not resend automatically.** The platform asked us not to, and it is right for a reason of
 *    our own: whatever we resend goes through the same single paced queue, on a number that has just
 *    been re-linked, which is when it is watched hardest (docs/WHATSAPP.md §1).
 * 2. **We do not resend on a button either, and this is the substantive judgment.** Every parent event in
 *    this app exists on EMAIL too and is sent on both channels from one place (mail/notify.ts). That is
 *    the whole argument that made a hard WhatsApp cap affordable in the first place: "a capped WhatsApp is
 *    a notice that arrived on one channel instead of two" (§2a). A suspect WhatsApp is exactly the same
 *    thing — so for any household with an address on file, the notice ARRIVED. Resending it would be
 *    telling a family a second time about a bill they have already read, on the shakiest channel we have,
 *    at the moment it can least afford the traffic.
 * 3. **We could not faithfully resend even if we wanted to.** `whatsapp_log` never stores a message body
 *    (§14 — a tuition message names a child and their fees, and a log is the copy that outlives the
 *    conversation). Re-rendering from today's data would produce a *different* message with the same
 *    event name — a receipt quoting a balance that has since changed. Better to say "we do not know" than
 *    to invent something and call it a resend.
 *
 * WHICH LEAVES THE HOUSEHOLDS WITH NO EMAIL ADDRESS, and they are the point of the summary. For them
 * WhatsApp was the only channel, so a suspect message is a notice genuinely lost rather than merely
 * duplicated. That set is named separately and is usually tiny — and this app already has the two tools
 * for it: the missing-email outreach, and a phone call. `houseHoldsWithoutEmail` is computed as it is
 * NOW rather than as it was then, which is a real limitation and is stated on screen rather than papered
 * over; an address added since is the good case, and one removed since is rare.
 *
 * A NOTE ON THE 404 THIS DOES NOT TOUCH. `status/<id>` answering 404 has always meant "unknown" — an
 * evicted record, an id that was never ours, an older platform. It is not a delivery failure and is not
 * evidence of this fault; the poller settles it `unknown` for its own reasons (whatsapp/index.ts). The
 * two producers of `unknown` are kept distinct by `reason` so the office can tell them apart.
 */
import { and, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import { db } from '../db';
import { guardians, guardianFamilies, students, whatsappLog } from '../db/schema';
import { getSuspectState, setSuspectState } from '../settings';
import { whatsappSuspect, type WhatsAppSuspectWindow } from '../fabric/platform';
import { makeLog } from '../logger';

const log = makeLog('whatsapp');

/** Why a row was marked. Distinguishes this fault from the poller's own 404, which is also `unknown`. */
export const SUSPECT_REASON = 'link_down';

/**
 * How many windows we remember.
 *
 * Enough to cover a bad week without letting the settings row grow without bound. They are kept at all so
 * a second poll does not re-report a window the office has already been shown: the platform retains a
 * window for seven days after the outage ends (0.51.1-dev.13), so every hourly poll for a week hands back
 * the same one.
 *
 * KEYED ON THE BOUNDS, and that is safe because **a window is a snapshot, not a running tally**. Everything
 * in it — the bounds, the cause, the count, the ids — is fixed at detection and never revised, since the
 * queue pauses at that moment and nothing else writes outcome records. (The earlier version of this comment
 * justified the dedupe by imagining a count that climbed hour by hour. It does not; the conclusion was
 * right and the reasoning was invented.) So a re-report is byte-identical, and skipping it is not merely an
 * optimization: re-marking would be a harmless no-op, but re-announcing would tell an office a settled
 * incident was still unfolding.
 */
const MAX_WINDOWS = 20;

/**
 * What we KEEP about a window, which is deliberately less than what arrives.
 *
 * Not the wire shape: `ids` is up to 500 platform message ids and is used once, at the moment of marking,
 * to decide which rows this window covers. Persisting it would put a few thousand opaque ids in a settings
 * row for no later reader — the marks on the log rows are the durable record of what it touched.
 */
export interface SuspectWindowRecord {
  from: number;
  to: number;
  count: number;
  /** When we first saw it, so the screen can order and age them. Epoch ms. */
  seenAt: number;
  /** How many of OUR log rows the window actually covered — usually, but not always, the platform's
   *  `count`: it counts what it reported sent, we count what we still have a row for. */
  marked: number;
  /**
   * What the platform said went wrong (platform 0.51.1-dev.13), so the screen can say why.
   *
   * Stored once and never refreshed, which is correct rather than lazy: a cause is fixed at detection and
   * cannot change mid-window — confirmed in the platform's own source, not assumed. A session expiry
   * followed by a key rotation during recovery is reported as two separate windows, which is what a
   * screen wants anyway.
   */
  cause?: string;
}

/** One pass: ask the platform, mark anything new, remember the window. Never throws. */
export async function checkSuspectWindows(now = Date.now()): Promise<{ checked: boolean; newWindows: number; marked: number; reason?: string }> {
  const res = await whatsappSuspect();
  if (!res.ok) {
    // `unsupported` is an older platform and is not news. Anything else is worth a line, because a
    // check that is silently failing looks exactly like a clean bill of health.
    if (res.reason !== 'unsupported' && res.reason !== 'no_platform') log.warn('suspect check unavailable', { reason: res.reason });
    return { checked: false, newWindows: 0, marked: 0, reason: res.reason };
  }

  const known = getSuspectState();
  const seen = new Set(known.map((w) => `${w.from}:${w.to}`));
  const fresh = res.windows.filter((w) => !seen.has(`${w.from}:${w.to}`));
  if (!fresh.length) return { checked: true, newWindows: 0, marked: 0 };

  let marked = 0;
  const added: SuspectWindowRecord[] = [];
  for (const w of fresh) {
    const n = markWindow(w);
    marked += n;
    added.push({ from: w.from, to: w.to, count: w.count, cause: w.cause, seenAt: now, marked: n });
  }
  // Newest first, capped. Sorted by the window itself rather than by when we noticed, so two polls of
  // the same incident cannot interleave.
  const next: SuspectWindowRecord[] = [...added, ...known].sort((a, b) => b.from - a.from).slice(0, MAX_WINDOWS);
  setSuspectState(next);
  log.info('suspect windows recorded', { windows: fresh.length, marked });
  return { checked: true, newWindows: fresh.length, marked };
}

/**
 * Re-label the rows one window covers.
 *
 * BY PLATFORM ID WHEN WE HAVE THEM (platform 0.51.1-dev.13), by time range otherwise.
 *
 * A COMPLETE ID LIST IS AUTHORITATIVE IN BOTH DIRECTIONS: a message it names was affected, and **a message
 * it does not name was not lost, whatever the timing looks like**. That second half is the one worth
 * stating, because the timing genuinely lies. `from`/`to` are when the PLATFORM reported those messages
 * sent; our `created_at` is when WE handed them over, with the paced queue between the two. So the range
 * is wrong at both edges — and now that the platform HOLDS messages through an outage, it is wrong in a
 * new way as well: a message queued during the outage and delivered perfectly after the re-link sits
 * inside the range and was never in trouble at all.
 *
 * That false positive is the fallback's, and it is the reason the range is only ever a fallback. We accept
 * it there rather than engineering around it because of what it costs HERE specifically: this app does not
 * resend (see the header), so an over-marked row is an office told to consider phoning a family who was in
 * fact reached — over-reporting, in a feature whose entire purpose is to stop silent under-reporting. An
 * app that resent on this signal could not make that trade, which is what makes the id list worth using
 * whenever it exists.
 *
 * `truncated` is the other reason the range path stays: the platform caps the id list at 500 per window,
 * and a truncated list would leave the overflow silently unmarked. A truncated window therefore falls back
 * to the range, which is complete by construction. (Our own send budget is 60 parent messages a day, so a
 * truncated window is close to unreachable here — but the fallback costs nothing and the cap is theirs to
 * change.) Older platforms send no ids at all, and the range is then all there is.
 *
 * ONLY rows we currently believe were `sent`, either way. A row already `failed`, `expired` or `skipped`
 * has a more specific answer than this one and must keep it; a row still `queued` was never claimed to be
 * delivered, so there is nothing to correct — and if it is still held, it may yet go out properly.
 */
function markWindow(w: WhatsAppSuspectWindow): number {
  const byId = w.ids.length > 0 && !w.truncated;
  return db
    .update(whatsappLog)
    .set({ status: 'unknown', reason: SUSPECT_REASON })
    .where(
      and(
        eq(whatsappLog.status, 'sent'),
        byId
          ? inArray(whatsappLog.platformId, w.ids)
          : and(gte(whatsappLog.createdAt, new Date(w.from)), lte(whatsappLog.createdAt, new Date(w.to))),
      ),
    )
    .run().changes;
}

export interface SuspectSummary {
  /** Windows we know about, newest first. */
  windows: SuspectWindowRecord[];
  /** Rows still carrying this fault's mark, by event — what the messages were ABOUT. */
  byEvent: { event: string; count: number }[];
  /** Total of the above. */
  total: number;
  /**
   * Households among those that have NO email address on file — the ones for whom WhatsApp was the only
   * channel, so the notice is genuinely lost rather than duplicated. The set an office should act on.
   */
  householdsWithoutEmail: { familyId: string; label: string; count: number }[];
}

/** What the settings screen shows. Derived on read — nothing here is a stored count. */
export function suspectSummary(): SuspectSummary {
  const windows = getSuspectState();
  const rows = db
    .select({ event: whatsappLog.event, familyId: whatsappLog.familyId })
    .from(whatsappLog)
    .where(and(eq(whatsappLog.status, 'unknown'), eq(whatsappLog.reason, SUSPECT_REASON)))
    .all();

  const perEvent = new Map<string, number>();
  for (const r of rows) perEvent.set(r.event, (perEvent.get(r.event) ?? 0) + 1);

  const famIds = [...new Set(rows.map((r) => r.familyId).filter((v): v is string => !!v))];
  const withoutEmail = famIds.length ? familiesWithoutEmail(famIds) : new Set<string>();
  const perFamily = new Map<string, number>();
  for (const r of rows) {
    if (r.familyId && withoutEmail.has(r.familyId)) perFamily.set(r.familyId, (perFamily.get(r.familyId) ?? 0) + 1);
  }

  const labels = perFamily.size ? familyLabels([...perFamily.keys()]) : new Map<string, string>();
  return {
    windows,
    byEvent: [...perEvent.entries()].map(([event, count]) => ({ event, count })).sort((a, b) => b.count - a.count),
    total: rows.length,
    householdsWithoutEmail: [...perFamily.entries()]
      .map(([familyId, count]) => ({ familyId, label: labels.get(familyId) ?? familyId, count }))
      .sort((a, b) => b.count - a.count),
  };
}

/** Of these households, which have no usable email address on any guardian? */
function familiesWithoutEmail(familyIds: string[]): Set<string> {
  const withEmail = new Set(
    db
      .select({ familyId: guardianFamilies.familyId })
      .from(guardianFamilies)
      .innerJoin(guardians, eq(guardians.id, guardianFamilies.guardianId))
      .where(and(inArray(guardianFamilies.familyId, familyIds), ne(guardians.email, ''), sql`${guardians.email} IS NOT NULL`))
      .all()
      .map((r) => r.familyId),
  );
  return new Set(familyIds.filter((id) => !withEmail.has(id)));
}

/** The derived household label, by way of its children — `families.name` is the stored one and the
 *  directory already prefers the derived form (people/household.ts). Cheap enough for a summary. */
function familyLabels(familyIds: string[]): Map<string, string> {
  const rows = db
    .select({ familyId: students.familyId, fullName: students.fullName })
    .from(students)
    .where(and(inArray(students.familyId, familyIds), eq(students.status, 'active')))
    .all();
  const byFamily = new Map<string, string[]>();
  for (const r of rows) byFamily.set(r.familyId, [...(byFamily.get(r.familyId) ?? []), r.fullName]);
  const out = new Map<string, string>();
  for (const id of familyIds) {
    const names = byFamily.get(id) ?? [];
    out.set(id, names.length ? names.map((n) => n.split(/\s+/)[0]).join(', ') : id);
  }
  return out;
}

/**
 * The office has read it and wants the banner gone.
 *
 * Clears the remembered windows AND the marks, because leaving the rows marked while forgetting the
 * windows would make the next poll of the same incident look like a new one. The rows go to `unknown`
 * with no reason rather than back to `sent`: we still do not know that they arrived, and pretending
 * otherwise to tidy a screen is the whole thing this feature exists to stop.
 */
export function acknowledgeSuspect(): number {
  const n = db
    .update(whatsappLog)
    .set({ reason: null })
    .where(and(eq(whatsappLog.status, 'unknown'), eq(whatsappLog.reason, SUSPECT_REASON)))
    .run().changes;
  setSuspectState([]);
  return n;
}
