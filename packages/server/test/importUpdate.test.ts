// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * IMPORTING CHANGES TO CHILDREN WHO ARE ALREADY HERE (0.52.0-dev.4, §4a Phase 1).
 *
 * The workflow this makes safe: export the roster with its data in it, fill in the blanks in Excel,
 * upload it back. Every assertion here exists because the obvious implementation of that gets one of
 * them wrong, and each wrong answer is expensive on a real roster of three hundred children:
 *
 *   - no identity column → three hundred duplicates;
 *   - matching on NAME → two children called Muhammad Ali become one;
 *   - an unknown ID treated as new → a typo mints a second record for a child already here;
 *   - empty meaning "set to nothing" → every untouched cell wipes a field;
 *   - writing every field → `updated_at` stops meaning anything and the trail is one row per child;
 *   - updating fee plans → a hundred households get the wrong bill, past a preview nobody read line
 *     by line.
 *
 * The preview and the commit are checked against EACH OTHER as well as separately: `commitRows` runs
 * `validateRows` itself and applies the diff it produced, so "what the office approved" and "what was
 * written" are the same object rather than two computations that might agree.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshApp, makeCtx } from './harness';
import { settings, students, studentNotes, studentFees, feePlans, families, guardians, guardianFamilies, emergencyContacts, classes, courses, schoolYears, terms, users, auditLog, invoices, invoiceItems, payments, paymentAllocations, charges, chargeItems } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let fields: typeof import('../src/people/fields');

const caller = (role: Role) =>
  app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp();
  fields = await import('../src/people/fields');
});

beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, charges, chargeItems, invoiceItems, invoices, studentNotes, studentFees, feePlans, guardianFamilies, guardians, emergencyContacts, students, classes, courses, families, terms, schoolYears, users, auditLog]) db.delete(t).run();
  db.delete(settings).where(eq(settings.key, 'student_fields')).run();
});

/** One child, on a plan, with a household. Returns their Student ID — the identity the sheet carries. */
async function seed(name = 'Yusuf Ismail') {
  const admin = caller('admin');
  const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' });
  const s = await admin.people.studentAdd({ fullName: name, feePlanId: plan.id });
  const row = app.dbmod.db.select().from(students).where(eq(students.id, s.id)).get()!;
  return { admin, planId: plan.id, studentId: s.id, code: row.studentCode!, familyId: row.familyId };
}

const preview = (admin: ReturnType<typeof caller>, rows: unknown[], updateExisting = true) =>
  admin.people.importPreview({ rows: rows as never, updateExisting });
const commit = (admin: ReturnType<typeof caller>, rows: unknown[], updateExisting = true) =>
  admin.people.importCommit({ rows: rows as never, updateExisting });

describe('classifying a row', () => {
  it('with no Student ID is a NEW child, exactly as before', async () => {
    const { admin, planId } = await seed();
    void planId;
    const r = await preview(admin, [{ fullName: 'Maryam Ismail', feePlanName: 'Tuition' }]);
    expect(r.rows[0].mode).toBe('create');
    expect(r.createCount).toBe(1);
    expect(r.updateCount).toBe(0);
  });

  it('with a matching Student ID is a CHANGE', async () => {
    const { admin, code } = await seed();
    const r = await preview(admin, [{ studentCode: code, fields: { priorSchool: 'Madrasah al-Noor' } }]);
    expect(r.rows[0].mode).toBe('update');
    expect(r.rows[0].ok).toBe(true);
    expect(r.rows[0].update?.changes.map((c) => c.key)).toEqual(['priorSchool']);
  });

  it('matches on the ID and NEVER on the name — two children called Muhammad Ali stay two', async () => {
    const { admin } = await seed('Muhammad Ali');
    const plan = app.dbmod.db.select().from(feePlans).get()!;
    await admin.people.studentAdd({ fullName: 'Muhammad Ali', feePlanId: plan.id });
    expect(app.dbmod.db.select().from(students).all()).toHaveLength(2);

    // A row naming one of them, with no ID, is a THIRD child — not a guess at which of the two.
    const r = await preview(admin, [{ fullName: 'Muhammad Ali', feePlanName: 'Tuition' }]);
    expect(r.rows[0].mode).toBe('create');
  });

  it('REFUSES an ID that matches nothing rather than creating a second record', async () => {
    // The expensive one. A typo'd ID silently creating a child is the outcome an office cannot see.
    const { admin } = await seed();
    const r = await preview(admin, [{ studentCode: 'ZZZ9999', fullName: 'Yusuf Ismail' }]);
    expect(r.rows[0].ok).toBe(false);
    expect(r.rows[0].errors.join(' ')).toContain('ZZZ9999');
    await expect(commit(admin, [{ studentCode: 'ZZZ9999', fullName: 'Yusuf Ismail' }])).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(app.dbmod.db.select().from(students).all()).toHaveLength(1);
  });

  it('REFUSES a row with an ID when the office has not asked to update', async () => {
    // "I am uploading the sheet I exported" and "I am adding this year's intake" are different
    // intentions and the file looks the same either way, so the switch is explicit.
    const { admin, code } = await seed();
    const r = await preview(admin, [{ studentCode: code, fields: { priorSchool: 'x' } }], false);
    expect(r.rows[0].ok).toBe(false);
    expect(r.rows[0].errors.join(' ')).toContain('Update students already here');
  });

  it('reads a Student ID however the office typed it — case, spaces and hyphens', async () => {
    const { admin, code } = await seed();
    const messy = ` ${code.slice(0, 3).toLowerCase()}-${code.slice(3)} `;
    const r = await preview(admin, [{ studentCode: messy, fields: { priorSchool: 'Madrasah al-Noor' } }]);
    expect(r.rows[0].ok).toBe(true);
    expect(r.rows[0].update?.studentCode).toBe(code);
  });
});

describe('an empty cell LEAVES IT ALONE', () => {
  it('does not wipe a field the office did not touch', async () => {
    // The rule the whole pre-filled workflow rests on: the sheet is mostly blanks being filled IN.
    const { admin, code, studentId } = await seed();
    await admin.people.studentUpdate({ id: studentId, fields: { priorSchool: 'Madrasah al-Noor', priorHifz: 'Juz 3' } });

    await commit(admin, [{ studentCode: code, fields: { priorHifz: 'Juz 5', priorSchool: '' } }]);

    const after = app.dbmod.db.select().from(students).where(eq(students.id, studentId)).get()!;
    expect(after.priorHifz).toBe('Juz 5');
    expect(after.priorSchool).toBe('Madrasah al-Noor'); // untouched, not cleared
  });

  it('clears one deliberately with the sentinel', async () => {
    const { admin, code, studentId } = await seed();
    await admin.people.studentUpdate({ id: studentId, fields: { priorSchool: 'Madrasah al-Noor' } });
    await commit(admin, [{ studentCode: code, fields: { priorSchool: '(clear)' } }]);
    expect(app.dbmod.db.select().from(students).where(eq(students.id, studentId)).get()!.priorSchool).toBeNull();
  });
});

describe('only what CHANGED is written', () => {
  it('reports no changes for a row that matches the record exactly', async () => {
    const { admin, code, studentId } = await seed();
    await admin.people.studentUpdate({ id: studentId, fields: { priorSchool: 'Madrasah al-Noor' } });
    const r = await preview(admin, [{ studentCode: code, fullName: 'Yusuf Ismail', fields: { priorSchool: 'Madrasah al-Noor' } }]);
    expect(r.rows[0].ok).toBe(true);
    expect(r.rows[0].update?.changes).toEqual([]);
    expect(r.unchangedCount).toBe(1);
    expect(r.updateCount).toBe(0);
  });

  it('does not touch the row at all when nothing differs, so updated_at still means something', async () => {
    const { admin, code, studentId } = await seed();
    const before = app.dbmod.db.select().from(students).where(eq(students.id, studentId)).get()!.updatedAt;
    const res = await commit(admin, [{ studentCode: code, fullName: 'Yusuf Ismail' }]);
    expect(res.updated).toBe(0);
    expect(app.dbmod.db.select().from(students).where(eq(students.id, studentId)).get()!.updatedAt).toEqual(before);
  });

  it('names every field it would change, before it changes it', async () => {
    const { admin, code, studentId } = await seed();
    await admin.people.studentUpdate({ id: studentId, fields: { priorSchool: 'Old School' } });
    const r = await preview(admin, [{ studentCode: code, fullName: 'Yusuf M Ismail', fields: { priorSchool: 'Madrasah al-Noor' } }]);
    const changes = r.rows[0].update!.changes;
    expect(changes.map((c) => c.key).sort()).toEqual(['fullName', 'priorSchool']);
    expect(changes.find((c) => c.key === 'priorSchool')).toMatchObject({ from: 'Old School', to: 'Madrasah al-Noor' });
  });
});

describe('what an import will NOT change', () => {
  it('lets the EXPORTED fee plan through unchanged — otherwise no round trip is possible', async () => {
    const { admin, code } = await seed();
    const r = await preview(admin, [{ studentCode: code, feePlanName: 'Tuition' }]);
    expect(r.rows[0].ok).toBe(true);
    expect(r.rows[0].update?.changes).toEqual([]);
  });

  it('refuses a CHANGE to the fee plan or the amount — money has its own screen', async () => {
    const { admin, code } = await seed();
    await admin.billing.feePlanCreate({ name: 'Hardship', amountCents: 2500, cadence: 'monthly' });
    const r = await preview(admin, [{ studentCode: code, feePlanName: 'Hardship' }]);
    expect(r.rows[0].ok).toBe(false);
    expect(r.rows[0].errors.join(' ')).toContain('Fee plan is not changed by an import');

    const r2 = await preview(admin, [{ studentCode: code, amount: '25.00' }]);
    expect(r2.rows[0].ok).toBe(false);
    expect(r2.rows[0].errors.join(' ')).toContain('Amount is not changed by an import');
  });

  it('refuses a guardian the household does not already have, and lets a repeated one through', async () => {
    const { admin, code, familyId } = await seed();
    const bad = await preview(admin, [{ studentCode: code, guardianName: 'Ibrahim Ismail', guardianPhone: '5551234' }]);
    expect(bad.rows[0].ok).toBe(false);
    expect(bad.rows[0].errors.join(' ')).toContain('Guardians are not changed');

    // Once that guardian IS on the household, the same row is the export round-tripping and is silent.
    await admin.people.guardianCreate({ familyId, name: 'Ibrahim Ismail', phone: '5551234', relation: 'father' });
    const ok = await preview(admin, [{ studentCode: code, guardianName: 'Ibrahim Ismail', guardianPhone: '5551234' }]);
    expect(ok.rows[0].ok).toBe(true);
  });

  it('refuses a field this madrasah has switched off', async () => {
    const { admin, code } = await seed();
    await admin.people.studentFieldsSet({ keys: ['priorHifz'] });
    const r = await preview(admin, [{ studentCode: code, fields: { priorSchool: 'Madrasah al-Noor' } }]);
    // The column is not in the catalog for this install, so the value is simply not offered — the
    // sheet may still carry the header, and an office should not be blocked by a stale column.
    expect(r.rows[0].update?.changes.map((c) => c.key)).not.toContain('priorSchool');
  });
});

describe('household fields go to the HOUSEHOLD', () => {
  it('writes the address once, on the family, from a child’s row', async () => {
    const { admin, code, familyId, studentId } = await seed();
    await commit(admin, [{ studentCode: code, fields: { address: '12 Mill Lane', languages: 'Urdu, English' } }]);
    const fam = app.dbmod.db.select().from(families).where(eq(families.id, familyId)).get()!;
    expect(fam.address).toBe('12 Mill Lane');
    expect(fam.languages).toBe('Urdu, English');
    // …and not onto the child, which is the point of the move.
    const stu = app.dbmod.db.select().from(students).where(eq(students.id, studentId)).get()! as unknown as Record<string, unknown>;
    expect(stu.address).toBeUndefined();
  });

  it('marks the change as household in the preview, so the office can see whose it is', async () => {
    const { admin, code } = await seed();
    const r = await preview(admin, [{ studentCode: code, fields: { address: '12 Mill Lane' } }]);
    expect(r.rows[0].update?.changes[0]).toMatchObject({ key: 'address', scope: 'household' });
  });
});

describe('the Note column', () => {
  it('APPENDS on an update rather than replacing — a sheet cannot rewrite a note', async () => {
    const { admin, code, studentId } = await seed();
    await admin.people.studentNoteAdd({ studentId, body: 'First note' });
    await commit(admin, [{ studentCode: code, note: 'Added from the spreadsheet', fields: { priorHifz: 'Juz 3' } }]);
    const { notes } = await admin.people.studentGet({ id: studentId });
    expect(notes.map((n) => n.body).sort()).toEqual(['Added from the spreadsheet', 'First note']);
  });
});

describe('the export', () => {
  it('carries the Student ID first, every column, and the data already recorded', async () => {
    const { admin, code, studentId, familyId } = await seed();
    await admin.people.studentUpdate({ id: studentId, fields: { priorSchool: 'Madrasah al-Noor' } });
    await admin.people.familyUpdate({ id: familyId, fields: { address: '12 Mill Lane' } });

    const x = await admin.people.importExport();
    expect(x.columns[0]).toMatchObject({ key: 'studentCode', label: 'Student ID' });
    expect(x.rows).toHaveLength(1);
    const at = (key: string) => x.rows[0][x.columns.findIndex((c) => c.key === key)];
    expect(at('studentCode')).toBe(code);
    expect(at('fullName')).toBe('Yusuf Ismail');
    expect(at('priorSchool')).toBe('Madrasah al-Noor');
    expect(at('address')).toBe('12 Mill Lane');
    // The note column is exported EMPTY on purpose: it appends, so round-tripping it would add a
    // second copy of every note each time the sheet came back.
    expect(at('note')).toBe('');
  });

  it('ROUND-TRIPS: exporting and re-importing unchanged writes nothing at all', async () => {
    // The assertion that makes the whole workflow safe. The obvious implementation fails this by
    // creating a duplicate of every child, or by rewriting every field it round-tripped.
    const { admin, studentId } = await seed();
    await admin.people.studentUpdate({ id: studentId, fields: { priorSchool: 'Madrasah al-Noor' } });
    const before = app.dbmod.db.select().from(students).where(eq(students.id, studentId)).get()!;

    const x = await admin.people.importExport();
    const rows = x.rows.map((cells) => {
      const row: Record<string, unknown> = { fields: {} as Record<string, string> };
      x.columns.forEach((c, i) => {
        if (fields.STUDENT_FIELDS.some((f) => f.key === c.key)) (row.fields as Record<string, string>)[c.key] = cells[i];
        else row[c.key] = cells[i];
      });
      return row;
    });

    const r = await preview(admin, rows);
    expect(r.errorCount).toBe(0);
    expect(r.createCount).toBe(0);
    expect(r.unchangedCount).toBe(1);

    const res = await commit(admin, rows);
    expect(res.created).toBe(0);
    expect(res.updated).toBe(0);
    expect(app.dbmod.db.select().from(students).all()).toHaveLength(1);
    expect(app.dbmod.db.select().from(students).where(eq(students.id, studentId)).get()!.updatedAt).toEqual(before.updatedAt);
  });

  it('is admin-only — finance does not export the roster', async () => {
    await seed();
    await expect(caller('finance').people.importExport()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('never carries a medical column, even to an admin, while the field is switched off', async () => {
    const { admin } = await seed();
    const x = await admin.people.importExport();
    for (const k of fields.MEDICAL_FIELD_KEYS) expect(x.columns.map((c) => c.key)).not.toContain(k);
    // …and does once it is on, so the assertion above is not passing on a spelling mistake.
    await admin.people.studentFieldsSet({ keys: fields.STUDENT_FIELDS.map((f) => f.key) });
    const y = await admin.people.importExport();
    for (const k of fields.MEDICAL_FIELD_KEYS) expect(y.columns.map((c) => c.key)).toContain(k);
  });
});

describe('a mixed file', () => {
  it('adds the new children and changes the existing ones in one pass', async () => {
    const { admin, code, studentId } = await seed();
    const res = await commit(admin, [
      { studentCode: code, fields: { priorHifz: 'Juz 5' } },
      { fullName: 'Maryam Ismail', feePlanName: 'Tuition' },
    ]);
    expect(res.created).toBe(1);
    expect(res.updated).toBe(1);
    expect(app.dbmod.db.select().from(students).all()).toHaveLength(2);
    expect(app.dbmod.db.select().from(students).where(eq(students.id, studentId)).get()!.priorHifz).toBe('Juz 5');
  });

  it('writes NOTHING when any row is bad — all of it lands or none does', async () => {
    const { admin, code } = await seed();
    await expect(
      commit(admin, [
        { studentCode: code, fields: { priorHifz: 'Juz 5' } },
        { studentCode: 'ZZZ9999', fullName: 'Nobody' },
      ]),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(app.dbmod.db.select().from(students).all()).toHaveLength(1);
    expect(app.dbmod.db.select().from(students).get()!.priorHifz).toBeNull();
  });
});
