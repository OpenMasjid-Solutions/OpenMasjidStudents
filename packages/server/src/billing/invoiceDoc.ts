// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * ONE INVOICE, as a document a parent can be handed (0.47.0).
 *
 * Until now an invoice existed only as a row in a table — on the office's billing screen and in the
 * parent portal — and there was no way to produce the thing a family actually asks for: "can I have
 * the bill for Yusuf for September?" A parent claiming from an employer, keeping records, or simply
 * querying a figure at the desk needs a piece of paper with the masjid's name and number on it, the
 * lines that make up the amount, and what is still owed.
 *
 * WHAT IT IS NOT. It is not the statement (`billing/statements.ts`), which is the whole household's
 * position across every child — balance, all open bills, recent payments. This is one child, one
 * period, one bill, broken into its lines. The two answer different questions and a masjid needs both.
 *
 * SOURCES OF TRUTH, all borrowed rather than recomputed:
 *   • `billing/lines.ts` for what the bill is made of and what is still owed on each line — the same
 *     module the portal, the kiosk and the Fabric `lookup` use, so a line reads identically wherever a
 *     parent meets it, and the paid/outstanding split matches what a card payment would settle.
 *   • `billing/ledger.ts` for the invoice's own total and paid figures.
 *   • The masjid's contact details, colour and date format from settings, exactly like the statement
 *     and the family sheet — one set of letterhead settings across all three printed artifacts.
 *
 * SECURITY. It carries a child's name and the household's money, so it is served through the same
 * authed, CSP'd route as the other two (billing/statementRoutes.ts) and never from a public mount.
 * Every dynamic value goes through `esc()`; a line description can be a charge label an office typed.
 */
import { asc, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { families, guardianFamilies, guardians, invoices, paymentAllocations, payments, students } from '../db/schema';
import { formatMoney } from '../db/money';
import { invoicePaid, invoiceTotal, studentBalance } from './ledger';
import { invoiceLines, type PayableLine } from './lines';
import { esc, SHEET_PHONE_CSS } from './statements';
import {
  accentWash,
  getAccentColor,
  getCurrency,
  getSchoolContact,
  getSchoolLogo,
  getSchoolName,
} from '../settings';
import { formatDate } from '../settings/dates';

const asDate = (v: unknown): string => {
  if (v == null) return '';
  const d = v instanceof Date ? v : new Date(v as number);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};

/** How the money arrived, in the words a parent would recognise. Mirrors the statement's list. */
const CHANNEL_LABELS: Record<string, string> = {
  cash: 'Cash', zelle: 'Zelle', check: 'Check', ach: 'Bank transfer', other: 'Other',
  'donations-web': 'Masjid website', kiosk: 'Kiosk', portal: 'Parent portal', autopay: 'Autopay',
  carry_in: 'Brought forward',
};

const KIND_LABELS: Record<PayableLine['kind'], string> = {
  tuition: 'Tuition',
  charge: 'Charge',
  credit: 'Credit',
};

export interface InvoiceDocData {
  invoiceId: string;
  label: string;
  periodKey: string;
  dueDate: string | null;
  status: string;
  issuedOn: string;
  studentName: string;
  studentCode: string | null;
  familyId: string;
  familyLabel: string;
  guardians: { name: string; email: string | null }[];
  lines: PayableLine[];
  totalCents: number;
  paidCents: number;
  outstandingCents: number;
  /** The CHILD's overall position, which is not the same as this bill's — they may be ahead or behind
   *  on others, and a parent reading one bill still wants to know where they stand. */
  studentOwedCents: number;
  studentCreditCents: number;
  paymentsAgainst: { occurredAt: string; channel: string; amountCents: number; memo: string | null }[];
}

/**
 * Everything the document prints. Split from the rendering so the figures can be asserted without
 * parsing HTML — the totals here are what a parent will query at the desk, so they are what is worth
 * testing directly.
 */
export function collectInvoiceDoc(invoiceId: string): InvoiceDocData | null {
  const inv = db
    .select({
      id: invoices.id, label: invoices.label, periodKey: invoices.periodKey, dueDate: invoices.dueDate,
      status: invoices.status, createdAt: invoices.createdAt, studentId: invoices.studentId,
    })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .get();
  if (!inv) return null;

  const stu = db
    .select({ id: students.id, fullName: students.fullName, studentCode: students.studentCode, familyId: students.familyId })
    .from(students)
    .where(eq(students.id, inv.studentId))
    .get();
  if (!stu) return null;

  const fam = db.select({ id: families.id, name: families.name }).from(families).where(eq(families.id, stu.familyId)).get();

  // Who to address it to. Email only — a printed bill does not need the household's phone numbers on
  // it, and this is the one field that makes "who do I give this to" answerable (§14 minimisation).
  const gs = db
    .select({ name: guardians.name, email: guardians.email })
    .from(guardianFamilies)
    .innerJoin(guardians, eq(guardians.id, guardianFamilies.guardianId))
    .where(eq(guardianFamilies.familyId, stu.familyId))
    .orderBy(asc(guardians.name))
    .all();

  const total = invoiceTotal(db, inv.id);
  const paid = invoicePaid(db, inv.id);
  const bal = studentBalance(stu.id);

  // The payments that actually landed on THIS bill, newest first — so "you paid $100 on the 3rd" is
  // on the same page as the figure it changed.
  //
  // Driven by the ALLOCATIONS, not by date: money is allocated oldest-due-first and reallocated
  // whenever a bill changes, so a payment made in October can legitimately be sitting on September's
  // invoice. Listing by date would credit this bill with money that went somewhere else. The amount
  // shown is the part that landed here, which is why it can be less than the payment.
  const allocByPayment = new Map<string, number>();
  for (const a of db
    .select({ paymentId: paymentAllocations.paymentId, amountCents: paymentAllocations.amountCents })
    .from(paymentAllocations)
    .where(eq(paymentAllocations.invoiceId, inv.id))
    .all()) {
    allocByPayment.set(a.paymentId, (allocByPayment.get(a.paymentId) ?? 0) + a.amountCents);
  }
  const paymentsAgainst = !allocByPayment.size
    ? []
    : db
        .select({ id: payments.id, occurredAt: payments.occurredAt, channel: payments.channel, memo: payments.memo })
        .from(payments)
        .where(inArray(payments.id, [...allocByPayment.keys()]))
        .orderBy(desc(payments.occurredAt))
        .all()
        // A reversal pair nets to zero on this invoice; showing both halves is honest, showing a
        // stray 0 row is not.
        .filter((p) => (allocByPayment.get(p.id) ?? 0) !== 0)
        .map((p) => ({ occurredAt: asDate(p.occurredAt), channel: p.channel, amountCents: allocByPayment.get(p.id)!, memo: p.memo }));

  return {
    invoiceId: inv.id,
    label: inv.label,
    periodKey: inv.periodKey,
    dueDate: inv.dueDate,
    status: inv.status,
    issuedOn: asDate(inv.createdAt),
    studentName: stu.fullName,
    studentCode: stu.studentCode,
    familyId: stu.familyId,
    familyLabel: fam?.name ?? '',
    guardians: gs,
    lines: invoiceLines(db, inv.id),
    totalCents: total,
    paidCents: paid,
    outstandingCents: total - paid,
    studentOwedCents: bal.owedCents,
    studentCreditCents: bal.creditCents,
    paymentsAgainst,
  };
}

/**
 * Render one invoice as a complete HTML document. Returns null if there is no such invoice.
 * `now` is injectable so tests can pin the printed date.
 */
export function buildInvoiceHtml(invoiceId: string, now: Date = new Date()): string | null {
  const d = collectInvoiceDoc(invoiceId);
  if (!d) return null;

  const schoolName = getSchoolName();
  const logo = getSchoolLogo();
  const currency = getCurrency();
  const money = (c: number) => formatMoney(c, currency);
  const day = (iso: string | null | undefined) => formatDate(iso);
  const accent = getAccentColor();
  const wash = accentWash(accent);
  const contact = getSchoolContact();
  /** Printed in ONE place — the foot of the page, on its own line. Same rule as the statement and the
   *  family sheet, so all three read the same way. */
  const contactFooter = [contact.address, contact.phone, contact.email, contact.website].map((v) => v.trim()).filter(Boolean).join(' · ');
  const printedOn = day(asDate(now));

  const settled = d.outstandingCents <= 0;
  const voided = d.status === 'void';

  // Deliberately NO per-line "paid" column.
  //
  // `coveredCents` means "dealt with", which includes value taken off by a credit line on the same
  // invoice — so a $200 tuition line with $100 paid and a $25 discount reports 125. Printing that
  // under a heading like "Paid" tells a parent they handed over $125 when they handed over $100, and
  // they will believe the paper. What a line needs to say is what it COSTS and what is STILL OWED on
  // it; money actually received is a property of the bill, not of a line, and it is in the totals
  // below where it is unambiguous.
  const lineRows = d.lines.length
    ? d.lines
        .map((l) => {
          // A credit line is a reduction, not something with a balance (lines.ts reports 0 by design).
          const outstanding = l.kind === 'credit' ? '<span class="muted">—</span>' : esc(money(l.balanceCents));
          return `<tr>
        <td>${esc(l.label)}</td>
        <td><span class="kind">${esc(KIND_LABELS[l.kind])}</span></td>
        <td class="num">${esc(money(l.amountCents))}</td>
        <td class="num${l.kind !== 'credit' && l.balanceCents > 0 ? ' owed' : ''}">${outstanding}</td>
      </tr>`;
        })
        .join('')
    : '<tr><td colspan="4" class="muted">This bill has no lines on it.</td></tr>';

  const paymentRows = d.paymentsAgainst.length
    ? d.paymentsAgainst
        .map((p) => `<tr><td>${esc(day(p.occurredAt) || '—')}</td><td>${esc(CHANNEL_LABELS[p.channel] ?? p.channel)}</td><td>${esc(p.memo ?? '')}</td><td class="num">${esc(money(p.amountCents))}</td></tr>`)
        .join('')
    : '';

  // Where the child stands overall — this bill is one month of a running account, and a parent
  // holding a settled invoice while owing on another month should not be told they are square.
  const standing = d.studentOwedCents > 0
    ? `${esc(d.studentName.trim().split(/\s+/)[0])} owes <span class="owed">${esc(money(d.studentOwedCents))}</span> in total across all bills.`
    : d.studentCreditCents > 0
      ? `${esc(d.studentName.trim().split(/\s+/)[0])} is <span class="credit">${esc(money(d.studentCreditCents))}</span> paid ahead, which comes off the next bill.`
      : `Nothing else is outstanding for ${esc(d.studentName.trim().split(/\s+/)[0])}.`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Invoice — ${esc(d.studentName)} — ${esc(d.label)}</title>
<style>
  @page { size: letter; margin: 0.6in; }
  /* --teal is the masjid's own colour (Settings → How you appear to parents), defaulting to the
     original teal, so this reads as the same school as the statement and the family sheet.
     Validated as a hex literal before it reaches here — it is interpolated into a style block. */
  :root { --ink:#1a1a1a; --teal:${accent}; --wash:${wash}; --line:#cbcbcb; --muted:#666; }
  * { box-sizing: border-box; }
  body { font: 13.5px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--ink); margin: 0; padding: 24px; background: #fff; }
  .sheet { max-width: 7.3in; margin: 0 auto; }
  .toolbar { display: flex; justify-content: flex-end; margin-bottom: 12px; }
  .btn { font: inherit; padding: 8px 16px; border: 1px solid var(--teal); background: var(--teal); color: #fff; border-radius: 8px; cursor: pointer; }
  header { border-bottom: 2px solid var(--teal); padding-bottom: 10px; margin-bottom: 14px; }
  .brand { display: flex; align-items: center; gap: 12px; }
  .logo { max-height: 50px; max-width: 180px; width: auto; height: auto; }
  h1 { font-size: 20px; color: var(--teal); margin: 0; }
  .sub { color: var(--muted); margin-top: 2px; font-size: 12.5px; }
  .docref { margin-inline-start: auto; text-align: right; font-size: 12px; }
  .docref b { display: block; font-size: 14px; color: var(--ink); }
  /* The masjid's address and number, so a parent holding this can act on it — at the foot, on its
     own line, and nowhere else on the page. */
  .contactline { margin-top: 4px; }
  .parties { display: flex; gap: 18px; flex-wrap: wrap; margin-bottom: 14px; }
  .party { flex: 1 1 14rem; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 5px; }
  .party .who { font-size: 15px; font-weight: 700; }
  .party .sub2 { font-size: 12px; color: var(--muted); }
  .code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; letter-spacing: 0.1em; font-weight: 700; }
  section { margin-top: 16px; page-break-inside: avoid; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 7px; border-bottom: 1px solid var(--line); font-size: 12.5px; vertical-align: top; }
  thead th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .kind { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  .muted { color: var(--muted); }
  .owed { color: #b42318; font-weight: 700; }
  .credit { color: var(--teal); font-weight: 700; }
  tfoot td { border-bottom: none; padding-top: 8px; }
  tfoot .grand td { font-size: 15px; font-weight: 700; border-top: 2px solid var(--teal); }
  .due { margin: 14px 0 0; padding: 10px 14px; border: 1px solid var(--teal); border-radius: 8px; background: var(--wash); font-size: 15px; }
  .void { border-color: #b42318; color: #b42318; font-weight: 700; }
  .standing { margin-top: 8px; font-size: 12.5px; color: var(--muted); }
  .how { margin-top: 16px; font-size: 12px; color: var(--muted); }
  footer { margin-top: 20px; color: var(--muted); font-size: 11px; text-align: center; }
  @media print {
    body { padding: 0; font-size: 10.5pt; }
    .toolbar { display: none; }
    /* A solid block of colour is what drains a masjid's toner. */
    .due { background: #fff; }
  }
${SHEET_PHONE_CSS}
</style>
</head>
<body>
<div class="sheet">
  <div class="toolbar"><button class="btn" onclick="window.print()">Print</button></div>
  <header>
    <div class="brand">
      ${logo ? `<img class="logo" src="${esc(logo)}" alt="" />` : ''}
      <div>
        <h1>${esc(schoolName)}</h1>
        <div class="sub">Invoice</div>
      </div>
      <div class="docref">
        <b>${esc(d.label)}</b>
        <span class="muted">Issued ${esc(day(d.issuedOn) || '—')}</span>
      </div>
    </div>
  </header>

  <div class="parties">
    <div class="party">
      <h2>Bill for</h2>
      <div class="who">${esc(d.studentName)}</div>
      ${d.studentCode ? `<div class="sub2">Student ID <span class="code">${esc(d.studentCode)}</span></div>` : ''}
      ${d.familyLabel ? `<div class="sub2">${esc(d.familyLabel)}</div>` : ''}
    </div>
    <div class="party">
      <h2>To</h2>
      ${d.guardians.length
        ? d.guardians.map((g) => `<div class="sub2">${esc(g.name)}${g.email ? ` · ${esc(g.email)}` : ''}</div>`).join('')
        : '<div class="sub2 muted">No parent or guardian on file.</div>'}
    </div>
  </div>

  <section>
    <h2>What this bill is for</h2>
    <table>
      <thead><tr><th>Item</th><th></th><th class="num">Amount</th><th class="num">Outstanding</th></tr></thead>
      <tbody>${lineRows}</tbody>
      <tfoot>
        <tr><td colspan="2"></td><td class="num muted">Total</td><td class="num">${esc(money(d.totalCents))}</td></tr>
        <tr><td colspan="2"></td><td class="num muted">Paid</td><td class="num">${esc(money(d.paidCents))}</td></tr>
        <tr class="grand"><td colspan="2"></td><td class="num">Outstanding</td><td class="num${d.outstandingCents > 0 ? ' owed' : ''}">${esc(money(d.outstandingCents))}</td></tr>
      </tfoot>
    </table>
  </section>

  ${paymentRows ? `<section>
    <h2>Payments received against this bill</h2>
    <table><thead><tr><th>Date</th><th>Method</th><th>Note</th><th class="num">Amount</th></tr></thead><tbody>${paymentRows}</tbody></table>
  </section>` : ''}

  <div class="due${voided ? ' void' : ''}">${voided
    ? 'This invoice has been cancelled — nothing is owed on it.'
    : settled
      ? `Paid in full. JazākumAllāhuKhayran.${d.dueDate ? ` <span class="muted">(Was due ${esc(day(d.dueDate))}.)</span>` : ''}`
      : `<b>${esc(money(d.outstandingCents))}</b> outstanding${d.dueDate ? ` · due <b>${esc(day(d.dueDate))}</b>` : ''}`}</div>
  ${voided ? '' : `<p class="standing">${standing}</p>`}

  ${voided || settled ? '' : `<p class="how">To pay: use the parent portal, pay with ${d.studentCode ? 'the Student ID above' : 'your child’s Student ID'} on the masjid website or at the kiosk, or hand cash, a check, Zelle or a bank transfer to the office — please make sure the office records it against the right child.</p>`}

  <footer>
    <div>${esc(schoolName)} · Printed ${esc(printedOn)}</div>
    ${contactFooter ? `<div class="contactline">${esc(contactFooter)}</div>` : ''}
  </footer>
</div>
</body>
</html>`;
}
