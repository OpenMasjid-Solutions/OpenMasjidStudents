// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * STANDING PAYMENTS (0.51.0-dev.15) — autopay for money that never touches Stripe.
 *
 * This feature RECORDS MONEY ON A SCHEDULE WITHOUT ANYBODY CONFIRMING IT ARRIVED. That was chosen
 * deliberately, and it puts every guard here on the critical path: a bug does not produce an error
 * message, it produces a ledger that says a family paid when they did not.
 *
 * The two rules that keep it from becoming a fiction, and the two ways it could quietly go wrong:
 *
 *  1. **The amount is what is OWED on the day, never a stored figure.** A stored amount recorded against
 *     a smaller bill would mint credit out of nothing — and credit is absorbed silently by the next
 *     invoice (§9), so it would compound for months with no screen ever showing it. Owing nothing must
 *     record nothing.
 *  2. **`payments.idempotency_key` is UNIQUE and is `standing:<student>:<period>`.** So a second run in
 *     the same month — a re-run, a restart, a catch-up on the 2nd — records nothing further. Relying on
 *     the `lastPeriod` marker instead would be the "trust a stored number" mistake §6 names.
 *
 * And the things that must NOT happen: a withdrawn child being charged, a sibling's arrears being paid off
 * by the wrong student, and a recorded payment being unreversible.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshApp, makeCtx } from './harness';
import {
  paymentAllocations, payments, charges, invoiceItems, invoices, studentFees, feePlans,
  students, families, standingPayments, schoolYears, terms, users, auditLog,
} from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let standing: typeof import('../src/billing/standingPayments');
const caller = (role: Role) => app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp();
  standing = await import('../src/billing/standingPayments');
});

beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, charges, invoiceItems, invoices, standingPayments, studentFees, feePlans, students, families, terms, schoolYears, users, auditLog]) db.delete(t).run();
});

/** A student on a $50 monthly plan, with September billed and due on the 1st. */
async function seed(opts: { day?: number; channel?: 'cash' | 'ach'; enabled?: boolean } = {}) {
  const admin = caller('admin');
  const fam = await admin.people.familyCreate({ name: 'Ismail' });
  const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
  const s = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });
  await admin.billing.generatePeriod({ periodKey: '2026-09', label: 'Sep 2026', dueDate: '2026-09-01' });
  await admin.billing.standingSet({
    studentId: s.id,
    enabled: opts.enabled ?? true,
    channel: opts.channel ?? 'cash',
    dayOfMonth: opts.day ?? 1,
  });
  return { admin, familyId: fam.id, studentId: s.id, planId: plan.id };
}

const ON_THE_FIRST = new Date('2026-09-01T09:00:00Z');
const paidRows = () => app.dbmod.db.select().from(payments).all();

describe('what it records', () => {
  it('records what is owed, in the channel the office chose', async () => {
    const { admin, familyId, studentId } = await seed({ channel: 'ach' });
    const r = standing.runStanding(ON_THE_FIRST);
    expect(r.recorded).toBe(1);
    expect(r.amountCents).toBe(5000);

    const row = paidRows()[0];
    expect(row.studentId).toBe(studentId);
    expect(row.channel).toBe('ach');
    expect(row.amountCents).toBe(5000);
    // The bill it settles.
    expect((await admin.billing.familyBilling({ familyId })).balance.owedCents).toBe(0);
  });

  /**
   * THE RULE THAT MATTERS MOST. No amount is stored, so a bill smaller than last month's cannot leave a
   * surplus behind — and a surplus would become credit, which the next invoice absorbs in silence.
   */
  it('never records more than is owed, so it cannot mint credit', async () => {
    const { admin, familyId, studentId } = await seed();
    // A credit brings the bill down to $20 before the run.
    await admin.billing.chargeAdd({ studentId, source: { kind: 'custom', label: 'Bursary', amountCents: -3000 }, bill: 'period', periodKey: '2026-09' });

    standing.runStanding(ON_THE_FIRST);
    expect(paidRows()[0].amountCents).toBe(2000);
    const bal = (await admin.billing.familyBilling({ familyId })).balance;
    expect(bal.owedCents).toBe(0);
    expect(bal.creditCents).toBe(0); // nothing invented
  });

  it('records nothing at all when nothing is owed', async () => {
    const { admin, studentId } = await seed();
    // Paid by hand already, so by the run there is nothing left.
    await admin.billing.recordManualPayment({ studentId, amountCents: 5000, channel: 'cash', occurredAt: '2026-09-01' });
    const before = paidRows().length;

    const r = standing.runStanding(ON_THE_FIRST);
    expect(r.recorded).toBe(0);
    expect(paidRows()).toHaveLength(before);
  });

  /** A bill dated later in the month is not owed yet on the 1st. */
  it('ignores a bill that is not due yet', async () => {
    const admin = caller('admin');
    const fam = await admin.people.familyCreate({ name: 'Farooqi' });
    const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
    const s = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Aisha Farooqi', feePlanId: plan.id });
    await admin.billing.generatePeriod({ periodKey: '2026-09', label: 'Sep 2026', dueDate: '2026-09-20' });
    await admin.billing.standingSet({ studentId: s.id, enabled: true, channel: 'cash', dayOfMonth: 1 });

    expect(standing.runStanding(ON_THE_FIRST).recorded).toBe(0);
  });

  it('is stamped as the app rather than as a person', async () => {
    await seed();
    standing.runStanding(ON_THE_FIRST);
    // §9's split: `recorded_by_name` answers "who took this cash?", and the honest answer is nobody did.
    expect(paidRows()[0].recordedByName).toBe(standing.STANDING_ACTOR);
  });
});

describe('it cannot record the same month twice', () => {
  /** THE DATABASE is the idempotency, not a marker we keep — the key is UNIQUE on `payments`. */
  it('is a no-op on a second run in the same month', async () => {
    await seed();
    expect(standing.runStanding(ON_THE_FIRST).recorded).toBe(1);
    expect(standing.runStanding(ON_THE_FIRST).recorded).toBe(0);
    expect(paidRows()).toHaveLength(1);
  });

  /**
   * A container down on the 1st must not skip the month, so the day test is `<=`. That catch-up must not
   * then record a second time — which is the same guard from the other direction.
   */
  it('catches up on a later day without doubling', async () => {
    await seed({ day: 1 });
    // Missed the 1st entirely; the job runs on the 3rd.
    expect(standing.runStanding(new Date('2026-09-03T09:00:00Z')).recorded).toBe(1);
    expect(standing.runStanding(new Date('2026-09-04T09:00:00Z')).recorded).toBe(0);
    expect(paidRows()).toHaveLength(1);
  });

  /**
   * THE GUARANTEE UNDER THE PRE-CHECK. The loop skips a month it has already recorded, but that check is a
   * courtesy for the count and the preview — the real guard is that `payments.idempotency_key` is UNIQUE.
   * Proved here directly against the ledger, so the module header's claim is verified rather than asserted:
   * two writes carrying one standing key leave exactly ONE row.
   */
  it('is protected by the database, not just by the pre-check', async () => {
    const { studentId } = await seed();
    const ledger = await import('../src/billing/ledger');
    const key = standing.standingKey(studentId, '2026-09');
    const actor = { userId: null, role: 'system' as const, name: 'test' };
    const first = ledger.recordPayment({ studentId, amountCents: 2500, channel: 'cash', occurredAt: new Date(), idempotencyKey: key }, actor);
    const again = ledger.recordPayment({ studentId, amountCents: 2500, channel: 'cash', occurredAt: new Date(), idempotencyKey: key }, actor);
    expect(again.duplicate).toBe(true);
    expect(again.paymentId).toBe(first.paymentId);
    expect(paidRows()).toHaveLength(1);
  });

  it('records again in the NEXT month, which is the whole point', async () => {
    const { admin } = await seed();
    standing.runStanding(ON_THE_FIRST);
    await admin.billing.generatePeriod({ periodKey: '2026-10', label: 'Oct 2026', dueDate: '2026-10-01' });
    expect(standing.runStanding(new Date('2026-10-01T09:00:00Z')).recorded).toBe(1);
    expect(paidRows()).toHaveLength(2);
  });

  it('does not run before its day', async () => {
    await seed({ day: 15 });
    expect(standing.runStanding(ON_THE_FIRST).recorded).toBe(0);
    expect(standing.runStanding(new Date('2026-09-15T09:00:00Z')).recorded).toBe(1);
  });
});

describe('who it leaves alone', () => {
  it('does nothing while switched off', async () => {
    await seed({ enabled: false });
    expect(standing.runStanding(ON_THE_FIRST).recorded).toBe(0);
  });

  /** A child who has left is not paying a standing amount, whatever the row says. */
  it('skips a withdrawn student', async () => {
    const { admin, studentId } = await seed();
    await admin.people.studentUpdate({ id: studentId, status: 'withdrawn' });
    expect(standing.runStanding(ON_THE_FIRST).recorded).toBe(0);
  });

  /**
   * The cap is the STUDENT's own balance, not the household's. A sibling's arrears are not this child's
   * to have settled — recording them here would move money onto the wrong record and read as though the
   * wrong family member had paid.
   */
  it('does not pay off a sibling’s arrears', async () => {
    const { admin, familyId, planId, studentId } = await seed();
    const sib = await admin.people.studentCreate({ familyId, fullName: 'Maryam Ismail', feePlanId: planId });
    // The sibling owes September too, and has NO standing arrangement.
    await admin.billing.generatePeriod({ periodKey: '2026-09', label: 'Sep 2026', dueDate: '2026-09-01' });

    const r = standing.runStanding(ON_THE_FIRST);
    expect(r.recorded).toBe(1);
    expect(r.amountCents).toBe(5000); // this child's bill only
    expect(paidRows().every((p) => p.studentId === studentId)).toBe(true);
    // The sibling is still owed for.
    const bill = await admin.billing.familyBilling({ familyId });
    expect(bill.invoices.find((i) => i.studentId === sib.id)?.status).toBe('open');
  });
});

describe('the arrangement itself', () => {
  it('is off until somebody turns it on', async () => {
    const admin = caller('admin');
    const fam = await admin.people.familyCreate({ name: 'Ismail' });
    const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
    const s = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf', feePlanId: plan.id });
    const got = await admin.billing.standingGet({ studentId: s.id });
    expect(got.enabled).toBe(false);
  });

  /**
   * The panel must show the same figure the scheduler would — no amount is stored, so it is derived. And
   * it is derived as of the NEXT RUN, not today: asking about today reported /usr/bin/bash to an office setting this
   * up before the bill was due, which is true and reads exactly like a broken feature ().
   */
  it('reports what it would record on the next run, not today', async () => {
    const { admin, studentId } = await seed();
    const got = await admin.billing.standingGet({ studentId });
    // The bill is due 2026-09-01 and the arrangement runs on the 1st, so the next run covers it.
    expect(got.runsOn.endsWith('-01')).toBe(true);
    expect(got.wouldRecord).toBe(5000);

    await admin.billing.recordManualPayment({ studentId, amountCents: 5000, channel: 'cash', occurredAt: '2026-09-01' });
    expect((await admin.billing.standingGet({ studentId })).wouldRecord).toBe(0);
  });

  /** The run date itself: this month's day when it is still ahead, next month's once it has passed. */
  it('names the next run date correctly either side of the day', async () => {
    expect(standing.nextRunDate(15, new Date('2026-09-10T00:00:00Z'))).toBe('2026-09-15');
    expect(standing.nextRunDate(5, new Date('2026-09-10T00:00:00Z'))).toBe('2026-10-05');
    // On the day itself it is today — the run has not happened yet at the time the panel is read.
    expect(standing.nextRunDate(10, new Date('2026-09-10T00:00:00Z'))).toBe('2026-09-10');
    // December rolls the year.
    expect(standing.nextRunDate(1, new Date('2026-12-10T00:00:00Z'))).toBe('2027-01-01');
  });

  it('is audited when set', async () => {
    const { studentId } = await seed();
    const row = app.dbmod.db.select().from(auditLog).all().find((r) => r.action === 'standing.set');
    expect(row).toBeTruthy();
    expect(row!.entityId).toBe(studentId);
  });

  /** Finance records payments by hand (§5), so arranging for one is the same authority. */
  it('is open to finance as well as admin', async () => {
    const { studentId } = await seed();
    await expect(caller('finance').billing.standingSet({ studentId, enabled: true, channel: 'cash', dayOfMonth: 5 })).resolves.toBeTruthy();
  });

  it('is refused to a parent', async () => {
    const { studentId } = await seed();
    await expect(caller('parent').billing.standingGet({ studentId })).rejects.toThrow();
  });
});

/**
 * THE ESCAPE HATCH. Because it records money nobody confirmed, being able to undo it is what makes the
 * whole design tolerable — and it must work through the ORDINARY reversal path, not a special one.
 */
describe('a recorded payment can be taken back', () => {
  it('reverses like any other manual payment, restoring the bill', async () => {
    const { admin, familyId } = await seed();
    standing.runStanding(ON_THE_FIRST);
    expect((await admin.billing.familyBilling({ familyId })).balance.owedCents).toBe(0);

    const p = paidRows()[0];
    await admin.billing.reversePayment({ paymentId: p.id });

    // The bill is owed again, and the reversal is a mirror row rather than a deletion (§9).
    expect((await admin.billing.familyBilling({ familyId })).balance.owedCents).toBe(5000);
    expect(paidRows()).toHaveLength(2);
    expect(paidRows().some((r) => r.reversalOf === p.id)).toBe(true);
  });

  /** …and the month stays settled as "already handled": reversing does not invite an immediate re-record,
   *  because the idempotency key for that period is still taken. That is deliberate — an office that
   *  reverses a wrongly-recorded payment does not want the scheduler putting it straight back. */
  it('does not re-record the month after a reversal', async () => {
    const { admin } = await seed();
    standing.runStanding(ON_THE_FIRST);
    await admin.billing.reversePayment({ paymentId: paidRows()[0].id });
    expect(standing.runStanding(new Date('2026-09-05T09:00:00Z')).recorded).toBe(0);
  });
});
