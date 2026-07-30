// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Scheduled invoice generation. `today` is injected, so every calendar case is testable.
 *
 * The cases that matter are the ones that decide whether this is safe to leave running unattended:
 * off by default; only months inside the school year (a madrasa year skips the summer, and blindly
 * billing every month would over-charge); exactly once per month; and a MISSED day is caught up rather
 * than skipped, because a container that was off on the 1st must not cost the madrasa a month of fees.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { families, students, feePlans, studentFees, invoices, invoiceItems, payments, paymentAllocations, charges, chargeItems, schoolYears, settings } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let auto: typeof import('../src/billing/autoInvoice');
let settingsMod: typeof import('../src/settings');
const caller = (role: Role) => app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp();
  auto = await import('../src/billing/autoInvoice');
  settingsMod = await import('../src/settings');
});

beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, charges, chargeItems, invoiceItems, invoices, studentFees, students, feePlans, families, schoolYears, settings]) db.delete(t).run();
});

/** A family with one billable student, and an Apr→Mar 2026 school year set current. */
async function seed(opts: { withYear?: boolean; startYear?: number | null } = {}) {
  const admin = caller('admin');
  const fam = await admin.people.familyCreate({ name: 'Ismail' });
  const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
  await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });
  if (opts.withYear !== false) {
    const y = await admin.structure.schoolYearCreate({ label: '2026–2027', startYear: 2026, startMonth: 4, endMonth: 3, makeCurrent: true });
    if (opts.startYear === null) app.dbmod.db.update(schoolYears).set({ startYear: null }).run();
    void y;
  }
  return { admin, famId: fam.id };
}

const JULY_15 = new Date(2026, 6, 15); // inside Apr→Mar 2026-27
const JULY_1 = new Date(2026, 6, 1);

describe('off by default', () => {
  it('does nothing until an admin turns it on', async () => {
    await seed();
    expect(settingsMod.getAutoInvoice().enabled).toBe(false);
    expect(auto.runAutoInvoice(JULY_15)).toEqual({ ran: false, reason: 'disabled' });
    expect(app.dbmod.db.select().from(invoices).all()).toHaveLength(0);
  });
});

describe('when enabled', () => {
  beforeEach(() => settingsMod.setAutoInvoice({ enabled: true, day: 1 }));

  it('generates the current month once, and is a no-op the second time', async () => {
    await seed();
    const first = auto.runAutoInvoice(JULY_15);
    expect(first.ran).toBe(true);
    expect(first.periodKey).toBe('2026-07');
    expect(first.created).toBe(1);
    expect(app.dbmod.db.select().from(invoices).all()).toHaveLength(1);

    const second = auto.runAutoInvoice(JULY_15);
    expect(second).toMatchObject({ ran: false, reason: 'already_done' });
    expect(app.dbmod.db.select().from(invoices).all()).toHaveLength(1);
  });

  it('CATCHES UP a missed day instead of skipping the month', async () => {
    await seed();
    settingsMod.setAutoInvoice({ day: 1 });
    // The app was off on the 1st. Waking on the 15th must still bill July.
    const r = auto.runAutoInvoice(JULY_15);
    expect(r.ran).toBe(true);
    expect(r.periodKey).toBe('2026-07');
  });

  it('waits until the chosen day', async () => {
    await seed();
    settingsMod.setAutoInvoice({ day: 10 });
    expect(auto.runAutoInvoice(JULY_1)).toMatchObject({ ran: false, reason: 'too_early' });
    expect(auto.runAutoInvoice(JULY_15).ran).toBe(true);
  });

  it('clamps the day to the month, so “the 31st” still fires in February', async () => {
    await seed();
    settingsMod.setAutoInvoice({ day: 31 });
    // Feb 2027 is inside the Apr 2026 → Mar 2027 year, and has 28 days.
    const r = auto.runAutoInvoice(new Date(2027, 1, 28));
    expect(r.ran).toBe(true);
    expect(r.periodKey).toBe('2027-02');
  });

  it('refuses a month OUTSIDE the school year — the summer must not be billed', async () => {
    await seed();
    // The year runs Apr 2026 → Mar 2027, so Apr 2028 is outside it.
    const r = auto.runAutoInvoice(new Date(2028, 3, 5));
    expect(r).toMatchObject({ ran: false, reason: 'outside_school_year' });
    expect(app.dbmod.db.select().from(invoices).all()).toHaveLength(0);
  });

  it('stops, loudly rather than silently, with no current school year', async () => {
    await seed({ withYear: false });
    expect(auto.runAutoInvoice(JULY_15)).toMatchObject({ ran: false, reason: 'no_school_year' });
  });

  it('stops when the school year has no starting calendar year', async () => {
    await seed({ startYear: null });
    expect(auto.runAutoInvoice(JULY_15)).toMatchObject({ ran: false, reason: 'needs_start_year' });
  });

  /**
   * A month bill ALWAYS carries a due date — the configured day, or the 1st of that month.
   *
   * It used to be null when no due day was set, and null is not a harmless "no opinion": autopay's
   * whole query is `due_date <= today`, so those invoices were never charged, and `reallocateStudent`
   * sorts nulls last, so money skipped past them to newer months. A February bill nobody had dated was
   * therefore never chased and never ticked in the year grid (0.43.0).
   */
  it('always dates a month bill — the configured day, or the 1st', async () => {
    await seed();
    settingsMod.setAutoInvoice({ day: 1, dueDay: 10 });
    auto.runAutoInvoice(JULY_15);
    expect(app.dbmod.db.select().from(invoices).all()[0].dueDate).toBe('2026-07-10');

    // Fresh month, no due day configured.
    settingsMod.setAutoInvoice({ dueDay: null });
    auto.runAutoInvoice(new Date(2026, 7, 15)); // August
    const aug = app.dbmod.db.select().from(invoices).all().find((i) => i.periodKey === '2026-08')!;
    expect(aug.dueDate).toBe('2026-08-01');
  });

  it('bills only monthly plans — a per-term plan is not swept into a month run', async () => {
    const { admin, famId } = await seed();
    const term = await admin.billing.feePlanCreate({ name: 'Term fee', amountCents: 9000, cadence: 'per_term' });
    const s2 = await admin.people.studentCreate({ familyId: famId, fullName: 'Maryam Ismail', feePlanId: term.id });
    void s2;
    auto.runAutoInvoice(JULY_15);
    const lines = app.dbmod.db.select().from(invoiceItems).all();
    expect(lines.some((l) => l.description.includes('Tuition'))).toBe(true);
    expect(lines.some((l) => l.description.includes('Term fee'))).toBe(false);
  });
});

describe('the tRPC surface', () => {
  it('is admin-only to configure, and finance can run it', async () => {
    await seed();
    await expect(caller('finance').billing.autoInvoiceSet({ enabled: true })).rejects.toThrow();
    await caller('admin').billing.autoInvoiceSet({ enabled: true, day: 1 });
    expect((await caller('finance').billing.autoInvoiceGet()).enabled).toBe(true);
    const r = await caller('finance').billing.autoInvoiceRunNow();
    expect(r.ran).toBe(true);
  });

  it('“Run now” uses the same path as the cron, so it cannot drift', async () => {
    await seed();
    await caller('admin').billing.autoInvoiceSet({ enabled: true, day: 28 });
    // Day 28 and "today" is well before it in most months — but Run now still reports the SAME
    // reasons the nightly job would, rather than forcing a generation.
    const r = await caller('admin').billing.autoInvoiceRunNow();
    expect(typeof r.ran).toBe('boolean');
    if (!r.ran) expect(['too_early', 'outside_school_year', 'already_done']).toContain(r.reason);
  });
});
