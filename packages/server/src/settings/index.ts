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
  // '1' → send NOTHING to any parent, including invites and resets (0.48.0). The switch you throw
  // before working through a real roster; see `getParentMailPaused`.
  parentMailPaused: 'parent_mail_paused',
  // The masjid's own logo, stored as a `data:` URI so it travels with the DB and needs no file
  // handling or attachment plumbing. Bounded and magic-byte checked on the way in (§14).
  schoolLogo: 'school_logo',
  // How dates are written and read across the whole app (0.47.0). Storage stays ISO — see
  // settings/dates.ts for why only the two edges move.
  dateFormat: 'date_format',
  // JSON — the masjid's own address/phone/email/website, printed on the sheet and the statement and
  // put at the foot of every parent email (0.47.0).
  schoolContact: 'school_contact',
  // The colour the printed artifacts are ruled in (0.47.0). One hex value; see `getAccentColor`.
  accentColor: 'accent_color',
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
}

const EMPTY_CONTACT: SchoolContact = { address: '', phone: '', email: '', website: '' };

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
    };
  } catch {
    return { ...EMPTY_CONTACT };
  }
}

export function setSchoolContact(patch: Partial<SchoolContact>): void {
  const next = { ...getSchoolContact(), ...patch };
  setSetting(SETTING_KEYS.schoolContact, JSON.stringify(next));
}

/** Is there anything to print? Used so a contact block is omitted entirely rather than left as an
 *  empty box with a heading. */
export function hasSchoolContact(c: SchoolContact = getSchoolContact()): boolean {
  return !!(c.address.trim() || c.phone.trim() || c.email.trim() || c.website.trim());
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

/** When the mid-year go-live step was committed, or null. Only used to stop nagging about it. */
export function getMidYearDoneAt(): string | null {
  const v = getSetting(SETTING_KEYS.midYearDoneAt);
  return v && v.trim() ? v.trim() : null;
}
export function setMidYearDoneAt(iso: string): void {
  setSetting(SETTING_KEYS.midYearDoneAt, iso);
}
