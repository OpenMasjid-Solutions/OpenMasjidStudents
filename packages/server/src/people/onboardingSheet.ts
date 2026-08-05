// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The printable household onboarding sheet — what the office hands a family when their children go on
 * the system.
 *
 * ONE SHEET PER HOUSEHOLD, not per child, and sized to a single double-sided letter page. That is the
 * whole shape of this file. A per-child sheet repeated the parents, the emergency contacts, the portal
 * QR and the entire "how to pay" section once for every child — so a family of three got three sheets
 * that were 60% identical and no single page showing what the household actually owes. Combining them
 * makes the children the subject: they share the guardians, they share the payment routes, and the
 * balance a parent cares about is the household total.
 *
 * It answers the four things a parent asks on day one: is this what you have on file for my children,
 * what will we be charged, how do I see and pay it, and who do I tell if it is wrong.
 *
 * PAGINATION — front side is who and what (children, fees, balances); back side is how (parents, the
 * portal, paying, and the please-check notice). The break between them is explicit rather than left to
 * the browser, so the office gets a predictable two-sided sheet instead of a widow line on side three.
 * A very large household (roughly six or more children, or many fee lines each) can still spill; the
 * back-side content is fixed, so what spills is the front's tables, which is the least bad place for it.
 *
 * FORMAT — print-CSS HTML, not a generated PDF, deliberately and consistently with
 * `billing/statements.ts`. The app dropped `@react-pdf/renderer` in 0.45.0 (installed but unused, and
 * an unused dependency is pure supply-chain surface), and a headless browser is out of the question on
 * a Raspberry Pi. The browser's own Print dialog produces the PDF and gives the office a real preview.
 * Strings are fixed English like the statement: this is a server-rendered artifact, not a screen, and
 * it has no i18next context.
 *
 * HONESTY — the sheet must never promise a payment route this install does not have. Three settings
 * decide what it says, and each is read here rather than assumed:
 *   • `stripeReady()`                — is there a Stripe account behind card payments at all?
 *   • `getExternalPaymentsEnabled()` — may the kiosk and the donation site take tuition? (The same flag
 *                                     the Fabric `info` method reports, so the sheet and the kiosk
 *                                     agree; §11.2.)
 *   • `getSelfRegistrationEnabled()` — can a parent make their own portal account? With that door shut
 *                                     a QR to /family/register is a dead end, so the sheet asks them to
 *                                     request an invite instead of printing a useless code.
 * Cash, check, Zelle and ACH are always offered: they need no integration, only the office.
 *
 * SECURITY — every dynamic value goes through `esc()` (§14: stored data is inert and always rendered as
 * text; a guardian name or a fee note is user input). The sheet carries Student IDs, guardian contact
 * details and children's dates of birth, so it is served only to admin/finance through the same authed,
 * CSP'd route as the statement — never a public mount (see billing/statementRoutes.ts).
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  classes,
  courses,
  emergencyContacts,
  families,
  feePlans,
  guardianFamilies,
  guardians,
  invoices,
  students,
  studentFees,
  type FeeCadence,
} from '../db/schema';
import { formatMoney } from '../db/money';
import { familyBalance, invoicePaid, invoiceTotal, studentBalance } from '../billing/ledger';
import { esc } from '../billing/statements';
import { getCurrency, getExternalPaymentsEnabled, getSchoolLogo, getSchoolName, getSelfRegistrationEnabled } from '../settings';
import { stripeReady } from '../payments/stripe';

const asDate = (v: unknown): string => {
  if (v == null) return '';
  const d = v instanceof Date ? v : new Date(v as number);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};

/** Whole years between an ISO date and today. Returns null for absent or unparseable input — DOB is
 *  optional by design (§14 data minimisation), and a child without one just shows a blank. */
export function ageFromDob(dob: string | null | undefined, today = new Date()): number | null {
  if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  const d = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  let age = today.getUTCFullYear() - d.getUTCFullYear();
  const m = today.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && today.getUTCDate() < d.getUTCDate())) age -= 1;
  return age >= 0 && age < 150 ? age : null;
}

const CADENCE_LABELS: Record<FeeCadence, string> = {
  monthly: 'Every month',
  per_term: 'Each term',
  one_time: 'One time',
};

/** Recurring commitments first, then per-term, then one-offs — a parent reads "what do I owe every
 *  month" before "what was the book fee", and it puts the monthly lines next to the monthly total. */
const CADENCE_RANK: Record<FeeCadence, number> = { monthly: 0, per_term: 1, one_time: 2 };

/** A fee line: the plan, and what THIS child is actually charged for it. */
type SheetFee = { name: string; cadence: FeeCadence; effectiveCents: number; overridden: boolean; note: string | null };

export type SheetChild = {
  id: string;
  fullName: string;
  studentCode: string | null;
  dob: string | null;
  status: 'active' | 'withdrawn';
  className: string | null;
  fees: SheetFee[];
  owedCents: number;
  creditCents: number;
  openInvoices: { label: string; dueDate: string | null; balanceCents: number }[];
};

export type FamilySheetData = {
  familyId: string;
  familyLabel: string;
  addedOn: string;
  children: SheetChild[];
  guardians: { name: string; relation: string | null; phone: string | null; email: string | null; emergency: boolean }[];
  contacts: { name: string; relation: string | null; phone: string | null }[];
  /** Household totals. Derived, like every balance in this app. */
  owedCents: number;
  creditCents: number;
  monthlyCents: number;
};

/** Fees assigned to one child, at the amount actually charged. */
function feesFor(studentId: string): SheetFee[] {
  return db
    .select({
      name: feePlans.name, cadence: feePlans.cadence, planCents: feePlans.amountCents,
      override: studentFees.overrideAmountCents, note: studentFees.note,
    })
    .from(studentFees)
    .innerJoin(feePlans, eq(feePlans.id, studentFees.feePlanId))
    .where(eq(studentFees.studentId, studentId))
    .orderBy(asc(feePlans.name))
    .all()
    .sort((a, b) => CADENCE_RANK[a.cadence] - CADENCE_RANK[b.cadence] || a.name.localeCompare(b.name))
    .map((f) => ({
      name: f.name,
      cadence: f.cadence,
      // `override ?? plan amount` (§9) — the override is how a bursary or a sibling rate is expressed,
      // so printing the plan's list price would tell a family they owe more than the office agreed.
      effectiveCents: f.override ?? f.planCents,
      overridden: f.override != null && f.override !== f.planCents,
      note: f.note,
    }));
}

/**
 * Gather everything the sheet prints for a household. Split from the rendering so the figures can be
 * tested without parsing HTML — the fee amounts and the balances are what a parent will query at the
 * office desk, so they are what is worth asserting directly.
 */
export function collectFamilySheet(familyId: string): FamilySheetData | null {
  const fam = db
    .select({ id: families.id, name: families.name, createdAt: families.createdAt })
    .from(families)
    .where(eq(families.id, familyId))
    .get();
  if (!fam) return null;

  // Every child on the household, including withdrawn ones: a withdrawn child's unpaid bill is still
  // owed, and a sheet that hid them would understate the total the parent is being asked for.
  const kids = db
    .select({
      id: students.id, fullName: students.fullName, studentCode: students.studentCode,
      dob: students.dob, status: students.status, classId: students.classId,
    })
    .from(students)
    .where(eq(students.familyId, familyId))
    .orderBy(asc(students.fullName))
    .all();

  // Course + class read as one label ("Hifz — Group B"): on a parent-facing sheet the class name alone
  // ("Group B") does not say what the child is actually studying.
  const classIds = kids.map((k) => k.classId).filter((v): v is string => !!v);
  const classLabels = new Map<string, string>();
  if (classIds.length) {
    for (const c of db
      .select({ id: classes.id, cls: classes.name, course: courses.name })
      .from(classes)
      .leftJoin(courses, eq(courses.id, classes.courseId))
      .where(inArray(classes.id, classIds))
      .all()) {
      classLabels.set(c.id, c.course ? `${c.course} — ${c.cls}` : c.cls);
    }
  }

  const children: SheetChild[] = kids.map((k) => {
    const bal = studentBalance(k.id);
    const openInvoices = db
      .select({ id: invoices.id, label: invoices.label, dueDate: invoices.dueDate })
      .from(invoices)
      .where(and(eq(invoices.studentId, k.id), inArray(invoices.status, ['open', 'partially_paid'])))
      // Oldest-due-first, matching the ledger's allocation order. SQLite sorts NULL first, so undated
      // invoices are pushed last rather than to the top (same guard as statements.ts).
      .orderBy(sql`${invoices.dueDate} is null`, asc(invoices.dueDate), asc(invoices.createdAt))
      .all()
      .map((i) => ({ label: i.label, dueDate: i.dueDate, balanceCents: invoiceTotal(db, i.id) - invoicePaid(db, i.id) }))
      .filter((i) => i.balanceCents > 0);

    return {
      id: k.id,
      fullName: k.fullName,
      studentCode: k.studentCode,
      dob: k.dob,
      status: k.status,
      className: k.classId ? classLabels.get(k.classId) ?? null : null,
      fees: feesFor(k.id),
      owedCents: bal.owedCents,
      creditCents: bal.creditCents,
      openInvoices,
    };
  });

  const gs = db
    .select({ name: guardians.name, phone: guardians.phone, email: guardians.email, relation: guardianFamilies.relation, emergency: guardianFamilies.isEmergencyContact })
    .from(guardianFamilies)
    .innerJoin(guardians, eq(guardians.id, guardianFamilies.guardianId))
    .where(eq(guardianFamilies.familyId, familyId))
    .orderBy(asc(guardians.name))
    .all();

  const contacts = db
    .select({ name: emergencyContacts.name, phone: emergencyContacts.phone, relation: emergencyContacts.relation })
    .from(emergencyContacts)
    .where(eq(emergencyContacts.familyId, familyId))
    .orderBy(asc(emergencyContacts.name))
    .all();

  // The household total comes from the ledger's own family view, not from re-adding the children here:
  // one function owns that arithmetic (§16), and a second copy is how two screens start disagreeing.
  const bal = familyBalance(familyId);

  return {
    familyId: fam.id,
    familyLabel: fam.name,
    addedOn: asDate(fam.createdAt),
    children,
    guardians: gs.map((g) => ({ name: g.name, relation: g.relation, phone: g.phone, email: g.email, emergency: !!g.emergency })),
    contacts,
    owedCents: bal.owedCents,
    creditCents: bal.creditCents,
    monthlyCents: children
      .filter((c) => c.status === 'active')
      .reduce((sum, c) => sum + c.fees.filter((f) => f.cadence === 'monthly').reduce((a, f) => a + f.effectiveCents, 0), 0),
  };
}

/** What this install can actually accept, so the sheet only promises routes that exist. */
export type PayRoutes = { card: boolean; external: boolean; selfRegister: boolean };

export function payRoutes(): PayRoutes {
  return { card: stripeReady(), external: getExternalPaymentsEnabled(), selfRegister: getSelfRegistrationEnabled() };
}

/**
 * Render the onboarding sheet for one household. `baseUrl` is the origin the QR points at (the tunnel
 * public URL when set, else the LAN address the request arrived on). Returns null if there is no such
 * household. `routes`/`now` are injectable so tests can pin the configuration and the printed date.
 */
export async function buildFamilySheetHtml(
  familyId: string,
  baseUrl: string,
  routes: PayRoutes = payRoutes(),
  now: Date = new Date(),
): Promise<string | null> {
  const d = collectFamilySheet(familyId);
  if (!d) return null;

  const schoolName = getSchoolName();
  const logo = getSchoolLogo();
  const currency = getCurrency();
  const money = (c: number) => formatMoney(c, currency);
  const printedOn = asDate(now);
  const kids = d.children;
  const firstNames = kids.map((k) => k.fullName.trim().split(/\s+/)[0]).filter(Boolean);
  const namesSentence =
    firstNames.length === 0 ? '' :
    firstNames.length === 1 ? firstNames[0] :
    `${firstNames.slice(0, -1).join(', ')} and ${firstNames[firstNames.length - 1]}`;

  const origin = baseUrl.replace(/\/+$/, '');
  // With self-registration off, /family/register refuses the parent — so point the QR at the portal
  // itself and tell them to ask for an invite, rather than printing a code that leads to a wall.
  const qrTarget = routes.selfRegister ? `${origin}/family/register` : `${origin}/family`;
  const qrcode = (await import('qrcode')).default;
  const qrDataUri = await qrcode.toDataURL(qrTarget, { margin: 1, width: 240, errorCorrectionLevel: 'M' });

  const balanceOf = (owed: number, credit: number) =>
    owed > 0 ? `<span class="owed">${esc(money(owed))}</span>`
      : credit > 0 ? `<span class="credit">${esc(money(credit))} ahead</span>`
        : '<span class="muted">—</span>';

  // ── Front: the children ────────────────────────────────────────────────────────
  // Identity and balance in ONE table. Two tables would be tidier in the abstract and cost half a side
  // of paper, which is the constraint that actually matters here.
  const childRows = kids.length
    ? kids
        .map((k) => {
          const age = ageFromDob(k.dob, now);
          return `<tr>
        <td><b>${esc(k.fullName)}</b>${k.status === 'withdrawn' ? ' <span class="muted">(withdrawn)</span>' : ''}</td>
        <td class="code">${esc(k.studentCode ?? '—')}</td>
        <td>${esc(k.dob ? (age != null ? `${k.dob} (${age})` : k.dob) : '—')}</td>
        <td>${esc(k.className ?? '—')}</td>
        <td class="num">${balanceOf(k.owedCents, k.creditCents)}</td>
      </tr>`;
        })
        .join('')
    : '<tr><td colspan="5" class="muted">No children on this record yet.</td></tr>';

  // Fees, grouped by child. The child's name spans their lines so the eye groups them without needing
  // a separate table per child.
  const feeRows = kids
    .filter((k) => k.fees.length)
    .map((k) =>
      k.fees
        .map((f, i) => `<tr>
        ${i === 0 ? `<td rowspan="${k.fees.length}">${esc(k.fullName)}</td>` : ''}
        <td>${esc(f.name)}${f.note ? ` <span class="muted">(${esc(f.note)})</span>` : ''}</td>
        <td>${esc(CADENCE_LABELS[f.cadence] ?? f.cadence)}</td>
        <td class="num">${esc(money(f.effectiveCents))}${f.overridden ? ' <span class="tag">agreed</span>' : ''}</td>
      </tr>`)
        .join(''),
    )
    .join('');
  const feeTable = feeRows
    ? `<table>
      <thead><tr><th>Child</th><th>Fee</th><th>How often</th><th class="num">Amount</th></tr></thead>
      <tbody>${feeRows}${d.monthlyCents > 0 ? `<tr class="foot"><td colspan="3">Every month, for the family</td><td class="num">${esc(money(d.monthlyCents))}</td></tr>` : ''}</tbody>
    </table>`
    : '<p class="muted">No fees assigned yet — the office will confirm these with you.</p>';

  const invoiceRows = kids
    .flatMap((k) => k.openInvoices.map((i) => `<tr><td>${esc(k.fullName)}</td><td>${esc(i.label)}</td><td>${esc(i.dueDate || '—')}</td><td class="num">${esc(money(i.balanceCents))}</td></tr>`))
    .join('');

  const familyBalanceLine = d.owedCents > 0
    ? `<span class="owed">${esc(money(d.owedCents))}</span> due`
    : d.creditCents > 0
      ? `<span class="credit">${esc(money(d.creditCents))}</span> paid ahead — this comes off the next bill`
      : '<span class="settled">Nothing due</span>';

  // ── Back: the household, the portal, paying ────────────────────────────────────
  const guardianRows = d.guardians.length
    ? d.guardians
        .map((g) => `<tr><td>${esc(g.name)}${g.emergency ? ' <span class="tag">emergency</span>' : ''}</td><td>${esc(g.relation ?? '—')}</td><td>${esc(g.phone ?? '—')}</td><td>${esc(g.email ?? '—')}</td></tr>`)
        .join('')
    : '<tr><td colspan="4" class="muted">No parent or guardian details on file — please give these to the office.</td></tr>';

  const contactBlock = d.contacts.length
    ? `<section>
    <h2>Emergency contacts</h2>
    <table><thead><tr><th>Name</th><th>Relation</th><th>Phone</th></tr></thead><tbody>${d.contacts
      .map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.relation ?? '—')}</td><td>${esc(c.phone ?? '—')}</td></tr>`)
      .join('')}</tbody></table>
  </section>`
    : '';

  const ways = ['cash'];
  if (routes.card) ways.push('card');
  if (routes.external) ways.push('the kiosk', 'the masjid website');
  const historyPoint = ways.length > 1
    ? `Every payment you have made, however you made it — ${ways.slice(0, -1).join(', ')} or ${ways[ways.length - 1]} — all in one list`
    : 'Every payment the office has recorded for you, all in one list';

  const portalPoints = [
    'What each child owes, and what you owe altogether',
    'Every bill, broken down line by line — so you can see tuition and, say, a book fee separately',
    historyPoint,
  ];
  if (routes.card) {
    portalPoints.push('Pay by card, save a card, and set up autopay');
    portalPoints.push('A receipt by email each time a payment is recorded');
  }

  const payItems: string[] = [];
  if (routes.card) {
    payItems.push(`<li><b>In the parent portal, by card.</b> Sign in and pay the whole balance or just part of it — for one child or all of them at once. You can save a card, and turn on <b>autopay</b> so tuition is paid automatically when it comes due; you can switch it off whenever you like.</li>`);
  }
  if (routes.external) {
    payItems.push(`<li><b>On the masjid website.</b> Go to the tuition section of the masjid's donations page, type any one of your children's <b>Student IDs</b>, check the name it shows you, and pay. You can pay for all of your children from that one screen, and you don't need an account for it.</li>`);
    payItems.push(`<li><b>At the kiosk in the masjid.</b> Choose tuition, enter a Student ID, confirm the name, and tap your card — <b>Apple Pay and Google Pay</b> work too.</li>`);
  }
  payItems.push(`<li><b>Cash, check, Zelle or bank transfer (ACH).</b> These go <b>through the office</b>. Please hand them to the office and make sure someone records it against the right child — a payment nobody enters is a payment nobody can see. Ask for confirmation before you leave, and keep it.</li>`);

  const idsLine = kids.filter((k) => k.studentCode).length
    ? `<p class="idnote"><b>Each child has their own Student ID.</b> ${kids
        .filter((k) => k.studentCode)
        .map((k) => `${esc(k.fullName.trim().split(/\s+/)[0])} <span class="code">${esc(k.studentCode!)}</span>`)
        .join(' &nbsp;·&nbsp; ')}${
        routes.external
          ? ' — it is what puts a payment on the right child, and what you need to pay at the kiosk or on the masjid website.'
          : ' — it is what puts a payment on the right child when the office enters it.'
      }</p>`
    : '';

  const signupCopy = routes.selfRegister
    ? `<b>Scan this to set up your account</b>
       You will need one of your children's Student IDs (above) and an email address the office already
       has for you — that is how we know the account belongs to your family. One account covers all of
       your children.
       <br /><span class="muted">${esc(qrTarget)}</span>`
    : `<b>Ask the office for a portal invite</b>
       Accounts here are set up by invitation. Give the office an email address and they will send you a
       link to choose your own password. One account covers all of your children.
       <br /><span class="muted">${esc(qrTarget)}</span>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Family information — ${esc(d.familyLabel)}</title>
<style>
  /* Sized for ONE DOUBLE-SIDED LETTER SHEET: front is who + what, back is how. The margin and the type
     scale are set together — dropping either loosens the fit enough to push a third side. */
  @page { size: letter; margin: 0.5in; }
  :root { --ink:#1a1a1a; --teal:#0f766e; --line:#cbcbcb; --muted:#666; }
  * { box-sizing: border-box; }
  body { font: 13px/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--ink); margin: 0; padding: 24px; background: #fff; }
  .sheet { max-width: 7.5in; margin: 0 auto; }
  .toolbar { display: flex; justify-content: flex-end; margin-bottom: 12px; }
  .btn { font: inherit; padding: 8px 16px; border: 1px solid var(--teal); background: var(--teal); color: #fff; border-radius: 8px; cursor: pointer; }
  header { border-bottom: 2px solid var(--teal); padding-bottom: 9px; margin-bottom: 12px; }
  .brand { display: flex; align-items: center; gap: 12px; }
  .logo { max-height: 46px; max-width: 170px; width: auto; height: auto; }
  h1 { font-size: 19px; color: var(--teal); margin: 0; }
  .sub { color: var(--muted); margin-top: 1px; font-size: 12px; }
  .meta { display: flex; justify-content: space-between; align-items: baseline; margin-top: 7px; }
  .fam { font-size: 16px; font-weight: 700; }
  .intro { margin: 0 0 10px; }
  section { margin-top: 14px; page-break-inside: avoid; }
  h2 { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 5px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 4.5px 6px; border-bottom: 1px solid var(--line); font-size: 12px; vertical-align: top; }
  thead th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  td[rowspan] { font-weight: 600; border-bottom: 1px solid var(--line); }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .foot td { font-weight: 700; border-bottom: none; }
  .code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; letter-spacing: 0.1em; font-weight: 700; }
  .muted { color: var(--muted); }
  .tag { font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--teal); border: 1px solid var(--teal); border-radius: 4px; padding: 0 4px; white-space: nowrap; }
  .owed { color: #b42318; font-weight: 700; }
  .credit, .settled { color: var(--teal); font-weight: 700; }
  .balance { margin: 10px 0 0; padding: 8px 12px; border: 1px solid var(--teal); border-radius: 8px; background: #f4faf8; font-size: 14px; }
  .idnote { margin: 8px 0 0; padding: 7px 10px; border: 1px dashed var(--teal); border-radius: 8px; font-size: 12px; }
  ul.pay, ul.plain { margin: 0; padding-left: 18px; }
  ul.pay li { margin-bottom: 5px; }
  ul.plain li { margin-bottom: 2px; }
  .signup { display: flex; gap: 14px; align-items: center; margin-top: 10px; padding: 10px; border: 1px dashed var(--teal); border-radius: 8px; page-break-inside: avoid; }
  .signup img { width: 118px; height: 118px; }
  .signup .cap { font-size: 12px; }
  .signup .cap b { display: block; font-size: 13.5px; margin-bottom: 3px; color: var(--ink); }
  .check { margin-top: 14px; padding: 9px 12px; border-left: 3px solid var(--teal); background: #f7f7f7; font-size: 12px; page-break-inside: avoid; }
  footer { margin-top: 16px; color: var(--muted); font-size: 11px; text-align: center; }
  /* The back of the sheet. On screen it is just the next block; on paper it starts side two. */
  .side2 { break-before: page; page-break-before: always; }
  @media print {
    body { padding: 0; font-size: 10.5pt; }
    .toolbar { display: none; }
    .signup, .idnote { border-color: #999; }
    .balance, .check { background: #fff; }
  }
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
        <div class="sub">Family information &amp; how to pay</div>
      </div>
    </div>
    <div class="meta"><span class="fam">${esc(d.familyLabel)}</span><span class="muted">Printed ${esc(printedOn)}</span></div>
  </header>

  <p class="intro">${namesSentence
    ? `<b>${esc(namesSentence)} ${firstNames.length === 1 ? 'is' : 'are'} now on our system.</b>`
    : '<b>Your family is now on our system.</b>'} This sheet is your copy of what we hold for your
  ${firstNames.length === 1 ? 'child' : 'children'}, what the fees are, and every way you can pay.
  Please read it through and tell the office if anything is wrong or out of date.</p>

  <section>
    <h2>Your ${firstNames.length === 1 ? 'child' : 'children'}</h2>
    <table>
      <thead><tr><th>Name</th><th>Student ID</th><th>Date of birth</th><th>Class</th><th class="num">Owes</th></tr></thead>
      <tbody>${childRows}</tbody>
    </table>
    ${idsLine}
  </section>

  <section>
    <h2>Fees</h2>
    ${feeTable}
    <div class="balance">Your balance right now: ${familyBalanceLine}</div>
  </section>

  ${invoiceRows ? `<section>
    <h2>Bills still open</h2>
    <table><thead><tr><th>Child</th><th>Bill</th><th>Due</th><th class="num">Outstanding</th></tr></thead><tbody>${invoiceRows}</tbody></table>
  </section>` : ''}

  <section class="side2">
    <h2>Parents &amp; guardians we contact</h2>
    <table><thead><tr><th>Name</th><th>Relation</th><th>Phone</th><th>Email</th></tr></thead><tbody>${guardianRows}</tbody></table>
  </section>

  ${contactBlock}

  <section>
    <h2>Your parent portal — one account for the whole family</h2>
    <ul class="plain">${portalPoints.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
    <div class="signup">
      <img src="${qrDataUri}" alt="Parent portal QR code" />
      <div class="cap">${signupCopy}</div>
    </div>
  </section>

  <section>
    <h2>How to pay</h2>
    <ul class="pay">${payItems.join('')}</ul>
  </section>

  <div class="check"><b>Please check this sheet.</b> If a name is spelled differently, a date of birth or
  a phone number is wrong, a child is missing, a fee is not what you agreed, or a payment you have made
  is not showing — tell the office. It is much easier to fix now than at the end of the year.</div>

  <footer>${esc(schoolName)} · Correct as of ${esc(printedOn)} · Keep this for your records.</footer>
</div>
</body>
</html>`;
}
