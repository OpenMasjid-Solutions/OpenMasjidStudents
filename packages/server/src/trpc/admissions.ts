// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * THE ADMISSIONS DESK (0.52.0, CLAUDE.md §4a Phase 2, docs/ADMISSIONS.md).
 *
 * Every procedure here is `adminProcedure`, which is the whole access story and is not a default
 * anybody may relax:
 *
 *  - **Finance does not reach admissions records at all** (§5). They are not money, and finance's
 *    wall is the one this app already holds. There is no filtered view for finance — a finance
 *    session is answered `FORBIDDEN`.
 *  - `adminProcedure` enforces §12.4 at session-USE time, not only at login, so the whole desk is
 *    **LAN-only** for free. That is correct and is not being weakened to make admissions more
 *    convenient. Its consequence is worth stating rather than working around: an office cannot read
 *    an inquiry from home, and `cf-ray` short-circuits before the client IP is examined, so a phone
 *    on masjid Wi-Fi that opened the bookmarked public URL is still `tunnel`.
 *  - Parents reach nothing here. The only thing a family ever touches is the public form and, later,
 *    their own one-time token link — neither of which is a tRPC procedure.
 *
 * The PUBLIC side of admissions is deliberately not in this file: it is plain Fastify routes in
 * `admissions/publicRoutes.ts`, outside this middleware entirely, with every control written out.
 *
 * State changes go through `admissions/transition.ts` and nowhere else (§16), which is what keeps the
 * `inquiry_events` trail and the audit row from ever disagreeing — and what makes `admitted`
 * unreachable from here, since a student existing is what that state means.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { router, adminProcedure, auditActor, recordingActor } from './trpc';
import { db } from '../db';
import { feePlans, inquiries, inquiryEvents, schoolYears, schools, type InquiryState } from '../db/schema';
import { audit } from '../audit';
import { canTransition, inquiryById, reorderWaitlist, transitionInquiry, TransitionRefused, type OfficeTransition } from '../admissions/transition';
import { INQUIRY_CAPS, storeInquiry } from '../admissions/inquiry';
import { ADMISSIONS_TEXT_DEFAULTS, ADMISSIONS_TEXT_KEYS } from '../admissions/text';
import { conversionPreview, convertInquiry } from '../admissions/convert';
import { resolveEnrollmentFee } from '../admissions/fees';
import { isIsoDay } from '../settings/dates';
import {
  ADMISSIONS_TEXT_CAP,
  MAX_EMBED_ORIGINS,
  getAdmissions,
  getAdmissionsText,
  getCurrency,
  isEmbedOrigin,
  setAdmissions,
  setAdmissionsText,
} from '../settings';
import { cachedPublicUrl } from '../fabric/platform';
import { config } from '../config';

const ID = z.string().min(1).max(64);
/** Everything the office may move an inquiry to. `admitted` is absent and that is the enforcement:
 *  it is reachable only from `admissions/convert.ts`, inside the transaction that made the child. */
const OFFICE_STATES = ['new', 'reviewing', 'waitlisted', 'offered', 'declined', 'withdrawn'] as const;
const REASON = z.string().trim().max(500);

/** The states an office normally wants to see together, and the order they are worked in. */
const OPEN_STATES: InquiryState[] = ['new', 'reviewing', 'waitlisted', 'offered'];

function requireInquiry(id: string) {
  const row = inquiryById(id);
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That inquiry no longer exists.' });
  return row;
}

export const admissionsRouter = router({
  /**
   * The desk: counts by state, and one page of rows.
   *
   * Everything on these rows was typed by a stranger, so the web side renders all of it as text and
   * never as markup. Nothing here is summarized or truncated server-side — an office reading an
   * inquiry needs the whole of what the family wrote.
   */
  list: adminProcedure
    .input(
      z
        .object({
          state: z.enum(['open', ...OFFICE_STATES, 'admitted'] as const).default('open'),
          limit: z.number().int().min(1).max(200).default(100),
        })
        .default({ state: 'open', limit: 100 }),
    )
    .query(({ input }) => {
      const where =
        input.state === 'open' ? inArray(inquiries.state, OPEN_STATES) : eq(inquiries.state, input.state as InquiryState);
      const rows = db
        .select()
        .from(inquiries)
        .where(where)
        // The waitlist is an ordered queue and everything else is a pile with the newest on top, so
        // position leads where it means something and falls away where it does not.
        .orderBy(asc(sql`coalesce(${inquiries.waitlistPosition}, 999999)`), desc(inquiries.createdAt))
        .limit(input.limit)
        .all();

      const counts = db
        .select({ state: inquiries.state, n: sql<number>`count(*)` })
        .from(inquiries)
        .groupBy(inquiries.state)
        .all();

      return {
        rows,
        counts: Object.fromEntries(counts.map((c) => [c.state, Number(c.n)])) as Partial<Record<InquiryState, number>>,
        /** So the screen can say which moves are available on a row without knowing the machine. */
        nextStates: Object.fromEntries(
          [...OFFICE_STATES, 'admitted'].map((s) => [s, OFFICE_STATES.filter((to) => canTransition(s as InquiryState, to))]),
        ) as Record<string, OfficeTransition[]>,
      };
    }),

  /** One inquiry with its whole trail — who moved it, when, and why (the product surface §9 records
   *  this table as existing for, since nothing in this app reads `audit_log`). */
  get: adminProcedure.input(z.object({ id: ID })).query(({ input }) => {
    const inquiry = requireInquiry(input.id);
    const events = db.select().from(inquiryEvents).where(eq(inquiryEvents.inquiryId, input.id)).orderBy(desc(inquiryEvents.createdAt)).all();
    const school = inquiry.schoolId ? db.select({ id: schools.id, name: schools.name }).from(schools).where(eq(schools.id, inquiry.schoolId)).get() : null;
    const year = inquiry.schoolYearId
      ? db.select({ id: schoolYears.id, label: schoolYears.label }).from(schoolYears).where(eq(schoolYears.id, inquiry.schoolYearId)).get()
      : null;
    return { inquiry, events, school: school ?? null, year: year ?? null, next: OFFICE_STATES.filter((to) => canTransition(inquiry.state, to)) };
  }),

  /**
   * Move one along the pipeline.
   *
   * The zod enum is the first of two guards and `NEXT_STATES` is the second: the enum keeps
   * `admitted` from being NAMED, and the machine keeps a legal name from being applied out of order.
   * Both exist deliberately — one defends against a caller, the other against the sequence.
   */
  transition: adminProcedure
    .input(z.object({ id: ID, to: z.enum(OFFICE_STATES), reason: REASON.optional(), waitlistReason: REASON.optional() }))
    .mutation(({ ctx, input }) => {
      requireInquiry(input.id);
      try {
        const row = transitionInquiry({
          inquiryId: input.id,
          to: input.to,
          reason: input.reason ?? null,
          waitlistReason: input.waitlistReason ?? null,
          // The person, not the account: this name is read back off a screen by a colleague asking
          // who declined a family. The forensic half uses `auditActor` inside the transition.
          actor: { ...auditActor(ctx), name: recordingActor(ctx).name },
        });
        return { ok: true as const, state: row.state };
      } catch (e) {
        if (e instanceof TransitionRefused) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: `That inquiry is ${e.from} — it cannot be moved to ${e.to}.` });
        }
        throw e;
      }
    }),

  /** Which school and which year this family is asking about — the office's judgement, made while
   *  reviewing, never something the public form could set (see `admissions/inquiry.ts`). */
  assign: adminProcedure
    .input(z.object({ id: ID, schoolId: ID.nullable().optional(), schoolYearId: ID.nullable().optional() }))
    .mutation(({ ctx, input }) => {
      requireInquiry(input.id);
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (input.schoolId !== undefined) {
        if (input.schoolId && !db.select({ id: schools.id }).from(schools).where(eq(schools.id, input.schoolId)).get()) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'That school no longer exists.' });
        }
        patch.schoolId = input.schoolId;
      }
      if (input.schoolYearId !== undefined) {
        if (input.schoolYearId && !db.select({ id: schoolYears.id }).from(schoolYears).where(eq(schoolYears.id, input.schoolYearId)).get()) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'That school year no longer exists.' });
        }
        patch.schoolYearId = input.schoolYearId;
      }
      db.update(inquiries).set(patch).where(eq(inquiries.id, input.id)).run();
      audit(auditActor(ctx), 'inquiry.assign', { entity: 'inquiry', entityId: input.id, detail: { keys: Object.keys(input).filter((k) => k !== 'id') } });
      return { ok: true as const };
    }),

  /** Reorder the waitlist by hand (decision 7: manual ordering, no capacity — classes carry none, and
   *  adding one means enforcing it in rollover, bulk assign and admission, three paths that currently
   *  cannot fail). */
  waitlistReorder: adminProcedure.input(z.object({ ids: z.array(ID).max(500) })).mutation(({ ctx, input }) => {
    const count = reorderWaitlist(input.ids, auditActor(ctx));
    return { ok: true as const, count };
  }),

  /**
   * A walk-in, or a phone call: the office typing in an inquiry on a family's behalf.
   *
   * The same store, the same dedupe and the same trail as the public form — only `source` differs, so
   * the desk can say where a conversation started. It reports the outcome honestly, unlike the public
   * route: the person who typed it is signed in and looking at the screen, so "you already have this
   * one" is useful rather than a disclosure.
   */
  officeAdd: adminProcedure
    .input(
      z.object({
        childName: z.string().trim().min(1).max(INQUIRY_CAPS.childName),
        childDob: z.string().trim().max(INQUIRY_CAPS.childDob).optional(),
        askedAbout: z.string().trim().max(INQUIRY_CAPS.askedAbout).optional(),
        parentName: z.string().trim().min(1).max(INQUIRY_CAPS.parentName),
        email: z.string().trim().max(INQUIRY_CAPS.email).optional(),
        phone: z.string().trim().max(INQUIRY_CAPS.phone).optional(),
        message: z.string().trim().max(INQUIRY_CAPS.message).optional(),
        schoolId: ID.nullable().optional(),
        schoolYearId: ID.nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const res = storeInquiry(input, {
        source: 'office',
        actor: { ...auditActor(ctx), name: recordingActor(ctx).name },
        schoolId: input.schoolId ?? null,
        schoolYearId: input.schoolYearId ?? null,
      });
      if (res.outcome === 'incomplete') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'An inquiry needs the child’s name, your contact’s name, and either an email address or a phone number.' });
      }
      return { ok: true as const, outcome: res.outcome, id: res.inquiry?.id ?? null };
    }),

  // ── Conversion: the inquiry becomes a student ─────────────────────────────

  /**
   * What the Admit screen needs before it asks anything.
   *
   * The households this family might ALREADY be part of, most importantly: a younger sibling of an
   * existing student must be offered the existing household rather than silently given a second one.
   * It is a hint and never an action — silently joining them to a matched household is the same
   * mistake in the other direction, and worse, because it attaches a child to an address and a set of
   * guardians nobody confirmed.
   */
  convertPreview: adminProcedure.input(z.object({ id: ID })).query(({ input }) => {
    const p = conversionPreview(input.id);
    const plans = db.select({ id: feePlans.id, name: feePlans.name, amountCents: feePlans.amountCents, cadence: feePlans.cadence }).from(feePlans).where(eq(feePlans.status, 'active')).all();
    const fee = resolveEnrollmentFee({ schoolYearId: p.inquiry.schoolYearId, kind: 'admission' });
    return { ...p, feePlans: plans, enrollmentFee: fee, currency: getCurrency() };
  }),

  /**
   * Admit them: a household, a child with a Student ID, their guardians, their fee plan and the
   * enrollment fee, in one step.
   *
   * IDEMPOTENT. A second press returns the student the first one made — the inquiry's own state is
   * what answers, and the enrollment fee has its own UNIQUE key besides, so even a conversion that
   * somehow ran twice could not bill a family twice.
   */
  convert: adminProcedure
    .input(
      z.object({
        id: ID,
        feePlanId: ID,
        overrideAmountCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
        familyId: ID.nullable().optional(),
        classId: ID.nullable().optional(),
        fullName: z.string().trim().max(160).optional(),
        dob: z.string().trim().max(10).optional(),
        admittedOn: z.string().trim().max(10).optional(),
        guardian: z
          .object({
            name: z.string().trim().min(1).max(160),
            phone: z.string().trim().max(40).optional(),
            email: z.string().trim().max(200).optional(),
            relation: z.string().trim().max(60).optional(),
          })
          .nullable()
          .optional(),
        feeWaived: z.boolean().optional(),
        feeOverrideCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      // A date arriving at a WRITE boundary is validated, never trusted: a regex is not enough,
      // because `2026-13-45` has the right shape and is not a day (§9).
      for (const [k, v] of Object.entries({ dob: input.dob, admittedOn: input.admittedOn })) {
        if (v && !isIsoDay(v)) throw new TRPCError({ code: 'BAD_REQUEST', message: `That ${k === 'dob' ? 'date of birth' : 'admission date'} is not a real date.` });
      }
      return convertInquiry({ ...input, inquiryId: input.id }, { ...auditActor(ctx), name: recordingActor(ctx).name });
    }),

  // ── Settings for the public form ──────────────────────────────────────────

  /**
   * The policy, plus the things the screen needs in order to say what is actually true.
   *
   * `linkStatus`'s pattern: a switch being ON is not the same as the feature WORKING, so the blockers
   * are reported separately rather than folded into one boolean an office would have to interpret.
   * An install with no public URL can still run the form on its LAN; it just cannot be embedded in a
   * website, and the screen should say that rather than looking broken.
   */
  settingsGet: adminProcedure.query(() => {
    const cfg = getAdmissions();
    const publicUrl = cachedPublicUrl() || config.omosPublicUrl || '';
    return {
      ...cfg,
      maxOrigins: MAX_EMBED_ORIGINS,
      publicUrl,
      /** The two addresses an office copies: the link to share, and the one-line embed snippet. */
      formUrl: publicUrl ? `${publicUrl.replace(/\/+$/, '')}/public/inquiry` : '',
      embedSnippet: publicUrl ? `<script src="${publicUrl.replace(/\/+$/, '')}/public/inquiry.js" async></script>` : '',
      /** Nothing is reachable from the internet without one, and a masjid that has not switched on
       *  Remote access in OpenMasjidOS has none — which looks like a bug in this screen otherwise. */
      hasPublicUrl: !!publicUrl,
      textKeys: [...ADMISSIONS_TEXT_KEYS],
      textDefaults: ADMISSIONS_TEXT_DEFAULTS,
      textOverrides: getAdmissionsText(),
      textMaxLength: ADMISSIONS_TEXT_CAP,
    };
  }),

  /**
   * Change the policy.
   *
   * Every bound here MIRRORS the clamp in `settings/index.ts` rather than replacing it, and both are
   * required: zod refuses a bad client, and the read-side clamp defends a row edited by hand. An
   * origin that is not a bare scheme-and-host is refused at this boundary AND dropped on read,
   * because these strings land in a `frame-ancestors` header.
   */
  settingsSet: adminProcedure
    .input(
      z.object({
        publicForm: z.boolean().optional(),
        open: z.boolean().optional(),
        embedOrigins: z.array(z.string().trim().max(200)).max(MAX_EMBED_ORIGINS).optional(),
        dailyMax: z.number().int().min(0).max(5_000).optional(),
        minSeconds: z.number().int().min(0).max(60).optional(),
        ackEmail: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      if (input.embedOrigins) {
        const bad = input.embedOrigins.map((o) => o.trim()).filter((o) => o && !isEmbedOrigin(o));
        if (bad.length) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `“${bad[0]}” is not a website address this can use. Give the site’s address only — like https://masjid.org — with no path after it.`,
          });
        }
        input.embedOrigins = input.embedOrigins.map((o) => o.trim()).filter(Boolean);
      }
      setAdmissions(input);
      // Opening the public form is a decision about the internet, so it is audited BOTH ways and the
      // trail can answer "when did this start?" — the same treatment `webhookNamesSet` gets.
      audit(auditActor(ctx), 'settings.admissions', {
        entity: 'settings',
        detail: { ...input, embedOrigins: input.embedOrigins?.length ?? undefined },
      });
      return { ok: true as const };
    }),

  /** The madrasah's own wording for the public page. An unknown key is refused at the boundary rather
   *  than stored and silently ignored — the same `z.enum(KEYS)` the sheet's wording uses. */
  textSet: adminProcedure
    .input(
      z.union([
        z.object({ boxes: z.array(z.object({ key: z.enum(ADMISSIONS_TEXT_KEYS), text: z.string().max(ADMISSIONS_TEXT_CAP) })).max(ADMISSIONS_TEXT_KEYS.length) }),
        z.object({ reset: z.literal(true) }),
      ]),
    )
    .mutation(({ ctx, input }) => {
      const patch: Record<string, string> = {};
      if ('reset' in input) for (const k of ADMISSIONS_TEXT_KEYS) patch[k] = '';
      else for (const b of input.boxes) patch[b.key] = b.text;
      setAdmissionsText(patch);
      // Key names only. The prose is the madrasah's own words about itself and there is no reason to
      // copy it into a forensic trail to record that it changed (§14).
      audit(auditActor(ctx), 'settings.admissionsText', { entity: 'settings', detail: { keys: Object.keys(patch), reset: 'reset' in input } });
      return { ok: true as const };
    }),
});
