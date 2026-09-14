// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * CONVERSION — AN INQUIRY BECOMES A STUDENT (0.52.0, docs/ADMISSIONS.md §4 and its test list in §8).
 *
 * The delicate step of the phase, and the one with money on the other side of it. Four things have to
 * hold, and three of them are about doing something TWICE:
 *
 *  1. **Idempotent.** Fire it twice — one student, one Student ID, one charge row. A double-clicked
 *     Admit button is the ordinary case, not the edge one.
 *  2. **The Student ID is minted here and only here**, by the same `createStudentRow` every other path
 *     uses. No state but `admitted` has one, and an inquiry never had one to begin with.
 *  3. **The enrollment fee goes through the charge machinery that already existed**, keyed
 *     `admission:<inquiryId>` in the UNIQUE `charges.source_key` Phase 0 added for exactly this. A
 *     family cannot be charged twice for enrolling once.
 *  4. **A sibling is OFFERED an existing household, never silently given one** — in either direction.
 *     Auto-joining is the same mistake as auto-duplicating, and worse: it attaches a child to an
 *     address and a set of guardians nobody confirmed.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshApp, makeCtx } from './harness';
import { charges, families, guardianFamilies, guardians, inquiries, inquiryEvents, studentFees, students, schoolYears, schools, feePlans, auditLog, settings } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let schoolsMod: typeof import('../src/schools');
let fees: typeof import('../src/admissions/fees');

const caller = (role: Role) =>
  app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp();
  schoolsMod = await import('../src/schools');
  fees = await import('../src/admissions/fees');
});

beforeEach(() => {
  const { db } = app.dbmod;
  // FK order, child-first. `charges` points at the invoice line it becomes, so it goes before
  // invoice_items; here there are no invoices, but the order is kept so the list stays copyable.
  for (const t of [inquiryEvents, inquiries, charges, studentFees, students, guardianFamilies, guardians, families, feePlans, schoolYears, auditLog]) db.delete(t).run();
  db.delete(settings).where(eq(settings.key, 'admissions')).run();
  schoolsMod.ensureDefaultSchool();
});

/** A fee plan, a year that charges to join, and an inquiry ready to admit. */
async function seed(opts: { admissionFeeCents?: number | null } = {}) {
  const admin = caller('admin');
  const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
  const school = app.dbmod.db.select().from(schools).all()[0];
  const year = await admin.structure.schoolYearCreate({ label: '2026–2027', startYear: 2026, startMonth: 9, endMonth: 6, schoolId: school.id });
  if (opts.admissionFeeCents !== undefined) {
    await admin.structure.schoolYearUpdate({ id: year.id, admissionFeeCents: opts.admissionFeeCents });
  }
  const inq = await admin.admissions.officeAdd({
    childName: 'Yusuf Ismail',
    parentName: 'Ibrahim Ismail',
    email: 'ibrahim@example.org',
    phone: '07700 900123',
    schoolYearId: year.id,
  });
  return { admin, planId: plan.id, yearId: year.id, inquiryId: inq.id as string };
}

const allStudents = () => app.dbmod.db.select().from(students).all();
const allCharges = () => app.dbmod.db.select().from(charges).all();
const inquiryRow = (id: string) => app.dbmod.db.select().from(inquiries).where(eq(inquiries.id, id)).get()!;

describe('admitting a child', () => {
  it('creates the household, the child and their Student ID, and marks the inquiry admitted', async () => {
    const { admin, planId, inquiryId } = await seed();
    const r = await admin.admissions.convert({ id: inquiryId, feePlanId: planId });

    expect(r.created).toBe(true);
    expect(r.studentCode).toMatch(/^[A-Z]{3}\d{4}$/); // minted by createStudentRow, like every other path
    const [s] = allStudents();
    expect(s.id).toBe(r.studentId);
    expect(s.fullName).toBe('Yusuf Ismail');
    expect(s.status).toBe('active');
    expect(s.admittedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/); // when they joined, not when somebody typed them in

    // Stored truth, written in the same transaction as the child it is true about.
    const inq = inquiryRow(inquiryId);
    expect(inq.state).toBe('admitted');
    expect(inq.studentId).toBe(r.studentId);
    expect(inq.familyId).toBe(r.familyId);

    // A fee plan is required — a child on no plan is invisible to invoice generation.
    expect(app.dbmod.db.select().from(studentFees).all()).toHaveLength(1);
    // The household is LABELLED, never named by anybody.
    const fam = app.dbmod.db.select().from(families).where(eq(families.id, r.familyId)).get()!;
    expect(fam.name).toContain('Ismail');
    // The adult is on the HOUSEHOLD, as guardians always have been.
    expect(app.dbmod.db.select().from(guardians).all()).toHaveLength(1);
    expect(app.dbmod.db.select().from(guardianFamilies).all()[0].familyId).toBe(r.familyId);
  });

  /**
   * THE TEST docs/ADMISSIONS.md §8 OPENS WITH. A double-clicked Admit is ordinary, and the cost of
   * getting it wrong is a second child on the roster with a second Student ID and a second bill.
   */
  it('is idempotent: fire it twice → one student, one Student ID, one charge', async () => {
    const { admin, planId, inquiryId } = await seed({ admissionFeeCents: 2500 });
    const first = await admin.admissions.convert({ id: inquiryId, feePlanId: planId });
    const second = await admin.admissions.convert({ id: inquiryId, feePlanId: planId });

    expect(second.studentId).toBe(first.studentId);
    expect(second.created).toBe(false);
    expect(allStudents()).toHaveLength(1);
    expect(new Set(allStudents().map((s) => s.studentCode)).size).toBe(1);
    expect(allCharges()).toHaveLength(1);
    expect(app.dbmod.db.select().from(families).all()).toHaveLength(1);
    expect(app.dbmod.db.select().from(guardians).all()).toHaveLength(1);
  });

  it('refuses to admit a family who was declined, and says what to do', async () => {
    const { admin, planId, inquiryId } = await seed();
    await admin.admissions.transition({ id: inquiryId, to: 'declined' });
    await expect(admin.admissions.convert({ id: inquiryId, feePlanId: planId })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('reviewing'),
    });
    expect(allStudents()).toHaveLength(0);
  });

  it('mints no Student ID in any state short of admitted', async () => {
    const { admin, inquiryId } = await seed();
    for (const to of ['reviewing', 'waitlisted', 'offered'] as const) {
      await admin.admissions.transition({ id: inquiryId, to });
      expect(allStudents()).toHaveLength(0);
      expect(JSON.stringify(inquiryRow(inquiryId))).not.toMatch(/[A-Z]{3}\d{4}/);
    }
  });
});

describe('the enrollment fee', () => {
  it('is raised once, through the charge machinery that already existed', async () => {
    const { admin, planId, inquiryId } = await seed({ admissionFeeCents: 2500 });
    const r = await admin.admissions.convert({ id: inquiryId, feePlanId: planId });
    expect(r.fee?.created).toBe(true);
    const [c] = allCharges();
    expect(c.amountCents).toBe(2500);
    expect(c.label).toBe('Enrollment fee');
    expect(c.sourceKey).toBe(`admission:${inquiryId}`);
    expect(c.status).toBe('pending');
    // It writes the charge and STOPS — whether that gets billed on its own or waits for the next run
    // is billing/invoices.ts's question, and the caller asks it.
    expect(c.invoiceItemId).toBeNull();
  });

  it('a second approval returns the first charge rather than erroring — “already done” is success', async () => {
    const { admin, planId, inquiryId } = await seed({ admissionFeeCents: 2500 });
    const first = await admin.admissions.convert({ id: inquiryId, feePlanId: planId });
    const second = await admin.admissions.convert({ id: inquiryId, feePlanId: planId });
    expect(allCharges()).toHaveLength(1);
    expect(first.fee?.chargeId).toBeTruthy();
    // The second call takes the already-admitted short circuit and reports no fee work, which is the
    // honest answer: it raised nothing, and nothing needed raising.
    expect(second.fee).toBeNull();
  });

  it('charges nothing when the year has no fee — an ordinary madrasah, not an unconfigured one', async () => {
    const { admin, planId, inquiryId } = await seed();
    const r = await admin.admissions.convert({ id: inquiryId, feePlanId: planId });
    expect(r.fee?.decision.reason).toBe('none');
    expect(allCharges()).toHaveLength(0);
  });

  it('honors a waiver and an override, and reads 0 as a waiver rather than a charge for nothing', () => {
    // Unit-level, because the three answers are a decision and not a write. A waiver beats an
    // override beats the year's figure: each is a narrower decision than the one before it.
    expect(fees.resolveEnrollmentFee({ schoolYearId: null, kind: 'admission' })).toEqual({ amountCents: null, reason: 'none' });
    expect(fees.resolveEnrollmentFee({ schoolYearId: null, kind: 'admission', waived: true })).toEqual({ amountCents: null, reason: 'waived' });
    expect(fees.resolveEnrollmentFee({ schoolYearId: null, kind: 'admission', overrideCents: 1000 })).toEqual({ amountCents: 1000, reason: 'override' });
    expect(fees.resolveEnrollmentFee({ schoolYearId: null, kind: 'admission', overrideCents: 0 })).toEqual({ amountCents: null, reason: 'waived' });
    // A waiver wins even against an override, because it is the later and narrower decision.
    expect(fees.resolveEnrollmentFee({ schoolYearId: null, kind: 'admission', overrideCents: 5000, waived: true }).amountCents).toBeNull();
  });

  it('waives it for this family without touching what the year charges everybody else', async () => {
    const { admin, planId, inquiryId, yearId } = await seed({ admissionFeeCents: 2500 });
    const r = await admin.admissions.convert({ id: inquiryId, feePlanId: planId, feeWaived: true });
    expect(r.fee?.decision.reason).toBe('waived');
    expect(allCharges()).toHaveLength(0);
    // The control: the year's own figure is untouched, so the next family still pays it.
    expect(app.dbmod.db.select().from(schoolYears).where(eq(schoolYears.id, yearId)).get()!.admissionFeeCents).toBe(2500);
  });

  it('is deduplicated by the DATABASE, not by the read before it', async () => {
    // Prove the UNIQUE index by going AROUND the helper. Without it the whole file passes with no
    // index at all — two concurrent approvals both pass the existence check.
    const { admin, planId, inquiryId } = await seed({ admissionFeeCents: 2500 });
    const r = await admin.admissions.convert({ id: inquiryId, feePlanId: planId });
    const { db } = app.dbmod;
    const ts = new Date();
    expect(() =>
      db
        .insert(charges)
        .values({ id: 'chg_dup', studentId: r.studentId, label: 'Enrollment fee', amountCents: 2500, status: 'pending', sourceKey: `admission:${inquiryId}`, createdAt: ts, updatedAt: ts })
        .run(),
    ).toThrow();
    expect(allCharges()).toHaveLength(1);
  });
});

describe('the sibling a madrasah already knows', () => {
  it('offers the existing household rather than joining it, and says WHY it matched', async () => {
    const { admin, planId, inquiryId } = await seed();
    await admin.admissions.convert({ id: inquiryId, feePlanId: planId });

    // A second child, same parent, same email address.
    const second = await admin.admissions.officeAdd({
      childName: 'Maryam Ismail',
      parentName: 'Ibrahim Ismail',
      email: 'ibrahim@example.org',
    });
    const preview = await admin.admissions.convertPreview({ id: second.id as string });
    expect(preview.hints).toHaveLength(1);
    expect(preview.hints[0].matchedOn).toBe('email'); // an email match is worth more than a name match
    expect(preview.hints[0].guardianName).toBe('Ibrahim Ismail');

    // A HINT, not an action: admitting without naming the household still makes a new one, because
    // silently joining a matched household attaches a child to guardians nobody confirmed.
    const r = await admin.admissions.convert({ id: second.id as string, feePlanId: planId });
    expect(r.familyId).not.toBe(preview.hints[0].familyId);
    expect(app.dbmod.db.select().from(families).all()).toHaveLength(2);
  });

  it('joins the existing household when the office says so, without adding a second guardian', async () => {
    const { admin, planId, inquiryId } = await seed();
    const first = await admin.admissions.convert({ id: inquiryId, feePlanId: planId });
    const second = await admin.admissions.officeAdd({ childName: 'Maryam Ismail', parentName: 'Ibrahim Ismail', email: 'ibrahim@example.org' });
    const r = await admin.admissions.convert({ id: second.id as string, feePlanId: planId, familyId: first.familyId });

    expect(r.familyId).toBe(first.familyId);
    expect(app.dbmod.db.select().from(families).all()).toHaveLength(1);
    // The household's guardians are already right — copying the inquiry's parent in again would give
    // the family two of the same adult.
    expect(app.dbmod.db.select().from(guardians).all()).toHaveLength(1);
    expect(allStudents()).toHaveLength(2);
    // Two children, two Student IDs, one household.
    expect(new Set(allStudents().map((s) => s.studentCode)).size).toBe(2);
  });

  it('offers nothing when nobody matches', async () => {
    const { admin, planId, inquiryId } = await seed();
    await admin.admissions.convert({ id: inquiryId, feePlanId: planId });
    const other = await admin.admissions.officeAdd({ childName: 'Bilal Khan', parentName: 'Sajid Khan', email: 'sajid@example.org' });
    const preview = await admin.admissions.convertPreview({ id: other.id as string });
    expect(preview.hints).toEqual([]);
  });
});

describe('the trail it leaves', () => {
  it('records the conversion without copying what the family wrote into the audit log', async () => {
    const { admin, planId, inquiryId } = await seed({ admissionFeeCents: 2500 });
    await admin.admissions.convert({ id: inquiryId, feePlanId: planId });
    const trail = JSON.stringify(app.dbmod.db.select().from(auditLog).all());
    // The controls first: the conversion and the student creation are both on the record.
    expect(trail).toContain('inquiry.convert');
    expect(trail).toContain('student.create');
    expect(trail).toContain('inquiry.transition');
    // The child's name is on the STUDENT row, which is where an office looks it up. The forensic
    // trail carries ids, action names and counts (§14).
    expect(trail).not.toContain('Yusuf Ismail');
    expect(trail).not.toContain('ibrahim@example.org');
  });

  it('puts the admission on the inquiry trail the office reads', async () => {
    const { admin, planId, inquiryId } = await seed();
    await admin.admissions.convert({ id: inquiryId, feePlanId: planId });
    const got = await admin.admissions.get({ id: inquiryId });
    expect(got.inquiry.state).toBe('admitted');
    expect(got.events.some((e) => e.toState === 'admitted')).toBe(true);
    expect(got.next).toEqual([]); // terminal — there is nowhere for an admitted child to go
  });
});
