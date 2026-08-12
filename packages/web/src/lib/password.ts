// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * A temporary password to hand a new staff member.
 *
 * WHY GENERATE ONE. The server asks for 12 characters and forces a change on first sign-in, so what an
 * admin types here lives for one login — which is exactly why they type "Password123456". That is fine
 * right up until the account is a `finance` one, because finance signs in OVER THE INTERNET (§12.4): a
 * guessable temporary password on an internet-reachable account is a real door, not a formality. Offering
 * a strong one costs a click and removes the reason to invent a weak one.
 *
 * CSPRNG, not `Math.random`. This is a credential, however short-lived, and the org rule for anything
 * that authenticates somebody is `crypto.getRandomValues` (§14). `Math.random` is seeded predictably
 * enough that a stream of passwords from one session is not independent.
 *
 * REJECTION SAMPLING, not `% alphabet.length`. The modulo shortcut biases toward the first
 * `256 % 40` characters of the alphabet — small, but free to avoid, and the kind of thing nobody revisits.
 *
 * The alphabet keeps exactly ONE member of every group that gets misread when this is written on paper
 * or read down a phone — `o` out of `0/O/o`, `i` out of `1/l/I/i`, `s` out of `5/S/s`, `z` out of
 * `2/Z/z`, `b` out of `8/B/b` — because that is how a temporary password actually travels from the
 * office to the person, and keeping one of each is what makes the survivors unambiguous rather than
 * merely fewer. Same reason there are no symbols: they survive neither dictation nor a keyboard whose
 * layout the reader is guessing at.
 */

/** 52 characters: a–z less `l`, A–Z less `B I O S Z`, and `3 4 6 7 8 9`. No symbols. */
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzACDEFGHJKLMNPQRTUVWXY346789';

/** Comfortably over the server's 12-character minimum, and grouped for reading aloud. */
const LENGTH = 15;
const GROUP = 5;

export function generateTempPassword(length = LENGTH): string {
  const bytes = new Uint8Array(length * 2);
  let out = '';
  // The largest multiple of the alphabet that fits in a byte; anything at or above it is discarded so
  // every character is uniformly likely.
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  while (out.length < length) {
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b >= limit) continue;
      out += ALPHABET[b % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  // "kmpqr-Y3TWA-9dnFh" — the dashes are part of the password, and they are what makes it possible to
  // read it down a phone without losing your place.
  return (out.match(new RegExp(`.{1,${GROUP}}`, 'g')) ?? [out]).join('-');
}
