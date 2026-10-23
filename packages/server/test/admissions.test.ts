// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * THE ADMISSIONS DESK (0.52.0, CLAUDE.md §4a Phase 2, docs/ADMISSIONS.md §3–4, §8).
 *
 * `publicInquiry.test.ts` covers the door a stranger knocks on. This file covers what the office does
 * afterwards, and the three things that have to hold no matter what gets built on top:
 *
 *  1. **An inquiry is not a student.** It never mints a Student ID, it is never billable, and the two
 *     columns that link it to a child are null in every state but `admitted`.
 *  2. **The state is stored truth.** It is what a transition set it to — never an inference from
 *     whether some other row exists — and every move writes both an `inquiry_events` row (the trail
 *     the office reads) and an `audit_log` row (§14), from one function, so they cannot disagree.
 *  3. **Finance reaches none of it, and neither does the tunnel.** Not a filtered view: `FORBIDDEN`.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshApp, makeCtx } from './harness';
import { inquiries, inquiryEvents, students, settings, auditLog, schools, schoolYears } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let transition: typeof import('../src/admissions/transition');
let schoolsMod: typeof import('../src/schools');

const caller = (role: Role, origin: 'lan' | 'tunnel' = 'lan') =>
  app.appRouter.createCaller(makeCtx({ origin, session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp();
  transition = await import('../src/admissions/transition');
  schoolsMod = await import('../src/schools');
});

beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [inquiryEvents, inquiries, students, auditLog]) db.delete(t).run();
  db.delete(settings).where(eq(settings.key, 'admissions')).run();
  db.delete(settings).where(eq(settings.key, 'admissions_text')).run();
});

/** One inquiry on the desk, entered by the office (the public door has its own file). */
async function anInquiry(over: Record<string, unknown> = {}) {
  const r = await caller('admin').admissions.officeAdd({
    childName: 'Yusuf Ismail',
    parentName: 'Ibrahim Ismail',
    email: 'ibrahim@example.org',
    ...over,
  });
  return r.id as string;
}

const row = (id: string) => app.dbmod.db.select().from(inquiries).where(eq(inquiries.id, id)).get()!;
const events = (id: string) => app.dbmod.db.select().from(inquiryEvents).where(eq(inquiryEvents.inquiryId, id)).all();

describe('who may reach the desk', () => {
  /**
   * Enumerated from the real router rather than a list typed here, so a procedure added later is
   * covered the moment it exists. `_def.procedures` is how `studentFields.test.ts` pins the notes
   * surface; the same mechanism is what makes §4a's promise — "the public inquiry form is the only
   * new unauthenticated write surface in the whole project and stays that way" — testable.
   */
  const admissionProcs = () => Object.keys(app.appRouter._def.procedures).filter((k) => k.startsWith('admissions.'));

  it('covers every procedure this file claims to cover', () => {
    // The vacuity guard. Without it, a rename empties the loops below and they all pass.
    expect(admissionProcs().length).toBeGreaterThanOrEqual(7);
  });

  it('answers a finance session FORBIDDEN — not a filtered view', async () => {
    const fin = caller('finance') as unknown as Record<string, Record<string, (i: unknown) => Promise<unknown>>>;
    for (const path of admissionProcs()) {
      const name = path.slice('admissions.'.length);
      await expect(fin.admissions[name]({}), `finance reached ${path}`).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('answers a parent session FORBIDDEN too', async () => {
    const par = caller('parent') as unknown as Record<string, Record<string, (i: unknown) => Promise<unknown>>>;
    for (const path of admissionProcs()) {
      const name = path.slice('admissions.'.length);
      await expect(par.admissions[name]({}), `a parent reached ${path}`).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('refuses an admin session presented over the tunnel', async () => {
    // §12.4 at session-USE time, not only at login. The whole desk is LAN-only as a consequence, and
    // that is correct rather than something to work around.
    const remote = caller('admin', 'tunnel') as unknown as Record<string, Record<string, (i: unknown) => Promise<unknown>>>;
    for (const path of admissionProcs()) {
      const name = path.slice('admissions.'.length);
      await expect(remote.admissions[name]({}), `an admin over the tunnel reached ${path}`).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    // The control: the same calls work on the LAN.
    await expect(caller('admin').admissions.list({ state: 'open', limit: 10 })).resolves.toBeTruthy();
  });
});

describe('an inquiry is not a student', () => {
  it('mints no Student ID and touches no student row', async () => {
    const id = await anInquiry();
    const r = row(id);
    expect(r.studentId).toBeNull();
    expect(r.familyId).toBeNull();
    expect(app.dbmod.db.select().from(students).all()).toHaveLength(0);
    // Nothing in the whole record looks like a code, in any state the office can reach.
    for (const to of ['waitlisted', 'admission'] as const) {
      await caller('admin').admissions.transition({ id, to });
      expect(JSON.stringify(row(id))).not.toMatch(/[A-Z]{3}\d{4}/);
      expect(row(id).studentId).toBeNull();
    }
  });

  it('cannot be marked admitted by the office — that state means a student exists', async () => {
    const id = await anInquiry();
    await caller('admin').admissions.transition({ id, to: 'admission' });
    // `admitted` is absent from the procedure's enum, so it cannot even be named. The machine allows
    // admission → admitted; only `admissions/convert.ts` may apply it, inside the transaction that
    // created the child.
    await expect(
      (caller('admin').admissions.transition as unknown as (i: unknown) => Promise<unknown>)({ id, to: 'admitted' }),
    ).rejects.toBeTruthy();
    expect(row(id).state).toBe('admission');
    expect(transition.canTransition('admission', 'admitted')).toBe(true);
  });
});

describe('the pipeline', () => {
  it('records who moved it, when and why — in the trail AND in the audit log', async () => {
    const id = await anInquiry();
    await caller('admin').admissions.transition({ id, to: 'waitlisted', reason: 'Called them back on Tuesday' });
    const trail = events(id);
    expect(trail).toHaveLength(2); // arrival, then the move
    const move = trail.find((e) => e.toState === 'waitlisted')!;
    expect(move.fromState).toBe('new');
    expect(move.reason).toBe('Called them back on Tuesday');
    expect(move.actorName).toBeTruthy();

    // Both rows, from one writer, so they cannot come apart. The audit half carries the states and
    // NOT the office's prose about a family (§14).
    const audit = JSON.stringify(app.dbmod.db.select().from(auditLog).all());
    expect(audit).toContain('inquiry.transition');
    expect(audit).toContain('waitlisted');
    expect(audit).not.toContain('Called them back');
  });

  it('refuses a move the pipeline does not allow, and says what is in the way', async () => {
    const id = await anInquiry();
    await caller('admin').admissions.transition({ id, to: 'declined' });
    await expect(caller('admin').admissions.transition({ id, to: 'waitlisted' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('declined'),
    });
    expect(row(id).state).toBe('declined');
  });

  it('keeps a declined inquiry rather than deleting it — “did we ever hear from them?” needs an answer', async () => {
    const id = await anInquiry();
    await caller('admin').admissions.transition({ id, to: 'declined', reason: 'Full for this year' });
    const got = await caller('admin').admissions.get({ id });
    expect(got.inquiry.state).toBe('declined');
    expect(got.events.some((e) => e.reason === 'Full for this year')).toBe(true);
    // Declining is not deleting: the row and its reason survive. The one way onward is REOPEN, which
    // is the undo for a mis-click (0.52.0-dev.11) — declining must not be a one-way door whose only
    // remedy is re-typing the family from memory. Deleting is a separate, explicit act.
    expect(got.next).toEqual(['new']);
  });

  it('reopens a declined inquiry, and the trail says so', async () => {
    const id = await anInquiry();
    await caller('admin').admissions.transition({ id, to: 'declined' });
    await caller('admin').admissions.transition({ id, to: 'new', reason: 'They rang back in August' });
    const got = await caller('admin').admissions.get({ id });
    expect(got.inquiry.state).toBe('new');
    // The decline is still in the history — reopening is a new event, never an erasure of the old one.
    expect(got.events.map((e) => e.toState)).toEqual(expect.arrayContaining(['declined', 'new']));
    expect(got.events.some((e) => e.reason === 'They rang back in August')).toBe(true);
  });
});

describe('deleting an inquiry for good', () => {
  it('erases the row and its whole trail', async () => {
    const id = await anInquiry();
    await caller('admin').admissions.transition({ id, to: 'declined' });
    expect(events(id).length).toBeGreaterThan(0);

    await caller('admin').admissions.remove({ id });
    expect(app.dbmod.db.select().from(inquiries).where(eq(inquiries.id, id)).get()).toBeUndefined();
    // `inquiry_events` is ON DELETE cascade — a trail pointing at a row that no longer exists is a
    // trail nothing can render, and it would keep the family's details in the database after an
    // office believed they had removed them.
    expect(events(id)).toHaveLength(0);
  });

  it('writes the audit row FIRST, and it carries the names — never the message body', async () => {
    const id = await anInquiry({ message: 'Please do not repeat this anywhere' });
    await caller('admin').admissions.remove({ id });
    const trail = JSON.stringify(app.dbmod.db.select().from(auditLog).all());
    expect(trail).toContain('inquiry.delete');
    // The audit row is the ONLY trace that survives, so an id alone would document nothing (§9's
    // studentDelete precedent).
    expect(trail).toContain('Yusuf Ismail');
    expect(trail).toContain('Ibrahim Ismail');
    // …and what a stranger typed is exactly the part that must not outlive the record it was
    // deleted with (§14).
    expect(trail).not.toContain('Please do not repeat this anywhere');
  });

  it('refuses to erase one that became a student — that row is how the child joined', async () => {
    const id = await anInquiry();
    // The state is set directly rather than through `markAdmitted`, which insists on a real student
    // and household: what is under test is the DELETE's guard, and conversion has its own file.
    app.dbmod.db.update(inquiries).set({ state: 'admitted' }).where(eq(inquiries.id, id)).run();
    await expect(caller('admin').admissions.remove({ id })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(row(id)).toBeTruthy();
  });

  it('closes the waitlist gap when the deleted row was in the queue', async () => {
    const ids: string[] = [];
    for (const name of ['One Child', 'Two Child', 'Three Child']) {
      const id = await anInquiry({ childName: name, email: `${name.split(' ')[0].toLowerCase()}@example.org` });
      await caller('admin').admissions.transition({ id, to: 'waitlisted' });
      ids.push(id);
    }
    // Deleting is the one exit from the queue that is NOT a transition, so the renumber has to be
    // wired up separately — without it the list runs 1, 3 and the office stops trusting the numbers.
    await caller('admin').admissions.remove({ id: ids[1] });
    expect([ids[0], ids[2]].map((i) => row(i).waitlistPosition)).toEqual([1, 2]);
  });
});

describe('the waitlist', () => {
  it('numbers arrivals in order and closes the gap when one leaves', async () => {
    const ids: string[] = [];
    for (const name of ['One Child', 'Two Child', 'Three Child']) {
      const id = await anInquiry({ childName: name, email: `${name.split(' ')[0].toLowerCase()}@example.org` });
      await caller('admin').admissions.transition({ id, to: 'waitlisted', waitlistReason: 'No room until September' });
      ids.push(id);
    }
    expect(ids.map((i) => row(i).waitlistPosition)).toEqual([1, 2, 3]);

    // Offering from the waitlist is the same transition as offering from review; leaving takes its
    // position with it. A list with a hole at 1 is a list an office stops trusting.
    await caller('admin').admissions.transition({ id: ids[0], to: 'admission' });
    expect(row(ids[0]).waitlistPosition).toBeNull();
    expect(ids.slice(1).map((i) => row(i).waitlistPosition)).toEqual([1, 2]);
  });

  it('reorders by hand, and rows the screen did not name keep their order after the ones it did', async () => {
    const ids: string[] = [];
    for (const name of ['Alif Child', 'Ba Child', 'Jim Child']) {
      const id = await anInquiry({ childName: name, email: `${name.split(' ')[0].toLowerCase()}@example.org` });
      await caller('admin').admissions.transition({ id, to: 'waitlisted' });
      ids.push(id);
    }
    // Name only the third. It goes to the front; the other two follow in their existing order, rather
    // than being stranded with stale positions a partial list would otherwise leave behind.
    const r = await caller('admin').admissions.waitlistReorder({ ids: [ids[2]] });
    expect(r.count).toBe(3);
    expect(row(ids[2]).waitlistPosition).toBe(1);
    expect(row(ids[0]).waitlistPosition).toBe(2);
    expect(row(ids[1]).waitlistPosition).toBe(3);
  });
});

describe('the office typing one in', () => {
  it('marks it as the office rather than the public form, and says when it is a repeat', async () => {
    const id = await anInquiry();
    expect(row(id).source).toBe('office');
    // Unlike the public route, this one reports the truth: the person who typed it is signed in and
    // looking at the screen, so "you already have this one" is useful rather than a disclosure.
    const again = await caller('admin').admissions.officeAdd({ childName: 'Yusuf Ismail', parentName: 'Ibrahim Ismail', email: 'ibrahim@example.org' });
    expect(again.outcome).toBe('duplicate');
    expect(app.dbmod.db.select().from(inquiries).all()).toHaveLength(1);
  });

  it('refuses one with nothing to act on', async () => {
    await expect(caller('admin').admissions.officeAdd({ childName: 'Nobody Contactable', parentName: 'A Parent' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('assigns the school and the year — the office’s judgement, never the public form’s', async () => {
    const { db } = app.dbmod;
    schoolsMod.ensureDefaultSchool();
    const school = db.select().from(schools).all()[0];
    const ts = new Date();
    db.insert(schoolYears).values({ id: 'sy_1', schoolId: school.id, label: '2026–2027', startYear: 2026, startMonth: 9, endMonth: 6, isCurrent: true, status: 'active', createdAt: ts, updatedAt: ts }).run();
    const id = await anInquiry();
    await caller('admin').admissions.assign({ id, schoolId: school.id, schoolYearId: 'sy_1' });
    const got = await caller('admin').admissions.get({ id });
    expect(got.school?.id).toBe(school.id);
    expect(got.year?.label).toBe('2026–2027');
    await expect(caller('admin').admissions.assign({ id, schoolYearId: 'sy_nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('the public form’s settings', () => {
  it('refuses an origin that is not a bare website address', async () => {
    // These strings land in a `frame-ancestors` header. Refused at the boundary AND dropped on read —
    // both, deliberately: zod refuses a bad client, the read-side filter defends a hand-edited row.
    for (const bad of ['*', 'https://masjid.example/admissions', 'masjid.example', "https://a.example 'self'"]) {
      await expect(caller('admin').admissions.settingsSet({ embedOrigins: [bad] }), `accepted ${bad}`).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    await expect(caller('admin').admissions.settingsSet({ embedOrigins: ['https://masjid.example:8443'] })).resolves.toEqual({ ok: true });
  });

  it('audits opening the door, in both directions', async () => {
    await caller('admin').admissions.settingsSet({ publicForm: true });
    await caller('admin').admissions.settingsSet({ publicForm: false });
    const trail = app.dbmod.db.select().from(auditLog).all().filter((a) => a.action === 'settings.admissions');
    expect(trail).toHaveLength(2);
    expect(JSON.stringify(trail)).toContain('publicForm');
  });

  it('hands the screen the link and the snippet, and says when there is no public address', async () => {
    const got = await caller('admin').admissions.settingsGet();
    // No tunnel configured in this test app: the form still works on the LAN, and the screen has to
    // be able to say that rather than looking broken.
    expect(got.hasPublicUrl).toBe(false);
    expect(got.formUrl).toBe('');
    expect(got.textKeys.length).toBeGreaterThan(0);
    expect(got.textDefaults.intro).toContain('[school]');
  });

  it('refuses wording for a box that does not exist', async () => {
    await expect(
      (caller('admin').admissions.textSet as unknown as (i: unknown) => Promise<unknown>)({ boxes: [{ key: 'nope', text: 'hi' }] }),
    ).rejects.toBeTruthy();
    await caller('admin').admissions.textSet({ boxes: [{ key: 'intro', text: 'Our own welcome.' }] });
    expect((await caller('admin').admissions.settingsGet()).textOverrides.intro).toBe('Our own welcome.');
  });
});
