// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Deriving name PARTS from the one `students.full_name` field.
 *
 * The office types a whole name and nothing else. Two features still need a piece of it, and both
 * ask here rather than storing a split, so `full_name` stays the single authority:
 *
 *   - the Student ID prefix wants the GIVEN name  — `YUS1234` for "Yusuf Ismail";
 *   - the household label and the Fabric lookup want the FAMILY name — "Ismail family", "Yusuf I.".
 *
 * These are heuristics on purpose. "First word / last word" is right for the overwhelming majority
 * of the names a madrasa enrols and is wrong in ways that never cost anything: a mononym ("Bilal")
 * makes both parts the same word, and a nasab ("Yusuf ibn Ibrahim") yields the last element. Nothing
 * here is a correctness boundary — a slightly odd household label or ID prefix is cosmetic, and the
 * ID is unique regardless of which letters it starts with.
 *
 * WHAT IS NOT COSMETIC: `lastInitial` is a privacy control. The Fabric lookup deliberately never
 * returns a full family name (§11.2, §14), so a consumer can confirm "Yusuf I.?" without a stranger
 * who guessed an ID learning the family's surname. Returning more than one character here would
 * quietly widen what a guessed Student ID discloses.
 */

/** Words of a name, with all whitespace collapsed. Empty for a blank/whitespace-only name. */
function words(fullName: string): string[] {
  return fullName.trim().split(/\s+/).filter(Boolean);
}

/** The whole name, whitespace-normalised — what to show wherever a name is displayed. */
export function displayName(fullName: string): string {
  return words(fullName).join(' ');
}

/** The given name: the first word. Feeds the Student ID prefix (billing/studentCodes.ts). */
export function givenName(fullName: string): string {
  return words(fullName)[0] ?? '';
}

/**
 * The family name: the last word — but only when there IS one. A mononym has no surname to speak
 * of, and treating its single word as one would put "Bilal family" on a household label and leak a
 * given name where a surname was promised.
 */
export function familyName(fullName: string): string {
  const w = words(fullName);
  return w.length > 1 ? w[w.length - 1] : '';
}

/**
 * The single letter a payment consumer shows next to the given name ("Yusuf I."). Empty when the
 * child has no surname on file, which consumers render as just the given name.
 */
export function lastInitial(fullName: string): string {
  return familyName(fullName).charAt(0);
}
