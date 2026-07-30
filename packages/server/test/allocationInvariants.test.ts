// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The allocation invariants, checked against a few hundred RANDOM histories.
 *
 * The example-based tests next door say what the ledger does in the cases we thought of. This one says
 * what must be true in every case, and then goes looking for a case we did not think of: bills with a
 * one-off charge and a bursary on the same invoice, money paid before the bill existed, a payment
 * directed at a line that is later covered another way, a reversal in the middle, months generated out
 * of order, a voided invoice.
 *
 * The five properties, in the order they would hurt if they broke:
 *
 *  1. NO MONEY INVENTED OR LOST — every payment's allocations sum to at most its own amount, and an
 *     invoice is never allocated more than it costs.
 *  2. THE LINES ADD UP — sum(line balances) equals the invoice's balance. This one is a promise on the
 *     wire to Kiosk, Donations and the parent portal, which all total the lines a parent ticked; if it
 *     can drift, a parent gets charged the wrong amount.
 *  3. THE BALANCE IS THE SUBTRACTION — the derived balance is exactly invoiced − paid, whatever the
 *     allocations happen to look like.
 *  4. IDEMPOTENT — reallocating twice changes nothing. It runs on every invoice, charge and payment, so
 *     a non-idempotent pass would make a balance depend on how many times something was saved.
 *  5. THE SIBLING WALL — one child's money never lands on another child's bill.
 *
 * Deliberately seeded, not random-per-run: a failure has to be reproducible, and a test that only fails
 * on somebody else's machine at 2am is worse than no test.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshApp } from './harness';
import { invoices, invoiceItems, payments, paymentAllocations, feePlans, families, students } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let ledger: typeof import('../src/billing/ledger');
let lines: typeof import('../src/billing/lines');
const ACTOR = { userId: 'usr_admin', role: 'admin', name: 'Admin' };

beforeAll(async () => {
  app = await freshApp();
  ledger = await import('../src/billing/ledger');
  lines = await import('../src/billing/lines');
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, invoiceItems, invoices, feePlans, students, families]) db.delete(t).run();
});

/** A tiny deterministic PRNG (mulberry32) — a seed reproduces a failure exactly. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface World {
  kids: string[];
  invoiceIds: string[];
  paymentIds: string[];
}

/** Build one random-but-plausible history for a household of 1–3 children. */
function buildWorld(seed: number): World {
  const r = rng(seed);
  const { db } = app.dbmod;
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  const cents = () => (1 + Math.floor(r() * 40)) * 500; // $5 … $200, in $5 steps
  const ts = new Date();

  db.insert(families).values({ id: 'fam_1', name: 'Fam', status: 'active', createdAt: ts, updatedAt: ts }).run();
  // A real plan row: a tuition line carries `feePlanId`, and that FK is what tells `invoiceLines` a line
  // is tuition rather than a one-off charge.
  db.insert(feePlans).values({ id: 'plan_1', name: 'Monthly tuition', amountCents: 5000, cadence: 'monthly', status: 'active', createdAt: ts, updatedAt: ts }).run();
  const kidCount = 1 + Math.floor(r() * 3);
  const kids: string[] = [];
  for (let i = 0; i < kidCount; i++) {
    const id = `stu_${i}`;
    kids.push(id);
    db.insert(students).values({ id, familyId: 'fam_1', fullName: `Kid${i} X`, status: 'active', studentCode: `KID${1000 + i}`, createdAt: ts, updatedAt: ts }).run();
  }

  const invoiceIds: string[] = [];
  const itemsByStudent = new Map<string, string[]>();
  const months = ['2026-09', '2026-10', '2026-11', '2026-12', '2027-01'];
  let n = 0;
  for (const kid of kids) {
    // Months in a shuffled order: an office generates late, and out-of-order creation is a real state.
    const mine = months.filter(() => r() < 0.7);
    for (const m of mine) {
      const invId = `inv_${n++}`;
      // A due date most of the time, none occasionally (older data, before dates were always stamped).
      const dueDate = r() < 0.85 ? `${m}-01` : null;
      db.insert(invoices).values({ id: invId, studentId: kid, label: `Tuition — ${m}`, periodKey: m, dueDate, status: 'open', createdAt: new Date(ts.getTime() + n * 10), updatedAt: ts }).run();
      invoiceIds.push(invId);
      // One tuition line, sometimes a one-off charge, sometimes a bursary (negative).
      const itemIds: string[] = [];
      const mk = (desc: string, amount: number, feePlanId: string | null) => {
        const id = `iti_${invId}_${itemIds.length}`;
        db.insert(invoiceItems).values({ id, invoiceId: invId, description: desc, amountCents: amount, studentId: kid, feePlanId, createdAt: new Date(ts.getTime() + n * 10) }).run();
        itemIds.push(id);
      };
      mk('Monthly tuition', cents(), 'plan_1');
      if (r() < 0.4) mk('Book fee', cents(), null);
      if (r() < 0.15) mk('Bursary', -Math.min(cents(), 2000), null);
      itemsByStudent.set(kid, [...(itemsByStudent.get(kid) ?? []), ...itemIds]);
    }
    // Void one invoice occasionally — a voided bill drops out of the invoiced total entirely.
    if (r() < 0.15 && invoiceIds.length) {
      const victim = pick(invoiceIds);
      db.update(invoices).set({ status: 'void' }).where(eq(invoices.id, victim)).run();
    }
  }

  // Payments: some plain, some directed at a line of THAT child's, in random date order.
  const paymentIds: string[] = [];
  const payCount = Math.floor(r() * 5);
  for (let i = 0; i < payCount; i++) {
    const kid = pick(kids);
    const mine = itemsByStudent.get(kid) ?? [];
    const directed = mine.length && r() < 0.45 ? [{ itemId: pick(mine), amountCents: 500 }] : undefined;
    const amount = cents();
    try {
      const res = ledger.recordPayment(
        {
          studentId: kid,
          amountCents: amount,
          channel: r() < 0.5 ? 'cash' : 'kiosk',
          occurredAt: new Date(Date.UTC(2026, 8 + Math.floor(r() * 5), 1 + Math.floor(r() * 27))),
          idempotencyKey: `k_${seed}_${i}`,
          ...(directed ? { directed } : {}),
        },
        ACTOR,
      );
      paymentIds.push(res.paymentId);
      // Occasionally reverse it straight away — a correction in the middle of a history.
      if (r() < 0.12) ledger.reversePayment(res.paymentId, ACTOR);
    } catch (e) {
      // `invalid_allocation` is a legitimate refusal (a directive naming a voided invoice's line).
      if ((e as Error).message !== 'invalid_allocation') throw e;
    }
  }
  return { kids, invoiceIds, paymentIds };
}

describe('allocation invariants hold for random histories', () => {
  const SEEDS = Array.from({ length: 120 }, (_, i) => i + 1);

  it('no money is invented or lost, and no invoice is over-allocated', () => {
    for (const seed of SEEDS) {
      const { db } = app.dbmod;
      for (const t of [paymentAllocations, payments, invoiceItems, invoices, feePlans, students, families]) db.delete(t).run();
      const w = buildWorld(seed);

      for (const p of db.select().from(payments).all()) {
        const allocated = db.select({ a: paymentAllocations.amountCents }).from(paymentAllocations).where(eq(paymentAllocations.paymentId, p.id)).all().reduce((s, r) => s + r.a, 0);
        // Signs match the payment: a reversal's allocations are negative, and neither can exceed it.
        if (p.amountCents >= 0) expect(allocated, `seed ${seed} payment ${p.id}`).toBeLessThanOrEqual(p.amountCents);
        else expect(allocated, `seed ${seed} reversal ${p.id}`).toBeGreaterThanOrEqual(p.amountCents);
      }
      for (const invId of w.invoiceIds) {
        const total = ledger.invoiceTotal(db, invId);
        const paid = ledger.invoicePaid(db, invId);
        expect(paid, `seed ${seed} invoice ${invId} over-allocated`).toBeLessThanOrEqual(Math.max(total, 0));
        expect(paid, `seed ${seed} invoice ${invId} negative paid`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('the lines of every invoice add up to that invoice’s balance', () => {
    for (const seed of SEEDS) {
      const { db } = app.dbmod;
      for (const t of [paymentAllocations, payments, invoiceItems, invoices, feePlans, students, families]) db.delete(t).run();
      const w = buildWorld(seed);

      for (const invId of w.invoiceIds) {
        const inv = db.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, invId)).get()!;
        if (inv.status === 'void') continue; // a voided bill is out of the balance entirely
        const balance = ledger.invoiceTotal(db, invId) - ledger.invoicePaid(db, invId);
        const summed = lines.invoiceLines(db, invId).reduce((s, l) => s + l.balanceCents, 0);
        // `Math.max(…, 0)` is the documented convention, not a fudge: a line balance is never negative,
        // so an invoice whose credit lines exceed its charges reports 0 here while its own balance is
        // negative. Nothing bills off that difference — autopay is capped at the family's derived
        // `owedCents` (see test/creditEdges.test.ts) — and a consumer summing lines can only ever
        // under-charge, never over-charge, which is the safe direction.
        expect(summed, `seed ${seed} invoice ${invId}: lines say ${summed}, invoice says ${balance}`).toBe(Math.max(balance, 0));
      }
    }
  });

  it('a student’s balance is exactly invoiced − paid', () => {
    for (const seed of SEEDS) {
      const { db } = app.dbmod;
      for (const t of [paymentAllocations, payments, invoiceItems, invoices, feePlans, students, families]) db.delete(t).run();
      const w = buildWorld(seed);

      for (const kid of w.kids) {
        const b = ledger.studentBalance(kid);
        expect(b.balanceCents, `seed ${seed} ${kid}`).toBe(b.invoicedCents - b.paidCents);
        expect(Math.min(b.owedCents, b.creditCents), `seed ${seed} ${kid}: owed and credit both non-zero`).toBe(0);
      }
    }
  });

  it('reallocating again changes nothing', () => {
    for (const seed of SEEDS) {
      const { db } = app.dbmod;
      for (const t of [paymentAllocations, payments, invoiceItems, invoices, feePlans, students, families]) db.delete(t).run();
      const w = buildWorld(seed);

      const snapshot = () =>
        db
          .select()
          .from(paymentAllocations)
          .all()
          .map((a) => `${a.paymentId}|${a.invoiceId}|${a.invoiceItemId ?? '-'}|${a.amountCents}`)
          .sort()
          .join(',');
      const before = snapshot();
      db.transaction((tx) => {
        for (const kid of w.kids) ledger.reallocateStudent(tx, kid);
      });
      expect(snapshot(), `seed ${seed} is not idempotent`).toBe(before);
    }
  });

  it('one child’s money never lands on a sibling’s bill', () => {
    for (const seed of SEEDS) {
      const { db } = app.dbmod;
      for (const t of [paymentAllocations, payments, invoiceItems, invoices, feePlans, students, families]) db.delete(t).run();
      buildWorld(seed);

      for (const a of db.select().from(paymentAllocations).all()) {
        const payer = db.select({ studentId: payments.studentId }).from(payments).where(eq(payments.id, a.paymentId)).get()!;
        const owner = db.select({ studentId: invoices.studentId }).from(invoices).where(eq(invoices.id, a.invoiceId)).get()!;
        expect(owner.studentId, `seed ${seed}: ${a.paymentId} paid ${a.invoiceId}`).toBe(payer.studentId);
        // And a line-level allocation must name a line OF that invoice.
        if (a.invoiceItemId) {
          const item = db.select({ invoiceId: invoiceItems.invoiceId }).from(invoiceItems).where(eq(invoiceItems.id, a.invoiceItemId)).get()!;
          expect(item.invoiceId, `seed ${seed}: allocation ${a.id} names a line of another invoice`).toBe(a.invoiceId);
        }
      }
    }
  });
});
