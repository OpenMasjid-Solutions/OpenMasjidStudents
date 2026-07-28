// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Printable family statements (CLAUDE.md §4, §5, §14): the access wall (admin LAN-only /
 * finance LAN+tunnel / others never), the rendered content (balance, open invoices, recent
 * payments, each child's Student ID and what they owe, the portal-signup QR + link), and HTML-escaping
 * of the student names it embeds (which are user input).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, students, families, users, auditLog } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let statements: typeof import('../src/billing/statements');
const caller = (role: Role, opts: { origin?: 'lan' | 'tunnel' } = {}) =>
  app.appRouter.createCaller(makeCtx({ origin: opts.origin ?? 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp();
  statements = await import('../src/billing/statements');
});
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, students, families, users, auditLog]) db.delete(t).run();
});

describe('statement access wall (canServeStatement)', () => {
  it('admin is LAN-only; finance is LAN + tunnel; teacher/parent never', () => {
    const { canServeStatement } = statements;
    expect(canServeStatement('admin', 'lan')).toBe(true);
    expect(canServeStatement('admin', 'tunnel')).toBe(false); // origin policy §12.4
    expect(canServeStatement('finance', 'lan')).toBe(true);
    expect(canServeStatement('finance', 'tunnel')).toBe(true);
    for (const r of ['parent'] as const) {
      expect(canServeStatement(r, 'lan')).toBe(false);
      expect(canServeStatement(r, 'tunnel')).toBe(false);
    }
  });
});

describe('esc', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(statements.esc(`<script>&"'`)).toBe('&lt;script&gt;&amp;&quot;&#39;');
    expect(statements.esc(null)).toBe('');
  });
});

async function seed() {
  const admin = caller('admin');
  const fam = await admin.people.familyCreate({ name: 'Ismail' });
  const plan = await admin.billing.feePlanCreate({ name: 'Monthly tuition', amountCents: 5000, cadence: 'monthly' });
  const s1 = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });
  await admin.billing.generateFamily({ familyId: fam.id, periodKey: '2026-07', label: 'Tuition — Jul 2026', dueDate: '2026-07-01' });
  await admin.billing.recordManualPayment({ studentId: s1.id, amountCents: 2000, channel: 'cash', occurredAt: '2026-07-03' });
  return { admin, familyId: fam.id, studentId: s1.id };
}

describe('buildFamilyStatementHtml', () => {
  it('returns null for an unknown family', async () => {
    expect(await statements.buildFamilyStatementHtml('fam_nope', 'http://host')).toBeNull();
  });

  it('renders balance, the open invoice, the payment, each child’s Student ID, and the portal-signup QR', async () => {
    const { familyId, studentId } = await seed();
    const code = app.dbmod.db.select().from(students).all().find((s) => s.id === studentId)!.studentCode!;
    const html = (await statements.buildFamilyStatementHtml(familyId, 'https://school.example.org/'))!;
    expect(html).toContain('Our Madrasa'); // default school name
    expect(html).toContain('Ismail'); // family name
    expect(html).toContain('Yusuf'); // student
    expect(html).toContain(code); // the child's Student ID is printed on the statement (§4)
    expect(html).toContain('Tuition — Jul 2026'); // the open invoice ($50 total, $20 paid → $30 open)
    expect(html).toContain('$30.00'); // remaining invoice balance
    expect(html).toContain('$30.00'); // owed balance too
    expect(html).toContain('Cash'); // the recorded payment channel
    expect(html).toContain("child's Student ID"); // the how-to-pay hint
    // No PIN concept survives anywhere on the printed page (§11.2).
    expect(html).not.toMatch(/PIN/i);
    // The portal-signup QR is embedded as a data URI, and the link is the base + /family/register.
    expect(html).toContain('data:image/png;base64,');
    expect(html).toContain('https://school.example.org/family/register');
  });

  it('lists open invoices oldest-due-first, undated last (matches the ledger order)', async () => {
    const { db } = app.dbmod;
    const ts = new Date();
    db.insert(families).values({ id: 'fam_ord', name: 'Order Fam', status: 'active', createdAt: ts, updatedAt: ts }).run();
    db.insert(students).values({ id: 'stu_ord', familyId: 'fam_ord', fullName: 'Ord Fam', status: 'active', studentCode: 'ORD9000', createdAt: ts, updatedAt: ts }).run();
    // A dated, genuinely-due invoice and an undated one, both open with a positive balance.
    const mk = (id: string, label: string, due: string | null) => {
      db.insert(invoices).values({ id, studentId: 'stu_ord', label, periodKey: id, dueDate: due, status: 'open', createdAt: ts, updatedAt: ts }).run();
      db.insert(invoiceItems).values({ id: `it_${id}`, invoiceId: id, description: 'Tuition', amountCents: 5000, studentId: 'stu_ord', createdAt: ts }).run();
    };
    mk('inv_dated', 'Dated invoice', '2026-06-01');
    mk('inv_undated', 'Undated invoice', null);
    const html = (await statements.buildFamilyStatementHtml('fam_ord', 'http://h'))!;
    expect(html.indexOf('Dated invoice')).toBeLessThan(html.indexOf('Undated invoice'));
  });

  it('HTML-escapes student names it embeds (they are user input, §14)', async () => {
    const admin = caller('admin');
    const fam = await admin.people.familyCreate({ name: 'Test' });
    const p = await admin.billing.feePlanCreate({ name: 'T', amountCents: 1000, cadence: 'monthly' });
    await admin.people.studentCreate({ familyId: fam.id, fullName: '<script>alert(1)</script> X', feePlanId: p.id });
    const html = (await statements.buildFamilyStatementHtml(fam.id, 'http://h'))!;
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
