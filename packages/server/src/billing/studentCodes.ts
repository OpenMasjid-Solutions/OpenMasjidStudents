// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The human-readable student ID: first three letters of the first name + 4 digits — `YUS1234`.
 *
 * WHAT IT IS FOR. A parent at the kiosk or on the donation site types this instead of spelling a full
 * name. The consumer then echoes the matched child's name back and asks "is this the right one?",
 * which catches a mistyped code before any money moves. Since 0.39.0 it is the ONLY identifier in
 * that flow — there is no PIN behind it.
 *
 * WHAT IT IS NOT. It is **not** a secret and must never be treated as one:
 *   - the letters are derived from the child's first name, so a third of it is public by design;
 *   - 4 digits is ~10k guesses per prefix, trivially brute-forced without a limiter;
 *   - it is printed on statements and shown on staff screens.
 * That is deliberate rather than a gap, because of what the code can actually do: see a balance and
 * *pay* it. There is no path from a code to changing a record, reading contact details, or taking
 * money out, so the worst outcome of a guessed code is a stranger settling a child's tuition. What
 * compensates is a hard per-code lockout (`codeLookupLimiter`) plus the name-confirmation step — not
 * a shared secret, which would cost every parent friction at the kiosk to buy very little (§11.2,
 * §14). Minting a portal ACCOUNT is the one thing a code cannot do alone: that also needs a guardian
 * email already on file (trpc/auth.ts `register`).
 *
 * FORMAT RULES, all deterministic so the same name always produces the same prefix:
 *   - strip diacritics (Yūsuf → YUSUF) and keep A-Z only, so punctuation and spaces never appear;
 *   - take the first three letters, uppercased;
 *   - a one- or two-letter name is padded with X (Bo → BOX), because a short prefix would make
 *     collisions far likelier within that prefix;
 *   - a name with no Latin letters at all (e.g. written only in Arabic script) falls back to STU
 *     rather than guessing a transliteration — honest and predictable beats clever here.
 */
import { randomInt } from 'node:crypto';
import { eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { students } from '../db/schema';
import { makeLog } from '../logger';

const log = makeLog('studentCodes');

/** The fallback prefix for a name with no Latin letters. */
export const FALLBACK_PREFIX = 'STU';

/** `YUS1234` — 3 uppercase letters then exactly 4 digits. Used to validate typed input. */
export const STUDENT_CODE_RE = /^[A-Z]{3}[0-9]{4}$/;

/** The three-letter prefix for a first name. Always returns exactly 3 chars of A-Z. */
export function codePrefix(firstName: string): string {
  const letters = firstName
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // the combining marks NFD just split off (Yūsuf → Yusuf)
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
  if (!letters) return FALLBACK_PREFIX;
  return letters.slice(0, 3).padEnd(3, 'X');
}

/** Normalise typed input: trim, uppercase, drop spaces and hyphens a parent might add. */
export function normalizeStudentCode(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-]/g, '');
}

/**
 * A code not currently used by any student. Tries random 4-digit suffixes on the name's prefix, then
 * — only if that prefix is genuinely saturated — falls back to other prefixes so student creation can
 * never hard-fail on a full prefix. 10k per prefix means a real madrasa never reaches the fallback.
 */
export function generateUniqueStudentCode(firstName: string): string {
  const prefix = codePrefix(firstName);
  const taken = (code: string) => !!db.select({ id: students.id }).from(students).where(eq(students.studentCode, code)).get();

  for (let i = 0; i < 200; i++) {
    const code = `${prefix}${String(randomInt(0, 10_000)).padStart(4, '0')}`;
    if (!taken(code)) return code;
  }
  // The name's own prefix is saturated (or very unlucky). Keep going rather than refusing to
  // enrol a child: append a letter shift so the code is still recognisably theirs.
  for (const alt of ['X', 'Y', 'Z']) {
    const p = `${prefix.slice(0, 2)}${alt}`;
    for (let i = 0; i < 200; i++) {
      const code = `${p}${String(randomInt(0, 10_000)).padStart(4, '0')}`;
      if (!taken(code)) return code;
    }
  }
  throw new Error('could not allocate a unique student ID');
}

/**
 * Give a code to every student that has none. Idempotent and cheap (a no-op once done), so it is safe
 * to call on every boot — which is how an install that upgrades into this feature gets codes without
 * a data migration that would have to solve collisions in SQL.
 *
 * Returns how many it filled. Never throws: a failure here must not stop the server from starting,
 * and the next boot retries.
 */
export function backfillStudentCodes(): number {
  let filled = 0;
  try {
    const rows = db.select({ id: students.id, firstName: students.firstName }).from(students).where(isNull(students.studentCode)).all();
    for (const r of rows) {
      try {
        db.update(students).set({ studentCode: generateUniqueStudentCode(r.firstName), updatedAt: new Date() }).where(eq(students.id, r.id)).run();
        filled++;
      } catch (e) {
        // One bad row must not abandon the rest.
        log.warn('could not assign a student ID', { studentId: r.id, error: (e as Error).message });
      }
    }
    if (filled) log.info('assigned student IDs', { filled });
  } catch (e) {
    log.warn('student ID backfill failed — will retry next boot', { error: (e as Error).message });
  }
  return filled;
}
