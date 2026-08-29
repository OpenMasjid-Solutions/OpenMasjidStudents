// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** App settings (admin-only): the school's name, currency, logo, color and date format; how it appears
 *  to parents; who hears about what by email; the past-due policy; and the Stripe account (from the OS
 *  vault) that tuition charges go through. A few reads are admin OR finance where finance needs them. */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { asc, eq, isNotNull } from 'drizzle-orm';
import { router, adminProcedure, adminOrFinanceProcedure, auditActor } from './trpc';
import { db } from '../db';
import { families, guardians, guardianFamilies, paymentMethods, autopayEnrollments, alertRecipients, students } from '../db/schema';
import { rid } from '../db/ids';
import { SETTING_KEYS, getSchoolName, getCurrency, getSelfRegistrationEnabled, getExternalPaymentsEnabled, setSetting, getChosenStripeAccount, setChosenStripeAccount, getSchoolLogo, setSchoolLogo, getParentEmails, setParentEmails, getParentMailPaused, setParentMailPaused, getWebhookNamesStudent, setWebhookNamesStudent, getSchoolContact, setSchoolContact, getAccentColor, setAccentColor, getSheetTextOverrides, setSheetTextOverrides, donationUrl, getPastDue, setPastDue, getPastDueStaffLast, getProcessingFee, setProcessingFee, getOnboardingText, setOnboardingText } from '../settings';
import { SHEET_TEXT_DEFAULTS, SHEET_TEXT_KEYS, SHEET_TEXT_MAX, SHEET_TEXT_TAGS } from '../people/sheetText';
import { ONBOARDING_DEFAULTS, ONBOARDING_KEYS, ONBOARDING_MAX, ONBOARDING_TAGS, onboardingWhatsApp, renderOnboarding } from '../people/onboarding';
import { testFamilyId } from '../settings/testStudent';
import { familyVars } from '../whatsapp';
import { dueForChasing, pastDueFamilies, runPastDue } from '../billing/pastDue';
import { DATE_FORMATS, DATE_FORMAT_SAMPLES, getDateFormat, setDateFormat } from '../settings/dates';
import { ALERT_EVENTS, defaultEvents, listRecipients, sendAlertTest, type AlertEvent } from '../alerts';
import { audit } from '../audit';
import { mailAvailable, sendTestEmail } from '../mail/notify';
import { portalBase } from '../auth/invites';
import { cachedPublicUrl } from '../fabric/platform';
import { fabricConfigured, config } from '../config';
import { stripeReady, stripeAccountId, loadStripeKeys } from '../payments/stripe';
import { FEE_EXAMPLE_CENTS, feeQuote } from '../payments/fees';
import { fetchStripeAccounts } from '../fabric/platform';

export const settingsRouter = router({
  get: adminProcedure.query(() => ({
    schoolName: getSchoolName(),
    currency: getCurrency(),
    selfRegistration: getSelfRegistrationEnabled(),
    externalPayments: getExternalPaymentsEnabled(),
    logo: getSchoolLogo(),
    contact: getSchoolContact(),
    /** What the website + donations path actually resolve to, so Settings shows the line a parent will
     *  read rather than making an admin assemble it in their head. */
    donateUrl: donationUrl(),
    dateFormat: getDateFormat(),
    accentColor: getAccentColor(),
    /** Rendered samples, so the settings screen shows each option rather than naming it. */
    dateFormats: DATE_FORMATS.map((f) => ({ value: f, sample: DATE_FORMAT_SAMPLES[f] })),
  })),

  /**
   * The handful of settings the NON-admin screens need (0.47.0).
   *
   * Admin | finance, unlike `get` above, because the year view and the directory are finance screens
   * and they have to render dates in the masjid's chosen format. It carries only presentation — no
   * Stripe account, no toggles, nothing that says anything about how the install is configured.
   */
  display: adminOrFinanceProcedure.query(() => ({
    dateFormat: getDateFormat(),
    accentColor: getAccentColor(),
    currency: getCurrency(),
  })),

  /**
   * Upload (or clear, with `null`) the school logo — it goes on printed statements and every
   * outgoing email, so a family sees the madrasa's own mark rather than generic text.
   *
   * The browser sends a `data:` URI it built from the chosen file. The server re-validates by MAGIC
   * BYTES rather than trusting the declared type, because this value is later served back over HTTP
   * with that content type (§14). Anything else is refused with a sentence the admin can act on.
   */
  logoSet: adminProcedure.input(z.object({ dataUri: z.string().max(1_400_000).nullable() })).mutation(({ ctx, input }) => {
    try {
      setSchoolLogo(input.dataUri);
    } catch {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'That file isn’t a PNG, JPEG or WebP image under 512 KB. Try exporting it again.' });
    }
    audit(auditActor(ctx), input.dataUri ? 'settings.logoSet' : 'settings.logoClear', { entity: 'settings' });
    return { ok: true as const };
  }),

  set: adminProcedure
    .input(
      z.object({
        schoolName: z.string().trim().max(160).optional(),
        currency: z.enum(['usd', 'cad', 'gbp', 'eur']).optional(),
        selfRegistration: z.boolean().optional(),
        externalPayments: z.boolean().optional(),
        dateFormat: z.enum(DATE_FORMATS).optional(),
        /** Bounded well below anything a printed footer could hold — this lands on a sheet, not in a CRM. */
        contact: z
          .object({
            address: z.string().trim().max(240).optional(),
            phone: z.string().trim().max(60).optional(),
            email: z.string().trim().max(200).optional(),
            website: z.string().trim().max(200).optional(),
            /** `/donate`, or a whole address when the donations page is on another domain (§ settings). */
            donatePath: z.string().trim().max(200).optional(),
          })
          .optional(),
        /** `''` clears it back to the default teal. */
        accentColor: z.union([z.string().trim().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/), z.literal('')]).optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      if (input.schoolName !== undefined) setSetting(SETTING_KEYS.schoolName, input.schoolName);
      if (input.currency !== undefined) setSetting(SETTING_KEYS.currency, input.currency);
      if (input.selfRegistration !== undefined) setSetting(SETTING_KEYS.selfRegistration, input.selfRegistration ? '1' : '0');
      if (input.externalPayments !== undefined) setSetting(SETTING_KEYS.externalPayments, input.externalPayments ? '1' : '0');
      if (input.dateFormat !== undefined) setDateFormat(input.dateFormat);
      if (input.contact !== undefined) setSchoolContact(input.contact);
      if (input.accentColor !== undefined) setAccentColor(input.accentColor);
      // Key names only — an address and a phone number are the masjid's, but there is no reason to
      // copy them into the audit trail to record that they changed (§14).
      audit(auditActor(ctx), 'settings.update', { entity: 'settings', detail: { keys: Object.keys(input) } });
      return { ok: true as const };
    }),

  /**
   * The wording on the printed family sheet (0.48.0) — the catalog, the shipped sentences, and this
   * madrasah's own versions of them.
   *
   * The whole registry comes from the server (people/sheetText.ts owns it), so the UI hard-codes no
   * sentence and no tag list: adding a box there makes a new field appear in Settings with no change on
   * the browser side, exactly like the alert catalog above.
   */
  sheetTextGet: adminProcedure.query(() => ({
    keys: [...SHEET_TEXT_KEYS],
    defaults: SHEET_TEXT_DEFAULTS,
    /** Only the boxes this madrasah actually changed; everything else falls through to `defaults`. */
    overrides: getSheetTextOverrides(),
    tags: [...SHEET_TEXT_TAGS],
    maxLength: SHEET_TEXT_MAX,
  })),

  /**
   * The onboarding message's wording (0.51.0) — the same served-registry shape as the sheet above, so the
   * UI hard-codes no sentence and adding a box needs no change on the browser side.
   *
   * `preview` is rendered against a REAL household — the test student's when one is set, otherwise the
   * first on the roster — because the tags are the whole point of checking: an office wants to see what
   * `[children]` and `[portal]` actually resolve to, not the template with brackets in it. Both channel
   * forms are returned, since the WhatsApp one carries the extra which-number line and an office should
   * be able to read the two side by side before writing to two hundred families.
   */
  onboardingTextGet: adminProcedure.query(() => {
    // The same choice of sample household the WhatsApp template preview makes (trpc/whatsapp.ts): the
    // test student's if the office has set one — they picked it precisely so previews are recognizable —
    // otherwise whoever is first on the roster.
    const fam = testFamilyId() ?? db.select({ id: families.id }).from(families).orderBy(asc(families.name)).get()?.id ?? null;
    const vars = fam ? familyVars(fam) : { family: 'the Ismail family', children: ['Yusuf', 'Maryam'], portal: portalBase() ? `${portalBase()}/family` : '' };
    return {
      keys: [...ONBOARDING_KEYS],
      defaults: ONBOARDING_DEFAULTS,
      overrides: getOnboardingText(),
      tags: [...ONBOARDING_TAGS],
      maxLength: ONBOARDING_MAX,
      /** Whether that preview is a real household or the worked example — the screen says which. */
      sample: fam ? 'household' : ('example' as const),
      preview: {
        subject: renderOnboarding('subject', vars),
        email: renderOnboarding('body', vars),
        whatsapp: onboardingWhatsApp(vars),
      },
    };
  }),

  onboardingTextSet: adminProcedure
    .input(
      z.union([
        z.object({ boxes: z.array(z.object({ key: z.enum(ONBOARDING_KEYS), text: z.string().max(ONBOARDING_MAX) })).min(1).max(ONBOARDING_KEYS.length) }),
        z.object({ reset: z.literal(true) }),
      ]),
    )
    .mutation(({ ctx, input }) => {
      if ('reset' in input) {
        setOnboardingText(Object.fromEntries(ONBOARDING_KEYS.map((k) => [k, null])));
        audit(auditActor(ctx), 'settings.onboardingTextReset', { entity: 'settings' });
        return { ok: true as const };
      }
      setOnboardingText(Object.fromEntries(input.boxes.map((b) => [b.key, b.text])));
      // Key names only. The wording is the school's own prose rather than personal data, but there is no
      // reason to copy paragraphs of it into the audit trail to record that it changed (§14).
      audit(auditActor(ctx), 'settings.onboardingText', { entity: 'settings', detail: { keys: input.boxes.map((b) => b.key) } });
      return { ok: true as const };
    }),

  /**
   * Save changed boxes. A box sent as `''` goes back to the shipped sentence — that is what clearing the
   * field means, and storing blank wording would print an empty line on a family's sheet.
   *
   * Sent as a LIST of key/text pairs rather than a free-form object so every key is validated against the
   * registry: an unknown key is refused at the boundary instead of being stored and silently ignored.
   */
  sheetTextSet: adminProcedure
    .input(
      z.object({
        boxes: z
          .array(z.object({ key: z.enum(SHEET_TEXT_KEYS), text: z.string().max(SHEET_TEXT_MAX) }))
          .max(SHEET_TEXT_KEYS.length)
          .optional(),
        /** Put every sentence back to the shipped wording. */
        reset: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const patch: Record<string, string> = {};
      if (input.reset) for (const k of SHEET_TEXT_KEYS) patch[k] = '';
      for (const b of input.boxes ?? []) patch[b.key] = b.text;
      setSheetTextOverrides(patch);
      // Key names only. The text itself is the school's own prose rather than anybody's personal data, but
      // there is no reason to copy paragraphs of it into the audit trail to record that it changed (§14).
      audit(auditActor(ctx), 'settings.sheetText', { entity: 'settings', detail: { keys: Object.keys(patch), reset: !!input.reset } });
      return { ok: true as const };
    }),

  /**
   * Can this install actually reach a parent? Every "invite/reset didn't arrive" report comes down to
   * one of these three, and until now all three failed SILENTLY:
   *   - no absolute public URL  → invite/reset links are un-emailable (Remote access is off)
   *   - no mail transport       → nothing can be sent at all
   *   - no notification webhook → staff alerts go nowhere
   * Read-only diagnostics; admin OR finance, because finance is who sends invites.
   */
  linkStatus: adminOrFinanceProcedure.query(() => {
    const base = portalBase();
    const live = cachedPublicUrl();
    return {
      fabric: fabricConfigured(),
      publicUrl: base,
      /** Where the URL came from — `platform` is authoritative, `env` is the install-time mirror. */
      publicUrlSource: live ? ('platform' as const) : config.omosPublicUrl ? ('env' as const) : ('none' as const),
      /** We declare `email: true`, so the platform can send for us whenever the Fabric is wired up. */
      platformMail: fabricConfigured(),
      mailAvailable: mailAvailable(),
      selfRegistrationOn: getSelfRegistrationEnabled(),
      /** The toggle being on is not enough — the verify link is emailed. */
      selfRegistrationAvailable: getSelfRegistrationEnabled() && mailAvailable() && !!base,
    };
  }),

  /**
   * Send a test email through OpenMasjidOS.
   *
   * There are no SMTP settings in this app any more — the OS owns the mail provider and the From
   * address, so a masjid configures email once, there. What is still worth having is a way to prove it
   * reaches somebody, which is what this is.
   *
   * The platform answers HTTP 200 with `{sent:false, reason}` when it has no provider configured, so a
   * failure here is reported as a real failure rather than a cheerful success.
   *
   * It goes through `sendTestEmail` in mail/notify.ts rather than composing here, so the test carries
   * the school's logo exactly like a real invite or receipt — the whole point is seeing what a parent
   * will see.
   */
  mailTest: adminProcedure.input(z.object({ to: z.string().trim().email().max(320) })).mutation(async ({ ctx, input }) => {
    if (!fabricConfigured()) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'This app isn’t connected to OpenMasjidOS yet, so it can’t send email.' });
    }
    const sent = await sendTestEmail(input.to);
    audit(auditActor(ctx), 'settings.mailTest', { entity: 'settings', detail: { sent } });
    if (!sent) {
      throw new TRPCError({
        code: 'BAD_GATEWAY',
        message: 'OpenMasjidOS couldn’t send it. Check that email is set up in OpenMasjidOS → Settings, then try again.',
      });
    }
    return { ok: true as const };
  }),

  // ── Email alerts (0.44.0) ──────────────────────────────────────────────────
  /**
   * Who gets told what, and which emails parents receive.
   *
   * Admin-only, like every other setting (§5). Finance sees alerts arrive in their inbox but does not
   * choose the list — an address on it is a standing grant of information about families, and that is
   * the office's decision.
   */
  alertsGet: adminProcedure.query(() => ({
    /** The catalog, so the UI never hard-codes the event list. */
    events: ALERT_EVENTS,
    recipients: listRecipients(),
    parentEmails: getParentEmails(),
    /** The master stop — nothing at all goes to a parent while it is on (0.48.0). */
    parentMailPaused: getParentMailPaused(),
    /** May the masjid's webhook name the child on a payment notice (0.51.0-dev.17)? Off by default. */
    webhookNamesStudent: getWebhookNamesStudent(),
    /** Nothing can be delivered without a transport; the UI says so rather than looking broken. */
    mailAvailable: mailAvailable(),
  })),

  /**
   * Add an address, or change one (same procedure — a repeated email UPDATES rather than failing on the
   * unique index, which is what an admin means when they re-add someone).
   */
  alertRecipientSave: adminProcedure
    .input(
      z.object({
        id: z.string().trim().max(64).optional(),
        email: z.string().trim().email().max(320),
        label: z.string().trim().max(80).optional(),
        /** Validated against the catalog, so a stale client can never subscribe to an unknown id. */
        events: z.array(z.enum(ALERT_EVENTS)).max(ALERT_EVENTS.length).optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const email = input.email.toLowerCase();
      const ts = new Date();
      const existing = input.id
        ? db.select().from(alertRecipients).where(eq(alertRecipients.id, input.id)).get()
        : db.select().from(alertRecipients).where(eq(alertRecipients.email, email)).get();
      // A brand-new recipient starts on the alerts that cost money or hide an attack, not on everything:
      // an inbox full of routine payments is how somebody mutes the whole channel.
      const events: AlertEvent[] = input.events ?? (existing ? ((existing.events ?? []) as AlertEvent[]) : defaultEvents());
      if (existing) {
        db.update(alertRecipients).set({ email, label: input.label?.trim() || null, events, updatedAt: ts }).where(eq(alertRecipients.id, existing.id)).run();
        audit(auditActor(ctx), 'alerts.recipientUpdate', { entity: 'settings', entityId: existing.id, detail: { events: events.length } });
        return { id: existing.id };
      }
      const id = rid('alr');
      db.insert(alertRecipients).values({ id, email, label: input.label?.trim() || null, events, createdAt: ts, updatedAt: ts }).run();
      audit(auditActor(ctx), 'alerts.recipientAdd', { entity: 'settings', entityId: id, detail: { events: events.length } });
      return { id };
    }),

  alertRecipientRemove: adminProcedure.input(z.object({ id: z.string().trim().max(64) })).mutation(({ ctx, input }) => {
    db.delete(alertRecipients).where(eq(alertRecipients.id, input.id)).run();
    audit(auditActor(ctx), 'alerts.recipientRemove', { entity: 'settings', entityId: input.id });
    return { ok: true as const };
  }),

  /** "Does this actually reach you?" — the same question the mail test answers, per recipient. */
  alertTest: adminProcedure.input(z.object({ id: z.string().trim().max(64) })).mutation(async ({ ctx, input }) => {
    const sent = await sendAlertTest(input.id);
    audit(auditActor(ctx), 'alerts.test', { entity: 'settings', entityId: input.id, detail: { sent } });
    if (!sent) {
      throw new TRPCError({
        code: 'BAD_GATEWAY',
        message: 'That didn’t send. Check that email is set up in OpenMasjidOS → Settings, then try again.',
      });
    }
    return { ok: true as const };
  }),

  /**
   * The master stop: hold ALL parent email, invites and resets included (0.48.0).
   *
   * Separate from `parentEmailsSet` because it is a different kind of decision — not "which
   * notifications does this madrasah send" but "do not write to anybody while I am working on this".
   * Audited both ways: turning it back ON is the change somebody will want a record of.
   */
  parentMailPauseSet: adminProcedure.input(z.object({ paused: z.boolean() })).mutation(({ ctx, input }) => {
    setParentMailPaused(input.paused);
    audit(auditActor(ctx), 'settings.parentMailPause', { entity: 'settings', detail: { paused: input.paused } });
    return { ok: true as const };
  }),

  /**
   * Let the masjid's webhook name the child on a payment notice (0.51.0-dev.17).
   *
   * Its own procedure, and audited both ways, for the reason the pause above gives: this is not "which
   * notifications does this madrasah send" but a decision about how much a channel we cannot see is
   * told about a family. Turning it ON is the entry somebody will want to find later, and turning it
   * back off equally so.
   *
   * Admin, never finance — the same wall as the recipient list, and for the same stated reason: opening
   * a channel is a standing grant of information about families, which is the office's call (§5).
   */
  webhookNamesSet: adminProcedure.input(z.object({ on: z.boolean() })).mutation(({ ctx, input }) => {
    setWebhookNamesStudent(input.on);
    audit(auditActor(ctx), 'settings.webhookNames', { entity: 'settings', detail: { on: input.on } });
    return { ok: true as const };
  }),

  /**
   * Students the madrasah cannot email (0.48.0).
   *
   * Email is how this app reaches a family — receipts, invites, resets, past-due reminders — and a
   * household with no address on file silently receives none of it. Nothing surfaced that before: the
   * sends just returned 0 and the office found out when a parent said they never heard anything.
   *
   * The list is per CHILD because that is who the office looks up, but the condition is per HOUSEHOLD:
   * guardians attach to the household (§9), so a child is unreachable when NOBODY on their household has
   * an address. Guardian names and phones come with it — the point of the list is to be able to ring
   * them and ask, which needs a number.
   *
   * Active students only. A withdrawn child's bill is still owed, but nobody is chasing an address for a
   * family that has left.
   */
  noEmailStudents: adminOrFinanceProcedure.query(() => {
    const withEmail = new Set(
      db
        .select({ familyId: guardianFamilies.familyId, email: guardians.email })
        .from(guardianFamilies)
        .innerJoin(guardians, eq(guardians.id, guardianFamilies.guardianId))
        .all()
        .filter((g) => (g.email ?? '').includes('@'))
        .map((g) => g.familyId),
    );

    const contacts = new Map<string, { name: string; phone: string | null }[]>();
    for (const g of db
      .select({ familyId: guardianFamilies.familyId, name: guardians.name, phone: guardians.phone })
      .from(guardianFamilies)
      .innerJoin(guardians, eq(guardians.id, guardianFamilies.guardianId))
      .all()) {
      if (withEmail.has(g.familyId)) continue;
      if (!contacts.has(g.familyId)) contacts.set(g.familyId, []);
      contacts.get(g.familyId)!.push({ name: g.name, phone: g.phone });
    }

    const rows = db
      .select({ id: students.id, fullName: students.fullName, familyId: students.familyId, familyLabel: families.name })
      .from(students)
      .innerJoin(families, eq(families.id, students.familyId))
      .where(eq(students.status, 'active'))
      .orderBy(asc(families.name), asc(students.fullName))
      .all()
      .filter((s) => !withEmail.has(s.familyId));

    return {
      total: rows.length,
      /** Households, not children — how many phone calls this actually is. */
      households: new Set(rows.map((r) => r.familyId)).size,
      students: rows.map((s) => ({
        id: s.id,
        fullName: s.fullName,
        familyId: s.familyId,
        familyLabel: s.familyLabel,
        /** Empty means there is no adult on the record at all, which is a different problem again. */
        guardians: contacts.get(s.familyId) ?? [],
      })),
    };
  }),

  /**
   * Chasing overdue balances (0.48.0) — the settings, plus what they would do right now.
   *
   * The preview is not decoration: `parentEmails` starts OFF, and an admin about to switch on automatic
   * money emails to real families deserves to see how many of them, for how much, before they do.
   */
  pastDueGet: adminProcedure.query(() => {
    const cfg = getPastDue();
    const today = new Date().toISOString().slice(0, 10);
    const all = pastDueFamilies(today);
    const chase = dueForChasing(today, cfg);
    return {
      ...cfg,
      currency: getCurrency(),
      /** Everybody with a due date behind them… */
      overdueFamilies: all.length,
      overdueCents: all.reduce((s, f) => s + f.amountCents, 0),
      /** …and the subset this configuration would actually write to. */
      chaseFamilies: chase.length,
      chaseCents: chase.reduce((s, f) => s + f.amountCents, 0),
      staffLastSent: getPastDueStaffLast(),
      mailAvailable: mailAvailable(),
      parentMailPaused: getParentMailPaused(),
    };
  }),

  pastDueSet: adminProcedure
    .input(
      z.object({
        parentEmails: z.boolean().optional(),
        graceDays: z.number().int().min(0).max(90).optional(),
        everyDays: z.number().int().min(1).max(90).optional(),
        minAmountCents: z.number().int().min(0).max(1_000_000).optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      setPastDue(input);
      audit(auditActor(ctx), 'settings.pastDue', { entity: 'settings', detail: { ...input } });
      return { ok: true as const };
    }),

  /**
   * The processing-fee policy, plus a worked example (0.51.0).
   *
   * The examples are computed by the SAME function that will charge the card, not written into the copy.
   * An office deciding whether to switch this on is really asking "what will a parent see?", and a
   * hand-written "about 3%" would drift from the arithmetic the moment either changed — which on this
   * screen is the difference between an informed decision and a surprise on 200 cards.
   */
  processingFeeGet: adminProcedure.query(() => {
    const cfg = getProcessingFee();
    // The amounts live in payments/fees.ts, because the printed family sheet quotes one of them too and
    // a parent's copy on paper must not work from a different bill than the office decided on.
    const examples = FEE_EXAMPLE_CENTS.map((net) => ({
      netCents: net,
      card: feeQuote(net, 'card', { ...cfg, enabled: true }),
      bank: feeQuote(net, 'bank', { ...cfg, enabled: true, bankEnabled: true }),
    }));
    return { ...cfg, currency: getCurrency(), examples, stripeReady: stripeReady() };
  }),

  processingFeeSet: adminProcedure
    .input(
      z.object({
        enabled: z.boolean().optional(),
        cardPercentBps: z.number().int().min(0).max(1000).optional(),
        cardFixedCents: z.number().int().min(0).max(1000).optional(),
        bankEnabled: z.boolean().optional(),
        bankPercentBps: z.number().int().min(0).max(1000).optional(),
        bankFixedCents: z.number().int().min(0).max(1000).optional(),
        bankCapCents: z.number().int().min(0).max(100_000).optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      setProcessingFee(input);
      // Audited like every other money-path setting: this one changes what every parent is charged, so
      // "when did this start?" has to be answerable from the trail.
      audit(auditActor(ctx), 'settings.processingFee', { entity: 'settings', detail: { ...input } });
      return { ok: true as const };
    }),

  /**
   * Run it now.
   *
   * `force` overrides the cadence — a person pressed the button, which is a different thing from a cron
   * tick, and an office that has just fixed a due date wants today's reminders to go today. It cannot
   * override the parent-mail pause, the parentEmails switch, or a missing address: those are decisions
   * and facts, not timing.
   */
  pastDueRunNow: adminProcedure.mutation(async ({ ctx }) => {
    const r = await runPastDue(new Date().toISOString().slice(0, 10), { force: true });
    audit(auditActor(ctx), 'settings.pastDueRun', { entity: 'settings', detail: { overdue: r.overdue, emailed: r.emailed, messaged: r.messaged } });
    return r;
  }),

  /** Which emails PARENTS get. Invites and password resets are not here — they always send (§ settings). */
  parentEmailsSet: adminProcedure
    .input(
      z.object({
        receipt: z.boolean().optional(),
        autopayFailure: z.boolean().optional(),
        // Added in 0.50.0, all defaulting off (§ settings/getParentEmails).
        invoiceReady: z.boolean().optional(),
        autopayUpcoming: z.boolean().optional(),
        cardExpiring: z.boolean().optional(),
        refund: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
    setParentEmails(input);
    audit(auditActor(ctx), 'settings.parentEmails', { entity: 'settings', detail: { ...input } });
    return { ok: true as const };
  }),

  // ── Payments: which OS-vault Stripe account tuition charges go through (§10). The account LIST comes
  // from OpenMasjidOS (id + label only — keys never touch this router); the admin picks one and it
  // applies immediately (no restart). Card keys stay in server memory (payments/stripe.ts).
  stripeAccountsGet: adminProcedure.query(async () => {
    const accounts = await fetchStripeAccounts();
    return { accounts, chosenId: getChosenStripeAccount(), ready: stripeReady(), activeId: stripeAccountId() };
  }),
  stripeAccountSet: adminProcedure.input(z.object({ accountId: z.string().trim().max(120) })).mutation(async ({ ctx, input }) => {
    const prevActive = stripeAccountId(); // the account currently loaded (null if none)
    setChosenStripeAccount(input.accountId);
    const ok = await loadStripeKeys(); // apply the choice now — reload keys for the new account
    // A successful switch to a DIFFERENT account invalidates every family's saved Stripe state: their
    // Customer + saved cards live on the OLD account and can't be charged on the new one. Clear them so
    // pay-now mints a fresh Customer and parents re-add cards; autopay is turned off. The ledger and
    // payment history are account-agnostic and untouched.
    let reset = false;
    if (ok && prevActive && prevActive !== stripeAccountId()) {
      const ts = new Date();
      db.update(autopayEnrollments).set({ enabled: false, defaultPmId: null, updatedAt: ts }).run(); // null the FK before deleting PMs
      db.delete(paymentMethods).run();
      db.update(families).set({ stripeCustomerId: null, updatedAt: ts }).where(isNotNull(families.stripeCustomerId)).run();
      reset = true;
    }
    audit(auditActor(ctx), 'settings.stripe.account', { entity: 'settings', detail: { accountId: input.accountId, reset } });
    return { ok, ready: stripeReady(), reset };
  }),
});
