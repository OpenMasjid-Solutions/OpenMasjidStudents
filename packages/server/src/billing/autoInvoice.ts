// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Generating each month's invoices on a schedule, so the office does not have to remember.
 *
 * Four things make this safe to leave running unattended:
 *
 * 1. **It only bills months inside the configured school year.** A madrasa year usually skips the
 *    summer; a blind "generate every month" would quietly bill tuition for months nobody teaches.
 *    With no school year configured (or one missing its start year) it does nothing and says why —
 *    silence would look identical to "working fine".
 * 2. **It is idempotent twice over.** `generateForPeriod` already refuses a second invoice for the
 *    same (family, period) — there is a UNIQUE index behind it — and we additionally record the last
 *    period generated, so a restart on the same day is a no-op rather than a re-scan.
 * 3. **A month that was missed is still caught up.** The trigger is "today is on or after the chosen
 *    day, and this period has not been generated yet", not "today IS the chosen day" — so a container
 *    that was off on the 1st generates when it next wakes, instead of skipping the month entirely.
 * 4. **A late-joining student is not stranded.** Because generation is per-family and idempotent, the
 *    office can still hit Generate manually for that family; this job only ever adds what is missing.
 *
 * The day is clamped to the length of the month, so "the 31st" works in February.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { schoolYears } from '../db/schema';
import { generateForPeriod } from './invoices';
import { schoolYearMonths } from './schoolYear';
import { getSetting, setSetting, SETTING_KEYS, getAutoInvoice, getBillingStartPeriod, getInvoiceLabelTemplate } from '../settings';
import { periodBefore, resolveInvoiceLabel } from './period';
import { alertStaff } from '../alerts';
import { makeLog } from '../logger';

const log = makeLog('autoInvoice');


export interface AutoInvoiceResult {
  ran: boolean;
  /** Why it did nothing, when it did nothing. */
  reason?: 'disabled' | 'no_school_year' | 'needs_start_year' | 'outside_school_year' | 'before_start' | 'too_early' | 'already_done';
  periodKey?: string;
  created?: number;
}

/** `YYYY-MM` for a date, in local time — the same key `generateForPeriod` uses. */
function periodKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Days in the month `d` falls in. */
function daysInMonth(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

/**
 * Generate the current month's invoices if the schedule says it is due and it has not happened yet.
 * `today` is injectable so the behaviour is testable without waiting for a calendar.
 */
export function runAutoInvoice(today = new Date()): AutoInvoiceResult {
  const cfg = getAutoInvoice();
  if (!cfg.enabled) return { ran: false, reason: 'disabled' };

  const year = db.select().from(schoolYears).where(eq(schoolYears.isCurrent, true)).get();
  if (!year) {
    log.warn('auto invoicing is on but no school year is current — nothing generated');
    return { ran: false, reason: 'no_school_year' };
  }
  if (year.startYear == null) {
    log.warn('auto invoicing is on but the current school year has no start year — nothing generated');
    return { ran: false, reason: 'needs_start_year' };
  }

  const periodKey = periodKeyOf(today);
  // Only bill a month the school year actually covers.
  const months = schoolYearMonths(year.startYear, year.startMonth, year.endMonth);
  const month = months.find((m) => m.periodKey === periodKey);
  if (!month) return { ran: false, reason: 'outside_school_year', periodKey };

  // A school that went live mid-year carries the earlier months as one figure per child; billing them
  // again would charge the same arrears twice. Normally moot (the floor is in the past), but an office
  // that sets a future go-live month must not have the scheduler bill around it.
  const floor = getBillingStartPeriod();
  if (floor && periodBefore(periodKey, floor)) return { ran: false, reason: 'before_start', periodKey };

  // Clamped so "the 31st" still fires in a 28-day month.
  const dueDay = Math.min(cfg.day, daysInMonth(today));
  if (today.getDate() < dueDay) return { ran: false, reason: 'too_early', periodKey };

  if (getSetting(SETTING_KEYS.autoInvoiceLast) === periodKey) return { ran: false, reason: 'already_done', periodKey };

  // The office's own wording, from the one template both this job and the manual form read (0.48.0).
  // Hardcoded here until then, which meant an office that renamed their invoices by hand every month got
  // a differently-worded one on any month the job ran.
  const label = resolveInvoiceLabel(getInvoiceLabelTemplate(), periodKey);
  const dueDate = cfg.dueDay
    ? `${month.year}-${String(month.month).padStart(2, '0')}-${String(Math.min(cfg.dueDay, daysInMonth(today))).padStart(2, '0')}`
    : null;

  const r = generateForPeriod({ periodKey, label, dueDate, periodKind: 'month' });
  // Mark the period done only AFTER a successful pass, so a throw leaves it to be retried tomorrow.
  setSetting(SETTING_KEYS.autoInvoiceLast, periodKey);
  log.info('auto-generated invoices', { periodKey, created: r.created });
  // Tell whoever asked to be told: this job runs at 2am and bills every family, and until now the only
  // trace of it was a line in the container log.
  void alertStaff('invoices-generated', {
    title: 'This month’s invoices were generated',
    // A count and a month name — no family in either, so the two texts are the same here.
    text: `${r.created} invoice(s) were generated automatically for ${label}.`,
    publicText: `${r.created} invoice(s) were generated automatically for ${label}.`,
  });
  return { ran: true, periodKey, created: r.created };
}
