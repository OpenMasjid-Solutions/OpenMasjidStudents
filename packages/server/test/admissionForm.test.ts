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
import { admissionLinks, auditLog, charges, families, feePlans, guardianFamilies, guardians, inquiries, inquiryEvents, settings, studentFees, students, users, userSchools } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let form: typeof import('../src/admissions/admissionForm');
let fields: typeof import('../src/people/fields');
let settingsMod: typeof import('../src/settings');
let routes: typeof import('../src/admissions/publicRoutes');
let schoolsMod: typeof import('../src/schools');
let http: FastifyInstance;

const caller = (role: Role, origin: 'lan' | 'tunnel' = 'lan') =>
  app.appRouter.createCaller(makeCtx({ origin, session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp();
  form = await import('../src/admissions/admissionForm');
  fields = await import('../src/people/fields');
  settingsMod = await import('../src/settings');
  routes = await import('../src/admissions/publicRoutes');
  schoolsMod = await import('../src/schools');
  http = Fastify();
  routes.registerPublicInquiryRoutes(http as never);
  await http.ready();
});

beforeEach(() => {
  const { db } = app.dbmod;
  // FK order, child-first — the same list admissionsConvert.test.ts keeps, plus the links this file
  // mints. Deleting a parent row before its children is a FOREIGN KEY error in `beforeEach`, which
  // fails every test in the file for a reason that has nothing to do with any of them.
  for (const t of [admissionLinks, inquiryEvents, inquiries, charges, studentFees, students, guardianFamilies, guardians, families, feePlans, userSchools, auditLog]) {
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

/**
 * A source address nobody else in this file has used.
 *
 * The rate limiters are process-wide singletons, so without this the LAST tests in the file are
 * refused 429 by the FIRST ones and start asserting the limiter rather than themselves — which is a
 * guard that passes for the wrong reason, the failure §18 calls worse than none.
 */
let peerN = 0;
const freshPeer = () => `10.66.${Math.floor(peerN / 250)}.${(peerN++ % 250) + 1}`;

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

  /**
   * DEFENSIVE, WITH NO REACHABLE COUNTER-EXAMPLE TODAY — and recorded rather than pretended.
   *
   * Deleting the `medical ? '' :` guard in `admissionFormFields` does NOT turn this red, because
   * `prefillFor` has no case for a medical key and returns '' for one anyway. The guard is a second
   * lock on a door that is already shut, and it earns its place because the thing that would open
   * the first one — teaching `prefillFor` to read from a record — is exactly the plausible future
   * edit. The same shape as §9's note about `webhookTextFor`: a test that cannot fail is worth
   * naming as such instead of counting as proof.
   */
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
    return http.inject({ method: 'POST', url: '/public/admission', remoteAddress: freshPeer(), payload: { token, ...body } });
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
      remoteAddress: freshPeer(),
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
    await http.inject({ method: 'POST', url: '/public/admission', remoteAddress: freshPeer(), payload: { token, childName: 'Yusuf Ismail' } });
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
      remoteAddress: freshPeer(),
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

describe('tablet mode', () => {
  /** A signed-in tablet, the way an admin starts one. */
  async function aTablet() {
    settingsMod.setAdmissions({ kiosk: true });
    const r = await caller('admin').admissions.kioskStart();
    return r.token;
  }

  it('is off until the office turns it on', async () => {
    settingsMod.setAdmissions({ kiosk: false });
    await expect(caller('admin').admissions.kioskStart()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // …and the route answers nothing at all, not an error page that admits it exists.
    const page = await http.inject({ method: 'GET', url: '/public/admission/kiosk?token=x' });
    expect(page.body).not.toContain('<form');
  });

  it('IS REFUSED OVER THE TUNNEL BY DEFAULT — the network is the control', async () => {
    const token = await aTablet();
    const lan = await http.inject({ method: 'GET', url: `/public/admission/kiosk?token=${token}` });
    const tunnel = await http.inject({ method: 'GET', url: `/public/admission/kiosk?token=${token}`, headers: { 'cf-ray': 'test-ray' } });
    expect(lan.statusCode).toBe(200);
    expect(lan.body).toContain('choose your child');
    // A form addressed to one family can travel anywhere; a form standing open on a shared device
    // cannot, because nobody is holding a per-family token (Hasan, 0.52.0-dev.13).
    expect(tunnel.body).not.toContain('choose your child');
  });

  it('opens over the tunnel once an office explicitly allows it', async () => {
    const token = await aTablet();
    settingsMod.setAdmissions({ kioskRemote: true });
    const tunnel = await http.inject({ method: 'GET', url: `/public/admission/kiosk?token=${token}`, headers: { 'cf-ray': 'test-ray' } });
    expect(tunnel.body).toContain('choose your child');
  });

  it('refuses a submission over the tunnel too, not just the page', async () => {
    const token = await aTablet();
    const id = await anInquiry();
    const res = await http.inject({
      method: 'POST',
      url: '/public/admission/kiosk',
      headers: { 'cf-ray': 'test-ray' },
      remoteAddress: freshPeer(),
      payload: { token, inquiry: id, childName: 'Yusuf Ismail' },
    });
    // Gating only the page would leave the write open to anybody who had once seen the URL.
    expect(res.statusCode).not.toBe(200);
    expect(app.dbmod.db.select().from(inquiries).where(eq(inquiries.id, id)).get()!.submittedPayload).toBeNull();
  });

  it('offers names and NOTHING else — whoever holds the tablet is not that family', async () => {
    const token = await aTablet();
    await anInquiry({ childName: 'Yusuf Ismail', email: 'secret@example.org', phone: '5559999', message: 'private note' });

    // THE ROW, not just the page. The guard is the narrowed `select` — the same reasoning
    // `studentColumnsFor` gives for returning columns rather than filtering after the read: what is
    // never read cannot be logged on the way through, and a renderer that starts printing one more
    // field is a one-line change. Asserting only the HTML would pass with the whole row in memory.
    const rows = form.kioskInquiries();
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(['childName', 'id']);

    const page = await http.inject({ method: 'GET', url: `/public/admission/kiosk?token=${token}` });
    expect(page.body).toContain('Yusuf Ismail');
    for (const leak of ['secret@example.org', '5559999', 'private note']) expect(page.body).not.toContain(leak);
  });

  it('does not offer a child who has been admitted or declined', async () => {
    const token = await aTablet();
    const gone = await anInquiry({ childName: 'Already Declined', email: 'a@example.org' });
    await caller('admin').admissions.transition({ id: gone, to: 'declined' });
    const page = await http.inject({ method: 'GET', url: `/public/admission/kiosk?token=${token}` });
    expect(page.body).not.toContain('Already Declined');
  });

  it('stores a submission against the family the tablet chose', async () => {
    const token = await aTablet();
    const id = await anInquiry();
    const res = await http.inject({ method: 'POST', url: '/public/admission/kiosk', remoteAddress: freshPeer(), payload: { token, inquiry: id, childName: 'Yusuf Ismail', guardianPhone: '5551111' } });
    expect(res.statusCode).toBe(200);
    const row = app.dbmod.db.select().from(inquiries).where(eq(inquiries.id, id)).get()!;
    expect(row.submittedPayload).toMatchObject({ guardianPhone: '5551111' });
    // Still a proposal — a tablet proposes exactly like a link does.
    expect(app.dbmod.db.select().from(students).all()).toHaveLength(0);
  });

  it('stops working the moment the office ends it', async () => {
    const token = await aTablet();
    const devices = await caller('admin').admissions.kioskList();
    expect(devices.devices).toHaveLength(1);
    await caller('admin').admissions.kioskRevoke({ id: devices.devices[0]!.id });

    const page = await http.inject({ method: 'GET', url: `/public/admission/kiosk?token=${token}` });
    expect(page.body).toContain('not signed in');
    const id = await anInquiry();
    const res = await http.inject({ method: 'POST', url: '/public/admission/kiosk', remoteAddress: freshPeer(), payload: { token, inquiry: id, childName: 'Yusuf Ismail' } });
    expect(res.statusCode).toBe(409);
  });

  it('carries no session — the token is the whole of what the device holds', async () => {
    const token = await aTablet();
    const page = await http.inject({ method: 'GET', url: `/public/admission/kiosk?token=${token}` });
    // Handing a parent a tablet holding an admin session would put the whole directory one
    // back-button away. Nothing here sets a cookie.
    expect(page.headers['set-cookie']).toBeUndefined();
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });
});

describe('two schools, and who works whose inquiries', () => {
  /**
   * Hasan's question: "how are we going to handle admissions to multiple schools? … someone at the
   * global level would select who manages this… it would notify the person in charge of that
   * specific school."
   *
   * `user_schools` already says it — NO ROWS MEANS ALL SCHOOLS — so an unrestricted account is the
   * global level and a restricted one is the school's own person. What was missing is that
   * admissions ignored it, and every admin saw every inquiry whatever their restriction said.
   */
  let maktab: string;
  let hifz: string;
  /** Schools are not deleted between tests (years and rosters point at them), so each pair is new. */
  let schoolN = 0;

  /**
   * An admin restricted to one school — the school's own person.
   *
   * The `users` row is real because `user_schools` has a foreign key to it: a restriction that could
   * be written for an account that does not exist would be a restriction nobody could ever lift.
   */
  const forSchool = (schoolId: string) => {
    const userId = `usr_${schoolId}`;
    const { db } = app.dbmod;
    if (!db.select().from(users).where(eq(users.id, userId)).get()) {
      db.insert(users)
        .values({ id: userId, username: userId, passwordHash: 'x', role: 'admin', status: 'active', mustChangePassword: false, createdAt: new Date(), updatedAt: new Date() })
        .run();
    }
    schoolsMod.setUserSchools(userId, [schoolId]);
    return app.appRouter.createCaller(
      makeCtx({ origin: 'lan', session: { role: 'admin', source: 'local', username: userId, userId } }).ctx,
    );
  };

  beforeEach(async () => {
    const admin = caller('admin');
    schoolN += 1;
    maktab = (await admin.structure.schoolCreate({ name: `Weekend maktab ${schoolN}` })).id;
    hifz = (await admin.structure.schoolCreate({ name: `Hifz school ${schoolN}` })).id;
  });

  it('shows a school’s own person only their school’s inquiries', async () => {
    const admin = caller('admin');
    const a = await anInquiry({ childName: 'Maktab Child', email: 'a@example.org' });
    const b = await anInquiry({ childName: 'Hifz Child', email: 'b@example.org' });
    await admin.admissions.assign({ id: a, schoolId: maktab });
    await admin.admissions.assign({ id: b, schoolId: hifz });

    const seen = await forSchool(maktab).admissions.list({ state: 'open', limit: 100 });
    expect(seen.rows.map((r) => r.childName)).toEqual(['Maktab Child']);
    // The counts are scoped too: "2 waiting" when one of them is the other program's is a number
    // that makes somebody do the wrong thing.
    expect(seen.counts.new ?? 0).toBe(1);
  });

  it('hides an UNASSIGNED inquiry from a school — routing is the global level’s job', async () => {
    const unrouted = await anInquiry({ childName: 'Not Routed Yet', email: 'c@example.org' });
    const seen = await forSchool(maktab).admissions.list({ state: 'open', limit: 100 });
    expect(seen.rows.map((r) => r.childName)).not.toContain('Not Routed Yet');
    // …and the global level does see it, or nobody could ever route it.
    const global = await caller('admin').admissions.list({ state: 'open', limit: 100 });
    expect(global.rows.map((r) => r.id)).toContain(unrouted);
  });

  it('refuses to OPEN an unassigned inquiry too, not just hide it from the list', async () => {
    const unrouted = await anInquiry({ childName: 'Not Routed Yet', email: 'c@example.org' });
    // The list hides it because SQL's `IN` never matches NULL — which is correct and is NOT the
    // guard. `requireInquiry` is, and without this test the null half of it is unproven: a school
    // holding the id could still open a family nobody had handed them.
    await expect(forSchool(maktab).admissions.get({ id: unrouted })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses to open another school’s inquiry, and says NOT FOUND rather than forbidden', async () => {
    const admin = caller('admin');
    const b = await anInquiry({ childName: 'Hifz Child', email: 'b@example.org' });
    await admin.admissions.assign({ id: b, schoolId: hifz });
    // Telling a restricted account that an inquiry EXISTS but belongs elsewhere is itself a fact
    // about another school's roster.
    await expect(forSchool(maktab).admissions.get({ id: b })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses to MOVE or delete another school’s inquiry', async () => {
    const admin = caller('admin');
    const b = await anInquiry({ childName: 'Hifz Child', email: 'b@example.org' });
    await admin.admissions.assign({ id: b, schoolId: hifz });
    const other = forSchool(maktab);
    // A read wall that is not a write wall is not a wall.
    await expect(other.admissions.transition({ id: b, to: 'declined' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(other.admissions.remove({ id: b })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(other.admissions.admissionStart({ id: b })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('an unrestricted admin still sees and works everything', async () => {
    const admin = caller('admin');
    const a = await anInquiry({ childName: 'Maktab Child', email: 'a@example.org' });
    await admin.admissions.assign({ id: a, schoolId: maktab });
    // The positive control: without it every assertion above passes against a list that is empty
    // for everybody.
    const got = await admin.admissions.get({ id: a });
    expect(got.inquiry.childName).toBe('Maktab Child');
  });
});
