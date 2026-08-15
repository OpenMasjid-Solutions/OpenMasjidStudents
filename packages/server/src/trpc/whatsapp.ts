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
import { getCurrency } from '../settings';
import { formatDate } from '../settings/dates';
import { formatMoney } from '../db/money';
import { fabricConfigured } from '../config';

/**
 * How many households one press of the outreach button writes to.
 *
 * A real cap, stated out loud rather than hidden: the sending allowance belongs to the masjid's NUMBER
 * and is shared with every other app on the server, so handing the queue two hundred messages in one
 * go is precisely the behaviour that gets a number restricted. The screen reports how many are left so
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
   * said "Not ready" and greyed out the Send-a-test button on an install that was working perfectly.
   * One request on an admin settings render is the right trade for that.
   */
  get: adminProcedure.query(async () => {
    const cfg = getWhatsApp();
    const testFam = testFamilyId();
    const testStudent = cfg.testStudentId
      ? db.select({ id: students.id, fullName: students.fullName, familyId: students.familyId, status: students.status }).from(students).where(eq(students.id, cfg.testStudentId)).get()
      : null;
    return {
      ...cfg,
      /** The catalogues, so the UI hard-codes no event list (same rule as the alert screen). */
      parentEvents: WA_PARENT_EVENTS,
      staffEvents: ALERT_EVENTS,
      status: await currentWhatsAppStatus(),
      /** Without the Fabric there is no platform to ask, so the feature cannot work at all. */
      fabric: fabricConfigured(),
      testStudent: testStudent ? { id: testStudent.id, fullName: testStudent.fullName, familyId: testStudent.familyId, active: testStudent.status === 'active' } : null,
      /** Null while a test student is set but no longer resolves — a withdrawn child, or one deleted.
       *  Said explicitly, because "paused, and the exception silently stopped working" is invisible. */
      testFamilyId: testFam,
      emailRequest: { text: getWhatsAppEmailRequest(), fallback: WA_EMAIL_REQUEST_DEFAULT, tags: [...WA_EMAIL_REQUEST_TAGS], maxLength: WA_TEXT_MAX },
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
        /** One event at a time, validated against the catalogue so a stale client cannot invent one. */
        event: z.object({ id: z.enum(WA_PARENT_EVENTS), on: z.boolean() }).optional(),
        defaultCountry: z.string().trim().max(5).optional(),
        countries: z.array(z.string().trim().max(5)).max(20).optional(),
        /** '' clears it — the household stops being the exception to the pause. */
        testStudentId: z.string().trim().max(64).optional(),
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
   * The wording of every parent message: the catalogue, the shipped sentences, this madrasah's own
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
    const status = await currentWhatsAppStatus();
    if (!status.available) throw new TRPCError({ code: 'BAD_GATEWAY', message: 'WhatsApp isn’t ready on this server yet.' });
    const to = familyRecipients(famId).filter((r) => !!r.to && !r.optedOut);
    if (!to.length) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Nobody on that household has a WhatsApp number we can read.' });
    }
    const outcome = await notifyGuardian('test', to[0], waTest());
    audit(auditActor(ctx), 'whatsapp.test', { entity: 'settings', detail: { outcome } });
    if (outcome !== 'queued') throw new TRPCError({ code: 'BAD_GATEWAY', message: 'That didn’t reach the queue. Check WhatsApp in OpenMasjidOS, then try again.' });
    return { ok: true as const };
  }),

  /**
   * What we handed to the queue, most recent first — never the message itself (§14).
   *
   * Names are resolved at READ time from the guardian and staff rows this points at, so the log adds
   * no personal data of its own and a corrected name is corrected here too.
   */
  log: adminProcedure.input(z.object({ limit: z.number().int().min(1).max(500).optional() })).query(({ input }) => {
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
    const famIds = [...new Set(rows.map((r) => r.familyId).filter((v): v is string => !!v))];
    const labels = new Map<string, string>();
    if (famIds.length) for (const f of db.select({ id: families.id, name: families.name }).from(families).where(inArray(families.id, famIds)).all()) labels.set(f.id, f.name);

    return rows.map((r) => ({
      id: r.id,
      event: r.event,
      kind: r.recipientKind,
      /** '(removed)' rather than a blank when the person is gone — the row is still true history. */
      who: names.get(r.recipientId) ?? '(removed)',
      household: r.familyId ? (labels.get(r.familyId) ?? null) : null,
      status: r.status,
      reason: r.reason,
      at: r.createdAt,
    }));
  }),
});
