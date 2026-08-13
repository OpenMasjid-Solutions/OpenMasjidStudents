// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The Settings surface for the family sheet's wording (0.48.0).
 *
 * The rendering itself is covered in onboardingSheet.test.ts. What matters here is the door:
 *
 *  1. ADMIN ONLY, like every other setting (§5). The sheet is what a family is handed; finance may print
 *     one but does not get to re-write what it says.
 *  2. THE REGISTRY IS THE ALLOW-LIST. An unknown box is refused at the boundary rather than stored and
 *     silently ignored — a client that made up a key would otherwise look like it had worked.
 *  3. The catalogue is SERVED, not hard-coded in the browser: keys, shipped defaults, tags and the length
 *     cap all come from the server, so adding a sentence needs no change on the UI side.
 *  4. Reset means reset — every box, back to the shipped sentence.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { freshApp, makeCtx } from './harness';
import { settings, auditLog, users, studentFees, feePlans, guardianFamilies, guardians, students, families } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
/**
 * The registry is imported DYNAMICALLY, after `freshApp`, and that is not a style choice.
 * `people/sheetText` reaches `db/index.ts` two hops down (for `esc`), and `config.ts` freezes `dataDir`
 * at import — so a static import here binds the whole app to the developer's own `./data` database
 * before the harness can point it at a temp directory. `freshApp` now refuses to continue when that has
 * happened, but the fix is here: import inside `beforeAll`, like every other test file.
 */
let text: typeof import('../src/people/sheetText');

const caller = (role: Role) =>
  app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp();
  text = await import('../src/people/sheetText');
});
beforeEach(() => {
  const { db } = app.dbmod;
  // People too, since the no-email list below reads the roster and would otherwise accumulate one.
  for (const t of [studentFees, feePlans, guardianFamilies, guardians, students, families, settings, auditLog, users]) db.delete(t).run();
});

describe('settings.sheetText', () => {
  it('serves the whole registry, with nothing overridden on a fresh install', async () => {
    const r = await caller('admin').settings.sheetTextGet();
    expect(r.keys).toEqual([...text.SHEET_TEXT_KEYS]);
    expect(r.defaults).toEqual(text.SHEET_TEXT_DEFAULTS);
    expect(r.overrides).toEqual({});
    expect(r.tags).toContain('website');
    expect(r.maxLength).toBeGreaterThan(300); // room for the longest shipped sentence
  });

  it('saves a box, reports it as this madrasah’s, and reverts it when cleared', async () => {
    const admin = caller('admin');
    await admin.settings.sheetTextSet({ boxes: [{ key: 'check', text: 'Tell us if anything here is wrong.' }] });
    expect((await admin.settings.sheetTextGet()).overrides).toEqual({ check: 'Tell us if anything here is wrong.' });

    await admin.settings.sheetTextSet({ boxes: [{ key: 'check', text: '   ' }] });
    expect((await admin.settings.sheetTextGet()).overrides).toEqual({});
  });

  it('leaves the other boxes alone when one is saved', async () => {
    const admin = caller('admin');
    await admin.settings.sheetTextSet({ boxes: [{ key: 'intro', text: 'Welcome.' }] });
    await admin.settings.sheetTextSet({ boxes: [{ key: 'footer', text: 'Keep this.' }] });
    expect((await admin.settings.sheetTextGet()).overrides).toEqual({ intro: 'Welcome.', footer: 'Keep this.' });
  });

  it('reset puts every box back', async () => {
    const admin = caller('admin');
    await admin.settings.sheetTextSet({ boxes: text.SHEET_TEXT_KEYS.map((key) => ({ key, text: 'mine' })) });
    expect(Object.keys((await admin.settings.sheetTextGet()).overrides)).toHaveLength(text.SHEET_TEXT_KEYS.length);
    await admin.settings.sheetTextSet({ reset: true });
    expect((await admin.settings.sheetTextGet()).overrides).toEqual({});
  });

  it('refuses a key that is not in the registry', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately sending what a stale or hostile client might
    await expect(caller('admin').settings.sheetTextSet({ boxes: [{ key: 'somethingElse' as any, text: 'x' }] })).rejects.toThrow();
  });

  it('refuses finance and parents at both ends', async () => {
    for (const role of ['finance', 'parent'] as Role[]) {
      await expect(caller(role).settings.sheetTextGet()).rejects.toThrow();
      await expect(caller(role).settings.sheetTextSet({ boxes: [{ key: 'intro', text: 'x' }] })).rejects.toThrow();
    }
  });

  it('audits the change by key name, without copying the prose in', async () => {
    const { db } = app.dbmod;
    await caller('admin').settings.sheetTextSet({ boxes: [{ key: 'payOffice', text: 'Hand it to the office.' }] });
    const row = db.select().from(auditLog).all().find((a) => a.action === 'settings.sheetText')!;
    expect(row).toBeTruthy();
    expect(JSON.stringify(row.detail)).toContain('payOffice');
    expect(JSON.stringify(row.detail)).not.toContain('Hand it to the office');
  });

  /**
   * Every message this app sends a family is an email, so a household with no address on file receives
   * none of it — silently, which is how an office finds out months later. This is the list that says so.
   */
  it('lists the students nobody can email, with somebody to ring about it', async () => {
    const admin = caller('admin');
    const plan = await admin.billing.feePlanCreate({ name: 'Monthly', amountCents: 10000, cadence: 'monthly' });
    const reachable = await admin.people.studentAdd({ fullName: 'Yusuf Ismail', feePlanId: plan.id });
    await admin.people.guardianCreate({ familyId: reachable.familyId, name: 'Abu Yusuf', email: 'abu@example.org', phone: '(555) 010-2030' });
    const unreachable = await admin.people.studentAdd({ fullName: 'Bilal Farooqi', feePlanId: plan.id });
    await admin.people.guardianCreate({ familyId: unreachable.familyId, name: 'Abu Bilal', phone: '(555) 010-4040' });

    const r = await admin.settings.noEmailStudents();
    expect(r.total).toBe(1);
    expect(r.households).toBe(1);
    expect(r.students[0].fullName).toBe('Bilal Farooqi');
    // The point of the list is being able to ring them, so the number comes with it.
    expect(r.students[0].guardians).toEqual([{ name: 'Abu Bilal', phone: '(555) 010-4040' }]);

    // One address anywhere on the household is enough — guardians attach to the household (§9), so the
    // question is whether the FAMILY is reachable, not whether every adult on it has an address.
    await admin.people.guardianCreate({ familyId: unreachable.familyId, name: 'Umm Bilal', email: 'umm@example.org' });
    expect((await admin.settings.noEmailStudents()).total).toBe(0);
  });

  it('leaves withdrawn students off the list — nobody chases an address for a family that left', async () => {
    const admin = caller('admin');
    const plan = await admin.billing.feePlanCreate({ name: 'Monthly', amountCents: 10000, cadence: 'monthly' });
    const gone = await admin.people.studentAdd({ fullName: 'Gone Away', feePlanId: plan.id });
    expect((await admin.settings.noEmailStudents()).total).toBe(1);
    await admin.people.studentUpdate({ id: gone.id, status: 'withdrawn' });
    expect((await admin.settings.noEmailStudents()).total).toBe(0);
  });

  it('exposes what the donations address resolves to, so Settings can show the printed line', async () => {
    const admin = caller('admin');
    expect((await admin.settings.get()).donateUrl).toBe('');
    await admin.settings.set({ contact: { website: 'https://madani.test', donatePath: '/donate' } });
    const r = await admin.settings.get();
    expect(r.contact.donatePath).toBe('/donate');
    expect(r.donateUrl).toBe('madani.test/donate');
  });
});
