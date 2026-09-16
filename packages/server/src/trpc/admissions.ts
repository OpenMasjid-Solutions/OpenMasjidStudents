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
import { feePlans, inquiries, inquiryEvents, readmissions, schoolYears, schools, type InquiryState } from '../db/schema';
import { audit } from '../audit';
import { AUDIENCE } from '../structure/audience';
import {
  READMISSION_FIELDS,
  approveReadmission,
  diffSubmission,
  mintReadmissionLink,
  openReadmissions,
  readmissionBoard,
  reviewReadmission,
  setReadmissionState,
} from '../admissions/readmission';
import { canTransition, inquiryById, reorderWaitlist, transitionInquiry, TransitionRefused, vacateWaitlistPosition, type OfficeTransition } from '../admissions/transition';
import { INQUIRY_CAPS, storeInquiry } from '../admissions/inquiry';
import { ADMISSIONS_TEXT_DEFAULTS, ADMISSIONS_TEXT_KEYS } from '../admissions/text';
import { conversionPreview, convertInquiry } from '../admissions/convert';
import { admissionFormFields, admissionPatch, admissionProposal, mintAdmissionLink } from '../admissions/admissionForm';
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
const OFFICE_STATES = ['new', 'waitlisted', 'admission', 'declined'] as const;
const REASON = z.string().trim().max(500);

/** The states an office normally wants to see together, and the order they are worked in. */
const OPEN_STATES: InquiryState[] = ['new', 'waitlisted', 'admission'];

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

  /**
   * ERASE AN INQUIRY FOR GOOD — the record, its trail, and any link minted for it.
   *
   * Asked for by Hasan in 0.52.0-dev.11: "if there's a way to fully, fully delete, like the ones
   * that you decline, you should be able to delete too." The old rule was that a declined row is
   * retained forever, on the argument that an office asked "did we ever hear from them?" needs an
   * answer. That argument holds for a real family and holds for nothing else, and a public form
   * collects the rest: the test submission somebody made while setting the widget up, the abuse, the
   * duplicate typed in by a parent who pressed the button twice on a bad connection. An office that
   * cannot clear those stops opening the board, which costs more than the retained row was worth.
   *
   * Three things keep it honest, and they are the same three that make `people.studentDelete`'s
   * `force` door tolerable (§9):
   *
   * 1. **Admin only.** Finance cannot reach admissions at all (§5), so this is stated by the
   *    procedure it is built on rather than by a check inside it.
   * 2. **`admitted` IS REFUSED.** That row is the provenance of a child on the roster — when the
   *    family first asked, and what they said. Erasing an inquiry is not a way to quietly unpick an
   *    admission, and the student's own delete (with `force`) is the deliberate door for that; it
   *    leaves the inquiry standing on purpose, which this must not undo from the other side.
   * 3. **THE AUDIT ROW IS WRITTEN FIRST AND CARRIES THE NAMES.** It is the only trace that survives,
   *    and an id that no longer resolves documents nothing. The child's name, the parent's name and
   *    the state it was in — never the message body, which is the part that could be abuse and is
   *    the part §14 keeps out of anything that outlives the record.
   *
   * `inquiry_events` and `admission_links` are `ON DELETE cascade`, so the row takes its trail and
   * any outstanding form link with it — a link that outlived its inquiry would be a token pointing
   * at nothing, redeemable by whoever still has the URL.
   */
  remove: adminProcedure.input(z.object({ id: ID })).mutation(({ ctx, input }) => {
    const row = requireInquiry(input.id);
    if (row.state === 'admitted') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'This inquiry became a student, so it is the record of how they joined. Delete the student instead if that is what you meant.',
      });
    }
    audit(auditActor(ctx), 'inquiry.delete', {
      entity: 'inquiry',
      entityId: row.id,
      detail: { childName: row.childName, parentName: row.parentName, state: row.state, source: row.source, createdAt: row.createdAt.toISOString() },
    });
    // Leaving the waitlist by being deleted leaves the same hole as leaving it by being declined, so
    // the renumber and the delete commit together — `vacateWaitlistPosition` is the waitlist's one
    // owner (§16), reached here because a delete is the one exit that is not a transition.
    db.transaction((tx) => {
      tx.delete(inquiries).where(eq(inquiries.id, row.id)).run();
      if (row.state === 'waitlisted' && row.waitlistPosition != null) vacateWaitlistPosition(row.waitlistPosition, tx);
    });
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
        /** Field keys from the family's admission form the office does NOT want written. Everything
         *  else on an approved proposal is applied — the office reviewed it. */
        rejectFields: z.array(z.string().max(40)).max(40).optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      // A date arriving at a WRITE boundary is validated, never trusted: a regex is not enough,
      // because `2026-13-45` has the right shape and is not a day (§9).
      for (const [k, v] of Object.entries({ dob: input.dob, admittedOn: input.admittedOn })) {
        if (v && !isIsoDay(v)) throw new TRPCError({ code: 'BAD_REQUEST', message: `That ${k === 'dob' ? 'date of birth' : 'admission date'} is not a real date.` });
      }

      // WHAT THE FAMILY SENT, MINUS WHAT THE OFFICE REJECTED, AND THE OFFICE'S OWN EDITS WIN.
      // The proposal has been sitting inert on the inquiry; this is the moment it becomes a record,
      // and it is the office's approval that makes it one — so a name typed on the review screen
      // overrides the one on the form, and a rejected key is dropped before the patch is built.
      const proposal = admissionProposal(input.id);
      const rejected = new Set(input.rejectFields ?? []);
      const accepted = Object.fromEntries(Object.entries(proposal.answers).filter(([k]) => !rejected.has(k)));
      const patch = admissionPatch(accepted);

      return convertInquiry(
        {
          ...input,
          inquiryId: input.id,
          fullName: input.fullName ?? patch.core.fullName,
          dob: input.dob ?? patch.core.dob,
          guardian:
            input.guardian ??
            (patch.guardian.name ? { name: patch.guardian.name, phone: patch.guardian.phone ?? null, email: patch.guardian.email ?? null, relation: null } : undefined),
          fields: { student: patch.student, family: patch.family },
        },
        { ...auditActor(ctx), name: recordingActor(ctx).name },
      );
    }),

  // ── The admission form: issuing it, and reading back what a family sent ────

  /**
   * Start a family's admission: move the inquiry along AND hand back their one-time link.
   *
   * One press, because it is one decision. The transition and the mint are separate functions on
   * purpose (`transition.ts` is the only writer of a state, §16) and are called together here, which
   * is the right place for "these two things happen when the office presses this button" to live.
   *
   * Pressing it again on an inquiry already in `admission` re-mints rather than refusing: a link gets
   * lost, a parent deletes the email, somebody needs to read it out over the phone. The old one keeps
   * working until it expires, which is correct — both point at the same inquiry and a submission
   * replaces the proposal rather than making a second one.
   */
  admissionStart: adminProcedure.input(z.object({ id: ID, reason: REASON.optional() })).mutation(({ ctx, input }) => {
    const row = requireInquiry(input.id);
    const actor = { ...auditActor(ctx), name: recordingActor(ctx).name };
    if (row.state !== 'admission') {
      if (!canTransition(row.state, 'admission')) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `That inquiry is ${row.state}, so an admission cannot be started from here.` });
      }
      transitionInquiry({ inquiryId: input.id, to: 'admission', reason: input.reason ?? null, actor });
    }
    const link = mintAdmissionLink(input.id, ctx.user?.id ?? null);
    audit(auditActor(ctx), 'admission.link', { entity: 'inquiry', entityId: input.id, detail: {} });
    return { ok: true as const, token: link.token, url: link.url };
  }),

  /** The form as it was asked, beside what came back — what the office reviews before admitting. */
  admissionProposal: adminProcedure.input(z.object({ id: ID })).query(({ input }) => {
    const p = admissionProposal(input.id);
    // The office is `admin`, which is the only role that reaches this router at all (§5), so the
    // medical answers are theirs to see. They are flagged rather than filtered so the screen can say
    // which ones they are — a note about a child's allergy should not look like a note about their
    // previous school.
    return { fields: p.fields, answers: p.answers, submitted: p.submitted };
  }),

  // ── Re-admission: the children who are already here ───────────────────────

  /**
   * Open re-admission for a cohort, for one year.
   *
   * Takes the SAME audience shape mass fee apply and the onboarding send take, resolved by the same
   * `structure/audience.ts` — which is also what enforces "withdrawn students are excluded", since
   * that resolver returns active students only (§16). A third resolver here would have drifted on
   * exactly that.
   *
   * Idempotent: a second press creates nothing and reports how many were already on the list.
   */
  readmissionOpen: adminProcedure
    .input(z.object({ schoolYearId: ID, target: AUDIENCE }))
    .mutation(({ ctx, input }) => openReadmissions(input.target, input.schoolYearId, auditActor(ctx))),

  /** Who has answered and who has not — the screen an office lives on for a fortnight. */
  readmissionBoard: adminProcedure.input(z.object({ schoolYearId: ID })).query(({ input }) => {
    const board = readmissionBoard(input.schoolYearId);
    const plans = db.select({ id: feePlans.id, name: feePlans.name, amountCents: feePlans.amountCents }).from(feePlans).where(eq(feePlans.status, 'active')).all();
    const year = db.select().from(schoolYears).where(eq(schoolYears.id, input.schoolYearId)).get() ?? null;
    return { ...board, feePlans: plans, year, currency: getCurrency() };
  }),

  /** One family's answer, as a diff — computed by the same function the approval applies. */
  readmissionReview: adminProcedure.input(z.object({ id: ID })).query(({ input }) => reviewReadmission(input.id)),

  /**
   * A one-time link to send the family.
   *
   * Returned once and never stored in the clear (§14). EMAIL OR PRINT ONLY — a token link is
   * auth-critical and never travels by WhatsApp, where a number can be banned overnight.
   */
  readmissionLink: adminProcedure.input(z.object({ id: ID })).mutation(({ ctx, input }) => {
    const r = mintReadmissionLink(input.id, ctx.session?.userId ?? null);
    audit(auditActor(ctx), 'readmission.link', { entity: 'readmission', entityId: input.id });
    return r;
  }),

  /** The office filling the form in on the family's behalf — the spec allows it explicitly, and a
   *  phone call is how most of a madrasah's re-enrollment actually happens. */
  readmissionSubmitFor: adminProcedure
    .input(z.object({ id: ID, returning: z.boolean(), fields: z.record(z.string().max(400)).optional() }))
    .mutation(({ ctx, input }) => {
      const { readmission: row, current } = reviewReadmission(input.id);
      const changes = diffSubmission(current, input.fields ?? {});
      const kept: Record<string, string> = {};
      for (const c of changes) kept[c.field] = c.to;
      const at = new Date();
      db.update(readmissions)
        .set({ state: input.returning ? 'submitted' : 'not_returning', submittedPayload: kept, submittedAt: at, updatedAt: at })
        .where(eq(readmissions.id, row.id))
        .run();
      audit(auditActor(ctx), 'readmission.submit', { entity: 'readmission', entityId: row.id, detail: { returning: input.returning, changed: changes.length, by: 'office' } });
      return { ok: true as const, changed: changes.length };
    }),

  /** Write what the office accepted, roll the child into the year, raise the re-enrollment fee. */
  readmissionApprove: adminProcedure
    .input(
      z.object({
        id: ID,
        feePlanId: ID.nullable().optional(),
        overrideAmountCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
        classId: ID.nullable().optional(),
        feeWaived: z.boolean().optional(),
        feeOverrideCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
        rejectFields: z.array(z.enum(READMISSION_FIELDS)).optional(),
      }),
    )
    .mutation(({ ctx, input }) => approveReadmission({ ...input, readmissionId: input.id }, { ...auditActor(ctx), name: recordingActor(ctx).name })),

  /** `lapsed` for a family that never answered, or back to `pending` to reopen. NEVER inferred from
   *  silence at read time — that would make the screen disagree with itself between refreshes (§9). */
  readmissionState: adminProcedure
    .input(z.object({ id: ID, state: z.enum(['pending', 'submitted', 'approved', 'enrolled', 'not_returning', 'lapsed']) }))
    .mutation(({ ctx, input }) => {
      setReadmissionState(input.id, input.state, auditActor(ctx));
      return { ok: true as const };
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
      /**
       * The admission form as it stands today, so Settings can offer a required-checkbox per field
       * without carrying its own list.
       *
       * Derived, never stored: which fields exist is the student-field registry's answer and an
       * office changes it on another tab. A stored list here would go stale the moment they did, and
       * the staleness would be invisible — a checkbox for a field nobody is asked for.
       */
      admissionFields: admissionFormFields(null).map((f) => ({ key: f.key, label: f.label, medical: f.medical, required: f.required })),
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
        requiredAdmissionFields: z.array(z.string().trim().max(40)).max(40).optional(),
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
