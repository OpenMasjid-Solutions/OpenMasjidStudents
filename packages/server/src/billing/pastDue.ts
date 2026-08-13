// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Who is behind, and telling somebody about it (0.48.0).
 *
 * WHAT "PAST DUE" MEANS HERE, precisely, because a vaguer definition would produce emails nobody can
 * defend: an invoice that is open or part-paid, carries a due date, that date has passed, and it still
 * has a positive balance. The amount is what is left on THOSE invoices — not the household's whole
 * balance, which would include next month's bill the day it is generated and tell a family they are
 * behind when they are not.
 *
 * It is DERIVED on every run, like every other balance in this app (§9). Nothing is stored about what a
 * family owes; the only row this module writes is "we last wrote to them on this date", which exists
 * solely to stop a daily job becoming a daily email (see `past_due_reminders`).
 *
 * TWO AUDIENCES, deliberately different:
 *   • PARENTS get one message per household — one adult pays for all their children — worded as a
 *     reminder rather than a demand (§15), rate-limited per household, and off until an office turns it
 *     on. It goes through `mail/notify.ts`, so the master parent-mail pause applies without this module
 *     knowing about it.
 *   • THE OFFICE gets a digest through `alerts/index.ts`: one email listing the households and the
 *     amounts, which is what makes it actionable. The de-identified copy that goes to the webhook and
 *     the platform channel carries a count and a total and no names at all (§14).
 *
 * A family with NO email on file is not a failure and is not retried into a cooldown — they simply
 * cannot be reached this way, which is exactly what Settings → Email alerts now lists, so the office can
 * ring them instead.
 */
import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { db } from '../db';
import { families, invoices, pastDueReminders, students } from '../db/schema';
import { invoicePaid, invoiceTotal } from './ledger';
import { formatMoney } from '../db/money';
import { getCurrency, getPastDue, getPastDueStaffLast, setPastDueStaffLast, type PastDueConfig } from '../settings';
import { formatDate } from '../settings/dates';
import { alertStaff } from '../alerts';
import { sendPastDue } from '../mail/notify';
import { makeLog } from '../logger';

const log = makeLog('pastDue');

/** One overdue bill, as a family reads it. */
export interface PastDueInvoice {
  id: string;
  studentId: string;
  studentName: string;
  label: string;
  dueDate: string;
  balanceCents: number;
}

export interface PastDueFamily {
  familyId: string;
  /** The derived household label ("Ismail family") — never a Student ID (§14). */
  label: string;
  amountCents: number;
  /** The oldest unpaid due date on the household — "overdue since". */
  oldestDue: string;
  invoices: PastDueInvoice[];
  /** Days since that oldest due date, so a caller can apply the grace period without re-deriving it. */
  daysOverdue: number;
}

/** Whole days between two ISO dates (UTC midnight either end — no clock, no drift). */
function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Every household with money outstanding on a bill whose due date has passed, worst first.
 *
 * `asOf` is passed in rather than read from the clock so the job, the preview an admin sees in Settings,
 * and the tests are all looking at the same day.
 */
export function pastDueFamilies(asOf: string): PastDueFamily[] {
  const rows = db
    .select({
      id: invoices.id,
      studentId: invoices.studentId,
      studentName: students.fullName,
      familyId: students.familyId,
      familyLabel: families.name,
      label: invoices.label,
      dueDate: invoices.dueDate,
    })
    .from(invoices)
    .innerJoin(students, eq(students.id, invoices.studentId))
    .innerJoin(families, eq(families.id, students.familyId))
    .where(
      and(
        inArray(invoices.status, ['open', 'partially_paid']),
        isNotNull(invoices.dueDate),
        // Strictly BEFORE today: a bill due today is due today, not late.
        lt(invoices.dueDate, asOf),
      ),
    )
    .orderBy(sql`${invoices.dueDate} asc`)
    .all();

  const byFamily = new Map<string, PastDueFamily>();
  for (const r of rows) {
    // The balance is derived per invoice (allocation is not stored on the invoice, §9), so it is read
    // here rather than joined — a paid-off invoice whose status has not been recomputed yet drops out.
    const balanceCents = invoiceTotal(db, r.id) - invoicePaid(db, r.id);
    if (balanceCents <= 0) continue;
    const dueDate = r.dueDate!;
    const fam = byFamily.get(r.familyId) ?? {
      familyId: r.familyId,
      label: r.familyLabel,
      amountCents: 0,
      oldestDue: dueDate,
      invoices: [],
      daysOverdue: 0,
    };
    fam.amountCents += balanceCents;
    if (dueDate < fam.oldestDue) fam.oldestDue = dueDate;
    fam.invoices.push({ id: r.id, studentId: r.studentId, studentName: r.studentName, label: r.label, dueDate, balanceCents });
    byFamily.set(r.familyId, fam);
  }

  return [...byFamily.values()]
    .map((f) => ({ ...f, daysOverdue: daysBetween(f.oldestDue, asOf) }))
    .sort((a, b) => b.amountCents - a.amountCents || a.oldestDue.localeCompare(b.oldestDue));
}

/** The households this run would actually consider — past the grace period and worth an email. */
export function dueForChasing(asOf: string, cfg: PastDueConfig = getPastDue()): PastDueFamily[] {
  return pastDueFamilies(asOf).filter((f) => f.daysOverdue >= cfg.graceDays && f.amountCents >= cfg.minAmountCents);
}

/** When each household was last written to, for the cadence check. */
function lastSentByFamily(): Map<string, string> {
  return new Map(db.select().from(pastDueReminders).all().map((r) => [r.familyId, r.lastSentOn]));
}

export interface PastDueRunResult {
  /** Households past due at all, before grace or cadence — what the office would call "behind". */
  overdue: number;
  totalCents: number;
  /** Households a parent email actually reached. */
  emailed: number;
  /** Past the grace period but silent this run — too soon since the last reminder. */
  waiting: number;
  /** Past the grace period with no guardian address on file. The office has to ring these. */
  unreachable: number;
  /** Did the office digest go out this run? */
  staffAlerted: boolean;
}

/**
 * One pass: remind the parents who are due a reminder, then tell the office who is behind.
 *
 * Best-effort and idempotent-per-day by construction — everything it decides is derived from the ledger
 * plus the last-sent dates, so a run that dies halfway leaves no half-state beyond the families it had
 * already written to (which is exactly what should not be repeated).
 */
export async function runPastDue(asOf: string, opts: { force?: boolean } = {}): Promise<PastDueRunResult> {
  const cfg = getPastDue();
  const currency = getCurrency();
  const all = pastDueFamilies(asOf);
  const chase = all.filter((f) => f.daysOverdue >= cfg.graceDays && f.amountCents >= cfg.minAmountCents);
  const result: PastDueRunResult = {
    overdue: all.length,
    totalCents: all.reduce((s, f) => s + f.amountCents, 0),
    emailed: 0,
    waiting: 0,
    unreachable: 0,
    staffAlerted: false,
  };

  if (cfg.parentEmails) {
    const lastSent = lastSentByFamily();
    const ts = new Date();
    for (const fam of chase) {
      const prev = lastSent.get(fam.familyId);
      // `force` is the office pressing "Send now" — it deliberately overrides the cadence, because a
      // person chose to do it. The daily job never passes it.
      if (!opts.force && prev && daysBetween(prev, asOf) < cfg.everyDays) {
        result.waiting++;
        continue;
      }
      const sent = await sendPastDue(fam.familyId, formatMoney(fam.amountCents, currency), formatDate(fam.oldestDue));
      if (sent > 0) {
        result.emailed++;
        // Written only on a real send. A family nobody could reach must not start a quiet cooldown —
        // otherwise the day an address is finally added, they wait another week for no reason.
        db.insert(pastDueReminders)
          .values({ familyId: fam.familyId, lastSentOn: asOf, amountCents: fam.amountCents, createdAt: ts, updatedAt: ts })
          .onConflictDoUpdate({ target: pastDueReminders.familyId, set: { lastSentOn: asOf, amountCents: fam.amountCents, updatedAt: ts } })
          .run();
      } else {
        result.unreachable++;
      }
    }
  }

  // The office digest, on its own cadence. Nothing overdue means nothing is sent — an empty "0 families
  // are behind" every week is how a recipient learns to ignore the whole channel.
  if (chase.length) {
    const staffLast = getPastDueStaffLast();
    if (opts.force || !staffLast || daysBetween(staffLast, asOf) >= cfg.everyDays) {
      const total = chase.reduce((s, f) => s + f.amountCents, 0);
      const money = (c: number) => formatMoney(c, currency);
      // Named households and amounts — these are addresses an admin typed, and a digest that cannot say
      // WHO is behind is not actionable (§9's alert rule).
      const lines = chase
        .slice(0, 40)
        .map((f) => `• ${f.label} — ${money(f.amountCents)}, since ${formatDate(f.oldestDue)}`);
      if (chase.length > lines.length) lines.push(`…and ${chase.length - lines.length} more.`);
      await alertStaff('past-due', {
        title: `${chase.length} ${chase.length === 1 ? 'family is' : 'families are'} past due`,
        text: [
          `${chase.length} ${chase.length === 1 ? 'household has' : 'households have'} a bill whose due date has passed — ${money(total)} in total.`,
          '',
          ...lines,
          '',
          cfg.parentEmails
            ? `Parents are being reminded automatically, at most once every ${cfg.everyDays} days.`
            : 'Parent reminders are switched off, so nobody has been told but you (Settings → Email alerts).',
        ].join('\n'),
        // No household, no child, no name beside an amount (§14) — this copy goes to the masjid webhook
        // and the OpenMasjidOS alert channel, which are third-party sinks.
        publicText: `${chase.length} ${chase.length === 1 ? 'household is' : 'households are'} past due, ${money(total)} in total. Open the tuition app to see who.`,
      });
      setPastDueStaffLast(asOf);
      result.staffAlerted = true;
    }
  }

  // Counts only — never a household, never an address (§14).
  log.info('past due run', { overdue: result.overdue, emailed: result.emailed, waiting: result.waiting, unreachable: result.unreachable });
  return result;
}
