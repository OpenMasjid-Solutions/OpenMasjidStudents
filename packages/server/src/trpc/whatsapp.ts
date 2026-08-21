// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * WhatsApp settings and the two things an office actually presses (0.50.0). Admin-only, like every
 * other setting (§5): who a madrasah messages, and on which channel, is the office's decision and not
 * finance's.
 *
 * The platform owns the gateway and the paced queue; this router owns the masjid's POLICY — is it on,
 * is it paused, which events, which country codes, which student is the test one — plus the queue log
 * and the missing-email outreach. Nothing here talks to WhatsApp directly; everything funnels through
 * whatsapp/index.ts, which is the one place that decides whether a message goes out.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import { router, adminProcedure, auditActor } from './trpc';
import { db } from '../db';
import { families, guardians, guardianFamilies, students, users, whatsappLog } from '../db/schema';
import { getWhatsApp, setWhatsApp, getWhatsAppEmailRequest, setWhatsAppEmailRequest, getWhatsAppTexts, setWhatsAppTexts, isCountryCode, WA_TEXT_MAX } from '../settings';
import { testFamilyId } from '../settings/testStudent';
import {
  WA_PARENT_EVENTS,
  approvedGroups,
  groupIsApproved,
  testGroup,
  capState,
  currentWhatsAppStatus,
  familyRecipients,
  familyVars,
  notifyGuardian,
  refreshWhatsAppStatus,
  staffRecipientsFor,
  type WaRecipient,
} from '../whatsapp';
import { maskNumber, toE164 } from '../whatsapp/numbers';
import {
  WA_EMAIL_REQUEST_DEFAULT,
  WA_EMAIL_REQUEST_TAGS,
  WA_TAG_HELP,
  WA_TEXT_DEFAULTS,
  WA_TEXT_KEYS,
  WA_TEXT_TAGS,
  renderEmailRequest,
  renderText,
  waTest,
} from '../whatsapp/templates';
import { ALERT_EVENTS } from '../alerts';
import { audit } from '../audit';
import { sendTestToHousehold } from '../mail/notify';
import { getCurrency, getSchoolName } from '../settings';
import { formatDate } from '../settings/dates';
import { formatMoney } from '../db/money';
import { fabricConfigured } from '../config';

/**
 * How many households one press of the outreach button writes to.
 *
 * A real cap, stated out loud rather than hidden: the sending allowance belongs to the masjid's NUMBER
 * and is shared with every other app on the server, so handing the queue two hundred messages in one
 * go is precisely the behavior that gets a number restricted. The screen reports how many are left so
 * nothing is silently dropped — press it again tomorrow.
 */
const OUTREACH_BATCH = 50;

/** Households listed on the settings screen at once. A big roster is a scrolling problem, not a
 *  reason to hide anybody — the total is always reported alongside. */
const PREVIEW_LIMIT = 200;

interface MissingEmailHousehold {
  familyId: string;
  label: string;
  /** The children this household has no address for — named in the message, because "we don't have
   *  your email" without saying who it is about is the first thing a parent will ask. */
  children: string[];
  recipients: WaRecipient[];
}

/**
 * Every household with no email address anywhere on it, with its children and its messageable adults.
 *
 * The condition is per HOUSEHOLD even though the office thinks in children: guardians attach to the
 * household (§9), so a child is unreachable exactly when nobody on their household has an address.
 * Active students only — a withdrawn child's bill may still be owed, but nobody is chasing an address
 * for a family that has left.
 */
function householdsMissingEmail(): MissingEmailHousehold[] {
  const withEmail = new Set(
    db
      .select({ familyId: guardianFamilies.familyId, email: guardians.email })
      .from(guardianFamilies)
      .innerJoin(guardians, eq(guardians.id, guardianFamilies.guardianId))
      .all()
      .filter((g) => (g.email ?? '').includes('@'))
      .map((g) => g.familyId),
  );

  const byFamily = new Map<string, MissingEmailHousehold>();
  for (const s of db
    .select({ id: students.id, fullName: students.fullName, familyId: students.familyId, label: families.name })
    .from(students)
    .innerJoin(families, eq(families.id, students.familyId))
    .where(eq(students.status, 'active'))
    .orderBy(asc(families.name), asc(students.fullName))
    .all()) {
    if (withEmail.has(s.familyId)) continue;
    const cur = byFamily.get(s.familyId) ?? { familyId: s.familyId, label: s.label, children: [], recipients: [] };
    cur.children.push(s.fullName);
    byFamily.set(s.familyId, cur);
  }
  for (const h of byFamily.values()) h.recipients = familyRecipients(h.familyId);
  return [...byFamily.values()];
}

/** Can this household actually be written to? (At least one adult who has not opted out and whose
 *  number we can read.) */
const reachable = (h: MissingEmailHousehold): WaRecipient[] => h.recipients.filter((r) => !!r.to && !r.optedOut);

export const whatsappRouter = router({
  /**
   * Everything the settings screen needs, in one read.
   *
   * The gateway status is resolved LIVE here — `currentWhatsAppStatus` answers from a five-minute
   * cache and only crosses the network when that is cold or stale (0.50.0-dev.4). It read the cache
   * alone at first, which produced a real fault rather than a slow screen: nothing primed the cache
   * except a 15-minute cron, so for the first quarter of an hour after a container start the panel
   * said "Not ready" and grayed out the Send-a-test button on an install that was working perfectly.
   * One request on an admin settings render is the right trade for that.
   */
  get: adminProcedure.query(async () => {
    const cfg = getWhatsApp();
    const testFam = testFamilyId();
    const testStudent = cfg.testStudentId
      ? db.select({ id: students.id, fullName: students.fullName, familyId: students.familyId, status: students.status }).from(students).where(eq(students.id, cfg.testStudentId)).get()
      : null;
    const status = await currentWhatsAppStatus();
    /** What is left of today's and this hour's send budget (0.51.0-dev.5). */
    const cap = capState();

    /**
     * WHY NOTHING IS SENDING (0.50.0-dev.5) — the diagnostic this screen should have had from the start.
     *
     * The three global gates return before any recipient is looked at, and deliberately write no log
     * row: a switch that is off would otherwise put two hundred "skipped" rows in the trail every time
     * an invoice run finished. The cost of that decision was invisibility — a masjid turned the feature
     * on, took a real payment for the test student, and got no message AND no log entry, with nothing
     * anywhere saying which gate had stopped it.
     *
     * So the gates report themselves, in the order they are actually applied. Anything in this list
     * means nothing reaches a parent, whatever else the screen shows.
     */
    const blockers: string[] = [];
    if (!fabricConfigured()) blockers.push('no_platform');
    else if (!cfg.enabled) blockers.push('off');
    else {
      if (!status.available) blockers.push(`gateway_${status.reason}`);
      if (!WA_PARENT_EVENTS.some((e) => cfg.events[e])) blockers.push('no_events');
      if (cfg.paused && !testFam) blockers.push('paused_no_test');
      // A spent send budget stops every parent message just as completely as a switch being off, and
      // it is the one blocker that appears on its own halfway through an invoice run (0.51.0-dev.5).
      if (cap.blocked) blockers.push(`cap_${cap.blocked}`);
    }

    return {
      ...cfg,
      /** Empty means messages can actually go out. See above — this is the answer to "why nothing?". */
      blockers,
      /** True when the pause is on but a test household is set: not a blocker, but the screen should
       *  say plainly that only that household will hear anything. */
      pausedWithTest: cfg.paused && !!testFam,
      /** The catalogs, so the UI hard-codes no event list (same rule as the alert screen). */
      parentEvents: WA_PARENT_EVENTS,
      staffEvents: ALERT_EVENTS,
      status,
      /** Without the Fabric there is no platform to ask, so the feature cannot work at all. */
      fabric: fabricConfigured(),
      testStudent: testStudent ? { id: testStudent.id, fullName: testStudent.fullName, familyId: testStudent.familyId, active: testStudent.status === 'active' } : null,
      /** Null while a test student is set but no longer resolves — a withdrawn child, or one deleted.
       *  Said explicitly, because "paused, and the exception silently stopped working" is invisible. */
      testFamilyId: testFam,
      emailRequest: { text: getWhatsAppEmailRequest(), fallback: WA_EMAIL_REQUEST_DEFAULT, tags: [...WA_EMAIL_REQUEST_TAGS], maxLength: WA_TEXT_MAX },
      /** The send budget and what is left of it — the platform caps nothing now, so this is the only
       *  place an office can see the limit that is actually in force. */
      cap,
    };
  }),

  /** Ask the platform again, now — for an admin who has just linked a phone in OpenMasjidOS and wants
   *  to see this screen agree with it rather than waiting out the cache. */
  statusCheck: adminProcedure.mutation(async () => refreshWhatsAppStatus()),

  set: adminProcedure
    .input(
      z.object({
        enabled: z.boolean().optional(),
        paused: z.boolean().optional(),
        /** One event at a time, validated against the catalog so a stale client cannot invent one. */
        event: z.object({ id: z.enum(WA_PARENT_EVENTS), on: z.boolean() }).optional(),
        defaultCountry: z.string().trim().max(5).optional(),
        countries: z.array(z.string().trim().max(5)).max(20).optional(),
        /** '' clears it — the household stops being the exception to the pause. */
        testStudentId: z.string().trim().max(64).optional(),
        /** The send budget. Bounded here AND clamped in the settings store — this is the setting whose
         *  worst case is a number the masjid can never get back. */
        hourlyCap: z.number().int().min(1).max(200).optional(),
        dailyCap: z.number().int().min(1).max(1000).optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const patch: Parameters<typeof setWhatsApp>[0] = {};
      if (input.enabled !== undefined) patch.enabled = input.enabled;
      if (input.paused !== undefined) patch.paused = input.paused;
      if (input.event) patch.events = { [input.event.id]: input.event.on };
      if (input.defaultCountry !== undefined) {
        if (!isCountryCode(input.defaultCountry)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'A country code looks like +1 or +44.' });
        patch.defaultCountry = input.defaultCountry;
      }
      if (input.countries !== undefined) {
        if (!input.countries.every(isCountryCode)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'A country code looks like +1 or +44.' });
        patch.countries = input.countries;
      }
      if (input.hourlyCap !== undefined) patch.hourlyCap = input.hourlyCap;
      if (input.dailyCap !== undefined) patch.dailyCap = input.dailyCap;
      if (input.testStudentId !== undefined) {
        if (input.testStudentId && !db.select({ id: students.id }).from(students).where(eq(students.id, input.testStudentId)).get()) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'That student isn’t on the roll.' });
        }
        patch.testStudentId = input.testStudentId;
      }
      setWhatsApp(patch);
      // Switch names and flags only — never a number, never a name (§14).
      audit(auditActor(ctx), 'whatsapp.settings', { entity: 'settings', detail: { keys: Object.keys(input) } });
      return { ok: true as const };
    }),

  /**
   * Who this install could message right now, and who it could not.
   *
   * Shown BEFORE the master switch in the UI on purpose. An admin about to turn on a channel that
   * reaches families deserves to know that eleven of their numbers cannot be read as WhatsApp numbers
   * before they find out one message at a time.
   */
  audience: adminProcedure.query(() => {
    const cfg = getWhatsApp();
    const rows = db
      .select({ id: guardians.id, name: guardians.name, phone: guardians.phone, phoneCountry: guardians.phoneCountry, optOut: guardians.waOptOut, familyId: guardianFamilies.familyId, label: families.name })
      .from(guardianFamilies)
      .innerJoin(guardians, eq(guardians.id, guardianFamilies.guardianId))
      .innerJoin(families, eq(families.id, guardianFamilies.familyId))
      .orderBy(asc(families.name), asc(guardians.name))
      .all();

    // One guardian can be on two households; the audience is PEOPLE, so they are counted once.
    const seen = new Map<string, { name: string; label: string; phone: string | null; country: string | null; optedOut: boolean }>();
    for (const r of rows) if (!seen.has(r.id)) seen.set(r.id, { name: r.name, label: r.label, phone: r.phone, country: r.phoneCountry, optedOut: !!r.optOut });

    let reachableCount = 0;
    let optedOutCount = 0;
    const unreadable: { guardianId: string; name: string; label: string; phone: string; country: string | null }[] = [];
    let noNumber = 0;
    for (const [id, g] of seen) {
      if (g.optedOut) {
        optedOutCount++;
        continue;
      }
      if (!g.phone?.trim()) {
        noNumber++;
        continue;
      }
      if (toE164(g.phone, g.country || cfg.defaultCountry)) reachableCount++;
      // The list an office can actually act on: a number is there, and we cannot read it. Capped for
      // the screen's sake; the count above it is the honest total.
      else unreadable.push({ guardianId: id, name: g.name, label: g.label, phone: g.phone, country: g.country });
    }

    return {
      guardians: seen.size,
      reachable: reachableCount,
      optedOut: optedOutCount,
      noNumber,
      unreadableTotal: unreadable.length,
      unreadable: unreadable.slice(0, PREVIEW_LIMIT),
      countries: cfg.countries,
      defaultCountry: cfg.defaultCountry,
      /** Staff who would hear each alert on WhatsApp, so the Staff screen and this one agree. */
      staff: ALERT_EVENTS.map((e) => ({ event: e, recipients: staffRecipientsFor(e).length })),
    };
  }),

  // ── What each message says (0.50.0-dev.4) ─────────────────────────────────
  /**
   * The wording of every parent message: the catalog, the shipped sentences, this madrasah's own
   * versions, the tags each one may use, and a live preview against a real household.
   *
   * The whole registry comes from the server (whatsapp/templates.ts owns it), so the UI hard-codes no
   * sentence and no tag list — adding a message there makes a new box appear here with no change on
   * the browser side, exactly like the printed sheet's wording.
   *
   * The PREVIEW is the part that matters. A template with tags in it is unreadable as prose; what an
   * office needs to see is the message a real family will actually get, with the names and figures
   * filled in. It uses the test student's household when one is set (that is what it is for) and
   * otherwise the first household on the roll, so the tags resolve to something real rather than to
   * "[family]".
   */
  textsGet: adminProcedure.query(() => {
    const sample = testFamilyId() ?? db.select({ id: families.id }).from(families).orderBy(asc(families.name)).get()?.id ?? null;
    const vars = sample ? { ...familyVars(sample), amount: formatMoney(5000, getCurrency()), due: formatDate(new Date().toISOString().slice(0, 10)) } : null;
    return {
      keys: [...WA_TEXT_KEYS],
      defaults: WA_TEXT_DEFAULTS,
      /** Only the boxes this madrasah changed; everything else falls through to `defaults`. */
      overrides: getWhatsAppTexts(),
      /** Per message, because a tag that cannot be filled in leaves a hole in a sentence. */
      tags: WA_TEXT_TAGS,
      tagHelp: WA_TAG_HELP,
      maxLength: WA_TEXT_MAX,
      /** Which household the preview is of, so the screen can say so rather than showing an
       *  unattributed message. Null on an install with no families yet. */
      sampleFamily: sample ? (db.select({ name: families.name }).from(families).where(eq(families.id, sample)).get()?.name ?? null) : null,
      /** Rendered both ways: a parent WITH an address on file sees the "check your email" line and a
       *  parent without does not, and an office rewriting the wording should see both. */
      preview: vars
        ? WA_TEXT_KEYS.map((k) => ({
            key: k,
            withEmail: renderText(k, vars, { hasEmail: true }),
            withoutEmail: renderText(k, vars, { hasEmail: false }),
          }))
        : [],
    };
  }),

  /**
   * Save changed boxes. A box sent as '' goes back to the shipped sentence — that is what clearing
   * the field means, and blank wording would send a family an empty message.
   *
   * A LIST of key/text pairs rather than a free-form object, so every key is validated against the
   * registry: an unknown one is refused at the boundary instead of stored and silently ignored.
   */
  textsSet: adminProcedure
    .input(
      z.object({
        boxes: z.array(z.object({ key: z.enum(WA_TEXT_KEYS), text: z.string().max(WA_TEXT_MAX) })).max(WA_TEXT_KEYS.length).optional(),
        /** Put every message back to the shipped wording. */
        reset: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const patch: Record<string, string> = {};
      if (input.reset) for (const k of WA_TEXT_KEYS) patch[k] = '';
      for (const b of input.boxes ?? []) patch[b.key] = b.text;
      setWhatsAppTexts(patch);
      // Key names only — the wording is the school's own prose, and there is no reason to copy
      // paragraphs of it into the audit trail to record that it changed (§14).
      audit(auditActor(ctx), 'whatsapp.texts', { entity: 'settings', detail: { keys: Object.keys(patch), reset: !!input.reset } });
      return { ok: true as const };
    }),

  // ── The missing-email outreach ────────────────────────────────────────────
  /**
   * Households with no email address, the message each would receive, and whether we can reach them.
   *
   * The whole point of showing the rendered message per household rather than one generic sample is
   * that the tags resolve differently for each — `[children]` is the part the office is checking.
   */
  emailRequestPreview: adminProcedure.query(() => {
    const template = getWhatsAppEmailRequest();
    const all = householdsMissingEmail();
    const sendable = all.filter((h) => reachable(h).length > 0);
    return {
      template,
      fallback: WA_EMAIL_REQUEST_DEFAULT,
      tags: [...WA_EMAIL_REQUEST_TAGS],
      maxLength: WA_TEXT_MAX,
      households: all.length,
      /** How many we could actually write to — the rest need a phone call, which is the old answer. */
      sendable: sendable.length,
      batchSize: OUTREACH_BATCH,
      paused: getWhatsApp().paused,
      preview: all.slice(0, PREVIEW_LIMIT).map((h) => ({
        familyId: h.familyId,
        label: h.label,
        children: h.children,
        text: renderEmailRequest(template, { family: h.label, children: h.children }),
        recipients: h.recipients.map((r) => ({ guardianId: r.guardianId, name: r.name, mask: maskNumber(r.to), usable: !!r.to, optedOut: r.optedOut })),
      })),
    };
  }),

  /** Save the office's own wording. '' puts the shipped sentence back. */
  emailRequestSet: adminProcedure.input(z.object({ text: z.string().max(WA_TEXT_MAX) })).mutation(({ ctx, input }) => {
    setWhatsAppEmailRequest(input.text);
    // The wording is the school's own prose, not personal data — but there is no reason to copy
    // paragraphs of it into the audit trail to record that it changed (§14).
    audit(auditActor(ctx), 'whatsapp.emailRequestText', { entity: 'settings', detail: { custom: !!input.text.trim() } });
    return { ok: true as const };
  }),

  /**
   * Send it. One message per household — the FIRST adult we can reach, not everybody on it.
   *
   * That choice is deliberate and it is about the sending allowance: this is a request for one piece
   * of information, and messaging both parents to ask for one email address doubles the cost to the
   * masjid's number for nothing. Whoever answers, answers.
   */
  emailRequestSend: adminProcedure.input(z.object({ text: z.string().max(WA_TEXT_MAX).optional() })).mutation(async ({ ctx, input }) => {
    if (input.text !== undefined) setWhatsAppEmailRequest(input.text);
    const template = getWhatsAppEmailRequest();
    const all = householdsMissingEmail().filter((h) => reachable(h).length > 0);
    const batch = all.slice(0, OUTREACH_BATCH);

    let queued = 0;
    const skipped: Record<string, number> = {};
    for (const h of batch) {
      const to = reachable(h)[0];
      const outcome = await notifyGuardian('email-request', to, renderEmailRequest(template, { family: h.label, children: h.children }));
      if (outcome === 'queued') queued++;
      else skipped[outcome] = (skipped[outcome] ?? 0) + 1;
    }
    audit(auditActor(ctx), 'whatsapp.emailRequest', { entity: 'settings', detail: { households: batch.length, queued } });
    return {
      queued,
      skipped,
      /** Households we did not get to this press. Reported rather than hidden — see OUTREACH_BATCH. */
      remaining: Math.max(0, all.length - batch.length),
      /** Not "sent". The queue paces these, and delivery is minutes away — hours in quiet hours. */
      paused: getWhatsApp().paused,
    };
  }),

  /**
   * "Does this actually reach a phone?" — the same question the mail test answers.
   *
   * Sent to the TEST STUDENT's household, which is the one household that gets through the pause, so
   * an admin can prove the whole path works before anything reaches a real roster. With no test
   * student set there is nowhere safe to send it, and the error says exactly that rather than
   * offering to message somebody at random.
   */
  testSend: adminProcedure.mutation(async ({ ctx }) => {
    const famId = testFamilyId();
    if (!famId) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Pick a test student first — that household is the one this test can safely go to.' });
    }

    /**
     * BOTH CHANNELS, and it succeeds if EITHER works (0.50.0-dev.5).
     *
     * It used to refuse outright unless the WhatsApp gateway was ready, which made the button useless
     * in the exact situation an office is in when they press it: setting the app up, before OpenWA is
     * installed on the server. Worse, the test student now governs the email pause too, so the one
     * thing an admin most wants to prove — that the exception works — could not be tested at all.
     *
     * So: try the email, try the WhatsApp, report what each did. It only fails when neither channel
     * could do anything, and then it says which.
     */
    const emailed = await sendTestToHousehold(famId);

    let whatsapp: 'queued' | 'paused' | 'opted_out' | 'no_number' | 'failed' | 'not_ready' = 'not_ready';
    /**
     * WHICH PHONE SHOULD RING (0.51.0). The button reported only "queued", and a household routinely
     * has two guardians — so an admin watching their own phone could be waiting on a number that was
     * never written to, with the screen agreeing that everything worked. It goes to whichever guardian
     * has a readable number, and now it says who and the last four digits.
     *
     * Live response only, never the log: §14 keeps numbers out of the trail, and this is being read by
     * an admin who can already see the guardian's full number on their record.
     */
    let whatsappTo: { name: string; masked: string } | null = null;
    const status = await currentWhatsAppStatus();
    if (getWhatsApp().enabled && status.available) {
      const to = familyRecipients(famId).filter((r) => !!r.to && !r.optedOut);
      whatsapp = to.length ? await notifyGuardian('test', to[0], waTest()) : 'no_number';
      if (to.length) whatsappTo = { name: to[0].name, masked: maskNumber(to[0].to) };
    }

    audit(auditActor(ctx), 'whatsapp.test', { entity: 'settings', detail: { emailed, whatsapp } });
    if (!emailed && whatsapp !== 'queued') {
      throw new TRPCError({
        code: 'BAD_GATEWAY',
        message:
          whatsapp === 'not_ready'
            ? 'Nothing could be sent: WhatsApp isn’t ready on this server, and there is no email address on that household either.'
            : 'That didn’t reach anybody. Check that the household has an email address or a WhatsApp number we can read.',
      });
    }
    return { emailed, whatsapp, whatsappTo };
  }),

  // ── Staff alerts to a group (0.50.0) ──────────────────────────────────────
  /**
   * The groups an admin approved for this app, and which STAFF ALERTS each one is subscribed to.
   *
   * A group here is a staff channel — a masjid's finance group getting every payment alert — and not
   * a way to reach parents: the events are the same `ALERT_EVENTS` a staff account can subscribe to,
   * and no parent event or free-typed message can be sent to a group at all.
   *
   * A confirmed-empty list HIDES the feature rather than showing it broken (the platform's own
   * guidance): the approval is somebody else's to give and to withdraw, so "no groups" is a normal
   * state and not an error. Read live on every call — a stale "yes you may" is worth a network hop.
   *
   * `reachable: false` is NOT that state and must not look like it. It means OpenMasjidOS did not
   * answer, and hiding the section on a hiccup is how a feature disappears with nothing said.
   *
   * `stale` is the other half of the same distinction, and it exists because of what happens when a
   * group comes BACK. Withdrawing approval does not delete what an admin ticked here — deleting it
   * would mean a five-minute platform outage silently wiped a configuration, which is far worse than
   * keeping it. But an un-approved group used to vanish from this screen while its stored
   * subscription lived on, so re-approving it — perhaps months later, perhaps for a different
   * purpose — silently resumed alerts nobody had re-ticked, `detail` and all. Showing the row is what
   * defuses that: an admin can see exactly what a group would resume with, and clear it if they meant
   * to. We only ever call a row stale when the platform positively answered without it.
   */
  groups: adminProcedure.query(async () => {
    const cfg = getWhatsApp();
    const status = await currentWhatsAppStatus();
    const list = await approvedGroups();
    const approved = list.ok ? list.groups : [];
    const subs = (id: string) => {
      const sub = cfg.groupAlerts[id];
      return {
        // Filtered against the catalog so a stale or hand-edited row cannot widen what a group hears.
        events: (sub?.events ?? []).filter((e): e is (typeof ALERT_EVENTS)[number] => (ALERT_EVENTS as readonly string[]).includes(e)),
        detail: sub?.detail === true,
      };
    };
    return {
      /** The catalog, so the UI never hard-codes the event list (same rule as every other screen). */
      events: ALERT_EVENTS,
      /** Did OpenMasjidOS actually answer? False means "could not ask", never "you have none". */
      reachable: list.ok,
      groups: approved.map((g) => ({ ...g, ...subs(g.id) })),
      /**
       * Subscriptions we hold for groups the platform no longer lists. Only computed from a confirmed
       * answer, so an unreachable platform never accuses a live group of being withdrawn.
       */
      stale: list.ok
        ? Object.keys(cfg.groupAlerts)
            .filter((id) => !approved.some((g) => g.id === id))
            .map((id) => ({ id, label: id.replace(/@g\.us$/, ''), ...subs(id) }))
        : [],
      ready: cfg.enabled && status.available,
    };
  }),

  /**
   * Subscribe a group to some alerts, and decide how much each one may say.
   *
   * `detail` is the field that matters. An alert carries two texts (§9) — one that may name a
   * household and an amount, one that names nobody — and which a group gets is the ADMIN's call,
   * because they can see who is in the group and this app cannot. It defaults off, and the screen puts
   * the consequence next to the switch rather than in a document.
   */
  groupSet: adminProcedure
    .input(
      z.object({
        groupId: z.string().trim().min(1).max(200),
        /** Validated against the catalog, so a stale client can never subscribe to an unknown id. */
        events: z.array(z.enum(ALERT_EVENTS)).max(ALERT_EVENTS.length),
        detail: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Only a group the admin has actually approved. The platform would refuse the send anyway, but a
      // setting stored against an id we were never given is a setting nobody can explain later.
      //
      // The two failures are told apart deliberately. "Not approved" sends an admin to OpenMasjidOS to
      // approve it; saying that when the truth is "we could not reach OpenMasjidOS" sends them to fix
      // something that is not broken, and they find the group already approved and no way forward.
      //
      // Three distinct causes, three distinct sentences. This one is ours: with the master switch off
      // there are no approved groups by definition, and the id check below would blame OpenMasjidOS
      // for a setting on this very screen — which a stale tab, or a second admin who just switched it
      // off, can reach. An admin sent to the platform finds the group approved and no way forward.
      if (!getWhatsApp().enabled) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'WhatsApp is switched off for this madrasah — turn it on first.' });
      }
      const approved = await groupIsApproved(input.groupId);
      if (approved === null) {
        throw new TRPCError({ code: 'BAD_GATEWAY', message: 'Couldn’t check with OpenMasjidOS just now. Try again in a moment.' });
      }
      if (!approved) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That group isn’t approved for this app in OpenMasjidOS.' });
      }
      const cur = getWhatsApp().groupAlerts[input.groupId];
      setWhatsApp({ groupAlerts: { [input.groupId]: { events: input.events, detail: input.detail ?? cur?.detail === true } } });
      audit(auditActor(ctx), 'whatsapp.groupAlerts', { entity: 'settings', detail: { groupId: input.groupId, events: input.events.length, detail: input.detail ?? cur?.detail === true } });
      return { ok: true as const };
    }),

  /**
   * Drop what we remember about a group the platform no longer lists.
   *
   * Deliberately NOT gated on the group being approved — it is the one group mutation that must work
   * for an id the platform has stopped offering, since that is the only situation it exists for. It
   * can only ever delete, so the widest thing it can do is forget something.
   */
  groupForget: adminProcedure.input(z.object({ groupId: z.string().trim().min(1).max(200) })).mutation(async ({ ctx, input }) => {
    // An empty event list is how `setWhatsApp` deletes a group row (settings/index.ts) — one rule for
    // "a group with nothing ticked is not a subscription", rather than a second removal path here.
    setWhatsApp({ groupAlerts: { [input.groupId]: { events: [], detail: false } } });
    audit(auditActor(ctx), 'whatsapp.groupForget', { entity: 'settings', detail: { groupId: input.groupId } });
    return { ok: true as const };
  }),

  /** "Does this group actually receive?" — a FIXED test message, never anything typed. This is not a
   *  composer, and a box that posts arbitrary text to a group is the misuse the design rules out. */
  groupTest: adminProcedure.input(z.object({ groupId: z.string().trim().min(1).max(200) })).mutation(async ({ ctx, input }) => {
    const outcome = await testGroup(input.groupId);
    audit(auditActor(ctx), 'whatsapp.groupTest', { entity: 'settings', detail: { groupId: input.groupId, outcome } });
    if (outcome !== 'queued') {
      throw new TRPCError({
        code: 'BAD_GATEWAY',
        message:
          outcome === 'off'
            ? 'WhatsApp is switched off for this madrasah.'
            : outcome === 'unavailable'
              ? 'WhatsApp isn’t ready on this server yet.'
              : outcome === 'unapproved'
                ? 'That group isn’t approved for this app in OpenMasjidOS any more.'
                : 'That didn’t reach the queue. The group may no longer be approved in OpenMasjidOS — check there, then try again.',
      });
    }
    return { ok: true as const };
  }),

  /**
   * What we handed to the queue, most recent first — never the message itself (§14).
   *
   * Names are resolved at READ time from the guardian and staff rows this points at, so the log adds
   * no personal data of its own and a corrected name is corrected here too.
   */
  log: adminProcedure.input(z.object({ limit: z.number().int().min(1).max(500).optional() })).query(async ({ input }) => {
    const rows = db.select().from(whatsappLog).orderBy(desc(whatsappLog.createdAt)).limit(input.limit ?? 100).all();
    const guardianIds = rows.filter((r) => r.recipientKind === 'guardian').map((r) => r.recipientId);
    const staffIds = rows.filter((r) => r.recipientKind === 'staff').map((r) => r.recipientId);
    const names = new Map<string, string>();
    if (guardianIds.length) for (const g of db.select({ id: guardians.id, name: guardians.name }).from(guardians).where(inArray(guardians.id, guardianIds)).all()) names.set(g.id, g.name);
    if (staffIds.length) {
      for (const u of db.select({ id: users.id, username: users.username, displayName: users.displayName }).from(users).where(inArray(users.id, staffIds)).all()) {
        names.set(u.id, u.displayName?.trim() || u.username);
      }
    }
    // Group rows point at an opaque platform id, so the label has to come from the platform too —
    // and only when there is actually a group row to name, so the common case pays nothing. A group
    // whose approval has since been withdrawn falls through to the id, which is still true history.
    if (rows.some((r) => r.recipientKind === 'group')) {
      const list = await approvedGroups();
      if (list.ok) for (const g of list.groups) names.set(g.id, g.label);
    }
    const famIds = [...new Set(rows.map((r) => r.familyId).filter((v): v is string => !!v))];
    const labels = new Map<string, string>();
    if (famIds.length) for (const f of db.select({ id: families.id, name: families.name }).from(families).where(inArray(families.id, famIds)).all()) labels.set(f.id, f.name);

    return rows.map((r) => ({
      id: r.id,
      event: r.event,
      kind: r.recipientKind,
      /** '(removed)' rather than a blank when the person is gone — the row is still true history. A
       *  group that is no longer approved shows its id, which is at least unambiguous. */
      who: names.get(r.recipientId) ?? (r.recipientKind === 'group' ? r.recipientId.replace(/@g\.us$/, '') : '(removed)'),
      household: r.familyId ? (labels.get(r.familyId) ?? null) : null,
      status: r.status,
      reason: r.reason,
      at: r.createdAt,
    }));
  }),
});
