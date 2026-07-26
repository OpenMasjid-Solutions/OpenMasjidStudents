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
} as const;

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

/** Optional columns the admin can switch on in the year view, beyond the fixed
 *  name / paying / month grid. */
export const YEAR_VIEW_COLUMNS = ['studentId', 'dob', 'guardianNames', 'guardianPhones', 'guardianEmails', 'balance', 'pin'] as const;
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
/** The stored SMTP config, or null when unconfigured (host + from are the minimum to send). */
/** The OS-vault Stripe account id the admin chose for tuition, or '' to use the manifest default
 *  (payments/stripe.ts resolves the fallback). This is an account REFERENCE, not a secret. */
export function getChosenStripeAccount(): string {
  return getSetting(SETTING_KEYS.stripeAccount) ?? '';
}
export function setChosenStripeAccount(id: string): void {
  setSetting(SETTING_KEYS.stripeAccount, id);
}
