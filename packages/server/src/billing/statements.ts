// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Printable family statements (CLAUDE.md §4, §14). A self-contained, print-CSS HTML page
 * — balance, open invoices, recent payments, each child's Student ID, and a QR to the parent-portal
 * signup — that finance/admin hand to a family. Rendered server-side (like the report-card
 * PDFs), so the strings are fixed English for now, matching the other generated artifacts.
 *
 * Security: every dynamic value (names, memos, labels) is HTML-escaped — the statement embeds
 * student names, which are user input (§14: stored data is inert, always rendered as text). Printing
 * the Student ID is the point of the page — it is what a parent types to pay (§11.2).
 */
import { and, eq, asc, desc, inArray, sql } from 'drizzle-orm';
import type { Role } from '../db/schema';
import type { Origin } from '../security/origin';
import { roleAllowedFromOrigin } from '../security/origin';
import { db } from '../db';
import { families, students, invoices, payments } from '../db/schema';
import { formatMoney } from '../db/money';
import { familyBalance, studentBalance, invoiceTotal, invoicePaid } from './ledger';
import { getSchoolName, getCurrency } from '../settings';

/** Only admin (LAN) and finance (LAN + tunnel) may print statements (§5 permission matrix). */
export function canServeStatement(role: Role, origin: Origin): boolean {
  if (role !== 'admin' && role !== 'finance') return false;
  return roleAllowedFromOrigin(role, origin);
}

/** Escape the five HTML-significant characters. Applied to every dynamic value below. */
export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const asDate = (v: unknown): string => {
  if (v == null) return '';
  const d = v instanceof Date ? v : new Date(v as number);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};

const CHANNEL_LABELS: Record<string, string> = {
  cash: 'Cash', zelle: 'Zelle', check: 'Check', other: 'Other',
  'donations-web': 'Donation site', kiosk: 'Kiosk', portal: 'Portal', autopay: 'Autopay',
};

/**
 * Build a family's statement as a complete HTML document. `baseUrl` is the origin the QR
 * points at (the tunnel public URL when set, else the LAN address the request came in on).
 * Returns null when the family doesn't exist. The QR encodes the parent-portal signup link.
 */
export async function buildFamilyStatementHtml(familyId: string, baseUrl: string): Promise<string | null> {
  const fam = db.select({ id: families.id, name: families.name }).from(families).where(eq(families.id, familyId)).get();
  if (!fam) return null;

  const schoolName = getSchoolName();
  const currency = getCurrency();
  const money = (c: number) => formatMoney(c, currency);
  const bal = familyBalance(familyId);

  // Every child on the family, not just the active ones: a withdrawn child's unpaid bill is still
  // owed, and a statement that hid it would understate the total the parent is being asked for.
  const kids = db
    .select({ id: students.id, firstName: students.firstName, lastName: students.lastName, studentCode: students.studentCode, status: students.status })
    .from(students)
    .where(eq(students.familyId, familyId))
    .orderBy(students.firstName)
    .all();
  const kidIds = kids.map((k) => k.id);

  // Invoices and payments are per student now, so both carry the child's name — on a household
  // statement "Tuition — Jul" appearing three times is only useful if you can tell whose is whose.
  const nameOf = new Map(kids.map((k) => [k.id, `${k.firstName} ${k.lastName}`.trim()]));

  const openInvs = !kidIds.length
    ? []
    : db
        .select({ id: invoices.id, label: invoices.label, dueDate: invoices.dueDate, status: invoices.status, studentId: invoices.studentId })
        .from(invoices)
        .where(and(inArray(invoices.studentId, kidIds), inArray(invoices.status, ['open', 'partially_paid'])))
        // Oldest-due-first, mirroring the ledger's allocation order — SQLite sorts NULL before any
        // value, so push undated invoices last rather than to the top (see ledger.ts).
        .orderBy(sql`${invoices.dueDate} is null`, asc(invoices.dueDate), asc(invoices.createdAt))
        .all()
        .map((i) => ({ ...i, balanceCents: invoiceTotal(db, i.id) - invoicePaid(db, i.id) }))
        .filter((i) => i.balanceCents > 0);

  // Recent payments (net view — reversals show as negative, so the record is honest).
  const recent = !kidIds.length
    ? []
    : db
        .select({ amountCents: payments.amountCents, channel: payments.channel, occurredAt: payments.occurredAt, memo: payments.memo, studentId: payments.studentId })
        .from(payments)
        .where(inArray(payments.studentId, kidIds))
        .orderBy(desc(payments.occurredAt), desc(payments.createdAt))
        .limit(10)
        .all();

  // The portal-signup QR. Dynamic-imported so the (CJS) server has no top-level ESM/heavy load.
  const qrcode = (await import('qrcode')).default;
  const signupUrl = `${baseUrl.replace(/\/+$/, '')}/family/register`;
  const qrDataUri = await qrcode.toDataURL(signupUrl, { margin: 1, width: 220, errorCorrectionLevel: 'M' });

  const balanceLine = bal.owedCents > 0
    ? `<span class="owed">${esc(money(bal.owedCents))}</span> due`
    : bal.creditCents > 0
      ? `<span class="credit">${esc(money(bal.creditCents))}</span> in credit`
      : `<span class="settled">${esc(money(0))}</span> — all settled`;

  // Each child's Student ID (the one thing a parent needs to pay anywhere — §11.2) and, now that bills
  // are per child, what each of them actually owes.
  const kidsRows = kids.length
    ? kids
        .map((k) => {
          const b = studentBalance(k.id);
          const owed = b.owedCents > 0 ? money(b.owedCents) : b.creditCents > 0 ? `${money(b.creditCents)} credit` : money(0);
          return `<tr><td>${esc(nameOf.get(k.id) ?? '')}${k.status === 'withdrawn' ? ' <span class="muted">(withdrawn)</span>' : ''}</td><td class="code">${esc(k.studentCode ?? '—')}</td><td class="num${b.owedCents > 0 ? ' owed' : ''}">${esc(owed)}</td></tr>`;
        })
        .join('')
    : `<tr><td colspan="3" class="muted">No students on this record.</td></tr>`;

  const invoiceRows = openInvs.length
    ? openInvs.map((i) => `<tr><td>${esc(nameOf.get(i.studentId) ?? '')}</td><td>${esc(i.label)}</td><td>${esc(asDate(i.dueDate) || '—')}</td><td class="num">${esc(money(i.balanceCents))}</td></tr>`).join('')
    : `<tr><td colspan="4" class="muted">No open invoices.</td></tr>`;

  const paymentRows = recent.length
    ? recent.map((p) => `<tr><td>${esc(asDate(p.occurredAt))}</td><td>${esc(nameOf.get(p.studentId) ?? '')}</td><td>${esc(CHANNEL_LABELS[p.channel] ?? p.channel)}</td><td>${esc(p.memo ?? '')}</td><td class="num ${p.amountCents < 0 ? 'owed' : ''}">${esc(money(p.amountCents))}</td></tr>`).join('')
    : `<tr><td colspan="5" class="muted">No payments recorded yet.</td></tr>`;

  const printedOn = asDate(new Date());

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Statement — ${esc(fam.name)}</title>
<style>
  :root { --ink:#1a1a1a; --teal:#0f766e; --line:#cbcbcb; --muted:#666; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--ink); margin: 0; padding: 24px; background: #fff; }
  .sheet { max-width: 760px; margin: 0 auto; }
  .toolbar { display: flex; justify-content: flex-end; margin-bottom: 16px; }
  .btn { font: inherit; padding: 8px 16px; border: 1px solid var(--teal); background: var(--teal); color: #fff; border-radius: 8px; cursor: pointer; }
  header { border-bottom: 2px solid var(--teal); padding-bottom: 12px; margin-bottom: 18px; }
  h1 { font-size: 22px; color: var(--teal); margin: 0; }
  .sub { color: var(--muted); margin-top: 2px; }
  .meta { display: flex; justify-content: space-between; align-items: baseline; margin-top: 10px; }
  .fam { font-size: 17px; font-weight: 700; }
  .balance { margin: 18px 0; padding: 12px 16px; border: 1px solid var(--teal); border-radius: 8px; background: #f4faf8; font-size: 16px; }
  .owed { color: #b42318; font-weight: 700; }
  .credit, .settled { color: var(--teal); font-weight: 700; }
  section { margin-top: 22px; page-break-inside: avoid; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 8px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line); font-size: 13px; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 15px; letter-spacing: 0.14em; font-weight: 700; }
  .muted { color: var(--muted); }
  .payhint { margin-top: 6px; color: var(--muted); font-size: 13px; }
  .signup { display: flex; gap: 18px; align-items: center; margin-top: 22px; padding: 14px; border: 1px dashed var(--teal); border-radius: 8px; page-break-inside: avoid; }
  .signup img { width: 132px; height: 132px; }
  .signup .cap { font-size: 13px; }
  .signup .cap b { display: block; font-size: 15px; margin-bottom: 4px; color: var(--ink); }
  footer { margin-top: 28px; color: var(--muted); font-size: 12px; text-align: center; }
  @media print { body { padding: 0; } .toolbar { display: none; } .signup { border-color: #999; } }
</style>
</head>
<body>
<div class="sheet">
  <div class="toolbar"><button class="btn" onclick="window.print()">Print</button></div>
  <header>
    <h1>${esc(schoolName)}</h1>
    <div class="sub">Family statement</div>
    <div class="meta"><span class="fam">${esc(fam.name)}</span><span class="muted">Printed ${esc(printedOn)}</span></div>
  </header>

  <div class="balance">Balance: ${balanceLine}</div>

  <section>
    <h2>Your children &amp; what each owes</h2>
    <table><thead><tr><th>Student</th><th>Student ID</th><th class="num">Owes</th></tr></thead><tbody>${kidsRows}</tbody></table>
    <p class="payhint">To pay at the kiosk or on the masjid's donation site, enter your child's Student ID and check the name it shows — then you can pay for any of your children on the same screen.</p>
  </section>

  <section>
    <h2>Open invoices</h2>
    <table><thead><tr><th>Student</th><th>Invoice</th><th>Due</th><th class="num">Balance</th></tr></thead><tbody>${invoiceRows}</tbody></table>
  </section>

  <section>
    <h2>Recent payments</h2>
    <table><thead><tr><th>Date</th><th>Student</th><th>Method</th><th>Note</th><th class="num">Amount</th></tr></thead><tbody>${paymentRows}</tbody></table>
  </section>

  <div class="signup">
    <img src="${qrDataUri}" alt="Parent portal signup QR code" />
    <div class="cap"><b>Sign up for the parent portal</b>Scan to see your balance and pay online.<br /><span class="muted">${esc(signupUrl)}</span></div>
  </div>

  <footer>${esc(schoolName)} · This statement reflects activity as of ${esc(printedOn)}.</footer>
</div>
</body>
</html>`;
}
