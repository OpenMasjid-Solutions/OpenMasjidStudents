// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Starting in the middle of a school year (0.43.0).
 *
 * A madrasa does not adopt an app in September. It decides in February, with five months of tuition
 * already collected in cash and recorded in a notebook, and the office is not going to re-key any of
 * it. So this app never asks them to: the months before go-live are simply NEVER GENERATED, and
 * whatever each child brings with them arrives as ONE artifact.
 *
 * Two artifacts, both real ledger rows rather than a stored balance:
 *
 *  • OWES → an invoice on the reserved period `carry-in`, labelled so a parent can read it ("Balance
 *    carried forward"), due on a date that is genuinely in the past. The past due date is load-bearing:
 *    it makes the arrears sort FIRST in `reallocateStudent`, so the next money in clears the old debt
 *    before this month — the house rule, unchanged — and it puts the amount in front of autopay's
 *    `due_date <= today` query instead of behind it.
 *  • PAID AHEAD → a payment on channel `carry_in`, dated when the office received it. Being the oldest
 *    live payment, it is the first thing the next generated invoice absorbs, which is exactly what a
 *    parent means by "we already paid through June".
 *
 * WHY NOT a "starts from" column on the fee. Because a column is editable state: correct it and there
 * is no record that it was ever wrong, and it cannot express money OWED at all. An invoice and a
 * payment are immutable facts with a date, an author and a memo, and the correction path already
 * exists — reverse the payment, void the invoice (§9). Nothing here stores a balance; both artifacts
 * feed the same `invoiced − paid` subtraction as everything else.
 *
 * The whole derivation is HERE and not in the browser, so what the office is shown before committing is
 * computed by the same code that then writes it (see `midYearPreview`/`midYearCommit` — the test that
 * matters asserts those two agree).
 */
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db';
import { carryIns, families, feePlans, invoiceItems, invoices, payments, schoolYears, studentFees, students } from '../db/schema';
import { rid } from '../db/ids';
import { audit } from '../audit';
import { reallocateStudent, recordPayment, studentBalance, type Balance } from './ledger';
import { CARRY_IN_PERIOD, firstDayOf, periodOf, previousPeriod } from './period';
import { schoolYearMonths } from './schoolYear';

type Actor = { userId: string | null; role: string; name: string | null };

/** What the office says about one child. `square` writes nothing at all. */
export type CarryInKind = 'owes' | 'ahead' | 'square';

export interface MidYearRow {
  studentId: string;
  /** The last month already settled before go-live. Null = tell me nothing, treat as square. */
  paidThrough?: string | null;
  /**
   * "They have paid nothing at all this year" (0.48.0).
   *
   * A separate flag rather than a sentinel in `paidThrough`, because that field is compared as a period
   * key in three places — the derivation here, the year grid, and the `carry_ins` row it is stored in —
   * and a non-period string would sort in ways that quietly mean the opposite ('2026-04' <= 'none' is
   * true, which would read every month as PAID). `midYearPlan` turns it into the real month it means:
   * the one before the school year began, which is literally what "nothing paid this year" says.
   */
  paidNothing?: boolean;
  /** The office's own figure, when the notebook disagrees with the derived one. */
  amountOverrideCents?: number | null;
  /** Which direction an override means. Ignored unless `amountOverrideCents` is given. */
  kindOverride?: Exclude<CarryInKind, 'square'> | null;
}

export interface MidYearStudent {
  studentId: string;
  fullName: string;
  studentCode: string | null;
  /** A child who has left still owes what they owe — shown, and marked, rather than dropped. */
  withdrawn: boolean;
  familyId: string;
  familyLabel: string;
  /** What a month bills this child today — the figure the derivation multiplies. */
  monthlyCents: number;
  /** Months of the configured year that fall before go-live, oldest first. */
  monthsBefore: string[];
  kind: CarryInKind;
  /** The month the office said was already settled, echoed back — null when they said nothing. */
  paidThrough: string | null;
  /** Always ≥ 0. The size of the artifact about to be written. */
  amountCents: number;
  /** How the figure was arrived at, so the preview can say so. */
  derivedFrom: 'months' | 'override' | 'none';
  monthCount: number;
  /** Their balance now, and what it becomes once this is committed. */
  before: Balance;
  afterOwedCents: number;
  afterCreditCents: number;
  /** True when this child already carries a committed artifact — it is left alone. */
  already: boolean;
}

/** What a month bills one child today: their monthly plans, each at the override price if it has one. */
export function monthlyRateCents(studentId: string): number {
  return db
    .select({ planAmount: feePlans.amountCents, override: studentFees.overrideAmountCents })
    .from(studentFees)
    .innerJoin(feePlans, eq(feePlans.id, studentFees.feePlanId))
    .where(and(eq(studentFees.studentId, studentId), eq(feePlans.status, 'active'), eq(feePlans.cadence, 'monthly')))
    .all()
    .reduce((s, r) => s + (r.override ?? r.planAmount), 0);
}

/**
 * Turn "paid through January" into an amount and a direction.
 *
 * One dropdown covers both cases, which is why the wizard needs only one control per child: with
 * go-live in February, "paid through January" is square, "paid through November" owes December and
 * January, and "paid through June" is five months paid ahead. Months are counted from the CONFIGURED
 * school year, so a year that runs Apr→Mar counts its own months and nobody does calendar arithmetic.
 */
export function deriveCarryIn(
  monthlyCents: number,
  yearMonths: string[],
  goLivePeriod: string,
  paidThrough: string | null | undefined,
): { kind: CarryInKind; amountCents: number; monthCount: number } {
  if (!paidThrough) return { kind: 'square', amountCents: 0, monthCount: 0 };
  const owedMonths = yearMonths.filter((m) => m < goLivePeriod && m > paidThrough);
  if (owedMonths.length) return { kind: 'owes', amountCents: monthlyCents * owedMonths.length, monthCount: owedMonths.length };
  const aheadMonths = yearMonths.filter((m) => m >= goLivePeriod && m <= paidThrough);
  if (aheadMonths.length) return { kind: 'ahead', amountCents: monthlyCents * aheadMonths.length, monthCount: aheadMonths.length };
  return { kind: 'square', amountCents: 0, monthCount: 0 };
}

/** Does this child already carry a committed carry-in? Either artifact counts. */
export function hasCarryIn(studentId: string): boolean {
  const inv = db.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.studentId, studentId), eq(invoices.periodKey, CARRY_IN_PERIOD))).get();
  if (inv) return true;
  return !!db.select({ id: payments.id }).from(payments).where(eq(payments.idempotencyKey, carryInKey(studentId))).get();
}

/** One key per child, so committing twice is a no-op rather than a doubled prepayment. */
export function carryInKey(studentId: string): string {
  return `carry-in:${studentId}`;
}

/**
 * Keep the ANSWER the office gave, beside the artifact derived from it (0.48.0).
 *
 * "Paid through November" is the only thing anybody knows about the months before go-live, and it was
 * thrown away the moment it became an amount — so the year view could say those months were never
 * billed here, but not which of them a family had actually settled. That is the distinction an office
 * wants, and this is the smallest honest way to keep it: a note, written once, next to the money.
 *
 * Nothing bills from it (see the module header — the ledger is still the only source of truth), and it
 * is recorded for a SQUARE child too, who gets no artifact at all: "they were up to date" is exactly
 * the answer the screen needs, and it is indistinguishable from silence unless it is written down.
 *
 * First answer wins, matching the artifact's own idempotency — a second run of the wizard must not
 * rewrite a history the first one already recorded.
 */
export function noteCarryIn(rec: { studentId: string; goLivePeriod: string; paidThrough?: string | null; kind: CarryInKind; amountCents: number }): void {
  if (db.select({ id: carryIns.studentId }).from(carryIns).where(eq(carryIns.studentId, rec.studentId)).get()) return;
  db.insert(carryIns)
    .values({
      studentId: rec.studentId,
      goLivePeriod: rec.goLivePeriod,
      paidThrough: rec.paidThrough?.trim() || null,
      kind: rec.kind,
      amountCents: rec.amountCents,
      createdAt: new Date(),
    })
    .run();
}

/** What the office said about one child at go-live, or null if they were never asked. */
export function carryInRecord(studentId: string): { paidThrough: string | null; goLivePeriod: string; kind: CarryInKind } | null {
  const r = db.select().from(carryIns).where(eq(carryIns.studentId, studentId)).get();
  return r ? { paidThrough: r.paidThrough, goLivePeriod: r.goLivePeriod, kind: r.kind } : null;
}

/** The roster the wizard works down: every active child with their rate, their current balance, and
 *  what the given rows would do to them. Pure — writes nothing. */
export function midYearPlan(goLivePeriod: string, schoolYearId: string | null, rows: MidYearRow[]): { months: string[]; students: MidYearStudent[] } {
  const year = schoolYearId
    ? db.select().from(schoolYears).where(eq(schoolYears.id, schoolYearId)).get()
    : db.select().from(schoolYears).where(eq(schoolYears.isCurrent, true)).get();
  const months = year && year.startYear != null ? schoolYearMonths(year.startYear, year.startMonth, year.endMonth).map((m) => m.periodKey) : [];

  const byId = new Map(rows.map((r) => [r.studentId, r]));
  // EVERY child, not just the active ones. A child who left in December still owes December's tuition,
  // and the household still gets a statement for it — `familyStudentIds` in the ledger is deliberately
  // unscoped for exactly this reason. Leaving them off the roster would mean the one figure this screen
  // exists to record could not be recorded for them, and their household's preview total would be wrong.
  const kids = db
    .select({ id: students.id, fullName: students.fullName, studentCode: students.studentCode, status: students.status, familyId: students.familyId, familyLabel: families.name })
    .from(students)
    .innerJoin(families, eq(families.id, students.familyId))
    .orderBy(asc(families.name), asc(students.fullName))
    .all();

  const out = kids.map((k) => {
    const row = byId.get(k.id);
    const monthlyCents = monthlyRateCents(k.id);
    // "Paid nothing at all" IS a paid-through month: the one before the year started. Resolved here, once,
    // so the derivation, the stored record and the year grid all see a real period key (0.48.0).
    const paidThrough = row?.paidNothing && months.length ? previousPeriod(months[0]) : row?.paidThrough;
    const derived = deriveCarryIn(monthlyCents, months, goLivePeriod, paidThrough);
    const override = row?.amountOverrideCents;
    const useOverride = typeof override === 'number' && override > 0 && !!row?.kindOverride;
    const kind: CarryInKind = useOverride ? (row!.kindOverride as CarryInKind) : derived.kind;
    const amountCents = useOverride ? override : derived.amountCents;
    const before = studentBalance(k.id);
    // The same subtraction the ledger does: an owed artifact adds to invoiced, a prepayment adds to
    // paid. Deriving the preview this way is what makes it match the commit exactly.
    const balanceAfter = before.balanceCents + (kind === 'owes' ? amountCents : kind === 'ahead' ? -amountCents : 0);
    return {
      studentId: k.id,
      fullName: k.fullName,
      studentCode: k.studentCode,
      withdrawn: k.status !== 'active',
      familyId: k.familyId,
      familyLabel: k.familyLabel,
      monthlyCents,
      monthsBefore: months.filter((m) => m < goLivePeriod),
      kind,
      paidThrough: paidThrough?.trim() || null,
      amountCents,
      derivedFrom: useOverride ? ('override' as const) : derived.kind === 'square' ? ('none' as const) : ('months' as const),
      monthCount: useOverride ? 0 : derived.monthCount,
      before,
      afterOwedCents: balanceAfter > 0 ? balanceAfter : 0,
      afterCreditCents: balanceAfter < 0 ? -balanceAfter : 0,
      already: hasCarryIn(k.id),
    };
  });
  return { months, students: out };
}

/**
 * Write one child's carried-forward balance. Idempotent, and refuses to write a second one.
 *
 * An arrears invoice is dated the first of the month BEFORE go-live: a real past date, so it sorts
 * ahead of every month this app will generate and autopay treats it as due. A prepayment is dated when
 * the office says the money arrived.
 */
export function commitCarryIn(
  input: { studentId: string; kind: CarryInKind; amountCents: number; goLivePeriod: string; asOf?: string | null; memo?: string | null },
  actor: Actor,
): { wrote: false } | { wrote: true; kind: 'owes'; invoiceId: string } | { wrote: true; kind: 'ahead'; paymentId: string } {
  if (input.kind === 'square' || input.amountCents <= 0) return { wrote: false };
  if (hasCarryIn(input.studentId)) return { wrote: false };
  const memo = input.memo?.trim() || null;

  if (input.kind === 'ahead') {
    const r = recordCarryInPayment(input.studentId, input.amountCents, input.asOf ?? null, memo, actor);
    audit(actor, 'billing.carryIn', { entity: 'student', entityId: input.studentId, detail: { kind: 'ahead', amountCents: input.amountCents, paymentId: r.paymentId } });
    return { wrote: true, kind: 'ahead', paymentId: r.paymentId };
  }

  const ts = new Date();
  const invId = rid('inv');
  const dueDate = firstDayOf(previousPeriod(input.goLivePeriod));
  db.transaction((tx) => {
    tx.insert(invoices).values({ id: invId, studentId: input.studentId, label: 'Balance carried forward', periodKey: CARRY_IN_PERIOD, dueDate, status: 'open', createdAt: ts, updatedAt: ts }).run();
    tx.insert(invoiceItems)
      .values({ id: rid('iti'), invoiceId: invId, description: memo ? `Owed before ${input.goLivePeriod} — ${memo}` : `Owed before ${input.goLivePeriod}`, amountCents: input.amountCents, studentId: input.studentId, feePlanId: null, createdAt: ts })
      .run();
    // Money the child already has sitting as credit should cover this the moment it exists.
    reallocateStudent(tx, input.studentId);
  });
  audit(actor, 'billing.carryIn', { entity: 'student', entityId: input.studentId, detail: { kind: 'owes', amountCents: input.amountCents, invoiceId: invId } });
  return { wrote: true, kind: 'owes', invoiceId: invId };
}

/** The prepayment half — a real payment row, through the ONE money-write path (§16), so it lands in
 *  the ledger like any other money and the next generated invoice absorbs it. */
function recordCarryInPayment(studentId: string, amountCents: number, asOf: string | null, memo: string | null, actor: Actor): { paymentId: string } {
  const occurredAt = asOf ? new Date(`${asOf}T12:00:00`) : new Date();
  return recordPayment(
    {
      studentId,
      amountCents,
      channel: 'carry_in',
      occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
      idempotencyKey: carryInKey(studentId),
      memo: memo ?? 'Paid before this app was in use',
    },
    actor,
  );
}

/** The month an office would default the wizard to: this one. */
export function defaultGoLivePeriod(): string {
  return periodOf(new Date());
}
