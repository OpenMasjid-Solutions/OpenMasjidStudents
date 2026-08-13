// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The sequence of calls the first-time setup wizard makes (0.48.0) — run for real, in order, on an
 * install that has nothing in it.
 *
 * The wizard is UI wiring over procedures that already existed, so what is worth testing is not the
 * component but the two assumptions it makes about the server:
 *
 *  1. IT NAMES NO SCHOOL. A first run has one school by definition, so the wizard omits `schoolId`
 *     everywhere and relies on the server falling back to it. That fallback throws "Add a school first"
 *     when there is nothing to fall back TO, which would make the year and classes steps dead on exactly
 *     the install they exist for — so a fresh database has to already have a school to land in.
 *
 *  2. THE ORDER IS THE POINT. `people/import.ts` resolves a row's Class and Fee plan columns against rows
 *     already in the database and REFUSES a file naming one that does not exist. So the spreadsheet an
 *     office imports only works if the classes and plans were made first — which is why those steps sit
 *     before the roster step, and why this asserts the failure as well as the success. `import.test.ts`
 *     covers the resolver itself; what is new here is that the wizard's own order satisfies it.
 *
 * It also pins the two smaller things the later steps lean on: the first year created becomes CURRENT
 * (the terms sub-step hangs off the current year, so a year that did not become current would leave it
 * with nothing to attach to), and name + currency save together in one call.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import {
  paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, guardianFamilies,
  guardians, students, classes, courses, families, terms, schoolYears, users, auditLog, settings,
} from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
const caller = (role: Role) =>
  app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => { app = await freshApp(); });
// `schools` is deliberately NOT cleared — the default school is part of a fresh install, which is
// precisely the thing assumption (1) above depends on.
beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, guardianFamilies, guardians, students, classes, courses, families, terms, schoolYears, users, auditLog, settings]) db.delete(t).run();
});

describe('the wizard, start to finish, naming no school', () => {
  it('walks the whole sequence on an empty install', async () => {
    const admin = caller('admin');

    // Step 1 — the madrasah's name and its currency, saved in one call.
    await admin.settings.set({ schoolName: 'An-Noor Weekend School', currency: 'gbp' });
    const s = await admin.settings.get();
    expect(s.schoolName).toBe('An-Noor Weekend School');
    expect(s.currency).toBe('gbp');

    // Step 3 — the school year. No `schoolId`: the server falls back to the default school.
    const year = await admin.structure.schoolYearCreate({ label: '2026–27', startYear: 2026, startMonth: 9, endMonth: 6 });
    const years = await admin.structure.schoolYearList();
    expect(years).toHaveLength(1);
    // The terms sub-step hangs off the CURRENT year, and nothing above asked for that — the first year
    // created for a school becomes current on its own, which is what makes the sub-step reachable.
    expect(years[0].isCurrent).toBe(true);
    expect(years[0].id).toBe(year.id);

    await admin.structure.termCreate({ schoolYearId: year.id, name: 'Term 1', startDate: '2026-09-01', endDate: '2026-12-18' });
    expect(await admin.structure.termList({ schoolYearId: year.id })).toHaveLength(1);

    // Step 4 — courses and classes, again with no school named.
    const course = await admin.structure.courseCreate({ name: 'Hifz' });
    await admin.structure.classCreate({ courseId: course.id, name: 'Hifz 1' });
    const tree = await admin.structure.courseTree();
    expect(tree.map((c) => c.name)).toEqual(['Hifz']);
    expect(tree[0].classes.map((k) => k.name)).toEqual(['Hifz 1']);

    // Step 5 — what tuition costs.
    await admin.billing.feePlanCreate({ name: 'Monthly tuition', amountCents: 8000, cadence: 'monthly' });
    expect((await admin.billing.feePlanList()).map((p) => p.name)).toEqual(['Monthly tuition']);

    // Step 8 — a colleague. The wizard generates the temporary password rather than asking for one, so
    // what matters is that a generated-shaped one is accepted and the account comes out forced to change
    // it: an account that did NOT would keep a password the office wrote on a sticky note forever.
    await admin.staff.create({ username: 'aisha', displayName: 'Aisha', role: 'finance', tempPassword: 'kmpqr-Y3TWA-9dnFh' });
    const roster = await admin.staff.list();
    const aisha = roster.find((u) => u.username === 'aisha');
    expect(aisha?.role).toBe('finance');
    expect(aisha?.mustChangePassword).toBe(true);
    expect(aisha?.status).toBe('active');
    // No school limit, which means all of them — a first run has one school and an account restricted to
    // none would see nothing (§9).
    expect(aisha?.schoolIds).toEqual([]);

    // Step 9 — and now the spreadsheet imports, because everything it names exists.
    const preview = await admin.people.importPreview({
      rows: [{ fullName: 'Yusuf Ismail', className: 'Hifz 1', feePlanName: 'Monthly tuition', guardianName: 'Ismail', guardianEmail: 'ismail@example.org' }],
    });
    expect(preview.rows[0].errors).toEqual([]);
  });

  it('never writes a staff temporary password into the audit trail', async () => {
    // The wizard now GENERATES this and shows it once, which makes where it can end up worth a test:
    // the audit row records the role and the username, and must not carry the credential itself (§14).
    // The same applies to the hash — an audit trail is read by people who are not entitled to it.
    const admin = caller('admin');
    const secret = 'kmpqr-Y3TWA-9dnFh';
    await admin.staff.create({ username: 'yasir', role: 'finance', tempPassword: secret });
    const trail = JSON.stringify(app.dbmod.db.select().from(auditLog).all());
    expect(trail).toContain('staff.create');
    expect(trail).toContain('yasir');
    expect(trail).not.toContain(secret);
    expect(trail).not.toContain('argon2');
  });

  it('would have rejected that same spreadsheet had the roster come first', async () => {
    // The reason the middle steps sit where they do, stated as a test rather than a comment: the very
    // same row, imported before the class and the plan exist, fails on both columns.
    const admin = caller('admin');
    const preview = await admin.people.importPreview({
      rows: [{ fullName: 'Yusuf Ismail', className: 'Hifz 1', feePlanName: 'Monthly tuition' }],
    });
    expect(preview.rows[0].errors.join(' ')).toMatch(/Class "Hifz 1" does not exist/);
    expect(preview.rows[0].errors.join(' ')).toMatch(/Fee plan "Monthly tuition" does not exist/);
  });

  it('has a school to fall back to before anything has been configured', async () => {
    // Assumption (1) on its own: the very first write the wizard makes that needs a school is the year,
    // and on a database straight out of migrations it must not raise "Add a school first".
    const admin = caller('admin');
    const schools = await admin.structure.schoolList();
    expect(schools.schools.length).toBeGreaterThan(0);
    await expect(admin.structure.courseCreate({ name: 'Maktab' })).resolves.toBeTruthy();
  });

  it('reports whether a parent can be reached, without a platform', async () => {
    // The email step reads this and says one of two things; with no Fabric wired up it must come back
    // "no mail" rather than throwing, because a standalone LAN install is a supported way to run (§6).
    const link = await caller('admin').settings.linkStatus();
    expect(link.mailAvailable).toBe(false);
    expect(link.publicUrl).toBeFalsy();
  });
});
