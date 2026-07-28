// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The DERIVED label for a household. Lives here rather than in the router because both the router
 * and the CSV import need it, and the import is imported BY the router — putting it in either would
 * make the two files circular.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { families, students } from '../db/schema';
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
