// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * What an invoice is CALLED (0.48.0 — billing/period.ts + the label template setting).
 *
 * The form used to be two free-text boxes typed out every month: the period key AND the label, with
 * nothing checking they agreed. "Tuition — Jun 2026" filed under `2026-07` was one keystroke away — and an
 * invoice is money history, never edited afterwards (§9), so the wrong month would sit on that parent's
 * bill for good.
 *
 * The fix is that the label is DERIVED from the period key the invoice is filed under. So what is worth
 * testing is exactly that: the two cannot come apart, whatever the office writes, and the same wording
 * comes out of the manual path and the nightly job.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { invoices, invoiceItems, paymentAllocations, payments, studentFees, feePlans, students, families, schoolYears, settings, users, auditLog } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let period: typeof import('../src/billing/period');
let settingsMod: typeof import('../src/settings');

const caller = (role: Role) =>
  app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp();
  period = await import('../src/billing/period');
  settingsMod = await import('../src/settings');
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, students, families, schoolYears, settings, users, auditLog]) db.delete(t).run();
});

describe('resolveInvoiceLabel', () => {
  it('fills the tags from the period key', () => {
    const r = period.resolveInvoiceLabel;
    expect(r('Tuition — [month] [year]', '2026-07')).toBe('Tuition — July 2026');
    expect(r('[mon] [yy]', '2026-07')).toBe('Jul 26');
    expect(r('Fees for [period]', '2026-07')).toBe('Fees for 2026-07');
    // Case-insensitive, because an office typing [Month] means [month].
    expect(r('[MONTH] [Year]', '2026-01')).toBe('January 2026');
  });

  it('leaves text that is not a tag exactly as written', () => {
    const r = period.resolveInvoiceLabel;
    // A madrasah's own wording, brackets and all. Deleting something nobody could see the source of
    // would be worse than leaving it.
    expect(r('Maktab [unknown] — [month] [year]', '2026-03')).toBe('Maktab [unknown] — March 2026');
    expect(r('Ramadan fees', '2026-03')).toBe('Ramadan fees');
  });

  it('never produces a nameless invoice', () => {
    const r = period.resolveInvoiceLabel;
    // A blank template, or one that is nothing but unresolvable tags, would leave a blank line on a
    // parent's bill. Fall back to the month rather than ship that.
    expect(r('', '2026-07')).toBe('July 2026');
    expect(r('   ', '2026-07')).toBe('July 2026');
  });

  it('does not invent a month from a period key it cannot read', () => {
    const r = period.resolveInvoiceLabel;
    // `carry-in` is a real period key in this app and is not a month.
    expect(r('Tuition — [month] [year]', 'carry-in')).toBe('Tuition — [month] [year]');
    expect(r('', 'carry-in')).toBe('carry-in');
  });
});

describe('generating with a template', () => {
  async function base() {
    const admin = caller('admin');
    const plan = await admin.billing.feePlanCreate({ name: 'Monthly', amountCents: 10000, cadence: 'monthly' });
    await admin.people.studentAdd({ fullName: 'Yusuf Ismail', feePlanId: plan.id });
    return admin;
  }

  it('files the invoice under the month it is named for', async () => {
    const admin = await base();
    await admin.billing.generatePeriod({ periodKey: '2026-07', labelTemplate: 'Tuition — [month] [year]' });
    const inv = app.dbmod.db.select().from(invoices).all();
    expect(inv).toHaveLength(1);
    // The pair that used to be typed independently, now derived from one value.
    expect(inv[0]).toMatchObject({ periodKey: '2026-07', label: 'Tuition — July 2026' });
  });

  it('remembers the wording, so next month and the nightly job say the same thing', async () => {
    const admin = await base();
    await admin.billing.generatePeriod({ periodKey: '2026-07', labelTemplate: 'Maktab fees for [mon] [year]' });
    // Remembered as the TEMPLATE, not as the resolved text — otherwise next month would be named July.
    expect(settingsMod.getInvoiceLabelTemplate()).toBe('Maktab fees for [mon] [year]');
    expect((await admin.billing.invoiceLabelConfig()).template).toBe('Maktab fees for [mon] [year]');

    // A later month, with nothing typed: same wording, its own month.
    await admin.billing.generatePeriod({ periodKey: '2026-08' });
    const aug = app.dbmod.db.select().from(invoices).all().find((i) => i.periodKey === '2026-08')!;
    expect(aug.label).toBe('Maktab fees for Aug 2026');
  });

  it('still takes an exact label when one is given', async () => {
    const admin = await base();
    // Every existing caller and test does this, and a caller that has decided on a string should get it.
    await admin.billing.generatePeriod({ periodKey: '2026-07', label: 'Whatever I say' });
    expect(app.dbmod.db.select().from(invoices).all()[0].label).toBe('Whatever I say');
    // …and an exact label is not mistaken for a template to remember.
    expect(settingsMod.getInvoiceLabelTemplate()).toBe('Tuition — [month] [year]');
  });

  /** The family window's Generate form is the same fields (components/InvoiceGenFields), so it must
   *  derive the label the same way — with one deliberate difference about what it remembers. */
  it('one household gets the same derived label as a whole-school run', async () => {
    const admin = await base();
    const fam = app.dbmod.db.select().from(families).all()[0];
    await admin.billing.generateFamily({ familyId: fam.id, periodKey: '2026-07', labelTemplate: 'Tuition — [month] [year]' });
    expect(app.dbmod.db.select().from(invoices).all()[0]).toMatchObject({ periodKey: '2026-07', label: 'Tuition — July 2026' });
  });

  it('a label typed for ONE household does not become everybody’s', async () => {
    const admin = await base();
    const fam = app.dbmod.db.select().from(families).all()[0];
    await admin.billing.generateFamily({ familyId: fam.id, periodKey: '2026-07', labelTemplate: 'Catch-up for [month]' });
    // That household's bill says what was typed…
    expect(app.dbmod.db.select().from(invoices).all()[0].label).toBe('Catch-up for July');
    // …and the madrasah's own wording is untouched, so the nightly job and next month's whole-school run
    // are not quietly renamed by a one-family correction.
    expect(settingsMod.getInvoiceLabelTemplate()).toBe('Tuition — [month] [year]');
  });

  it('offers the school year’s months rather than a free-typed key', async () => {
    const admin = await base();
    await admin.structure.schoolYearCreate({ label: '2026–27', startYear: 2026, startMonth: 9, endMonth: 6, makeCurrent: true });
    const cfg = await admin.billing.invoiceLabelConfig();
    // Sep→Jun, the months this madrasah actually teaches — not every month there has ever been.
    expect(cfg.months.map((m) => m.periodKey)).toEqual([
      '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06',
    ]);
    expect(cfg.months[0].label).toBe('Sep 2026');
    // The tags come with worked examples, so the UI never hardcodes what they mean.
    expect(cfg.tags.find((x) => x.tag === 'month')!.example).toMatch(/^[A-Z][a-z]+$/);
  });
});
