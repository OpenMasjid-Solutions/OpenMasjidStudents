// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * App-owned settings (CLAUDE.md §6 — NOT a masjid profile injected by the platform; this app
 * collects and owns its own config). Simple typed key/value over the `settings` table: school
 * name, currency, the external-tuition toggle, self-registration, SMTP, and the Stripe account.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { settings } from '../db/schema';

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
  autoInvoice: 'auto_invoice', // '1' → generate each month's invoices on a schedule (default OFF).
  autoInvoiceDay: 'auto_invoice_day', // day of month (1-28+) to generate on; clamped to the month.
  autoInvoiceDueDay: 'auto_invoice_due_day', // optional day of month to set as the invoice due date.
  autoInvoiceLast: 'auto_invoice_last', // the last periodKey generated — the job's own idempotency.
  // The first month this install bills for (0.43.0). A madrasa that goes live mid-year records what
  // each child brings with them as ONE carried-forward figure; generating the months before that would
  // then bill the same arrears a second time, so anything earlier is refused rather than discouraged.
  billingStartPeriod: 'billing_start_period',
  midYearDoneAt: 'midyear_committed_at', // ISO timestamp — the wizard has been run (hides the banner).
  parentEmails: 'parent_emails', // JSON {receipt, autopayFailure} — which emails PARENTS get (0.44.0).
  // The masjid's own logo, stored as a `data:` URI so it travels with the DB and needs no file
  // handling or attachment plumbing. Bounded and magic-byte checked on the way in (§14).
  schoolLogo: 'school_logo',
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
}

export function getParentEmails(): ParentEmailPrefs {
  const raw = getSetting(SETTING_KEYS.parentEmails);
  // Absent = an install that upgraded, which was sending both; defaulting to ON keeps the morning
  // after an update looking like the day before it.
  if (!raw) return { receipt: true, autopayFailure: true };
  try {
    const p = JSON.parse(raw) as Partial<ParentEmailPrefs>;
    return { receipt: p.receipt !== false, autopayFailure: p.autopayFailure !== false };
  } catch {
    return { receipt: true, autopayFailure: true };
  }
}

export function setParentEmails(patch: Partial<ParentEmailPrefs>): void {
  setSetting(SETTING_KEYS.parentEmails, JSON.stringify({ ...getParentEmails(), ...patch }));
}

/** When the mid-year go-live step was committed, or null. Only used to stop nagging about it. */
export function getMidYearDoneAt(): string | null {
  const v = getSetting(SETTING_KEYS.midYearDoneAt);
  return v && v.trim() ? v.trim() : null;
}
export function setMidYearDoneAt(iso: string): void {
  setSetting(SETTING_KEYS.midYearDoneAt, iso);
}
