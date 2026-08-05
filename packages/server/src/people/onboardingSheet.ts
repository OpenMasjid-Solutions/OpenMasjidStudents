// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The printable student onboarding sheet — one page the office hands a family when a child is added.
 *
 * It answers the four things a parent asks at that moment: is this what you have on file for my
 * child, what will I be charged, how do I see and pay it, and who do I tell if it is wrong. So it
 * carries the child's details and Student ID, the fee plans actually assigned to them, what they owe
 * today, a QR to the parent portal, and every way this masjid can take a payment.
 *
 * FORMAT — print-CSS HTML, not a generated PDF, deliberately and consistently with
 * `billing/statements.ts`. The app dropped `@react-pdf/renderer` in 0.45.0 (it was installed but
 * unused, and unused dependencies are pure supply-chain surface), and a headless browser is out of the
 * question on a Raspberry Pi. The browser's own Print dialog produces the PDF, which also means the
 * office gets a real print preview and page breaks it can see before it commits paper. Strings are
 * fixed English like the statement, for the same reason: this is a server-rendered artifact, not a
 * screen, and it has no i18next context.
 *
 * HONESTY — the sheet must never promise a payment route this install does not have. Three settings
 * decide what it says, and each is read here rather than assumed:
 *   • `stripeReady()`               — is there a Stripe account behind card payments at all?
 *   • `getExternalPaymentsEnabled()` — may the kiosk and the donation site take tuition? (Same flag
 *                                      the Fabric `info` method reports, so the sheet and the kiosk
 *                                      agree; §11.2.)
 *   • `getSelfRegistrationEnabled()` — can a parent make their own portal account? With that door
 *                                      shut a QR to /family/register is a dead end, so the sheet asks
 *                                      them to request an invite instead of printing a useless code.
 * Cash, check, Zelle and ACH are always offered: they need no integration, only the office.
 *
 * SECURITY — every dynamic value goes through `esc()` (§14: stored data is inert and always rendered
 * as text; a guardian name or a fee note is user input). The sheet carries a Student ID, guardian
 * contact details and a child's DOB, so it is served only to admin/finance through the same authed,
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
import { invoicePaid, invoiceTotal, studentBalance } from '../billing/ledger';
import { esc } from '../billing/statements';
import { getCurrency, getExternalPaymentsEnabled, getSchoolLogo, getSchoolName, getSelfRegistrationEnabled } from '../settings';
import { stripeReady } from '../payments/stripe';

const asDate = (v: unknown): string => {
  if (v == null) return '';
  const d = v instanceof Date ? v : new Date(v as number);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};

/** Whole years between an ISO date and today. Returns null for absent or unparseable input — DOB is
 *  optional by design (§14 data minimisation), and a sheet for a child without one just omits it. */
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

/** A row in the fee table: the plan, and what THIS child is actually charged for it. */
type SheetFee = { name: string; cadence: FeeCadence; effectiveCents: number; overridden: boolean; note: string | null };

export type StudentSheetData = {
  student: { id: string; fullName: string; studentCode: string | null; dob: string | null; status: 'active' | 'withdrawn'; addedOn: string };
  className: string | null;
  familyLabel: string;
  siblings: { fullName: string; studentCode: string | null }[];
  guardians: { name: string; relation: string | null; phone: string | null; email: string | null; emergency: boolean }[];
  contacts: { name: string; relation: string | null; phone: string | null }[];
  fees: SheetFee[];
  owedCents: number;
  creditCents: number;
  openInvoices: { label: string; dueDate: string | null; balanceCents: number }[];
};

/**
 * Gather everything the sheet prints. Split out from the rendering so the numbers can be tested
 * without parsing HTML — the fee amounts and the balance are the parts a parent will query at the
 * office desk, so they are the parts worth asserting directly.
 */
export function collectStudentSheet(studentId: string): StudentSheetData | null {
  const s = db
    .select({
      id: students.id, familyId: students.familyId, fullName: students.fullName, studentCode: students.studentCode,
      dob: students.dob, status: students.status, classId: students.classId, createdAt: students.createdAt,
    })
    .from(students)
    .where(eq(students.id, studentId))
    .get();
  if (!s) return null;

  const fam = db.select({ name: families.name }).from(families).where(eq(families.id, s.familyId)).get();

  // Course + class read as one label ("Hifz — Group B"): on a parent-facing sheet the class name
  // alone ("Group B") does not say what the child is actually studying.
  let className: string | null = null;
  if (s.classId) {
    const c = db
      .select({ cls: classes.name, course: courses.name })
      .from(classes)
      .leftJoin(courses, eq(courses.id, classes.courseId))
      .where(eq(classes.id, s.classId))
      .get();
    if (c) className = c.course ? `${c.course} — ${c.cls}` : c.cls;
  }

  const siblings = db
    .select({ fullName: students.fullName, studentCode: students.studentCode })
    .from(students)
    .where(and(eq(students.familyId, s.familyId), sql`${students.id} <> ${studentId}`))
    .orderBy(asc(students.fullName))
    .all();

  const gs = db
    .select({ name: guardians.name, phone: guardians.phone, email: guardians.email, relation: guardianFamilies.relation, emergency: guardianFamilies.isEmergencyContact })
    .from(guardianFamilies)
    .innerJoin(guardians, eq(guardians.id, guardianFamilies.guardianId))
    .where(eq(guardianFamilies.familyId, s.familyId))
    .orderBy(asc(guardians.name))
    .all();

  const contacts = db
    .select({ name: emergencyContacts.name, phone: emergencyContacts.phone, relation: emergencyContacts.relation })
    .from(emergencyContacts)
    .where(eq(emergencyContacts.familyId, s.familyId))
    .orderBy(asc(emergencyContacts.name))
    .all();

  // The effective amount is `override ?? plan amount` (§9) — the override is how a bursary or a
  // sibling rate is expressed, so printing the plan's list price instead would tell a family they owe
  // more than the office actually agreed with them.
  // Recurring commitments first, then per-term, then one-offs — a parent reads "what do I owe every
  // month" before "what was the book fee", and it puts the monthly lines immediately above the monthly
  // total. Alphabetical alone floated a one-time book fee above the tuition.
  const CADENCE_RANK: Record<FeeCadence, number> = { monthly: 0, per_term: 1, one_time: 2 };
  const fees: SheetFee[] = db
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
      effectiveCents: f.override ?? f.planCents,
      overridden: f.override != null && f.override !== f.planCents,
      note: f.note,
    }));

  const bal = studentBalance(studentId);

  const openInvoices = db
    .select({ id: invoices.id, label: invoices.label, dueDate: invoices.dueDate })
    .from(invoices)
    .where(and(eq(invoices.studentId, studentId), inArray(invoices.status, ['open', 'partially_paid'])))
    // Oldest-due-first, matching the ledger's allocation order. SQLite sorts NULL first, so undated
    // invoices are pushed last rather than to the top (same guard as statements.ts).
    .orderBy(sql`${invoices.dueDate} is null`, asc(invoices.dueDate), asc(invoices.createdAt))
    .all()
    .map((i) => ({ label: i.label, dueDate: i.dueDate, balanceCents: invoiceTotal(db, i.id) - invoicePaid(db, i.id) }))
    .filter((i) => i.balanceCents > 0);

  return {
    student: {
      id: s.id, fullName: s.fullName, studentCode: s.studentCode, dob: s.dob, status: s.status,
      addedOn: asDate(s.createdAt),
    },
    className,
    familyLabel: fam?.name ?? '',
    siblings,
    guardians: gs.map((g) => ({ name: g.name, relation: g.relation, phone: g.phone, email: g.email, emergency: !!g.emergency })),
    contacts,
    fees,
    owedCents: bal.owedCents,
    creditCents: bal.creditCents,
    openInvoices,
  };
}

/** What this install can actually accept, so the sheet only promises routes that exist. */
export type PayRoutes = { card: boolean; external: boolean; selfRegister: boolean };

export function payRoutes(): PayRoutes {
  return { card: stripeReady(), external: getExternalPaymentsEnabled(), selfRegister: getSelfRegistrationEnabled() };
}

/**
 * Render the onboarding sheet for one student. `baseUrl` is the origin the QR points at (the tunnel
 * public URL when set, else the LAN address the request arrived on). Returns null if there is no such
 * student. `routes`/`now` are injectable so tests can pin the configuration and the printed date.
 */
export async function buildStudentSheetHtml(
  studentId: string,
  baseUrl: string,
  routes: PayRoutes = payRoutes(),
  now: Date = new Date(),
): Promise<string | null> {
  const d = collectStudentSheet(studentId);
  if (!d) return null;

  const schoolName = getSchoolName();
  const logo = getSchoolLogo();
  const currency = getCurrency();
  const money = (c: number) => formatMoney(c, currency);
  const printedOn = asDate(now);
  const age = ageFromDob(d.student.dob, now);

  const origin = baseUrl.replace(/\/+$/, '');
  // With self-registration off, /family/register refuses the parent — so point the QR at the portal
  // itself and tell them to ask for an invite, rather than printing a code that leads to a wall.
  const qrTarget = routes.selfRegister ? `${origin}/family/register` : `${origin}/family`;
  const qrcode = (await import('qrcode')).default;
  const qrDataUri = await qrcode.toDataURL(qrTarget, { margin: 1, width: 240, errorCorrectionLevel: 'M' });

  const row = (label: string, value: string) =>
    `<tr><th scope="row">${esc(label)}</th><td>${value}</td></tr>`;

  const detailRows = [
    row('Full name', `<b>${esc(d.student.fullName)}</b>`),
    row('Student ID', `<span class="code">${esc(d.student.studentCode ?? '—')}</span>`),
    d.student.dob ? row('Date of birth', esc(age != null ? `${d.student.dob} (age ${age})` : d.student.dob)) : '',
    d.className ? row('Class', esc(d.className)) : '',
    row('Household', esc(d.familyLabel)),
    // Plain text, NOT a pre-escaped entity: `row()` escapes the label, so passing "&amp;" here printed
    // a literal "&amp;" on the sheet.
    d.siblings.length
      ? row('Brothers & sisters here', d.siblings.map((s) => `${esc(s.fullName)}${s.studentCode ? ` <span class="muted">(${esc(s.studentCode)})</span>` : ''}`).join(', '))
      : '',
    row('Status', d.student.status === 'withdrawn' ? '<span class="muted">Withdrawn</span>' : 'Enrolled'),
    row('On the system since', esc(d.student.addedOn)),
  ].filter(Boolean).join('');

  const feeRows = d.fees.length
    ? d.fees
        .map((f) => `<tr><td>${esc(f.name)}${f.note ? ` <span class="muted">(${esc(f.note)})</span>` : ''}</td><td>${esc(CADENCE_LABELS[f.cadence] ?? f.cadence)}</td><td class="num">${esc(money(f.effectiveCents))}${f.overridden ? ' <span class="tag">agreed rate</span>' : ''}</td></tr>`)
        .join('')
    : `<tr><td colspan="3" class="muted">No fees assigned yet — the office will confirm these with you.</td></tr>`;

  const monthlyTotal = d.fees.filter((f) => f.cadence === 'monthly').reduce((a, f) => a + f.effectiveCents, 0);
  const feeFoot = monthlyTotal > 0
    ? `<tr class="foot"><td colspan="2">Total each month</td><td class="num">${esc(money(monthlyTotal))}</td></tr>`
    : '';

  const balanceLine = d.owedCents > 0
    ? `<span class="owed">${esc(money(d.owedCents))}</span> due`
    : d.creditCents > 0
      ? `<span class="credit">${esc(money(d.creditCents))}</span> paid ahead — this comes off the next bill`
      : `<span class="settled">Nothing due</span>`;

  const invoiceRows = d.openInvoices.length
    ? d.openInvoices.map((i) => `<tr><td>${esc(i.label)}</td><td>${esc(i.dueDate || '—')}</td><td class="num">${esc(money(i.balanceCents))}</td></tr>`).join('')
    : '';

  const guardianRows = d.guardians.length
    ? d.guardians
        .map((g) => `<tr><td>${esc(g.name)}${g.emergency ? ' <span class="tag">emergency contact</span>' : ''}</td><td>${esc(g.relation ?? '—')}</td><td>${esc(g.phone ?? '—')}</td><td>${esc(g.email ?? '—')}</td></tr>`)
        .join('')
    : `<tr><td colspan="4" class="muted">No parent or guardian details on file — please give these to the office.</td></tr>`;

  const contactRows = d.contacts.length
    ? `<section>
    <h2>Emergency contacts</h2>
    <table><thead><tr><th>Name</th><th>Relation</th><th>Phone</th></tr></thead><tbody>${d.contacts
      .map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.relation ?? '—')}</td><td>${esc(c.phone ?? '—')}</td></tr>`)
      .join('')}</tbody></table>
  </section>`
    : '';

  // Every way this masjid can actually take tuition, in the order a parent is most likely to use it.
  // Each entry is conditional on the configuration above — an install with no Stripe account behind it
  // must not tell a family they can pay by card.
  const payItems: string[] = [];
  if (routes.card) {
    payItems.push(`<li><b>In the parent portal, by card.</b> Sign in and pay the whole balance or just part of it. You can save a card, and turn on <b>autopay</b> so tuition is paid automatically when it comes due — you can switch it off whenever you like.</li>`);
  }
  if (routes.external) {
    payItems.push(`<li><b>On the masjid website.</b> Go to the tuition section of the masjid's donations page, type your child's <b>Student ID</b>, check the name it shows you, and pay. You can pay for all of your children on the same screen — and you don't need an account for this.</li>`);
    payItems.push(`<li><b>At the kiosk in the masjid.</b> Choose tuition, enter the Student ID, confirm the name, and tap your card — <b>Apple Pay and Google Pay</b> work too.</li>`);
  }
  payItems.push(`<li><b>Cash, check, Zelle or bank transfer (ACH).</b> These go <b>through the office</b>. Please hand them to the office and make sure someone records it against your child — a payment nobody enters is a payment nobody can see. Ask for confirmation before you leave, and keep it.</li>`);
  if (d.student.studentCode) {
    payItems.push(`<li class="muted">Whichever way you pay, your child's Student ID is <b>${esc(d.student.studentCode)}</b>. It is what puts the money on the right child's record${d.siblings.length ? ' — each of your children has their own' : ''}.</li>`);
  }

  // The history bullet names only the channels this install actually has. Listing "card, the kiosk or
  // the website" on an office-only install describes a history the family can never have had, and
  // invites them to look for a way to pay that is not there.
  const ways = ['cash'];
  if (routes.card) ways.push('card');
  if (routes.external) ways.push('the kiosk', 'the masjid website');
  const historyPoint = ways.length > 1
    ? `Every payment you have made, however you made it — ${ways.slice(0, -1).join(', ')} or ${ways[ways.length - 1]} — all in one list`
    : 'Every payment the office has recorded for you, all in one list';

  const portalPoints = [
    'What each of your children owes, and what the household owes altogether',
    'Every bill, broken down line by line — so you can see the tuition and, say, a book fee separately',
    historyPoint,
  ];
  if (routes.card) {
    portalPoints.push('Pay by card, save a card, and set up autopay');
    portalPoints.push('A receipt by email each time a payment is recorded');
  }

  // The Student ID callout has to obey the same rules as the "How to pay" list. In the first draft it
  // named the kiosk and the website unconditionally, which meant an install with external payments
  // switched off printed a sheet telling parents to go and pay somewhere that would not serve them.
  const portalTail = routes.selfRegister ? ', and to set up your parent portal account' : '';
  const idCardCopy = routes.external
    ? `This is how a payment finds your child. You will need it to pay at the kiosk or on the masjid website${portalTail}.`
    : `This is how a payment finds your child — it is what puts the money on the right record when the office enters it${portalTail}.`;

  const signupCopy = routes.selfRegister
    ? `<b>Scan this to set up your account</b>
       You will need your child's Student ID (above) and an email address the office already has for you — that is how we know the account belongs to your family.
       <br /><span class="muted">${esc(qrTarget)}</span>`
    : `<b>Ask the office for a portal invite</b>
       Accounts here are set up by invitation. Give the office an email address and they will send you a link to choose your own password.
       <br /><span class="muted">${esc(qrTarget)}</span>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Student information — ${esc(d.student.fullName)}</title>
<style>
  :root { --ink:#1a1a1a; --teal:#0f766e; --line:#cbcbcb; --muted:#666; }
  * { box-sizing: border-box; }
  body { font: 14px/1.55 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--ink); margin: 0; padding: 24px; background: #fff; }
  .sheet { max-width: 760px; margin: 0 auto; }
  .toolbar { display: flex; justify-content: flex-end; margin-bottom: 16px; }
  .btn { font: inherit; padding: 8px 16px; border: 1px solid var(--teal); background: var(--teal); color: #fff; border-radius: 8px; cursor: pointer; }
  header { border-bottom: 2px solid var(--teal); padding-bottom: 12px; margin-bottom: 18px; }
  .brand { display: flex; align-items: center; gap: 12px; }
  .logo { max-height: 56px; max-width: 200px; width: auto; height: auto; }
  h1 { font-size: 22px; color: var(--teal); margin: 0; }
  .sub { color: var(--muted); margin-top: 2px; }
  .meta { display: flex; justify-content: space-between; align-items: baseline; margin-top: 10px; }
  .who { font-size: 17px; font-weight: 700; }
  .intro { margin: 16px 0 4px; }
  .idcard { display: flex; align-items: center; gap: 14px; margin: 16px 0; padding: 12px 16px; border: 1px solid var(--teal); border-radius: 8px; background: #f4faf8; }
  .idcard .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
  .idcard .code { font-size: 24px; }
  section { margin-top: 22px; page-break-inside: avoid; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 8px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line); font-size: 13px; vertical-align: top; }
  thead th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  tbody th[scope="row"] { width: 34%; color: var(--muted); font-weight: 400; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .foot td { font-weight: 700; border-bottom: none; }
  .code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; letter-spacing: 0.14em; font-weight: 700; }
  .muted { color: var(--muted); }
  .tag { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--teal); border: 1px solid var(--teal); border-radius: 4px; padding: 1px 5px; white-space: nowrap; }
  .owed { color: #b42318; font-weight: 700; }
  .credit, .settled { color: var(--teal); font-weight: 700; }
  .balance { margin: 10px 0 0; padding: 10px 14px; border: 1px solid var(--line); border-radius: 8px; font-size: 15px; }
  ul.pay { margin: 0; padding-left: 20px; }
  ul.pay li { margin-bottom: 8px; }
  ul.plain { margin: 0; padding-left: 20px; }
  ul.plain li { margin-bottom: 4px; }
  .signup { display: flex; gap: 18px; align-items: center; margin-top: 14px; padding: 14px; border: 1px dashed var(--teal); border-radius: 8px; page-break-inside: avoid; }
  .signup img { width: 140px; height: 140px; }
  .signup .cap { font-size: 13px; }
  .signup .cap b { display: block; font-size: 15px; margin-bottom: 4px; color: var(--ink); }
  .check { margin-top: 22px; padding: 12px 16px; border-left: 3px solid var(--teal); background: #f7f7f7; page-break-inside: avoid; }
  footer { margin-top: 26px; color: var(--muted); font-size: 12px; text-align: center; }
  @media print {
    body { padding: 0; }
    .toolbar { display: none; }
    .signup { border-color: #999; }
    .idcard, .balance, .check { background: #fff; }
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
        <div class="sub">Student information &amp; how to pay</div>
      </div>
    </div>
    <div class="meta"><span class="who">${esc(d.student.fullName)}</span><span class="muted">Printed ${esc(printedOn)}</span></div>
  </header>

  <p class="intro"><b>${esc(d.student.fullName)} is now on our system.</b> This sheet is your copy of what we hold
  for them, what the fees are, and every way you can pay. Please read it through and tell the office if
  anything is wrong or out of date.</p>

  <div class="idcard">
    <div>
      <div class="lbl">Student ID</div>
      <div class="code">${esc(d.student.studentCode ?? '—')}</div>
    </div>
    <div class="muted">${idCardCopy}</div>
  </div>

  <section>
    <h2>What we have on file</h2>
    <table><tbody>${detailRows}</tbody></table>
  </section>

  <section>
    <h2>Fees for ${esc(d.student.fullName)}</h2>
    <table>
      <thead><tr><th>Fee</th><th>How often</th><th class="num">Amount</th></tr></thead>
      <tbody>${feeRows}${feeFoot}</tbody>
    </table>
    <div class="balance">Right now: ${balanceLine}</div>
    ${invoiceRows ? `<table style="margin-top:10px"><thead><tr><th>Bill</th><th>Due</th><th class="num">Outstanding</th></tr></thead><tbody>${invoiceRows}</tbody></table>` : ''}
  </section>

  <section>
    <h2>Parents &amp; guardians we contact</h2>
    <table><thead><tr><th>Name</th><th>Relation</th><th>Phone</th><th>Email</th></tr></thead><tbody>${guardianRows}</tbody></table>
  </section>

  ${contactRows}

  <section>
    <h2>Your parent portal — and why it is worth setting up</h2>
    <p style="margin:0 0 8px">The portal is your own view of your family's account, on your phone. With an
    account you can see:</p>
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

  <div class="check"><b>Please check this sheet.</b> If a name is spelled differently, a date of birth or a
  phone number is wrong, a fee is not what you agreed, or a payment you have made is missing — tell the
  office. It is much easier to fix now than at the end of the year.</div>

  <footer>${esc(schoolName)} · Correct as of ${esc(printedOn)} · Keep this for your records.</footer>
</div>
</body>
</html>`;
}
