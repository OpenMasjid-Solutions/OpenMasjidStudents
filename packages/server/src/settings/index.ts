// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * App-owned settings (CLAUDE.md §6 — NOT a masjid profile injected by the platform; this app
 * collects and owns its own config). Simple typed key/value over the `settings` table: school
 * name, currency, the external-tuition toggle, self-registration, notification policy, and the
 * Stripe account. NOT mail credentials — see the note on SETTING_KEYS below.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { settings } from '../db/schema';
import { DEFAULT_INVOICE_LABEL } from '../billing/period';

export const SETTING_KEYS = {
  schoolName: 'school_name',
  currency: 'currency',
  externalPayments: 'external_payments', // Donations/Kiosk tuition campaign on/off (§11.2 info.enabled)
  reconcileCursor: 'stripe_reconcile_cursor', // unix seconds — last reconciled PI created-time (§11.4)
  reconcileLast: 'stripe_reconcile_last', // JSON summary of the last reconcile run (for the finance UI)
  // NOTE: there is deliberately no `smtp` key. Email is OpenMasjidOS's job (POST /api/fabric/email) —
  // it owns the provider and the From address, so this app never holds mail credentials at all. An
  // upgraded install may still have a stale `smtp_config` row; it is simply never read.
  stripeAccount: 'stripe_account', // the OS-vault Stripe account id the admin picked for tuition (§10).
  // Empty → fall back to the STRIPE_ACCOUNT manifest default (resolved in payments/stripe.ts).
  selfRegistration: 'self_registration', // parent self-registration door on/off (§12, default ON).
  yearViewColumns: 'year_view_columns', // JSON string[] — optional columns on the year grid.
  // '0' → keep the fee-override note off the year grid (0.48.0). The note is the office's own words about
  // why a child pays less; see `getYearViewFeeNote`.
  yearViewFeeNote: 'year_view_fee_note',
  autoInvoice: 'auto_invoice', // '1' → generate each month's invoices on a schedule (default OFF).
  autoInvoiceDay: 'auto_invoice_day', // day of month (1-28+) to generate on; clamped to the month.
  autoInvoiceDueDay: 'auto_invoice_due_day', // optional day of month to set as the invoice due date.
  autoInvoiceLast: 'auto_invoice_last', // the last periodKey generated — the job's own idempotency.
  // What an invoice is CALLED, as a template with [month]/[year] tags (0.48.0). One place, so the office
  // writes their wording once and the manual form and the nightly job cannot disagree about it.
  invoiceLabel: 'invoice_label',
  // The first month this install bills for (0.43.0). A madrasa that goes live mid-year records what
  // each child brings with them as ONE carried-forward figure; generating the months before that would
  // then bill the same arrears a second time, so anything earlier is refused rather than discouraged.
  billingStartPeriod: 'billing_start_period',
  midYearDoneAt: 'midyear_committed_at', // ISO timestamp — the wizard has been run (hides the banner).
  parentEmails: 'parent_emails', // JSON {receipt, autopayFailure} — which emails PARENTS get (0.44.0).
  // '1' → send NOTHING to any parent, including invites and resets (0.48.0). The switch you throw
  // before working through a real roster; see `getParentMailPaused`.
  parentMailPaused: 'parent_mail_paused',
  // JSON — chasing overdue balances (0.48.0): whether parents are reminded, how long after the due date,
  // and how often. See `getPastDue`.
  pastDue: 'past_due',
  // ISO date of the last past-due digest sent to the office, so a daily job does not become a daily email.
  pastDueStaffLast: 'past_due_staff_last',
  // JSON — whether the PAYER covers Stripe's cut rather than the school (0.51.0). Off by default; the
  // math and the reasoning live in payments/fees.ts. See `getProcessingFee`.
  processingFee: 'processing_fee',
  // The masjid's own logo, stored as a `data:` URI so it travels with the DB and needs no file
  // handling or attachment plumbing. Bounded and magic-byte checked on the way in (§14).
  schoolLogo: 'school_logo',
  // How dates are written and read across the whole app (0.47.0). Storage stays ISO — see
  // settings/dates.ts for why only the two edges move.
  dateFormat: 'date_format',
  // JSON — the masjid's own address/phone/email/website, printed on the sheet and the statement and
  // put at the foot of every parent email (0.47.0). Carries `donatePath` too (0.48.0) — see
  // `donationUrl`, which is what a parent is told to type to pay online.
  schoolContact: 'school_contact',
  // JSON — the madrasah's own wording for the printed family sheet (0.48.0). A partial map of
  // people/sheetText.ts keys; anything absent uses the shipped sentence.
  sheetText: 'sheet_text',
  // The colour the printed artifacts are ruled in (0.47.0). One hex value; see `getAccentColor`.
  accentColor: 'accent_color',
  // JSON — WhatsApp (0.50.0): the master switch, the parent pause, the per-event toggles, the country
  // codes and the test student. See `getWhatsApp`; the event CATALOGUE lives in whatsapp/index.ts.
  whatsapp: 'whatsapp',
  // The office's own wording for the "we don't have your email address" message (0.50.0). One string;
  // blank means the shipped sentence. See whatsapp/templates.ts.
  whatsappEmailRequest: 'whatsapp_email_request',
  // JSON {textKey: string} — the madrasah's own wording for each WhatsApp message (0.50.0). A partial
  // map; anything absent uses the shipped sentence. Stored opaquely, like `sheet_text`.
  whatsappTexts: 'whatsapp_texts',
} as const;

/** Image types a logo may be. Kept to the three that every browser, print path and mail client
 *  renders — no SVG, which is script-capable and would be served back to browsers. */
export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
/** Decoded bytes. Comfortably more than a crisp letterhead logo needs, small enough that it can sit
 *  in a settings row and be inlined into a print sheet without bloating it. */
export const LOGO_MAX_BYTES = 512 * 1024;

/**
 * The school logo as a `data:` URI, or null. Validated on read as well as write: the value is
 * interpolated into printed HTML and served from an HTTP route, so a row edited by hand (or
 * surviving from an older build) must not become a way to inject something else.
 */
export function getSchoolLogo(): string | null {
  const v = getSetting(SETTING_KEYS.schoolLogo);
  return v && parseLogoDataUri(v) ? v : null;
}

/** Split a logo data URI into its parts, or null if it is not one we accept. */
export function parseLogoDataUri(value: string): { mime: (typeof LOGO_TYPES)[number]; bytes: Buffer } | null {
  const m = /^data:([a-z/+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(value.trim());
  if (!m) return null;
  const mime = m[1] as (typeof LOGO_TYPES)[number];
  if (!LOGO_TYPES.includes(mime)) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(m[2], 'base64');
  } catch {
    return null;
  }
  if (!bytes.length || bytes.length > LOGO_MAX_BYTES) return null;
  // Magic bytes, not the declared type: the content-type in a data URI is caller-supplied text, and
  // this value is later served with that type on a real HTTP response (§14 attachment rules).
  const isPng = bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isWebp = bytes.length > 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  const actual = isPng ? 'image/png' : isJpeg ? 'image/jpeg' : isWebp ? 'image/webp' : null;
  if (!actual || actual !== mime) return null;
  return { mime, bytes };
}

/** Save or clear the logo. Throws on anything that is not an accepted image. */
export function setSchoolLogo(dataUri: string | null): void {
  if (!dataUri) {
    setSetting(SETTING_KEYS.schoolLogo, '');
    return;
  }
  if (!parseLogoDataUri(dataUri)) throw new Error('invalid_logo');
  setSetting(SETTING_KEYS.schoolLogo, dataUri.trim());
}

export interface AutoInvoiceConfig {
  enabled: boolean;
  /** Day of the month to generate on. Clamped to the month's length at run time. */
  day: number;
  /** Optional day of the month to stamp as the due date; 0/absent = no due date. */
  dueDay: number | null;
}

/** The auto-invoice schedule. OFF by default — billing every family is not something to start
 *  happening on its own after an upgrade; an admin turns it on deliberately. */
export function getAutoInvoice(): AutoInvoiceConfig {
  const day = Number(getSetting(SETTING_KEYS.autoInvoiceDay) ?? '1');
  const dueDay = Number(getSetting(SETTING_KEYS.autoInvoiceDueDay) ?? '0');
  return {
    enabled: getSetting(SETTING_KEYS.autoInvoice) === '1',
    day: Number.isFinite(day) && day >= 1 && day <= 31 ? Math.trunc(day) : 1,
    dueDay: Number.isFinite(dueDay) && dueDay >= 1 && dueDay <= 31 ? Math.trunc(dueDay) : null,
  };
}

export function setAutoInvoice(cfg: { enabled?: boolean; day?: number; dueDay?: number | null }): void {
  if (cfg.enabled !== undefined) setSetting(SETTING_KEYS.autoInvoice, cfg.enabled ? '1' : '0');
  if (cfg.day !== undefined) setSetting(SETTING_KEYS.autoInvoiceDay, String(cfg.day));
  if (cfg.dueDay !== undefined) setSetting(SETTING_KEYS.autoInvoiceDueDay, cfg.dueDay === null ? '' : String(cfg.dueDay));
}

/** The last period the job generated, for the UI to show. */
export function getAutoInvoiceLast(): string | null {
  return getSetting(SETTING_KEYS.autoInvoiceLast);
}

/**
 * Optional columns the admin can switch on in the year view, beyond the fixed name / paying / month
 * grid.
 *
 * Contact details are split ONE COLUMN PER NUMBER (0.42.0) rather than the old single "guardian
 * phones" cell that crammed every number in behind a comma. A column headed "Father's" that you can
 * tap to ring is worth more to an office than a list, and a labelled column is the only way to know
 * whose number you are about to call. `other` is not a leftover: a guardian with no relation recorded —
 * every CSV-imported one — still has to appear somewhere, and dropping them would silently lose the
 * only number the school has.
 */
export const YEAR_VIEW_COLUMNS = [
  'studentId',
  'dob',
  'guardianNames',
  'fatherPhone',
  'motherPhone',
  'otherPhone',
  'emergencyPhone',
  'fatherEmail',
  'motherEmail',
  'otherEmail',
  'balance',
] as const;
export type YearViewColumn = (typeof YEAR_VIEW_COLUMNS)[number];

/** What the two pre-0.42.0 combined columns become, so an install that had them keeps showing exactly
 *  the same information the morning after an update — just in labelled columns. */
const LEGACY_COLUMNS: Record<string, YearViewColumn[]> = {
  guardianPhones: ['fatherPhone', 'motherPhone', 'otherPhone'],
  guardianEmails: ['fatherEmail', 'motherEmail', 'otherEmail'],
};

/** Phone numbers, in labelled columns — what an office keeps beside a payment grid. Everything else is
 *  opt-in, so a page that gets printed and left on a desk carries only what the admin asked for (§14). */
const DEFAULT_YEAR_VIEW_COLUMNS: YearViewColumn[] = ['fatherPhone', 'motherPhone', 'otherPhone'];

/** Which optional columns the year view shows. Saved values from before 0.42.0 are translated on read
 *  (see LEGACY_COLUMNS) rather than migrated in the database: a settings row is cheap to reinterpret,
 *  and doing it here means there is exactly one place that knows the old names. */
export function getYearViewColumns(): YearViewColumn[] {
  const raw = getSetting(SETTING_KEYS.yearViewColumns);
  if (!raw) return [...DEFAULT_YEAR_VIEW_COLUMNS];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [...DEFAULT_YEAR_VIEW_COLUMNS];
    const expanded = parsed.flatMap((c) => (typeof c === 'string' && LEGACY_COLUMNS[c] ? LEGACY_COLUMNS[c] : [c]));
    // Filter against the allow-list so a stale/hand-edited row can never widen what is exposed.
    return [...new Set(expanded.filter((c): c is YearViewColumn => (YEAR_VIEW_COLUMNS as readonly unknown[]).includes(c)))];
  } catch {
    return [...DEFAULT_YEAR_VIEW_COLUMNS];
  }
}

export function setYearViewColumns(cols: YearViewColumn[]): void {
  setSetting(SETTING_KEYS.yearViewColumns, JSON.stringify([...new Set(cols)]));
}

/**
 * Whether the year grid shows the fee-override note beside what a child pays (0.48.0).
 *
 * Not a column, which is why it is a switch of its own: the note is a chip inside the "Paying" cell, the
 * office's own words about why this child pays less than the plan — "sibling rate", "hardship, agreed with
 * the imam". That is exactly the kind of sentence some offices want in front of them while they work
 * through a year, and exactly the kind others do not want on a page that gets printed and left on a desk
 * (§14). Default ON, because that is how the grid behaved before the switch existed.
 */
export function getYearViewFeeNote(): boolean {
  return getSetting(SETTING_KEYS.yearViewFeeNote) !== '0';
}
export function setYearViewFeeNote(on: boolean): void {
  setSetting(SETTING_KEYS.yearViewFeeNote, on ? '1' : '0');
}

export function getSetting(key: string): string | null {
  return db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get()?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  const ts = new Date();
  const existing = db.select({ key: settings.key }).from(settings).where(eq(settings.key, key)).get();
  if (existing) db.update(settings).set({ value, updatedAt: ts }).where(eq(settings.key, key)).run();
  else db.insert(settings).values({ key, value, updatedAt: ts }).run();
}

export function getSchoolName(): string {
  return getSetting(SETTING_KEYS.schoolName) || 'Our Madrasa';
}
export function getCurrency(): string {
  return getSetting(SETTING_KEYS.currency) || 'usd';
}
/** External (Donations/Kiosk) tuition payments — on unless the admin turned them off. */
export function getExternalPaymentsEnabled(): boolean {
  return getSetting(SETTING_KEYS.externalPayments) !== '0';
}

/** Parent self-registration door (§12) — ON unless the admin turned it off. (It's additionally gated
 *  on SMTP + a public URL at the procedure, since the verify link is emailed.) */
export function getSelfRegistrationEnabled(): boolean {
  return getSetting(SETTING_KEYS.selfRegistration) !== '0';
}

/** Transactional email (SMTP) config — app-owned, in the DB (§4/§10). `pass` is a secret: never log
 *  it, never return it to the client. */
/** The stored SMTP config, or null when unconfigured (host + from are the minimum to send). */
/** The OS-vault Stripe account id the admin chose for tuition, or '' to use the manifest default
 *  (payments/stripe.ts resolves the fallback). This is an account REFERENCE, not a secret. */
export function getChosenStripeAccount(): string {
  return getSetting(SETTING_KEYS.stripeAccount) ?? '';
}
export function setChosenStripeAccount(id: string): void {
  setSetting(SETTING_KEYS.stripeAccount, id);
}

/**
 * The first month this install bills for, or null when it has always billed everything (0.43.0).
 *
 * Set by the mid-year go-live step, and then enforced on every generation path. It exists because the
 * one way to double-bill a madrasa that started in February is to record the autumn as one carried-in
 * figure and THEN generate September out of habit — the arrears would be counted twice, and the second
 * copy looks exactly as legitimate as the first. Refusing the earlier month is the only version of that
 * protection an office cannot forget about.
 */
/**
 * How an invoice is NAMED, as a template (0.48.0).
 *
 * Stored so the office writes their wording once — "Tuition — [month] [year]", or whatever their madrasah
 * calls it — and both the manual Generate form and the nightly job produce the same thing. The tags are
 * resolved by `resolveInvoiceLabel` (billing/period.ts) from the period key itself, so the label and the
 * month an invoice is filed under cannot drift apart.
 */
export function getInvoiceLabelTemplate(): string {
  return getSetting(SETTING_KEYS.invoiceLabel)?.trim() || DEFAULT_INVOICE_LABEL;
}
export function setInvoiceLabelTemplate(template: string): void {
  // Blank clears it back to the default rather than storing nothing: an invoice with no name is a blank
  // line on a parent's bill, and it cannot be corrected afterwards (money history is not edited, §9).
  setSetting(SETTING_KEYS.invoiceLabel, template.trim());
}

export function getBillingStartPeriod(): string | null {
  const v = getSetting(SETTING_KEYS.billingStartPeriod);
  return v && v.trim() ? v.trim() : null;
}
export function setBillingStartPeriod(periodKey: string | null): void {
  setSetting(SETTING_KEYS.billingStartPeriod, periodKey ?? '');
}

/**
 * Which emails PARENTS receive (0.44.0). Both default ON.
 *
 * Only the discretionary ones are here. Invites and password resets are deliberately absent and always
 * send: they are not notifications, they are the only way a parent can reach their account at all, and
 * a switch that can turn them off is a support call waiting to happen.
 */
export interface ParentEmailPrefs {
  /** A receipt whenever money lands, whichever way it arrived (portal, autopay, kiosk, cash). */
  receipt: boolean;
  /** "We couldn't charge your card" + the third-strike "autopay is now off" (§13.3). */
  autopayFailure: boolean;
  /**
   * The four added in 0.50.0, all defaulting OFF — see the note below on why the split matters.
   *
   * `invoiceReady`: this month's bill has been generated. The biggest gap in the app: a parent heard
   * nothing at all between one receipt and the past-due reminder that followed a bill they were never
   * told about.
   */
  invoiceReady: boolean;
  /** "We'll charge your saved card on Tuesday" — a few days before autopay runs, so it is not a
   *  surprise on a statement and there is time to move money or turn it off. */
  autopayUpcoming: boolean;
  /** A saved card is about to expire, which is how autopay silently stops working. */
  cardExpiring: boolean;
  /** Money went back to the family. Rare, and worth confirming in writing. */
  refund: boolean;
}

/**
 * TWO DIFFERENT DEFAULTS IN ONE FUNCTION, and the difference is the whole rule.
 *
 * `receipt` and `autopayFailure` default ON because an install that upgraded was already sending
 * them: defaulting to OFF would silently stop mail a madrasah relies on. Everything added since
 * defaults OFF because it is a NEW message — turning it on by default would mean a madrasah that
 * updated on a Tuesday started emailing two hundred families on the Wednesday without anyone deciding
 * to, which is the worst surprise this app could produce. The office switches each one on.
 */
const PARENT_EMAIL_DEFAULTS: ParentEmailPrefs = {
  receipt: true,
  autopayFailure: true,
  invoiceReady: false,
  autopayUpcoming: false,
  cardExpiring: false,
  refund: false,
};

export function getParentEmails(): ParentEmailPrefs {
  const raw = getSetting(SETTING_KEYS.parentEmails);
  if (!raw) return { ...PARENT_EMAIL_DEFAULTS };
  try {
    const p = JSON.parse(raw) as Partial<ParentEmailPrefs>;
    return {
      // `!== false` for the two that ship on: an upgraded row has neither key and must keep sending.
      receipt: p.receipt !== false,
      autopayFailure: p.autopayFailure !== false,
      // `=== true` for the rest: absent means an office that has never been asked, which is off.
      invoiceReady: p.invoiceReady === true,
      autopayUpcoming: p.autopayUpcoming === true,
      cardExpiring: p.cardExpiring === true,
      refund: p.refund === true,
    };
  } catch {
    return { ...PARENT_EMAIL_DEFAULTS };
  }
}

export function setParentEmails(patch: Partial<ParentEmailPrefs>): void {
  setSetting(SETTING_KEYS.parentEmails, JSON.stringify({ ...getParentEmails(), ...patch }));
}

/**
 * The master stop: send NOTHING to any parent while this is on (0.48.0).
 *
 * It exists for one situation, and it is a real one — an office setting the app up with their ACTUAL
 * roster in it, complete with real addresses, trying out an import, a payment, an autopay run. Every one
 * of those paths emails somebody. There was no way to hold that back, and "we accidentally emailed 200
 * families a receipt for a test payment" is not a mistake anybody can take back.
 *
 * Unlike `ParentEmailPrefs` this DELIBERATELY OVERRIDES the always-send messages too — invites and
 * password resets. Those are exempt from the per-type switches for a good reason (they are the only way
 * a parent reaches their account, so a switch that stops them is a support call), but that reasoning is
 * about an install in service. A kill switch that let invites through would not be a kill switch, and
 * an invite is the single most embarrassing thing to send by accident.
 *
 * Consequences are made VISIBLE rather than silent: every skipped send reports `parents_paused`, the
 * office still gets the copy/print link for an invite or a reset, and Settings says the switch is on.
 * Default OFF — an install in service must behave as it always has.
 */
export function getParentMailPaused(): boolean {
  return getSetting(SETTING_KEYS.parentMailPaused) === '1';
}
export function setParentMailPaused(on: boolean): void {
  setSetting(SETTING_KEYS.parentMailPaused, on ? '1' : '0');
}

/**
 * Chasing an overdue balance (0.48.0).
 *
 * `parentEmails` DEFAULTS OFF, and that is deliberate in a way the other parent switches are not. Every
 * other one describes a message the app was already sending; this is a NEW message. Turning it on by
 * default would mean a madrasah that updated on a Tuesday started emailing two hundred families about
 * money on the Wednesday, without anyone deciding to — the worst surprise this app could produce. The
 * office switches it on, and Settings shows them how many families it would write to first.
 *
 * `graceDays` is why a reminder is not simply "due date passed": a bill due on the 1st, chased on the
 * 2nd, tells a family who paid on the 3rd every month that the school is not paying attention.
 *
 * `everyDays` is the cadence, per household, and it is the load-bearing one. A daily job that emails
 * every overdue family every day is not a reminder — it is what gets a school's mail marked as spam,
 * and it takes the invites and the receipts down with it (see `past_due_reminders`).
 */
export interface PastDueConfig {
  /** Email the parents of an overdue household. Off until an office turns it on. */
  parentEmails: boolean;
  /** Days after the due date before anything is said. */
  graceDays: number;
  /** Minimum days between reminders to the same household — and between office digests. */
  everyDays: number;
  /** Ignore anything smaller than this, in cents. A 40¢ rounding tail is not worth an email. */
  minAmountCents: number;
}

const PAST_DUE_DEFAULTS: PastDueConfig = { parentEmails: false, graceDays: 3, everyDays: 7, minAmountCents: 100 };

/** Bounds, not preferences: a 0-day cadence would email daily, and both extremes are a support call. */
const clampDays = (v: unknown, fallback: number, max: number): number => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= max ? n : fallback;
};

export function getPastDue(): PastDueConfig {
  const raw = getSetting(SETTING_KEYS.pastDue);
  if (!raw) return { ...PAST_DUE_DEFAULTS };
  try {
    const p = JSON.parse(raw) as Partial<PastDueConfig>;
    return {
      parentEmails: p.parentEmails === true,
      graceDays: clampDays(p.graceDays, PAST_DUE_DEFAULTS.graceDays, 90),
      // Never 0: that is a daily email to a family about money, which nobody means to ask for.
      everyDays: Math.max(1, clampDays(p.everyDays, PAST_DUE_DEFAULTS.everyDays, 90)),
      minAmountCents: clampDays(p.minAmountCents, PAST_DUE_DEFAULTS.minAmountCents, 1_000_000),
    };
  } catch {
    return { ...PAST_DUE_DEFAULTS };
  }
}

export function setPastDue(patch: Partial<PastDueConfig>): void {
  setSetting(SETTING_KEYS.pastDue, JSON.stringify({ ...getPastDue(), ...patch }));
}

/**
 * Does the PAYER cover Stripe's cut, or does the school? (0.51.0)
 *
 * Off by default and that is not a shrug — turning it on changes what every parent is charged, so it
 * has to be a decision somebody made rather than a default they inherited in an update. The math is in
 * payments/fees.ts, which is also where the compliance note lives; this is only the stored policy.
 *
 * The card and bank rates are SEPARATE and the bank one has its own switch, because they are not
 * remotely the same cost: 2.9% + 30¢ against 0.8% capped at $5. An office may reasonably pass on the
 * card cost and absorb the bank one, and on a $2,000 term payment the difference between the two rates
 * is fifty-five dollars of somebody's money.
 *
 * The defaults are Stripe's own published US rates, so an office that switches this on without reading
 * anything is charging what it is actually being charged.
 */
export interface ProcessingFeeConfig {
  /** The master switch. Off means every quote in the app is the identity — no code path changes. */
  enabled: boolean;
  /** Card rate in basis points (290 = 2.9%) and the per-charge fixed part, in cents. */
  cardPercentBps: number;
  cardFixedCents: number;
  /** US bank account (ACH) — its own switch, because absorbing this one is a reasonable choice. */
  bankEnabled: boolean;
  bankPercentBps: number;
  bankFixedCents: number;
  /** ACH is capped by Stripe. Without honouring the cap a large payment would be charged a percentage
   *  of a fee that stopped growing — money taken for nothing. 0 means uncapped. */
  bankCapCents: number;
}

const FEE_DEFAULTS: ProcessingFeeConfig = {
  enabled: false,
  cardPercentBps: 290,
  cardFixedCents: 30,
  bankEnabled: false,
  bankPercentBps: 80,
  bankFixedCents: 0,
  bankCapCents: 500,
};

/**
 * A hard ceiling on the percentage, not a preference.
 *
 * 10% is far above any real cost of card acceptance, which is the thing the card networks actually cap
 * a passed-on fee at (see payments/fees.ts). Its job is to stop a typo — a `2900` meant as 2.9% —
 * from adding $290 to a $100 bill and taking it off a family's card before anybody notices.
 */
const MAX_FEE_BPS = 1000;

const clampBps = (v: unknown, fallback: number): number => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= MAX_FEE_BPS ? n : fallback;
};

const clampCents = (v: unknown, fallback: number, max: number): number => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= max ? n : fallback;
};

export function getProcessingFee(): ProcessingFeeConfig {
  const raw = getSetting(SETTING_KEYS.processingFee);
  if (!raw) return { ...FEE_DEFAULTS };
  try {
    const p = JSON.parse(raw) as Partial<ProcessingFeeConfig>;
    return {
      enabled: p.enabled === true,
      cardPercentBps: clampBps(p.cardPercentBps, FEE_DEFAULTS.cardPercentBps),
      // A fixed part above a few dollars is a typo, not a payment processor's pricing.
      cardFixedCents: clampCents(p.cardFixedCents, FEE_DEFAULTS.cardFixedCents, 1000),
      bankEnabled: p.bankEnabled === true,
      bankPercentBps: clampBps(p.bankPercentBps, FEE_DEFAULTS.bankPercentBps),
      bankFixedCents: clampCents(p.bankFixedCents, FEE_DEFAULTS.bankFixedCents, 1000),
      bankCapCents: clampCents(p.bankCapCents, FEE_DEFAULTS.bankCapCents, 100_000),
    };
  } catch {
    return { ...FEE_DEFAULTS };
  }
}

export function setProcessingFee(patch: Partial<ProcessingFeeConfig>): void {
  setSetting(SETTING_KEYS.processingFee, JSON.stringify({ ...getProcessingFee(), ...patch }));
}

/** The last day the office's own past-due digest went out, or null. */
export function getPastDueStaffLast(): string | null {
  const v = getSetting(SETTING_KEYS.pastDueStaffLast);
  return v && v.trim() ? v.trim() : null;
}
export function setPastDueStaffLast(iso: string): void {
  setSetting(SETTING_KEYS.pastDueStaffLast, iso);
}

/**
 * How to reach the masjid (0.47.0). Every field optional — a madrasah that only wants to print a
 * phone number should not have to invent an address.
 *
 * It exists because the printed sheet, the statement and every parent email all end with some version
 * of "tell the office", and until now none of them said HOW. A parent holding a sheet at home with a
 * question about a fee had no number on it.
 */
export interface SchoolContact {
  address: string;
  phone: string;
  email: string;
  website: string;
  /**
   * Where tuition is paid online, relative to `website` — `/donate`, `/donations`, `/tuition`, whatever
   * this madrasah's donations page is called (0.48.0). A value that does NOT start with `/` is treated as
   * a complete address instead, because a madrasah whose donations page lives on another domain
   * (`donate.example.org`) still has to be able to print the right thing.
   *
   * It exists because the sheet tells a parent to pay "on the madrasah's website" and then never said
   * which page — and only the masjid knows, since the Donations app is on their own domain under a path
   * they chose. See `donationUrl`.
   */
  donatePath: string;
}

const EMPTY_CONTACT: SchoolContact = { address: '', phone: '', email: '', website: '', donatePath: '' };

export function getSchoolContact(): SchoolContact {
  const raw = getSetting(SETTING_KEYS.schoolContact);
  if (!raw) return { ...EMPTY_CONTACT };
  try {
    const p = JSON.parse(raw) as Partial<SchoolContact>;
    // Coerced field by field: this value is interpolated into printed HTML and email bodies, so a
    // hand-edited row must not be able to put a non-string (or a nested object) in front of `esc()`.
    return {
      address: typeof p.address === 'string' ? p.address : '',
      phone: typeof p.phone === 'string' ? p.phone : '',
      email: typeof p.email === 'string' ? p.email : '',
      website: typeof p.website === 'string' ? p.website : '',
      donatePath: typeof p.donatePath === 'string' ? p.donatePath : '',
    };
  } catch {
    return { ...EMPTY_CONTACT };
  }
}

/**
 * The address a parent types to pay tuition online, or '' when this install has not said (0.48.0).
 *
 * Printed in parentheses after "on the madrasah's website" — on the family sheet and the statement — so a
 * parent reading it at home has somewhere to go. Two deliberate details:
 *
 *  • A `donatePath` that does not begin with `/` is used AS the whole address, so a donations page on
 *    another domain still prints correctly and does not get glued onto the school's homepage.
 *  • The `https://` is dropped. This is print copy, not a link: a parent types it into a phone, and the
 *    scheme is noise there. The contact line at the foot of the page still shows the website exactly as
 *    the office typed it — that block is their letterhead, and not ours to tidy.
 */
export function donationUrl(c: SchoolContact = getSchoolContact()): string {
  const bare = (v: string) => v.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const path = bare(c.donatePath);
  // Is this a whole address or a path? Decided by whether its first segment looks like a HOST — a dot
  // before any slash. `donate.example.org/tuition` is somewhere else; `donate` and `/donate` are both a
  // page on this madrasah's own site. Leaning that way on purpose: an office that types "donate" without
  // the slash means the page, and gluing it to nothing would print the single word "donate".
  if (path && path.split('/')[0].includes('.')) return path;
  const site = bare(c.website);
  if (!site) return ''; // a path with no site is not an address; print nothing rather than "/donate"
  return path ? `${site}/${path.replace(/^\/+/, '')}` : site;
}

export function setSchoolContact(patch: Partial<SchoolContact>): void {
  const next = { ...getSchoolContact(), ...patch };
  setSetting(SETTING_KEYS.schoolContact, JSON.stringify(next));
}

/**
 * The madrasah's own wording for the printed family sheet — a partial map of people/sheetText.ts keys
 * (0.48.0).
 *
 * Stored OPAQUELY here on purpose: this module knows nothing about which keys exist, so the registry stays
 * in one place next to the sheet itself and adding a sentence there needs no change in settings. Unknown
 * keys are simply never read back, and the tRPC boundary validates against the real list.
 *
 * Values are trimmed and capped on the way out as well as in. A settings row can be edited by hand, and
 * this text is interpolated into a printed page (§14 — it is escaped at render, but there is no reason to
 * let a hand-edited row put a hundred kilobytes on a parent's sheet either).
 */
const SHEET_TEXT_CAP = 1000;

export function getSheetTextOverrides(): Record<string, string> {
  const raw = getSetting(SETTING_KEYS.sheetText);
  if (!raw) return {};
  try {
    const p = JSON.parse(raw) as unknown;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (typeof v !== 'string') continue;
      const text = v.trim().slice(0, SHEET_TEXT_CAP);
      if (text) out[k] = text;
    }
    return out;
  } catch {
    return {};
  }
}

/** Merge in changed boxes. A key set to `''` or `null` is REMOVED rather than stored blank — clearing the
 *  field in Settings means "use the shipped sentence again", and an empty string stored as wording would
 *  print a blank line on a family's sheet. */
export function setSheetTextOverrides(patch: Record<string, string | null | undefined>): void {
  const next = getSheetTextOverrides();
  for (const [k, v] of Object.entries(patch)) {
    const text = (v ?? '').trim().slice(0, SHEET_TEXT_CAP);
    if (text) next[k] = text;
    else delete next[k];
  }
  setSetting(SETTING_KEYS.sheetText, Object.keys(next).length ? JSON.stringify(next) : '');
}

/** The teal every printed artifact has been ruled in since the first statement. */
export const DEFAULT_ACCENT = '#0f766e';

/**
 * The masjid's colour, used for the rules, headings and boxes on printed artifacts (0.47.0).
 *
 * VALIDATED ON READ, not just on write, and that is not paranoia: this value is interpolated straight
 * into a `<style>` block on a page served to a browser, so a row edited by hand (or surviving from an
 * older build) must not be able to close the declaration and add its own CSS. Only `#rgb` / `#rrggbb`
 * gets through; anything else falls back to the default rather than being passed along.
 */
export function getAccentColor(): string {
  const v = (getSetting(SETTING_KEYS.accentColor) ?? '').trim();
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v) ? v : DEFAULT_ACCENT;
}

export function setAccentColor(hex: string | null): void {
  const v = (hex ?? '').trim();
  if (v && !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) throw new Error('invalid_colour');
  setSetting(SETTING_KEYS.accentColor, v);
}

/**
 * A very pale wash of the accent, for the tinted panels on the sheet.
 *
 * `color-mix` in sRGB rather than a hand-computed tint: it follows whatever accent is set without a
 * second setting to keep in step, and every browser that can print these pages supports it. The
 * printed rules already force these panels to white (toner), so this only affects the on-screen
 * preview and a colour print.
 */
export function accentWash(accent: string = getAccentColor()): string {
  return `color-mix(in srgb, ${accent} 7%, #ffffff)`;
}

/**
 * WhatsApp (0.50.0) — everything an office decides about it, in one row.
 *
 * THREE DEFAULTS HERE ARE THE FEATURE, not preferences:
 *
 *  • `enabled: false`. A masjid that updates on a Tuesday must not start messaging families on the
 *    Wednesday. Nothing is offered until an admin turns it on, and the switch is beside the sentence
 *    explaining that the linked number carries real risk.
 *  • `paused: true` — ON by default, unlike the email pause which is off by default. That asymmetry is
 *    deliberate: parent EMAIL is a channel every install has been using for releases, so pausing it by
 *    default would break working installs. WhatsApp has never sent anything, so the safe starting
 *    state is "configured but silent" — set it up, look at it, send a test to the test student, and
 *    only then let it reach two hundred families.
 *  • every event off. Same reason, one level down.
 *
 * `events` is stored OPAQUELY (a plain string→bool map) so this module knows nothing about which
 * events exist — whatsapp/index.ts owns that catalogue, exactly as alerts/index.ts owns the alert one.
 * Adding an event needs no change here.
 */
export interface WhatsAppConfig {
  /** The master switch. Off = the feature does not exist for this masjid. */
  enabled: boolean;
  /** Send nothing to parents. On by default; the test student's household is the one exception. */
  paused: boolean;
  /** Per-event, by our own event id. Absent = off. */
  events: Record<string, boolean>;
  /** The country code a number is assumed to be in when nothing more specific is recorded. */
  defaultCountry: string;
  /** The codes the office can pick from, per guardian and per staff member. Always includes the default. */
  countries: string[];
  /**
   * A real student whose household receives messages EVEN WHILE PAUSED (0.50.0).
   *
   * For notification purposes only — it changes nothing about billing, invoices or the ledger, and the
   * child is an ordinary student in every other respect. It exists because the alternative way to test
   * a message is to unpause and hope, and the office's own child is the right person to send a test
   * receipt to. It overrides the PAUSE and nothing else: not the master switch, not an event that is
   * off, and never an opt-out (whatsapp/index.ts).
   */
  testStudentId: string;
  /**
   * Which STAFF ALERTS go to which approved WhatsApp group (0.50.0) — "the finance group gets every
   * payment alert", keyed by the opaque group id the platform gave us.
   *
   * `detail` is the load-bearing field and it defaults to FALSE. A staff alert has two texts (§9): the
   * one that may name a household and an amount, and the de-identified one for third-party sinks. A
   * group is somewhere in between — an admin approved it and chose these events, which is the same
   * deliberate act as typing an address into the alert list, but this app cannot see who is IN the
   * group and an admin can subscribe the wrong one. So the safe half is the default: turning `detail`
   * on is a decision made in front of a sentence explaining it, and the cost of getting it wrong the
   * other way is one click rather than two hundred parents reading a family's balance.
   */
  groupAlerts: Record<string, { events: string[]; detail: boolean }>;
}

/** `+1` unless the office says otherwise — this app's first madāris are North American, and a wrong
 *  default is visible and one click to fix, whereas no default means every number fails silently. */
const WA_DEFAULTS: WhatsAppConfig = { enabled: false, paused: true, events: {}, defaultCountry: '+1', countries: ['+1'], testStudentId: '', groupAlerts: {} };

/** A country code as we store it: `+` and 1–3 digits. Anything else is dropped rather than stored, since
 *  it is glued onto the front of a real phone number and a bad one silently messages a stranger. */
export function isCountryCode(v: unknown): v is string {
  return typeof v === 'string' && /^\+\d{1,3}$/.test(v.trim());
}

export function getWhatsApp(): WhatsAppConfig {
  const raw = getSetting(SETTING_KEYS.whatsapp);
  if (!raw) return { ...WA_DEFAULTS, events: {}, countries: [...WA_DEFAULTS.countries], groupAlerts: {} };
  try {
    const p = JSON.parse(raw) as Partial<WhatsAppConfig>;
    const defaultCountry = isCountryCode(p.defaultCountry) ? p.defaultCountry.trim() : WA_DEFAULTS.defaultCountry;
    const countries = [...new Set([defaultCountry, ...(Array.isArray(p.countries) ? p.countries.filter(isCountryCode).map((c) => c.trim()) : [])])];
    const events: Record<string, boolean> = {};
    if (p.events && typeof p.events === 'object' && !Array.isArray(p.events)) {
      for (const [k, v] of Object.entries(p.events as Record<string, unknown>)) if (v === true) events[k] = true;
    }
    return {
      enabled: p.enabled === true,
      // Absent reads as PAUSED, which is the safe direction: a half-written row must not start sending.
      paused: p.paused !== false,
      events,
      defaultCountry,
      countries,
      testStudentId: typeof p.testStudentId === 'string' ? p.testStudentId.trim() : '',
      groupAlerts: readGroupAlerts(p.groupAlerts),
    };
  } catch {
    return { ...WA_DEFAULTS, events: {}, countries: [...WA_DEFAULTS.countries], groupAlerts: {} };
  }
}

/** Coerce a hand-edited or older `groupAlerts` row into shape. Unknown event ids are left alone here —
 *  whatsapp/index.ts owns the catalogue and filters against it, exactly as `alert_recipients` does. */
function readGroupAlerts(raw: unknown): Record<string, { events: string[]; detail: boolean }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, { events: string[]; detail: boolean }> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const g = v as { events?: unknown; detail?: unknown };
    const events = Array.isArray(g.events) ? g.events.filter((e): e is string => typeof e === 'string') : [];
    // Nothing subscribed means nothing to store; and `detail` is opt-in, never inferred.
    if (events.length) out[id] = { events, detail: g.detail === true };
  }
  return out;
}

export function setWhatsApp(patch: Partial<WhatsAppConfig>): void {
  const next = { ...getWhatsApp(), ...patch };
  // Merged rather than replaced, so a screen that only knows about three events cannot clear a fourth.
  if (patch.events) next.events = { ...getWhatsApp().events, ...patch.events };
  // Group subscriptions are merged the same way, and a group with no events is REMOVED rather than
  // stored empty — an approval that was withdrawn should not leave a row behind claiming a setting.
  if (patch.groupAlerts) {
    const merged = { ...getWhatsApp().groupAlerts, ...patch.groupAlerts };
    next.groupAlerts = Object.fromEntries(Object.entries(merged).filter(([, v]) => v.events.length > 0));
  }
  setSetting(SETTING_KEYS.whatsapp, JSON.stringify(next));
}

/** The office's own wording for the missing-email message, or '' for the shipped sentence. Capped for
 *  the same reason the sheet text is: it is prose typed into a box, not a document store. */
export const WA_TEXT_MAX = 900;

export function getWhatsAppEmailRequest(): string {
  return (getSetting(SETTING_KEYS.whatsappEmailRequest) ?? '').trim().slice(0, WA_TEXT_MAX);
}
export function setWhatsAppEmailRequest(text: string | null): void {
  setSetting(SETTING_KEYS.whatsappEmailRequest, (text ?? '').trim().slice(0, WA_TEXT_MAX));
}

/**
 * The madrasah's own wording for each WhatsApp message (0.50.0).
 *
 * Stored OPAQUELY — this module knows nothing about which messages exist, so the catalogue and the
 * shipped sentences stay in whatsapp/templates.ts next to the code that renders them, exactly as
 * `sheet_text` keeps the printed sheet's registry beside the sheet. Unknown keys are never read back,
 * and the tRPC boundary validates against the real list.
 *
 * A key set to '' is REMOVED rather than stored blank: clearing the box in Settings means "use our
 * sentence again", and empty wording would send a family an empty message.
 */
export function getWhatsAppTexts(): Record<string, string> {
  const raw = getSetting(SETTING_KEYS.whatsappTexts);
  if (!raw) return {};
  try {
    const p = JSON.parse(raw) as unknown;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (typeof v !== 'string') continue;
      const text = v.trim().slice(0, WA_TEXT_MAX);
      if (text) out[k] = text;
    }
    return out;
  } catch {
    return {};
  }
}

export function setWhatsAppTexts(patch: Record<string, string | null | undefined>): void {
  const next = getWhatsAppTexts();
  for (const [k, v] of Object.entries(patch)) {
    const text = (v ?? '').trim().slice(0, WA_TEXT_MAX);
    if (text) next[k] = text;
    else delete next[k];
  }
  setSetting(SETTING_KEYS.whatsappTexts, Object.keys(next).length ? JSON.stringify(next) : '');
}

/** When the mid-year go-live step was committed, or null. Only used to stop nagging about it. */
export function getMidYearDoneAt(): string | null {
  const v = getSetting(SETTING_KEYS.midYearDoneAt);
  return v && v.trim() ? v.trim() : null;
}
export function setMidYearDoneAt(iso: string): void {
  setSetting(SETTING_KEYS.midYearDoneAt, iso);
}
