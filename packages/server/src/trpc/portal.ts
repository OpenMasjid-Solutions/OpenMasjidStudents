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
import { and, eq, desc, inArray } from 'drizzle-orm';
import { router, parentProcedure } from './trpc';
import { db } from '../db';
import { families, students, invoices, invoiceItems, payments, paymentMethods, autopayEnrollments } from '../db/schema';
import { familyBalance, studentBalance, familyStudentIds, splitAcrossFamily, recordedSplit, invoiceTotal, invoicePaid, recordSplit, type SplitShare } from '../billing/ledger';
import { invoiceLines, type LineKind } from '../billing/lines';
import { formatMoney, MIN_PAYMENT_CENTS } from '../db/money';
import { getCurrency } from '../settings';
import { parentFamilyIds, assertFamilyAccess } from './familyAccess';
import { stripeClient, stripeReady, publishableKey } from '../payments/stripe';
import { alertStaff, householdName } from '../alerts';
import { sendReceipt } from '../mail/notify';
import { makeLog } from '../logger';

const payLog = makeLog('portal');

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
      const pays = kidIds.length
        ? db
            .select({ id: payments.id, studentId: payments.studentId, amountCents: payments.amountCents, channel: payments.channel, occurredAt: payments.occurredAt, memo: payments.memo, reversalOf: payments.reversalOf })
            .from(payments)
            .where(inArray(payments.studentId, kidIds))
            .orderBy(desc(payments.occurredAt), desc(payments.createdAt))
            .limit(25)
            .all()
        : [];
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

  /** Saved cards + autopay state for a family (§13.3). */
  autopayStatus: parentProcedure.input(z.object({ familyId: z.string().min(1).max(64) })).query(({ ctx, input }) => {
    assertFamilyAccess(ctx, input.familyId);
    const enr = db.select().from(autopayEnrollments).where(eq(autopayEnrollments.familyId, input.familyId)).get();
    const cards = db.select({ id: paymentMethods.id, brand: paymentMethods.brand, last4: paymentMethods.last4, expMonth: paymentMethods.expMonth, expYear: paymentMethods.expYear, isDefault: paymentMethods.isDefault }).from(paymentMethods).where(eq(paymentMethods.familyId, input.familyId)).all();
    return { ready: stripeReady(), enabled: !!enr?.enabled, defaultPmId: enr?.defaultPmId ?? null, cards };
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
      const si = await stripe.setupIntents.create({ customer: customerId, usage: 'off_session', metadata: { omos_app: 'students-portal', students_family_id: fam.id } });
      return { clientSecret: si.client_secret, publishableKey: publishableKey() };
    } catch (e) {
      payLog.error('createSetupIntent failed', { familyId: fam.id, error: (e as Error).message });
      throw new TRPCError({ code: 'BAD_GATEWAY', message: 'We couldn’t set up your card just now. Please try again in a moment.' });
    }
  }),

  /** After the browser confirms the SetupIntent, persist the card REFERENCE (brand/last4/exp — never a
   *  PAN) and attach it to the family's Stripe Customer. The first saved card becomes the default. */
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
      const isFirst = !db.select({ id: paymentMethods.id }).from(paymentMethods).where(eq(paymentMethods.familyId, input.familyId)).get();
      const ts = new Date();
      db.insert(paymentMethods).values({ id: pm.id, familyId: input.familyId, brand: pm.card?.brand ?? null, last4: pm.card?.last4 ?? null, expMonth: pm.card?.exp_month ?? null, expYear: pm.card?.exp_year ?? null, isDefault: isFirst, createdAt: ts }).onConflictDoNothing().run();
      return { ok: true as const };
    } catch (e) {
      payLog.error('saveCard failed', { familyId: input.familyId, error: (e as Error).message });
      throw new TRPCError({ code: 'BAD_GATEWAY', message: 'We couldn’t save that card. Please try again.' });
    }
  }),

  /** Remove a saved card. If it was the autopay default, autopay is turned off (no card to charge). */
  removeCard: parentProcedure.input(z.object({ familyId: z.string().min(1).max(64), paymentMethodId: z.string().min(1).max(64) })).mutation(async ({ ctx, input }) => {
    assertFamilyAccess(ctx, input.familyId);
    if (!db.select({ id: paymentMethods.id }).from(paymentMethods).where(and(eq(paymentMethods.id, input.paymentMethodId), eq(paymentMethods.familyId, input.familyId))).get()) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Card not found.' });
    }
    db.delete(paymentMethods).where(eq(paymentMethods.id, input.paymentMethodId)).run();
    const enr = db.select().from(autopayEnrollments).where(eq(autopayEnrollments.familyId, input.familyId)).get();
    if (enr?.defaultPmId === input.paymentMethodId) {
      db.update(autopayEnrollments).set({ enabled: false, defaultPmId: null, updatedAt: new Date() }).where(eq(autopayEnrollments.familyId, input.familyId)).run();
    }
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
});

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
  payments: { id: string; studentId: string; amountCents: number; channel: string; occurredAt: Date; memo: string | null; reversalOf: string | null }[];
};
