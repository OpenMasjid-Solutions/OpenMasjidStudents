// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The printable invoice (0.47.0) — one child, one period, line by line.
 *
 * What is worth pinning:
 *
 *  1. THE ARITHMETIC. A parent queries the figure at the desk, so total / paid / outstanding must
 *     agree with the ledger, and the lines must add up to the bill (the rule `billing/lines.ts`
 *     guarantees and every consumer depends on). A credit line reads as a reduction, not as something
 *     with a balance.
 *  2. THE MASJID IS ON IT. The whole reason this document exists: a bill a family can act on has the
 *     school's name, address and phone number on it.
 *  3. PAYMENTS ARE THE ONES THAT LANDED HERE. Allocation is derived and gets recomputed, so a payment
 *     made in October can sit on September's invoice — listing by date would credit the wrong bill.
 *  4. THE WALL. It names a child and their household's money: admin (LAN) and finance only, over real
 *     HTTP, with an admin session refused from the tunnel (§12.4).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { freshApp } from './harness';
import {
  charges, chargeItems, classes, courses, families, feePlans, guardianFamilies, guardians,
  invoiceItems, invoices, paymentAllocations, payments, sessions, studentFees, students, users,
} from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let http: FastifyInstance;
let sessionsMod: typeof import('../src/auth/sessions');
let settingsMod: typeof import('../src/settings');
let doc: typeof import('../src/billing/invoiceDoc');

beforeAll(async () => {
  app = await freshApp();
  sessionsMod = await import('../src/auth/sessions');
  settingsMod = await import('../src/settings');
  doc = await import('../src/billing/invoiceDoc');
  const { registerStatementRoutes } = await import('../src/billing/statementRoutes');
  http = Fastify();
  await http.register(fastifyCookie);
  registerStatementRoutes(http);
  await http.ready();
});

beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [
    paymentAllocations, payments, charges, chargeItems, invoiceItems, invoices,
    studentFees, feePlans, guardianFamilies, guardians, students, classes, courses, families, sessions, users,
  ]) db.delete(t).run();
  settingsMod.setSchoolContact({ address: '', phone: '', email: '', website: '' });
  settingsMod.setSetting(settingsMod.SETTING_KEYS.accentColor, '');
  settingsMod.setSetting(settingsMod.SETTING_KEYS.dateFormat, '');
  settingsMod.setSetting(settingsMod.SETTING_KEYS.schoolName, 'An-Noor Weekend School');
});

const TS = new Date('2026-08-01T00:00:00Z');
const NOW = new Date('2026-09-15T00:00:00Z');

/**
 * A real bill: $200 tuition + a $50 book fee, on one child in a household with one guardian.
 * Written directly rather than through the routers so the shape is visible in one place.
 */
function seed() {
  const { db } = app.dbmod;
  db.insert(families).values({ id: 'fam_1', name: 'Ismail family', status: 'active', createdAt: TS, updatedAt: TS }).run();
  db.insert(students).values({ id: 'stu_1', familyId: 'fam_1', fullName: 'Yusuf Ismail', dob: '2016-03-04', status: 'active', studentCode: 'YUS1234', createdAt: TS, updatedAt: TS }).run();
  db.insert(guardians).values({ id: 'grd_1', name: 'Ibrahim Ismail', phone: '5550102030', email: 'ibrahim@example.com', createdAt: TS, updatedAt: TS }).run();
  db.insert(guardianFamilies).values({ guardianId: 'grd_1', familyId: 'fam_1', relation: 'father', isEmergencyContact: false, createdAt: TS }).run();
  db.insert(feePlans).values({ id: 'fp_1', name: 'Monthly tuition', amountCents: 20000, cadence: 'monthly', status: 'active', createdAt: TS, updatedAt: TS }).run();
  db.insert(invoices).values({ id: 'inv_1', studentId: 'stu_1', label: 'Tuition — Sep 2026', periodKey: '2026-09', dueDate: '2026-09-05', status: 'open', createdAt: TS, updatedAt: TS }).run();
  db.insert(invoiceItems).values({ id: 'iti_1', invoiceId: 'inv_1', description: 'Monthly tuition', amountCents: 20000, studentId: 'stu_1', feePlanId: 'fp_1', createdAt: TS }).run();
  db.insert(invoiceItems).values({ id: 'iti_2', invoiceId: 'inv_1', description: 'Book fee', amountCents: 5000, studentId: 'stu_1', feePlanId: null, createdAt: TS }).run();
  return 'inv_1';
}

/** Record money against the bill, the way the ledger does. */
function pay(id: string, amountCents: number, opts: { itemId?: string | null; occurredAt?: Date; channel?: string } = {}) {
  const { db } = app.dbmod;
  db.insert(payments).values({
    id, studentId: 'stu_1', amountCents, channel: (opts.channel ?? 'cash') as 'cash',
    occurredAt: opts.occurredAt ?? new Date('2026-09-03T00:00:00Z'), idempotencyKey: id, createdAt: TS,
  }).run();
  db.insert(paymentAllocations).values({
    id: `pa_${id}`, paymentId: id, invoiceId: 'inv_1', invoiceItemId: opts.itemId ?? null, amountCents, createdAt: TS,
  }).run();
}

const cookieFor = (role: Role): string => {
  const { token } = sessionsMod.createSession({ userId: null, role, source: 'sso', username: role });
  return `${sessionsMod.COOKIE}=${token}`;
};

const get = (id: string, opts: { cookie?: string; tunnel?: boolean } = {}) =>
  http.inject({
    method: 'GET',
    url: `/invoices/${id}`,
    headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.tunnel ? { 'cf-ray': 'test-ray' } : {}) },
  });

describe('the figures', () => {
  it('reports total, paid and outstanding to match the ledger', () => {
    const id = seed();
    pay('pay_1', 5000);
    const d = doc.collectInvoiceDoc(id)!;
    expect(d.totalCents).toBe(25000);
    expect(d.paidCents).toBe(5000);
    expect(d.outstandingCents).toBe(20000);
  });

  it('breaks the bill into its lines, and the lines add up to it', () => {
    const id = seed();
    pay('pay_1', 5000);
    const d = doc.collectInvoiceDoc(id)!;
    expect(d.lines.map((l) => l.label)).toEqual(['Monthly tuition', 'Book fee']);
    // Tuition first is the canonical order, and it is also where undirected money lands.
    expect(d.lines[0].coveredCents).toBe(5000);
    expect(d.lines.reduce((n, l) => n + l.balanceCents, 0)).toBe(d.outstandingCents);
  });

  it('honours a payment directed at a specific line', () => {
    const id = seed();
    pay('pay_1', 5000, { itemId: 'iti_2' }); // "this $50 is the book fee"
    const d = doc.collectInvoiceDoc(id)!;
    expect(d.lines.find((l) => l.label === 'Book fee')!.balanceCents).toBe(0);
    expect(d.lines.find((l) => l.label === 'Monthly tuition')!.balanceCents).toBe(20000);
  });

  /**
   * A line's `coveredCents` counts value taken off by a credit line on the same invoice, not just
   * money — so a $200 tuition line with $100 paid and a $25 discount reports 125. Printing that under
   * a per-line "Paid" heading would tell a parent they handed over $125 when they handed over $100,
   * and they will believe the paper over the person. Money received belongs to the BILL, and it is in
   * the totals where it is unambiguous.
   */
  it('does not print a per-line paid figure, which would overstate what the parent handed over', () => {
    const id = seed();
    const { db } = app.dbmod;
    db.insert(invoiceItems).values({ id: 'iti_3', invoiceId: 'inv_1', description: 'Sibling discount', amountCents: -2500, studentId: 'stu_1', feePlanId: null, createdAt: TS }).run();
    pay('pay_1', 10000);

    const d = doc.collectInvoiceDoc(id)!;
    // The underlying figure that must never reach a per-line "Paid" column: covered is 125 on the
    // tuition line, while the parent actually handed over 100.
    expect(d.lines[0].coveredCents).toBe(12500);
    expect(d.paidCents).toBe(10000);

    const html = doc.buildInvoiceHtml(id, NOW)!;
    // The line table has four columns — item, kind, amount, outstanding — and no per-line paid one.
    const head = /<thead><tr>(.*?)<\/tr><\/thead>/.exec(html)![1];
    expect(head).toContain('Amount');
    expect(head).toContain('Outstanding');
    expect(head).not.toContain('Paid');
    // And the tuition row therefore never prints 125 beside itself.
    const tuitionRow = /<td>Monthly tuition<\/td>.*?<\/tr>/s.exec(html)![0];
    expect(tuitionRow).not.toContain('$125.00');
    expect(tuitionRow).toContain('$200.00'); // what it costs
    expect(tuitionRow).toContain('$75.00'); // what is still owed on it
    // Money received is stated once, on the bill, and it is the real figure.
    expect(html).toContain('$100.00');
  });

  it('shows a credit line as a reduction rather than as something owed', () => {
    const id = seed();
    const { db } = app.dbmod;
    db.insert(invoiceItems).values({ id: 'iti_3', invoiceId: 'inv_1', description: 'Hardship discount', amountCents: -5000, studentId: 'stu_1', feePlanId: null, createdAt: TS }).run();
    const d = doc.collectInvoiceDoc(id)!;
    const credit = d.lines.find((l) => l.kind === 'credit')!;
    expect(credit.amountCents).toBe(-5000);
    expect(credit.balanceCents).toBe(0);
    expect(d.outstandingCents).toBe(20000);
    // On the page it must not read as an amount still owed.
    const html = doc.buildInvoiceHtml(id, NOW)!;
    expect(html).toContain('Hardship discount');
    expect(html).toContain('-$50.00');
  });
});

describe('payments listed on the bill', () => {
  it('lists only money ALLOCATED to this invoice, whatever date it was taken', () => {
    const id = seed();
    // Paid in October, but allocated to September's bill — which is exactly what oldest-due-first
    // allocation does. Listing by date would put it on the wrong invoice.
    pay('pay_1', 5000, { occurredAt: new Date('2026-10-11T00:00:00Z') });
    // A payment on the same child that lands nowhere near this invoice must not appear.
    const { db } = app.dbmod;
    db.insert(payments).values({ id: 'pay_2', studentId: 'stu_1', amountCents: 9999, channel: 'cash', occurredAt: new Date('2026-09-04T00:00:00Z'), idempotencyKey: 'pay_2', createdAt: TS }).run();

    const d = doc.collectInvoiceDoc(id)!;
    expect(d.paymentsAgainst).toHaveLength(1);
    expect(d.paymentsAgainst[0].amountCents).toBe(5000);
    expect(d.paymentsAgainst[0].occurredAt).toBe('2026-10-11');
  });

  it('omits the section entirely when nothing has been paid', () => {
    const id = seed();
    expect(doc.collectInvoiceDoc(id)!.paymentsAgainst).toHaveLength(0);
    expect(doc.buildInvoiceHtml(id, NOW)!).not.toContain('Payments received against this bill');
  });
});

describe('the masjid on the invoice', () => {
  it('prints the school’s contact details ONCE, at the foot — the reason the document exists', () => {
    const id = seed();
    expect(doc.buildInvoiceHtml(id, NOW)!).not.toContain('<div class="contactline">');

    settingsMod.setSchoolContact({ address: '412 Greenlane Road', phone: '(555) 010-2030', email: 'office@annoor.example' });
    const html = doc.buildInvoiceHtml(id, NOW)!;
    expect(html).toContain('412 Greenlane Road');
    // One place on the page, the same rule as the statement and the family sheet.
    expect(html.match(/\(555\) 010-2030/g)!).toHaveLength(1);
    expect(/<footer>[\s\S]*contactline[\s\S]*<\/footer>/.test(html)).toBe(true);
    expect(/<header>[\s\S]*contactline[\s\S]*<\/header>/.test(html)).toBe(false);
  });

  it('uses the masjid’s colour and date format, like the other printed artifacts', () => {
    const id = seed();
    expect(doc.buildInvoiceHtml(id, NOW)!).toContain('--teal:#0f766e');
    settingsMod.setAccentColor('#7c3aed');
    settingsMod.setSetting(settingsMod.SETTING_KEYS.dateFormat, 'uk');
    const html = doc.buildInvoiceHtml(id, NOW)!;
    expect(html).toContain('--teal:#7c3aed');
    expect(html).toContain('05/09/2026'); // the due date, written the masjid's way
  });

  it('never lets a hand-edited colour row escape the style block', () => {
    const id = seed();
    settingsMod.setSetting(settingsMod.SETTING_KEYS.accentColor, 'red; } body { display:none } .x{');
    const html = doc.buildInvoiceHtml(id, NOW)!;
    expect(html).not.toContain('display:none');
    expect(html).toContain('--teal:#0f766e');
  });

  it('names the child, their Student ID and who to give it to', () => {
    const id = seed();
    const html = doc.buildInvoiceHtml(id, NOW)!;
    expect(html).toContain('Yusuf Ismail');
    expect(html).toContain('YUS1234');
    expect(html).toContain('Ibrahim Ismail');
    expect(html).toContain('ibrahim@example.com');
  });
});

describe('how it reads', () => {
  it('says what is outstanding and when it was due', () => {
    const id = seed();
    const html = doc.buildInvoiceHtml(id, NOW)!;
    expect(html).toContain('$250.00');
    expect(html).toContain('outstanding');
    expect(html).toContain('2026-09-05');
  });

  it('says paid in full once it is settled, and drops the how-to-pay line', () => {
    const id = seed();
    pay('pay_1', 25000);
    const html = doc.buildInvoiceHtml(id, NOW)!;
    expect(html).toContain('Paid in full');
    expect(html).not.toContain('To pay:');
  });

  it('says a void invoice is cancelled rather than showing a balance to chase', () => {
    const id = seed();
    app.dbmod.db.update(invoices).set({ status: 'void', updatedAt: TS }).run();
    const html = doc.buildInvoiceHtml(id, NOW)!;
    expect(html).toContain('cancelled');
    expect(html).not.toContain('To pay:');
  });

  it('tells the parent where the child stands overall, not just on this bill', () => {
    const id = seed();
    pay('pay_1', 25000); // this bill is settled...
    const { db } = app.dbmod;
    // ...but another month is not, and a settled invoice must not read as "you are square".
    db.insert(invoices).values({ id: 'inv_2', studentId: 'stu_1', label: 'Tuition — Oct 2026', periodKey: '2026-10', dueDate: '2026-10-05', status: 'open', createdAt: TS, updatedAt: TS }).run();
    db.insert(invoiceItems).values({ id: 'iti_9', invoiceId: 'inv_2', description: 'Monthly tuition', amountCents: 20000, studentId: 'stu_1', feePlanId: 'fp_1', createdAt: TS }).run();
    const html = doc.buildInvoiceHtml(id, NOW)!;
    expect(html).toMatch(/Yusuf owes .*\$200\.00/);
  });

  it('returns null for an invoice that does not exist', () => {
    expect(doc.buildInvoiceHtml('inv_nope')).toBeNull();
  });

  it('escapes a charge label rather than rendering it', () => {
    const id = seed();
    app.dbmod.db.insert(invoiceItems).values({ id: 'iti_x', invoiceId: 'inv_1', description: '<img src=x onerror=alert(1)>', amountCents: 100, studentId: 'stu_1', feePlanId: null, createdAt: TS }).run();
    const html = doc.buildInvoiceHtml(id, NOW)!;
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('the access wall', () => {
  it('serves admin on the LAN and finance from anywhere', async () => {
    const id = seed();
    expect((await get(id, { cookie: cookieFor('admin') })).statusCode).toBe(200);
    expect((await get(id, { cookie: cookieFor('finance') })).statusCode).toBe(200);
    expect((await get(id, { cookie: cookieFor('finance'), tunnel: true })).statusCode).toBe(200);
  });

  it('refuses an admin session over the tunnel (§12.4)', async () => {
    const id = seed();
    expect((await get(id, { cookie: cookieFor('admin'), tunnel: true })).statusCode).toBe(403);
  });

  it('refuses a parent and an anonymous request', async () => {
    const id = seed();
    // A parent may see their own bill IN THE PORTAL, which re-checks their family scope. This route
    // takes an invoice id with no scope check of its own, so it is staff-only by design.
    expect((await get(id, { cookie: cookieFor('parent') })).statusCode).toBe(403);
    expect((await get(id)).statusCode).toBe(403);
  });

  it('404s an unknown invoice rather than leaking whether it exists to a stranger', async () => {
    seed();
    expect((await get('inv_nope', { cookie: cookieFor('admin') })).statusCode).toBe(404);
    // Unauthenticated gets 403 for BOTH real and unknown ids — no existence oracle.
    expect((await get('inv_nope')).statusCode).toBe(403);
  });

  it('sends the same hardened headers as the other printed documents', async () => {
    const id = seed();
    const res = await get(id, { cookie: cookieFor('admin') });
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });
});
