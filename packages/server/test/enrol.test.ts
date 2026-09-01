// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Mass class enrollment (0.42.0). The per-student dropdown was the only way to place a child, which made
 * September an hour of dropdowns; this is the same write, done once for a list.
 *
 * The behaviors worth pinning: it is one transaction, it silently skips students who are no longer
 * active (a stale browser tab is not a reason to fail the whole action), it refuses an archived class,
 * and it audits ONE entry with a count rather than thirty rows — it was one decision by one person.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshApp, makeCtx } from './harness';
import { auditLog, students, classes, courses, studentFees, feePlans, families } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
const caller = (role: Role, origin: 'lan' | 'tunnel' = 'lan') =>
  app.appRouter.createCaller(makeCtx({ origin, session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => { app = await freshApp(); });
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [studentFees, students, classes, courses, feePlans, families, auditLog]) db.delete(t).run();
});

async function seed() {
  const admin = caller('admin');
  const course = await admin.structure.courseCreate({ name: 'Hifz' });
  const cls = await admin.structure.classCreate({ courseId: course.id, name: 'Hifz 1' });
  const other = await admin.structure.classCreate({ courseId: course.id, name: 'Hifz 2' });
  const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 35000, cadence: 'monthly' });
  const kids = [];
  for (const name of ['Yusuf Ismail', 'Maryam Ismail', 'Bilal Farooqi']) {
    kids.push(await admin.people.studentAdd({ fullName: name, feePlanId: plan.id }));
  }
  return { admin, classId: cls.id, otherId: other.id, courseId: course.id, kids };
}

describe('setStudentClassBulk', () => {
  it('places a whole list into one class in one call', async () => {
    const { admin, classId, kids } = await seed();
    const r = await admin.structure.setStudentClassBulk({ studentIds: kids.map((k) => k.id), classId });
    expect(r).toMatchObject({ placed: 3, skipped: 0 });

    const rows = await admin.structure.studentsByClass({});
    expect(rows.filter((s) => s.classId === classId)).toHaveLength(3);
    // The course tree's per-class count is what the office reads on the Structure tab.
    const tree = await admin.structure.courseTree();
    expect(tree[0].classes.find((c) => c.id === classId)!.studentCount).toBe(3);
  });

  it('moves students out of another class, and can unplace them with null', async () => {
    const { admin, classId, otherId, kids } = await seed();
    await admin.structure.setStudentClassBulk({ studentIds: kids.map((k) => k.id), classId });
    await admin.structure.setStudentClassBulk({ studentIds: [kids[0].id], classId: otherId });
    await admin.structure.setStudentClassBulk({ studentIds: [kids[1].id], classId: null });

    const rows = await admin.structure.studentsByClass({});
    expect(rows.find((s) => s.id === kids[0].id)!.classId).toBe(otherId);
    expect(rows.find((s) => s.id === kids[1].id)!.classId).toBeNull();
    expect(rows.find((s) => s.id === kids[2].id)!.classId).toBe(classId);
  });

  it('skips a student who is no longer active instead of failing the whole enrollment', async () => {
    const { admin, classId, kids } = await seed();
    await admin.people.studentUpdate({ id: kids[2].id, status: 'withdrawn' });
    const r = await admin.structure.setStudentClassBulk({ studentIds: kids.map((k) => k.id), classId });
    expect(r).toMatchObject({ placed: 2, skipped: 1 });
    // The withdrawn child was left exactly as they were, not quietly enrolled.
    expect(app.dbmod.db.select().from(students).where(eq(students.id, kids[2].id)).get()!.classId).toBeNull();
  });

  it('refuses an archived class', async () => {
    const { admin, classId, kids } = await seed();
    await admin.structure.classArchive({ id: classId });
    await expect(admin.structure.setStudentClassBulk({ studentIds: kids.map((k) => k.id), classId })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('audits one entry with the count, not one per student', async () => {
    const { admin, classId, kids } = await seed();
    await admin.structure.setStudentClassBulk({ studentIds: kids.map((k) => k.id), classId });
    const entries = app.dbmod.db.select().from(auditLog).all().filter((e) => e.action === 'student.setClassBulk');
    expect(entries).toHaveLength(1);
    expect((entries[0].detail as { placed: number }).placed).toBe(3);
  });

  it('is admin-only and LAN-only', async () => {
    const { classId, kids } = await seed();
    const ids = kids.map((k) => k.id);
    await expect(caller('finance').structure.setStudentClassBulk({ studentIds: ids, classId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller('admin', 'tunnel').structure.setStudentClassBulk({ studentIds: ids, classId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
