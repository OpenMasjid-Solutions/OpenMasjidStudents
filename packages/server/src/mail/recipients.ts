// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/** Who receives a family's transactional email (§4). A family's recipients are the email addresses
 *  of all its linked guardians (via guardian_families). Used for receipts + autopay-failure notices. */
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { guardians, guardianFamilies } from '../db/schema';
import { getParentMailPaused } from '../settings';

/** All valid guardian email addresses for a family (deduped). Empty when none is on file — and empty
 *  while parent mail is paused (0.48.0).
 *
 *  The senders in notify.ts each check the pause themselves, so this is a SECOND line, deliberately.
 *  This function's whole job is "the addresses of parents", and it is what any future parent-facing
 *  message will reach for; making it answer honestly that there is nobody to write to means the next
 *  such message is safe before anybody remembers the switch exists. It is only ever used to send. */
export function guardianEmailsForFamily(familyId: string): string[] {
  if (getParentMailPaused()) return [];
  const rows = db
    .select({ email: guardians.email })
    .from(guardianFamilies)
    .innerJoin(guardians, eq(guardians.id, guardianFamilies.guardianId))
    .where(eq(guardianFamilies.familyId, familyId))
    .all();
  const seen = new Set<string>();
  for (const r of rows) {
    const e = (r.email ?? '').trim();
    if (e.includes('@')) seen.add(e);
  }
  return [...seen];
}
