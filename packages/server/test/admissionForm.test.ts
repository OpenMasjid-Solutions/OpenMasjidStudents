// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * THE ADMISSION FORM — the family-facing one (0.52.0-dev.12, docs/ADMISSIONS.md §3a).
 *
 * The load-bearing claims, in the order they would hurt if they were wrong:
 *
 * 1. **Medical fields appear only when the office enabled them, and are NEVER read back to a
 *    family.** This is the §14 amendment Hasan signed off, and "providing is not disclosure" is only
 *    true if the read-back half actually holds. A pre-fill leak here hands a parent the office's own
 *    notes about their child.
 * 2. **A submission changes nothing until an admin approves it.** A token link that could write onto
 *    a roster is a roster anybody with a forwarded URL can edit.
 * 3. **The form is the registry**, so a field an office switched off is not asked for, and one it
 *    switched on is — without anybody editing a second list.
 * 4. **Nothing a family typed reaches a log line** (§14).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { freshApp, makeCtx } from './harness';
import { admissionLinks, auditLog, charges, families, feePlans, guardianFamilies, guardians, inquiries, inquiryEvents, settings, studentFees, students } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let form: typeof import('../src/admissions/admissionForm');
let fields: typeof import('../src/people/fields');
let settingsMod: typeof import('../src/settings');
let routes: typeof import('../src/admissions/publicRoutes');
let http: FastifyInstance;

const caller = (role: Role, origin: 'lan' | 'tunnel' = 'lan') =>
  app.appRouter.createCaller(makeCtx({ origin, session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp();
  form = await import('../src/admissions/admissionForm');
  fields = await import('../src/people/fields');
  settingsMod = await import('../src/settings');
  routes = await import('../src/admissions/publicRoutes');
  http = Fastify();
  routes.registerPublicInquiryRoutes(http as never);
  await http.ready();
});

beforeEach(() => {
  const { db } = app.dbmod;
  // FK order, child-first — the same list admissionsConvert.test.ts keeps, plus the links this file
  // mints. Deleting a parent row before its children is a FOREIGN KEY error in `beforeEach`, which
  // fails every test in the file for a reason that has nothing to do with any of them.
  for (const t of [admissionLinks, inquiryEvents, inquiries, charges, studentFees, students, guardianFamilies, guardians, families, feePlans, auditLog]) {
    db.delete(t).run();
  }
  for (const key of ['admissions', 'student_fields']) db.delete(settings).where(eq(settings.key, key)).run();
  settingsMod.setAdmissions({ publicForm: true, open: true, dailyMax: 1_000, minSeconds: 3 });
});

async function anInquiry(over: Record<string, unknown> = {}) {
  const r = await caller('admin').admissions.officeAdd({
    childName: 'Yusuf Ismail',
    parentName: 'Ibrahim Ismail',
    email: 'ibrahim@example.org',
    phone: '5551234',
    ...over,
  });
  return r.id as string;
}

/** Start the admission and get the family's link, the way the office does. */
async function issueLink(id: string) {
  const r = await caller('admin').admissions.admissionStart({ id });
  return r.token;
}

const keysOf = (id: string | null) => form.admissionFormFields(id ? app.dbmod.db.select().from(inquiries).where(eq(inquiries.id, id)).get()! : null).map((f) => f.key);

describe('what the form asks', () => {
  it('asks the registry, so a field the office switched off is not on the form', () => {
    fields.setEnabledFieldKeys(['priorSchool']);
    expect(keysOf(null)).toContain('priorSchool');
    expect(keysOf(null)).not.toContain('priorHifz');

    fields.setEnabledFieldKeys(['priorHifz']);
    expect(keysOf(null)).toContain('priorHifz');
    expect(keysOf(null)).not.toContain('priorSchool');
  });

  it('never asks a family for the office’s own answers', () => {
    fields.setEnabledFieldKeys([...fields.STUDENT_FIELD_KEYS]);
    const keys = keysOf(null);
    // Asking a parent when their child was admitted is asking them to fill in the school's record;
    // asking when they left is a question about a child who has not arrived.
    for (const k of ['admittedOn', 'withdrawnOn', 'withdrawalReason']) expect(keys).not.toContain(k);
  });

  it('pre-fills what the family already told us on the inquiry', async () => {
    const id = await anInquiry();
    const row = app.dbmod.db.select().from(inquiries).where(eq(inquiries.id, id)).get()!;
    const byKey = Object.fromEntries(form.admissionFormFields(row).map((f) => [f.key, f.prefill]));
    expect(byKey.childName).toBe('Yusuf Ismail');
    expect(byKey.guardianName).toBe('Ibrahim Ismail');
    expect(byKey.guardianEmail).toBe('ibrahim@example.org');
    expect(byKey.guardianPhone).toBe('5551234');
  });
});

describe('the medical fields — the §14 amendment', () => {
  it('are absent until the office enables them', () => {
    // The registry ships with them off, so the shipped default is a form that never asks.
    fields.setEnabledFieldKeys(['priorSchool']);
    for (const k of fields.MEDICAL_FIELD_KEYS) expect(keysOf(null)).not.toContain(k);
  });

  it('appear when the office enables them, flagged as medical', () => {
    fields.setEnabledFieldKeys([...fields.MEDICAL_FIELD_KEYS]);
    const got = form.admissionFormFields(null);
    for (const k of fields.MEDICAL_FIELD_KEYS) {
      const f = got.find((x) => x.key === k);
      expect(f, `expected ${k} on the form`).toBeTruthy();
      expect(f!.medical).toBe(true);
    }
  });

  it('IS NEVER PRE-FILLED — providing is not disclosure', () => {
    fields.setEnabledFieldKeys([...fields.MEDICAL_FIELD_KEYS]);
    // Hand the builder an inquiry whose every readable string is a medical secret. Whatever a future
    // edit makes `prefillFor` capable of reading, a medical box must come back empty.
    const secret = 'PEANUT ALLERGY — EPIPEN IN THE OFFICE';
    const fake = {
      id: 'i1', childName: secret, childDob: null, parentName: secret, email: secret, phone: secret,
      message: secret, askedAbout: secret, state: 'new', source: 'office', waitlistPosition: null,
      waitlistReason: null, submittedPayload: null, studentId: null, familyId: null, dedupeKey: null,
      schoolId: null, schoolYearId: null, createdAt: new Date(), updatedAt: new Date(),
    } as unknown as Parameters<typeof form.admissionFormFields>[0];
    for (const f of form.admissionFormFields(fake)) {
      if (f.medical) expect(f.prefill).toBe('');
    }
  });

  it('is rendered on the served page only when enabled, and the page carries no stored value', async () => {
    fields.setEnabledFieldKeys([...fields.MEDICAL_FIELD_KEYS]);
    const id = await anInquiry();
    const token = await issueLink(id);
    const page = await http.inject({ method: 'GET', url: `/public/admission?token=${token}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('a_allergies');
    // The consent flag is a SELECT, not a checkbox: an unticked box and a question nobody answered
    // are the same bytes, and for a medical consent that difference is the whole point.
    expect(page.body).toContain('name="medicalConsent"');
    expect(page.body).toContain('<select id="a_medicalConsent"');
  });
});

describe('a submission is a proposal, not a write', () => {
  async function submit(token: string, body: Record<string, unknown>) {
    return http.inject({ method: 'POST', url: '/public/admission', payload: { token, ...body } });
  }

  it('stores what came back and creates NOTHING', async () => {
    fields.setEnabledFieldKeys(['priorSchool', ...fields.MEDICAL_FIELD_KEYS]);
    const id = await anInquiry();
    const token = await issueLink(id);
    const res = await submit(token, { childName: 'Yusuf Ismail', priorSchool: 'Al-Falah', allergies: 'Peanuts' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);

    // Inert: the answers are on the inquiry and nowhere else.
    const row = app.dbmod.db.select().from(inquiries).where(eq(inquiries.id, id)).get()!;
    expect(row.submittedPayload).toMatchObject({ priorSchool: 'Al-Falah', allergies: 'Peanuts' });
    expect(app.dbmod.db.select().from(students).all()).toHaveLength(0);
    expect(app.dbmod.db.select().from(families).all()).toHaveLength(0);
    expect(row.studentId).toBeNull();
  });

  it('drops a key the form never asked for', async () => {
    fields.setEnabledFieldKeys(['priorSchool']);
    const id = await anInquiry();
    const token = await issueLink(id);
    // `allergies` is switched OFF, so it was not on the form and is not an answer to anything.
    await submit(token, { childName: 'Yusuf Ismail', allergies: 'Peanuts', admittedOn: '2020-01-01' });
    const row = app.dbmod.db.select().from(inquiries).where(eq(inquiries.id, id)).get()!;
    expect(row.submittedPayload).not.toHaveProperty('allergies');
    // …and an office-only field is refused even though it is a real registry key.
    expect(row.submittedPayload).not.toHaveProperty('admittedOn');
  });

  it('refuses a submission missing a field the office marked required', async () => {
    fields.setEnabledFieldKeys(['priorSchool']);
    settingsMod.setAdmissions({ requiredAdmissionFields: ['priorSchool'] });
    const id = await anInquiry();
    const token = await issueLink(id);
    const res = await submit(token, { childName: 'Yusuf Ismail', priorSchool: '' });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).reason).toBe('incomplete');
    expect(app.dbmod.db.select().from(inquiries).where(eq(inquiries.id, id)).get()!.submittedPayload).toBeNull();
  });

  it('replaces the proposal on a re-submission rather than making a second one', async () => {
    const id = await anInquiry();
    const token = await issueLink(id);
    await submit(token, { childName: 'Yusuf Ismail', guardianPhone: '111' });
    await submit(token, { childName: 'Yusuf Ismail', guardianPhone: '222' });
    const row = app.dbmod.db.select().from(inquiries).where(eq(inquiries.id, id)).get()!;
    // A family who mistyped a number should be able to open the link again and fix it.
    expect((row.submittedPayload as Record<string, string>).guardianPhone).toBe('222');
  });

  it('writes no answer into the audit trail — counts only', async () => {
    fields.setEnabledFieldKeys([...fields.MEDICAL_FIELD_KEYS]);
    const id = await anInquiry();
    const token = await issueLink(id);
    await submit(token, { childName: 'Yusuf Ismail', allergies: 'PEANUTS — EPIPEN' });
    const trail = JSON.stringify(app.dbmod.db.select().from(auditLog).all());
    expect(trail).toContain('admission.submit');
    // A trail outlives the proposal. A child's allergy must not be in it (§14).
    expect(trail).not.toContain('PEANUTS');
  });
});

describe('approval is what makes it a record', () => {
  it('writes the family’s answers to the right tables, and only on approval', async () => {
    fields.setEnabledFieldKeys(['priorSchool', 'address', ...fields.MEDICAL_FIELD_KEYS]);
    const id = await anInquiry();
    const token = await issueLink(id);
    await http.inject({
      method: 'POST',
      url: '/public/admission',
      payload: { token, childName: 'Yusuf Ismail', priorSchool: 'Al-Falah', address: '12 Mill Road', allergies: 'Peanuts', medicalConsent: '1' },
    });

    const plan = await caller('admin').billing.feePlanCreate({ name: 'Monthly', amountCents: 5000, cadence: 'monthly' });
    await caller('admin').admissions.convert({ id, feePlanId: plan.id });

    const student = app.dbmod.db.select().from(students).all()[0]!;
    expect(student.fullName).toBe('Yusuf Ismail');
    // A child field lands on the child…
    expect((student as unknown as Record<string, unknown>).priorSchool).toBe('Al-Falah');
    expect((student as unknown as Record<string, unknown>).allergies).toBe('Peanuts');
    // …and a household field lands on the household, never on the child (§9).
    const fam = app.dbmod.db.select().from(families).all()[0]!;
    expect((fam as unknown as Record<string, unknown>).address).toBe('12 Mill Road');
    expect(student).not.toHaveProperty('address');
  });

  it('stamps the admission date as TODAY without anybody typing one', async () => {
    const id = await anInquiry();
    const token = await issueLink(id);
    await http.inject({ method: 'POST', url: '/public/admission', payload: { token, childName: 'Yusuf Ismail' } });
    const plan = await caller('admin').billing.feePlanCreate({ name: 'Monthly', amountCents: 5000, cadence: 'monthly' });
    // Nothing in the office's approval names a date, and nothing on the family's form asks for one —
    // an admission approved today is an admission today (Hasan, 0.52.0-dev.12).
    await caller('admin').admissions.convert({ id, feePlanId: plan.id });
    const student = app.dbmod.db.select().from(students).all()[0]!;
    // UTC, like every other date this app stamps — `billing/invoices.ts`, autopay and the scheduler
    // all derive a day the same way, and admissions disagreeing with billing about what day it is
    // would be the §20 defect ("two places disagreeing about the same rule").
    expect((student as unknown as Record<string, unknown>).admittedOn).toBe(new Date().toISOString().slice(0, 10));
  });

  it('honors a field the office rejected on review', async () => {
    fields.setEnabledFieldKeys(['priorSchool', 'address']);
    const id = await anInquiry();
    const token = await issueLink(id);
    await http.inject({
      method: 'POST',
      url: '/public/admission',
      payload: { token, childName: 'Yusuf Ismail', priorSchool: 'Nonsense typed by mistake', address: '12 Mill Road' },
    });

    const plan = await caller('admin').billing.feePlanCreate({ name: 'Monthly', amountCents: 5000, cadence: 'monthly' });
    await caller('admin').admissions.convert({ id, feePlanId: plan.id, rejectFields: ['priorSchool'] });

    const student = app.dbmod.db.select().from(students).all()[0]!;
    expect((student as unknown as Record<string, unknown>).priorSchool).toBeNull();
    // The one they kept is still applied — rejecting one field is not rejecting the form.
    expect((app.dbmod.db.select().from(families).all()[0] as unknown as Record<string, unknown>).address).toBe('12 Mill Road');
  });
});

describe('the door', () => {
  it('tells a token holder WHICH failure, unlike the inquiry form', async () => {
    const page = await http.inject({ method: 'GET', url: '/public/admission?token=nope' });
    expect(page.statusCode).toBe(200);
    // A token holder is not a stranger being probed — they are looking at a form that will not open.
    expect(page.body).toContain('could not find that link');
    expect(page.body).not.toContain('<form');
  });

  it('is closed once the child has been admitted', async () => {
    const id = await anInquiry();
    const token = await issueLink(id);
    const plan = await caller('admin').billing.feePlanCreate({ name: 'Monthly', amountCents: 5000, cadence: 'monthly' });
    await caller('admin').admissions.convert({ id, feePlanId: plan.id });
    const page = await http.inject({ method: 'GET', url: `/public/admission?token=${token}` });
    expect(page.body).not.toContain('<form');
    expect(page.body).toContain('already dealt with');
  });

  it('is never embeddable — an admission form belongs in nobody’s iframe', async () => {
    const id = await anInquiry();
    const token = await issueLink(id);
    const page = await http.inject({ method: 'GET', url: `/public/admission?token=${token}` });
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
  });

  it('answers nothing at all when admissions are switched off', async () => {
    settingsMod.setAdmissions({ publicForm: false });
    const id = await anInquiry();
    const page = await http.inject({ method: 'GET', url: `/public/admission?token=x` });
    expect(page.body).not.toContain('<form');
    expect(id).toBeTruthy();
  });
});
