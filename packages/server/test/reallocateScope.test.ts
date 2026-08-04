// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * `reallocateStudent` must touch EXACTLY ONE student's allocation rows [OMS-004].
 *
 * The function clears a student's derived mapping and rebuilds it. It used to find the rows to clear
 * by reading the whole `payment_allocations` table and discarding non-matching rows in JavaScript,
 * which made the cost of every payment proportional to the size of the entire table — and
 * `generatePeriod` calls it once per student, so a nightly invoice run scaled as
 * students × all-allocations-ever.
 *
 * Scoping that read in SQL is only safe if it selects precisely the rows the JS filter kept, so these
 * tests pin the boundary rather than the query: another student's allocation rows must survive
 * byte-identically (same row ids — not merely the same totals, since a delete-and-rebuild would
 * produce equal sums with new ids and hide the bug), the target's must be rebuilt, and a student with
 * no live payments must be a no-op rather than a table-wide wipe. That last case is the one a wrong
 * empty-set predicate would break: SQLite has no `IN ()`, so the code must not ask for one.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshApp } from './harness';
import { invoices, invoiceItems, payments, paymentAllocations, families, students } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let ledger: typeof import('../src/billing/ledger');
const ACTOR = { userId: 'usr_admin', role: 'admin', name: 'Admin' };

beforeAll(async () => {
  app = await freshApp();
  ledger = await import('../src/billing/ledger');
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, invoiceItems, invoices, students, families]) db.delete(t).run();
});

/** Two unrelated households, one child each, one open invoice each. */
function twoHouseholds() {
  const { db } = app.dbmod;
  const ts = new Date();
  for (const [fam, stu, code] of [
    ['fam_a', 'stu_a', 'AAA1000'],
    ['fam_b', 'stu_b', 'BBB2000'],
  ]) {
    db.insert(families).values({ id: fam, name: `${fam} family`, status: 'active', createdAt: ts, updatedAt: ts }).run();
    db.insert(students).values({ id: stu, familyId: fam, fullName: `Child ${stu}`, status: 'active', studentCode: code, createdAt: ts, updatedAt: ts }).run();
    const invId = `inv_${stu}`;
    db.insert(invoices).values({ id: invId, studentId: stu, label: 'Tuition — Jul 2026', periodKey: '2026-07', dueDate: '2026-07-01', status: 'open', createdAt: ts, updatedAt: ts }).run();
    db.insert(invoiceItems).values({ id: `it_${stu}`, invoiceId: invId, description: 'Monthly tuition', amountCents: 20000, studentId: stu, createdAt: ts }).run();
  }
}

/** Every allocation row for one student's invoice, as stable tuples. */
const allocationsOf = (studentId: string) =>
  app.dbmod.db
    .select({ id: paymentAllocations.id, paymentId: paymentAllocations.paymentId, invoiceItemId: paymentAllocations.invoiceItemId, amountCents: paymentAllocations.amountCents })
    .from(paymentAllocations)
    .where(eq(paymentAllocations.invoiceId, `inv_${studentId}`))
    .all()
    .sort((x, y) => x.id.localeCompare(y.id));

describe('reallocateStudent is scoped to one student [OMS-004]', () => {
  it('leaves another student’s allocation rows byte-identical', () => {
    twoHouseholds();
    ledger.recordPayment({ studentId: 'stu_a', amountCents: 20000, channel: 'cash', occurredAt: new Date('2026-07-05'), idempotencyKey: 'k-a' }, ACTOR);
    ledger.recordPayment({ studentId: 'stu_b', amountCents: 20000, channel: 'cash', occurredAt: new Date('2026-07-06'), idempotencyKey: 'k-b' }, ACTOR);

    const bBefore = allocationsOf('stu_b');
    expect(bBefore).toHaveLength(1);

    app.dbmod.db.transaction((tx) => ledger.reallocateStudent(tx, 'stu_a'));

    // The SAME rows, not merely an equal total — a table-wide clear would rebuild B's with new ids.
    expect(allocationsOf('stu_b')).toEqual(bBefore);
    expect(app.dbmod.db.select().from(invoices).where(eq(invoices.id, 'inv_stu_b')).get()?.status).toBe('paid');
    expect(ledger.studentBalance('stu_b').balanceCents).toBe(0);
  });

  it('still rebuilds the target student’s own mapping', () => {
    twoHouseholds();
    ledger.recordPayment({ studentId: 'stu_a', amountCents: 20000, channel: 'cash', occurredAt: new Date('2026-07-05'), idempotencyKey: 'k-a' }, ACTOR);

    const before = allocationsOf('stu_a');
    expect(before).toHaveLength(1);

    app.dbmod.db.transaction((tx) => ledger.reallocateStudent(tx, 'stu_a'));

    const after = allocationsOf('stu_a');
    // Rebuilt: a fresh row id, but the same money on the same line, and the invoice still settled.
    expect(after).toHaveLength(1);
    expect(after[0].id).not.toBe(before[0].id);
    expect(after[0]).toMatchObject({ paymentId: before[0].paymentId, invoiceItemId: before[0].invoiceItemId, amountCents: 20000 });
    expect(ledger.studentBalance('stu_a').balanceCents).toBe(0);
  });

  it('is a no-op for a student with no payments, and wipes nothing', () => {
    twoHouseholds();
    ledger.recordPayment({ studentId: 'stu_b', amountCents: 20000, channel: 'cash', occurredAt: new Date('2026-07-06'), idempotencyKey: 'k-b' }, ACTOR);
    const bBefore = allocationsOf('stu_b');

    // stu_a has an invoice but has never paid: `liveIds` is empty. The predicate must not be built
    // as `IN ()`, and the absence of live payments must not be read as "clear everything".
    app.dbmod.db.transaction((tx) => expect(ledger.reallocateStudent(tx, 'stu_a')).toBe(0));

    expect(allocationsOf('stu_a')).toEqual([]);
    expect(allocationsOf('stu_b')).toEqual(bBefore);
    expect(ledger.studentBalance('stu_a').owedCents).toBe(20000);
    expect(ledger.studentBalance('stu_b').balanceCents).toBe(0);
  });

  it('does not disturb a reversal pair belonging to another student', () => {
    twoHouseholds();
    const paid = ledger.recordPayment({ studentId: 'stu_b', amountCents: 20000, channel: 'cash', occurredAt: new Date('2026-07-06'), idempotencyKey: 'k-b' }, ACTOR);
    ledger.reversePayment(paid.paymentId, ACTOR);

    // A reversed payment and its mirror both keep their allocations, summing to zero on the invoice.
    const bBefore = allocationsOf('stu_b');
    expect(bBefore).toHaveLength(2);
    expect(bBefore.reduce((s, r) => s + r.amountCents, 0)).toBe(0);

    ledger.recordPayment({ studentId: 'stu_a', amountCents: 20000, channel: 'cash', occurredAt: new Date('2026-07-07'), idempotencyKey: 'k-a' }, ACTOR);
    app.dbmod.db.transaction((tx) => ledger.reallocateStudent(tx, 'stu_a'));

    expect(allocationsOf('stu_b')).toEqual(bBefore);
    expect(ledger.studentBalance('stu_b').owedCents).toBe(20000); // reversal re-opened the bill
  });
});
