// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * RE-ADMISSION — the children who are already here (0.52.0-dev.9, docs/ADMISSIONS.md §5 and §8).
 *
 * The flow whose normal mode of use is "three hundred families, in one fortnight, with every button
 * pressed twice". So most of this file is about doing things more than once and about writing LESS
 * than was submitted:
 *
 *  - **The diff writes only what changed.** The form is pre-filled, so nearly everything that comes
 *    back is what was already there. Writing all of it would touch every row every year and bury the
 *    two fields that moved in three hundred that did not. Proven here by `updated_at`, which is the
 *    only observable difference between "wrote the same value" and "wrote nothing".
 *  - **Preview and commit agree**, over the same input, because they call the same function.
 *  - **Everything is idempotent**: opening, approving, and the re-enrollment fee.
 *  - **The Student ID never changes and is never re-minted.** This is an update to a record that
 *    already exists, which is the whole difference between re-admission and admission.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshApp, makeCtx } from './harness';
import { admissionLinks, charges, families, feePlans, guardianFamilies, guardians, readmissions, schoolYears, schools, studentFees, students, auditLog, settings } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let schoolsMod: typeof import('../src/schools');
let readmission: typeof import('../src/admissions/readmission');
let tokens: typeof import('../src/auth/tokens');

const caller = (role: Role) =>
  app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp();
  schoolsMod = await import('../src/schools');
  readmission = await import('../src/admissions/readmission');
  tokens = await import('../src/auth/tokens');
});

beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [admissionLinks, readmissions, charges, studentFees, students, guardianFamilies, guardians, families, feePlans, schoolYears, auditLog]) db.delete(t).run();
  db.delete(settings).where(eq(settings.key, 'admissions')).run();
  schoolsMod.ensureDefaultSchool();
});

/** A roster: two active children, one withdrawn, one household with an address and a guardian. */
async function seed(opts: { readmissionFeeCents?: number | null } = {}) {
  const admin = caller('admin');
  const { db } = app.dbmod;
  const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
  const hardship = await admin.billing.feePlanCreate({ name: 'Hardship', amountCents: 2000, cadence: 'monthly' });
  const school = db.select().from(schools).all()[0];
  const year = await admin.structure.schoolYearCreate({ label: '2027–2028', startYear: 2027, startMonth: 9, endMonth: 6, schoolId: school.id });
  if (opts.readmissionFeeCents !== undefined) await admin.structure.schoolYearUpdate({ id: year.id, readmissionFeeCents: opts.readmissionFeeCents });

  const a = await admin.people.studentAdd({ fullName: 'Yusuf Ismail', feePlanId: plan.id });
  const b = await admin.people.studentAdd({ fullName: 'Bilal Khan', feePlanId: plan.id });
  const gone = await admin.people.studentAdd({ fullName: 'Departed Child', feePlanId: plan.id });
  await admin.people.studentUpdate({ id: gone.id, status: 'withdrawn' });

  const famId = db.select().from(students).where(eq(students.id, a.id)).get()!.familyId;
  await admin.people.familyUpdate({ id: famId, fields: { address: '12 Mill Lane', languages: 'Urdu, English', nationality: 'British' } });
  await admin.people.guardianCreate({ familyId: famId, name: 'Ibrahim Ismail', phone: '07700 900123', email: 'ibrahim@example.org' });

  return { admin, planId: plan.id, hardshipId: hardship.id, yearId: year.id, aId: a.id, bId: b.id, goneId: gone.id, famId };
}

const rows = () => app.dbmod.db.select().from(readmissions).all();
const famRow = (id: string) => app.dbmod.db.select().from(families).where(eq(families.id, id)).get()!;

describe('opening a year', () => {
  it('names every active child, excludes the withdrawn one, and is idempotent', async () => {
    const { admin, yearId, goneId } = await seed();
    const first = await admin.admissions.readmissionOpen({ schoolYearId: yearId, target: { kind: 'all' } });
    expect(first.created).toBe(2); // the withdrawn child is not asked to come back
    expect(rows().map((r) => r.studentId)).not.toContain(goneId);

    // The second press is what actually happens, because the first one looked slow.
    const second = await admin.admissions.readmissionOpen({ schoolYearId: yearId, target: { kind: 'all' } });
    expect(second.created).toBe(0);
    expect(second.existing).toBe(2);
    expect(rows()).toHaveLength(2);
  });

  it('counts the withdrawn children an office picked by hand, rather than silently dropping them', async () => {
    const { admin, yearId, aId, goneId } = await seed();
    const r = await admin.admissions.readmissionOpen({ schoolYearId: yearId, target: { kind: 'students', studentIds: [aId, goneId] } });
    expect(r.created).toBe(1);
    expect(r.skippedWithdrawn).toBe(1); // said out loud — a silent drop is how an office loses a child
  });

  it('refuses a year that does not exist', async () => {
    const { admin } = await seed();
    await expect(admin.admissions.readmissionOpen({ schoolYearId: 'sy_nope', target: { kind: 'all' } })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('the family’s link', () => {
  it('stores only the hash, and the raw token appears nowhere in the database', async () => {
    const { admin, yearId } = await seed();
    await admin.admissions.readmissionOpen({ schoolYearId: yearId, target: { kind: 'all' } });
    const id = rows()[0].id;
    const { token } = await admin.admissions.readmissionLink({ id });

    expect(token.length).toBeGreaterThan(30);
    const [link] = app.dbmod.db.select().from(admissionLinks).all();
    expect(link.tokenHash).toBe(tokens.hashToken(token));
    expect(link.tokenHash).not.toBe(token);
    // The control: it is genuinely the same machinery invites and resets use, so a stolen row cannot
    // be replayed as a link.
    expect(JSON.stringify(app.dbmod.db.select().from(admissionLinks).all())).not.toContain(token);
  });

  it('is single use — a second submission through the same link is refused', async () => {
    const { admin, yearId } = await seed();
    await admin.admissions.readmissionOpen({ schoolYearId: yearId, target: { kind: 'all' } });
    const id = rows()[0].id;
    const { token } = await admin.admissions.readmissionLink({ id });

    const first = readmission.submitReadmission(token, { address: '9 New Road' }, { returning: true, actor: { userId: null, name: 'test' } });
    expect(first.ok).toBe(true);
    const second = readmission.submitReadmission(token, { address: '99 Other Road' }, { returning: true, actor: { userId: null, name: 'test' } });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('used');
  });

  it('says which failure it is — there is nothing to enumerate behind a 256-bit token', () => {
    // Deliberately unlike the public inquiry form, which answers identically whatever happens. Its
    // key is a child's name; this one's is unguessable, so telling its holder "already used" reveals
    // nothing to anybody who did not already have it, and saves a phone call to the office.
    expect(readmission.readmissionByToken('not-a-real-token')).toEqual({ ok: false, reason: 'unknown' });
  });

  it('refuses an expired link', async () => {
    const { admin, yearId } = await seed();
    await admin.admissions.readmissionOpen({ schoolYearId: yearId, target: { kind: 'all' } });
    const id = rows()[0].id;
    const { token } = await admin.admissions.readmissionLink({ id });
    const { db } = app.dbmod;
    db.update(admissionLinks).set({ expiresAt: new Date(Date.now() - 1000) }).run();
    expect(readmission.readmissionByToken(token).ok).toBe(false);
    expect((readmission.readmissionByToken(token) as { reason: string }).reason).toBe('expired');
  });
});

describe('the diff', () => {
  it('writes only what changed, and repeating a pre-filled value writes nothing at all', async () => {
    const { admin, yearId, famId } = await seed();
    await admin.admissions.readmissionOpen({ schoolYearId: yearId, target: { kind: 'all' } });
    const id = rows().find((r) => r.studentId)!.id;
    const review0 = await admin.admissions.readmissionReview({ id });
    const before = famRow(review0.current.familyId).updatedAt.getTime();

    // The family sends back the whole pre-filled form with ONE field changed.
    await admin.admissions.readmissionSubmitFor({
      id,
      returning: true,
      fields: { address: '9 New Road', languages: 'Urdu, English', nationality: 'British' },
    });
    const review = await admin.admissions.readmissionReview({ id });
    expect(review.changes.map((c) => c.field)).toEqual(['address']);
    expect(review.changes[0]).toEqual({ field: 'address', from: '12 Mill Lane', to: '9 New Road' });

    await admin.admissions.readmissionApprove({ id });
    const fam = famRow(review.current.familyId);
    expect(fam.address).toBe('9 New Road');
    expect(fam.languages).toBe('Urdu, English');
    expect(fam.nationality).toBe('British');
    expect(fam.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
    void famId;
  });

  it('writes NOTHING when a family confirms everything unchanged', async () => {
    const { admin, yearId } = await seed();
    await admin.admissions.readmissionOpen({ schoolYearId: yearId, target: { kind: 'all' } });
    const id = rows()[0].id;
    const review0 = await admin.admissions.readmissionReview({ id });
    const before = famRow(review0.current.familyId).updatedAt.getTime();

    await admin.admissions.readmissionSubmitFor({
      id,
      returning: true,
      fields: { address: review0.current.address, languages: review0.current.languages, nationality: review0.current.nationality },
    });
    const review = await admin.admissions.readmissionReview({ id });
    expect(review.changes).toEqual([]);
    await admin.admissions.readmissionApprove({ id });
    // `updated_at` still means something. Delete the "to === from" skip in `diffSubmission` and this
    // goes red, because every row would be rewritten every year.
    expect(famRow(review0.current.familyId).updatedAt.getTime()).toBe(before);
  });

  /** The property docs/ADMISSIONS.md §5 asks for by name: run both over the same input, assert they
   *  agree. They do because `approveReadmission` takes `reviewReadmission`'s answer rather than
   *  recomputing one — which is what makes this a property of the code and not a coincidence. */
  it('preview and commit agree, over the same input', async () => {
    const { admin, yearId } = await seed();
    await admin.admissions.readmissionOpen({ schoolYearId: yearId, target: { kind: 'all' } });
    const id = rows()[0].id;
    await admin.admissions.readmissionSubmitFor({ id, returning: true, fields: { address: '9 New Road', guardianPhone: '07700 900999' } });

    const preview = await admin.admissions.readmissionReview({ id });
    const committed = await admin.admissions.readmissionApprove({ id });
    expect(committed.applied).toEqual(preview.changes);
    expect(preview.changes.length).toBeGreaterThan(0); // the vacuity guard: [] === [] proves nothing
  });

  it('an absent field is left alone; an emptied one is cleared on purpose', async () => {
    const { admin, yearId } = await seed();
    await admin.admissions.readmissionOpen({ schoolYearId: yearId, target: { kind: 'all' } });
    const id = rows()[0].id;
    const review0 = await admin.admissions.readmissionReview({ id });

    // `languages` is never sent — the form did not carry it. `nationality` is sent empty, which is a
    // family clearing a pre-filled box on purpose. Conflating the two would either wipe untouched
    // fields or refuse to clear one somebody deliberately emptied.
    await admin.admissions.readmissionSubmitFor({ id, returning: true, fields: { nationality: '' } });
    const review = await admin.admissions.readmissionReview({ id });
    expect(review.changes.map((c) => c.field)).toEqual(['nationality']);
    await admin.admissions.readmissionApprove({ id });
    const fam = famRow(review0.current.familyId);
    expect(fam.nationality).toBeNull();
    expect(fam.languages).toBe('Urdu, English'); // untouched
  });

  it('lets the office refuse one field without refusing the rest', async () => {
    const { admin, yearId } = await seed();
    await admin.admissions.readmissionOpen({ schoolYearId: yearId, target: { kind: 'all' } });
    const id = rows()[0].id;
    await admin.admissions.readmissionSubmitFor({ id, returning: true, fields: { address: '9 New Road', nationality: 'Nonsense' } });
    const r = await admin.admissions.readmissionApprove({ id, rejectFields: ['nationality'] });
    expect(r.applied.map((c) => c.field)).toEqual(['address']);
    const review = await admin.admissions.readmissionReview({ id });
    expect(famRow(review.current.familyId).nationality).toBe('British');
  });
});

describe('approving', () => {
  it('keeps the Student ID and the active status — this is an update, not a new child', async () => {
    const { admin, yearId } = await seed();
    await admin.admissions.readmissionOpen({ schoolYearId: yearId, target: { kind: 'all' } });
    const id = rows()[0].id;
    const before = app.dbmod.db.select().from(students).where(eq(students.id, rows()[0].studentId)).get()!;
    await admin.admissions.readmissionSubmitFor({ id, returning: true, fields: { address: '9 New Road' } });
    await admin.admissions.readmissionApprove({ id });
    const after = app.dbmod.db.select().from(students).where(eq(students.id, before.id)).get()!;
    expect(after.studentCode).toBe(before.studentCode);
    expect(after.status).toBe('active');
    expect(app.dbmod.db.select().from(students).all()).toHaveLength(3); // no new child was created
  });

  it('reconfirms the fee plan rather than carrying it forward silently', async () => {
    const { admin, yearId, hardshipId } = await seed();
    await admin.admissions.readmissionOpen({ schoolYearId: yearId, target: { kind: 'all' } });
    const r = rows()[0];
    await admin.admissions.readmissionSubmitFor({ id: r.id, returning: true });
    await admin.admissions.readmissionApprove({ id: r.id, feePlanId: hardshipId, overrideAmountCents: 1500 });
    const fee = app.dbmod.db.select().from(studentFees).where(eq(studentFees.studentId, r.studentId)).get()!;
    expect(fee.feePlanId).toBe(hardshipId);
    expect(fee.overrideAmountCents).toBe(1500);
    // One row, replaced — not a second plan quietly stacked on the first.
    expect(app.dbmod.db.select().from(studentFees).where(eq(studentFees.studentId, r.studentId)).all()).toHaveLength(1);
  });

  it('raises the re-enrollment fee once, whatever the button does', async () => {
    const { admin, yearId } = await seed({ readmissionFeeCents: 1000 });
    await admin.admissions.readmissionOpen({ schoolYearId: yearId, target: { kind: 'all' } });
    const r = rows()[0];
    await admin.admissions.readmissionSubmitFor({ id: r.id, returning: true });
    const first = await admin.admissions.readmissionApprove({ id: r.id });
    const second = await admin.admissions.readmissionApprove({ id: r.id });

    expect(first.fee.created).toBe(true);
    expect(second.alreadyApproved).toBe(true);
    const raised = app.dbmod.db.select().from(charges).all();
    expect(raised).toHaveLength(1);
    expect(raised[0].amountCents).toBe(1000);
    expect(raised[0].sourceKey).toBe(`readmission:${r.studentId}:${yearId}`);
    expect(raised[0].label).toContain('2027–2028'); // snapshotted, so next year's price cannot rewrite it
  });

  it('waives the fee for one family without touching the year', async () => {
    const { admin, yearId } = await seed({ readmissionFeeCents: 1000 });
    await admin.admissions.readmissionOpen({ schoolYearId: yearId, target: { kind: 'all' } });
    const r = rows()[0];
    await admin.admissions.readmissionSubmitFor({ id: r.id, returning: true });
    await admin.admissions.readmissionApprove({ id: r.id, feeWaived: true });
    expect(app.dbmod.db.select().from(charges).all()).toHaveLength(0);
    expect(app.dbmod.db.select().from(schoolYears).where(eq(schoolYears.id, yearId)).get()!.readmissionFeeCents).toBe(1000);
  });

  it('refuses to approve a family who said they are not returning, and says what to do', async () => {
    const { admin, yearId } = await seed();
    await admin.admissions.readmissionOpen({ schoolYearId: yearId, target: { kind: 'all' } });
    const r = rows()[0];
    await admin.admissions.readmissionSubmitFor({ id: r.id, returning: false });
    expect(rows().find((x) => x.id === r.id)!.state).toBe('not_returning');
    await expect(admin.admissions.readmissionApprove({ id: r.id })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('pending') });
  });

  it('keeps field NAMES in the trail and the values out of it', async () => {
    const { admin, yearId } = await seed();
    await admin.admissions.readmissionOpen({ schoolYearId: yearId, target: { kind: 'all' } });
    const r = rows()[0];
    await admin.admissions.readmissionSubmitFor({ id: r.id, returning: true, fields: { address: '9 Secretstreet Road' } });
    await admin.admissions.readmissionApprove({ id: r.id });
    const trail = JSON.stringify(app.dbmod.db.select().from(auditLog).all());
    expect(trail).toContain('readmission.approve'); // the control
    expect(trail).toContain('address'); // the field name is useful
    expect(trail).not.toContain('Secretstreet'); // the value is the family's
  });
});

describe('the board, and lapsing', () => {
  it('counts who has answered and who has not', async () => {
    const { admin, yearId } = await seed();
    await admin.admissions.readmissionOpen({ schoolYearId: yearId, target: { kind: 'all' } });
    const [first] = rows();
    await admin.admissions.readmissionSubmitFor({ id: first.id, returning: true });
    const board = await admin.admissions.readmissionBoard({ schoolYearId: yearId });
    expect(board.counts.submitted).toBe(1);
    expect(board.counts.pending).toBe(1);
    expect(board.rows).toHaveLength(2);
    expect(board.rows[0].fullName < board.rows[1].fullName).toBe(true); // a stable order to work down
  });

  it('lapses by the office’s action, never by inference from silence', async () => {
    const { admin, yearId } = await seed();
    await admin.admissions.readmissionOpen({ schoolYearId: yearId, target: { kind: 'all' } });
    const r = rows()[0];
    // A row that nobody has answered is still `pending` however long it sits there — deriving
    // "lapsed" at read time would make the screen disagree with itself between two refreshes.
    expect((await admin.admissions.readmissionBoard({ schoolYearId: yearId })).counts.lapsed).toBeUndefined();
    await admin.admissions.readmissionState({ id: r.id, state: 'lapsed' });
    expect((await admin.admissions.readmissionBoard({ schoolYearId: yearId })).counts.lapsed).toBe(1);
    // ...and reopening is the same door in reverse.
    await admin.admissions.readmissionState({ id: r.id, state: 'pending' });
    expect((await admin.admissions.readmissionBoard({ schoolYearId: yearId })).counts.pending).toBe(2);
  });

  it('cannot hold two rows for one child in one year — the database says so', async () => {
    const { admin, yearId } = await seed();
    await admin.admissions.readmissionOpen({ schoolYearId: yearId, target: { kind: 'all' } });
    const r = rows()[0];
    const { db } = app.dbmod;
    const ts = new Date();
    // Around the helper, straight at the index — otherwise this file passes with no unique index.
    expect(() =>
      db.insert(readmissions).values({ id: 'rdm_dup', studentId: r.studentId, schoolYearId: yearId, state: 'pending', feeWaived: false, createdAt: ts, updatedAt: ts }).run(),
    ).toThrow();
  });
});
