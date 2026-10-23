// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * THE ONE IMPLEMENTATION OF "CREATE A STUDENT" (CLAUDE.md §16).
 *
 * `studentCreate` (into a known family), `studentAdd` (student-first, creating or joining a
 * household) and — from 0.52.0-dev.8 — `admissions/convert.ts` all come through here, so the
 * invariants below hold on every path rather than in whichever copy somebody remembered.
 *
 * **It lives in `people/` rather than in `trpc/people.ts`, where it was written.** Moving it was the
 * first thing Phase 2's conversion needed: `docs/ADMISSIONS.md` §4 step 2 says an inquiry becomes a
 * student "through the existing people write path, which is what mints the Student ID", and that path
 * was a module-private function inside a router. Reaching it from `admissions/` would have meant one
 * tRPC router importing another, or — far worse and the actual risk — a second implementation that
 * mints an ID its own way. Nothing about it changed in the move.
 *
 * TWO INVARIANTS IT EXISTS TO HOLD:
 *
 *  - **A FEE PLAN IS REQUIRED.** A student who exists but is on no plan is invisible to invoice
 *    generation, which is how a child silently stops being billed. The student and their fee are
 *    written in ONE transaction, with an optional per-student override so an unusual amount does not
 *    need a parallel plan.
 *  - **THE STUDENT ID IS GENERATED HERE AND NOWHERE ELSE** — derived from the given name, never
 *    accepted from a caller, never importable, never chosen (§9, §14). It is the whole credential on
 *    the payment path, so the set of places that can mint one is exactly this function.
 */
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { classes, families, feePlans, studentFees, students } from '../db/schema';
import { rid } from '../db/ids';
import { generateUniqueStudentCode } from '../billing/studentCodes';
import { displayName } from './names';
import { familyLabel } from './household';
import { addStudentNote } from './notes';
import { defaultSchoolId, schoolIdForClass } from '../schools';
import { audit, type AuditActor } from '../audit';
import type { Tx } from '../billing/ledger';

const now = () => new Date();
const blankToNull = (v: string | undefined | null): string | null => {
  const s = (v ?? '').trim();
  return s ? s : null;
};

export interface NewStudent {
  familyId: string;
  fullName: string;
  dob?: string;
  notes?: string;
  feePlanId: string;
  overrideAmountCents?: number;
  feeNote?: string;
  classId?: string;
  /** Which school to file them under (0.47.0). Ignored when `classId` is set — the class decides. */
  schoolId?: string;
  /** Who the first note is attributed to — the PERSON (`recordingActor`), not the account (§9). */
  noteBy?: { userId: string | null; name: string | null };
}

export function createStudentRow(input: NewStudent, actor: AuditActor, outer?: Tx): { id: string; studentCode: string } {
  const run = (tx: Tx) => {
    if (!tx.select({ id: families.id }).from(families).where(eq(families.id, input.familyId)).get()) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Family not found.' });
    }
    const plan = tx.select({ id: feePlans.id }).from(feePlans).where(and(eq(feePlans.id, input.feePlanId), eq(feePlans.status, 'active'))).get();
    if (!plan) throw new TRPCError({ code: 'NOT_FOUND', message: 'Fee plan not found.' });
    if (input.classId) {
      const k = tx.select({ id: classes.id, status: classes.status }).from(classes).where(eq(classes.id, input.classId)).get();
      if (!k) throw new TRPCError({ code: 'NOT_FOUND', message: 'Class not found.' });
      if (k.status !== 'active') throw new TRPCError({ code: 'CONFLICT', message: 'That class is archived.' });
    }
    const id = rid('stu');
    const ts = now();
    // Which school this child attends (0.47.0). The class decides it when there is one — a class
    // belongs to exactly one school, so anything else would file the child away from their own class
    // — otherwise the caller's chosen school, otherwise the only/first school there is. A sibling's
    // school is deliberately NOT inherited: two children in one household can attend different
    // schools, which is the case this whole feature exists for.
    const schoolId = (input.classId ? schoolIdForClass(input.classId) : null) ?? input.schoolId ?? defaultSchoolId();
    // The typed ID a parent uses at the kiosk. Derived from the given name, so it is generated here
    // rather than accepted from the caller — never importable, never chosen (§14).
    const studentCode = generateUniqueStudentCode(input.fullName);
    tx.insert(students)
      .values({
        id,
        familyId: input.familyId,
        fullName: displayName(input.fullName),
        dob: blankToNull(input.dob),
        status: 'active',
        schoolId,
        classId: input.classId ?? null,
        studentCode,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    // The note typed on the add form becomes the child's first authored note (0.52.0). It used to go
    // into `students.notes`, a column nothing rendered — see people/notes.ts.
    addStudentNote(id, input.notes, input.noteBy ?? { userId: actor.userId ?? null, name: null }, ts, tx);
    tx.insert(studentFees)
      .values({ id: rid('stf'), studentId: id, feePlanId: input.feePlanId, overrideAmountCents: input.overrideAmountCents ?? null, note: input.feeNote || null, createdAt: ts, updatedAt: ts })
      .run();
    // The household label is derived from its children, so adding one can change it.
    tx.update(families).set({ name: familyLabel(input.familyId, tx), updatedAt: ts }).where(eq(families.id, input.familyId)).run();
    return { id, studentCode };
  };
  // Reuse the caller's transaction when there is one (studentAdd wraps the family insert with this,
  // and so does admissions conversion), so a validation failure rolls back BOTH writes rather than
  // orphaning a household.
  const res = outer ? run(outer) : db.transaction(run);
  audit(actor, 'student.create', { entity: 'student', entityId: res.id, detail: { familyId: input.familyId, feePlanId: input.feePlanId, classId: input.classId ?? null } });
  return res;
}
