// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * People & SIS router (CLAUDE.md §4 SIS, §5 roles, §9 data rules, §14 audit).
 * Writes are admin-only; directory + record reads are admin OR finance (§5). Teachers
 * (own-class students) and parents (own family) get scoped reads once classes and
 * portal accounts exist — until then those roles simply have no access here (walls err
 * toward deny). Students are withdrawn, families archived — never hard-deleted (§9),
 * except the explicit `studentDelete` path below. Every create/update/withdraw is audited.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { router, adminProcedure, adminOrFinanceProcedure, auditActor } from './trpc';
import { db } from '../db';
import {
  families,
  students,
  guardians,
  guardianFamilies,
  emergencyContacts,
  feePlans,
  studentFees,
  invoiceItems,
  invoices,
  payments,
  charges,
  classes,
  guardianUsers,
  users,
  paymentMethods,
  autopayEnrollments,
  autopayRuns,
} from '../db/schema';
import { rid } from '../db/ids';
import { generateUniqueStudentCode } from '../billing/studentCodes';
import { displayName } from '../people/names';
import { familyLabel, mergeDuplicateGuardians, mergeDuplicateContacts } from '../people/household';
import { suggestSiblingGroups } from '../people/siblingSuggest';
import type { Tx } from '../billing/ledger';
import { audit } from '../audit';
import { IMPORT_FIELDS, IMPORT_EXAMPLE_ROWS, validateRows, commitRows, type ImportRow } from '../people/import';
import { defaultSchoolId, resolveSchoolScope, schoolIdForClass } from '../schools';

// ── input helpers ────────────────────────────────────────────────────────────
const REQ_NAME = z.string().trim().min(1).max(120);
const OPT_NAME = z.string().trim().max(120).optional();
const PHONE = z.string().trim().max(40).optional();
const EMAIL = z.string().trim().max(200).optional();
const NOTES = z.string().max(4000).optional();
/** A guardian's or contact's relationship to the child.
 *
 *  Free text on purpose, though the guardian form now offers a fixed FOUR (father / mother /
 *  relative / other, stored as those lowercase codes and translated for display). Two reasons not to
 *  make this a zod enum: rows written before 0.41.0 hold whatever the office typed ("Dad", "Uncle"),
 *  and a stricter column would make editing such a guardian's phone number fail on a field nobody
 *  touched. Emergency contacts stay genuinely free text — "neighbour", "aunt on the next street" is
 *  the useful answer there, not one of four. */
const RELATION = z.string().trim().max(60).optional();
const DOB = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();
const ID = z.string().min(1).max(64);
const blankToNull = (v: string | undefined): string | null => (v && v.trim() !== '' ? v.trim() : null);

/** One spreadsheet row as the dialog sends it: every cell optional and length-bounded. The real
 *  validation lives in people/import.ts so problems can be reported per row, not as one
 *  opaque zod failure the admin can't act on. */
const CELL = z.string().max(300).optional();
const IMPORT_ROW = z.object({
  fullName: CELL,
  dob: CELL,
  className: CELL,
  courseName: CELL,
  feePlanName: CELL,
  amount: CELL,
  guardianName: CELL,
  guardianRelation: CELL,
  guardianPhone: CELL,
  guardianEmail: CELL,
  note: CELL,
});

/** The office's answer to "is a Relative a guardian or an emergency contact?", once per distinct
 *  relation label the file used (0.48.0). Bounded because it is keyed by text out of a file. */
const PLACEMENTS = z.record(z.string().max(60), z.enum(['guardian', 'emergency'])).refine((r) => Object.keys(r).length <= 200, 'Too many relationships to place.');

const now = () => new Date();

interface NewStudent {
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
}

/**
 * THE one implementation of "create a student" — both `studentCreate` (into a known family) and
 * `studentAdd` (student-first, creating or joining one) go through here, so the invariants below hold
 * on every path rather than in whichever copy was remembered.
 *
 * A FEE PLAN IS REQUIRED: a student who exists but is on no plan is invisible to invoice generation,
 * which is how a child silently stops being billed. The student and their fee are written in ONE
 * transaction, with an optional per-student override so an unusual amount does not need a parallel
 * plan. `classId` is optional — a student may be unplaced.
 */
function createStudentRow(input: NewStudent, actor: ReturnType<typeof auditActor>, outer?: Tx): { id: string; studentCode: string } {
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
        notes: blankToNull(input.notes),
        schoolId,
        classId: input.classId ?? null,
        studentCode,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    tx.insert(studentFees)
      .values({ id: rid('stf'), studentId: id, feePlanId: input.feePlanId, overrideAmountCents: input.overrideAmountCents ?? null, note: input.feeNote || null, createdAt: ts, updatedAt: ts })
      .run();
    // The household label is derived from its children, so adding one can change it.
    tx.update(families).set({ name: familyLabel(input.familyId, tx), updatedAt: ts }).where(eq(families.id, input.familyId)).run();
    return { id, studentCode };
  };
  // Reuse the caller's transaction when there is one (studentAdd wraps the family insert with this),
  // so a validation failure rolls back BOTH writes rather than orphaning a household.
  const res = outer ? run(outer) : db.transaction(run);
  audit(actor, 'student.create', { entity: 'student', entityId: res.id, detail: { familyId: input.familyId, feePlanId: input.feePlanId, classId: input.classId ?? null } });
  return res;
}

function requireFamily(id: string) {
  const fam = db.select().from(families).where(eq(families.id, id)).get();
  if (!fam) throw new TRPCError({ code: 'NOT_FOUND', message: 'Family not found.' });
  return fam;
}
function requireStudent(id: string) {
  const s = db.select().from(students).where(eq(students.id, id)).get();
  if (!s) throw new TRPCError({ code: 'NOT_FOUND', message: 'Student not found.' });
  return s;
}

/**
 * Which school an import lands in — the one the admin picked, if they may use it, else their first
 * visible school (0.47.0).
 *
 * Both preview and commit resolve it through here so they cannot disagree: a preview that validated
 * class names against one school while the commit wrote them into another would report a clean file
 * and then import it wrong.
 */
function importSchool(ctx: { session?: { userId?: string | null } | null }, requested?: string): string | null {
  const scope = resolveSchoolScope(ctx.session?.userId ?? null, requested);
  return scope.requested ?? scope.ids[0] ?? defaultSchoolId();
}

export const peopleRouter = router({
  // ── Directory (admin | finance) ────────────────────────────────────────────
  /**
   * Families with their students + guardians.
   *
   * SCHOOL FILTERING (0.47.0) picks WHICH HOUSEHOLDS to list — those with at least one child in the
   * school in view — and then shows each of them WHOLE, siblings in other schools included.
   *
   * That is deliberate, and it follows from the household not being scoped (schools/index.ts). A
   * household has one balance covering every child in it; showing a filtered subset of the children
   * next to the full balance would be an arithmetic lie, and the office answering the phone about that
   * balance needs to see what makes it up. So the school switcher is a way to narrow a long list to the
   * families you are working with today, not an information boundary — the boundary is the ROLE, which
   * is enforced on every procedure regardless.
   */
  directory: adminOrFinanceProcedure.input(z.object({ schoolId: ID.optional() }).optional()).query(({ ctx, input }) => {
    const scope = resolveSchoolScope(ctx.session?.userId ?? null, input?.schoolId);
    const inScope = new Set(
      db.select({ familyId: students.familyId }).from(students).where(inArray(students.schoolId, scope.ids)).all().map((r) => r.familyId),
    );
    // A household with no children at all still belongs in the list — it is usually one mid-creation,
    // and hiding it would make it unreachable.
    const withKids = new Set(db.select({ familyId: students.familyId }).from(students).all().map((r) => r.familyId));
    const fams = db.select().from(families).all().filter((f) => inScope.has(f.id) || !withKids.has(f.id));
    const ids = fams.map((f) => f.id);
    const studs = ids.length
      ? db
          .select({ id: students.id, familyId: students.familyId, fullName: students.fullName, status: students.status, classId: students.classId, schoolId: students.schoolId })
          .from(students)
          .where(inArray(students.familyId, ids))
          .all()
      : [];
    const links = ids.length
      ? db
          .select({
            familyId: guardianFamilies.familyId,
            guardianId: guardians.id,
            name: guardians.name,
            relation: guardianFamilies.relation,
            isEmergencyContact: guardianFamilies.isEmergencyContact,
          })
          .from(guardianFamilies)
          .innerJoin(guardians, eq(guardians.id, guardianFamilies.guardianId))
          .where(inArray(guardianFamilies.familyId, ids))
          .all()
      : [];
    return fams.map((f) => ({
      id: f.id,
      name: f.name,
      status: f.status,
      students: studs.filter((s) => s.familyId === f.id),
      guardians: links.filter((l) => l.familyId === f.id),
    }));
  }),

  /** One family with everything on the record — students, guardians, emergency contacts. */
  familyGet: adminOrFinanceProcedure.input(z.object({ id: ID })).query(({ input }) => {
    const fam = requireFamily(input.id);
    const studs = db.select().from(students).where(eq(students.familyId, fam.id)).all();
    const links = db
      .select({
        guardianId: guardians.id,
        name: guardians.name,
        phone: guardians.phone,
        email: guardians.email,
        relation: guardianFamilies.relation,
        isEmergencyContact: guardianFamilies.isEmergencyContact,
      })
      .from(guardianFamilies)
      .innerJoin(guardians, eq(guardians.id, guardianFamilies.guardianId))
      .where(eq(guardianFamilies.familyId, fam.id))
      .all();
    // Which guardians have actually taken up a portal account, and whether that account is usable.
    // Without this the office cannot tell "invite never accepted" from "signed up and forgot their
    // password" — the difference between re-inviting and sending a reset.
    const accounts = new Map<string, { userId: string; status: string; lastSeen: Date | null }>();
    for (const a of db
      .select({ guardianId: guardianUsers.guardianId, userId: users.id, status: users.status, createdAt: users.createdAt })
      .from(guardianUsers)
      .innerJoin(users, eq(users.id, guardianUsers.userId))
      .all()) {
      accounts.set(a.guardianId, { userId: a.userId, status: a.status, lastSeen: null });
    }
    const withAccounts = links.map((g) => {
      const acc = accounts.get(g.guardianId);
      return {
        ...g,
        hasAccount: !!acc,
        accountStatus: acc?.status ?? null,
        /** A reset can only be sent to a guardian who has an account AND an email on file. */
        canSendReset: !!acc && acc.status === 'active' && !!(g.email ?? '').trim(),
      };
    });
    const contacts = db.select().from(emergencyContacts).where(eq(emergencyContacts.familyId, fam.id)).all();
    return { family: fam, students: studs, guardians: withAccounts, emergencyContacts: contacts };
  }),

  // ── Families (admin write) ─────────────────────────────────────────────────
  /**
   * Create a family directly. NOT a door the UI offers any more — adding people starts with a student
   * (`studentAdd`), which creates or joins a family for them and derives its label. This stays for the
   * CSV import, which really does group rows by a household column, and for tests.
   */
  familyCreate: adminProcedure.input(z.object({ name: REQ_NAME, notes: NOTES })).mutation(({ ctx, input }) => {
    const id = rid('fam');
    const ts = now();
    db.insert(families).values({ id, name: input.name, notes: blankToNull(input.notes), status: 'active', createdAt: ts, updatedAt: ts }).run();
    audit(auditActor(ctx), 'family.create', { entity: 'family', entityId: id, detail: { name: input.name } });
    return { id };
  }),

  /** Notes and archive status only. The LABEL is not settable: it is derived from the children
   *  (`familyLabel`) and refreshed whenever they change, so accepting one here would just be silently
   *  overwritten the next time a student was added. */
  familyUpdate: adminProcedure
    .input(z.object({ id: ID, notes: NOTES, status: z.enum(['active', 'archived']).optional() }))
    .mutation(({ ctx, input }) => {
      const fam = requireFamily(input.id);
      const patch: Partial<typeof families.$inferInsert> = { updatedAt: now() };
      if (input.notes !== undefined) patch.notes = blankToNull(input.notes);
      if (input.status !== undefined) patch.status = input.status;
      db.update(families).set(patch).where(eq(families.id, fam.id)).run();
      audit(auditActor(ctx), 'family.update', { entity: 'family', entityId: fam.id, detail: { fields: Object.keys(patch).filter((k) => k !== 'updatedAt') } });
      return { ok: true as const };
    }),

  // ── Students (admin write) ─────────────────────────────────────────────────
  /** Add a student to a household that already exists (the "add another child" button on a record).
   *  Returns their generated Student ID so the admin can note it straight away; thereafter it is on
   *  the student record and the statement. See `createStudentRow` for the invariants. */
  studentCreate: adminProcedure
    .input(
      z.object({
        familyId: ID,
        fullName: REQ_NAME,
        dob: DOB,
        notes: NOTES,
        feePlanId: ID,
        overrideAmountCents: z.number().int().min(0).max(100_000_000).optional(),
        feeNote: z.string().trim().max(200).optional(),
        classId: ID.optional(),
      }),
    )
    .mutation(({ ctx, input }) => createStudentRow(input, auditActor(ctx))),

  /**
   * THE way people are added (0.39.0): start with the student, not a household.
   *
   * `linkToStudentId` is the "add a sibling" path — pass an existing child and the new one joins their
   * family, which is what makes the guardians and emergency contacts already on file apply to them
   * too. Nothing is copied per-student; they hang off the family, so linking IS the sharing.
   *
   * With no link, a fresh family is created for this child and labelled from their surname. Nobody is
   * asked to name it: a family is plumbing that connects siblings, not a record an office maintains.
   */
  studentAdd: adminProcedure
    .input(
      z.object({
        fullName: REQ_NAME,
        dob: DOB,
        notes: NOTES,
        feePlanId: ID,
        overrideAmountCents: z.number().int().min(0).max(100_000_000).optional(),
        feeNote: z.string().trim().max(200).optional(),
        classId: ID.optional(),
        /** Which school to file them under (0.47.0). Only consulted when no class is chosen — a class
         *  already implies its school. Absent on a single-school install, where there is nothing to ask. */
        schoolId: ID.optional(),
        /** An existing sibling to share a household (and therefore guardians) with. */
        linkToStudentId: ID.optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const linked = input.linkToStudentId ? requireStudent(input.linkToStudentId) : null;
      // ONE transaction over both writes: without it, a student that fails validation (a bad fee plan,
      // an archived class) leaves the household it was about to join behind as an orphan row.
      const { familyId, r } = db.transaction((tx) => {
        let fid: string;
        if (linked) {
          fid = linked.familyId;
        } else {
          fid = rid('fam');
          const ts = now();
          // A placeholder, overwritten inside the same transaction: createStudentRow derives the real
          // label from the child once they exist. Nobody ever types a household name.
          tx.insert(families).values({ id: fid, name: 'Family', status: 'active', createdAt: ts, updatedAt: ts }).run();
        }
        return { familyId: fid, r: createStudentRow({ ...input, familyId: fid }, auditActor(ctx), tx) };
      });
      if (!linked) audit(auditActor(ctx), 'family.create', { entity: 'family', entityId: familyId, detail: { via: 'studentAdd' } });
      return { ...r, familyId, familyLabel: familyLabel(familyId) };
    }),

  /**
   * Every active student, ready to be picked — for linking a sibling, and for the office's payment box.
   *
   * Carries the Student ID and the household label as well as the name, because the picker is a
   * type-to-search list and a madrasa really does enrol two children called Muhammad Ali. A name alone
   * makes those two rows indistinguishable at the moment of choosing, which is the one moment it
   * matters; the ID disambiguates them and the household says who they are already with.
   *
   * (Named `siblingOptions` until 0.43.0, when recording a payment started with the same picker — a
   * name that described one of its two callers was worse than a plain one.)
   */
  studentOptions: adminOrFinanceProcedure.query(() =>
    db
      .select({ id: students.id, fullName: students.fullName, studentCode: students.studentCode, familyId: students.familyId, familyName: families.name })
      .from(students)
      .innerJoin(families, eq(families.id, students.familyId))
      .where(eq(students.status, 'active'))
      .orderBy(students.fullName)
      .all(),
  ),

  studentUpdate: adminProcedure
    .input(
      z.object({
        id: ID,
        fullName: OPT_NAME,
        dob: z.union([DOB, z.literal('')]).optional(),
        notes: NOTES,
        status: z.enum(['active', 'withdrawn']).optional(),
        classId: z.union([ID, z.literal('')]).optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const s = requireStudent(input.id);
      const patch: Partial<typeof students.$inferInsert> = { updatedAt: now() };
      if (input.fullName !== undefined) patch.fullName = displayName(input.fullName);
      if (input.dob !== undefined) patch.dob = blankToNull(input.dob);
      if (input.notes !== undefined) patch.notes = blankToNull(input.notes);
      if (input.status !== undefined) patch.status = input.status;
      if (input.classId !== undefined) {
        const cid = blankToNull(input.classId);
        if (cid) {
          const k = db.select({ id: classes.id, status: classes.status }).from(classes).where(eq(classes.id, cid)).get();
          if (!k) throw new TRPCError({ code: 'NOT_FOUND', message: 'Class not found.' });
          if (k.status !== 'active') throw new TRPCError({ code: 'CONFLICT', message: 'That class is archived.' });
        }
        patch.classId = cid;
      }
      db.update(students).set(patch).where(eq(students.id, s.id)).run();
      // Renaming a child can change the household label, which is derived from the children's surnames.
      if (patch.fullName !== undefined) {
        db.update(families).set({ name: familyLabel(s.familyId), updatedAt: now() }).where(eq(families.id, s.familyId)).run();
      }
      const action = input.status && input.status !== s.status ? `student.${input.status === 'withdrawn' ? 'withdraw' : 'reinstate'}` : 'student.update';
      audit(auditActor(ctx), action, { entity: 'student', entityId: s.id, detail: { fields: Object.keys(patch).filter((k) => k !== 'updatedAt') } });
      return { ok: true as const };
    }),

  /**
   * Add a student to THIS household as a sibling — the one sibling control the office uses.
   *
   * It takes the household you are already looking at plus the child to bring into it, because that
   * is the whole of what the office knows: you have a record open, and this other child belongs on
   * it. (Until 0.41.0 this asked for a source student as well — "which of these is the sibling of
   * whom" — which was a question with no useful answer: every student on the record shares one
   * household already, so any of them gave the same result.)
   *
   * It MERGES the joining child's household into this one rather than moving the child alone, because
   * sibling-hood is transitive — if A and B are siblings then everyone already in A's household is in
   * B's too. Guardians and emergency contacts hang off the household, so merging is exactly what makes
   * this family's parent details apply to the child who joins; nothing is copied per-student. The
   * emptied household is then removed, so linking cannot leave a stranded record behind.
   *
   * Invoices and payments belong to the STUDENT (0.39.0), so billing history follows each child
   * untouched — no money row is rewritten.
   *
   * It REFUSES when the household being absorbed has card/autopay state, because those hang off that
   * family's Stripe Customer and quietly re-pointing them at another customer is not something to do
   * behind an office's back. Rare in practice: linking happens when children are enrolled, long
   * before a parent saves a card.
   */
  familyAddSibling: adminProcedure.input(z.object({ familyId: ID, studentId: ID })).mutation(({ ctx, input }) => {
    const s = requireStudent(input.studentId);
    const to = requireFamily(input.familyId).id;
    if (s.familyId === to) return { ok: true as const, merged: false, familyId: to };

    // The household on screen is the one that SURVIVES: it is the record the office is reading, with
    // the guardians and Stripe customer they can see. The joining child's household is absorbed.
    const from = s.familyId;
    const blockers: string[] = [];
    const fromFam = requireFamily(from);
    if (fromFam.stripeCustomerId) blockers.push('a Stripe customer');
    if (db.select({ id: paymentMethods.id }).from(paymentMethods).where(eq(paymentMethods.familyId, from)).get()) blockers.push('saved cards');
    if (db.select({ familyId: autopayEnrollments.familyId }).from(autopayEnrollments).where(eq(autopayEnrollments.familyId, from)).get()) blockers.push('autopay');
    if (db.select({ id: autopayRuns.id }).from(autopayRuns).where(eq(autopayRuns.familyId, from)).get()) blockers.push('autopay history');
    if (blockers.length) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: `This student’s household has ${blockers.join(' and ')} set up, so it can’t be merged automatically. Remove those first — or open that household and add these children to it instead, which merges it the other way round.`,
      });
    }

    const moved = db.transaction((tx) => {
      const kids = tx.update(students).set({ familyId: to, updatedAt: now() }).where(eq(students.familyId, from)).run().changes;
      // A guardian already on the target household would violate the (guardian, family) primary key.
      const already = new Set(tx.select({ guardianId: guardianFamilies.guardianId }).from(guardianFamilies).where(eq(guardianFamilies.familyId, to)).all().map((g) => g.guardianId));
      for (const link of tx.select().from(guardianFamilies).where(eq(guardianFamilies.familyId, from)).all()) {
        if (already.has(link.guardianId)) tx.delete(guardianFamilies).where(and(eq(guardianFamilies.guardianId, link.guardianId), eq(guardianFamilies.familyId, from))).run();
        else tx.update(guardianFamilies).set({ familyId: to }).where(and(eq(guardianFamilies.guardianId, link.guardianId), eq(guardianFamilies.familyId, from))).run();
      }
      const contacts = tx.update(emergencyContacts).set({ familyId: to, updatedAt: now() }).where(eq(emergencyContacts.familyId, from)).run().changes;
      // Empty now, and nothing money-side ever referenced it — see the guard above.
      tx.delete(families).where(eq(families.id, from)).run();
      // The `already` check above only catches the SAME guardian row on both households. After a CSV
      // import the same father exists as two different rows, one per child, so linking the children
      // produced "Abu Yusuf · Abu Yusuf" on the record. Fold those together here — see
      // mergeDuplicateGuardians for why matching by name is safe inside one household and nowhere else.
      const dupes = mergeDuplicateGuardians(tx, to);
      const dedupedContacts = mergeDuplicateContacts(tx, to);
      tx.update(families).set({ name: familyLabel(to, tx), updatedAt: now() }).where(eq(families.id, to)).run();
      return { kids, contacts, dupes: dupes.merged, dedupedContacts };
    });
    audit(auditActor(ctx), 'student.linkSiblings', {
      entity: 'student',
      entityId: s.id,
      detail: { from, to, movedStudents: moved.kids, movedContacts: moved.contacts, mergedGuardians: moved.dupes, mergedContacts: moved.dedupedContacts },
    });
    // The counts come back so the UI can say "…and merged 2 duplicate guardian records", rather than
    // the office noticing on their own that a row they expected to see twice is now there once.
    return { ok: true as const, merged: true, familyId: to, mergedGuardians: moved.dupes, mergedContacts: moved.dedupedContacts };
  }),

  /**
   * Sibling suggestions for children who are alone in their household — the job a CSV import leaves.
   *
   * A query with no input: "alone in their household" is the population that needs checking, whether
   * the import ran five seconds or three months ago. See people/siblingSuggest.ts for why contact
   * matches and surname matches are reported as separate strengths of evidence.
   */
  siblingSuggestions: adminProcedure.query(() => suggestSiblingGroups()),

  /**
   * Link a whole suggested group in one action — accept the suggestion, not two children at a time.
   *
   * Everyone joins the household of the FIRST child by name, chosen only because it has to be
   * deterministic. The merge is the same one `familyAddSibling` performs (guardians and contacts come
   * across, duplicates fold together, emptied households go), done once per joining child inside a
   * single transaction so a half-linked group cannot exist.
   *
   * It REFUSES if any household in the group carries card/autopay state, for the same reason
   * `familyAddSibling` does: those hang off that family's Stripe customer. Newly imported children
   * never have any, so in the flow this exists for it never fires.
   */
  linkSiblingGroup: adminProcedure.input(z.object({ studentIds: z.array(ID).min(2).max(50) })).mutation(({ ctx, input }) => {
    const kids = input.studentIds.map((id) => requireStudent(id));
    const families_ = [...new Set(kids.map((k) => k.familyId))];
    if (families_.length < 2) return { ok: true as const, familyId: kids[0].familyId, linked: 0, mergedGuardians: 0, mergedContacts: 0 };

    // Deterministic survivor: the alphabetically first child's household. Nothing else distinguishes
    // them — they are all single-child households a moment out of a spreadsheet.
    const anchor = [...kids].sort((a, b) => a.fullName.localeCompare(b.fullName))[0];
    const to = anchor.familyId;
    const from = families_.filter((f) => f !== to);

    for (const f of from) {
      const blockers: string[] = [];
      const fam = requireFamily(f);
      if (fam.stripeCustomerId) blockers.push('a Stripe customer');
      if (db.select({ id: paymentMethods.id }).from(paymentMethods).where(eq(paymentMethods.familyId, f)).get()) blockers.push('saved cards');
      if (db.select({ familyId: autopayEnrollments.familyId }).from(autopayEnrollments).where(eq(autopayEnrollments.familyId, f)).get()) blockers.push('autopay');
      if (db.select({ id: autopayRuns.id }).from(autopayRuns).where(eq(autopayRuns.familyId, f)).get()) blockers.push('autopay history');
      if (blockers.length) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `One of these students’ households has ${blockers.join(' and ')} set up, so it can’t be merged automatically. Link the others, then sort that one out by hand.`,
        });
      }
    }

    const res = db.transaction((tx) => {
      const ts = now();
      for (const f of from) {
        tx.update(students).set({ familyId: to, updatedAt: ts }).where(eq(students.familyId, f)).run();
        const already = new Set(tx.select({ guardianId: guardianFamilies.guardianId }).from(guardianFamilies).where(eq(guardianFamilies.familyId, to)).all().map((g) => g.guardianId));
        for (const link of tx.select().from(guardianFamilies).where(eq(guardianFamilies.familyId, f)).all()) {
          if (already.has(link.guardianId)) tx.delete(guardianFamilies).where(and(eq(guardianFamilies.guardianId, link.guardianId), eq(guardianFamilies.familyId, f))).run();
          else tx.update(guardianFamilies).set({ familyId: to }).where(and(eq(guardianFamilies.guardianId, link.guardianId), eq(guardianFamilies.familyId, f))).run();
        }
        tx.update(emergencyContacts).set({ familyId: to, updatedAt: ts }).where(eq(emergencyContacts.familyId, f)).run();
        tx.delete(families).where(eq(families.id, f)).run();
      }
      // Once, at the end: the same father arriving from four rows collapses to one record here.
      const dupes = mergeDuplicateGuardians(tx, to);
      const dedupedContacts = mergeDuplicateContacts(tx, to);
      tx.update(families).set({ name: familyLabel(to, tx), updatedAt: ts }).where(eq(families.id, to)).run();
      return { mergedGuardians: dupes.merged, mergedContacts: dedupedContacts };
    });

    audit(auditActor(ctx), 'student.linkSiblingGroup', { entity: 'family', entityId: to, detail: { students: kids.length, households: from.length, ...res } });
    return { ok: true as const, familyId: to, linked: kids.length, ...res };
  }),

  /**
   * Undo a link: move ONE child out into a household of their own. The counterpart to the merge
   * above, for the case the merge is meant to serve — someone linked the wrong two children.
   *
   * Their own billing history follows them (it is per-student). What does NOT follow is the
   * guardians, because those belong to the household they are leaving; the office re-adds whoever
   * actually belongs to the new one. Refusing to guess is right here — silently copying a guardian
   * onto a household they may have no relationship with is worse than an empty contact list.
   */
  studentUnlinkSiblings: adminProcedure.input(z.object({ studentId: ID })).mutation(({ ctx, input }) => {
    const s = requireStudent(input.studentId);
    const siblings = db.select({ id: students.id }).from(students).where(and(eq(students.familyId, s.familyId), ne(students.id, s.id))).all().length;
    if (!siblings) return { ok: true as const, moved: false, familyId: s.familyId };
    const fid = db.transaction((tx) => {
      const id = rid('fam');
      const ts = now();
      tx.insert(families).values({ id, name: 'Family', status: 'active', createdAt: ts, updatedAt: ts }).run();
      tx.update(students).set({ familyId: id, updatedAt: ts }).where(eq(students.id, s.id)).run();
      tx.update(families).set({ name: familyLabel(id, tx), updatedAt: ts }).where(eq(families.id, id)).run();
      tx.update(families).set({ name: familyLabel(s.familyId, tx), updatedAt: ts }).where(eq(families.id, s.familyId)).run();
      return id;
    });
    audit(auditActor(ctx), 'student.unlinkSiblings', { entity: 'student', entityId: s.id, detail: { from: s.familyId, to: fid } });
    return { ok: true as const, moved: true, familyId: fid };
  }),

  // ── CSV import ───────────────────────────────────────────────────────────────
  /** The canonical column set. The dialog uses this both to build the blank template and to
   *  auto-match the uploaded file's headers, so there is one source of truth. */
  /**
   * The columns the importer understands, and the example rows the template is filled with.
   *
   * The examples come from the SERVER, beside the field registry (people/import.ts), for one reason: the
   * validator refuses a row that is still an untouched example, and it compares against the same
   * constant. A copy in the browser is how that guard would quietly stop matching.
   */
  importTemplate: adminProcedure.query(() => ({
    fields: IMPORT_FIELDS.map((f) => ({ key: f.key, label: f.label, required: f.required, aliases: [...f.aliases] })),
    /** Rows of cells in `fields` order. */
    example: IMPORT_EXAMPLE_ROWS.map((r) => [...r]),
  })),

  /** Dry run. Resolves families / classes / fee plans and reports per-row problems so the dialog
   *  can show them before anything is written. A mutation, not a query, because the rows go in the
   *  request BODY — a few hundred rows would not survive a query string. */
  importPreview: adminProcedure
    .input(z.object({ rows: z.array(IMPORT_ROW).min(1).max(2000), defaultFeePlanId: ID.optional(), schoolId: ID.optional(), placements: PLACEMENTS.optional() }))
    .mutation(({ ctx, input }) =>
      validateRows(input.rows as ImportRow[], { defaultFeePlanId: input.defaultFeePlanId ?? null, schoolId: importSchool(ctx, input.schoolId), placements: input.placements }),
    ),

  /** Commit. Re-validates and writes everything in ONE transaction — all rows land or none do.
   *  Returns each new student's ID so the admin can print them (never logged, never audited). */
  importCommit: adminProcedure
    .input(z.object({ rows: z.array(IMPORT_ROW).min(1).max(2000), defaultFeePlanId: ID.optional(), schoolId: ID.optional(), placements: PLACEMENTS.optional() }))
    .mutation(({ ctx, input }) => {
      let res;
      try {
        res = commitRows(input.rows as ImportRow[], {
          defaultFeePlanId: input.defaultFeePlanId ?? null,
          schoolId: importSchool(ctx, input.schoolId),
          placements: input.placements,
        });
      } catch (e) {
        if ((e as Error).message === 'invalid_rows') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Some rows still have problems — fix them and try again.' });
        }
        throw e;
      }
      // Counts only: never the names or the Student IDs (§14).
      audit(auditActor(ctx), 'student.import', {
        entity: 'people',
        detail: {
          created: res.created,
          familiesCreated: res.familiesCreated,
          guardiansCreated: res.guardiansCreated,
          contactsCreated: res.contactsCreated,
          // How many file rows were folded into the student above them — the one number that says
          // whether the file was the multi-row shape, without recording any of its contents.
          mergedRows: res.mergedCount,
        },
      });
      return res;
    }),

  /**
   * Can this student be deleted outright, and if not, why not?
   *
   * FIVE tables reference `students`, all ON DELETE RESTRICT, and they are not equal:
   *   - `student_fees` is CONFIGURATION — which plans they carry. Deleting it with them is correct.
   *   - `invoice_items` and `invoices` are MONEY HISTORY — a bill that was actually raised. Removing a
   *     student who appears on one would silently change what that invoice says it was for, which is
   *     exactly the immutability §9 protects.
   *   - `payments` is MONEY THAT ARRIVED. Even with nothing billed — a parent paying a term ahead —
   *     that row is the masjid's record of cash it received, and no tidying-up of a student list is
   *     worth erasing it.
   *   - `charges` is either: a `pending`/`void` charge is not yet money and goes with them; an
   *     `invoiced` one is money history and blocks.
   *
   * So: delete is for a mistake (wrong name typed, duplicate row, a child who never actually
   * enrolled). A student who has ever been billed OR paid is withdrawn, not deleted — which stops all
   * future billing, since invoice generation only ever looks at `active` students.
   *
   * `payments` and `invoices` were missing from this check until 0.42.0, so a child with an advance
   * payment reported `deletable: true` and the delete then died on the constraint — surfacing a raw
   * "FOREIGN KEY constraint failed" to the office (§15: never).
   */
  studentDeletable: adminProcedure.input(z.object({ studentId: ID })).query(({ input }) => {
    const s = requireStudent(input.studentId);
    const invoiceLines = db.select({ id: invoiceItems.id }).from(invoiceItems).where(eq(invoiceItems.studentId, s.id)).all().length;
    const invoicedCharges = db.select({ id: charges.id }).from(charges).where(and(eq(charges.studentId, s.id), eq(charges.status, 'invoiced'))).all().length;
    const bills = db.select({ id: invoices.id }).from(invoices).where(eq(invoices.studentId, s.id)).all().length;
    // Every payment row, INCLUDING reversals: a reversed payment nets to zero but the pair is still
    // the story of money that came in and went back out, and that story is the ledger.
    const paymentRows = db.select({ id: payments.id }).from(payments).where(eq(payments.studentId, s.id)).all().length;
    return {
      deletable: invoiceLines === 0 && invoicedCharges === 0 && bills === 0 && paymentRows === 0,
      invoiceLines,
      invoicedCharges,
      /** Invoices raised for them, and payments recorded against them — both block. */
      invoices: bills,
      payments: paymentRows,
      /** Config rows that will be removed along with them. */
      feeAssignments: db.select({ id: studentFees.id }).from(studentFees).where(eq(studentFees.studentId, s.id)).all().length,
      pendingCharges: db.select({ id: charges.id }).from(charges).where(and(eq(charges.studentId, s.id), ne(charges.status, 'invoiced'))).all().length,
    };
  }),

  /**
   * Delete a student for good — the "not just withdrawn" case: a duplicate, a typo, someone who never
   * actually enrolled. Refuses whenever the student carries money history (see `studentDeletable`),
   * because a raised invoice must keep meaning what it said.
   *
   * Their fee assignments and any not-yet-invoiced charges go with them, in ONE transaction, since the
   * RESTRICT constraints would otherwise block the delete. Audited with the counts (never the name).
   */
  studentDelete: adminProcedure.input(z.object({ studentId: ID })).mutation(({ ctx, input }) => {
    const s = requireStudent(input.studentId);
    const invoiceLines = db.select({ id: invoiceItems.id }).from(invoiceItems).where(eq(invoiceItems.studentId, s.id)).all().length;
    const invoicedCharges = db.select({ id: charges.id }).from(charges).where(and(eq(charges.studentId, s.id), eq(charges.status, 'invoiced'))).all().length;
    const bills = db.select({ id: invoices.id }).from(invoices).where(eq(invoices.studentId, s.id)).all().length;
    const paymentRows = db.select({ id: payments.id }).from(payments).where(eq(payments.studentId, s.id)).all().length;
    if (invoiceLines > 0 || invoicedCharges > 0 || bills > 0) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'This student has been billed, so their record is part of your invoice history and can’t be deleted. Mark them withdrawn instead — that stops all future billing and keeps the history intact.',
      });
    }
    // Money that arrived is not ours to delete, even when nothing was ever billed (a term paid in
    // advance). Withdrawal is the right move; the payment stays on the books where it belongs.
    if (paymentRows > 0) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'A payment has been recorded for this student, so their record is part of your payment history and can’t be deleted. Mark them withdrawn instead — that stops all future billing. If the payment belongs to a different child, reverse it first, then record it against the right one.',
      });
    }
    let removedFees = 0;
    let removedCharges = 0;
    db.transaction((tx) => {
      removedCharges = tx.delete(charges).where(eq(charges.studentId, s.id)).run().changes;
      removedFees = tx.delete(studentFees).where(eq(studentFees.studentId, s.id)).run().changes;
      tx.delete(students).where(eq(students.id, s.id)).run();
    });
    audit(auditActor(ctx), 'student.delete', { entity: 'student', entityId: s.id, detail: { familyId: s.familyId, removedFees, removedCharges } });
    return { ok: true as const, removedFees, removedCharges };
  }),

  // ── Guardians + emergency contacts (admin write) ───────────────────────────
  guardianCreate: adminProcedure
    .input(z.object({ familyId: ID, name: REQ_NAME, phone: PHONE, email: EMAIL, relation: RELATION, isEmergencyContact: z.boolean().optional() }))
    .mutation(({ ctx, input }) => {
      requireFamily(input.familyId);
      const id = rid('grd');
      const ts = now();
      db.transaction((tx) => {
        tx.insert(guardians).values({ id, name: input.name, phone: blankToNull(input.phone), email: blankToNull(input.email), createdAt: ts, updatedAt: ts }).run();
        tx.insert(guardianFamilies)
          .values({ guardianId: id, familyId: input.familyId, relation: blankToNull(input.relation), isEmergencyContact: input.isEmergencyContact ?? false, createdAt: ts })
          .run();
      });
      audit(auditActor(ctx), 'guardian.create', { entity: 'guardian', entityId: id, detail: { familyId: input.familyId } });
      return { id };
    }),

  /** Edit a guardian. `relation` needs a `familyId` alongside it: a guardian can span households
   *  (a father of children in two families after a remarriage), so the relationship is a property of
   *  the LINK, not of the person — updating it without saying which household would be guesswork. */
  guardianUpdate: adminProcedure
    .input(z.object({ id: ID, name: OPT_NAME, phone: PHONE, email: EMAIL, familyId: ID.optional(), relation: RELATION }))
    .mutation(({ ctx, input }) => {
      const g = db.select().from(guardians).where(eq(guardians.id, input.id)).get();
      if (!g) throw new TRPCError({ code: 'NOT_FOUND', message: 'Guardian not found.' });
      const patch: Partial<typeof guardians.$inferInsert> = { updatedAt: now() };
      if (input.name !== undefined) patch.name = input.name;
      if (input.phone !== undefined) patch.phone = blankToNull(input.phone);
      if (input.email !== undefined) patch.email = blankToNull(input.email);
      db.update(guardians).set(patch).where(eq(guardians.id, g.id)).run();
      if (input.relation !== undefined) {
        if (!input.familyId) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Say which household the relationship is in.' });
        const link = db
          .select({ guardianId: guardianFamilies.guardianId })
          .from(guardianFamilies)
          .where(and(eq(guardianFamilies.guardianId, g.id), eq(guardianFamilies.familyId, input.familyId)))
          .get();
        if (!link) throw new TRPCError({ code: 'NOT_FOUND', message: 'That guardian isn’t on this household.' });
        db.update(guardianFamilies)
          .set({ relation: blankToNull(input.relation) })
          .where(and(eq(guardianFamilies.guardianId, g.id), eq(guardianFamilies.familyId, input.familyId)))
          .run();
      }
      audit(auditActor(ctx), 'guardian.update', { entity: 'guardian', entityId: g.id });
      return { ok: true as const };
    }),

  /** Link an existing guardian to another family (guardians can span families). */
  guardianLinkFamily: adminProcedure
    .input(z.object({ guardianId: ID, familyId: ID, relation: RELATION, isEmergencyContact: z.boolean().optional() }))
    .mutation(({ ctx, input }) => {
      requireFamily(input.familyId);
      const g = db.select({ id: guardians.id }).from(guardians).where(eq(guardians.id, input.guardianId)).get();
      if (!g) throw new TRPCError({ code: 'NOT_FOUND', message: 'Guardian not found.' });
      const existing = db
        .select()
        .from(guardianFamilies)
        .where(and(eq(guardianFamilies.guardianId, input.guardianId), eq(guardianFamilies.familyId, input.familyId)))
        .get();
      if (existing) throw new TRPCError({ code: 'CONFLICT', message: 'That guardian is already linked to this family.' });
      db.insert(guardianFamilies)
        .values({ guardianId: input.guardianId, familyId: input.familyId, relation: blankToNull(input.relation), isEmergencyContact: input.isEmergencyContact ?? false, createdAt: now() })
        .run();
      audit(auditActor(ctx), 'guardian.link', { entity: 'guardian', entityId: input.guardianId, detail: { familyId: input.familyId } });
      return { ok: true as const };
    }),

  /**
   * What removing this guardian from this household would actually do — asked before the click.
   *
   * Three outcomes, and the office must be told which one they are about to get:
   *  - the guardian is on ANOTHER household too → they are only unlinked from this one, and the person
   *    (and their login) carries on for that other family;
   *  - they are on this household only → the person is deleted;
   *  - they are on this household only AND have a parent portal login → the login goes with them,
   *    because `guardian_users` cascades and a login with no family attached can sign in and see
   *    nothing. That is worth a sentence, not a surprise.
   */
  guardianRemovable: adminProcedure.input(z.object({ guardianId: ID, familyId: ID })).query(({ input }) => {
    const g = db.select({ id: guardians.id, name: guardians.name }).from(guardians).where(eq(guardians.id, input.guardianId)).get();
    if (!g) throw new TRPCError({ code: 'NOT_FOUND', message: 'Guardian not found.' });
    const otherFamilies = db
      .select({ familyId: guardianFamilies.familyId })
      .from(guardianFamilies)
      .where(and(eq(guardianFamilies.guardianId, g.id), ne(guardianFamilies.familyId, input.familyId)))
      .all().length;
    const account = db
      .select({ userId: users.id, status: users.status })
      .from(guardianUsers)
      .innerJoin(users, eq(users.id, guardianUsers.userId))
      .where(eq(guardianUsers.guardianId, g.id))
      .get();
    return {
      name: g.name,
      otherFamilies,
      /** True when this is their last household, so the person themself goes. */
      deletesPerson: otherFamilies === 0,
      hasAccount: !!account,
      accountStatus: account?.status ?? null,
      /** True when the parent's portal login goes too — only ever alongside deleting the person. */
      deletesAccount: otherFamilies === 0 && !!account,
    };
  }),

  /**
   * Remove a guardian from a household — unlink if they belong elsewhere too, delete outright if this
   * was their only one. See `guardianRemovable` for which of the two will happen.
   *
   * A guardian carries no money, so there is nothing here to protect the way `studentDelete` protects
   * invoices: contact details are corrections, not history. The one consequence worth handling is the
   * portal login, which is deleted with the person rather than left orphaned — `sessions` cascades off
   * `users`, so an open browser session dies with it, and `payments.recorded_by_user_id` is a plain
   * column (not a foreign key), so who-recorded-what survives untouched in the ledger.
   */
  guardianRemove: adminProcedure.input(z.object({ guardianId: ID, familyId: ID })).mutation(({ ctx, input }) => {
    const g = db.select({ id: guardians.id }).from(guardians).where(eq(guardians.id, input.guardianId)).get();
    if (!g) throw new TRPCError({ code: 'NOT_FOUND', message: 'Guardian not found.' });
    const link = db
      .select({ guardianId: guardianFamilies.guardianId })
      .from(guardianFamilies)
      .where(and(eq(guardianFamilies.guardianId, g.id), eq(guardianFamilies.familyId, input.familyId)))
      .get();
    if (!link) throw new TRPCError({ code: 'NOT_FOUND', message: 'That guardian isn’t on this household.' });

    const res = db.transaction((tx) => {
      tx.delete(guardianFamilies).where(and(eq(guardianFamilies.guardianId, g.id), eq(guardianFamilies.familyId, input.familyId))).run();
      const elsewhere = tx.select({ familyId: guardianFamilies.familyId }).from(guardianFamilies).where(eq(guardianFamilies.guardianId, g.id)).get();
      if (elsewhere) return { unlinkedOnly: true as const, deletedAccount: false };
      // Their last household: take the person, and the login that pointed at them.
      const accountIds = tx.select({ userId: guardianUsers.userId }).from(guardianUsers).where(eq(guardianUsers.guardianId, g.id)).all().map((r) => r.userId);
      tx.delete(guardians).where(eq(guardians.id, g.id)).run(); // cascades guardian_families + guardian_users
      let deletedAccount = false;
      for (const userId of accountIds) {
        // Only if that login has no OTHER guardian to stand for — a shared account across households
        // is unusual but must not be cut off from a family it still belongs to.
        const stillLinked = tx.select({ guardianId: guardianUsers.guardianId }).from(guardianUsers).where(eq(guardianUsers.userId, userId)).get();
        if (!stillLinked) {
          tx.delete(users).where(eq(users.id, userId)).run();
          deletedAccount = true;
        }
      }
      return { unlinkedOnly: false as const, deletedAccount };
    });

    audit(auditActor(ctx), res.unlinkedOnly ? 'guardian.unlink' : 'guardian.delete', {
      entity: 'guardian',
      entityId: g.id,
      detail: { familyId: input.familyId, deletedAccount: res.deletedAccount },
    });
    return { ok: true as const, ...res };
  }),

  guardianUnlinkFamily: adminProcedure.input(z.object({ guardianId: ID, familyId: ID })).mutation(({ ctx, input }) => {
    db.delete(guardianFamilies)
      .where(and(eq(guardianFamilies.guardianId, input.guardianId), eq(guardianFamilies.familyId, input.familyId)))
      .run();
    audit(auditActor(ctx), 'guardian.unlink', { entity: 'guardian', entityId: input.guardianId, detail: { familyId: input.familyId } });
    return { ok: true as const };
  }),

  emergencyContactAdd: adminProcedure
    .input(z.object({ familyId: ID, name: REQ_NAME, phone: PHONE, relation: RELATION }))
    .mutation(({ ctx, input }) => {
      requireFamily(input.familyId);
      const id = rid('ec');
      const ts = now();
      db.insert(emergencyContacts).values({ id, familyId: input.familyId, name: input.name, phone: blankToNull(input.phone), relation: blankToNull(input.relation), createdAt: ts, updatedAt: ts }).run();
      audit(auditActor(ctx), 'emergencyContact.add', { entity: 'family', entityId: input.familyId });
      return { id };
    }),

  emergencyContactRemove: adminProcedure.input(z.object({ id: ID })).mutation(({ ctx, input }) => {
    const ec = db.select().from(emergencyContacts).where(eq(emergencyContacts.id, input.id)).get();
    if (!ec) throw new TRPCError({ code: 'NOT_FOUND', message: 'Contact not found.' });
    db.delete(emergencyContacts).where(eq(emergencyContacts.id, ec.id)).run();
    audit(auditActor(ctx), 'emergencyContact.remove', { entity: 'family', entityId: ec.familyId });
    return { ok: true as const };
  }),
});
