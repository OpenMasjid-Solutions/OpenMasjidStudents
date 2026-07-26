// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * CSV export — and above all the FORMULA-INJECTION escaping §14 mandates.
 *
 * This export carries free text a parent can influence: guardian names, family names, payment memos.
 * A spreadsheet treats a cell beginning `=`, `+`, `-`, `@` (or a tab/CR) as a FORMULA, so an
 * un-escaped export turns "open the file" into "run whatever a parent typed". That is the attack these
 * tests exist for; the structural CSV quoting is checked alongside it.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { families, students, feePlans, studentFees, invoices, invoiceItems, payments, paymentAllocations, charges, chargeItems, guardians, guardianFamilies } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let csv: typeof import('../src/billing/csv');
const caller = (role: Role) => app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp();
  csv = await import('../src/billing/csv');
});

beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, charges, chargeItems, invoiceItems, invoices, studentFees, students, guardianFamilies, guardians, feePlans, families]) db.delete(t).run();
});

describe('csvCell — formula injection (§14)', () => {
  // Each of these, pasted into a cell, is executable in a spreadsheet.
  for (const evil of ['=1+1', '=cmd|/c calc', '+1', '-1', '@SUM(A1)', '=HYPERLINK("http://x","click")', '\tTab', '\rCR']) {
    it(`neutralises a leading formula character: ${JSON.stringify(evil)}`, () => {
      const out = csv.csvCell(evil);
      // The guard quote must be the first thing the SPREADSHEET sees — i.e. immediately inside any
      // structural quoting, never after it.
      const inner = out.startsWith('"') ? out.slice(1) : out;
      expect(inner.startsWith("'")).toBe(true);
      expect(inner.slice(1).startsWith(evil.slice(0, 1))).toBe(true);
    });
  }

  it('leaves ordinary text alone', () => {
    expect(csv.csvCell('Yusuf Ismail')).toBe('Yusuf Ismail');
    expect(csv.csvCell('35.00')).toBe('35.00');
    expect(csv.csvCell(null)).toBe('');
    expect(csv.csvCell(undefined)).toBe('');
  });

  it('quotes structurally and doubles inner quotes', () => {
    expect(csv.csvCell('a,b')).toBe('"a,b"');
    expect(csv.csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csv.csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('a negative amount is escaped (it leads with -) yet stays readable', () => {
    // csvMoney produces -50.00; csvCell must guard it, since `-` leads a formula.
    const cell = csv.csvCell(csv.csvMoney(-5000));
    expect(cell).toContain('50.00');
    expect(cell.replace(/^"/, '').startsWith("'")).toBe(true);
  });
});

describe('csvMoney / csvDate', () => {
  it('formats integer cents as a plain decimal', () => {
    expect(csv.csvMoney(0)).toBe('0.00');
    expect(csv.csvMoney(5)).toBe('0.05');
    expect(csv.csvMoney(35000)).toBe('350.00');
    expect(csv.csvMoney(-1275)).toBe('-12.75');
  });

  it('formats dates ISO so they sort, and tolerates nulls', () => {
    expect(csv.csvDate(new Date('2026-07-15T18:03:22Z'))).toBe('2026-07-15');
    expect(csv.csvDate(null)).toBe('');
    expect(csv.csvDate('nonsense')).toBe('');
  });
});

describe('toCsv', () => {
  it('writes a header, CRLF rows and a trailing newline', () => {
    const out = csv.toCsv(['A', 'B'], [[1, 2], ['x', 'y']]);
    expect(out).toBe('A,B\r\n1,2\r\nx,y\r\n');
  });
});

describe('billing.exportCsv end to end', () => {
  async function seed() {
    const admin = caller('admin');
    // A family name and a memo that are BOTH formula payloads — the realistic hostile case.
    const fam = await admin.people.familyCreate({ name: '=cmd|/c calc' });
    await admin.people.guardianCreate({ familyId: fam.id, name: '@evil', phone: '+15550100', email: 'a@test.org' });
    const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
    await admin.people.studentCreate({ familyId: fam.id, firstName: 'Yusuf', lastName: 'Ismail', feePlanId: plan.id });
    await admin.billing.generatePeriod({ periodKey: '2026-07', label: 'Tuition — Jul 2026' });
    await admin.billing.recordManualPayment({ familyId: fam.id, amountCents: 2500, channel: 'ach', occurredAt: '2026-07-15', memo: '=DANGER()' });
    return { admin, famId: fam.id };
  }

  it('exports all four datasets with rows', async () => {
    const { admin } = await seed();
    for (const dataset of ['payments', 'invoices', 'balances', 'students'] as const) {
      const r = await admin.billing.exportCsv({ dataset });
      expect(r.rows).toBeGreaterThan(0);
      expect(r.filename).toMatch(new RegExp(`^${dataset}-\\d{4}-\\d{2}-\\d{2}\\.csv$`));
      expect(r.csv.split('\r\n')[0]).toBeTruthy(); // a header line
    }
  });

  it('escapes a hostile family name AND a hostile memo in the payments sheet', async () => {
    const { admin } = await seed();
    const r = await admin.billing.exportCsv({ dataset: 'payments' });
    // Neither payload may appear as a live formula — i.e. never immediately after a delimiter/quote.
    expect(r.csv).not.toMatch(/(^|,|")=cmd/m);
    expect(r.csv).not.toMatch(/(^|,|")=DANGER/m);
    // They ARE present, just defused.
    expect(r.csv).toContain("'=cmd");
    expect(r.csv).toContain("'=DANGER");
  });

  it('never exports PINs, even though it does export the student ID', async () => {
    const { admin } = await seed();
    const pin = app.dbmod.db.select().from(students).all()[0].pin;
    const code = app.dbmod.db.select().from(students).all()[0].studentCode!;
    const r = await admin.billing.exportCsv({ dataset: 'students' });
    expect(r.csv).toContain(code); // the ID is not a secret
    expect(r.csv).not.toContain(pin); // the PIN is
    expect(r.csv.split('\r\n')[0]).not.toMatch(/pin/i);
  });

  it('is reachable by finance (including over the tunnel) but not by a parent', async () => {
    await seed();
    await expect(caller('finance').billing.exportCsv({ dataset: 'balances' })).resolves.toBeTruthy();
    const financeRemote = app.appRouter.createCaller(makeCtx({ origin: 'tunnel', session: { role: 'finance', source: 'local', username: 'f', userId: 'usr_f' } }).ctx);
    await expect(financeRemote.billing.exportCsv({ dataset: 'balances' })).resolves.toBeTruthy();
    await expect(caller('parent').billing.exportCsv({ dataset: 'balances' })).rejects.toThrow();
  });

  it('audits the export — it is a bulk read of billing data', async () => {
    const { admin } = await seed();
    await admin.billing.exportCsv({ dataset: 'payments' });
    const { auditLog } = await import('../src/db/schema');
    const entry = app.dbmod.db.select().from(auditLog).all().find((e) => e.action === 'billing.exportCsv');
    expect(entry).toBeTruthy();
    expect(JSON.stringify(entry!.detail)).toContain('payments');
  });
});
