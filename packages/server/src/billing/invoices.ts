// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Invoice generation (CLAUDE.md §4): build ONE STUDENT's invoice for a period from their own fee
 * plans (one line per plan), then append any pending one-off charges of theirs.
 * UNIQUE(student, periodKey) makes generation idempotent — re-running a period never double-bills.
 * Money is integer cents.
 *
 * Two rules live here and nowhere else:
 *
 *  1. CADENCE IS HONORED. A `monthly` plan bills only on month periods; a `per_term` plan only
 *     on term periods (so generating a term invoice can't double-bill monthly tuition); a
 *     `one_time` plan bills exactly once, ever, deduped on (student, plan) against live invoice
 *     lines. A madrasah with no terms configured simply never generates term periods, so its
 *     `per_term` plans are an intentional no-op.
 *  2. THE EFFECTIVE AMOUNT is `student_fees.override_amount_cents ?? fee_plans.amount_cents`, so
 *     one student can be charged differently without minting a parallel plan. This override is
 *     also how a sibling discount is expressed now that the family-level discount is gone (0.39.0)
 *     — a discount belongs on the child whose bill it reduces, not on a household line no single
 *     invoice could honestly carry.
 */
import { and, eq, asc, inArray, ne, or, isNull } from 'drizzle-orm';
import { db } from '../db';
import { invoices, invoiceItems, studentFees, students, feePlans, charges } from '../db/schema';
import { rid } from '../db/ids';
import { refreshStatus, reallocateStudent, invoiceTotal, type Tx } from './ledger';
import { firstDayOf, isMonthPeriod, IMMEDIATE_PERIOD_PREFIX } from './period';
import { getCurrency } from '../settings';
import { formatDate } from '../settings/dates';
import { formatMoney } from '../db/money';
import { givenName } from '../people/names';
import { sendInvoiceReady } from '../mail/notify';

/** Which kind of period is being generated. Drives the cadence gate. */
export type PeriodKind = 'month' | 'term';

export interface GenerateOpts {
  periodKey: string;
  label: string;
  dueDate?: string | null;
  /** Defaults to `month` — the common case and what the existing callers mean. */
  periodKind?: PeriodKind;
}

/** Has this student already been billed for this plan on a LIVE (non-void) invoice? Voiding an
 *  invoice deliberately makes a one-time fee billable again. */
function alreadyBilled(tx: Tx, studentId: string, feePlanId: string): boolean {
  return !!tx
    .select({ id: invoiceItems.id })
    .from(invoiceItems)
    .innerJoin(invoices, eq(invoices.id, invoiceItems.invoiceId))
    .where(and(eq(invoiceItems.studentId, studentId), eq(invoiceItems.feePlanId, feePlanId), ne(invoices.status, 'void')))
    .get();
}

interface Line {
  description: string;
  amountCents: number;
  studentId: string;
  feePlanId: string | null;
}

/** Tuition lines from ONE student's active fee plans, after the cadence gate and the per-student
 *  override. Returns [] for a student who is not active. */
function feeLines(tx: Tx, studentId: string, periodKind: PeriodKind): Line[] {
  const rows = tx
    .select({
      studentId: students.id,
      planId: feePlans.id,
      planName: feePlans.name,
      planAmount: feePlans.amountCents,
      cadence: feePlans.cadence,
      override: studentFees.overrideAmountCents,
    })
    .from(studentFees)
    .innerJoin(students, eq(students.id, studentFees.studentId))
    .innerJoin(feePlans, eq(feePlans.id, studentFees.feePlanId))
    .where(and(eq(students.id, studentId), eq(students.status, 'active'), eq(feePlans.status, 'active')))
    .orderBy(asc(feePlans.name))
    .all();

  const out: Line[] = [];
  for (const r of rows) {
    if (r.cadence === 'monthly' && periodKind !== 'month') continue;
    if (r.cadence === 'per_term' && periodKind !== 'term') continue;
    if (r.cadence === 'one_time' && alreadyBilled(tx, r.studentId, r.planId)) continue;
    const amountCents = r.override ?? r.planAmount;
    if (amountCents === 0) continue; // a zero line is noise on a printed statement
    // No name in the description any more: the invoice IS the child's, so "Tuition — Yusuf" on
    // Yusuf's own bill just repeats the header.
    out.push({ description: r.planName, amountCents, studentId: r.studentId, feePlanId: r.planId });
  }
  return out;
}

/** One student's pending charges that belong on this period: either explicitly targeted at it, or
 *  untargeted (`period_key IS NULL`) and therefore due on the next invoice generated. */
function pendingCharges(tx: Tx, studentId: string, periodKey: string) {
  return tx
    .select({ id: charges.id, studentId: charges.studentId, label: charges.label, amountCents: charges.amountCents })
    .from(charges)
    .innerJoin(students, eq(students.id, charges.studentId))
    .where(
      and(
        eq(students.id, studentId),
        eq(students.status, 'active'),
        eq(charges.status, 'pending'),
        or(eq(charges.periodKey, periodKey), isNull(charges.periodKey)),
      ),
    )
    .orderBy(asc(charges.createdAt))
    .all();
}

/**
 * When a bill is due. A month bill with no stated due date is dated the FIRST of that month.
 *
 * Not a cosmetic default: a NULL due date makes an invoice invisible to autopay, whose whole query is
 * `due_date <= today`, and sorts it LAST in `reallocateStudent` so money skips past it to newer months.
 * A February bill with no date was therefore never chased and never ticked, which is the opposite of
 * what generating it meant. A term period keeps null — its dates come from the configured term.
 */
function dueDateFor(opts: GenerateOpts): string | null {
  if (opts.dueDate) return opts.dueDate;
  return isMonthPeriod(opts.periodKey) ? firstDayOf(opts.periodKey) : null;
}

/** Insert one charge as an invoice line and flip it to `invoiced`. */
function writeChargeLine(tx: Tx, invoiceId: string, c: { id: string; studentId: string; label: string; amountCents: number }, ts: Date): void {
  const itemId = rid('iti');
  tx.insert(invoiceItems).values({ id: itemId, invoiceId, description: c.label, amountCents: c.amountCents, studentId: c.studentId, feePlanId: null, createdAt: ts }).run();
  tx.update(charges).set({ status: 'invoiced', invoiceItemId: itemId, updatedAt: ts }).where(eq(charges.id, c.id)).run();
}

/**
 * Hand a voided invoice's charges back, so they can be billed again. ONE place decides this (§16).
 *
 * A charge is marked `invoiced` and pointed at the line it became. Voiding the invoice left it that
 * way — so the charge was never picked up again by `pendingCharges` (which selects `status: 'pending'`),
 * and the money it represented was silently dropped: a book fee voided along with February's tuition
 * simply stopped being owed, with nothing on any screen saying so. That is the same rule `alreadyBilled`
 * already states for a one-time FEE plan — "voiding an invoice deliberately makes it billable again" —
 * and a charge is the one kind of line that was not getting it.
 *
 * It also clears the way to delete the row: `charges.invoice_item_id` is ON DELETE RESTRICT, so a
 * stranded charge would block the regeneration below with an FK error rather than a message.
 *
 * Called from `voidInvoice` (the forward fix) and from `generateForStudent` (which covers invoices
 * voided by an earlier version, where the charge is still stranded).
 */
export function releaseChargesFrom(tx: Tx, invoiceId: string): number {
  const items = tx.select({ id: invoiceItems.id }).from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId)).all();
  if (items.length === 0) return 0;
  const ids = items.map((i) => i.id);
  const stranded = tx.select({ id: charges.id }).from(charges).where(inArray(charges.invoiceItemId, ids)).all();
  if (stranded.length === 0) return 0;
  tx.update(charges)
    .set({ status: 'pending', invoiceItemId: null, updatedAt: new Date() })
    .where(inArray(charges.invoiceItemId, ids))
    .run();
  return stranded.length;
}

/** Generate one STUDENT's invoice for a period. Idempotent on (student, periodKey); returns the
 *  existing invoice unchanged if already generated, and skips a student with nothing to bill.
 *  Everything is computed INSIDE the transaction so the one-time dedupe can't race the insert. */
export function generateForStudent(studentId: string, opts: GenerateOpts): { invoiceId: string | null; created: boolean } {
  const existing = db
    .select({ id: invoices.id, status: invoices.status })
    .from(invoices)
    .where(and(eq(invoices.studentId, studentId), eq(invoices.periodKey, opts.periodKey)))
    .get();
  /**
   * A LIVE invoice means this period is already billed — return it untouched, which is the idempotency
   * every generation path relies on.
   *
   * A VOIDED one used to mean the same thing, and that was a trap with no way out of it. `invoices` is
   * UNIQUE(student, period_key), so the void row kept the slot for good: after an office voided a bill
   * to correct it, that child could never be billed for that month again — not by hand, not by the
   * nightly job — and the only feedback was "Generated 0 invoice(s)", which reads like there was nothing
   * to bill. Voiding is how an office fixes a wrong bill, so it has to be a step they can come back from.
   *
   * The void row is REPLACED rather than kept beside the new one. It provably holds no money — `voidInvoice`
   * refuses while any payment is allocated, and the allocator skips void invoices entirely, so one can never
   * acquire an allocation afterwards — and the alternative, two rows for one month, would show up twice on
   * the family's record and make every month-keyed reader (the year grid, the statement) pick between them.
   * The `invoice.void` audit entry is what survives, which is the record that matters.
   */
  if (existing && existing.status !== 'void') return { invoiceId: existing.id, created: false };

  const periodKind = opts.periodKind ?? 'month';
  const ts = new Date();
  const invId = rid('inv');
  let created = false;

  db.transaction((tx) => {
    /**
     * Release the voided bill's charges BEFORE reading them — that is what makes a charge which was on
     * the voided invoice show up in `pendingCharges` below, so the replacement carries it instead of
     * dropping it.
     *
     * Deleting the void row waits until we know there is something to replace it with. An early return
     * out of this callback COMMITS (only a throw rolls back), so deleting up here would destroy the
     * voided record on a run that then billed nothing. Releasing the charges early is safe either way:
     * pending is the correct state for a charge whose invoice is void, whether or not this run bills.
     */
    if (existing) releaseChargesFrom(tx, existing.id);
    const lines = feeLines(tx, studentId, periodKind);
    const chs = pendingCharges(tx, studentId, opts.periodKey);
    if (lines.length === 0 && chs.length === 0) return; // nothing to bill — no empty invoice
    if (existing) tx.delete(invoices).where(eq(invoices.id, existing.id)).run(); // items cascade

    tx.insert(invoices).values({ id: invId, studentId, label: opts.label, periodKey: opts.periodKey, dueDate: dueDateFor(opts), status: 'open', createdAt: ts, updatedAt: ts }).run();
    for (const l of lines) {
      tx.insert(invoiceItems).values({ id: rid('iti'), invoiceId: invId, description: l.description, amountCents: l.amountCents, studentId: l.studentId, feePlanId: l.feePlanId, createdAt: ts }).run();
    }
    for (const c of chs) writeChargeLine(tx, invId, c, ts);
    // Money the family already handed over covers this month the moment it is billed. Without this
    // an advance payment stayed as an unattached credit and the new invoice showed up unpaid — right
    // balance, wrong invoice status, and a ✗ in the year grid for a month that IS paid.
    reallocateStudent(tx, studentId);
    created = true;
  });

  return { invoiceId: created ? invId : null, created };
}

/** Generate invoices for every student on one family. The "bill this household" action — a parent
 *  thinks in households even though each child now gets their own bill. */
export function generateForFamily(familyId: string, opts: GenerateOpts): { created: number; invoiceIds: string[] } {
  const kids = db.select({ id: students.id }).from(students).where(and(eq(students.familyId, familyId), eq(students.status, 'active'))).orderBy(asc(students.fullName)).all();
  const invoiceIds: string[] = [];
  let created = 0;
  for (const k of kids) {
    const r = generateForStudent(k.id, opts);
    if (r.invoiceId) invoiceIds.push(r.invoiceId);
    if (r.created) created++;
  }
  if (created) void tellFamilies(invoiceIds);
  return { created, invoiceIds };
}

/** Generate invoices for every active student who has something to bill. Returns how many were created. */
export function generateForPeriod(opts: GenerateOpts): { created: number } {
  const kids = db.select({ id: students.id }).from(students).where(eq(students.status, 'active')).all();
  const fresh: string[] = [];
  for (const k of kids) {
    const r = generateForStudent(k.id, opts);
    if (r.created && r.invoiceId) fresh.push(r.invoiceId);
  }
  if (fresh.length) void tellFamilies(fresh);
  return { created: fresh.length };
}

/**
 * Tell each household its bill is ready (0.50.0) — ONE message per household, not one per child.
 *
 * Notified from the two RUN-level functions rather than from `generateForStudent`, and that is the
 * whole reason this helper exists: bills are per child, but the message is to a parent, and a
 * household with three children would otherwise get three of them for one billing run — on a channel
 * whose sending allowance belongs to the masjid's own number.
 *
 * Fire-and-forget and never throws: generation is a money operation and must not fail because a
 * notification did. Only invoices CREATED in this run are counted, so re-running a period (which is
 * idempotent by design) does not message anybody a second time.
 */
function tellFamilies(invoiceIds: string[]): Promise<void> {
  const rows = db
    .select({ familyId: students.familyId, invoiceId: invoices.id, dueDate: invoices.dueDate, fullName: students.fullName })
    .from(invoices)
    .innerJoin(students, eq(students.id, invoices.studentId))
    .where(inArray(invoices.id, invoiceIds))
    .all();

  const byFamily = new Map<string, { total: number; due: string | null; children: string[] }>();
  for (const r of rows) {
    const cur = byFamily.get(r.familyId) ?? { total: 0, due: r.dueDate, children: [] };
    cur.total += invoiceTotal(db, r.invoiceId);
    // The earliest due date across the household's new bills — the one a parent has to act on first.
    if (r.dueDate && (!cur.due || r.dueDate < cur.due)) cur.due = r.dueDate;
    cur.children.push(givenName(r.fullName));
    byFamily.set(r.familyId, cur);
  }

  const currency = getCurrency();
  return (async () => {
    for (const [familyId, v] of byFamily) {
      try {
        await sendInvoiceReady(familyId, formatMoney(v.total, currency), v.due ? formatDate(v.due) : '', v.children);
      } catch {
        /* best-effort — a household we could not tell must not stop the rest being told */
      }
    }
  })();
}

/**
 * BILL ONE CHARGE ON ITS OWN, NOW — without waiting for, or forcing, a period's invoice run
 * (0.51.0-dev.10).
 *
 * The gap this closes: a book fee added in the middle of August was payable only once somebody
 * generated August's tuition invoices. An office that had not billed the month yet had to either
 * generate the whole month early — committing every child's tuition — or tell the parent to wait. So
 * this is now the default: the charge becomes its own one-line bill, due today, payable through every
 * channel the moment it exists.
 *
 * TWO THINGS MAKE IT SAFE, and both are the reason it is not simply "make an invoice":
 *
 *  1. **It cannot eat the month's slot.** `invoices` is UNIQUE on (student, period_key), so an invoice
 *     keyed `2026-08` would BE that student's August invoice — and `generateForStudent` returns early
 *     when one exists, so the real August tuition would silently never be billed for them. The key is
 *     therefore per-charge (`charge-<id>`, `IMMEDIATE_PERIOD_PREFIX`), unique by construction and not
 *     month-shaped, so the generator and every month-shaped query pass over it.
 *  2. **The charge cannot be billed twice.** It flips to `invoiced` inside the same transaction
 *     (`writeChargeLine`), and generation only ever picks up `pending` charges — so the next run for
 *     any period cannot pick this one up again.
 *
 * A CREDIT IS REFUSED. A negative charge is how a bursary or a correction is expressed (§4), and its
 * whole purpose is to reduce a bill — on its own it would be an invoice with a negative balance, which
 * is not a thing a parent can pay and not a thing the allocator has any sensible answer for. A credit
 * belongs on the period it is discounting, so the caller is told `credit` and the UI keeps it there.
 *
 * NO `invoice-ready` NOTIFICATION, deliberately, matching `generateForStudent` which also stays silent
 * (§9: the notice is per household and is sent from the run-level functions, so a family of three gets
 * one message and not three). The mass-apply path can create a hundred of these in one press, and a
 * hundred households hearing about a $5 charge is exactly the burst the send budget exists to prevent.
 * The parent sees it in the portal, on the statement, and on their next receipt.
 */
/**
 * Can an amount stand as a bill of its own? — the ONE place that answers it.
 *
 * A credit cannot: it is a negative line whose whole purpose is to reduce something (§4), and alone it
 * would be an invoice with a negative balance, which is not payable and which the allocator has no
 * sensible answer for. So it has to go ON the period it is discounting.
 *
 * Exported because the ROUTER has to know the answer BEFORE it writes the charge row — a charge that is
 * about to be billed on its own belongs to no period, and one that is not must keep the month it was
 * aimed at. That is two callers, so this had to stop being a comparison written out twice: the first
 * version tested `>= 0` in the router and `< 0` in here, which meant the guard that mattered was the
 * router's and the one in here could be deleted with every test still passing.
 */
export function canBillAlone(amountCents: number): boolean {
  return amountCents >= 0;
}

export function billChargeNow(chargeId: string, today = new Date()): { invoiceId?: string; billed: boolean; reason?: 'not_pending' | 'credit' | 'no_student' } {
  const c = db
    .select({ id: charges.id, studentId: charges.studentId, label: charges.label, amountCents: charges.amountCents, status: charges.status })
    .from(charges)
    .where(eq(charges.id, chargeId))
    .get();
  if (!c || c.status !== 'pending') return { billed: false, reason: 'not_pending' };
  if (!canBillAlone(c.amountCents)) return { billed: false, reason: 'credit' };
  if (!db.select({ id: students.id }).from(students).where(and(eq(students.id, c.studentId), eq(students.status, 'active'))).get()) {
    return { billed: false, reason: 'no_student' };
  }

  const invId = rid('inv');
  const ts = new Date();
  // Due TODAY: "charge immediately" means payable immediately, and a due date is what makes it visible
  // to autopay, to the past-due chase and to the year-end view of what is outstanding.
  const dueDate = today.toISOString().slice(0, 10);
  db.transaction((tx) => {
    tx.insert(invoices)
      .values({ id: invId, studentId: c.studentId, label: c.label, periodKey: `${IMMEDIATE_PERIOD_PREFIX}${c.id}`, dueDate, status: 'open', createdAt: ts, updatedAt: ts })
      .run();
    writeChargeLine(tx, invId, { id: c.id, studentId: c.studentId, label: c.label, amountCents: c.amountCents }, ts);
    refreshStatus(tx, invId);
    // A family already sitting on credit should have this come out of it, which is what a parent means
    // by "we've paid ahead" — the same re-derivation `attachChargeToExistingInvoice` relies on.
    reallocateStudent(tx, c.studentId);
  });
  return { billed: true, invoiceId: invId };
}

/** Append a single pending charge onto the family's ALREADY-EXISTING invoice for its period, when
 *  there is one. This is the "add a charge to the invoice" path: if the period has been generated
 *  the charge lands immediately and the invoice's status is re-derived; otherwise it stays
 *  `pending` and the next generation picks it up. A void invoice is refused — its lines are
 *  settled history, and re-opening it by adding a line would corrupt the family balance. */
export function attachChargeToExistingInvoice(chargeId: string): { attached: boolean; invoiceId?: string; reason?: 'no_period' | 'no_invoice' | 'invoice_void' | 'not_pending' } {
  const c = db
    .select({ id: charges.id, studentId: charges.studentId, label: charges.label, amountCents: charges.amountCents, periodKey: charges.periodKey, status: charges.status })
    .from(charges)
    .where(eq(charges.id, chargeId))
    .get();
  if (!c) return { attached: false, reason: 'not_pending' };
  if (c.status !== 'pending') return { attached: false, reason: 'not_pending' };
  if (!c.periodKey) return { attached: false, reason: 'no_period' };

  const inv = db.select({ id: invoices.id, status: invoices.status }).from(invoices).where(and(eq(invoices.studentId, c.studentId), eq(invoices.periodKey, c.periodKey))).get();
  if (!inv) return { attached: false, reason: 'no_invoice' };
  if (inv.status === 'void') return { attached: false, reason: 'invoice_void' };

  const ts = new Date();
  db.transaction((tx) => {
    writeChargeLine(tx, inv.id, { id: c.id, studentId: c.studentId, label: c.label, amountCents: c.amountCents }, ts);
    tx.update(invoices).set({ updatedAt: ts }).where(eq(invoices.id, inv.id)).run();
    refreshStatus(tx, inv.id);
    // A charge on a family sitting on an advance balance should come OUT of that balance first —
    // that is what a parent means by "we've already paid ahead". Re-deriving oldest-due-first does
    // it: the charge's invoice is older than the months the advance was covering, so it takes its
    // money back off the newest covered month. If that leaves the month short it correctly returns
    // to open, which is what puts it back on the statement and in front of autopay.
    reallocateStudent(tx, c.studentId);
  });
  return { attached: true, invoiceId: inv.id };
}
