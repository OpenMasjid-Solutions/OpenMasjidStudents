// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * How dates are WRITTEN and READ, once, for the whole app (0.47.0).
 *
 * THE STORAGE FORMAT NEVER CHANGES. Every date in the database is an ISO `YYYY-MM-DD` string and stays
 * one — it sorts correctly as text, it is what `students.dob`, `invoices.due_date` and every period key
 * already hold, and it is unambiguous. What the setting changes is only the two edges: how a date is
 * PRINTED for a human, and what a human may TYPE for us to accept. Anything else would mean the same
 * database read differently depending on a settings row, which is how "07/08" becomes two dates.
 *
 * Why it is configurable at all: `2019-03-04` on a sheet handed to a parent is a developer's date, and
 * a madrasah in Britain reading `03/04/2019` as the 3rd of April while the office typed the 4th of
 * March is a real and silent error. So the office picks once and every surface follows — the printed
 * family sheet, the statement, the year view, the directory, and the CSV import.
 */
import { getSetting, setSetting, SETTING_KEYS } from './index';

/**
 * The formats on offer. Deliberately short: every extra one is another way for two staff members to
 * disagree about what a column means.
 *
 * `long` is the only unambiguous one for a mixed audience, which is why it is what the printed sheet
 * would ideally default to — but changing the default for an existing install would silently redraw
 * every screen the morning after an update, so `iso` remains the default and an admin opts in.
 */
export const DATE_FORMATS = ['iso', 'us', 'uk', 'long'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export const DEFAULT_DATE_FORMAT: DateFormat = 'iso';

/** What each option looks like, for the settings screen — shown rather than described. */
export const DATE_FORMAT_SAMPLES: Record<DateFormat, string> = {
  iso: '2026-03-04',
  us: '03/04/2026',
  uk: '04/03/2026',
  long: '4 Mar 2026',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function getDateFormat(): DateFormat {
  const v = getSetting(SETTING_KEYS.dateFormat);
  return (DATE_FORMATS as readonly string[]).includes(v ?? '') ? (v as DateFormat) : DEFAULT_DATE_FORMAT;
}

export function setDateFormat(f: DateFormat): void {
  setSetting(SETTING_KEYS.dateFormat, f);
}

/**
 * Render a stored ISO date the way this masjid writes dates. Anything that is not an ISO date comes
 * back as the empty string rather than as `Invalid Date` — a blank cell is honest, and a DOB is
 * optional by design (§14).
 */
export function formatDate(iso: string | null | undefined, fmt: DateFormat = getDateFormat()): string {
  if (!iso) return '';
  const m = ISO.exec(iso.trim());
  if (!m) return '';
  const [, y, mo, d] = m;
  switch (fmt) {
    case 'us':
      return `${mo}/${d}/${y}`;
    case 'uk':
      return `${d}/${mo}/${y}`;
    case 'long':
      return `${Number(d)} ${MONTHS[Number(mo) - 1] ?? mo} ${y}`;
    default:
      return `${y}-${mo}-${d}`;
  }
}

/**
 * Turn something a human typed (or a spreadsheet held) into a stored ISO date, or null if it is not a
 * date at all.
 *
 * ISO IS ALWAYS ACCEPTED, whatever the setting. It is unambiguous, it is what the app itself writes,
 * and a file exported from this app must always re-import — a format setting that could make our own
 * export unreadable would be a trap.
 *
 * A slashed or dotted date is read with the CONFIGURED order, and that is the whole point: `03/04/2026`
 * is the 3rd of April to a British office and the 4th of March to an American one, and only the
 * setting can say which. Where the numbers themselves settle it (`25/03/2026` cannot be month-first)
 * the unambiguous reading wins over the setting rather than being rejected — the office pasting a
 * column from elsewhere is better served by the obvious answer than by a lecture.
 *
 * The date is then validated for real: 2026-02-30 parses cleanly as digits and is not a date.
 */
export function parseDateInput(raw: string | null | undefined, fmt: DateFormat = getDateFormat()): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;

  const iso = ISO.exec(s);
  if (iso) return validOrNull(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // `4 Mar 2026` / `4 March 2026` — what the `long` format prints, so it round-trips.
  const named = /^(\d{1,2})[\s-]+([A-Za-z]{3,})[\s-]+(\d{4})$/.exec(s);
  if (named) {
    const mi = MONTHS.findIndex((m) => named[2].toLowerCase().startsWith(m.toLowerCase()));
    if (mi >= 0) return validOrNull(Number(named[3]), mi + 1, Number(named[1]));
    return null;
  }

  const parts = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/.exec(s);
  if (!parts) return null;
  const a = Number(parts[1]);
  const b = Number(parts[2]);
  const year = Number(parts[3]);

  // Let the numbers decide when they can; fall back to the configured order when they cannot.
  const dayFirst = a > 12 ? true : b > 12 ? false : fmt === 'uk';
  return dayFirst ? validOrNull(year, b, a) : validOrNull(year, a, b);
}

/** A real calendar date, not just three plausible numbers. */
function validOrNull(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Rolls over for an impossible day (31 Feb → 3 Mar), so comparing back is the check.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
