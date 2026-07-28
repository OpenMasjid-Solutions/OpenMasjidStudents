// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Age from a stored date of birth.
 *
 * Computed in the BROWSER, not the server: "how old are they" depends on today's date where the
 * reader is, and a container running UTC would show a child as 9 for a few hours after they turned 10.
 * A date of birth is a plain 'YYYY-MM-DD' string with no time and no zone, so it is parsed by its
 * parts — `new Date('2016-07-14')` is parsed as UTC midnight and shifts a day backwards in every
 * timezone behind it, which is exactly the kind of off-by-one that shows up as a wrong birthday.
 */

/** Years old today, or null when there is no usable date of birth. */
export function ageFromDob(dob: string | null | undefined, today: Date = new Date()): number | null {
  if (!dob) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;

  let age = today.getFullYear() - y;
  // Not had this year's birthday yet? Then they are a year younger than the difference suggests.
  const monthNow = today.getMonth() + 1;
  if (monthNow < mo || (monthNow === mo && today.getDate() < d)) age--;
  // A date in the future (a typo) is not an age. Better to show nothing than "-3".
  return age < 0 ? null : age;
}
