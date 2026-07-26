// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * People & SIS router (CLAUDE.md §4 SIS, §5 roles, §9 data rules, §14 audit).
 * Writes are admin-only; directory + record reads are admin OR finance (§5). Teachers
 * (own-class students) and parents (own family) get scoped reads once classes and
 * portal accounts exist — until then those roles simply have no access here (walls err
 * toward deny). Students are withdrawn, families archived — never hard-deleted (§9).
 * Every create/update/withdraw and every PIN regeneration is audited; PINs never enter
 * the audit detail or logs (§14).
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray } from 'drizzle-orm';
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
  classes,
} from '../db/schema';
import { rid } from '../db/ids';
import { generateUniquePin } from '../billing/pins';
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
  /** Families with their students + guardians. NO PINs in the bulk view (PINs come
   *  from the per-student record). */
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

  /** One family with everything on the record — students (incl. PIN, for admin/finance),
   *  guardians, emergency contacts. */
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
    const contacts = db.select().from(emergencyContacts).where(eq(emergencyContacts.familyId, fam.id)).all();
    return { family: fam, students: studs, guardians: links, emergencyContacts: contacts };
  }),

  // ── Families (admin write) ─────────────────────────────────────────────────
  familyCreate: adminProcedure.input(z.object({ name: REQ_NAME, notes: NOTES })).mutation(({ ctx, input }) => {
    const id = rid('fam');
    const ts = now();
    db.insert(families).values({ id, name: input.name, notes: blankToNull(input.notes), status: 'active', createdAt: ts, updatedAt: ts }).run();
    audit(auditActor(ctx), 'family.create', { entity: 'family', entityId: id, detail: { name: input.name } });
    return { id };
  }),

  familyUpdate: adminProcedure
    .input(z.object({ id: ID, name: OPT_NAME, notes: NOTES, status: z.enum(['active', 'archived']).optional() }))
    .mutation(({ ctx, input }) => {
      const fam = requireFamily(input.id);
      const patch: Partial<typeof families.$inferInsert> = { updatedAt: now() };
      if (input.name !== undefined) patch.name = input.name;
      if (input.notes !== undefined) patch.notes = blankToNull(input.notes);
      if (input.status !== undefined) patch.status = input.status;
      db.update(families).set(patch).where(eq(families.id, fam.id)).run();
      audit(auditActor(ctx), 'family.update', { entity: 'family', entityId: fam.id, detail: { fields: Object.keys(patch).filter((k) => k !== 'updatedAt') } });
      return { ok: true as const };
    }),

  // ── Students (admin write) ─────────────────────────────────────────────────
  /** Create a student and auto-generate a unique PIN (§9). Returns the PIN once so the
   *  admin can note/print it; thereafter it's on the student record (admin/finance).
   *
   *  A FEE PLAN IS REQUIRED: a student who exists but is on no plan is invisible to invoice
   *  generation, which is how a child silently stops being billed. The plan and the student are
   *  created in ONE transaction, with an optional per-student override so an unusual amount does
   *  not need a parallel plan. `classId` is optional — a student may be unplaced. */
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
    .mutation(({ ctx, input }) => {
      requireFamily(input.familyId);
      const plan = db.select({ id: feePlans.id }).from(feePlans).where(and(eq(feePlans.id, input.feePlanId), eq(feePlans.status, 'active'))).get();
      if (!plan) throw new TRPCError({ code: 'NOT_FOUND', message: 'Fee plan not found.' });
      if (input.classId) {
        const k = db.select({ id: classes.id, status: classes.status }).from(classes).where(eq(classes.id, input.classId)).get();
        if (!k) throw new TRPCError({ code: 'NOT_FOUND', message: 'Class not found.' });
        if (k.status !== 'active') throw new TRPCError({ code: 'CONFLICT', message: 'That class is archived.' });
      }
      const id = rid('stu');
      const ts = now();
      const pin = generateUniquePin();
      db.transaction((tx) => {
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
            pin,
            pinUpdatedAt: ts,
            createdAt: ts,
            updatedAt: ts,
          })
          .run();
        tx.insert(studentFees)
          .values({ id: rid('stf'), studentId: id, feePlanId: input.feePlanId, overrideAmountCents: input.overrideAmountCents ?? null, note: input.feeNote || null, createdAt: ts, updatedAt: ts })
          .run();
      });
      // Audit records the event, NEVER the PIN (§14).
      audit(auditActor(ctx), 'student.create', { entity: 'student', entityId: id, detail: { familyId: input.familyId, feePlanId: input.feePlanId, classId: input.classId ?? null } });
      return { id, pin };
    }),

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

  /** Regenerate a student's PIN (admin | finance) — audited, PIN value never recorded. */
  /** Move a student into another family — the "add siblings" path. Guardians and emergency
   *  contacts attach to the FAMILY, so linking a student to their siblings' family is what makes
   *  the parent/guardian details apply to them; nothing is copied per-student.
   *
   *  Invoices already raised stay with the family that was billed (they are immutable history), so
   *  a move only redirects FUTURE billing. Audited both sides. */
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
   *  Returns each new student's PIN once so the admin can print them (never logged, never audited). */
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
      // Counts only: never the names or the PINs (§14).
      audit(auditActor(ctx), 'student.import', { entity: 'people', detail: { created: res.created, familiesCreated: res.familiesCreated, guardiansCreated: res.guardiansCreated } });
      return res;
    }),

  pinRegenerate: adminOrFinanceProcedure.input(z.object({ studentId: ID })).mutation(({ ctx, input }) => {
    const s = requireStudent(input.studentId);
    const pin = generateUniquePin();
    db.update(students).set({ pin, pinUpdatedAt: now(), updatedAt: now() }).where(eq(students.id, s.id)).run();
    audit(auditActor(ctx), 'student.pin.regenerate', { entity: 'student', entityId: s.id });
    return { pin };
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
