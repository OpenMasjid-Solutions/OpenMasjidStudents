// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * US phone formatting — `(555) 123-4567` — for both typing and display.
 *
 * ONE function for both on purpose. Numbers already on file were typed however the office felt like
 * ("5551234567", "555-123-4567"), so a mask that only ran on new input would leave the directory
 * looking inconsistent for years. Running the same formatter on display means the whole app reads the
 * same way from the first render.
 *
 * It never destroys what somebody typed. A number that is not a 10-digit US one — an international
 * `+44 20 7946 0958`, an extension, a half-remembered fragment — is handed back untouched rather than
 * squeezed into a shape it doesn't fit. Storage stays a plain string (the server takes any text up to
 * 40 chars): this is presentation, and a masjid with an overseas grandparent on file must not lose
 * their number to our formatting.
 */

/** Every digit in the string, in order. */
function digits(raw: string): string {
  return raw.replace(/\D/g, '');
}

/**
 * Format for a US number; return the input unchanged when it isn't one.
 *
 * Used as an as-you-type mask (each keystroke re-formats the field) and as a display formatter. As a
 * mask it is deliberately forgiving: a partial number formats as far as it goes, so `(555) 12` is a
 * legitimate intermediate state rather than an error.
 */
export function formatUsPhone(raw: string | null | undefined): string {
  if (!raw) return '';
  // A leading + means the person is telling us the country, so we are not the ones to reformat it.
  if (raw.trimStart().startsWith('+')) return raw;
  const d = digits(raw);
  if (!d) return raw.trim() === '' ? '' : raw;
  // A US number written with its country code — common when pasted from a contacts app.
  if (d.length === 11 && d.startsWith('1')) return `1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  // Too many digits for a US number: an extension, or somewhere else entirely. Leave it alone.
  if (d.length > 10) return raw;
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}
