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
  smtp: 'smtp_config', // JSON blob: transactional email config (§4/§10). The password lives here in the
  // DB (the DB file is already a secret, §9) — never logged, never returned to the client.
  stripeAccount: 'stripe_account', // the OS-vault Stripe account id the admin picked for tuition (§10).
  // Empty → fall back to the STRIPE_ACCOUNT manifest default (resolved in payments/stripe.ts).
  selfRegistration: 'self_registration', // parent self-registration door on/off (§12, default ON).
  yearViewColumns: 'year_view_columns', // JSON string[] — optional columns on the year grid.
} as const;

/** Optional columns the admin can switch on in the year view, beyond the fixed
 *  name / paying / month grid. */
export const YEAR_VIEW_COLUMNS = ['dob', 'guardianNames', 'guardianPhones', 'guardianEmails', 'balance', 'pin'] as const;
export type YearViewColumn = (typeof YEAR_VIEW_COLUMNS)[number];

/** Which optional columns the year view shows. Defaults to guardian phone numbers — the column an
 *  office actually keeps beside a payment grid.
 *
 *  `pin` is available but OFF by default on purpose: a PIN is a capability token that pays tuition,
 *  and a whole-school grid carrying every child's PIN is a much broader exposure than the per-family
 *  statement that is meant to (§14). The admin opts in knowingly. */
export function getYearViewColumns(): YearViewColumn[] {
  const raw = getSetting(SETTING_KEYS.yearViewColumns);
  if (!raw) return ['guardianPhones'];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return ['guardianPhones'];
    // Filter against the allow-list so a stale/hand-edited row can never widen what is exposed.
    return parsed.filter((c): c is YearViewColumn => (YEAR_VIEW_COLUMNS as readonly unknown[]).includes(c));
  } catch {
    return ['guardianPhones'];
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
export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean; // true = implicit TLS (465); false = STARTTLS (587)
  user: string;
  pass: string;
  from: string; // e.g. "An-Noor School <office@example.org>"
}

/** The stored SMTP config, or null when unconfigured (host + from are the minimum to send). */
export function getSmtp(): SmtpConfig | null {
  const raw = getSetting(SETTING_KEYS.smtp);
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Partial<SmtpConfig>;
    if (!c.host || !c.from) return null;
    return { host: c.host, port: typeof c.port === 'number' ? c.port : 587, secure: !!c.secure, user: c.user ?? '', pass: c.pass ?? '', from: c.from };
  } catch {
    return null;
  }
}

export function setSmtp(c: SmtpConfig): void {
  setSetting(SETTING_KEYS.smtp, JSON.stringify(c));
}

/** The OS-vault Stripe account id the admin chose for tuition, or '' to use the manifest default
 *  (payments/stripe.ts resolves the fallback). This is an account REFERENCE, not a secret. */
export function getChosenStripeAccount(): string {
  return getSetting(SETTING_KEYS.stripeAccount) ?? '';
}
export function setChosenStripeAccount(id: string): void {
  setSetting(SETTING_KEYS.stripeAccount, id);
}
