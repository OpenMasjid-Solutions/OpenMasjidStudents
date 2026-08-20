// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The ledger — the ONE money-write path (CLAUDE.md §16). Every payment (manual, Fabric, portal,
 * autopay, reconciliation) flows through `recordPayment`. Money is integer cents; balances are
 * DERIVED, never stored; payments are immutable (corrections are reversal rows).
 *
 * PER STUDENT since 0.39.0. A payment belongs to one child and pays *that child's* open invoices
 * oldest-due-first; any surplus stays as that child's credit, which the next invoice for them
 * absorbs automatically (nothing is stored — `credit = max(0, paid − invoiced)` falls out of the
 * same subtraction). `familyBalance` still exists and simply sums a family's students, because a
 * parent pays once for all their children.
 *
 * `idempotencyKey` is UNIQUE, so a replay returns the original. When one real card charge covers
 * several siblings the caller records it once per child with a per-student key suffix — see
 * `recordSplit`.
 */
import { and, eq, asc, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import type { DB } from '../db';
import { invoices, invoiceItems, payments, paymentAllocations, autopayEnrollments, students } from '../db/schema';
import type { InvoiceStatus, PaymentChannel } from '../db/schema';
import { rid } from '../db/ids';
import { orderedItems } from './lines';

export type Tx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];
type Actor = { userId: string | null; role: string; name: string | null };

/** Sum of an invoice's line items (its total). */
export function invoiceTotal(tx: Tx, invoiceId: string): number {
  return tx.select({ a: invoiceItems.amountCents }).from(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId)).all().reduce((s, r) => s + r.a, 0);
}
/** Sum of allocations against an invoice (nets reversals, which are negative). */
export function invoicePaid(tx: Tx, invoiceId: string): number {
  return tx.select({ a: paymentAllocations.amountCents }).from(paymentAllocations).where(eq(paymentAllocations.invoiceId, invoiceId)).all().reduce((s, r) => s + r.a, 0);
}

function statusFor(total: number, paid: number): InvoiceStatus {
  // A bill that costs nothing is settled, not open. This test has to come FIRST: a 100% bursary makes
  // the total 0 (or negative), no payment is possible against it, and asking "has anything been paid?"
  // first left such an invoice reading Open with a $0.00 balance forever — on the statement, in the
  // year grid, and in front of the office.
  if (total <= 0) return 'paid';
  if (paid <= 0) return 'open';
  if (paid >= total) return 'paid';
  return 'partially_paid';
}

/** Recompute + persist an invoice's status from its total vs allocated (skips voided).
 *  Exported because appending a charge line changes an invoice's TOTAL, so its status has to be
 *  re-derived too — a charge added to a `paid` invoice correctly drops it to `partially_paid`. */
export function refreshStatus(tx: Tx, invoiceId: string): void {
  const inv = tx.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, invoiceId)).get();
  if (!inv || inv.status === 'void') return;
  tx.update(invoices).set({ status: statusFor(invoiceTotal(tx, invoiceId), invoicePaid(tx, invoiceId)), updatedAt: new Date() }).where(eq(invoices.id, invoiceId)).run();
}

export interface Balance {
  invoicedCents: number;
  paidCents: number;
  balanceCents: number; // > 0 owed, < 0 overpaid
  creditCents: number; // max(0, -balance)
  owedCents: number; // max(0, balance)
}
/** Retained name — a family balance and a student balance have the same shape. */
export type FamilyBalance = Balance;

const zero = (): Balance => ({ invoicedCents: 0, paidCents: 0, balanceCents: 0, creditCents: 0, owedCents: 0 });

const shape = (invoicedCents: number, paidCents: number): Balance => {
  const balanceCents = invoicedCents - paidCents;
  return { invoicedCents, paidCents, balanceCents, creditCents: balanceCents < 0 ? -balanceCents : 0, owedCents: balanceCents > 0 ? balanceCents : 0 };
};

/** One student's derived balance: everything invoiced to them (non-void) minus their net payments.
 *  Overpayment shows as `creditCents` and is absorbed by their next invoice — there is no stored
 *  credit to go stale. */
export function studentBalance(studentId: string): Balance {
  return balanceForStudents([studentId]);
}

/** The combined balance across a set of students — one query pass, so a family view of 5 children
 *  costs the same as one. Used by `familyBalance`, the portal and the year view. */
export function balanceForStudents(studentIds: string[]): Balance {
  if (!studentIds.length) return zero();
  const liveIds = db
    .select({ id: invoices.id, status: invoices.status })
    .from(invoices)
    .where(inArray(invoices.studentId, studentIds))
    .all()
    .filter((i) => i.status !== 'void')
    .map((i) => i.id);
  const invoicedCents = liveIds.length
    ? db.select({ a: invoiceItems.amountCents }).from(invoiceItems).where(inArray(invoiceItems.invoiceId, liveIds)).all().reduce((s, r) => s + r.a, 0)
    : 0;
  const paidCents = db.select({ a: payments.amountCents }).from(payments).where(inArray(payments.studentId, studentIds)).all().reduce((s, r) => s + r.a, 0);
  return shape(invoicedCents, paidCents);
}

/** Every student id on a family, whatever their status — a withdrawn child's unpaid bill is still
 *  owed, so scoping this to `active` would quietly hide real debt. */
export function familyStudentIds(familyId: string): string[] {
  return db.select({ id: students.id }).from(students).where(eq(students.familyId, familyId)).all().map((s) => s.id);
}

/** A family's balance = the sum of its students'. A parent pays once for all their children, so this
 *  is what the portal, statements and autopay work from. */
export function familyBalance(familyId: string): Balance {
  return balanceForStudents(familyStudentIds(familyId));
}

/** "This much of the money is for that line" — a payer's instruction, not a derived mapping. */
export interface DirectedLine {
  itemId: string;
  amountCents: number;
}

export interface RecordInput {
  studentId: string;
  amountCents: number; // > 0
  channel: PaymentChannel;
  occurredAt: Date;
  idempotencyKey: string;
  memo?: string | null;
  externalRef?: Record<string, unknown> | null;
  /**
   * The invoice LINES this money was handed over for — "the $50 is the book fee" (0.43.0).
   *
   * Stored on the payment and re-honored by every later `reallocateStudent`, which is the whole
   * point: allocation is derived and gets recomputed whenever a bill changes, so an instruction that
   * lived only in the first allocation pass would silently move to the oldest invoice the next time
   * anything happened, and the line the parent chose would go back to reading as unpaid.
   */
  directed?: DirectedLine[] | null;
}

/**
 * Check a payer's line instruction and turn it into what gets stored, or null when there is none.
 *
 * An instruction may only name lines on THIS student's live invoices, and may not claim more than a
 * line costs or more than the payment is worth — a consumer bug must not be able to park one child's
 * money on another child's bill (§11.2) or to mark a $50 line as $500 settled. Rejected as
 * `invalid_allocation`, which is the error code the Fabric provider already maps to a 422.
 *
 * An invoice-level instruction (the Fabric contract's `allocations`) is normalized into lines by the
 * caller, so there is only ever one shape to honor here.
 */
function normalizeDirected(tx: Tx, input: RecordInput): DirectedLine[] | null {
  const wanted = input.directed?.filter((d) => d.amountCents > 0) ?? [];
  if (!wanted.length) return null;
  let total = 0;
  for (const d of wanted) {
    const row = tx
      .select({ itemAmount: invoiceItems.amountCents, invoiceStudent: invoices.studentId, invoiceStatus: invoices.status })
      .from(invoiceItems)
      .innerJoin(invoices, eq(invoices.id, invoiceItems.invoiceId))
      .where(eq(invoiceItems.id, d.itemId))
      .get();
    if (!row || row.invoiceStudent !== input.studentId || row.invoiceStatus === 'void') throw new Error('invalid_allocation');
    if (d.amountCents > row.itemAmount) throw new Error('invalid_allocation');
    total += d.amountCents;
  }
  if (total > input.amountCents) throw new Error('invalid_allocation');
  return wanted.map((d) => ({ itemId: d.itemId, amountCents: d.amountCents }));
}

/** Record a payment + allocate it. Idempotent on `idempotencyKey` (a replay returns the original). */
export function recordPayment(input: RecordInput, actor: Actor): { paymentId: string; duplicate: boolean; allocatedCents: number; creditCents: number } {
  const dup = db.select({ id: payments.id }).from(payments).where(eq(payments.idempotencyKey, input.idempotencyKey)).get();
  if (dup) {
    const allocated = db.select({ a: paymentAllocations.amountCents }).from(paymentAllocations).where(eq(paymentAllocations.paymentId, dup.id)).all().reduce((s, r) => s + r.a, 0);
    return { paymentId: dup.id, duplicate: true, allocatedCents: allocated, creditCents: input.amountCents - allocated };
  }
  if (input.amountCents <= 0) throw new Error('payment amount must be positive');

  const ts = new Date();
  const paymentId = rid('pay');
  let allocated = 0;
  db.transaction((tx) => {
    // An instruction about WHERE the money should land is validated here, once, and then stored with
    // the payment — everything downstream (including every later recompute) reads it from there.
    const directed = normalizeDirected(tx, input);
    tx.insert(payments).values({ id: paymentId, studentId: input.studentId, amountCents: input.amountCents, channel: input.channel, occurredAt: input.occurredAt, memo: input.memo ?? null, idempotencyKey: input.idempotencyKey, externalRef: input.externalRef ?? null, directed, reversalOf: null, recordedByUserId: actor.userId, recordedByName: actor.name, createdAt: ts }).run();

    // ONE allocation path, always: re-derive the whole student's mapping, which places this payment,
    // honors any instruction it carries, and simultaneously picks up earlier money that was left
    // unattached (see `reallocateStudent`). There used to be a second loop here for explicit
    // allocations; it wrote rows that the very next recompute deleted, so an instruction only held
    // until the next invoice was raised.
    reallocateStudent(tx, input.studentId);
    allocated = tx
      .select({ a: paymentAllocations.amountCents })
      .from(paymentAllocations)
      .where(eq(paymentAllocations.paymentId, paymentId))
      .all()
      .reduce((s, r) => s + r.a, 0);
  });
  // A payment that clears the FAMILY's balance (via ANY channel — portal, manual, autopay, Fabric)
  // resets the autopay retry ladder: it tracks CONSECUTIVE failures against outstanding debt, so once
  // the debt is gone a fresh billing cycle must start at zero, not inherit a stale failure count that
  // could trip the auto-disable early (§13.3). Autopay charges one card for all a parent's children,
  // so the ladder is still family-scoped even though the payment is not — clearing one child while a
  // sibling is still in arrears must NOT reset it. A no-op for families without an enrollment.
  const famId = db.select({ familyId: students.familyId }).from(students).where(eq(students.id, input.studentId)).get()?.familyId;
  if (famId && familyBalance(famId).owedCents === 0) {
    db.update(autopayEnrollments).set({ failureCount: 0, nextAttemptAt: null, updatedAt: new Date() }).where(eq(autopayEnrollments.familyId, famId)).run();
  }
  return { paymentId, duplicate: false, allocatedCents: allocated, creditCents: input.amountCents - allocated };
}

/**
 * Re-derive which of a student's payments cover which of their invoices, oldest-due-first.
 *
 * WHY THIS EXISTS. A balance is derived (invoiced − paid), but an invoice's STATUS — and therefore
 * every ✓ in the year grid, every "open invoice" on a statement, and what autopay decides is due —
 * comes from `payment_allocations`. Those two drifted apart in one very common case: money paid
 * before the bill existed. A parent handing over $1,400 against a $350/month fee had $350 attached
 * to the month that existed and $1,050 left sitting as credit, and when May, June and July were
 * generated later NOTHING attached that credit to them. Their balance said paid; the grid said
 * unpaid. That is the "it only ticks some of the months" bug.
 *
 * Allocation is a DERIVED mapping, not a money movement, so the honest fix is to recompute it from
 * scratch whenever the inputs change (an invoice is raised, a charge lands, an invoice is voided)
 * rather than to patch it incrementally. Payments themselves are never touched — §9's immutability
 * is about the payment rows, and those are read-only here.
 *
 * The rule is the same one used everywhere else: oldest-due-first. That is what makes a one-off
 * charge behave the way an office expects — adding it to an earlier invoice pulls money back off a
 * later month automatically, and that month correctly reverts to unpaid so it gets chased.
 *
 * THE ONE EXCEPTION IS AN INSTRUCTION (0.43.0). When a parent picked lines to pay — "this $50 is the
 * book fee" at the kiosk, on the donation site or in the portal — that choice is stored on the payment
 * and honored here BEFORE the oldest-first sweep. It has to happen here rather than at the moment of
 * payment, because this function runs again every time a bill changes: an instruction applied once
 * would be quietly undone by the next invoice, and the line the parent deliberately paid would go back
 * to reading as outstanding on their next statement.
 *
 * Money is attached per LINE, not per invoice, so a bill made of tuition plus a book fee can honestly
 * say which of the two is settled. `payment_allocations.invoice_id` is still set on every row, so
 * everything that reads an invoice's total paid is unaffected.
 *
 * REVERSALS ARE LEFT ALONE. A reversed payment and its mirror both keep their allocations, which
 * sum to zero on the invoice, so they neither hold money down nor get handed out again.
 *
 * Returns the number of cents now attached to invoices.
 */
export function reallocateStudent(tx: Tx, studentId: string): number {
  const all = tx.select({ id: payments.id, amountCents: payments.amountCents, reversalOf: payments.reversalOf, occurredAt: payments.occurredAt, createdAt: payments.createdAt, directed: payments.directed }).from(payments).where(eq(payments.studentId, studentId)).all();
  const reversed = new Set(all.map((p) => p.reversalOf).filter((x): x is string => !!x));
  /** Live money: not a reversal row, and not itself reversed. */
  const live = all
    .filter((p) => !p.reversalOf && !reversed.has(p.id) && p.amountCents > 0)
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime());
  const liveIds = new Set(live.map((p) => p.id));

  const touched = new Set<string>();
  // Clear the mapping for live payments only, remembering which invoices that affects so their
  // status is re-derived even if nothing is re-attached to them.
  //
  // SCOPED TO THIS STUDENT'S PAYMENTS IN SQL, not filtered afterwards. This used to read the whole
  // `payment_allocations` table and drop everything that wasn't in `liveIds` in JS — correct, but it
  // made the cost of one payment proportional to every allocation the install has ever written, and
  // `generatePeriod` calls this once PER STUDENT. A 200-child madrasa a few years in was reading
  // millions of rows per nightly run, on a Raspberry Pi, to keep a few dozen. The predicate hits
  // `payment_allocations_payment_idx`; the rows selected are exactly the ones the JS filter kept.
  const liveIdList = [...liveIds];
  const existing = liveIdList.length
    ? tx
        .select({ id: paymentAllocations.id, invoiceId: paymentAllocations.invoiceId })
        .from(paymentAllocations)
        .where(inArray(paymentAllocations.paymentId, liveIdList))
        .all()
    : []; // no live payments → nothing of ours is attached (don't ask SQLite for `IN ()`)
  for (const a of existing) {
    touched.add(a.invoiceId);
    tx.delete(paymentAllocations).where(eq(paymentAllocations.id, a.id)).run();
  }

  const open = tx
    .select({ id: invoices.id, status: invoices.status })
    .from(invoices)
    .where(eq(invoices.studentId, studentId))
    // NULL due dates last, exactly as recordPayment orders them (SQLite sorts NULL first).
    .orderBy(sql`${invoices.dueDate} is null`, asc(invoices.dueDate), asc(invoices.createdAt))
    .all();

  /** Every payable line of this student's live invoices, oldest bill first, with what it still needs.
   *  Built AFTER the live allocations are cleared, so `needs` counts only money that is staying put
   *  (a reversal pair) plus the reduction any credit line on the same invoice already applied. */
  const slots: { itemId: string; invoiceId: string; need: number }[] = [];
  for (const inv of open) {
    if (inv.status === 'void') continue;
    touched.add(inv.id);
    // The SAME order billing/lines.ts displays them in — if these two disagreed, the balance shown
    // against a line would not be the one the money actually landed on.
    const items = orderedItems(tx, inv.id);
    const kept = tx.select({ itemId: paymentAllocations.invoiceItemId, amountCents: paymentAllocations.amountCents }).from(paymentAllocations).where(eq(paymentAllocations.invoiceId, inv.id)).all();
    const named = new Map<string, number>();
    let pool = 0; // invoice-level money that names no line, plus the value of any credit lines
    for (const k of kept) {
      if (k.itemId) named.set(k.itemId, (named.get(k.itemId) ?? 0) + k.amountCents);
      else pool += k.amountCents;
    }
    for (const it of items) if (it.amountCents < 0) pool += -it.amountCents;
    if (pool < 0) pool = 0;
    for (const it of items) {
      if (it.amountCents <= 0) continue; // a credit line is a reduction, never something to pay
      let need = it.amountCents - Math.min(it.amountCents, Math.max(0, named.get(it.id) ?? 0));
      if (need > 0 && pool > 0) {
        const take = Math.min(need, pool);
        need -= take;
        pool -= take;
      }
      if (need > 0) slots.push({ itemId: it.id, invoiceId: inv.id, need });
    }
  }

  const ts = new Date();
  const left = live.map((p) => p.amountCents);
  let applied = 0;
  const put = (paymentIdx: number, slot: { itemId: string; invoiceId: string; need: number }, amount: number): void => {
    tx.insert(paymentAllocations).values({ id: rid('pal'), paymentId: live[paymentIdx].id, invoiceId: slot.invoiceId, invoiceItemId: slot.itemId, amountCents: amount, createdAt: ts }).run();
    slot.need -= amount;
    left[paymentIdx] -= amount;
    applied += amount;
    touched.add(slot.invoiceId);
  };

  // Pass 1 — the payer's instructions. A line named by a payment that no longer needs the money (it
  // was covered another way, or its invoice was voided) is simply skipped, and that money falls
  // through to the sweep below rather than being stranded.
  const byItem = new Map(slots.map((s) => [s.itemId, s]));
  live.forEach((p, i) => {
    for (const d of p.directed ?? []) {
      const slot = byItem.get(d.itemId);
      if (!slot || slot.need <= 0 || left[i] <= 0) continue;
      put(i, slot, Math.min(d.amountCents, slot.need, left[i]));
    }
  });

  // Pass 2 — the house rule for everything not spoken for: oldest bill first, line by line.
  let p = 0;
  for (const slot of slots) {
    while (slot.need > 0 && p < live.length) {
      if (left[p] <= 0) {
        p++;
        continue;
      }
      put(p, slot, Math.min(slot.need, left[p]));
    }
  }

  for (const id of touched) refreshStatus(tx, id);
  return applied;
}

/** One student's share of a split payment. */
export interface SplitShare {
  studentId: string;
  amountCents: number;
  /** Lines of THIS child's bills the payer chose to settle, when they chose (0.43.0). */
  directed?: DirectedLine[];
}

/**
 * Turn "this family paid £X" into a per-student split — THE shared primitive for every path where a
 * parent pays once for several children: portal pay-now, a kiosk/donation charge that only names a
 * family, autopay, and reconciliation replaying a lost webhook.
 *
 * It walks the family's open invoices oldest-due-first (the same order `recordPayment` allocates in)
 * and assigns each invoice's outstanding balance to that invoice's student until the money runs out.
 * Because the order is deterministic, every one of those paths produces the SAME split for the same
 * inputs — which is what lets reconciliation reproduce a charge it never saw recorded.
 *
 * Any remainder once every invoice is covered is credit, and credit has to sit on some child: it goes
 * to `preferStudentId` when the caller knows who was being paid for (the kiosk's matched student),
 * otherwise to the family's first child by name. Deterministic either way, and the office can move it
 * by recording a correction — never silently spread around.
 */
export function splitAcrossFamily(familyId: string, amountCents: number, preferStudentId?: string | null): SplitShare[] {
  if (amountCents <= 0) return [];
  const kids = familyStudentIds(familyId);
  if (!kids.length) return [];

  const open = db
    .select({ id: invoices.id, studentId: invoices.studentId, status: invoices.status })
    .from(invoices)
    .where(inArray(invoices.studentId, kids))
    .orderBy(sql`${invoices.dueDate} is null`, asc(invoices.dueDate), asc(invoices.createdAt))
    .all();

  const byStudent = new Map<string, number>();
  let remaining = amountCents;
  for (const inv of open) {
    if (remaining <= 0) break;
    if (inv.status === 'void') continue;
    const bal = invoiceTotal(db, inv.id) - invoicePaid(db, inv.id);
    if (bal <= 0) continue;
    const amt = Math.min(remaining, bal);
    byStudent.set(inv.studentId, (byStudent.get(inv.studentId) ?? 0) + amt);
    remaining -= amt;
  }

  if (remaining > 0) {
    // Overpayment → credit on one child. Prefer whoever the payment was made for.
    const target = preferStudentId && kids.includes(preferStudentId) ? preferStudentId : firstChildByName(familyId) ?? kids[0];
    byStudent.set(target, (byStudent.get(target) ?? 0) + remaining);
  }
  return [...byStudent].map(([studentId, amt]) => ({ studentId, amountCents: amt }));
}

/** A family's first child by first name — the documented tie-break for where stray credit lands. */
function firstChildByName(familyId: string): string | undefined {
  return db.select({ id: students.id }).from(students).where(eq(students.familyId, familyId)).orderBy(asc(students.fullName)).all()[0]?.id;
}

export interface SplitResult {
  /** Per-student results, in the order given. */
  parts: { studentId: string; paymentId: string; duplicate: boolean; allocatedCents: number; creditCents: number }[];
  /** True only when EVERY part was already recorded — i.e. the whole charge is a replay. */
  duplicate: boolean;
}

/**
 * The parts of a split charge already recorded under `key` — i.e. "have we seen this charge before?".
 *
 * Every caller that DERIVES a split (rather than being handed one) must ask this FIRST, because
 * deriving is not idempotent: `splitAcrossFamily` reads the invoices the first attempt already paid
 * down, so re-deriving after a successful call yields a different, smaller split whose per-student
 * keys are new — and the money would be recorded twice. Asking here turns a replay into a no-op.
 *
 * Prefix-matched with substr rather than `LIKE key || ':%'` on purpose: `_` is a LIKE wildcard and
 * Stripe ids are full of them (`pi_3Pabc…`), so LIKE would need an ESCAPE clause to even be correct.
 */
export function recordedSplit(key: string): { studentId: string; paymentId: string; amountCents: number }[] {
  return db
    .select({ studentId: payments.studentId, paymentId: payments.id, amountCents: payments.amountCents })
    .from(payments)
    .where(sql`${payments.idempotencyKey} = ${key} OR substr(${payments.idempotencyKey}, 1, ${key.length + 1}) = ${`${key}:`}`)
    .all();
}

/**
 * Record one real charge that covers several children — the "pay for all my kids" case at the kiosk,
 * on the donation site, or in the portal.
 *
 * Payments are per student, so this fans out into one row per child, each with the shared
 * `idempotencyKey` suffixed by that child's id. Two things fall out of that suffix: a replay of the
 * whole charge is a no-op per child, and a partially-recorded charge (the process died halfway, or a
 * consumer retried after a timeout) completes rather than duplicating — the children already written
 * come back as duplicates and the rest get written.
 *
 * NOT one transaction across children on purpose: `recordPayment` opens its own, and a per-child key
 * means a crash between children is recoverable by simply calling again with the same key.
 */
export function recordSplit(
  base: Omit<RecordInput, 'studentId' | 'amountCents' | 'directed'>,
  shares: SplitShare[],
  actor: Actor,
): SplitResult {
  const parts = shares
    .filter((s) => s.amountCents > 0)
    .map((s) => {
      const r = recordPayment({ ...base, studentId: s.studentId, amountCents: s.amountCents, directed: s.directed ?? null, idempotencyKey: `${base.idempotencyKey}:${s.studentId}` }, actor);
      return { studentId: s.studentId, ...r };
    });
  return { parts, duplicate: parts.length > 0 && parts.every((p) => p.duplicate) };
}

/** Reverse a payment: a negative payment + negative allocations mirroring the original, so
 *  per-invoice paid nets to zero. Immutable — never edits/deletes the original (§9). */
export function reversePayment(paymentId: string, actor: Actor): { reversalId: string } {
  const orig = db.select().from(payments).where(eq(payments.id, paymentId)).get();
  if (!orig) throw new Error('payment not found');
  if (orig.reversalOf) throw new Error('cannot reverse a reversal');
  const already = db.select({ id: payments.id }).from(payments).where(eq(payments.reversalOf, paymentId)).get();
  if (already) return { reversalId: already.id };

  const ts = new Date();
  const reversalId = rid('pay');
  db.transaction((tx) => {
    tx.insert(payments).values({ id: reversalId, studentId: orig.studentId, amountCents: -orig.amountCents, channel: orig.channel, occurredAt: ts, memo: `Reversal of ${orig.id}`, idempotencyKey: `reversal:${orig.id}`, externalRef: null, directed: null, reversalOf: orig.id, recordedByUserId: actor.userId, recordedByName: actor.name, createdAt: ts }).run();
    for (const a of tx.select().from(paymentAllocations).where(eq(paymentAllocations.paymentId, orig.id)).all()) {
      // Mirrored line for line, so the pair nets to zero on the LINE as well as on the invoice —
      // otherwise reversing a directed payment would leave that line reading as settled.
      tx.insert(paymentAllocations).values({ id: rid('pal'), paymentId: reversalId, invoiceId: a.invoiceId, invoiceItemId: a.invoiceItemId, amountCents: -a.amountCents, createdAt: ts }).run();
      refreshStatus(tx, a.invoiceId);
    }
    // The reversed pair nets to zero on the invoices it touched, re-opening them. Any OTHER money
    // the student has should now shuffle forward to cover the oldest of those — otherwise reversing
    // an old payment leaves a newer month ticked while the month before it sits unpaid.
    reallocateStudent(tx, orig.studentId);
  });
  return { reversalId };
}
