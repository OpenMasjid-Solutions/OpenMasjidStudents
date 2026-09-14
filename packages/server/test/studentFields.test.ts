// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * THE STUDENT RECORD, THE FIELD REGISTRY, AND THE MEDICAL WALL (0.52.0, §4a Phase 1).
 *
 * CLAUDE.md §5 (the medical wall), §9 (the allow-list), §14 (the amendment). `people/fields.ts` is the
 * one place that answers all three questions about a student field; these are the assertions that make
 * it a wall rather than a convention.
 *
 * **Why this file matters more than the feature it tests.** Before it, `familyGet` was an
 * `adminOrFinanceProcedure` doing `db.select().from(students)`, and the finance shell renders the SAME
 * `FamilyDetail` component the admin shell does (`readOnly` is cosmetic — every occurrence wraps a
 * button). So adding a medical column would have handed it to finance **with no code change at all**.
 * The regression this guards against is not a bad `if`; it is somebody adding a column.
 *
 * Watch for the vacuous version of every assertion here. "Finance cannot see `medicalNotes`" passes
 * trivially if the field was never enabled, if the student never had one written, or if the key is
 * spelled wrong — so each negative test below asserts the POSITIVE case in the same breath: admin CAN
 * see the value, and the value is the one we wrote.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshApp, makeCtx } from './harness';
import { settings, students, studentNotes, studentFees, feePlans, families, classes, courses, schoolYears, terms, users, auditLog, invoices, invoiceItems, payments, paymentAllocations, charges, chargeItems } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
/** Dynamic, inside beforeAll — a static import of anything reaching `db` freezes dataDir (see harness). */
let fields: typeof import('../src/people/fields');

const caller = (role: Role) =>
  app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp();
  fields = await import('../src/people/fields');
});

beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, charges, chargeItems, invoiceItems, invoices, studentNotes, studentFees, feePlans, students, classes, courses, families, terms, schoolYears, users, auditLog]) db.delete(t).run();
  // The field registry is a settings row; clear it so each test starts from the shipped defaults.
  db.delete(settings).where(eq(settings.key, 'student_fields')).run();
});

async function seed() {
  const admin = caller('admin');
  const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
  const s = await admin.people.studentAdd({ fullName: 'Yusuf Ismail', feePlanId: plan.id });
  const stu = app.dbmod.db.select({ id: students.id, familyId: students.familyId }).from(students).get()!;
  return { admin, finance: caller('finance'), studentId: s.id, familyId: stu.familyId };
}

/** Turn on every field in the catalog, which is what an office asking for medical notes would do. */
async function enableAll(admin: ReturnType<typeof caller>) {
  await admin.people.studentFieldsSet({ keys: fields.STUDENT_FIELDS.map((f) => f.key) });
}

describe('the shipped defaults', () => {
  it('has the ordinary fields on and EVERY medical field off', () => {
    const on = new Set(fields.enabledFieldKeys());
    for (const f of fields.STUDENT_FIELDS) {
      expect(on.has(f.key)).toBe(f.sensitivity === 'ordinary');
    }
    // Vacuity check: there is something in each group, so the loop above asserts two real things.
    expect(fields.MEDICAL_FIELD_KEYS.length).toBeGreaterThan(0);
    expect(fields.STUDENT_FIELDS.filter((f) => f.sensitivity === 'ordinary').length).toBeGreaterThan(0);
  });

  it('never lets a parent read an extended field — the registry has no parent anywhere in it', () => {
    for (const f of fields.STUDENT_FIELDS) expect(f.readableBy).not.toContain('parent');
    expect(fields.visibleFields('parent')).toEqual([]);
  });
});

describe('THE MEDICAL WALL', () => {
  it('gives finance the ordinary fields and NEVER a medical one, on familyGet', async () => {
    const { admin, finance, studentId, familyId } = await seed();
    await enableAll(admin);
    await admin.people.studentUpdate({ id: studentId, fields: { address: '12 Mill Lane', allergies: 'Peanuts', medicalNotes: 'Carries an inhaler', medicalConsent: true } });

    const asAdmin = (await admin.people.familyGet({ id: familyId })).students[0] as Record<string, unknown>;
    const asFinance = (await finance.people.familyGet({ id: familyId })).students[0] as Record<string, unknown>;

    // The positive half, so the negative half cannot pass vacuously.
    expect(asAdmin.allergies).toBe('Peanuts');
    expect(asAdmin.medicalNotes).toBe('Carries an inhaler');
    expect(asAdmin.medicalConsent).toBe(true);
    expect(asAdmin.address).toBe('12 Mill Lane');

    expect(asFinance.address).toBe('12 Mill Lane'); // finance DOES see the ordinary record
    for (const k of fields.MEDICAL_FIELD_KEYS) expect(asFinance).not.toHaveProperty(k);
    // And not merely absent as a key — nothing in the payload carries the value at all.
    expect(JSON.stringify(asFinance)).not.toContain('Peanuts');
    expect(JSON.stringify(asFinance)).not.toContain('inhaler');
  });

  it('holds on studentGet too, and finance gets no notes at all', async () => {
    const { admin, finance, studentId } = await seed();
    await enableAll(admin);
    await admin.people.studentUpdate({ id: studentId, fields: { allergies: 'Peanuts' } });
    await admin.people.studentNoteAdd({ studentId, body: 'Spoke to the mother about pickup.' });

    const a = await admin.people.studentGet({ id: studentId });
    const f = await finance.people.studentGet({ id: studentId });

    expect((a.student as Record<string, unknown>).allergies).toBe('Peanuts');
    expect(a.notes).toHaveLength(1);
    expect(a.fields.map((x) => x.key)).toContain('allergies');

    expect(f.student).not.toHaveProperty('allergies');
    expect(f.notes).toEqual([]);
    // The screen renders from this list, so a medical field must not even be ANNOUNCED to finance.
    expect(f.fields.map((x) => x.key)).not.toContain('allergies');
    expect(JSON.stringify(f)).not.toContain('Peanuts');
    expect(JSON.stringify(f)).not.toContain('pickup');
  });

  it('is the ROLE and not just the toggle — enabling every field changes nothing for finance', async () => {
    const { admin, finance, studentId, familyId } = await seed();
    await enableAll(admin);
    await admin.people.studentUpdate({ id: studentId, fields: { allergies: 'Peanuts' } });
    const asFinance = (await finance.people.familyGet({ id: familyId })).students[0] as Record<string, unknown>;
    expect(asFinance).not.toHaveProperty('allergies');
  });

  it('keeps the registry panel itself away from finance', async () => {
    const { finance } = await seed();
    await expect(finance.people.studentFieldsGet()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(finance.people.studentFieldsSet({ keys: [] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('a field the office switched off', () => {
  it('disappears from the record, for admin as well', async () => {
    const { admin, studentId, familyId } = await seed();
    await enableAll(admin);
    await admin.people.studentUpdate({ id: studentId, fields: { priorSchool: 'Madrasah al-Noor' } });
    expect(((await admin.people.familyGet({ id: familyId })).students[0] as Record<string, unknown>).priorSchool).toBe('Madrasah al-Noor');

    await admin.people.studentFieldsSet({ keys: fields.STUDENT_FIELDS.map((f) => f.key).filter((k) => k !== 'priorSchool') });
    expect((await admin.people.familyGet({ id: familyId })).students[0]).not.toHaveProperty('priorSchool');
  });

  it('cannot be written while it is off — refused, not silently dropped', async () => {
    const { admin, studentId } = await seed();
    await admin.people.studentFieldsSet({ keys: ['address'] });
    await expect(admin.people.studentUpdate({ id: studentId, fields: { priorSchool: 'x' } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('HIDES rather than erases, which is what studentFieldsGet has to tell the office', async () => {
    const { admin, studentId } = await seed();
    await enableAll(admin);
    await admin.people.studentUpdate({ id: studentId, fields: { allergies: 'Peanuts' } });
    await admin.people.studentFieldsSet({ keys: ['address'] });

    const panel = await admin.people.studentFieldsGet();
    const allergies = panel.fields.find((f) => f.key === 'allergies')!;
    expect(allergies.enabled).toBe(false);
    expect(allergies.holdsData).toBe(true); // the value is still in the database
    // And it really is — turning it back on brings it back rather than showing an empty box.
    await enableAll(admin);
    const back = await admin.people.studentGet({ id: studentId });
    expect((back.student as Record<string, unknown>).allergies).toBe('Peanuts');
  });
});

describe('a hand-edited settings row cannot widen what is exposed', () => {
  it('ignores a key that is not in the catalog', async () => {
    const { admin, studentId } = await seed();
    const { db } = app.dbmod;
    const ts = new Date();
    db.insert(settings).values({ key: 'student_fields', value: JSON.stringify(['address', 'nationalInsuranceNumber', '*']), updatedAt: ts }).onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(['address', 'nationalInsuranceNumber', '*']) } }).run();
    expect(fields.enabledFieldKeys()).toEqual(['address']);
    await expect(admin.people.studentUpdate({ id: studentId, fields: { nationalInsuranceNumber: 'x' } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('falls back to the defaults on a row that is not a list at all', () => {
    const { db } = app.dbmod;
    const ts = new Date();
    db.insert(settings).values({ key: 'student_fields', value: 'not json', updatedAt: ts }).run();
    expect(fields.enabledFieldKeys()).toEqual(fields.STUDENT_FIELDS.filter((f) => f.onByDefault).map((f) => f.key));
  });
});

describe('writing a field', () => {
  it('stores it, and an empty string clears it', async () => {
    const { admin, studentId } = await seed();
    await admin.people.studentUpdate({ id: studentId, fields: { nationality: 'British' } });
    expect((await admin.people.studentGet({ id: studentId })).student).toMatchObject({ nationality: 'British' });
    await admin.people.studentUpdate({ id: studentId, fields: { nationality: '' } });
    expect((await admin.people.studentGet({ id: studentId })).student).toMatchObject({ nationality: null });
  });

  it('refuses a date that is the right SHAPE but not a real day (§9)', async () => {
    const { admin, studentId } = await seed();
    await expect(admin.people.studentUpdate({ id: studentId, fields: { admittedOn: '2026-13-45' } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await admin.people.studentUpdate({ id: studentId, fields: { admittedOn: '2026-09-01' } });
    expect((await admin.people.studentGet({ id: studentId })).student).toMatchObject({ admittedOn: '2026-09-01' });
  });

  it('refuses an unknown key rather than ignoring it', async () => {
    const { admin, studentId } = await seed();
    await expect(admin.people.studentUpdate({ id: studentId, fields: { shoeSize: '9' } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('keeps a flag to yes / no / not recorded, and refuses text for it', async () => {
    const { admin, studentId } = await seed();
    await enableAll(admin);
    await admin.people.studentUpdate({ id: studentId, fields: { medicalConsent: true } });
    expect((await admin.people.studentGet({ id: studentId })).student).toMatchObject({ medicalConsent: true });
    await admin.people.studentUpdate({ id: studentId, fields: { medicalConsent: null } });
    expect((await admin.people.studentGet({ id: studentId })).student).toMatchObject({ medicalConsent: null });
    await expect(admin.people.studentUpdate({ id: studentId, fields: { medicalConsent: 'yes' } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('is admin-only to write — finance reads the ordinary record and changes nothing', async () => {
    const { finance, studentId } = await seed();
    await expect(finance.people.studentUpdate({ id: studentId, fields: { address: 'x' } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('records field NAMES in the audit trail and never a value (§14)', async () => {
    const { admin, studentId } = await seed();
    await enableAll(admin);
    await admin.people.studentUpdate({ id: studentId, fields: { allergies: 'Peanuts' } });
    const trail = JSON.stringify(app.dbmod.db.select().from(auditLog).all());
    expect(trail).toContain('allergies');
    expect(trail).not.toContain('Peanuts');
  });
});

describe('office notes', () => {
  it('carries the author and the time, newest first', async () => {
    const { admin, studentId } = await seed();
    await admin.people.studentNoteAdd({ studentId, body: 'First note' });
    await admin.people.studentNoteAdd({ studentId, body: 'Second note' });
    const { notes } = await admin.people.studentGet({ id: studentId });
    expect(notes).toHaveLength(2);
    expect(notes[0].body).toBe('Second note');
    expect(notes[0].authorName).toBeTruthy();
    expect(notes[0].createdAt).toBeInstanceOf(Date);
  });

  it('IS APPEND-ONLY — the router offers no way to change or remove one', async () => {
    // A structural assertion rather than a behavioural one: there is nothing to call, so the test is
    // that the surface does not exist. If an update or delete is ever added, this fails and whoever
    // adds it has to come and read people/notes.ts on why it was left out.
    const surface = Object.keys(app.appRouter._def.procedures).filter((k) => k.startsWith('people.studentNote'));
    expect(surface).toEqual(['people.studentNoteAdd']);
  });

  it('takes the note typed on the add form as the child’s first note', async () => {
    const admin = caller('admin');
    const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
    const s = await admin.people.studentAdd({ fullName: 'Maryam Ismail', feePlanId: plan.id, notes: 'Joined from another madrasah.' });
    const { notes } = await admin.people.studentGet({ id: s.id });
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe('Joined from another madrasah.');
  });

  it('writes NO note for a blank one — an empty box is not a record', async () => {
    const admin = caller('admin');
    const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
    const s = await admin.people.studentAdd({ fullName: 'Bilal Ismail', feePlanId: plan.id, notes: '   ' });
    expect((await admin.people.studentGet({ id: s.id })).notes).toEqual([]);
  });

  it('never puts the body in the audit trail — only its length (§14)', async () => {
    const { admin, studentId } = await seed();
    await admin.people.studentNoteAdd({ studentId, body: 'Mother asked us not to call the father.' });
    const rows = app.dbmod.db.select().from(auditLog).all();
    expect(rows.map((r) => r.action)).toContain('student.note');
    // The length is recorded so the trail says something happened; the words never are.
    expect(JSON.stringify(rows)).toContain('length');
    expect(JSON.stringify(rows)).not.toContain('the father');
  });

  it('follows the child when they are erased — no step to forget in studentDelete', async () => {
    const { admin, studentId } = await seed();
    await admin.people.studentNoteAdd({ studentId, body: 'A note' });
    await admin.people.studentDelete({ studentId, force: true });
    expect(app.dbmod.db.select().from(studentNotes).all()).toEqual([]);
  });
});
