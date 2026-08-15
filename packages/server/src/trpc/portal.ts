// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Parent portal (CLAUDE.md §4, §5) — the parent-facing lens, scoped to the caller's own families
 * via guardian_users (§14: scoping in the query, never the UI). The My-Family home (their kids with
 * each child's Student ID, the derived balance, open invoices, and the unified payment history), plus
 * pay-now (Stripe Elements), saved cards, and autopay. Every value crosses through parentProcedure
 * (LAN + tunnel).
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { and, asc, eq, desc, inArray } from 'drizzle-orm';
import { router, parentProcedure } from './trpc';
import { db } from '../db';
import { families, students, invoices, invoiceItems, payments, paymentMethods, autopayEnrollments, schoolYears, guardians, guardianUsers } from '../db/schema';
import { familyBalance, studentBalance, familyStudentIds, splitAcrossFamily, recordedSplit, invoiceTotal, invoicePaid, recordSplit, type SplitShare } from '../billing/ledger';
import { invoiceLines, type LineKind } from '../billing/lines';
import { paidForByPayment, type PaidFor } from '../billing/paidFor';
import { schoolYearMonths } from '../billing/schoolYear';
import { yearCellsFor, type YearCell } from '../billing/yearCells';
import { listSchools } from '../schools';
import { formatMoney, MIN_PAYMENT_CENTS } from '../db/money';
import { getCurrency, getWhatsApp } from '../settings';
import { maskNumber, toE164 } from '../whatsapp/numbers';
import { parentFamilyIds, assertFamilyAccess } from './familyAccess';
import { stripeClient, stripeReady, publishableKey } from '../payments/stripe';
import { describePaymentMethod, repairPaymentMethods, resequenceMethods } from '../payments/methods';
import { alertStaff, householdName } from '../alerts';
import { sendReceipt } from '../mail/notify';
import { makeLog } from '../logger';

const payLog = makeLog('portal');

/** One school's year, as the portal's year tab renders it. A household can span two schools, and each has
 *  its own calendar — hence blocks rather than one grid (0.48.0). */
interface PortalYearBlock {
  /** Set only when this masjid runs more than one school. */
  schoolName: string | null;
  yearLabel: string;
  months: { periodKey: string; label: string }[];
  students: { studentId: string; fullName: string; cells: YearCell[] }[];
}

/**
 * Turn the lines a parent ticked into a per-child split carrying each child's instruction — or null if
 * they do not describe this payment, in which case the caller falls back to oldest-due-first.
 *
 * Null rather than an error on purpose. By the time this runs, Stripe has already taken the money: a
 * throw here would leave a real charge unrecorded over a mismatched tick list. The lines must belong to
 * this family and add up to exactly what was taken; anything else is a stale screen, and the honest
 * response is to record the money the default way rather than to guess at the intent or lose it.
 */
function lineShares(familyId: string, lines: { itemId: string; amountCents: number }[], amountCents: number): SplitShare[] | null {
  if (!lines.length) return null;
  if (lines.reduce((s, l) => s + l.amountCents, 0) !== amountCents) {
    payLog.warn('ignoring chosen lines — they do not add up to the amount charged', { familyId, lines: lines.length });
    return null;
  }
  const kidIds = new Set(familyStudentIds(familyId));
  const byStudent = new Map<string, SplitShare>();
  for (const l of lines) {
    const owner = db
      .select({ studentId: invoices.studentId, status: invoices.status, itemAmount: invoiceItems.amountCents })
      .from(invoiceItems)
      .innerJoin(invoices, eq(invoices.id, invoiceItems.invoiceId))
      .where(eq(invoiceItems.id, l.itemId))
      .get();
    if (!owner || !kidIds.has(owner.studentId) || owner.status === 'void' || l.amountCents > owner.itemAmount) {
      payLog.warn('ignoring chosen lines — one does not belong to an open bill of this family', { familyId });
      return null;
    }
    const cur = byStudent.get(owner.studentId) ?? { studentId: owner.studentId, amountCents: 0, directed: [] };
    cur.amountCents += l.amountCents;
    cur.directed!.push({ itemId: l.itemId, amountCents: l.amountCents });
    byStudent.set(owner.studentId, cur);
  }
  return [...byStudent.values()];
}

export const portalRouter = router({
  /**
   * The year at a glance, for this parent's own children (0.48.0).
   *
   * The office has had this view since 0.42.0 and it answers the question a parent asks most often —
   * "which months have we actually paid?" — better than a list of open bills does, because the months
   * that are FINE are the useful context. A parent could see what they owed but never see the shape of
   * the year.
   *
   * The squares are computed by `yearCellsFor`, the same function the staff grid uses, so a parent ringing
   * the office about November is looking at exactly what the office is looking at.
   *
   * GROUPED BY SCHOOL, because a school year belongs to a school (0.47.0) and a household is not scoped to
   * one — a family with a child in the weekend maktab and another in the full-time hifz programme has two
   * different sets of months, and laying them on one axis would be nonsense. Almost always one group.
   *
   * Scoping is by `parentFamilyIds`, the same wall as every other procedure here: a parent can only ever
   * name their own children because they never name any (§14 — enforced in the query, not the UI).
   */
  yearGrid: parentProcedure.query(({ ctx }) => {
    const famIds = parentFamilyIds(ctx);
    if (!famIds.length) return { blocks: [] as PortalYearBlock[] };

    const kids = db
      .select({ id: students.id, fullName: students.fullName, schoolId: students.schoolId })
      .from(students)
      .where(and(inArray(students.familyId, famIds), eq(students.status, 'active')))
      .orderBy(students.fullName)
      .all();
    if (!kids.length) return { blocks: [] as PortalYearBlock[] };

    const schoolIds = [...new Set(kids.map((k) => k.schoolId ?? ''))];
    const multiSchool = listSchools().length > 1;
    const blocks: PortalYearBlock[] = [];

    for (const schoolId of schoolIds) {
      const mine = kids.filter((k) => (k.schoolId ?? '') === schoolId);
      const year = schoolId
        ? db.select().from(schoolYears).where(and(eq(schoolYears.isCurrent, true), eq(schoolYears.schoolId, schoolId))).get()
        : db.select().from(schoolYears).where(eq(schoolYears.isCurrent, true)).get();
      // No year configured, or one without a start year: there are no months to lay out, so the block is
      // skipped rather than rendered empty. The home tab still shows every bill and the balance.
      if (!year || year.startYear == null) continue;
      const months = schoolYearMonths(year.startYear, year.startMonth, year.endMonth);
      const cells = yearCellsFor(mine.map((k) => k.id), months.map((m) => m.periodKey));
      blocks.push({
        // Named only when this masjid runs more than one school; otherwise the name is just the madrasah's
        // and repeating it above the grid reads like a fault.
        schoolName: multiSchool && schoolId ? listSchools().find((s) => s.id === schoolId)?.name ?? null : null,
        yearLabel: year.label,
        months: months.map((m) => ({ periodKey: m.periodKey, label: m.label })),
        students: mine.map((k) => ({ studentId: k.id, fullName: k.fullName, cells: cells.get(k.id) ?? [] })),
      });
    }
    return { blocks };
  }),

  /** Everything the My-Family home needs, for each family this parent is linked to. */
  myFamily: parentProcedure.query(({ ctx }) => {
    const currency = getCurrency();
    const famIds = parentFamilyIds(ctx);
    if (!famIds.length) return { currency, families: [] as FamilyView[] };

    const list: FamilyView[] = famIds.map((fid) => {
      const fam = db.select({ id: families.id, name: families.name }).from(families).where(eq(families.id, fid)).get();
      const kids = db
        .select({ id: students.id, fullName: students.fullName, studentCode: students.studentCode })
        .from(students)
        .where(and(eq(students.familyId, fid), eq(students.status, 'active')))
        .orderBy(students.fullName)
        .all();
      const kidIds = kids.map((k) => k.id);
      // Invoices and payments are per child now, so each row says which child it is for. The parent
      // still sees ONE combined balance and pays once — that is the whole point of the family view —
      // but they can now tell what each child owes, which they never could before.
      const open = (
        kidIds.length
          ? db
              .select({ id: invoices.id, studentId: invoices.studentId, label: invoices.label, dueDate: invoices.dueDate })
              .from(invoices)
              .where(and(inArray(invoices.studentId, kidIds), inArray(invoices.status, ['open', 'partially_paid'])))
              .all()
          : []
      )
        .map((i) => ({
          id: i.id,
          studentId: i.studentId,
          label: i.label,
          dueDate: i.dueDate,
          balanceCents: invoiceTotal(db, i.id) - invoicePaid(db, i.id),
          // WHAT THE BILL IS MADE OF (0.43.0). A parent looking at "Tuition — Feb 2027 · $250" could
          // not see that $50 of it was the book fee, and had no way to pay just that. These add up to
          // the invoice's own balance (a credit line reports 0 — its value is already deducted), so the
          // portal can total whatever the parent ticks without a special case.
          //
          // EVERY line, including the ones already settled: a parent who paid the book fee last week
          // needs to see that it is dealt with, and dropping it would read as the payment having gone
          // missing. `balanceCents: 0` is what marks it done.
          items: invoiceLines(db, i.id).map((l) => ({ id: l.itemId, label: l.label, kind: l.kind, amountCents: l.amountCents, balanceCents: l.balanceCents })),
        }))
        .filter((i) => i.balanceCents > 0)
        .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'));
      const rawPays = kidIds.length
        ? db
            .select({ id: payments.id, studentId: payments.studentId, amountCents: payments.amountCents, channel: payments.channel, occurredAt: payments.occurredAt, memo: payments.memo, reversalOf: payments.reversalOf })
            .from(payments)
            .where(inArray(payments.studentId, kidIds))
            .orderBy(desc(payments.occurredAt), desc(payments.createdAt))
            .limit(25)
            .all()
        : [];
      // WHAT each payment was for (0.48.0) — derived from its allocations, so it says what the money is
      // doing now rather than what it was described as on the day (billing/paidFor.ts).
      const forWhat = paidForByPayment(db, rawPays.map((p) => p.id));
      const pays = rawPays.map((p) => ({ ...p, paidFor: forWhat.get(p.id) ?? { labels: [], more: 0, advance: true } }));
      return {
        id: fid,
        name: fam?.name ?? '',
        balance: familyBalance(fid),
        students: kids.map((k) => ({ ...k, balance: studentBalance(k.id) })),
        invoices: open,
        payments: pays,
      };
    });
    return { currency, families: list };
  }),

  /** Whether card payments are available + the publishable key for Stripe Elements (§13.1/§13.2). */
  payConfig: parentProcedure.query(() => ({ ready: stripeReady(), publishableKey: publishableKey(), currency: getCurrency() })),

  /** Create a PaymentIntent for a chosen amount against one of the parent's families (§13.2). Card
   *  data never touches our server — the browser confirms with Elements, then calls confirmPayment
   *  (below) which records it. This just mints the intent against the admin-chosen Stripe account. */
  createPayment: parentProcedure.input(z.object({ familyId: z.string().min(1).max(64), amountCents: z.number().int().min(MIN_PAYMENT_CENTS).max(100_000_000) })).mutation(async ({ ctx, input }) => {
    assertFamilyAccess(ctx, input.familyId);
    const stripe = stripeClient();
    if (!stripe) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Card payments are temporarily unavailable.' });
    const fam = db.select({ id: families.id, name: families.name, stripeCustomerId: families.stripeCustomerId }).from(families).where(eq(families.id, input.familyId)).get();
    if (!fam) throw new TRPCError({ code: 'NOT_FOUND', message: 'Family not found.' });

    try {
      let customerId = fam.stripeCustomerId;
      if (!customerId) {
        const c = await stripe.customers.create({ name: fam.name, metadata: { students_family_id: fam.id } });
        customerId = c.id;
        db.update(families).set({ stripeCustomerId: customerId, updatedAt: new Date() }).where(eq(families.id, fam.id)).run();
      }
      const pi = await stripe.paymentIntents.create({
        amount: input.amountCents,
        currency: getCurrency(),
        customer: customerId,
        description: `School balance — ${fam.name}`,
        // §11.3 metadata. NEVER a Student ID or a child's name.
        metadata: { purpose: 'students-billing', omos_app: 'students-portal', students_family_id: fam.id, students_channel: 'portal' },
        automatic_payment_methods: { enabled: true },
      });
      return { clientSecret: pi.client_secret, publishableKey: publishableKey() };
    } catch (e) {
      // Never surface a raw Stripe/DB message to the parent (§15/§18) — log ids only, return one warm line.
      payLog.error('createPayment failed', { familyId: fam.id, error: (e as Error).message });
      throw new TRPCError({ code: 'BAD_GATEWAY', message: 'We couldn’t start your payment just now. Please try again in a moment.' });
    }
  }),

  /** Confirm a portal pay-now on return (§13.2 — NO webhook): retrieve the PI from Stripe, verify it's
   *  OURS and belongs to THIS family, and record it to the ledger if it succeeded. Idempotent
   *  (idempotency key = the PI id); the daily reconciliation (§11.4) is the backstop if the browser
   *  never calls this (e.g. the tab was closed). */
  confirmPayment: parentProcedure
    .input(
      z.object({
        familyId: z.string().min(1).max(64),
        paymentIntentId: z.string().min(1).max(255),
        /** The lines the parent ticked (0.43.0). Honoured only when they add up to what Stripe actually
         *  took — otherwise this falls back to oldest-due-first, which is the documented default. */
        lines: z.array(z.object({ itemId: z.string().min(1).max(64), amountCents: z.number().int().min(1).max(100_000_000) })).max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
    assertFamilyAccess(ctx, input.familyId);
    const stripe = stripeClient();
    if (!stripe) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Card payments are temporarily unavailable.' });
    let pi: import('stripe').Stripe.PaymentIntent;
    try {
      pi = await stripe.paymentIntents.retrieve(input.paymentIntentId);
    } catch (e) {
      payLog.error('confirmPayment retrieve failed', { familyId: input.familyId, error: (e as Error).message });
      throw new TRPCError({ code: 'BAD_GATEWAY', message: 'We couldn’t confirm your payment just now — it’ll appear on your account shortly.' });
    }
    const md = (pi.metadata ?? {}) as Record<string, string>;
    // Must be OUR portal intent for THIS family — a parent can never confirm another family's PI (§14).
    if (md.purpose !== 'students-billing' || md.omos_app !== 'students-portal' || md.students_family_id !== input.familyId) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Payment not found.' });
    }
    const succeeded = pi.status === 'succeeded';
    // Already recorded (a double-submit, or reconciliation got there first)? Then do nothing at all —
    // asking BEFORE deriving a split is what makes this idempotent, since `splitAcrossFamily` reads
    // the invoices the first attempt already paid down and would otherwise derive a second, different
    // split under new per-student keys.
    if (succeeded && recordedSplit(pi.id).length === 0) {
      const amount = pi.amount_received || pi.amount || 0;
      // One card charge, one ledger row per child: the parent paid a single household amount, and it
      // is spread over their children's open invoices oldest-due-first. Reconciliation (§11.4) uses
      // the same split, so a lost confirm-on-return lands identically when the daily job replays it.
      //
      // Unless the parent said WHICH lines they were paying, in which case those lines define both the
      // split and the instruction stored with each row (§ billing/ledger.ts). Reconciliation cannot know
      // about the ticks — it only ever sees the Stripe charge — so this is the one path where the two
      // differ, and it is the right way round: the parent's choice wins when we have it, and the backstop
      // still lands the money correctly if this call never happens.
      const chosen = lineShares(input.familyId, input.lines ?? [], amount);
      const res = recordSplit(
        { channel: 'portal', occurredAt: new Date(), idempotencyKey: pi.id, memo: null, externalRef: { stripePaymentIntentId: pi.id, stripeChargeId: (pi.latest_charge as string) ?? null } },
        chosen ?? splitAcrossFamily(input.familyId, amount),
        { userId: ctx.session.userId ?? null, role: 'portal', name: 'portal' },
      );
      if (!res.duplicate) {
        void alertStaff('payment-received', {
          title: 'Tuition payment received',
          text: `${householdName(input.familyId)} paid ${formatMoney(amount, getCurrency())} by card in the parent portal.`,
          publicText: `A tuition payment of ${formatMoney(amount, getCurrency())} was received (portal).`,
        });
        void sendReceipt(input.familyId, formatMoney(amount, getCurrency())); // §13.2.5 — "payment", never "donation"
      }
    }
    return { status: pi.status, recorded: succeeded };
  }),

  /**
   * Saved payment methods + autopay state for a family (§13.3).
   *
   * Async since 0.48.0 only to repair rows that never recorded WHAT they were — the households already
   * showing "CARD ···· " are put right the next time a parent opens the tab, with nobody re-saving
   * anything. It is a no-op once every row has a `type`, and best-effort in any case: Stripe being
   * unreachable leaves the wording vague and the page working (§13.5).
   */
  autopayStatus: parentProcedure.input(z.object({ familyId: z.string().min(1).max(64) })).query(async ({ ctx, input }) => {
    assertFamilyAccess(ctx, input.familyId);
    await repairPaymentMethods(input.familyId);
    const enr = db.select().from(autopayEnrollments).where(eq(autopayEnrollments.familyId, input.familyId)).get();
    const cards = db
      .select({
        id: paymentMethods.id,
        type: paymentMethods.type,
        brand: paymentMethods.brand,
        last4: paymentMethods.last4,
        expMonth: paymentMethods.expMonth,
        expYear: paymentMethods.expYear,
        wallet: paymentMethods.wallet,
        bankName: paymentMethods.bankName,
        accountType: paymentMethods.accountType,
        isDefault: paymentMethods.isDefault,
      })
      .from(paymentMethods)
      .where(eq(paymentMethods.familyId, input.familyId))
      // The order they will be TRIED in (0.48.0) — position 0 is what autopay charges. The list is the
      // feature, so it must arrive in that order rather than being sorted on the client.
      .orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.createdAt))
      .all();
    return { ready: stripeReady(), enabled: !!enr?.enabled, defaultPmId: enr?.defaultPmId ?? null, cards };
  }),

  /**
   * Put the saved methods in the order they should be charged (0.48.0).
   *
   * The parent sends the whole list, not "move this one up": a full order is idempotent and cannot get out
   * of step with what they were looking at, whereas a relative move applied to a list that changed in
   * another tab silently reorders the wrong pair.
   *
   * Every id must be one of THIS household's, and all of them must be present — a partial list would leave
   * the rest at arbitrary positions, and this decides what gets charged.
   */
  reorderMethods: parentProcedure
    .input(z.object({ familyId: z.string().min(1).max(64), orderedIds: z.array(z.string().min(1).max(64)).max(20) }))
    .mutation(({ ctx, input }) => {
      assertFamilyAccess(ctx, input.familyId);
      const mine = db.select({ id: paymentMethods.id }).from(paymentMethods).where(eq(paymentMethods.familyId, input.familyId)).all().map((r) => r.id);
      const asked = [...new Set(input.orderedIds)];
      if (asked.length !== mine.length || !asked.every((id) => mine.includes(id))) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'That list is out of date — reload the page and try again.' });
      }
      db.transaction((tx) => {
        asked.forEach((id, i) => {
          tx.update(paymentMethods).set({ sortOrder: i }).where(eq(paymentMethods.id, id)).run();
        });
      });
      // One place keeps sort_order, is_default and the autopay enrolment agreeing (payments/methods.ts).
      resequenceMethods(input.familyId);
      return { ok: true as const };
    }),

  /** Start saving a card: a SetupIntent (off-session capable) the browser confirms with Elements. */
  createSetupIntent: parentProcedure.input(z.object({ familyId: z.string().min(1).max(64) })).mutation(async ({ ctx, input }) => {
    assertFamilyAccess(ctx, input.familyId);
    const stripe = stripeClient();
    if (!stripe) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Card payments are temporarily unavailable.' });
    const fam = db.select({ id: families.id, name: families.name, stripeCustomerId: families.stripeCustomerId }).from(families).where(eq(families.id, input.familyId)).get();
    if (!fam) throw new TRPCError({ code: 'NOT_FOUND', message: 'Family not found.' });
    try {
      let customerId = fam.stripeCustomerId;
      if (!customerId) {
        const c = await stripe.customers.create({ name: fam.name, metadata: { students_family_id: fam.id } });
        customerId = c.id;
        db.update(families).set({ stripeCustomerId: customerId, updatedAt: new Date() }).where(eq(families.id, fam.id)).run();
      }
      const si = await stripe.setupIntents.create({
        customer: customerId,
        usage: 'off_session',
        metadata: { omos_app: 'students-portal', students_family_id: fam.id },
        // OFFER WHAT THE MASJID ACTUALLY TAKES (0.48.0). Stripe defaults a SetupIntent to
        // `payment_method_types: ['card']` when neither field is given, so this step had ALWAYS been
        // card-only however the masjid's Stripe account was configured — a household could pay from a
        // bank account in pay-now (which has had automatic methods all along) but never save one.
        //
        // `automatic_payment_methods` rather than naming `us_bank_account` explicitly: naming a type the
        // account has not enabled makes Stripe REJECT the whole call, which would break saving a card for
        // every masjid that takes cards only. Letting Stripe filter means each masjid is offered exactly
        // what it has switched on, and no masjid can be broken by a type it never wanted. Stripe also
        // drops anything that cannot be reused off-session, which is what autopay needs.
        automatic_payment_methods: { enabled: true },
      });
      return { clientSecret: si.client_secret, publishableKey: publishableKey() };
    } catch (e) {
      payLog.error('createSetupIntent failed', { familyId: fam.id, error: (e as Error).message });
      throw new TRPCError({ code: 'BAD_GATEWAY', message: 'We couldn’t start that just now. Please try again in a moment.' });
    }
  }),

  /**
   * After the browser confirms the SetupIntent, persist the payment method's REFERENCE — never a PAN or an
   * account number — and attach it to the family's Stripe Customer. The first one saved becomes the default.
   *
   * `describePaymentMethod` decides what to store (0.48.0). This used to read `pm.card` and nothing else,
   * so a bank account saved through the Payment Element stored a row of NULLs and the portal called it a
   * card with no digits. Anything the masjid's Stripe account offers is now recorded as what it is.
   */
  saveCard: parentProcedure.input(z.object({ familyId: z.string().min(1).max(64), paymentMethodId: z.string().min(1).max(64) })).mutation(async ({ ctx, input }) => {
    assertFamilyAccess(ctx, input.familyId);
    const stripe = stripeClient();
    if (!stripe) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Card payments are temporarily unavailable.' });
    const fam = db.select({ stripeCustomerId: families.stripeCustomerId }).from(families).where(eq(families.id, input.familyId)).get();
    if (!fam?.stripeCustomerId) throw new TRPCError({ code: 'NOT_FOUND', message: 'Family not found.' });
    try {
      const pm = await stripe.paymentMethods.retrieve(input.paymentMethodId);
      // Guard: the PM must belong to THIS family's customer (never attach someone else's card).
      if (pm.customer && pm.customer !== fam.stripeCustomerId) throw new Error('pm_customer_mismatch');
      if (!pm.customer) await stripe.paymentMethods.attach(input.paymentMethodId, { customer: fam.stripeCustomerId });
      // A new method goes to the END of the order (0.48.0): the household already chose what to charge
      // first, and quietly promoting the newest card over that choice is how autopay ends up on the wrong
      // one. The first one saved is position 0 by arithmetic, not by a special case.
      const existing = db.select({ id: paymentMethods.id }).from(paymentMethods).where(eq(paymentMethods.familyId, input.familyId)).all();
      const ts = new Date();
      db.insert(paymentMethods)
        .values({ id: pm.id, familyId: input.familyId, ...describePaymentMethod(pm), sortOrder: existing.length, isDefault: existing.length === 0, createdAt: ts })
        .onConflictDoNothing()
        .run();
      resequenceMethods(input.familyId);
      return { ok: true as const };
    } catch (e) {
      payLog.error('saveCard failed', { familyId: input.familyId, error: (e as Error).message });
      throw new TRPCError({ code: 'BAD_GATEWAY', message: 'We couldn’t save that card. Please try again.' });
    }
  }),

  /**
   * Remove a saved method.
   *
   * Removing the one autopay charges no longer switches autopay OFF when the household has another (0.48.0)
   * — the next in their chosen order takes over, which is the point of being able to order them. It is only
   * switched off when nothing is left, and `resequenceMethods` owns that decision so the enrolment can
   * never end up pointing at a row that has gone.
   */
  removeCard: parentProcedure.input(z.object({ familyId: z.string().min(1).max(64), paymentMethodId: z.string().min(1).max(64) })).mutation(async ({ ctx, input }) => {
    assertFamilyAccess(ctx, input.familyId);
    if (!db.select({ id: paymentMethods.id }).from(paymentMethods).where(and(eq(paymentMethods.id, input.paymentMethodId), eq(paymentMethods.familyId, input.familyId))).get()) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Card not found.' });
    }
    db.delete(paymentMethods).where(eq(paymentMethods.id, input.paymentMethodId)).run();
    resequenceMethods(input.familyId);
    const stripe = stripeClient();
    if (stripe) { try { await stripe.paymentMethods.detach(input.paymentMethodId); } catch { /* best-effort */ } }
    return { ok: true as const };
  }),

  /** Turn autopay on/off for a family (§13.3). Enabling requires a saved card + records consent. */
  setAutopay: parentProcedure.input(z.object({ familyId: z.string().min(1).max(64), enabled: z.boolean() })).mutation(({ ctx, input }) => {
    assertFamilyAccess(ctx, input.familyId);
    const ts = new Date();
    const enr = db.select().from(autopayEnrollments).where(eq(autopayEnrollments.familyId, input.familyId)).get();
    if (input.enabled) {
      const def = db.select({ id: paymentMethods.id }).from(paymentMethods).where(and(eq(paymentMethods.familyId, input.familyId), eq(paymentMethods.isDefault, true))).get() ?? db.select({ id: paymentMethods.id }).from(paymentMethods).where(eq(paymentMethods.familyId, input.familyId)).get();
      if (!def) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Add a card before turning on autopay.' });
      if (enr) db.update(autopayEnrollments).set({ enabled: true, defaultPmId: def.id, consentAt: ts, failureCount: 0, nextAttemptAt: null, updatedAt: ts }).where(eq(autopayEnrollments.familyId, input.familyId)).run();
      else db.insert(autopayEnrollments).values({ familyId: input.familyId, enabled: true, defaultPmId: def.id, consentAt: ts, failureCount: 0, nextAttemptAt: null, createdAt: ts, updatedAt: ts }).run();
    } else if (enr) {
      db.update(autopayEnrollments).set({ enabled: false, updatedAt: ts }).where(eq(autopayEnrollments.familyId, input.familyId)).run();
    }
    return { ok: true as const };
  }),

  // ── WhatsApp, from the parent's side (0.50.0) ─────────────────────────────
  /**
   * Whether this parent hears from the madrasa on WhatsApp.
   *
   * Scoped to the caller's OWN guardian record — the one their portal account is linked to — and not
   * to the household. The choice is about a phone and the phone belongs to a person: a mother opting
   * out must not silence her husband's number, and vice versa (§9).
   *
   * `available` is deliberately about the INSTALL, not the person: with the feature off there is
   * nothing to opt out of, and the portal shows nothing at all rather than a dead switch.
   */
  messagingGet: parentProcedure.query(({ ctx }) => {
    const cfg = getWhatsApp();
    const me = myGuardian(ctx);
    return {
      available: cfg.enabled && !!me,
      optedOut: !!me?.waOptOut,
      /** So the screen can say WHICH number, without printing it. Empty when we can't read theirs —
       *  which the portal turns into "we don't have a WhatsApp number for you", the honest version. */
      mask: maskNumber(me ? toE164(me.phone, me.phoneCountry || cfg.defaultCountry) : null),
    };
  }),

  /** Turn messages off, or back on. Immediate, and nothing in the app overrides it — not the office's
   *  broadcast, not the test student, not an admin screen. */
  messagingSet: parentProcedure.input(z.object({ optOut: z.boolean() })).mutation(({ ctx, input }) => {
    const me = myGuardian(ctx);
    if (!me) throw new TRPCError({ code: 'FORBIDDEN', message: 'You don’t have access to that.' });
    db.update(guardians).set({ waOptOut: input.optOut, updatedAt: new Date() }).where(eq(guardians.id, me.id)).run();
    return { ok: true as const };
  }),
});

/** The guardian record behind this parent session, or null. The portal's scoping wall is
 *  `guardian_users`, and this is the same link read one step earlier (§14 — in the query). */
function myGuardian(ctx: { session?: { userId?: string | null } | null }) {
  const userId = ctx.session?.userId;
  if (!userId) return null;
  return (
    db
      .select({ id: guardians.id, phone: guardians.phone, phoneCountry: guardians.phoneCountry, waOptOut: guardians.waOptOut })
      .from(guardianUsers)
      .innerJoin(guardians, eq(guardians.id, guardianUsers.guardianId))
      .where(eq(guardianUsers.userId, userId))
      .get() ?? null
  );
}

type FamilyView = {
  id: string;
  name: string;
  /** The combined household balance — what the parent pays in one go. */
  balance: ReturnType<typeof familyBalance>;
  /** Each child, with their own balance: bills are per child, so "what does Maryam owe?" is answerable. */
  students: { id: string; fullName: string; studentCode: string | null; balance: ReturnType<typeof studentBalance> }[];
  /** Each open bill, with the lines it is made of so the parent can pay one of them (0.43.0). */
  invoices: {
    id: string;
    studentId: string;
    label: string;
    dueDate: string | null;
    balanceCents: number;
    items: { id: string; label: string; kind: LineKind; amountCents: number; balanceCents: number }[];
  }[];
  /** `paidFor` is what the money settled, derived from its allocations (billing/paidFor.ts) — the
   *  portal's history says what a payment was for, not only how much it was. */
  payments: { id: string; studentId: string; amountCents: number; channel: string; occurredAt: Date; memo: string | null; reversalOf: string | null; paidFor: PaidFor }[];
};
