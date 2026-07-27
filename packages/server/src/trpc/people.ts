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
  charges,
  classes,
  guardianUsers,
  users,
} from '../db/schema';
import { rid } from '../db/ids';
import { generateUniqueStudentCode } from '../billing/studentCodes';
import type { Tx } from '../billing/ledger';
import { audit } from '../audit';
import { IMPORT_FIELDS, validateRows, commitRows, type ImportRow } from '../people/import';

// ── input helpers ────────────────────────────────────────────────────────────
const REQ_NAME = z.string().trim().min(1).max(120);
const OPT_NAME = z.string().trim().max(120).optional();
const PHONE = z.string().trim().max(40).optional();
const EMAIL = z.string().trim().max(200).optional();
const NOTES = z.string().max(4000).optional();
const RELATION = z.string().trim().max(60).optional();
const DOB = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();
const ID = z.string().min(1).max(64);
const blankToNull = (v: string | undefined): string | null => (v && v.trim() !== '' ? v.trim() : null);

/** One CSV row as the dialog sends it: every cell optional and length-bounded. The real
 *  validation lives in people/import.ts so problems can be reported per row, not as one
 *  opaque zod failure the admin can't act on. */
const CELL = z.string().max(300).optional();
const IMPORT_ROW = z.object({
  firstName: CELL,
  lastName: CELL,
  familyName: CELL,
  dob: CELL,
  className: CELL,
  courseName: CELL,
  feePlanName: CELL,
  amount: CELL,
  guardianName: CELL,
  guardianPhone: CELL,
  guardianEmail: CELL,
  note: CELL,
});

const now = () => new Date();

/**
 * The label for a household, DERIVED from the children in it — nobody is ever asked to name a family
 * (0.39.0). A family is not a thing an office maintains; it is just the link that makes siblings share
 * guardians, so its name should never be another field to keep up to date.
 *
 * One surname → "Ismail family". Several (step-siblings, a remarriage) → "Farooqi / Ismail", because
 * picking one child's surname to stand for the household would be wrong in exactly the cases where it
 * matters. Surnames are sorted so the label depends on WHO is in the household, not on the order they
 * were added — otherwise the same family would read differently on two installs. Falls back to the
 * stored `families.name` for a household with no children yet (a CSV import can create one), and
 * finally to a neutral label so nothing renders blank.
 */
export function familyLabel(familyId: string, tx: Tx = db): string {
  const kids = tx.select({ lastName: students.lastName }).from(students).where(eq(students.familyId, familyId)).all();
  const surnames = [...new Set(kids.map((k) => k.lastName.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (surnames.length === 1) return `${surnames[0]} family`;
  if (surnames.length > 1) return surnames.join(' / ');
  return tx.select({ name: families.name }).from(families).where(eq(families.id, familyId)).get()?.name || 'Family';
}

interface NewStudent {
  familyId: string;
  firstName: string;
  lastName: string;
  dob?: string;
  notes?: string;
  feePlanId: string;
  overrideAmountCents?: number;
  feeNote?: string;
  classId?: string;
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
    // The typed ID a parent uses at the kiosk. Derived from the first name, so it is generated here
    // rather than accepted from the caller — never importable, never chosen (§14).
    const studentCode = generateUniqueStudentCode(input.firstName);
    tx.insert(students)
      .values({
        id,
        familyId: input.familyId,
        firstName: input.firstName,
        lastName: input.lastName,
        dob: blankToNull(input.dob),
        status: 'active',
        notes: blankToNull(input.notes),
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

export const peopleRouter = router({
  // ── Directory (admin | finance) ────────────────────────────────────────────
  /** Families with their students + guardians. */
  directory: adminOrFinanceProcedure.query(() => {
    const fams = db.select().from(families).all();
    const ids = fams.map((f) => f.id);
    const studs = ids.length
      ? db
          .select({ id: students.id, familyId: students.familyId, firstName: students.firstName, lastName: students.lastName, status: students.status })
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
        firstName: REQ_NAME,
        lastName: REQ_NAME,
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
        firstName: REQ_NAME,
        lastName: REQ_NAME,
        dob: DOB,
        notes: NOTES,
        feePlanId: ID,
        overrideAmountCents: z.number().int().min(0).max(100_000_000).optional(),
        feeNote: z.string().trim().max(200).optional(),
        classId: ID.optional(),
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
          // A provisional label; createStudentRow derives the real one once the child exists.
          tx.insert(families).values({ id: fid, name: `${input.lastName} family`, status: 'active', createdAt: ts, updatedAt: ts }).run();
        }
        return { familyId: fid, r: createStudentRow({ ...input, familyId: fid }, auditActor(ctx), tx) };
      });
      if (!linked) audit(auditActor(ctx), 'family.create', { entity: 'family', entityId: familyId, detail: { via: 'studentAdd' } });
      return { ...r, familyId, familyLabel: familyLabel(familyId) };
    }),

  /** Candidate siblings to link a new student to — every active student, with their household label,
   *  so the add dialog can offer "shares a family with…". */
  siblingOptions: adminOrFinanceProcedure.query(() =>
    db
      .select({ id: students.id, firstName: students.firstName, lastName: students.lastName, familyId: students.familyId })
      .from(students)
      .where(eq(students.status, 'active'))
      .orderBy(students.lastName, students.firstName)
      .all(),
  ),

  studentUpdate: adminProcedure
    .input(
      z.object({
        id: ID,
        firstName: OPT_NAME,
        lastName: OPT_NAME,
        dob: z.union([DOB, z.literal('')]).optional(),
        notes: NOTES,
        status: z.enum(['active', 'withdrawn']).optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const s = requireStudent(input.id);
      const patch: Partial<typeof students.$inferInsert> = { updatedAt: now() };
      if (input.firstName !== undefined) patch.firstName = input.firstName;
      if (input.lastName !== undefined) patch.lastName = input.lastName;
      if (input.dob !== undefined) patch.dob = blankToNull(input.dob);
      if (input.notes !== undefined) patch.notes = blankToNull(input.notes);
      if (input.status !== undefined) patch.status = input.status;
      db.update(students).set(patch).where(eq(students.id, s.id)).run();
      const action = input.status && input.status !== s.status ? `student.${input.status === 'withdrawn' ? 'withdraw' : 'reinstate'}` : 'student.update';
      audit(auditActor(ctx), action, { entity: 'student', entityId: s.id, detail: { fields: Object.keys(patch).filter((k) => k !== 'updatedAt') } });
      return { ok: true as const };
    }),

  /** Move a student into another family — the "add siblings" path. Guardians and emergency
   *  contacts attach to the FAMILY, so linking a student to their siblings' family is what makes
   *  the parent/guardian details apply to them; nothing is copied per-student.
   *
   *  Invoices and payments belong to the STUDENT (0.39.0), so a move takes their billing history with
   *  them rather than stranding it on a household they have left — a debt nobody is looking at is
   *  worse than one that follows the child. No money row is rewritten; only the child's family
   *  changes. Audited both sides. */
  studentSetFamily: adminProcedure.input(z.object({ studentId: ID, familyId: ID })).mutation(({ ctx, input }) => {
    const s = requireStudent(input.studentId);
    requireFamily(input.familyId);
    if (s.familyId === input.familyId) return { ok: true as const, moved: false };
    db.update(students).set({ familyId: input.familyId, updatedAt: now() }).where(eq(students.id, s.id)).run();
    audit(auditActor(ctx), 'student.setFamily', { entity: 'student', entityId: s.id, detail: { from: s.familyId, to: input.familyId } });
    return { ok: true as const, moved: true };
  }),

  // ── CSV import ───────────────────────────────────────────────────────────────
  /** The canonical column set. The dialog uses this both to build the blank template and to
   *  auto-match the uploaded file's headers, so there is one source of truth. */
  importTemplate: adminProcedure.query(() =>
    IMPORT_FIELDS.map((f) => ({ key: f.key, label: f.label, required: f.required, aliases: [...f.aliases] })),
  ),

  /** Dry run. Resolves families / classes / fee plans and reports per-row problems so the dialog
   *  can show them before anything is written. A mutation, not a query, because the rows go in the
   *  request BODY — a few hundred rows would not survive a query string. */
  importPreview: adminProcedure
    .input(z.object({ rows: z.array(IMPORT_ROW).min(1).max(2000), defaultFeePlanId: ID.optional() }))
    .mutation(({ input }) => validateRows(input.rows as ImportRow[], { defaultFeePlanId: input.defaultFeePlanId ?? null })),

  /** Commit. Re-validates and writes everything in ONE transaction — all rows land or none do.
   *  Returns each new student's ID so the admin can print them (never logged, never audited). */
  importCommit: adminProcedure
    .input(z.object({ rows: z.array(IMPORT_ROW).min(1).max(2000), defaultFeePlanId: ID.optional() }))
    .mutation(({ ctx, input }) => {
      let res;
      try {
        res = commitRows(input.rows as ImportRow[], { defaultFeePlanId: input.defaultFeePlanId ?? null });
      } catch (e) {
        if ((e as Error).message === 'invalid_rows') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Some rows still have problems — fix them and try again.' });
        }
        throw e;
      }
      // Counts only: never the names or the Student IDs (§14).
      audit(auditActor(ctx), 'student.import', { entity: 'people', detail: { created: res.created, familiesCreated: res.familiesCreated, guardiansCreated: res.guardiansCreated } });
      return res;
    }),

  /**
   * Can this student be deleted outright, and if not, why not?
   *
   * Three tables reference `students`, all ON DELETE RESTRICT, and they are not equal:
   *   - `student_fees` is CONFIGURATION — which plans they carry. Deleting it with them is correct.
   *   - `invoice_items` is MONEY HISTORY — a line on an invoice that was actually raised. Removing a
   *     student who appears on an invoice would silently change what that invoice says it was for,
   *     which is exactly the immutability §9 protects.
   *   - `charges` is either: a `pending`/`void` charge is not yet money and goes with them; an
   *     `invoiced` one is money history and blocks.
   *
   * So: delete is for a mistake (wrong name typed, duplicate row, a child who never actually
   * enrolled). A student who has ever been billed is withdrawn, not deleted. Exposed as its own query
   * so the office sees the reason BEFORE clicking, instead of hitting a refusal.
   */
  studentDeletable: adminProcedure.input(z.object({ studentId: ID })).query(({ input }) => {
    const s = requireStudent(input.studentId);
    const invoiceLines = db.select({ id: invoiceItems.id }).from(invoiceItems).where(eq(invoiceItems.studentId, s.id)).all().length;
    const invoicedCharges = db.select({ id: charges.id }).from(charges).where(and(eq(charges.studentId, s.id), eq(charges.status, 'invoiced'))).all().length;
    return {
      deletable: invoiceLines === 0 && invoicedCharges === 0,
      invoiceLines,
      invoicedCharges,
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
    if (invoiceLines > 0 || invoicedCharges > 0) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'This student has been billed, so their record is part of your invoice history and can’t be deleted. Mark them withdrawn instead.',
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

  guardianUpdate: adminProcedure
    .input(z.object({ id: ID, name: OPT_NAME, phone: PHONE, email: EMAIL }))
    .mutation(({ ctx, input }) => {
      const g = db.select().from(guardians).where(eq(guardians.id, input.id)).get();
      if (!g) throw new TRPCError({ code: 'NOT_FOUND', message: 'Guardian not found.' });
      const patch: Partial<typeof guardians.$inferInsert> = { updatedAt: now() };
      if (input.name !== undefined) patch.name = input.name;
      if (input.phone !== undefined) patch.phone = blankToNull(input.phone);
      if (input.email !== undefined) patch.email = blankToNull(input.email);
      db.update(guardians).set(patch).where(eq(guardians.id, g.id)).run();
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
