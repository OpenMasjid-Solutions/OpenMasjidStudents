// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * OFFICE NOTES on a child — the one place a note is written (0.52.0, §4a Phase 1, §16).
 *
 * Three callers write one: `people.studentAdd`/`studentCreate` (the note typed on the add form), the
 * spreadsheet importer (the file's Note column), and `people.studentNoteAdd` (the record screen). They
 * go through here so the author, the trimming and the blank-is-not-a-note rule are decided once.
 *
 * ── Append-only, and what that costs ────────────────────────────────────────
 *
 * There is no update and no delete, by design: a note is often the record of what somebody was told,
 * and rewriting it destroys the only copy. A correction is another note — the same shape as a ledger
 * reversal (§9's "payments immutable"). The cost is real and worth stating rather than discovering: an
 * office that types a note onto the wrong child cannot take it back, only add one saying so. If that
 * turns out to be the wrong trade in practice, the fix is a deletion that is ADMIN-ONLY and AUDITED —
 * and the audit row records the author and the length, never the body.
 *
 * The author is the PERSON (`recordingActor`), not the account (`auditActor`) — §9's distinction: the
 * office reads back "who wrote this?" and wants a name, while the forensic trail wants the identity an
 * admin can disable. An SSO admin has no local account and records plain `Admin`.
 */
import { desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { rid } from '../db/ids';
import { studentNotes, type StudentNote } from '../db/schema';
import type { Tx } from '../billing/ledger';

/** Who a note is attributed to. Shaped to take `recordingActor(ctx)` directly. */
export interface NoteAuthor {
  userId: string | null;
  name: string | null;
}

export const NOTE_MAX = 4000;

/**
 * Append a note. Returns its id, or `null` when there was nothing to write.
 *
 * A blank body is not a note and is silently skipped rather than refused: two of the three callers are
 * an optional field on a form and an optional column in a spreadsheet, where "left empty" is the normal
 * case and an error would be noise.
 */
export function addStudentNote(studentId: string, body: string | null | undefined, by: NoteAuthor, at = new Date(), tx?: Tx): string | null {
  const text = (body ?? '').trim();
  if (!text) return null;
  const id = rid('stn');
  (tx ?? db)
    .insert(studentNotes)
    .values({
      id,
      studentId,
      body: text.slice(0, NOTE_MAX),
      authorUserId: by.userId ?? null,
      // Never blank: a note nobody is attached to reads as though the app wrote it. `Office` is the
      // honest fallback for a session that has no display name at all.
      authorName: (by.name ?? '').trim() || 'Office',
      createdAt: at,
    })
    .run();
  return id;
}

/** A child's notes, newest first — the order an office reads them in. */
export function studentNotesFor(studentId: string): StudentNote[] {
  return db.select().from(studentNotes).where(eq(studentNotes.studentId, studentId)).orderBy(desc(studentNotes.createdAt)).all();
}
