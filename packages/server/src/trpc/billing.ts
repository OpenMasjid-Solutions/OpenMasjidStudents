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
import { and, eq, asc, desc, inArray } from 'drizzle-orm';
import { router, adminProcedure, adminOrFinanceProcedure, auditActor } from './trpc';
import { db } from '../db';
import { feePlans, studentFees, students, families, invoices, invoiceItems, payments, chargeItems, charges, classes, courses, schoolYears, guardians, guardianFamilies, emergencyContacts, MANUAL_PAYMENT_CHANNELS } from '../db/schema';
import { rid } from '../db/ids';
import { audit } from '../audit';
import { recordPayment, reversePayment, familyBalance, studentBalance, invoiceTotal, invoicePaid } from '../billing/ledger';
import { generateForFamily, generateForPeriod, attachChargeToExistingInvoice } from '../billing/invoices';
import { schoolYearMonths } from '../billing/schoolYear';
import { toCsv, csvMoney, csvDate } from '../billing/csv';
import { reconcile, reconcileStatus } from '../payments/reconcile';
import { getCurrency, getYearViewColumns, setYearViewColumns, YEAR_VIEW_COLUMNS, getAutoInvoice, setAutoInvoice, getAutoInvoiceLast } from '../settings';
import { runAutoInvoice } from '../billing/autoInvoice';
import { relationKind, dedupeNumbers, type RelationKind } from '../people/relations';

const ID = z.string().min(1).max(64);
const NAME = z.string().trim().min(1).max(120);
const CENTS = z.number().int().min(0).max(100_000_000);
/** Charges may be NEGATIVE — a negative charge is how a credit / scholarship / correction is
 *  expressed, since an invoice line is immutable once written (§9). */
const SIGNED_CENTS = z.number().int().min(-100_000_000).max(100_000_000);
const PERIOD = z.string().trim().min(1).max(40);
const NOTE = z.string().trim().max(200);
const now = () => new Date();

/** Who a bulk apply targets: explicit students, or everyone active in a class or course.
 *  One resolver so the fee-plan and charge-item tabs behave identically. */
const BULK_TARGET = z.union([
  z.object({ kind: z.literal('students'), studentIds: z.array(ID).min(1).max(2000) }),
  z.object({ kind: z.literal('class'), classId: ID }),
  z.object({ kind: z.literal('course'), courseId: ID }),
]);

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

function resolveTarget(target: z.infer<typeof BULK_TARGET>): string[] {
  if (target.kind === 'students') {
    // Keep only ids that are real AND active — a stale UI selection must not create rows
    // pointing at withdrawn students.
    const rows = db.select({ id: students.id }).from(students).where(eq(students.status, 'active')).all();
    const live = new Set(rows.map((r) => r.id));
    return target.studentIds.filter((id) => live.has(id));
  }
  if (target.kind === 'class') {
    return db.select({ id: students.id }).from(students).where(and(eq(students.classId, target.classId), eq(students.status, 'active'))).all().map((r) => r.id);
  }
  return db
    .select({ id: students.id })
    .from(students)
    .innerJoin(classes, eq(classes.id, students.classId))
    .where(and(eq(classes.courseId, target.courseId), eq(students.status, 'active')))
    .all()
    .map((r) => r.id);
}

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
      return { id: i.id, studentId: i.studentId, label: i.label, periodKey: i.periodKey, dueDate: i.dueDate, status: i.status, totalCents: total, paidCents: paid, balanceCents: total - paid };
    });
}

/** Payment rows for a set of students, newest first. */
function paymentRowsFor(studentIds: string[]) {
  if (!studentIds.length) return [];
  return db
    .select({ id: payments.id, studentId: payments.studentId, amountCents: payments.amountCents, channel: payments.channel, occurredAt: payments.occurredAt, memo: payments.memo, reversalOf: payments.reversalOf, by: payments.recordedByName })
    .from(payments)
    .where(inArray(payments.studentId, studentIds))
    .orderBy(desc(payments.occurredAt), desc(payments.createdAt))
    .all();
}

/** Distinct, non-empty email addresses from a set of guardians — compared case-insensitively, since
 *  the same address typed twice with different capitalisation is one inbox. */
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
  generatePeriod: adminOrFinanceProcedure
    .input(z.object({ periodKey: PERIOD, label: NAME, dueDate: z.string().max(20).optional(), periodKind: z.enum(['month', 'term']).optional() }))
    .mutation(({ ctx, input }) => {
      const r = generateForPeriod({ periodKey: input.periodKey, label: input.label, dueDate: input.dueDate || null, periodKind: input.periodKind });
      audit(auditActor(ctx), 'invoice.generatePeriod', { entity: 'billing', detail: { periodKey: input.periodKey, periodKind: input.periodKind ?? 'month', created: r.created } });
      return r;
    }),

  generateFamily: adminOrFinanceProcedure
    .input(z.object({ familyId: ID, periodKey: PERIOD, label: NAME, dueDate: z.string().max(20).optional(), periodKind: z.enum(['month', 'term']).optional() }))
    .mutation(({ ctx, input }) => {
      const r = generateForFamily(input.familyId, { periodKey: input.periodKey, label: input.label, dueDate: input.dueDate || null, periodKind: input.periodKind });
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
    .input(z.object({ schoolYearId: ID.optional(), includeWithdrawn: z.boolean().optional() }).optional())
    .query(({ input }) => {
      const year = input?.schoolYearId
        ? db.select().from(schoolYears).where(eq(schoolYears.id, input.schoolYearId)).get()
        : db.select().from(schoolYears).where(eq(schoolYears.isCurrent, true)).get();
      if (!year) return { year: null, needsStartYear: false, months: [], columns: [], rows: [], currency: getCurrency() };
      if (year.startYear == null) {
        // Configured before start_year existed — the UI asks for it rather than guessing a calendar.
        return { year: { id: year.id, label: year.label }, needsStartYear: true, months: [], columns: [], rows: [], currency: getCurrency() };
      }

      const months = schoolYearMonths(year.startYear, year.startMonth, year.endMonth);
      const columns = getYearViewColumns();
      const periodKeys = months.map((m) => m.periodKey);

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
        .where(input?.includeWithdrawn ? undefined : eq(students.status, 'active'))
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

      // One pass over the year's invoices → per (STUDENT, period) status. Each row now reports the
      // child's own bill rather than the household's, so two siblings can legitimately differ in the
      // same month — which is the whole point of per-student invoices.
      const cellByStudent = new Map<string, Map<string, { status: string; totalCents: number; paidCents: number; invoiceId: string }>>();
      if (periodKeys.length) {
        for (const inv of db.select({ id: invoices.id, studentId: invoices.studentId, periodKey: invoices.periodKey, status: invoices.status }).from(invoices).where(inArray(invoices.periodKey, periodKeys)).all()) {
          const total = invoiceTotal(db, inv.id);
          const paid = invoicePaid(db, inv.id);
          if (!cellByStudent.has(inv.studentId)) cellByStudent.set(inv.studentId, new Map());
          cellByStudent.get(inv.studentId)!.set(inv.periodKey, { status: inv.status, totalCents: total, paidCents: paid, invoiceId: inv.id });
        }
      }

      // Guardian contact, only when a guardian column is actually enabled — and classified by WHO each
      // adult is, so each number gets its own labelled, tappable column (§ settings/YEAR_VIEW_COLUMNS).
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
        const cells = cellByStudent.get(s.id);
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
          feeNote: m?.note ?? null,
          cells: months.map((mo) => {
            const c = cells?.get(mo.periodKey);
            if (!c) return { periodKey: mo.periodKey, status: 'none' as const };
            const state = c.status === 'void' ? 'void' : c.paidCents >= c.totalCents && c.totalCents > 0 ? 'paid' : c.paidCents > 0 ? 'partial' : 'open';
            return { periodKey: mo.periodKey, status: state, totalCents: c.totalCents, paidCents: c.paidCents, invoiceId: c.invoiceId };
          }),
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

      return { year: { id: year.id, label: year.label }, needsStartYear: false, months, columns, rows, currency: getCurrency() };
    }),

  /** The optional year-view columns and which are on. Admin-only to change — the guardian-contact
   *  columns put phone numbers and email addresses on a whole-school page (§5: finance reads). */
  yearViewColumnsGet: adminOrFinanceProcedure.query(() => ({ available: [...YEAR_VIEW_COLUMNS], enabled: getYearViewColumns() })),

  yearViewColumnsSet: adminProcedure.input(z.object({ columns: z.array(z.enum(YEAR_VIEW_COLUMNS)).max(YEAR_VIEW_COLUMNS.length) })).mutation(({ ctx, input }) => {
    setYearViewColumns(input.columns);
    audit(auditActor(ctx), 'settings.yearViewColumns', { entity: 'settings', detail: { columns: input.columns } });
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
    };
  }),

  /** Overview: every active family with its balance (the Billing landing list). */
  familiesOverview: adminOrFinanceProcedure.query(() => {
    const fams = db.select({ id: families.id, name: families.name }).from(families).where(eq(families.status, 'active')).orderBy(asc(families.name)).all();
    return fams.map((f) => ({ ...f, balance: familyBalance(f.id) }));
  }),

  /** Mark money as received that did not come through a card: cash, a check, a bank/ACH transfer,
   *  Zelle, or anything else (with the memo saying what). The channel list is shared with the schema
   *  so the dropdown and this enum cannot drift.
   *
   *  Recorded against ONE STUDENT — "Yusuf handed me cash for April". It lands in his balance and his
   *  own invoices absorb it oldest-first; anything left over stays as his credit and the next bill for
   *  him takes it. Paying for several children is several records, which is the honest shape: the
   *  office counted separate amounts for separate kids. */
  recordManualPayment: adminOrFinanceProcedure.input(z.object({ studentId: ID, amountCents: CENTS.min(1), channel: z.enum(MANUAL_PAYMENT_CHANNELS), occurredAt: z.string().max(20), memo: z.string().trim().max(200).optional() })).mutation(({ ctx, input }) => {
    if (!db.select({ id: students.id }).from(students).where(eq(students.id, input.studentId)).get()) throw new TRPCError({ code: 'NOT_FOUND', message: 'Student not found.' });
    const res = recordPayment({ studentId: input.studentId, amountCents: input.amountCents, channel: input.channel, occurredAt: new Date(`${input.occurredAt}T12:00:00`), idempotencyKey: rid('man'), memo: input.memo || null }, auditActor(ctx));
    audit(auditActor(ctx), 'payment.record', { entity: 'student', entityId: input.studentId, detail: { channel: input.channel, amountCents: input.amountCents } });
    return res;
  }),

  reversePayment: adminOrFinanceProcedure.input(z.object({ paymentId: ID })).mutation(({ ctx, input }) => {
    const p = db.select({ id: payments.id, studentId: payments.studentId }).from(payments).where(eq(payments.id, input.paymentId)).get();
    if (!p) throw new TRPCError({ code: 'NOT_FOUND', message: 'Payment not found.' });
    const r = reversePayment(input.paymentId, auditActor(ctx));
    audit(auditActor(ctx), 'payment.reverse', { entity: 'student', entityId: p.studentId, detail: { paymentId: input.paymentId } });
    return r;
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
