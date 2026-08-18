// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The ONE place a stored phone number becomes something the WhatsApp gateway will accept (0.50.0).
 *
 * Numbers in this app were typed by an office over years, into a free-text field, and they look like
 * it: `(555) 123-4567`, `555-123-4567`, `5551234567`, `07911 123456`, `+44 20 7946 0958`,
 * `001 555 123 4567`. The gateway wants exactly one shape — E.164, `+15551234567` — and getting it
 * wrong does not fail loudly. It messages a stranger.
 *
 * So the rules below are deliberately CONSERVATIVE, and the function returns null rather than
 * guessing. A number nobody can read is reported to the office as a number nobody can read (the
 * settings screen lists them), which is a fixable problem; a number silently mangled into somebody
 * else's is not.
 *
 * The stored string is never rewritten. Formatting is presentation (web/src/lib/phone.ts), storage is
 * whatever the office typed, and this is the third thing: the wire form, derived at the point of use.
 */

/** Every digit, in order. */
function digits(raw: string): string {
  return raw.replace(/\D/g, '');
}

/**
 * The shortest and longest a real international number can be, in digits INCLUDING the country code.
 * E.164 caps at 15; the floor is a little below the shortest national numbering plans in use, because
 * refusing a legitimate number is a support call and this is not the place to be clever about it.
 */
const MIN_E164_DIGITS = 8;
const MAX_E164_DIGITS = 15;

/**
 * Turn a stored number + the country it belongs to into `+<digits>`, or null when it cannot be read.
 *
 * The order of these rules matters, and each one exists because of a real way an office writes a
 * number:
 *
 *  1. **It already starts with `+`** — the person told us the country. Take the digits and trust them;
 *     re-deriving a country here would only be able to get it wrong.
 *  2. **It starts with `00`** — the international prefix used across most of Europe, Asia and Africa.
 *     `00` becomes `+`.
 *  3. **It starts with a single `0`** — a national trunk prefix (`07911…` in the UK, `0300…` in
 *     Pakistan). The zero is dropped BEFORE the country code goes on, because `+4407911…` is not a
 *     number. This is the rule whose absence would have quietly broken every non-US install.
 *  4. **It already carries the country code** — `15551234567` for `+1`. Recognised only when the
 *     length after the code is still plausible, so a 10-digit US number beginning with 1 (`1234567890`,
 *     area code 123) is NOT mistaken for a country code and truncated.
 *  5. Otherwise the country code goes on the front.
 *
 * Finally the total length is checked, which is what catches an extension (`555-1234 x22`), a
 * half-remembered fragment, and a field somebody put a note in.
 */
export function toE164(raw: string | null | undefined, country: string): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  /**
   * A phone number contains no letters, and this rule is doing real work.
   *
   * Without it, `555-1234 x22` reduces to nine digits, which is a perfectly plausible length once a
   * country code goes on — so it would be dialled, as somebody else's number. The same goes for
   * `555-1234 (mobile)` and `07911 123456 ext 4`. There is no way to tell which digits are the number
   * and which are the note, so the honest answer is that we cannot read it: the settings screen lists
   * every number in that state for the office to fix.
   *
   * Nothing legitimate is lost. `+`, digits, spaces, brackets, dots and dashes are how numbers are
   * written everywhere; a letter always means somebody added something else to the field.
   */
  if (/[a-z]/i.test(s)) return null;
  const cc = country.trim().replace(/^\+/, '');
  if (!/^\d{1,3}$/.test(cc)) return null;

  let d: string;
  if (s.startsWith('+')) {
    d = digits(s);
  } else {
    let national = digits(s);
    if (!national) return null;
    if (national.startsWith('00')) {
      d = national.slice(2);
    } else {
      // A trunk prefix is a national convention and never part of the international form.
      if (national.startsWith('0')) national = national.replace(/^0+/, '');
      if (!national) return null;
      // Rule 4: does it already carry the country code? Decided by LENGTH, because that is the only
      // thing that separates the two readings. A national number — once a trunk zero is gone — is at
      // most ten digits in every numbering plan a masjid is realistically dialling, so a longer string
      // beginning with the country code is one that already carries it.
      //
      // Ten is the load-bearing number, and `>` rather than `>=` is what makes `1234567890` come out
      // as a ten-digit US number getting a `+1` rather than a nine-digit one being truncated to
      // `+1234567890`. (In the NANP it cannot be the latter anyway: an area code never starts with 1.)
      const alreadyPrefixed = national.startsWith(cc) && national.length > 10;
      d = alreadyPrefixed ? national : cc + national;
    }
  }

  if (d.length < MIN_E164_DIGITS || d.length > MAX_E164_DIGITS) return null;
  // A leading zero survives only from rule 1 (`+0…`), which is not a country code.
  if (d.startsWith('0')) return null;
  return `+${d}`;
}

/**
 * The last four digits, for a screen that has to say WHICH number without printing it.
 *
 * Used where an office is choosing between two guardians, and in the parent portal's opt-out ("we
 * message ···4567"). Never in a log — the log stores an id, not a number (§14).
 */
export function maskNumber(e164: string | null | undefined): string {
  const d = digits(e164 ?? '');
  return d.length >= 4 ? `···${d.slice(-4)}` : '';
}
