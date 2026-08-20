// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Printable family statements (CLAUDE.md §4, §14). A self-contained, print-CSS HTML page
 * — balance, open invoices, recent payments, each child's Student ID, and a QR to the parent-portal
 * signup — that finance/admin hand to a family. Rendered server-side (like the report-card
 * PDFs), so the strings are fixed English for now, matching the other generated artifacts.
 *
 * Security: every dynamic value (names, memos, labels, the logo data URI) goes through `esc()` — the
 * statement embeds student names and payment memos, which are user input, and a memo can be typed by a
 * PARENT at the kiosk or on the donation site and read back here by staff (§14: stored data is inert,
 * always rendered as text). Printing the Student ID is the point of the page — it is what a parent
 * types to pay (§11.2). The route adds a CSP on top (see statementRoutes.ts).
 */
import { and, eq, asc, desc, inArray, sql } from 'drizzle-orm';
import type { Role } from '../db/schema';
import type { Origin } from '../security/origin';
import { roleAllowedFromOrigin } from '../security/origin';
import { db } from '../db';
import { families, students, invoices, payments } from '../db/schema';
import { formatMoney } from '../db/money';
import { familyBalance, studentBalance, invoiceTotal, invoicePaid } from './ledger';
import { accentWash, donationUrl, getAccentColor, getSchoolContact, getSchoolName, getCurrency, getSchoolLogo } from '../settings';
import { formatDate } from '../settings/dates';

/** Only admin (LAN) and finance (LAN + tunnel) may print statements (§5 permission matrix). */
export function canServeStatement(role: Role, origin: Origin): boolean {
  if (role !== 'admin' && role !== 'finance') return false;
  return roleAllowedFromOrigin(role, origin);
}

/**
 * The phone rules every printable document shares (0.48.0).
 *
 * These pages are laid out for a sheet of letter paper — a 7.5in column, half-inch margins, 24px of
 * screen padding around it — and that is right, because paper is what they are for. On a phone opening
 * one to read or to hand to the office, the same layout is a wide page you pinch and drag.
 *
 * SCREEN ONLY. It lives in a `max-width` query, so `@media print` in each document is untouched and what
 * comes out of a printer does not move. Interpolated into all four documents from here rather than
 * copied into each, because four copies is how one of them quietly stops matching.
 */
export const SHEET_PHONE_CSS = `
  /* A line that exists only on a phone — see .phone-tip in the markup. Hidden by default so a desktop
     never shows it, and hidden again in print because a phone printing this page matches BOTH queries. */
  .phone-tip { display: none; }
  @media print { .phone-tip { display: none !important; } }
  @media (max-width: 700px) {
    .phone-tip {
      display: block;
      margin: 0 0 12px;
      font-size: 12px;
      color: var(--muted);
    }
    /* The paper column is the whole screen now; the padding was margin for a page that isn't there. */
    body { padding: 12px; font-size: 13px; }
    .sheet { max-width: none; }
    /* A thumb, not a mouse pointer. Full width because there is nothing to sit beside. */
    .toolbar { justify-content: stretch; }
    .btn { width: 100%; min-height: 2.75rem; font-size: 1rem; }
    /* Tables are the part that overflows: let long values break instead of setting an unbreakable
       minimum width for their column, and lose a little of the padding rather than the content. */
    table { table-layout: fixed; }
    th, td { padding: 4px 4px; overflow-wrap: anywhere; }
    /* Rows of boxes and the QR block are side-by-side arrangements that assume width. */
    .signup { flex-direction: column; align-items: flex-start; }
    .idrow { flex-direction: column; }
    .idcard { width: 100%; }
  }`;

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
  // Inlined rather than fetched from /api/logo: a statement is printed, sometimes from a machine
  // that is not on the network, and a broken image box on a letterhead is worse than no logo.
  const logo = getSchoolLogo();
  const currency = getCurrency();
  const money = (c: number) => formatMoney(c, currency);
  const bal = familyBalance(familyId);
  // Same three install settings the family sheet reads (0.47.0), so the two printed artifacts a
  // masjid hands out cannot end up looking like they came from different schools.
  const accent = getAccentColor();
  const wash = accentWash(accent);
  const contact = getSchoolContact();
  const contactFooter = [contact.address, contact.phone, contact.email, contact.website].map((v) => v.trim()).filter(Boolean).join(' · ');
  /** The madrasah's donations page, named in the pay hint below (0.48.0). Telling a parent to pay "on the
   *  website" without saying which page is half an instruction — and only the masjid knows the path. '' when
   *  unconfigured, in which case the parenthetical is left off entirely rather than printed empty. */
  const payUrl = donationUrl(contact);
  /** Dates the way this masjid writes them; storage stays ISO (settings/dates.ts). */
  const day = (iso: string | null | undefined) => formatDate(iso);

  // Every child on the family, not just the active ones: a withdrawn child's unpaid bill is still
  // owed, and a statement that hid it would understate the total the parent is being asked for.
  const kids = db
    .select({ id: students.id, fullName: students.fullName, studentCode: students.studentCode, status: students.status })
    .from(students)
    .where(eq(students.familyId, familyId))
    .orderBy(students.fullName)
    .all();
  const kidIds = kids.map((k) => k.id);

  // Invoices and payments are per student now, so both carry the child's name — on a household
  // statement "Tuition — Jul" appearing three times is only useful if you can tell whose is whose.
  const nameOf = new Map(kids.map((k) => [k.id, k.fullName]));

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
    ? openInvs.map((i) => `<tr><td>${esc(nameOf.get(i.studentId) ?? '')}</td><td>${esc(i.label)}</td><td>${esc(day(asDate(i.dueDate)) || '—')}</td><td class="num">${esc(money(i.balanceCents))}</td></tr>`).join('')
    : `<tr><td colspan="4" class="muted">No open invoices.</td></tr>`;

  const paymentRows = recent.length
    ? recent.map((p) => `<tr><td>${esc(day(asDate(p.occurredAt)))}</td><td>${esc(nameOf.get(p.studentId) ?? '')}</td><td>${esc(CHANNEL_LABELS[p.channel] ?? p.channel)}</td><td>${esc(p.memo ?? '')}</td><td class="num ${p.amountCents < 0 ? 'owed' : ''}">${esc(money(p.amountCents))}</td></tr>`).join('')
    : `<tr><td colspan="5" class="muted">No payments recorded yet.</td></tr>`;

  const printedOn = day(asDate(new Date()));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Statement — ${esc(fam.name)}</title>
<style>
  /* --teal is the masjid's own color (Settings → Appearance), defaulting to the original teal, so
     the statement and the family sheet are ruled in the same ink. Validated as a hex literal before
     it reaches here — this is interpolated into a style block. */
  :root { --ink:#1a1a1a; --teal:${accent}; --wash:${wash}; --line:#cbcbcb; --muted:#666; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--ink); margin: 0; padding: 24px; background: #fff; }
  .sheet { max-width: 760px; margin: 0 auto; }
  .toolbar { display: flex; justify-content: flex-end; margin-bottom: 16px; }
  .btn { font: inherit; padding: 8px 16px; border: 1px solid var(--teal); background: var(--teal); color: #fff; border-radius: 8px; cursor: pointer; }
  header { border-bottom: 2px solid var(--teal); padding-bottom: 12px; margin-bottom: 18px; }
  h1 { font-size: 22px; color: var(--teal); margin: 0; }
  /* The masjid's own logo on its letterhead. Height-capped so a large upload can't push the
     statement onto a second page, and it must survive a black-and-white photocopier (§15). */
  .brand { display: flex; align-items: center; gap: 12px; }
  .logo { max-height: 56px; max-width: 200px; width: auto; height: auto; }
  .sub { color: var(--muted); margin-top: 2px; }
  .meta { display: flex; justify-content: space-between; align-items: baseline; margin-top: 10px; }
  .fam { font-size: 17px; font-weight: 700; }
  .balance { margin: 18px 0; padding: 12px 16px; border: 1px solid var(--teal); border-radius: 8px; background: var(--wash); font-size: 16px; }
  /* The masjid's address and number live in exactly ONE place on every printed document: the very
     bottom, on their own line. They were in the header too, which made three artifacts each repeat
     the same details twice — noise on a page whose whole job is to be scanned once. */
  .contactline { margin-top: 4px; }
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
${SHEET_PHONE_CSS}
</style>
</head>
<body>
<div class="sheet">
  <div class="toolbar"><button class="btn" onclick="window.print()">Print</button></div>
  <p class="phone-tip">On a phone, Print opens your phone&rsquo;s own print preview &mdash; from there the share button will email it, send it, or save it as a PDF.</p>
  <header>
    <div class="brand">
      ${logo ? `<img class="logo" src="${esc(logo)}" alt="" />` : ''}
      <div>
        <h1>${esc(schoolName)}</h1>
        <div class="sub">Family statement</div>
      </div>
    </div>
    <div class="meta"><span class="fam">${esc(fam.name)}</span><span class="muted">Printed ${esc(printedOn)}</span></div>
  </header>

  <div class="balance">Balance: ${balanceLine}</div>

  <section>
    <h2>Your children &amp; what each owes</h2>
    <table><thead><tr><th>Student</th><th>Student ID</th><th class="num">Owes</th></tr></thead><tbody>${kidsRows}</tbody></table>
    <p class="payhint">To pay at the kiosk or on the madrasah&rsquo;s donation site${payUrl ? ` (${esc(payUrl)})` : ''}, enter your child&rsquo;s Student ID and check the name it shows &mdash; then you can pay for any of your children on the same screen.</p>
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

  <footer>
    <div>${esc(schoolName)} · This statement reflects activity as of ${esc(printedOn)}.</div>
    ${contactFooter ? `<div class="contactline">${esc(contactFooter)}</div>` : ''}
  </footer>
</div>
</body>
</html>`;
}
