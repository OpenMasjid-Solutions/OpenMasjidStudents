// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Which of a household's adults is the father, which the mother, and which is neither.
 *
 * The guardian form has offered a fixed four since 0.41.0 (`father | mother | relative | other`), but
 * the column is still free text and always will be: rows written before that hold whatever an office
 * typed, and a CSV import records no relation at all. So the year view — which now wants a separate,
 * labeled column per number — has to classify what is actually in the database rather than what the
 * current form would produce.
 *
 * Hence `other` rather than `unknown`: a guardian whose relation is blank is not evidence of anything,
 * and the point of the bucket is that their number still APPEARS on the page instead of vanishing
 * because nobody ticked a box. The aliases cover the words offices really type, in English and in
 * transliterated Arabic/Urdu, because a masjid roster is full of both.
 */
export type RelationKind = 'father' | 'mother' | 'other';

/** Words that mean "father". Matched on the first word, so "Abu Yusuf" and "dad (Ahmed)" both land. */
const FATHER = ['father', 'dad', 'daddy', 'baba', 'abu', 'abbu', 'abba', 'abi', 'walid', 'papa'];
const MOTHER = ['mother', 'mom', 'mum', 'mummy', 'mama', 'umm', 'ummi', 'ummu', 'ammi', 'amma', 'walida'];

export function relationKind(raw: string | null | undefined): RelationKind {
  const first = (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z\s'’-]/g, '')
    .split(/\s+/)[0];
  if (!first) return 'other';
  if (FATHER.includes(first)) return 'father';
  if (MOTHER.includes(first)) return 'mother';
  return 'other';
}

/**
 * A relation as it should READ on a printed sheet — "Father", not "father" (0.47.0).
 *
 * Only the first letter is touched. The column is free text and always will be, so an office that
 * typed "Paternal uncle" keeps their sentence and gets a capital; one that typed "FATHER" keeps their
 * shouting, because lower-casing what somebody deliberately wrote is the more annoying failure. A
 * multi-word relation is not title-cased either — "Legal Guardian Of Record" reads worse than the
 * sentence the office actually wrote.
 *
 * Returns '' for nothing, so callers keep control of their own placeholder (the sheet prints an
 * em dash; a table cell may want to stay blank).
 */
export function relationLabel(raw: string | null | undefined): string {
  const v = (raw ?? '').trim();
  if (!v) return '';
  return v.charAt(0).toUpperCase() + v.slice(1);
}

/** Distinct phone numbers, compared by digits so "(555) 123-4567" and "5551234567" count once. The
 *  first spelling wins, since that is the one the office chose to record. */
export function dedupeNumbers(numbers: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of numbers) {
    const v = (n ?? '').trim();
    if (!v) continue;
    const key = v.replace(/\D/g, '') || v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}
