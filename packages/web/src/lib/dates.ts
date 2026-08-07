// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Writing a stored date the way this masjid writes dates (0.47.0) — the browser half of
 * `packages/server/src/settings/dates.ts`.
 *
 * DISPLAY ONLY. There is no parser here on purpose: every date the UI collects goes through
 * `<input type="date">`, which is always ISO by the HTML spec regardless of what the field LOOKS like
 * to the user (the browser localises the widget itself). So the ambiguity the server has to resolve —
 * is 03/04 March or April — cannot arise in this app's own forms. It arises in a pasted CSV column,
 * which is the server's problem and is handled there.
 *
 * Kept deliberately in step with the server's `formatDate`, and small enough to read side by side.
 * The alternative — sending pre-formatted strings down the wire — would mean every query that
 * carries a date has to know it is for display, which is worse.
 */
export type DateFormat = 'iso' | 'us' | 'uk' | 'long';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Empty string for anything that is not a stored ISO date — a DOB is optional, and a blank cell is
 *  a better answer than "Invalid Date". */
export function formatDate(iso: string | null | undefined, fmt: DateFormat = 'iso'): string {
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
