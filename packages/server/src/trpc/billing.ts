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
import { feePlans, studentFees, students, families, invoices, payments, chargeItems, charges, classes, courses, schoolYears, guardians, guardianFamilies, MANUAL_PAYMENT_CHANNELS } from '../db/schema';
import { rid } from '../db/ids';
import { audit } from '../audit';
import { recordPayment, reversePayment, familyBalance, invoiceTotal, invoicePaid } from '../billing/ledger';
import { generateForFamily, generateForPeriod, attachChargeToExistingInvoice } from '../billing/invoices';
import { schoolYearMonths } from '../billing/schoolYear';
import { reconcile, reconcileStatus } from '../payments/reconcile';
import { getCurrency, getYearViewColumns, setYearViewColumns, YEAR_VIEW_COLUMNS } from '../settings';

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

export const billingRouter = router({
  /** The install currency, for money formatting in the finance UI. */
  currency: adminOrFinanceProcedure.query(() => ({ currency: getCurrency() })),

  // ── Fee plans ────────────────────────────────────────────────────────────────
  feePlanList: adminOrFinanceProcedure.query(() => db.select().from(feePlans).where(eq(feePlans.status, 'active')).orderBy(asc(feePlans.name)).all()),

  feePlanCreate: adminOrFinanceProcedure.input(z.object({ name: NAME, amountCents: CENTS.min(1), cadence: z.enum(['monthly', 'per_term', 'one_time']) })).mutation(({ ctx, input }) => {
    const id = rid('fee');
    const ts = now();
    db.insert(feePlans).values({ id, name: input.name, amountCents: input.amountCents, cadence: input.cadence, status: 'active', createdAt: ts, updatedAt: ts }).run();
    audit(auditActor(ctx), 'feePlan.create', { entity: 'feePlan', entityId: id, detail: { amountCents: input.amountCents, cadence: input.cadence } });
    return { id };
  }),

  feePlanArchive: adminOrFinanceProcedure.input(z.object({ id: ID })).mutation(({ ctx, input }) => {
    if (!db.select({ id: feePlans.id }).from(feePlans).where(eq(feePlans.id, input.id)).get()) throw new TRPCError({ code: 'NOT_FOUND', message: 'Fee plan not found.' });
    // Archiving a plan removes it everywhere: flip the status AND drop its student assignments, so the
    // family billing page and invoice generation agree (invoices already skip non-active plans) and no
    // orphaned student_fees linger. Existing invoices/payments are untouched (immutable).
    const removed = db.delete(studentFees).where(eq(studentFees.feePlanId, input.id)).run().changes;
    db.update(feePlans).set({ status: 'archived', updatedAt: now() }).where(eq(feePlans.id, input.id)).run();
    audit(auditActor(ctx), 'feePlan.archive', { entity: 'feePlan', entityId: input.id, detail: { unassigned: removed } });
    return { ok: true as const };
  }),

  // ── Per-student fee assignment + per-family discount ─────────────────────────
  /** A family's active students, each with the fee plan(s) assigned (one row per assignment;
   *  a student with no fee still appears once, with null fee fields). */
  familyFees: adminOrFinanceProcedure.input(z.object({ familyId: ID })).query(({ input }) => {
    const rows = db
      .select({
        studentId: students.id,
        firstName: students.firstName,
        lastName: students.lastName,
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
      .orderBy(asc(students.firstName))
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

  setDiscount: adminOrFinanceProcedure.input(z.object({ familyId: ID, kind: z.enum(['none', 'fixed', 'percent']), value: CENTS })).mutation(({ ctx, input }) => {
    if (!db.select({ id: families.id }).from(families).where(eq(families.id, input.familyId)).get()) throw new TRPCError({ code: 'NOT_FOUND', message: 'Family not found.' });
    const value = input.kind === 'none' ? 0 : input.kind === 'percent' ? Math.min(input.value, 10000) : input.value;
    db.update(families).set({ discountKind: input.kind, discountValue: value, updatedAt: now() }).where(eq(families.id, input.familyId)).run();
    audit(auditActor(ctx), 'family.setDiscount', { entity: 'family', entityId: input.familyId, detail: { kind: input.kind, value } });
    return { ok: true as const };
  }),

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
          firstName: students.firstName,
          lastName: students.lastName,
          status: students.status,
          dob: students.dob,
          pin: students.pin,
          studentCode: students.studentCode,
          familyId: students.familyId,
          familyName: families.name,
          classId: students.classId,
          className: classes.name,
          courseName: courses.name,
        })
        .from(students)
        .innerJoin(families, eq(families.id, students.familyId))
        .leftJoin(classes, eq(classes.id, students.classId))
        .leftJoin(courses, eq(courses.id, classes.courseId))
        .where(input?.includeWithdrawn ? undefined : eq(students.status, 'active'))
        .orderBy(asc(courses.sortOrder), asc(courses.name), asc(classes.sortOrder), asc(classes.name), asc(students.firstName))
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

      // One pass over the year's invoices → per (family, period) status.
      const cellByFamily = new Map<string, Map<string, { status: string; totalCents: number; paidCents: number; invoiceId: string }>>();
      if (periodKeys.length) {
        for (const inv of db.select({ id: invoices.id, familyId: invoices.familyId, periodKey: invoices.periodKey, status: invoices.status }).from(invoices).where(inArray(invoices.periodKey, periodKeys)).all()) {
          const total = invoiceTotal(db, inv.id);
          const paid = invoicePaid(db, inv.id);
          if (!cellByFamily.has(inv.familyId)) cellByFamily.set(inv.familyId, new Map());
          cellByFamily.get(inv.familyId)!.set(inv.periodKey, { status: inv.status, totalCents: total, paidCents: paid, invoiceId: inv.id });
        }
      }

      // Guardian contact, only when a guardian column is actually enabled.
      const wantsGuardians = columns.some((c) => c === 'guardianNames' || c === 'guardianPhones' || c === 'guardianEmails');
      const guardiansByFamily = new Map<string, { name: string; phone: string | null; email: string | null }[]>();
      if (wantsGuardians) {
        for (const g of db
          .select({ familyId: guardianFamilies.familyId, name: guardians.name, phone: guardians.phone, email: guardians.email })
          .from(guardianFamilies)
          .innerJoin(guardians, eq(guardians.id, guardianFamilies.guardianId))
          .all()) {
          if (!guardiansByFamily.has(g.familyId)) guardiansByFamily.set(g.familyId, []);
          guardiansByFamily.get(g.familyId)!.push({ name: g.name, phone: g.phone, email: g.email });
        }
      }

      const wantsBalance = columns.includes('balance');
      const balanceByFamily = new Map<string, number>();

      const rows = studentRows.map((s) => {
        const m = monthly.get(s.id);
        const fam = cellByFamily.get(s.familyId);
        if (wantsBalance && !balanceByFamily.has(s.familyId)) balanceByFamily.set(s.familyId, familyBalance(s.familyId).owedCents);
        const gs = guardiansByFamily.get(s.familyId) ?? [];
        return {
          studentId: s.id,
          firstName: s.firstName,
          lastName: s.lastName,
          status: s.status,
          familyId: s.familyId,
          familyName: s.familyName,
          classId: s.classId,
          className: s.className,
          courseName: s.courseName,
          monthlyAmountCents: m?.amountCents ?? 0,
          feeNote: m?.note ?? null,
          cells: months.map((mo) => {
            const c = fam?.get(mo.periodKey);
            if (!c) return { periodKey: mo.periodKey, status: 'none' as const };
            const state = c.status === 'void' ? 'void' : c.paidCents >= c.totalCents && c.totalCents > 0 ? 'paid' : c.paidCents > 0 ? 'partial' : 'open';
            return { periodKey: mo.periodKey, status: state, totalCents: c.totalCents, paidCents: c.paidCents, invoiceId: c.invoiceId };
          }),
          // Only enabled columns are populated — a disabled one is absent from the payload entirely.
          extra: {
            ...(columns.includes('studentId') ? { studentCode: s.studentCode } : {}),
            ...(columns.includes('dob') ? { dob: s.dob } : {}),
            ...(columns.includes('pin') ? { pin: s.pin } : {}),
            ...(columns.includes('guardianNames') ? { guardianNames: gs.map((g) => g.name) } : {}),
            ...(columns.includes('guardianPhones') ? { guardianPhones: gs.map((g) => g.phone).filter((p): p is string => !!p) } : {}),
            ...(columns.includes('guardianEmails') ? { guardianEmails: gs.map((g) => g.email).filter((e): e is string => !!e) } : {}),
            ...(wantsBalance ? { balanceCents: balanceByFamily.get(s.familyId) ?? 0 } : {}),
          },
        };
      });

      return { year: { id: year.id, label: year.label }, needsStartYear: false, months, columns, rows, currency: getCurrency() };
    }),

  /** The optional year-view columns and which are on. Admin-only to change (it can expose PINs). */
  yearViewColumnsGet: adminOrFinanceProcedure.query(() => ({ available: [...YEAR_VIEW_COLUMNS], enabled: getYearViewColumns() })),

  yearViewColumnsSet: adminProcedure.input(z.object({ columns: z.array(z.enum(YEAR_VIEW_COLUMNS)).max(YEAR_VIEW_COLUMNS.length) })).mutation(({ ctx, input }) => {
    setYearViewColumns(input.columns);
    audit(auditActor(ctx), 'settings.yearViewColumns', { entity: 'settings', detail: { columns: input.columns } });
    return { ok: true as const };
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
          firstName: students.firstName,
          lastName: students.lastName,
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

  // ── Family ledger + payments ─────────────────────────────────────────────────
  familyBilling: adminOrFinanceProcedure.input(z.object({ familyId: ID })).query(({ input }) => {
    const fam = db.select({ discountKind: families.discountKind, discountValue: families.discountValue }).from(families).where(eq(families.id, input.familyId)).get();
    const balance = familyBalance(input.familyId);
    const invs = db.select().from(invoices).where(eq(invoices.familyId, input.familyId)).orderBy(desc(invoices.createdAt)).all().map((i) => {
      const total = invoiceTotal(db, i.id);
      const paid = invoicePaid(db, i.id);
      return { id: i.id, label: i.label, periodKey: i.periodKey, dueDate: i.dueDate, status: i.status, totalCents: total, paidCents: paid, balanceCents: total - paid };
    });
    const pays = db.select().from(payments).where(eq(payments.familyId, input.familyId)).orderBy(desc(payments.occurredAt), desc(payments.createdAt)).all().map((p) => ({ id: p.id, amountCents: p.amountCents, channel: p.channel, occurredAt: p.occurredAt, memo: p.memo, reversalOf: p.reversalOf, by: p.recordedByName }));
    return { balance, invoices: invs, payments: pays, discount: { kind: fam?.discountKind ?? 'none', value: fam?.discountValue ?? 0 } };
  }),

  /** Overview: every active family with its balance (the Billing landing list). */
  familiesOverview: adminOrFinanceProcedure.query(() => {
    const fams = db.select({ id: families.id, name: families.name }).from(families).where(eq(families.status, 'active')).orderBy(asc(families.name)).all();
    return fams.map((f) => ({ ...f, balance: familyBalance(f.id) }));
  }),

  /** Mark money as received that did not come through a card: cash, a check, a bank/ACH transfer,
   *  Zelle, or anything else (with the memo saying what). The channel list is shared with the schema
   *  so the dropdown and this enum cannot drift. */
  recordManualPayment: adminOrFinanceProcedure.input(z.object({ familyId: ID, amountCents: CENTS.min(1), channel: z.enum(MANUAL_PAYMENT_CHANNELS), occurredAt: z.string().max(20), memo: z.string().trim().max(200).optional() })).mutation(({ ctx, input }) => {
    if (!db.select({ id: families.id }).from(families).where(eq(families.id, input.familyId)).get()) throw new TRPCError({ code: 'NOT_FOUND', message: 'Family not found.' });
    const res = recordPayment({ familyId: input.familyId, amountCents: input.amountCents, channel: input.channel, occurredAt: new Date(`${input.occurredAt}T12:00:00`), idempotencyKey: rid('man'), memo: input.memo || null }, auditActor(ctx));
    audit(auditActor(ctx), 'payment.record', { entity: 'family', entityId: input.familyId, detail: { channel: input.channel, amountCents: input.amountCents } });
    return res;
  }),

  reversePayment: adminOrFinanceProcedure.input(z.object({ paymentId: ID })).mutation(({ ctx, input }) => {
    const p = db.select({ id: payments.id, familyId: payments.familyId }).from(payments).where(eq(payments.id, input.paymentId)).get();
    if (!p) throw new TRPCError({ code: 'NOT_FOUND', message: 'Payment not found.' });
    const r = reversePayment(input.paymentId, auditActor(ctx));
    audit(auditActor(ctx), 'payment.reverse', { entity: 'family', entityId: p.familyId, detail: { paymentId: input.paymentId } });
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
