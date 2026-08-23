// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Billing (CLAUDE.md §4/§5): fee plans, per-student fee assignment, per-family discount,
 * invoice generation, the derived ledger/balance, and manual payments (cash/Zelle/check/other).
 * Admin + finance only (finance works LAN + tunnel; admin LAN-only — origin policy). All money
 * goes through billing/ledger.ts + billing/invoices.ts; amounts are integer cents. Audited.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { and, eq, ne, asc, desc, inArray } from 'drizzle-orm';
import { router, adminProcedure, adminOrFinanceProcedure, auditActor, recordingActor } from './trpc';
import { db } from '../db';
import { feePlans, studentFees, students, families, invoices, invoiceItems, payments, chargeItems, charges, classes, courses, schoolYears, guardians, guardianFamilies, emergencyContacts, carryIns, autopayEnrollments, paymentMethods, MANUAL_PAYMENT_CHANNELS } from '../db/schema';
import { rid } from '../db/ids';
import { audit } from '../audit';
import { makeLog } from '../logger';
import { recordPayment, reversePayment, familyBalance, studentBalance, invoiceTotal, invoicePaid } from '../billing/ledger';
import { generateForFamily, generateForPeriod, attachChargeToExistingInvoice } from '../billing/invoices';
import { billFromMonths, currentPeriod } from '../billing/joinMidYear';
import { schoolYearMonths } from '../billing/schoolYear';
import { AUDIENCE_CLASS, AUDIENCE_COURSE, AUDIENCE_STUDENTS, resolveAudience } from '../structure/audience';
import { yearCellsFor } from '../billing/yearCells';
import { invoiceLines, payableLines } from '../billing/lines';
import { periodKeyError, periodBefore, isMonthPeriod, CARRY_IN_PERIOD, resolveInvoiceLabel } from '../billing/period';
import { commitCarryIn, defaultGoLivePeriod, midYearPlan, noteCarryIn } from '../billing/carryIn';
import { toCsv, csvMoney, csvDate } from '../billing/csv';
import { isIsoDay } from '../settings/dates';
import { reconcile, reconcileStatus } from '../payments/reconcile';
import { paidForByPayment } from '../billing/paidFor';
import { refundTransaction, refundableTransactions, isStripePayment } from '../payments/refunds';
import { stripeReady } from '../payments/stripe';
import {
  getCurrency,
  getYearViewColumns,
  setYearViewColumns,
  getYearViewFeeNote,
  setYearViewFeeNote,
  YEAR_VIEW_COLUMNS,
  getAutoInvoice,
  setAutoInvoice,
  getAutoInvoiceLast,
  getBillingStartPeriod,
  setBillingStartPeriod,
  getMidYearDoneAt,
  setMidYearDoneAt,
  getInvoiceLabelTemplate,
  setInvoiceLabelTemplate,
} from '../settings';
import { runAutoInvoice } from '../billing/autoInvoice';
import { relationKind, dedupeNumbers, type RelationKind } from '../people/relations';
import { alertStaff, studentName } from '../alerts';
import { resolveSchoolScope } from '../schools';
import { sendReceipt, sendRefund } from '../mail/notify';
import { formatMoney } from '../db/money';

const payLog = makeLog('billing');

const ID = z.string().min(1).max(64);
const NAME = z.string().trim().min(1).max(120);
const CENTS = z.number().int().min(0).max(100_000_000);
/** Charges may be NEGATIVE — a negative charge is how a credit / scholarship / correction is
 *  expressed, since an invoice line is immutable once written (§9). */
const SIGNED_CENTS = z.number().int().min(-100_000_000).max(100_000_000);
const PERIOD = z.string().trim().min(1).max(40);
const NOTE = z.string().trim().max(200);
const now = () => new Date();

/**
 * A date typed into a form on the money path (0.48.0).
 *
 * REFUSED HERE, with one sentence, because nothing downstream can refuse it usefully. §9 fixes the
 * storage format as ISO precisely because every date column is compared as TEXT — so a due date of
 * `lol` is stored happily and then sorts wherever it likes, is never past due (`due_date < today` is
 * false), and is invisible to autopay (`due_date <= today` is false too). A payment date fails louder
 * and worse: `new Date('T12:00:00')` is `NaN`, SQLite stores that as NULL, and the NOT NULL column
 * refuses — which reached the office as `NOT NULL constraint failed: payments.occurred_at`. Clearing
 * the date box in the record-a-payment form was enough to do it.
 *
 * A regex would not be enough: `2026-13-45` is ten characters of the right shape and is not a day, so
 * `settings/dates.ts` is asked instead — the one place that knows what a real stored date is.
 */
function isoDay(value: string, what: string): string {
  const v = value.trim();
  if (!isIsoDay(v)) throw new TRPCError({ code: 'BAD_REQUEST', message: `${what} needs to be a real date, like 2026-03-04.` });
  return v;
}

/** The same check for a field that may legitimately be left blank (no due date, "as of today"). */
function isoDayOrNull(value: string | undefined, what: string): string | null {
  return value && value.trim() ? isoDay(value, what) : null;
}

/**
 * Who a bulk apply targets: explicit students, or everyone active in a class or course.
 *
 * DELIBERATELY NARROWER THAN `AUDIENCE` — there is no `all` here. The resolver these hand off to
 * (structure/audience.ts) understands "everyone", because the onboarding message needs it; a one-click
 * "put this charge on every student in the school" is a different proposition from a one-click "write to
 * every family", and the difference is that this one moves money. Widening it is a decision, not a
 * convenience: leave the boundary narrow and the one resolver shared.
 */
const BULK_TARGET = z.discriminatedUnion('kind', [AUDIENCE_STUDENTS, AUDIENCE_CLASS, AUDIENCE_COURSE]);

/** Where a charge's label + amount come from: a preconfigured item (optionally re-priced for
 *  this application) or a free-typed one-off. */
const CHARGE_SOURCE = z.union([
  z.object({ kind: z.literal('item'), chargeItemId: ID, amountCents: SIGNED_CENTS.optional() }),
  z.object({ kind: z.literal('custom'), label: NAME, amountCents: SIGNED_CENTS }),
]);

/** Freeze the label + amount onto the charge. Renaming or repricing the item afterwards must
 *  never rewrite a charge already applied (§9's frozen-fact rule), so we copy, never reference. */
function snapshotCharge(source: z.infer<typeof CHARGE_SOURCE>): { label: string; amountCents: number; chargeItemId: string | null } {
  if (source.kind === 'custom') {
    if (source.amountCents === 0) throw new TRPCError({ code: 'BAD_REQUEST', message: 'A charge cannot be zero.' });
    return { label: source.label, amountCents: source.amountCents, chargeItemId: null };
  }
  const item = db.select({ id: chargeItems.id, name: chargeItems.name, defaultAmountCents: chargeItems.defaultAmountCents, status: chargeItems.status }).from(chargeItems).where(eq(chargeItems.id, source.chargeItemId)).get();
  if (!item) throw new TRPCError({ code: 'NOT_FOUND', message: 'Item not found.' });
  if (item.status !== 'active') throw new TRPCError({ code: 'CONFLICT', message: 'That item is archived.' });
  const amountCents = source.amountCents ?? item.defaultAmountCents;
  if (amountCents === 0) throw new TRPCError({ code: 'BAD_REQUEST', message: 'A charge cannot be zero.' });
  return { label: item.name, amountCents, chargeItemId: item.id };
}

/**
 * Refuse a period key that would bill a month twice.
 *
 * Two ways that happens, both silent until the year's total is wrong: a mis-spelled month (`2027-2` is
 * a DIFFERENT key from `2027-02`, so UNIQUE(student, period) does not stop it and February is billed
 * again), and a month before this install started billing (a madrasa that recorded the autumn as one
 * carried-forward figure would now be owed it twice — see settings.getBillingStartPeriod).
 *
 * A `term` period is exempt from the month spelling: its key comes from a configured term row, not from
 * anybody typing.
 */
function assertBillablePeriod(periodKey: string, periodKind: 'month' | 'term' = 'month'): void {
  if (periodKind === 'month') {
    const err = periodKeyError(periodKey);
    if (err) throw new TRPCError({ code: 'BAD_REQUEST', message: err });
  }
  const floor = getBillingStartPeriod();
  if (floor && isMonthPeriod(periodKey) && periodBefore(periodKey, floor)) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: `This install bills from ${floor} onwards. Anything earlier is already covered by the balances carried forward, so billing it again would charge it twice.`,
    });
  }
}

/**
 * The label an invoice gets — resolved HERE, not in the browser (0.48.0).
 *
 * The form used to be two free-text boxes typed out every month: the period key AND the label, with
 * nothing checking they agreed. "Tuition — Jun 2026" filed under `2026-07` was one keystroke away, and an
 * invoice is money history — it is never edited afterwards (§9), so the wrong month would be on that
 * parent's bill for good. Deriving the label from the period key the invoice is actually filed under is
 * what makes that impossible rather than merely unlikely.
 *
 * The template is REMEMBERED, so next month's form opens with this madrasah's own wording and the nightly
 * job says the same thing (settings.getInvoiceLabelTemplate).
 *
 * An explicit `label` still wins when given: it is what every existing caller and test sends, and a
 * caller that has already decided on an exact string should get exactly that.
 */
function invoiceLabelFor(input: { periodKey: string; label?: string; labelTemplate?: string }, opts: { remember?: boolean } = {}): string {
  if (input.label?.trim()) return input.label.trim();
  const template = input.labelTemplate?.trim() || getInvoiceLabelTemplate();
  // `remember` is what separates the two Generate forms (0.48.0). A WHOLE-SCHOOL run defines how this
  // madrasah names its invoices, so its wording is saved and the nightly job inherits it. A ONE-HOUSEHOLD
  // run is usually a catch-up or a correction, and a label typed for that one family must not quietly
  // become the default for everybody else's bills.
  if (opts.remember && input.labelTemplate?.trim()) setInvoiceLabelTemplate(input.labelTemplate.trim());
  return resolveInvoiceLabel(template, input.periodKey);
}

/**
 * The months worth offering in the Generate form: the current school year's, if one is configured.
 *
 * Not a free-typed period key, and not every month since 1970 — a madrasa bills the months it teaches,
 * and the school year already says which those are (billing/schoolYear.ts). With no year set yet, a
 * window around today keeps the form usable rather than empty.
 */
function invoiceMonthOptions(): { periodKey: string; label: string }[] {
  const year = db.select().from(schoolYears).where(eq(schoolYears.isCurrent, true)).get();
  if (year?.startYear != null) {
    return schoolYearMonths(year.startYear, year.startMonth, year.endMonth).map((m) => ({
      periodKey: m.periodKey,
      label: resolveInvoiceLabel('[mon] [year]', m.periodKey),
    }));
  }
  const now = new Date();
  const out: { periodKey: string; label: string }[] = [];
  for (let i = -6; i <= 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const periodKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    out.push({ periodKey, label: resolveInvoiceLabel('[mon] [year]', periodKey) });
  }
  return out;
}

/** Kept as a name here because two dozen call sites read better for it, but the RULE lives in
 *  structure/audience.ts now — shared with the onboarding message, so the two can never disagree about
 *  whether a withdrawn child is in a course. */
const resolveTarget = resolveAudience;

/** Invoice rows for a set of students, newest first, each carrying whose bill it is. Shared by the
 *  per-student window and the household one so the two can never disagree about a total. */
function invoiceRowsFor(studentIds: string[]) {
  if (!studentIds.length) return [];
  return db
    .select({ id: invoices.id, studentId: invoices.studentId, label: invoices.label, periodKey: invoices.periodKey, dueDate: invoices.dueDate, status: invoices.status, createdAt: invoices.createdAt })
    .from(invoices)
    .where(inArray(invoices.studentId, studentIds))
    .orderBy(desc(invoices.createdAt))
    .all()
    .map((i) => {
      const total = invoiceTotal(db, i.id);
      const paid = invoicePaid(db, i.id);
      return {
        id: i.id,
        studentId: i.studentId,
        label: i.label,
        periodKey: i.periodKey,
        dueDate: i.dueDate,
        status: i.status,
        totalCents: total,
        paidCents: paid,
        balanceCents: total - paid,
        // What the bill is made of, so the office can see at a glance that the $250 is $200 of tuition
        // plus a $50 book fee — and which of the two the money has actually covered.
        lines: invoiceLines(db, i.id),
      };
    });
}

/** Payment rows for a set of students, newest first. */
function paymentRowsFor(studentIds: string[]) {
  if (!studentIds.length) return [];
  const rows = db
    .select({ id: payments.id, studentId: payments.studentId, amountCents: payments.amountCents, channel: payments.channel, occurredAt: payments.occurredAt, memo: payments.memo, reversalOf: payments.reversalOf, by: payments.recordedByName })
    .from(payments)
    .where(inArray(payments.studentId, studentIds))
    .orderBy(desc(payments.occurredAt), desc(payments.createdAt))
    .all();
  /**
   * WHAT each payment was for (0.48.0), not only how it arrived.
   *
   * The office's ledger said cash / card / autopay and a date, which answers "how" and leaves "which bill"
   * to be worked out from the amount — impossible on a monthly plan, where every row is the same figure.
   * The parent portal got this first; the office needs it more, because the office is who gets asked.
   *
   * Derived from the allocations on every read (billing/paidFor.ts), so it follows the recompute rather
   * than freezing whatever was true on the day.
   */
  const forWhat = paidForByPayment(db, rows.map((r) => r.id));
  // `byCard` so the screen can stop offering a plain ledger reversal on money that lives at Stripe.
  // Server-side is where it is ENFORCED (`reversePayment` refuses it); this is so the office is not
  // offered a button that then refuses — a dialog on an action that cannot work is how people learn
  // to distrust the ones that do (§15).
  return rows.map((r) => ({
    ...r,
    byCard: isStripePayment(r.id),
    paidFor: forWhat.get(r.id) ?? { labels: [], more: 0, advance: true },
  }));
}

/** The mid-year go-live input — shared by preview and commit so they cannot drift (see below). */
const MID_YEAR_INPUT = z.object({
  goLivePeriod: PERIOD,
  schoolYearId: ID.optional(),
  /** What the office said about each child. A child not mentioned is treated as square. */
  rows: z
    .array(
      z.object({
        studentId: ID,
        paidThrough: z.union([PERIOD, z.literal('')]).optional(),
        /** "They have paid nothing at all this year" — resolved to a real month in `midYearPlan`, so
         *  nothing downstream ever sees a sentinel (0.48.0). */
        paidNothing: z.boolean().optional(),
        amountOverrideCents: CENTS.optional(),
        kindOverride: z.enum(['owes', 'ahead']).optional(),
      }),
    )
    .max(4000)
    .optional(),
  /** When the money/debt was true, for the artifacts' dates. Defaults to today. */
  asOf: z.string().max(20).optional(),
  memo: NOTE.optional(),
});

/** Household totals for the preview — a parent pays once for all their children, so this is the number
 *  they will actually read. Summed from the same per-child figures shown above it. */
function familyTotals(rows: { familyId: string; familyLabel: string; afterOwedCents: number; afterCreditCents: number }[]) {
  const m = new Map<string, { familyId: string; label: string; owedCents: number; creditCents: number }>();
  for (const r of rows) {
    const cur = m.get(r.familyId) ?? { familyId: r.familyId, label: r.familyLabel, owedCents: 0, creditCents: 0 };
    cur.owedCents += r.afterOwedCents;
    cur.creditCents += r.afterCreditCents;
    m.set(r.familyId, cur);
  }
  // A household with money owed AND credit sitting on another child nets out, because one adult pays
  // for all of them — showing both numbers would read as two separate problems.
  return [...m.values()]
    .map((f) => {
      const net = f.owedCents - f.creditCents;
      return { familyId: f.familyId, label: f.label, owedCents: net > 0 ? net : 0, creditCents: net < 0 ? -net : 0 };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Distinct, non-empty email addresses from a set of guardians — compared case-insensitively, since
 *  the same address typed twice with different capitalization is one inbox. */
function emails(gs: { email: string | null }[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of gs) {
    const v = (g.email ?? '').trim();
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
}

export const billingRouter = router({
  /** The install currency, for money formatting in the finance UI. */
  currency: adminOrFinanceProcedure.query(() => ({ currency: getCurrency() })),

  // ── Fee plans ────────────────────────────────────────────────────────────────
  //
  // READ is finance's too — they cannot bill without knowing what the plans are, and every screen
  // showing an invoice needs their names. WRITING them is ADMIN ONLY (0.42.0, Hasan's call): a fee
  // plan is what the madrasa charges, which is a decision of the office, not of whoever is at the
  // desk reconciling payments this week. Archiving one silently unassigns every student on it and
  // deleting one is permanent, so both stay behind the same wall as the rest of the configuration.
  feePlanList: adminOrFinanceProcedure.query(() => db.select().from(feePlans).where(eq(feePlans.status, 'active')).orderBy(asc(feePlans.name)).all()),

  feePlanCreate: adminProcedure.input(z.object({ name: NAME, amountCents: CENTS.min(1), cadence: z.enum(['monthly', 'per_term', 'one_time']) })).mutation(({ ctx, input }) => {
    const id = rid('fee');
    const ts = now();
    db.insert(feePlans).values({ id, name: input.name, amountCents: input.amountCents, cadence: input.cadence, status: 'active', createdAt: ts, updatedAt: ts }).run();
    audit(auditActor(ctx), 'feePlan.create', { entity: 'feePlan', entityId: id, detail: { amountCents: input.amountCents, cadence: input.cadence } });
    return { id };
  }),

  feePlanArchive: adminProcedure.input(z.object({ id: ID })).mutation(({ ctx, input }) => {
    if (!db.select({ id: feePlans.id }).from(feePlans).where(eq(feePlans.id, input.id)).get()) throw new TRPCError({ code: 'NOT_FOUND', message: 'Fee plan not found.' });
    // Archiving a plan removes it everywhere: flip the status AND drop its student assignments, so the
    // family billing page and invoice generation agree (invoices already skip non-active plans) and no
    // orphaned student_fees linger. Existing invoices/payments are untouched (immutable).
    const removed = db.delete(studentFees).where(eq(studentFees.feePlanId, input.id)).run().changes;
    db.update(feePlans).set({ status: 'archived', updatedAt: now() }).where(eq(feePlans.id, input.id)).run();
    audit(auditActor(ctx), 'feePlan.archive', { entity: 'feePlan', entityId: input.id, detail: { unassigned: removed } });
    return { ok: true as const };
  }),

  /**
   * Whether a fee plan can be deleted outright, and what goes with it.
   *
   * `invoice_items.fee_plan_id` is the line that says WHY a bill said what it said. A plan named on
   * a raised invoice is part of that invoice's meaning, so deleting it would rewrite history — that
   * one is archived, not deleted. A plan that has never been billed is just a wrong row.
   */
  feePlanDeletable: adminProcedure.input(z.object({ id: ID })).query(({ input }) => {
    if (!db.select({ id: feePlans.id }).from(feePlans).where(eq(feePlans.id, input.id)).get()) throw new TRPCError({ code: 'NOT_FOUND', message: 'Fee plan not found.' });
    const billed = db.select({ id: invoiceItems.id }).from(invoiceItems).where(eq(invoiceItems.feePlanId, input.id)).all().length;
    return {
      deletable: billed === 0,
      invoiceLines: billed,
      assignedStudents: db.select({ id: studentFees.id }).from(studentFees).where(eq(studentFees.feePlanId, input.id)).all().length,
    };
  }),

  /** Delete a fee plan for good. Refuses once it appears on any invoice (see `feePlanDeletable`);
   *  its student assignments are configuration and go with it. */
  feePlanDelete: adminProcedure.input(z.object({ id: ID })).mutation(({ ctx, input }) => {
    if (!db.select({ id: feePlans.id }).from(feePlans).where(eq(feePlans.id, input.id)).get()) throw new TRPCError({ code: 'NOT_FOUND', message: 'Fee plan not found.' });
    if (db.select({ id: invoiceItems.id }).from(invoiceItems).where(eq(invoiceItems.feePlanId, input.id)).all().length) {
      throw new TRPCError({ code: 'CONFLICT', message: 'This plan has been billed, so it’s part of your invoice history and can’t be deleted. Archive it instead.' });
    }
    let unassigned = 0;
    db.transaction((tx) => {
      unassigned = tx.delete(studentFees).where(eq(studentFees.feePlanId, input.id)).run().changes;
      tx.delete(feePlans).where(eq(feePlans.id, input.id)).run();
    });
    audit(auditActor(ctx), 'feePlan.delete', { entity: 'feePlan', entityId: input.id, detail: { unassigned } });
    return { ok: true as const, unassigned };
  }),

  // ── Per-student fee assignment + per-family discount ─────────────────────────
  /** A family's active students, each with the fee plan(s) assigned (one row per assignment;
   *  a student with no fee still appears once, with null fee fields). */
  familyFees: adminOrFinanceProcedure.input(z.object({ familyId: ID })).query(({ input }) => {
    const rows = db
      .select({
        studentId: students.id,
        fullName: students.fullName,
        feeId: studentFees.id,
        feePlanId: feePlans.id,
        feePlanName: feePlans.name,
        amountCents: feePlans.amountCents,
        cadence: feePlans.cadence,
        overrideAmountCents: studentFees.overrideAmountCents,
        note: studentFees.note,
      })
      .from(students)
      .leftJoin(studentFees, eq(studentFees.studentId, students.id))
      .leftJoin(feePlans, eq(feePlans.id, studentFees.feePlanId))
      .where(and(eq(students.familyId, input.familyId), eq(students.status, 'active')))
      .orderBy(asc(students.fullName))
      .all();
    // Surface the amount that will actually be billed so the UI never has to re-derive it.
    return rows.map((r) => ({ ...r, effectiveAmountCents: r.feeId ? (r.overrideAmountCents ?? r.amountCents) : null }));
  }),

  assignFee: adminOrFinanceProcedure
    .input(z.object({ studentId: ID, feePlanId: ID, overrideAmountCents: CENTS.optional(), note: NOTE.optional() }))
    .mutation(({ ctx, input }) => {
      if (!db.select({ id: students.id }).from(students).where(eq(students.id, input.studentId)).get()) throw new TRPCError({ code: 'NOT_FOUND', message: 'Student not found.' });
      if (!db.select({ id: feePlans.id }).from(feePlans).where(eq(feePlans.id, input.feePlanId)).get()) throw new TRPCError({ code: 'NOT_FOUND', message: 'Fee plan not found.' });
      const ts = now();
      const existing = db.select({ id: studentFees.id }).from(studentFees).where(and(eq(studentFees.studentId, input.studentId), eq(studentFees.feePlanId, input.feePlanId))).get();
      if (existing) {
        // Re-assigning an existing plan is how the UI edits the override, so treat it as an upsert
        // rather than a silent no-op.
        if (input.overrideAmountCents !== undefined || input.note !== undefined) {
          db.update(studentFees)
            .set({ overrideAmountCents: input.overrideAmountCents ?? null, note: input.note || null, updatedAt: ts })
            .where(eq(studentFees.id, existing.id))
            .run();
          audit(auditActor(ctx), 'fee.override', { entity: 'student', entityId: input.studentId, detail: { feePlanId: input.feePlanId, overrideAmountCents: input.overrideAmountCents ?? null } });
        }
        return { ok: true as const };
      }
      db.insert(studentFees)
        .values({ id: rid('stf'), studentId: input.studentId, feePlanId: input.feePlanId, overrideAmountCents: input.overrideAmountCents ?? null, note: input.note || null, createdAt: ts, updatedAt: ts })
        .run();
      audit(auditActor(ctx), 'fee.assign', { entity: 'student', entityId: input.studentId, detail: { feePlanId: input.feePlanId, overrideAmountCents: input.overrideAmountCents ?? null } });
      return { ok: true as const };
    }),

  /**
   * The fee assignments of a named set of students (0.48.0) — what the import's fee step reads.
   *
   * `familyFees` above answers the same question per HOUSEHOLD, which is the wrong shape right after an
   * import: the office is looking at the 36 children they just added, each in a household of their own,
   * and 36 queries to show one table is silly. Bounded to the import's own cap.
   */
  studentFeeList: adminOrFinanceProcedure
    .input(z.object({ studentIds: z.array(ID).min(1).max(2000) }))
    .query(({ input }) =>
      db
        .select({
          studentId: students.id,
          fullName: students.fullName,
          feeId: studentFees.id,
          feePlanId: feePlans.id,
          feePlanName: feePlans.name,
          planAmountCents: feePlans.amountCents,
          cadence: feePlans.cadence,
          overrideAmountCents: studentFees.overrideAmountCents,
          note: studentFees.note,
        })
        .from(students)
        .leftJoin(studentFees, eq(studentFees.studentId, students.id))
        .leftJoin(feePlans, eq(feePlans.id, studentFees.feePlanId))
        .where(inArray(students.id, input.studentIds))
        .orderBy(asc(students.fullName))
        .all()
        .map((r) => ({ ...r, effectiveAmountCents: r.feeId ? (r.overrideAmountCents ?? r.planAmountCents) : null })),
    ),

  /**
   * "This child carries exactly this plan, at this amount" (0.48.0).
   *
   * The import gives every row the SAME default plan, because a spreadsheet column cannot express "the
   * second child pays less"; the office then wants to correct a handful of them without opening 36
   * household records. `assignFee` alone could not do it — it adds a plan but never takes the wrong one
   * away, so changing a child's plan through it left them carrying both and billed twice.
   *
   * So this REPLACES the student's assignments with the one given, which is what "set the fee" means.
   * That is destructive by design and therefore stated plainly: a child who legitimately carries several
   * fees (tuition plus a book fee) must be edited on their own record, not here.
   */
  setStudentFee: adminOrFinanceProcedure
    .input(z.object({ studentId: ID, feePlanId: ID, overrideAmountCents: CENTS.nullable().optional(), note: NOTE.optional() }))
    .mutation(({ ctx, input }) => {
      if (!db.select({ id: students.id }).from(students).where(eq(students.id, input.studentId)).get()) throw new TRPCError({ code: 'NOT_FOUND', message: 'Student not found.' });
      if (!db.select({ id: feePlans.id }).from(feePlans).where(eq(feePlans.id, input.feePlanId)).get()) throw new TRPCError({ code: 'NOT_FOUND', message: 'Fee plan not found.' });
      const ts = now();
      const override = input.overrideAmountCents ?? null;
      // The note explains an override and only an override, so it goes when the override does — a
      // "sibling rate" note left on a child back at the plan price is a claim about nothing.
      const note = override == null ? null : input.note?.trim() || null;
      db.transaction((tx) => {
        // Any OTHER plan goes, so the child ends up billed once. Nothing here touches an invoice
        // already raised — a fee is configuration, and money already billed is history (§9).
        tx.delete(studentFees).where(and(eq(studentFees.studentId, input.studentId), ne(studentFees.feePlanId, input.feePlanId))).run();
        const existing = tx.select({ id: studentFees.id }).from(studentFees).where(and(eq(studentFees.studentId, input.studentId), eq(studentFees.feePlanId, input.feePlanId))).get();
        if (existing) tx.update(studentFees).set({ overrideAmountCents: override, note, updatedAt: ts }).where(eq(studentFees.id, existing.id)).run();
        else tx.insert(studentFees).values({ id: rid('stf'), studentId: input.studentId, feePlanId: input.feePlanId, overrideAmountCents: override, note, createdAt: ts, updatedAt: ts }).run();
      });
      audit(auditActor(ctx), 'fee.setStudent', { entity: 'student', entityId: input.studentId, detail: { feePlanId: input.feePlanId, overrideAmountCents: override } });
      return { ok: true as const };
    }),

  /** Change (or clear, by omitting `overrideAmountCents`) one student's amount for a plan they
   *  already carry — the "override per student instead of making a whole new plan" path. */
  setFeeOverride: adminOrFinanceProcedure
    .input(z.object({ id: ID, overrideAmountCents: CENTS.nullable().optional(), note: NOTE.optional() }))
    .mutation(({ ctx, input }) => {
      const row = db.select({ id: studentFees.id, studentId: studentFees.studentId }).from(studentFees).where(eq(studentFees.id, input.id)).get();
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Fee assignment not found.' });
      const patch: Partial<typeof studentFees.$inferInsert> = { updatedAt: now() };
      if (input.overrideAmountCents !== undefined) patch.overrideAmountCents = input.overrideAmountCents;
      if (input.note !== undefined) patch.note = input.note || null;
      db.update(studentFees).set(patch).where(eq(studentFees.id, input.id)).run();
      audit(auditActor(ctx), 'fee.override', { entity: 'student', entityId: row.studentId, detail: { feeId: input.id, overrideAmountCents: input.overrideAmountCents ?? null } });
      return { ok: true as const };
    }),

  /** Mass-apply one plan to many students (by explicit ids, or a whole class or course).
   *  Idempotent: a student who already carries the plan is skipped, not duplicated. */
  assignFeeBulk: adminOrFinanceProcedure
    .input(z.object({ feePlanId: ID, target: BULK_TARGET, overrideAmountCents: CENTS.optional(), note: NOTE.optional() }))
    .mutation(({ ctx, input }) => {
      if (!db.select({ id: feePlans.id }).from(feePlans).where(and(eq(feePlans.id, input.feePlanId), eq(feePlans.status, 'active'))).get()) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Fee plan not found.' });
      }
      const ids = resolveTarget(input.target);
      const ts = now();
      let assigned = 0;
      let skipped = 0;
      db.transaction((tx) => {
        for (const studentId of ids) {
          const has = tx.select({ id: studentFees.id }).from(studentFees).where(and(eq(studentFees.studentId, studentId), eq(studentFees.feePlanId, input.feePlanId))).get();
          if (has) {
            skipped++;
            continue;
          }
          tx.insert(studentFees)
            .values({ id: rid('stf'), studentId, feePlanId: input.feePlanId, overrideAmountCents: input.overrideAmountCents ?? null, note: input.note || null, createdAt: ts, updatedAt: ts })
            .run();
          assigned++;
        }
      });
      audit(auditActor(ctx), 'fee.assignBulk', { entity: 'billing', detail: { feePlanId: input.feePlanId, targeted: ids.length, assigned, skipped } });
      return { assigned, skipped, targeted: ids.length };
    }),

  unassignFee: adminOrFinanceProcedure.input(z.object({ id: ID })).mutation(({ ctx, input }) => {
    db.delete(studentFees).where(eq(studentFees.id, input.id)).run();
    audit(auditActor(ctx), 'fee.unassign', { entity: 'studentFee', entityId: input.id });
    return { ok: true as const };
  }),

  // No `setDiscount` any more. A family-level discount had nowhere honest to sit once each child gets
  // their own bill, so a reduced rate is now the per-student fee override (`assignFee`'s
  // `overrideAmountCents`) — on the child whose bill it actually reduces.

  // ── Invoice generation ───────────────────────────────────────────────────────
  /** `periodKind` drives the cadence gate: a `month` period bills monthly plans, a `term` period
   *  bills per-term plans, and one-time plans bill once on whichever comes first. Defaults to
   *  `month` — the common case, and what every existing caller means. */
  /**
   * The label TEMPLATE this madrasah uses, and the months it makes sense to generate (0.48.0).
   *
   * The form used to be two free-text boxes — the period key AND the label — typed out every month, with
   * nothing checking they agreed. "Tuition — Jun 2026" filed under `2026-07` was one keystroke away, and
   * an invoice is money history: it is not edited afterwards (§9). So the month is picked from this list
   * and the label is written once with tags in it.
   */
  invoiceLabelConfig: adminOrFinanceProcedure.query(() => ({
    template: getInvoiceLabelTemplate(),
    /** What the tags mean, resolved against the current month so the UI can show real examples. */
    tags: ['month', 'mon', 'year', 'yy', 'period'].map((tag) => ({ tag, example: resolveInvoiceLabel(`[${tag}]`, defaultGoLivePeriod()) })),
    /** The months of the current school year, if one is set — the only months worth billing. Falls back
     *  to a window around today so the form still works before a year is configured. */
    months: invoiceMonthOptions(),
    suggested: defaultGoLivePeriod(),
  })),

  generatePeriod: adminOrFinanceProcedure
    .input(z.object({ periodKey: PERIOD, label: NAME.optional(), labelTemplate: NAME.optional(), dueDate: z.string().max(20).optional(), periodKind: z.enum(['month', 'term']).optional() }))
    .mutation(({ ctx, input }) => {
      assertBillablePeriod(input.periodKey, input.periodKind ?? 'month');
      const r = generateForPeriod({ periodKey: input.periodKey, label: invoiceLabelFor(input, { remember: true }), dueDate: isoDayOrNull(input.dueDate, 'The due date'), periodKind: input.periodKind });
      audit(auditActor(ctx), 'invoice.generatePeriod', { entity: 'billing', detail: { periodKey: input.periodKey, periodKind: input.periodKind ?? 'month', created: r.created } });
      return r;
    }),

  generateFamily: adminOrFinanceProcedure
    .input(z.object({ familyId: ID, periodKey: PERIOD, label: NAME.optional(), labelTemplate: NAME.optional(), dueDate: z.string().max(20).optional(), periodKind: z.enum(['month', 'term']).optional() }))
    .mutation(({ ctx, input }) => {
      assertBillablePeriod(input.periodKey, input.periodKind ?? 'month');
      const r = generateForFamily(input.familyId, { periodKey: input.periodKey, label: invoiceLabelFor(input), dueDate: isoDayOrNull(input.dueDate, 'The due date'), periodKind: input.periodKind });
      audit(auditActor(ctx), 'invoice.generateFamily', { entity: 'family', entityId: input.familyId, detail: { periodKey: input.periodKey, periodKind: input.periodKind ?? 'month', created: r.created } });
      return r;
    }),

  /** The auto-generate schedule, and when it last ran. */
  autoInvoiceGet: adminOrFinanceProcedure.query(() => ({ ...getAutoInvoice(), lastPeriodKey: getAutoInvoiceLast() })),

  /** Turn monthly auto-generation on/off and choose the day. Admin-only: it starts billing every
   *  family on its own, which is a policy decision, not a day-to-day finance action. */
  autoInvoiceSet: adminProcedure
    .input(z.object({ enabled: z.boolean().optional(), day: z.number().int().min(1).max(31).optional(), dueDay: z.number().int().min(1).max(31).nullable().optional() }))
    .mutation(({ ctx, input }) => {
      setAutoInvoice(input);
      audit(auditActor(ctx), 'billing.autoInvoice', { entity: 'settings', detail: { ...input } });
      return { ok: true as const };
    }),

  /** Run the scheduled generation right now — the same code path the cron uses, so "Run now" can
   *  never behave differently from the nightly job. Reports why it did nothing, if it did nothing. */
  autoInvoiceRunNow: adminOrFinanceProcedure.mutation(({ ctx }) => {
    const r = runAutoInvoice();
    audit(auditActor(ctx), 'billing.autoInvoice.run', { entity: 'billing', detail: { ran: r.ran, reason: r.reason ?? null, periodKey: r.periodKey ?? null, created: r.created ?? 0 } });
    return r;
  }),

  voidInvoice: adminOrFinanceProcedure.input(z.object({ id: ID })).mutation(({ ctx, input }) => {
    const inv = db.select({ id: invoices.id, status: invoices.status }).from(invoices).where(eq(invoices.id, input.id)).get();
    if (!inv) throw new TRPCError({ code: 'NOT_FOUND', message: 'Invoice not found.' });
    if (inv.status === 'void') return { ok: true as const };
    // A voided invoice drops out of the invoiced total, but its payments stay counted — voiding a
    // paid bill would understate the family balance. Reverse the payment first (§9: reversals only).
    if (invoicePaid(db, input.id) !== 0) throw new TRPCError({ code: 'CONFLICT', message: 'Reverse the payments on this invoice before voiding it.' });
    db.update(invoices).set({ status: 'void', updatedAt: now() }).where(eq(invoices.id, input.id)).run();
    audit(auditActor(ctx), 'invoice.void', { entity: 'invoice', entityId: input.id });
    return { ok: true as const };
  }),

  // ── Year view (the students × months payment grid) ───────────────────────────
  /** Everything the year grid renders: the school year's months, one row per active student with
   *  their effective monthly amount, and a cell per month.
   *
   *  A cell reports the status of the FAMILY's invoice for that period, because that is what is
   *  actually billed and paid — siblings on one bill therefore show the same cell, which is correct.
   *  The per-student number in `monthlyAmountCents` is that student's share.
   *
   *  Optional columns are admin-configured (settings) and resolved server-side, so a column the
   *  admin has not switched on is never sent to the browser at all. */
  yearGrid: adminOrFinanceProcedure
    .input(z.object({ schoolYearId: ID.optional(), includeWithdrawn: z.boolean().optional(), schoolId: ID.optional() }).optional())
    .query(({ ctx, input }) => {
      // The grid is one school's year, so both halves are scoped (0.47.0): the YEAR comes from the
      // school in view — "current" is per school now, and an unscoped lookup would pick whichever
      // school's current year the planner returned first — and so do the student rows below.
      const scope = resolveSchoolScope(ctx.session?.userId ?? null, input?.schoolId);
      const year = input?.schoolYearId
        ? db.select().from(schoolYears).where(and(eq(schoolYears.id, input.schoolYearId), inArray(schoolYears.schoolId, scope.ids))).get()
        : db.select().from(schoolYears).where(and(eq(schoolYears.isCurrent, true), inArray(schoolYears.schoolId, scope.ids))).orderBy(asc(schoolYears.label)).get();
      if (!year) return { year: null, needsStartYear: false, months: [], columns: [], rows: [], currency: getCurrency(), startPeriod: null as string | null };
      // Rows follow the YEAR's school, not the requested filter: asking for a specific year implies its
      // school, and mixing another school's children into it would be nonsense.
      const rowSchoolIds = year.schoolId ? [year.schoolId] : scope.ids;
      if (year.startYear == null) {
        // Configured before start_year existed — the UI asks for it rather than guessing a calendar.
        return { year: { id: year.id, label: year.label }, needsStartYear: true, months: [], columns: [], rows: [], currency: getCurrency(), startPeriod: getBillingStartPeriod() };
      }

      const months = schoolYearMonths(year.startYear, year.startMonth, year.endMonth);
      const columns = getYearViewColumns();
      // Off means NOT SENT, not hidden in the browser (0.48.0) — the same rule the optional columns
      // follow. The note is the office's own words about a bursary, and a page that gets printed and left
      // on a desk should carry only what an admin asked for (§14).
      const wantsFeeNote = getYearViewFeeNote();
      const periodKeys = months.map((m) => m.periodKey);
      // The pre-go-live marking and the invoice states both come from billing/yearCells.ts, shared with
      // the parent portal so a family and the office are never looking at different squares (0.48.0).
      const startPeriod = getBillingStartPeriod();

      const studentRows = db
        .select({
          id: students.id,
          fullName: students.fullName,
          status: students.status,
          dob: students.dob,
          studentCode: students.studentCode,
          familyId: students.familyId,
          familyName: families.name,
          classId: students.classId,
          className: classes.name,
          courseId: classes.courseId,
          courseName: courses.name,
        })
        .from(students)
        .innerJoin(families, eq(families.id, students.familyId))
        .leftJoin(classes, eq(classes.id, students.classId))
        .leftJoin(courses, eq(courses.id, classes.courseId))
        .where(and(inArray(students.schoolId, rowSchoolIds), input?.includeWithdrawn ? undefined : eq(students.status, 'active')))
        .orderBy(asc(courses.sortOrder), asc(courses.name), asc(classes.sortOrder), asc(classes.name), asc(students.fullName))
        .all();

      // Monthly fee total per student (override wins), so the "Paying" column matches what a month
      // actually bills. Non-monthly cadences are excluded — they do not recur per month.
      const monthly = new Map<string, { amountCents: number; note: string | null }>();
      for (const r of db
        .select({ studentId: studentFees.studentId, planAmount: feePlans.amountCents, override: studentFees.overrideAmountCents, note: studentFees.note })
        .from(studentFees)
        .innerJoin(feePlans, eq(feePlans.id, studentFees.feePlanId))
        .where(and(eq(feePlans.status, 'active'), eq(feePlans.cadence, 'monthly')))
        .all()) {
        const prev = monthly.get(r.studentId);
        const amt = (prev?.amountCents ?? 0) + (r.override ?? r.planAmount);
        monthly.set(r.studentId, { amountCents: amt, note: r.note ?? prev?.note ?? null });
      }

      const cellsByStudent = yearCellsFor(studentRows.map((r) => r.id), periodKeys);

      // Guardian contact, only when a guardian column is actually enabled — and classified by WHO each
      // adult is, so each number gets its own labeled, tappable column (§ settings/YEAR_VIEW_COLUMNS).
      const wantsGuardians = columns.some((c) => c === 'guardianNames' || c.endsWith('Phone') || c.endsWith('Email'));
      const guardiansByFamily = new Map<string, { name: string; phone: string | null; email: string | null; kind: RelationKind; isEmergency: boolean }[]>();
      if (wantsGuardians) {
        for (const g of db
          .select({
            familyId: guardianFamilies.familyId,
            name: guardians.name,
            phone: guardians.phone,
            email: guardians.email,
            relation: guardianFamilies.relation,
            isEmergency: guardianFamilies.isEmergencyContact,
          })
          .from(guardianFamilies)
          .innerJoin(guardians, eq(guardians.id, guardianFamilies.guardianId))
          .all()) {
          if (!guardiansByFamily.has(g.familyId)) guardiansByFamily.set(g.familyId, []);
          guardiansByFamily.get(g.familyId)!.push({ name: g.name, phone: g.phone, email: g.email, kind: relationKind(g.relation), isEmergency: g.isEmergency });
        }
      }

      // The emergency column reads the emergency-contacts table, plus any guardian flagged as one
      // before that checkbox was removed in 0.42.0 — an office that ticked it should still see the
      // number it meant to record.
      const contactsByFamily = new Map<string, string[]>();
      if (columns.includes('emergencyPhone')) {
        for (const c of db.select({ familyId: emergencyContacts.familyId, phone: emergencyContacts.phone }).from(emergencyContacts).all()) {
          if (!c.phone) continue;
          if (!contactsByFamily.has(c.familyId)) contactsByFamily.set(c.familyId, []);
          contactsByFamily.get(c.familyId)!.push(c.phone);
        }
      }

      const wantsBalance = columns.includes('balance');

      const rows = studentRows.map((s) => {
        const m = monthly.get(s.id);
        const cells = cellsByStudent.get(s.id) ?? [];
        const gs = guardiansByFamily.get(s.familyId) ?? [];
        return {
          studentId: s.id,
          fullName: s.fullName,
          status: s.status,
          familyId: s.familyId,
          familyName: s.familyName,
          classId: s.classId,
          className: s.className,
          courseId: s.courseId,
          courseName: s.courseName,
          monthlyAmountCents: m?.amountCents ?? 0,
          feeNote: wantsFeeNote ? m?.note ?? null : null,
          cells,
          // Only enabled columns are populated — a disabled one is absent from the payload entirely.
          extra: {
            ...(columns.includes('studentId') ? { studentCode: s.studentCode } : {}),
            ...(columns.includes('dob') ? { dob: s.dob } : {}),
            ...(columns.includes('guardianNames') ? { guardianNames: gs.map((g) => g.name) } : {}),
            // One list per column: usually a single number, but a household can hold two fathers'
            // numbers (a mobile and a work line recorded separately) and neither should be dropped.
            ...(columns.includes('fatherPhone') ? { fatherPhone: dedupeNumbers(gs.filter((g) => g.kind === 'father').map((g) => g.phone)) } : {}),
            ...(columns.includes('motherPhone') ? { motherPhone: dedupeNumbers(gs.filter((g) => g.kind === 'mother').map((g) => g.phone)) } : {}),
            ...(columns.includes('otherPhone') ? { otherPhone: dedupeNumbers(gs.filter((g) => g.kind === 'other').map((g) => g.phone)) } : {}),
            ...(columns.includes('emergencyPhone')
              ? { emergencyPhone: dedupeNumbers([...(contactsByFamily.get(s.familyId) ?? []), ...gs.filter((g) => g.isEmergency).map((g) => g.phone)]) }
              : {}),
            ...(columns.includes('fatherEmail') ? { fatherEmail: emails(gs.filter((g) => g.kind === 'father')) } : {}),
            ...(columns.includes('motherEmail') ? { motherEmail: emails(gs.filter((g) => g.kind === 'mother')) } : {}),
            ...(columns.includes('otherEmail') ? { otherEmail: emails(gs.filter((g) => g.kind === 'other')) } : {}),
            // This child's own balance, not the household's — the row is the child.
            ...(wantsBalance ? { balanceCents: studentBalance(s.id).owedCents } : {}),
          },
        };
      });

      // startPeriod goes to the browser so the month HEADINGS can be marked too, not just the cells —
      // a whole column being pre-go-live is a property of the month, not of each child in it.
      return { year: { id: year.id, label: year.label }, needsStartYear: false, months, columns, rows, currency: getCurrency(), startPeriod };
    }),

  /**
   * The months a NEW student's billing may start from (0.48.0) — this school year's months, no earlier
   * than the billing floor and no later than the month we are in (billing/joinMidYear.ts).
   *
   * Admin | finance: it feeds a dropdown on the add-student form, and finance adds students too.
   */
  billFromMonths: adminOrFinanceProcedure
    .input(z.object({ schoolId: ID.optional() }).optional())
    .query(({ ctx, input }) => {
      // Scoped like every other school-aware read (0.47.0): the months come from the school year of the
      // school the child is being added to, since two schools can run different calendars.
      const scope = resolveSchoolScope(ctx.session?.userId ?? null, input?.schoolId);
      return { months: billFromMonths(input?.schoolId ?? scope.ids[0] ?? null), current: currentPeriod() };
    }),

  /** The optional year-view columns and which are on. Admin-only to change — the guardian-contact
   *  columns put phone numbers and email addresses on a whole-school page (§5: finance reads). */
  yearViewColumnsGet: adminOrFinanceProcedure.query(() => ({
    available: [...YEAR_VIEW_COLUMNS],
    enabled: getYearViewColumns(),
    /** Not a column — the fee-override note is a chip inside the "Paying" cell (0.48.0). Same panel, same
     *  decision ("what does this grid show"), so it is carried on the same pair of procedures. */
    feeNote: getYearViewFeeNote(),
  })),

  yearViewColumnsSet: adminProcedure
    .input(z.object({ columns: z.array(z.enum(YEAR_VIEW_COLUMNS)).max(YEAR_VIEW_COLUMNS.length).optional(), feeNote: z.boolean().optional() }))
    .mutation(({ ctx, input }) => {
      if (input.columns !== undefined) setYearViewColumns(input.columns);
      if (input.feeNote !== undefined) setYearViewFeeNote(input.feeNote);
      audit(auditActor(ctx), 'settings.yearViewColumns', { entity: 'settings', detail: { columns: input.columns, feeNote: input.feeNote } });
      return { ok: true as const };
    }),

  /**
   * CSV export for the office's own records — the one thing the app had no way to produce.
   *
   * Four datasets, each a flat sheet: `payments` (the ledger), `invoices`, `balances` (one row per
   * family) and `students` (the billing directory). Code-defined, not composed from user input: the
   * dataset is an enum and every column is written here, so there is no path from a request to a
   * query shape (§14 — the same rule the old Report Creator had).
   *
   * Every cell goes through `csvCell`, which neutralises spreadsheet formula injection: a guardian
   * name or a payment memo is free text a parent can influence, and `=…` in a cell is code the office
   * would run by opening the file.
   *
   * Returns the CSV as a string for the browser to save. Admin + finance, and the export itself is
   * audited — it is a bulk read of billing data, which is worth a trail.
   */
  exportCsv: adminOrFinanceProcedure
    .input(z.object({ dataset: z.enum(['payments', 'invoices', 'balances', 'students']) }))
    .mutation(({ ctx, input }) => {
      const currency = getCurrency();
      let header: string[] = [];
      let rows: unknown[][] = [];

      if (input.dataset === 'payments') {
        header = ['Date', 'Student', 'Student ID', 'Family', 'Amount', 'Currency', 'Method', 'Memo', 'Recorded by', 'Reversal of'];
        rows = db
          .select({
            occurredAt: payments.occurredAt,
            fullName: students.fullName,
            studentCode: students.studentCode,
            familyName: families.name,
            amountCents: payments.amountCents,
            channel: payments.channel,
            memo: payments.memo,
            by: payments.recordedByName,
            reversalOf: payments.reversalOf,
          })
          .from(payments)
          .innerJoin(students, eq(students.id, payments.studentId))
          .innerJoin(families, eq(families.id, students.familyId))
          .orderBy(desc(payments.occurredAt))
          .all()
          .map((p) => [csvDate(p.occurredAt), p.fullName, p.studentCode, p.familyName, csvMoney(p.amountCents), currency, p.channel, p.memo, p.by, p.reversalOf ? 'yes' : '']);
      } else if (input.dataset === 'invoices') {
        header = ['Period', 'Label', 'Student', 'Student ID', 'Family', 'Due', 'Total', 'Paid', 'Outstanding', 'Currency', 'Status'];
        rows = db
          .select({ id: invoices.id, periodKey: invoices.periodKey, label: invoices.label, fullName: students.fullName, studentCode: students.studentCode, familyName: families.name, dueDate: invoices.dueDate, status: invoices.status })
          .from(invoices)
          .innerJoin(students, eq(students.id, invoices.studentId))
          .innerJoin(families, eq(families.id, students.familyId))
          .orderBy(desc(invoices.periodKey), asc(students.fullName))
          .all()
          .map((i) => {
            const total = invoiceTotal(db, i.id);
            const paid = invoicePaid(db, i.id);
            return [i.periodKey, i.label, i.fullName, i.studentCode, i.familyName, i.dueDate, csvMoney(total), csvMoney(paid), csvMoney(total - paid), currency, i.status];
          });
      } else if (input.dataset === 'balances') {
        header = ['Family', 'Outstanding', 'Credit', 'Currency'];
        rows = db
          .select({ id: families.id, name: families.name })
          .from(families)
          .where(eq(families.status, 'active'))
          .orderBy(asc(families.name))
          .all()
          .map((f) => {
            const b = familyBalance(f.id);
            return [f.name, csvMoney(b.owedCents), csvMoney(b.creditCents), currency];
          });
      } else {
        // students — the billing directory, including the Student ID (the identifier the office reads
        // out when a parent calls, and the one a payment is keyed on).
        header = ['Student', 'Student ID', 'Status', 'Family', 'Course', 'Class', 'Monthly fees', 'Currency', 'Guardians', 'Phones', 'Emails'];
        const guardiansByFamily = new Map<string, { name: string; phone: string | null; email: string | null }[]>();
        for (const g of db
          .select({ familyId: guardianFamilies.familyId, name: guardians.name, phone: guardians.phone, email: guardians.email })
          .from(guardianFamilies)
          .innerJoin(guardians, eq(guardians.id, guardianFamilies.guardianId))
          .all()) {
          if (!guardiansByFamily.has(g.familyId)) guardiansByFamily.set(g.familyId, []);
          guardiansByFamily.get(g.familyId)!.push({ name: g.name, phone: g.phone, email: g.email });
        }
        // Effective monthly total per student (override wins) — the same rule the year view uses.
        const monthly = new Map<string, number>();
        for (const r of db
          .select({ studentId: studentFees.studentId, planAmount: feePlans.amountCents, override: studentFees.overrideAmountCents })
          .from(studentFees)
          .innerJoin(feePlans, eq(feePlans.id, studentFees.feePlanId))
          .where(and(eq(feePlans.status, 'active'), eq(feePlans.cadence, 'monthly')))
          .all()) {
          monthly.set(r.studentId, (monthly.get(r.studentId) ?? 0) + (r.override ?? r.planAmount));
        }
        rows = db
          .select({
            id: students.id,
            fullName: students.fullName,
            studentCode: students.studentCode,
            status: students.status,
            familyId: students.familyId,
            familyName: families.name,
            className: classes.name,
            courseName: courses.name,
          })
          .from(students)
          .innerJoin(families, eq(families.id, students.familyId))
          .leftJoin(classes, eq(classes.id, students.classId))
          .leftJoin(courses, eq(courses.id, classes.courseId))
          .orderBy(asc(courses.name), asc(classes.name), asc(students.fullName))
          .all()
          .map((s) => {
            const gs = guardiansByFamily.get(s.familyId) ?? [];
            return [
              s.fullName,
              s.studentCode,
              s.status,
              s.familyName,
              s.courseName,
              s.className,
              csvMoney(monthly.get(s.id) ?? 0),
              currency,
              gs.map((g) => g.name).join('; '),
              gs.map((g) => g.phone).filter(Boolean).join('; '),
              gs.map((g) => g.email).filter(Boolean).join('; '),
            ];
          });
      }

      audit(auditActor(ctx), 'billing.exportCsv', { entity: 'billing', detail: { dataset: input.dataset, rows: rows.length } });
      return { dataset: input.dataset, rows: rows.length, filename: `${input.dataset}-${new Date().toISOString().slice(0, 10)}.csv`, csv: toCsv(header, rows) };
    }),

  // ── Charge items (the configurable Items tab) ────────────────────────────────
  chargeItemList: adminOrFinanceProcedure.query(() =>
    db.select().from(chargeItems).where(eq(chargeItems.status, 'active')).orderBy(asc(chargeItems.sortOrder), asc(chargeItems.name)).all(),
  ),

  chargeItemCreate: adminOrFinanceProcedure.input(z.object({ name: NAME, defaultAmountCents: SIGNED_CENTS, sortOrder: z.number().int().min(0).max(9999).optional() })).mutation(({ ctx, input }) => {
    const id = rid('cit');
    const ts = now();
    db.insert(chargeItems).values({ id, name: input.name, defaultAmountCents: input.defaultAmountCents, sortOrder: input.sortOrder ?? 0, status: 'active', createdAt: ts, updatedAt: ts }).run();
    audit(auditActor(ctx), 'chargeItem.create', { entity: 'chargeItem', entityId: id, detail: { defaultAmountCents: input.defaultAmountCents } });
    return { id };
  }),

  /** Editing an item does NOT touch charges already applied — those hold their own snapshot. */
  chargeItemUpdate: adminOrFinanceProcedure
    .input(z.object({ id: ID, name: NAME.optional(), defaultAmountCents: SIGNED_CENTS.optional(), sortOrder: z.number().int().min(0).max(9999).optional() }))
    .mutation(({ ctx, input }) => {
      if (!db.select({ id: chargeItems.id }).from(chargeItems).where(eq(chargeItems.id, input.id)).get()) throw new TRPCError({ code: 'NOT_FOUND', message: 'Item not found.' });
      const patch: Partial<typeof chargeItems.$inferInsert> = { updatedAt: now() };
      if (input.name !== undefined) patch.name = input.name;
      if (input.defaultAmountCents !== undefined) patch.defaultAmountCents = input.defaultAmountCents;
      if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
      db.update(chargeItems).set(patch).where(eq(chargeItems.id, input.id)).run();
      audit(auditActor(ctx), 'chargeItem.update', { entity: 'chargeItem', entityId: input.id });
      return { ok: true as const };
    }),

  chargeItemArchive: adminOrFinanceProcedure.input(z.object({ id: ID })).mutation(({ ctx, input }) => {
    if (!db.select({ id: chargeItems.id }).from(chargeItems).where(eq(chargeItems.id, input.id)).get()) throw new TRPCError({ code: 'NOT_FOUND', message: 'Item not found.' });
    db.update(chargeItems).set({ status: 'archived', updatedAt: now() }).where(eq(chargeItems.id, input.id)).run();
    audit(auditActor(ctx), 'chargeItem.archive', { entity: 'chargeItem', entityId: input.id });
    return { ok: true as const };
  }),

  /** Delete a charge item outright. Refuses while any charge still points at it — a charge holds its
   *  own label/amount snapshot, but the `charge_item_id` link is how the office traces "which item
   *  was this?", and RESTRICT would block the delete anyway. Archive covers the rest. */
  chargeItemDelete: adminOrFinanceProcedure.input(z.object({ id: ID })).mutation(({ ctx, input }) => {
    if (!db.select({ id: chargeItems.id }).from(chargeItems).where(eq(chargeItems.id, input.id)).get()) throw new TRPCError({ code: 'NOT_FOUND', message: 'Item not found.' });
    const used = db.select({ id: charges.id }).from(charges).where(eq(charges.chargeItemId, input.id)).all().length;
    if (used) {
      throw new TRPCError({ code: 'CONFLICT', message: `This item has been charged to ${used} student${used === 1 ? '' : 's'}, so it’s part of your billing history and can’t be deleted. Archive it instead.` });
    }
    db.delete(chargeItems).where(eq(chargeItems.id, input.id)).run();
    audit(auditActor(ctx), 'chargeItem.delete', { entity: 'chargeItem', entityId: input.id });
    return { ok: true as const };
  }),

  // ── Charges (per student, or mass-applied from an item) ──────────────────────
  /** Add one charge to a student. If the target period's invoice already exists and is open the
   *  line lands on it immediately (and the invoice status is re-derived); otherwise the charge
   *  waits as `pending` and the next generation for that period picks it up. */
  chargeAdd: adminOrFinanceProcedure
    .input(z.object({ studentId: ID, source: CHARGE_SOURCE, note: NOTE.optional(), periodKey: PERIOD.optional() }))
    .mutation(({ ctx, input }) => {
      if (!db.select({ id: students.id }).from(students).where(and(eq(students.id, input.studentId), eq(students.status, 'active'))).get()) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Student not found.' });
      }
      const snap = snapshotCharge(input.source);
      const id = rid('chg');
      const ts = now();
      db.insert(charges)
        .values({ id, studentId: input.studentId, chargeItemId: snap.chargeItemId, label: snap.label, amountCents: snap.amountCents, note: input.note || null, periodKey: input.periodKey ?? null, status: 'pending', createdByUserId: ctx.session?.userId ?? null, createdAt: ts, updatedAt: ts })
        .run();
      const attach = attachChargeToExistingInvoice(id);
      audit(auditActor(ctx), 'charge.add', { entity: 'student', entityId: input.studentId, detail: { chargeId: id, amountCents: snap.amountCents, periodKey: input.periodKey ?? null, attached: attach.attached } });
      return { id, attached: attach.attached, invoiceId: attach.invoiceId };
    }),

  /** Mass-apply one charge to many students — "go on the item and select who to charge". */
  chargeAddBulk: adminOrFinanceProcedure
    .input(z.object({ source: CHARGE_SOURCE, target: BULK_TARGET, note: NOTE.optional(), periodKey: PERIOD.optional() }))
    .mutation(({ ctx, input }) => {
      const snap = snapshotCharge(input.source);
      const ids = resolveTarget(input.target);
      const ts = now();
      const created: string[] = [];
      db.transaction((tx) => {
        for (const studentId of ids) {
          const id = rid('chg');
          tx.insert(charges)
            .values({ id, studentId, chargeItemId: snap.chargeItemId, label: snap.label, amountCents: snap.amountCents, note: input.note || null, periodKey: input.periodKey ?? null, status: 'pending', createdByUserId: ctx.session?.userId ?? null, createdAt: ts, updatedAt: ts })
            .run();
          created.push(id);
        }
      });
      // Attach after the insert transaction so one family's open invoice can't roll back the batch.
      let attached = 0;
      for (const id of created) if (attachChargeToExistingInvoice(id).attached) attached++;
      audit(auditActor(ctx), 'charge.addBulk', { entity: 'billing', detail: { amountCents: snap.amountCents, targeted: ids.length, created: created.length, attached, periodKey: input.periodKey ?? null } });
      return { created: created.length, attached, targeted: ids.length };
    }),

  chargeList: adminOrFinanceProcedure
    .input(z.object({ studentId: ID.optional(), familyId: ID.optional(), status: z.enum(['pending', 'invoiced', 'void']).optional(), periodKey: PERIOD.optional() }).optional())
    .query(({ input }) => {
      const filters = [
        input?.studentId ? eq(charges.studentId, input.studentId) : undefined,
        input?.familyId ? eq(students.familyId, input.familyId) : undefined,
        input?.status ? eq(charges.status, input.status) : undefined,
        input?.periodKey ? eq(charges.periodKey, input.periodKey) : undefined,
      ].filter(Boolean);
      return db
        .select({
          id: charges.id,
          studentId: charges.studentId,
          fullName: students.fullName,
          label: charges.label,
          amountCents: charges.amountCents,
          note: charges.note,
          periodKey: charges.periodKey,
          status: charges.status,
          invoiceItemId: charges.invoiceItemId,
          createdAt: charges.createdAt,
        })
        .from(charges)
        .innerJoin(students, eq(students.id, charges.studentId))
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(charges.createdAt))
        .all();
    }),

  /** Void a charge that has not been invoiced yet. Once it is on an invoice the line is
   *  immutable (§9) — the correction is a second, NEGATIVE charge, not an edit. */
  chargeVoid: adminOrFinanceProcedure.input(z.object({ id: ID })).mutation(({ ctx, input }) => {
    const c = db.select({ id: charges.id, status: charges.status, studentId: charges.studentId }).from(charges).where(eq(charges.id, input.id)).get();
    if (!c) throw new TRPCError({ code: 'NOT_FOUND', message: 'Charge not found.' });
    if (c.status === 'void') return { ok: true as const };
    if (c.status === 'invoiced') {
      throw new TRPCError({ code: 'CONFLICT', message: 'This charge is already on an invoice. Add a negative charge to credit it back.' });
    }
    db.update(charges).set({ status: 'void', updatedAt: now() }).where(eq(charges.id, input.id)).run();
    audit(auditActor(ctx), 'charge.void', { entity: 'student', entityId: c.studentId, detail: { chargeId: input.id } });
    return { ok: true as const };
  }),

  // ── Student ledger + payments ────────────────────────────────────────────────
  /** ONE STUDENT's record: their balance, their invoices, their payments. This is the window finance
   *  works in — recording an in-person payment happens here, against the child it was paid for. */
  studentBilling: adminOrFinanceProcedure.input(z.object({ studentId: ID })).query(({ input }) => {
    const s = db.select({ id: students.id, fullName: students.fullName, studentCode: students.studentCode, familyId: students.familyId }).from(students).where(eq(students.id, input.studentId)).get();
    if (!s) throw new TRPCError({ code: 'NOT_FOUND', message: 'Student not found.' });
    return {
      student: s,
      balance: studentBalance(s.id),
      invoices: invoiceRowsFor([s.id]),
      payments: paymentRowsFor([s.id]),
    };
  }),

  /**
   * What there is to pay for one child, line by line — the tuition and the book fee as separate rows.
   *
   * The office's quick payment box reads this so "what is Yusuf here to pay?" is answerable without
   * opening anything, and so a parent handing over money for the trip can have it recorded AS the trip.
   * Same shape the parent portal and the kiosk get (billing/lines.ts), so all three describe a bill the
   * same way.
   */
  studentPayables: adminOrFinanceProcedure.input(z.object({ studentId: ID })).query(({ input }) => {
    const s = db.select({ id: students.id, fullName: students.fullName, familyId: students.familyId }).from(students).where(eq(students.id, input.studentId)).get();
    if (!s) throw new TRPCError({ code: 'NOT_FOUND', message: 'Student not found.' });
    return { student: s, balance: studentBalance(s.id), lines: payableLines(db, [s.id]) };
  }),

  /** The lines of one invoice — what a bill is actually made of, for the office and the statement. */
  invoiceLines: adminOrFinanceProcedure.input(z.object({ invoiceId: ID })).query(({ input }) => invoiceLines(db, input.invoiceId)),

  /** The whole household, for when a parent asks "what do we owe altogether?". The combined balance
   *  plus each child's own, and every invoice/payment tagged with the child it belongs to. */
  familyBilling: adminOrFinanceProcedure.input(z.object({ familyId: ID })).query(({ input }) => {
    const kids = db
      .select({ id: students.id, fullName: students.fullName, studentCode: students.studentCode, status: students.status })
      .from(students)
      .where(eq(students.familyId, input.familyId))
      .orderBy(asc(students.fullName))
      .all();
    const kidIds = kids.map((k) => k.id);
    return {
      balance: familyBalance(input.familyId),
      students: kids.map((k) => ({ ...k, balance: studentBalance(k.id) })),
      invoices: invoiceRowsFor(kidIds),
      payments: paymentRowsFor(kidIds),
      /**
       * Whether tuition collects itself, and off what (0.48.0).
       *
       * The office could not see this anywhere. Autopay is a PER-HOUSEHOLD enrollment against a
       * per-household Stripe Customer (§13.3), so it is reported here once and the screen says "this
       * household" rather than implying it is a property of one child — but it belongs on a child's record
       * because that is where a volunteer stands when a parent rings to ask why nothing was taken, or when
       * they are about to chase a family whose card is going to pay them on Friday anyway.
       *
       * The method is named through the same fields the parent's own screen uses, so both say "Visa ····
       * 4242" or "Chase ···· 6789" rather than one of them guessing.
       */
      autopay: (() => {
        const enr = db.select().from(autopayEnrollments).where(eq(autopayEnrollments.familyId, input.familyId)).get();
        if (!enr?.enabled) return { enabled: false as const, method: null, since: null };
        const pm = enr.defaultPmId
          ? db
              .select({ type: paymentMethods.type, brand: paymentMethods.brand, last4: paymentMethods.last4, expMonth: paymentMethods.expMonth, expYear: paymentMethods.expYear, wallet: paymentMethods.wallet, bankName: paymentMethods.bankName, accountType: paymentMethods.accountType })
              .from(paymentMethods)
              .where(eq(paymentMethods.id, enr.defaultPmId))
              .get()
          : undefined;
        return { enabled: true as const, method: pm ?? null, since: enr.consentAt ?? null };
      })(),
    };
  }),

  // (`familiesOverview` lived here until 0.43.0. Its only reader was the grid of household cards at the
  // bottom of the Billing tab, which the year view replaced — a wall of names with one number each was
  // never how anyone found a family. A query nobody calls is the kind of thing that rots quietly, so it
  // went out with the screen.)

  /** Mark money as received that did not come through a card: cash, a check, a bank/ACH transfer,
   *  Zelle, or anything else (with the memo saying what). The channel list is shared with the schema
   *  so the dropdown and this enum cannot drift.
   *
   *  Recorded against ONE STUDENT — "Yusuf handed me cash for April". It lands in his balance and his
   *  own invoices absorb it oldest-first; anything left over stays as his credit and the next bill for
   *  him takes it. Paying for several children is several records, which is the honest shape: the
   *  office counted separate amounts for separate kids. */
  recordManualPayment: adminOrFinanceProcedure
    .input(
      z.object({
        studentId: ID,
        amountCents: CENTS.min(1),
        channel: z.enum(MANUAL_PAYMENT_CHANNELS),
        occurredAt: z.string().max(20),
        memo: z.string().trim().max(200).optional(),
        /** Lines the money was handed over for, when the parent said which (§ billing/lines.ts). */
        directed: z.array(z.object({ itemId: ID, amountCents: CENTS.min(1) })).max(100).optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const stu = db.select({ id: students.id, familyId: students.familyId }).from(students).where(eq(students.id, input.studentId)).get();
      if (!stu) throw new TRPCError({ code: 'NOT_FOUND', message: 'Student not found.' });
      let res;
      try {
        res = recordPayment(
          { studentId: input.studentId, amountCents: input.amountCents, channel: input.channel, occurredAt: new Date(`${isoDay(input.occurredAt, 'The payment date')}T12:00:00`), idempotencyKey: rid('man'), memo: input.memo || null, directed: input.directed ?? null },
          // `recordingActor`, not `auditActor`: this name is stamped on the payment row the office
          // reads back ("who took this cash?"), so it is the person's name rather than their username.
          recordingActor(ctx),
        );
      } catch (e) {
        // The only thing the ledger refuses here is an instruction that does not fit the bills it
        // names — a stale screen, in practice. Say so plainly instead of leaking the ledger's wording.
        if ((e as Error).message === 'invalid_allocation') throw new TRPCError({ code: 'CONFLICT', message: 'Those lines have changed since this screen loaded. Reload and record it again.' });
        throw e;
      }
      audit(auditActor(ctx), 'payment.record', { entity: 'student', entityId: input.studentId, detail: { channel: input.channel, amountCents: input.amountCents, directedLines: input.directed?.length ?? 0 } });
      if (!res.duplicate) {
        // A receipt for cash, a check, Zelle — the parent who handed money over at the door gets the
        // same written record as one who paid by card. This was simply missing before 0.44.0: five ways
        // to pay, and only two of them told the family anything. Both sends are best-effort and gated
        // (parent-email switch / the alert list), so nothing here can fail the payment.
        void sendReceipt(stu.familyId, formatMoney(input.amountCents, getCurrency()));
        void alertStaff('payment-received', {
          title: 'Tuition payment received',
          // The child, not the household: this payment is recorded against ONE student (§9), and that
          // is the record an office opens next.
          text: `${formatMoney(input.amountCents, getCurrency())} paid for ${studentName(input.studentId)} (${input.channel}), recorded by ${recordingActor(ctx).name ?? 'the office'}.`,
          publicText: `A tuition payment of ${formatMoney(input.amountCents, getCurrency())} was received (${input.channel}).`,
        });
      }
      return res;
    }),

  /**
   * Reverse a payment on the LEDGER ONLY — which is right for cash and wrong for a card.
   *
   * A ledger reversal writes mirror rows: the bill re-opens and the family owes it again. For cash
   * that is the whole story, because a person hands the notes back. For a card it is only half of
   * one, and the missing half is the money: Stripe still holds it. An office pressing this on a
   * portal or autopay payment would believe they had given it back, while the family sat charged AND
   * billed again — and `refundTransaction` would then find the row already reversed and refuse the
   * real refund, so the mistake could not be undone from any screen.
   *
   * So anything carrying a Stripe PaymentIntent is refused here and sent to Refunds, which does both
   * halves in the right order (Stripe first, then the mirror rows). The rule lives in
   * `payments/refunds.ts` — the same predicate that decides a transaction's route — rather than being
   * a second list of "card-ish channels" that could disagree with it.
   */
  reversePayment: adminOrFinanceProcedure.input(z.object({ paymentId: ID })).mutation(({ ctx, input }) => {
    const p = db.select({ id: payments.id, studentId: payments.studentId }).from(payments).where(eq(payments.id, input.paymentId)).get();
    if (!p) throw new TRPCError({ code: 'NOT_FOUND', message: 'Payment not found.' });
    if (isStripePayment(input.paymentId)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'This one was paid by card, so it has to go back through Stripe. Use Refunds — reversing it here would leave the family charged.',
      });
    }
    const r = reversePayment(input.paymentId, recordingActor(ctx));
    audit(auditActor(ctx), 'payment.reverse', { entity: 'student', entityId: p.studentId, detail: { paymentId: input.paymentId } });
    return r;
  }),

  // ── Refunds (0.48.0) ────────────────────────────────────────────────────────
  /** Recent transactions and how each one could be given back (payments/refunds.ts).
   *
   *  `cardRefundsReady` is separate from each row's `route` deliberately: the route says how the money
   *  arrived (and never changes), this says whether Stripe can be reached to send a card one back right
   *  now. Rolling the two together made a card payment read as "hand the cash over" whenever the keys
   *  were briefly unavailable — advice that would have the family paid twice. */
  refundable: adminOrFinanceProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).optional(), query: z.string().trim().max(120).optional() }).optional())
    .query(({ input }) => ({ transactions: refundableTransactions(input ?? {}), currency: getCurrency(), cardRefundsReady: stripeReady() })),

  /**
   * Give a whole transaction back: the money at Stripe where it came through Stripe, and the ledger either
   * way (§9 — payments are immutable, so this writes mirror rows rather than deleting anything).
   *
   * Admin OR finance, like every other money action: refunding is part of running billing, and it is
   * audited and alerted rather than gated to admin. Finance already records and reverses payments.
   */
  refund: adminOrFinanceProcedure.input(z.object({ key: z.string().trim().min(1).max(255) })).mutation(async ({ ctx, input }) => {
    let r: Awaited<ReturnType<typeof refundTransaction>>;
    try {
      r = await refundTransaction(input.key, recordingActor(ctx));
    } catch (e) {
      const msg = (e as Error).message;
      // One friendly sentence each, and the raw Stripe/DB text stays in the log (§15/§18).
      if (msg === 'card_refunds_unavailable') {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Card refunds aren’t available right now — the payments connection is down. Try again shortly.' });
      }
      if (msg === 'payment not found') throw new TRPCError({ code: 'NOT_FOUND', message: 'That payment no longer exists.' });
      if (msg === 'not_refundable_carry_in') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'That is a balance carried forward from before you started using this app, not a payment taken here — there is nothing to send back. To correct it, re-run the go-live step.',
        });
      }
      if (msg.startsWith('refund_')) {
        throw new TRPCError({ code: 'BAD_GATEWAY', message: 'The card company refused the refund. Check the payment in Stripe before trying again.' });
      }
      payLog.error('refund failed', { key: input.key, error: msg });
      throw new TRPCError({ code: 'BAD_GATEWAY', message: 'We couldn’t complete that refund. Nothing was changed — please try again.' });
    }
    audit(auditActor(ctx), 'payment.refund', {
      entity: 'payment',
      entityId: input.key,
      // Amounts and ids, no names — the audit trail records the act, not the household (§14).
      detail: { route: r.route, amountCents: r.amountCents, reversed: r.reversed, stripeRefundId: r.stripeRefundId, stripeStatus: r.stripeStatus },
    });
    if (r.reversed > 0) {
      // Someone should know money left, and the office email may not be the person who pressed it.
      // BOTH texts carry the amount. `publicText` goes to third-party sinks (the masjid webhook, the
      // platform's alert channel) so it names no household — but a figure on its own identifies nobody, and
      // an alert that says only "a refund was recorded" cannot be acted on or even sanity-checked. Same
      // shape as `payment-received` above, which has always included its amount for the same reason.
      const amount = formatMoney(r.amountCents, getCurrency());
      const how = r.route === 'stripe' ? ' back to the card or bank account it came from' : ' on the ledger — the money still has to be handed back';
      // WHO it was for and WHAT it paid go in the office's own email only. `text` names the CHILDREN the
      // money was for — without that the alert is unactionable, which is exactly why that channel exists —
      // while `publicText` reaches third-party sinks and carries the figure and nothing that identifies
      // anybody (§9/§14). This path already named students; the rest of the alerts caught up in dev.14.
      const who = r.students.length ? ` for ${r.students.join(', ')}` : '';
      const what = r.labels.length ? ` It covered ${r.labels.join(', ')}.` : '';
      void alertStaff('payment-refunded', {
        title: `A payment of ${amount} was refunded`,
        text: `A refund of ${amount}${who} was made${how}, by ${recordingActor(ctx).name ?? 'the office'}.${what}`,
        publicText: `A tuition refund of ${amount} was recorded (${r.route === 'stripe' ? 'card or bank' : 'by hand'}).`,
      });
      // …and the family, who should not have to take the office's word for it (0.50.0). Off by
      // default like every other message added since, and gated inside the sender, not here.
      for (const familyId of r.familyIds) void sendRefund(familyId, amount);
    }
    return r;
  }),

  // ── Starting mid-year (0.43.0) ───────────────────────────────────────────────
  /** Where this install stands: the first month it bills, and whether the go-live step has been run. */
  midYearStatus: adminOrFinanceProcedure.query(() => ({
    startPeriod: getBillingStartPeriod(),
    committedAt: getMidYearDoneAt(),
    suggestedGoLive: defaultGoLivePeriod(),
  })),

  /**
   * What the go-live step WOULD do — every child, their rate, the figure derived from "paid through",
   * and the balance each parent would end up seeing. Writes nothing.
   *
   * The same input and the same derivation as `midYearCommit`, deliberately: the office must not be
   * able to commit a set of balances it has not already read on screen, and the way to guarantee the
   * preview is truthful is for both to be one function (see test/midYear.test.ts).
   */
  midYearPreview: adminOrFinanceProcedure.input(MID_YEAR_INPUT).query(({ input }) => {
    const plan = midYearPlan(input.goLivePeriod, input.schoolYearId ?? null, input.rows ?? []);
    return { ...plan, families: familyTotals(plan.students) };
  }),

  /**
   * Commit it: one carried-forward bill per child who owes, one dated prepayment per child who is
   * ahead, nothing at all for a child who is square — and the billing floor set, so the months this
   * figure already covers can never be generated on top of it.
   *
   * Admin-only. It is a one-time statement about the school's history, not a day-to-day finance action,
   * and it is the one action here that decides what every parent's balance starts at.
   */
  midYearCommit: adminProcedure.input(MID_YEAR_INPUT).mutation(({ ctx, input }) => {
    const err = periodKeyError(input.goLivePeriod);
    if (err) throw new TRPCError({ code: 'BAD_REQUEST', message: err });
    // Checked ONCE, before a single artifact is written: this date lands on every carry-in row the run
    // creates, so half a school's histories dated NaN is not a state to discover afterwards.
    const asOf = isoDayOrNull(input.asOf, 'The date these balances were true');
    const plan = midYearPlan(input.goLivePeriod, input.schoolYearId ?? null, input.rows ?? []);
    // A carry-in writes real ledger rows, so it is named the same way a cash payment is.
    const actor = recordingActor(ctx);

    let owed = 0;
    let ahead = 0;
    let skipped = 0;
    for (const s of plan.students) {
      // Keep the ANSWER first, and for every child the office actually answered for — including the
      // square ones, who get no artifact at all (0.48.0). "Paid through November" is the only thing
      // anybody knows about the months before go-live, and deriving an amount from it used to consume
      // it; the year view needs it back to say which of those months a family had settled. It is a note
      // beside the money, never a source of it (billing/carryIn.ts).
      if (s.paidThrough) noteCarryIn({ studentId: s.studentId, goLivePeriod: input.goLivePeriod, paidThrough: s.paidThrough, kind: s.kind, amountCents: s.amountCents });
      if (s.already || s.kind === 'square' || s.amountCents <= 0) {
        if (s.already && s.kind !== 'square') skipped++;
        continue;
      }
      const r = commitCarryIn({ studentId: s.studentId, kind: s.kind, amountCents: s.amountCents, goLivePeriod: input.goLivePeriod, asOf: asOf, memo: input.memo ?? null }, actor);
      if (!r.wrote) continue;
      if (r.kind === 'owes') owed++;
      else ahead++;
    }

    // The floor goes in whether or not anything was written: "we start billing in February" is true of
    // a school whose families were all square too, and it is what stops January being generated later.
    //
    // It only ever moves BACK. The wizard defaults its month to today, so a second run — a new child
    // whose history needs recording in May — would otherwise push the floor to May and start refusing
    // February, March and April, months this install has already billed. The earliest go-live is the
    // honest one: it is the point before which balances were carried in.
    const floor = getBillingStartPeriod();
    if (!floor || periodBefore(input.goLivePeriod, floor)) setBillingStartPeriod(input.goLivePeriod);
    setMidYearDoneAt(new Date().toISOString());
    audit(auditActor(ctx), 'billing.midYear.commit', { entity: 'billing', detail: { goLivePeriod: input.goLivePeriod, owed, ahead, skipped } });
    return { owed, ahead, skipped, startPeriod: getBillingStartPeriod() ?? input.goLivePeriod };
  }),

  /** Clear the billing floor — for an install that set a go-live month it now needs to bill before.
   *  Admin-only and audited: it re-opens the door the floor was closing. */
  midYearClearFloor: adminProcedure.mutation(({ ctx }) => {
    setBillingStartPeriod(null);
    audit(auditActor(ctx), 'billing.midYear.clearFloor', { entity: 'billing' });
    return { ok: true as const };
  }),

  // Stripe reconciliation (§11.4): the safety net for missed broker calls / webhooks. The last-run
  // summary drives the finance UI; "Reconcile now" runs a pass on demand (the scheduler runs daily).
  reconcileStatus: adminOrFinanceProcedure.query(() => reconcileStatus()),
  reconcileNow: adminOrFinanceProcedure.mutation(async ({ ctx }) => {
    const r = await reconcile(auditActor(ctx));
    audit(auditActor(ctx), 'payment.reconcile.run', { detail: { ok: r.ok, scanned: r.scanned, recorded: r.recorded } });
    return r;
  }),
});
