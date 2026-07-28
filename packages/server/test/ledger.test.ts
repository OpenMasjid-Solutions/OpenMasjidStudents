// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The ledger/allocation engine (CLAUDE.md §16 test matrix): exact pay, partial, overpay→credit,
 * multi-invoice oldest-due-first, replayed idempotency key, reversal, and each channel. Money is
 * integer cents; balances are derived; payments immutable (reversals only).
 *
 * PER STUDENT since 0.39.0, so the matrix runs against one child and there are two extra things to
 * pin down: money recorded for one child must never move another child's balance, and one real card
 * charge covering several children must fan out into one row each (`recordSplit`) using the same
 * deterministic oldest-due-first split every payment path shares (`splitAcrossFamily`).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshApp } from './harness';
import { invoices, invoiceItems, payments, paymentAllocations, families, students } from '../src/db/schema';
import type { PaymentChannel } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let ledger: typeof import('../src/billing/ledger');
const ACTOR = { userId: 'usr_admin', role: 'admin', name: 'Admin' };
const D = (iso: string) => new Date(iso);

beforeAll(async () => {
  app = await freshApp();
  ledger = await import('../src/billing/ledger');
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, invoiceItems, invoices, students, families]) db.delete(t).run();
});

const FAM = 'fam_1';

/** A family with one child. */
function mkFamily(kids: string[] = ['stu_1']) {
  const { db } = app.dbmod;
  const ts = new Date();
  db.insert(families).values({ id: FAM, name: 'Fam', status: 'active', createdAt: ts, updatedAt: ts }).run();
  kids.forEach((id, i) => {
    db.insert(students).values({ id, familyId: FAM, fullName: `Kid${i} X`, status: 'active', studentCode: `KID${1000 + i}`, createdAt: ts, updatedAt: ts }).run();
  });
  return kids;
}

function mkInvoice(studentId: string, amountCents: number, due: string | null, periodKey: string, createdOffsetMs = 0) {
  const { db } = app.dbmod;
  const ts = new Date(Date.now() + createdOffsetMs);
  const invId = `inv_${periodKey}`;
  db.insert(invoices).values({ id: invId, studentId, label: `Invoice ${periodKey}`, periodKey, dueDate: due, status: 'open', createdAt: ts, updatedAt: ts }).run();
  db.insert(invoiceItems).values({ id: `it_${periodKey}`, invoiceId: invId, description: 'Tuition', amountCents, studentId, createdAt: ts }).run();
  return invId;
}

/** One child with one invoice, due on `due`. */
function studentWithInvoice(amountCents: number, due: string, periodKey = 'p1') {
  const [studentId] = mkFamily();
  return { studentId, invId: mkInvoice(studentId, amountCents, due, periodKey) };
}

const invStatus = (id: string) => app.dbmod.db.select().from(invoices).where(eq(invoices.id, id)).get()?.status;

describe('allocation + balance', () => {
  it('exact payment marks the invoice paid; balance zero', () => {
    const { studentId, invId } = studentWithInvoice(15000, '2026-07-01');
    const r = ledger.recordPayment({ studentId, amountCents: 15000, channel: 'cash', occurredAt: D('2026-07-05'), idempotencyKey: 'k1' }, ACTOR);
    expect(r).toMatchObject({ duplicate: false, allocatedCents: 15000, creditCents: 0 });
    expect(invStatus(invId)).toBe('paid');
    expect(ledger.studentBalance(studentId).balanceCents).toBe(0);
  });

  it('partial payment leaves partially_paid + remaining balance', () => {
    const { studentId, invId } = studentWithInvoice(15000, '2026-07-01');
    ledger.recordPayment({ studentId, amountCents: 6000, channel: 'zelle', occurredAt: D('2026-07-05'), idempotencyKey: 'k1' }, ACTOR);
    expect(invStatus(invId)).toBe('partially_paid');
    expect(ledger.studentBalance(studentId).owedCents).toBe(9000);
  });

  /** The behaviour Hasan asked for by name: cash sits in the child's balance and their next bill eats
   *  it. Nothing is stored — it falls out of `invoiced − paid`, so it cannot go stale. */
  it('overpayment becomes that STUDENT’s credit, and their next invoice absorbs it', () => {
    const { studentId, invId } = studentWithInvoice(10000, '2026-07-01');
    const r = ledger.recordPayment({ studentId, amountCents: 13000, channel: 'cash', occurredAt: D('2026-07-05'), idempotencyKey: 'k1' }, ACTOR);
    expect(r.allocatedCents).toBe(10000);
    expect(r.creditCents).toBe(3000);
    expect(invStatus(invId)).toBe('paid');
    const bal = ledger.studentBalance(studentId);
    expect(bal.balanceCents).toBe(-3000);
    expect(bal.creditCents).toBe(3000);

    // Next month's bill arrives: the credit covers 3000 of it with no further action.
    mkInvoice(studentId, 10000, '2026-08-01', 'aug');
    expect(ledger.studentBalance(studentId).owedCents).toBe(7000);
  });

  it('multi-invoice payment allocates oldest-due-first', () => {
    const { studentId } = studentWithInvoice(5000, '2026-08-01', 'aug'); // later due
    mkInvoice(studentId, 5000, '2026-07-01', 'jul'); // earlier due
    // Pay 7000 → fully covers Jul (5000) then 2000 of Aug.
    ledger.recordPayment({ studentId, amountCents: 7000, channel: 'check', occurredAt: D('2026-07-10'), idempotencyKey: 'k1' }, ACTOR);
    expect(invStatus('inv_jul')).toBe('paid');
    expect(invStatus('inv_aug')).toBe('partially_paid');
    expect(ledger.studentBalance(studentId).owedCents).toBe(3000);
  });

  it('a replayed idempotency key returns the original, records nothing new', () => {
    const { studentId } = studentWithInvoice(10000, '2026-07-01');
    const first = ledger.recordPayment({ studentId, amountCents: 10000, channel: 'cash', occurredAt: D('2026-07-05'), idempotencyKey: 'dupe' }, ACTOR);
    const replay = ledger.recordPayment({ studentId, amountCents: 10000, channel: 'cash', occurredAt: D('2026-07-05'), idempotencyKey: 'dupe' }, ACTOR);
    expect(replay.duplicate).toBe(true);
    expect(replay.paymentId).toBe(first.paymentId);
    expect(app.dbmod.db.select().from(payments).all()).toHaveLength(1);
  });

  it('reversal nets the payment out (invoice back to open, balance restored)', () => {
    const { studentId, invId } = studentWithInvoice(10000, '2026-07-01');
    const p = ledger.recordPayment({ studentId, amountCents: 10000, channel: 'cash', occurredAt: D('2026-07-05'), idempotencyKey: 'k1' }, ACTOR);
    expect(invStatus(invId)).toBe('paid');
    ledger.reversePayment(p.paymentId, ACTOR);
    expect(invStatus(invId)).toBe('open');
    expect(ledger.studentBalance(studentId).owedCents).toBe(10000);
    // Original payment row is untouched; a negative reversal row was added.
    expect(app.dbmod.db.select().from(payments).all()).toHaveLength(2);
    // Reversing a reversal is refused.
    expect(() => ledger.reversePayment(app.dbmod.db.select().from(payments).all().find((x) => x.reversalOf)!.id, ACTOR)).toThrow();
  });

  it('records every channel', () => {
    const { studentId } = studentWithInvoice(100000, '2026-07-01');
    const channels: PaymentChannel[] = ['cash', 'zelle', 'check', 'other', 'donations-web', 'kiosk', 'portal', 'autopay'];
    channels.forEach((c, i) => ledger.recordPayment({ studentId, amountCents: 1000, channel: c, occurredAt: D('2026-07-05'), idempotencyKey: `k-${c}-${i}` }, ACTOR));
    expect(app.dbmod.db.select().from(payments).all()).toHaveLength(channels.length);
    expect(ledger.studentBalance(studentId).paidCents).toBe(channels.length * 1000);
  });

  it('a voided invoice drops out of the balance', () => {
    const { studentId, invId } = studentWithInvoice(10000, '2026-07-01');
    expect(ledger.studentBalance(studentId).owedCents).toBe(10000);
    app.dbmod.db.update(invoices).set({ status: 'void' }).where(eq(invoices.id, invId)).run();
    expect(ledger.studentBalance(studentId).owedCents).toBe(0);
  });

  it('auto-allocation pays the dated invoice before an undated one (NULL due sorts last)', () => {
    // Oldest-due-first must settle the DATED one first — SQLite would otherwise sort NULL ahead of
    // every date. The undated invoice is created LATER so createdAt can't be the accidental tiebreak.
    const [studentId] = mkFamily();
    const dated = mkInvoice(studentId, 5000, '2026-07-01', 'dated');
    mkInvoice(studentId, 5000, null, 'undated', 1000);
    ledger.recordPayment({ studentId, amountCents: 5000, channel: 'cash', occurredAt: D('2026-07-05'), idempotencyKey: 'k1' }, ACTOR);
    expect(invStatus(dated)).toBe('paid');
    expect(invStatus('inv_undated')).toBe('open');
  });

  it('rejects an explicit allocation that exceeds the invoice balance', () => {
    const { studentId, invId } = studentWithInvoice(5000, '2026-07-01');
    expect(() => ledger.recordPayment({ studentId, amountCents: 8000, channel: 'donations-web', occurredAt: D('2026-07-05'), idempotencyKey: 'k1', allocations: [{ invoiceId: invId, amountCents: 8000 }] }, ACTOR)).toThrow('invalid_allocation');
    // Nothing was written — the transaction rolled back.
    expect(app.dbmod.db.select().from(payments).all()).toHaveLength(0);
  });

  it('rejects explicit allocations summing beyond the payment amount', () => {
    const { studentId } = studentWithInvoice(5000, '2026-07-01', 'a');
    mkInvoice(studentId, 5000, '2026-08-01', 'b');
    expect(() => ledger.recordPayment({ studentId, amountCents: 6000, channel: 'kiosk', occurredAt: D('2026-07-05'), idempotencyKey: 'k1', allocations: [{ invoiceId: 'inv_a', amountCents: 5000 }, { invoiceId: 'inv_b', amountCents: 5000 }] }, ACTOR)).toThrow('invalid_allocation');
    expect(app.dbmod.db.select().from(payments).all()).toHaveLength(0);
  });

  it('rejects an explicit allocation against a voided invoice', () => {
    const { studentId, invId } = studentWithInvoice(5000, '2026-07-01');
    app.dbmod.db.update(invoices).set({ status: 'void' }).where(eq(invoices.id, invId)).run();
    expect(() => ledger.recordPayment({ studentId, amountCents: 5000, channel: 'portal', occurredAt: D('2026-07-05'), idempotencyKey: 'k1', allocations: [{ invoiceId: invId, amountCents: 5000 }] }, ACTOR)).toThrow('invalid_allocation');
  });

  /** The wall between siblings. An explicit allocation naming another child's invoice must be refused
   *  outright — otherwise a consumer bug could quietly settle the wrong child's bill. */
  it('refuses to allocate one child’s payment to a SIBLING’s invoice', () => {
    const [a, b] = mkFamily(['stu_1', 'stu_2']);
    mkInvoice(a, 5000, '2026-07-01', 'a');
    const bInv = mkInvoice(b, 5000, '2026-07-01', 'b');
    expect(() => ledger.recordPayment({ studentId: a, amountCents: 5000, channel: 'cash', occurredAt: D('2026-07-05'), idempotencyKey: 'k1', allocations: [{ invoiceId: bInv, amountCents: 5000 }] }, ACTOR)).toThrow('invalid_allocation');
    expect(app.dbmod.db.select().from(payments).all()).toHaveLength(0);
  });

  it('auto-allocation never touches a sibling’s invoice', () => {
    const [a, b] = mkFamily(['stu_1', 'stu_2']);
    const aInv = mkInvoice(a, 5000, '2026-07-01', 'a');
    const bInv = mkInvoice(b, 5000, '2026-06-01', 'b'); // OLDER than a's — must still be untouched
    ledger.recordPayment({ studentId: a, amountCents: 5000, channel: 'cash', occurredAt: D('2026-07-05'), idempotencyKey: 'k1' }, ACTOR);
    expect(invStatus(aInv)).toBe('paid');
    expect(invStatus(bInv)).toBe('open');
    expect(ledger.studentBalance(b).owedCents).toBe(5000);
  });
});

describe('familyBalance sums the children', () => {
  it('adds up each child, and a withdrawn child’s debt still counts', () => {
    const [a, b] = mkFamily(['stu_1', 'stu_2']);
    mkInvoice(a, 5000, '2026-07-01', 'a');
    mkInvoice(b, 3000, '2026-07-01', 'b');
    expect(ledger.familyBalance(FAM).owedCents).toBe(8000);
    // Withdrawing a child does not forgive their bill.
    app.dbmod.db.update(students).set({ status: 'withdrawn' }).where(eq(students.id, b)).run();
    expect(ledger.familyBalance(FAM).owedCents).toBe(8000);
  });

  it('nets one child’s credit against a sibling’s debt in the household view', () => {
    const [a, b] = mkFamily(['stu_1', 'stu_2']);
    mkInvoice(a, 5000, '2026-07-01', 'a');
    ledger.recordPayment({ studentId: b, amountCents: 2000, channel: 'cash', occurredAt: D('2026-07-05'), idempotencyKey: 'k1' }, ACTOR);
    // The household is 5000 owed less 2000 already in hand…
    expect(ledger.familyBalance(FAM).owedCents).toBe(3000);
    // …but the money is still sitting on the child it was paid for, not silently moved.
    expect(ledger.studentBalance(a).owedCents).toBe(5000);
    expect(ledger.studentBalance(b).creditCents).toBe(2000);
  });
});

describe('splitAcrossFamily — one payment, several children', () => {
  it('walks open invoices oldest-due-first across the whole household', () => {
    const [a, b] = mkFamily(['stu_1', 'stu_2']);
    mkInvoice(a, 5000, '2026-08-01', 'a-aug');
    mkInvoice(b, 3000, '2026-07-01', 'b-jul'); // oldest → paid first
    // 6000 covers b's 3000 in full, then 3000 of a's 5000.
    const shares = ledger.splitAcrossFamily(FAM, 6000);
    expect(shares.find((s) => s.studentId === b)?.amountCents).toBe(3000);
    expect(shares.find((s) => s.studentId === a)?.amountCents).toBe(3000);
    expect(shares.reduce((s, x) => s + x.amountCents, 0)).toBe(6000);
  });

  it('always sums to the amount, parking any overpayment on one named child', () => {
    const [a, b] = mkFamily(['stu_1', 'stu_2']);
    mkInvoice(a, 1000, '2026-07-01', 'a');
    // 5000 against 1000 of debt: 4000 has nowhere to go but a child's credit.
    const shares = ledger.splitAcrossFamily(FAM, 5000, b);
    expect(shares.reduce((s, x) => s + x.amountCents, 0)).toBe(5000);
    expect(shares.find((s) => s.studentId === b)?.amountCents).toBe(4000);
  });

  it('with no invoices at all it still attributes the whole amount', () => {
    const [a] = mkFamily(['stu_1', 'stu_2']);
    const shares = ledger.splitAcrossFamily(FAM, 2500);
    expect(shares).toHaveLength(1);
    expect(shares[0].amountCents).toBe(2500);
    expect(shares[0].studentId).toBe(a); // first child by name — the documented tie-break
  });
});

describe('recordSplit — one card charge, one row per child', () => {
  it('writes a row per child and each lands in that child’s own balance', () => {
    const [a, b] = mkFamily(['stu_1', 'stu_2']);
    mkInvoice(a, 5000, '2026-07-01', 'a');
    mkInvoice(b, 3000, '2026-07-01', 'b');
    const res = ledger.recordSplit(
      { channel: 'portal', occurredAt: D('2026-07-05'), idempotencyKey: 'pi_123' },
      ledger.splitAcrossFamily(FAM, 8000),
      ACTOR,
    );
    expect(res.parts).toHaveLength(2);
    expect(res.duplicate).toBe(false);
    expect(ledger.studentBalance(a).owedCents).toBe(0);
    expect(ledger.studentBalance(b).owedCents).toBe(0);
    // Two ledger rows for one charge, each keyed per child so neither can replay the other.
    const keys = app.dbmod.db.select().from(payments).all().map((p) => p.idempotencyKey).sort();
    expect(keys).toEqual([`pi_123:${a}`, `pi_123:${b}`].sort());
  });

  it('a replay of the whole charge is a no-op', () => {
    const [a, b] = mkFamily(['stu_1', 'stu_2']);
    mkInvoice(a, 5000, '2026-07-01', 'a');
    mkInvoice(b, 3000, '2026-07-01', 'b');
    const shares = ledger.splitAcrossFamily(FAM, 8000);
    ledger.recordSplit({ channel: 'kiosk', occurredAt: D('2026-07-05'), idempotencyKey: 'pi_x' }, shares, ACTOR);
    const again = ledger.recordSplit({ channel: 'kiosk', occurredAt: D('2026-07-05'), idempotencyKey: 'pi_x' }, shares, ACTOR);
    expect(again.duplicate).toBe(true);
    expect(app.dbmod.db.select().from(payments).all()).toHaveLength(2);
  });

  /** The crash-in-the-middle case. A per-child key means the children already written come back as
   *  duplicates and the rest get written — the charge completes instead of double-charging. */
  it('completes a half-written charge rather than duplicating it', () => {
    const [a, b] = mkFamily(['stu_1', 'stu_2']);
    mkInvoice(a, 5000, '2026-07-01', 'a');
    mkInvoice(b, 3000, '2026-07-01', 'b');
    // Simulate the first child having landed before the process died.
    ledger.recordPayment({ studentId: a, amountCents: 5000, channel: 'kiosk', occurredAt: D('2026-07-05'), idempotencyKey: 'pi_half:' + a }, ACTOR);
    const res = ledger.recordSplit({ channel: 'kiosk', occurredAt: D('2026-07-05'), idempotencyKey: 'pi_half' }, [{ studentId: a, amountCents: 5000 }, { studentId: b, amountCents: 3000 }], ACTOR);
    expect(res.duplicate).toBe(false); // not wholly a replay
    expect(res.parts.find((p) => p.studentId === a)?.duplicate).toBe(true);
    expect(res.parts.find((p) => p.studentId === b)?.duplicate).toBe(false);
    expect(app.dbmod.db.select().from(payments).all()).toHaveLength(2); // NOT three
    expect(ledger.familyBalance(FAM).owedCents).toBe(0);
  });
});
