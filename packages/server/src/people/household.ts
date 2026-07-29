// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The DERIVED label for a household. Lives here rather than in the router because both the router
 * and the CSV import need it, and the import is imported BY the router — putting it in either would
 * make the two files circular.
 */
import { and, eq, ne } from 'drizzle-orm';
import { db } from '../db';
import { families, students, guardians, guardianFamilies, guardianUsers, emergencyContacts } from '../db/schema';
import type { Tx } from '../billing/ledger';
import { familyName as familyNameOf, displayName } from './names';

/**
 * The label for a household, DERIVED from the children in it — nobody is ever asked to name a family.
 * A family is not a thing an office maintains; it is just the link that makes siblings share
 * guardians, so its name should never be another field to keep up to date.
 *
 * One surname → "Ismail family". Several (step-siblings, a remarriage) → "Farooqi / Ismail", because
 * picking one child's surname to stand for the household would be wrong in exactly the cases where it
 * matters. Surnames are sorted so the label depends on WHO is in the household, not on the order they
 * were added — otherwise the same family would read differently on two installs.
 *
 * Names are one field now (`full_name`), so the surname is the last word — and some children have no
 * surname at all. A household of mononyms falls back to the children's own names rather than to the
 * word "Family", because "Bilal family" still tells the office whose record they are looking at. The
 * stored `families.name` is only ever reached by a household with no children yet (a CSV import can
 * create one); nobody types it.
 */
export function familyLabel(familyId: string, tx: Tx = db): string {
  const kids = tx.select({ fullName: students.fullName }).from(students).where(eq(students.familyId, familyId)).all();
  const label = (parts: string[]) => (parts.length === 1 ? `${parts[0]} family` : parts.join(' / '));
  const uniqueSorted = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b));

  const surnames = uniqueSorted(kids.map((k) => familyNameOf(k.fullName)));
  if (surnames.length) return label(surnames);
  const givenNames = uniqueSorted(kids.map((k) => displayName(k.fullName)));
  if (givenNames.length) return label(givenNames);
  return tx.select({ name: families.name }).from(families).where(eq(families.id, familyId)).get()?.name || 'Family';
}

/** One duplicate group that was folded: who survived, who was absorbed, under what name. */
export interface GuardianMerge {
  survivorId: string;
  absorbedIds: string[];
  name: string;
}

/** The keys that make two guardian rows the same PERSON. Empty when there is nothing to match on.
 *  Exported for the sibling suggester, which asks the same question across households: two children
 *  whose guardians share a phone number or an email address are very probably siblings. */
export function identityKeys(g: { name: string; phone: string | null; email: string | null }): string[] {
  const keys: string[] = [];
  const email = (g.email ?? '').trim().toLowerCase();
  if (email) keys.push(`email:${email}`);
  const digits = (g.phone ?? '').replace(/\D/g, '');
  // Seven digits is a local number; anything shorter is a fragment that could collide by accident.
  if (digits.length >= 7) keys.push(`phone:${digits.slice(-10)}`);
  const name = g.name.trim().toLowerCase().replace(/\s+/g, ' ');
  if (name) keys.push(`name:${name}`);
  return keys;
}

/**
 * Fold duplicate guardian records within ONE household into a single row.
 *
 * Why this exists: a CSV import gives every row its own household and its own guardian record (it
 * deliberately matches nothing — see people/import.ts). So a father with three children at the madrasa
 * arrives as three separate people. The moment the office links those children as siblings, all three
 * copies land on one household and the record reads "Abu Yusuf · Abu Yusuf · Abu Yusuf".
 *
 * Matching on name alone would be reckless across the whole install — plenty of madāris have two
 * unrelated Muhammad Alis. Inside a single household it is the opposite: two adults with the same
 * email, the same phone, or the same name are one person recorded twice, and the office has just told
 * us these children are siblings. So the scope of this function IS the safety argument, and it must
 * never be widened to run across households.
 *
 * Two rules keep it honest:
 *  - **A portal account is never touched silently.** If two duplicates both have parent logins, the
 *    group is left alone for a human to resolve; deleting a guardian CASCADES to `guardian_users` and
 *    would leave that parent able to sign in and see nothing.
 *  - **Blanks are filled, never overwritten.** One import row often carries the phone and another the
 *    email, so the survivor ends up with more information than either copy had, and no field is lost.
 */
export function mergeDuplicateGuardians(tx: Tx, familyId: string): { merged: number; groups: GuardianMerge[] } {
  const rows = tx
    .select({
      guardianId: guardians.id,
      name: guardians.name,
      phone: guardians.phone,
      email: guardians.email,
      createdAt: guardians.createdAt,
      relation: guardianFamilies.relation,
      isEmergencyContact: guardianFamilies.isEmergencyContact,
    })
    .from(guardianFamilies)
    .innerJoin(guardians, eq(guardians.id, guardianFamilies.guardianId))
    .where(eq(guardianFamilies.familyId, familyId))
    .all();
  if (rows.length < 2) return { merged: 0, groups: [] };

  const hasAccount = new Set(tx.select({ guardianId: guardianUsers.guardianId }).from(guardianUsers).all().map((r) => r.guardianId));

  // Group by ANY shared key: a pair matching on phone and a pair matching on email are one group if
  // they overlap, so three copies with partial details still collapse to one.
  const groups: { keys: Set<string>; members: typeof rows }[] = [];
  for (const r of rows) {
    const keys = identityKeys(r);
    const hit = groups.find((g) => keys.some((k) => g.keys.has(k)));
    if (hit) {
      hit.members.push(r);
      for (const k of keys) hit.keys.add(k);
    } else {
      groups.push({ keys: new Set(keys), members: [r] });
    }
  }

  const merged: GuardianMerge[] = [];
  for (const g of groups) {
    if (g.members.length < 2) continue;
    if (g.members.filter((m) => hasAccount.has(m.guardianId)).length > 1) continue; // two logins — human's call

    const score = (m: (typeof rows)[number]) => (hasAccount.has(m.guardianId) ? 100 : 0) + (m.phone ? 1 : 0) + (m.email ? 1 : 0);
    const ordered = [...g.members].sort((a, b) => score(b) - score(a) || a.createdAt.getTime() - b.createdAt.getTime() || a.guardianId.localeCompare(b.guardianId));
    const [survivor, ...absorbed] = ordered;

    const patch: { phone?: string; email?: string; updatedAt: Date } = { updatedAt: new Date() };
    if (!survivor.phone) patch.phone = absorbed.find((m) => m.phone)?.phone ?? undefined;
    if (!survivor.email) patch.email = absorbed.find((m) => m.email)?.email ?? undefined;
    if (patch.phone || patch.email) tx.update(guardians).set(patch).where(eq(guardians.id, survivor.guardianId)).run();

    // The link carries the relation and the emergency flag: keep whichever copy actually said something.
    const relation = survivor.relation ?? absorbed.find((m) => m.relation)?.relation ?? null;
    const emergency = survivor.isEmergencyContact || absorbed.some((m) => m.isEmergencyContact);
    if (relation !== survivor.relation || emergency !== survivor.isEmergencyContact) {
      tx.update(guardianFamilies)
        .set({ relation, isEmergencyContact: emergency })
        .where(and(eq(guardianFamilies.guardianId, survivor.guardianId), eq(guardianFamilies.familyId, familyId)))
        .run();
    }

    for (const m of absorbed) {
      tx.delete(guardianFamilies).where(and(eq(guardianFamilies.guardianId, m.guardianId), eq(guardianFamilies.familyId, familyId))).run();
      // Only delete the PERSON if this was their last household — a guardian can legitimately span
      // two families, and that other family still needs them.
      const elsewhere = tx
        .select({ familyId: guardianFamilies.familyId })
        .from(guardianFamilies)
        .where(and(eq(guardianFamilies.guardianId, m.guardianId), ne(guardianFamilies.familyId, familyId)))
        .get();
      if (!elsewhere) tx.delete(guardians).where(eq(guardians.id, m.guardianId)).run();
    }
    merged.push({ survivorId: survivor.guardianId, absorbedIds: absorbed.map((m) => m.guardianId), name: survivor.name });
  }
  return { merged: merged.reduce((n, m) => n + m.absorbedIds.length, 0), groups: merged };
}

/**
 * The same fold for emergency contacts, which duplicate for a different reason: the office adds "Uncle
 * Bilal" to each child's record separately, and only later links the children as siblings.
 *
 * Simpler than the guardian case — a contact is a name and a number with nothing hanging off it, so
 * there is no account to protect and no other household to keep it for. Returns how many rows went.
 */
export function mergeDuplicateContacts(tx: Tx, familyId: string): number {
  const rows = tx.select().from(emergencyContacts).where(eq(emergencyContacts.familyId, familyId)).all();
  if (rows.length < 2) return 0;

  const groups: { keys: Set<string>; members: typeof rows }[] = [];
  for (const r of rows) {
    const keys = identityKeys({ name: r.name, phone: r.phone, email: null });
    const hit = groups.find((g) => keys.some((k) => g.keys.has(k)));
    if (hit) {
      hit.members.push(r);
      for (const k of keys) hit.keys.add(k);
    } else {
      groups.push({ keys: new Set(keys), members: [r] });
    }
  }

  let removed = 0;
  for (const g of groups) {
    if (g.members.length < 2) continue;
    const ordered = [...g.members].sort(
      (a, b) => (b.phone ? 1 : 0) - (a.phone ? 1 : 0) || (b.relation ? 1 : 0) - (a.relation ? 1 : 0) || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
    );
    const [survivor, ...absorbed] = ordered;
    const patch: { phone?: string; relation?: string; updatedAt: Date } = { updatedAt: new Date() };
    if (!survivor.phone) patch.phone = absorbed.find((m) => m.phone)?.phone ?? undefined;
    if (!survivor.relation) patch.relation = absorbed.find((m) => m.relation)?.relation ?? undefined;
    if (patch.phone || patch.relation) tx.update(emergencyContacts).set(patch).where(eq(emergencyContacts.id, survivor.id)).run();
    for (const m of absorbed) {
      tx.delete(emergencyContacts).where(eq(emergencyContacts.id, m.id)).run();
      removed++;
    }
  }
  return removed;
}
