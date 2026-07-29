// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * "Are any of these children siblings?" — the question a CSV import leaves behind.
 *
 * The import deliberately matches nothing: every row becomes its own household, because guessing a
 * family from a spreadsheet and getting it wrong merges two families' money. That is the right default
 * and it is also an unfinished job — a file of 120 children really does contain 40 households, and
 * nobody wants to link them one at a time from memory.
 *
 * So this SUGGESTS, and a human confirms. It only ever looks at children who are alone in their
 * household, which is exactly the post-import state and never disturbs a household the office has
 * already built.
 *
 * Two strengths of evidence, kept apart on purpose rather than merged into one list:
 *
 *  - **contact** — their guardians share a phone number or an email address. This is strong: one adult,
 *    recorded once per child by the import. Shown first, and safe to accept at a glance.
 *  - **surname** — nothing but the last word of the name matches. This is WEAK, and a madrasa is
 *    exactly the place it goes wrong: three unrelated Ismail families in one roster is normal. Shown
 *    separately, worded as a maybe, and never pre-ticked.
 *
 * Nothing here writes. The suggestion is data for a person to act on.
 */
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { students, families, guardians, guardianFamilies } from '../db/schema';
import { familyName as familyNameOf } from './names';
import { identityKeys } from './household';

export interface SuggestedStudent {
  id: string;
  fullName: string;
  studentCode: string | null;
  familyId: string;
  /** The adults on that child's household — what the office recognises the family by. */
  guardianNames: string[];
  /** The shared detail, so the office can see WHY these two are together. */
  phone: string | null;
  email: string | null;
}

export interface SuggestedGroup {
  /** Stable id for React keys and for the "already handled" set: the sorted student ids. */
  key: string;
  reason: 'contact' | 'surname';
  /** What the office will recognise: the shared number/email, or the surname. */
  label: string;
  students: SuggestedStudent[];
}

/** Union-find, small and local: groups form by sharing ANY key, transitively. */
function groupBy<T>(items: T[], keysOf: (t: T) => string[]): T[][] {
  const groups: { keys: Set<string>; members: T[] }[] = [];
  for (const item of items) {
    const keys = keysOf(item);
    if (!keys.length) continue;
    const hits = groups.filter((g) => keys.some((k) => g.keys.has(k)));
    if (hits.length === 0) {
      groups.push({ keys: new Set(keys), members: [item] });
      continue;
    }
    // Two existing groups can be bridged by this item (same phone as one, same email as another).
    const [first, ...rest] = hits;
    first.members.push(item);
    for (const k of keys) first.keys.add(k);
    for (const other of rest) {
      first.members.push(...other.members);
      for (const k of other.keys) first.keys.add(k);
      groups.splice(groups.indexOf(other), 1);
    }
  }
  return groups.filter((g) => g.members.length > 1).map((g) => g.members);
}

/**
 * Sibling suggestions across every household that currently holds exactly ONE child.
 *
 * No input on purpose: "children who are alone in their household" IS the population that needs
 * checking, whether they arrived in the import five seconds ago or in one three months ago that nobody
 * finished tidying. It also keeps this a plain query — a list of 2,000 student ids does not belong in a
 * URL.
 */
export function suggestSiblingGroups(): SuggestedGroup[] {
  // Households with exactly one active child. A household the office has already linked is left alone.
  const singles = db
    .select({ id: students.id, fullName: students.fullName, studentCode: students.studentCode, familyId: students.familyId })
    .from(students)
    .innerJoin(families, eq(families.id, students.familyId))
    .where(eq(students.status, 'active'))
    .groupBy(students.familyId)
    .having(sql`count(${students.id}) = 1`)
    .all();
  if (singles.length < 2) return [];

  const famIds = singles.map((s) => s.familyId);
  const guardiansByFamily = new Map<string, { name: string; phone: string | null; email: string | null }[]>();
  for (const g of db
    .select({ familyId: guardianFamilies.familyId, name: guardians.name, phone: guardians.phone, email: guardians.email })
    .from(guardianFamilies)
    .innerJoin(guardians, eq(guardians.id, guardianFamilies.guardianId))
    .where(inArray(guardianFamilies.familyId, famIds))
    .all()) {
    if (!guardiansByFamily.has(g.familyId)) guardiansByFamily.set(g.familyId, []);
    guardiansByFamily.get(g.familyId)!.push({ name: g.name, phone: g.phone, email: g.email });
  }

  const enriched: SuggestedStudent[] = singles.map((s) => {
    const gs = guardiansByFamily.get(s.familyId) ?? [];
    return {
      id: s.id,
      fullName: s.fullName,
      studentCode: s.studentCode,
      familyId: s.familyId,
      guardianNames: gs.map((g) => g.name),
      phone: gs.find((g) => g.phone)?.phone ?? null,
      email: gs.find((g) => g.email)?.email ?? null,
    };
  });

  const contactKeys = (s: SuggestedStudent) => {
    const gs = guardiansByFamily.get(s.familyId) ?? [];
    // A guardian NAME is not evidence across households — two families can both have a "Mohammed" —
    // so only the phone and email keys count here.
    return gs.flatMap((g) => identityKeys(g).filter((k) => k.startsWith('phone:') || k.startsWith('email:')));
  };

  const out: SuggestedGroup[] = [];
  const claimed = new Set<string>();
  for (const members of groupBy(enriched, contactKeys)) {
    for (const m of members) claimed.add(m.id);
    const shared = members.find((m) => m.phone)?.phone ?? members.find((m) => m.email)?.email ?? '';
    out.push({
      key: members.map((m) => m.id).sort().join('|'),
      reason: 'contact',
      label: shared,
      students: members.sort((a, b) => a.fullName.localeCompare(b.fullName)),
    });
  }

  // Then surname, over whoever the contact pass did not already account for.
  for (const members of groupBy(
    enriched.filter((s) => !claimed.has(s.id)),
    (s) => {
      const surname = familyNameOf(s.fullName).toLowerCase();
      return surname ? [`s:${surname}`] : [];
    },
  )) {
    out.push({
      key: members.map((m) => m.id).sort().join('|'),
      reason: 'surname',
      label: familyNameOf(members[0].fullName),
      students: members.sort((a, b) => a.fullName.localeCompare(b.fullName)),
    });
  }

  // Strong evidence first, then the biggest groups — the office gets the most done per decision.
  return out.sort((a, b) => (a.reason === b.reason ? b.students.length - a.students.length : a.reason === 'contact' ? -1 : 1));
}
