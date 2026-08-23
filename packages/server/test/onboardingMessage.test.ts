// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * THE ONBOARDING MESSAGE (0.51.0) — the explain-what-this-is note an office sends when a madrasah starts
 * using the app.
 *
 * Four things here can fail expensively, and they are what this file is about:
 *
 *  1. **WHO IT REACHES.** Guardians belong to the household, not the student (§9), so picking one child
 *     reaches the adults who also pay for their siblings. If the audience did not collapse to households,
 *     a family of three would get three copies of one message — and the office would have no way to tell,
 *     because the counts would still look right.
 *  2. **WHAT IT SAYS, AND WHAT IT MUST NEVER SAY.** It points at the family sheet precisely BECAUSE a
 *     Student ID may never go out on this channel (§14). A message that helpfully included the ID would
 *     be the whole payment credential on a channel the app does not control end to end.
 *  3. **THE WHATSAPP-ONLY LINE.** "Messages come from this number" is the sentence that stops a parent
 *     blocking an unknown number that is texting them about their children's fees. It has to be on the
 *     WhatsApp form and must not be in the email, where it means nothing.
 *  4. **THE BOUND.** One press writes to a fixed number of households and REPORTS the rest. Handing the
 *     queue two hundred messages is how a masjid loses its number (docs/WHATSAPP.md §1); truncating
 *     silently is the invisible failure this release spent its time removing.
 *
 * `fetch` is stubbed exactly as in whatsapp.test.ts, so nothing leaves the machine and the assertions are
 * on the requests we build.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { freshApp, makeCtx } from './harness';
import { classes, courses, families, feePlans, guardianFamilies, guardians, settings, auditLog, students, studentFees, users, whatsappLog } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let onboarding: typeof import('../src/people/onboarding');
let audience: typeof import('../src/structure/audience');
let whatsapp: typeof import('../src/whatsapp');
let settingsMod: typeof import('../src/settings');

const caller = (role: Role) => app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

interface Call {
  url: string;
  body: Record<string, unknown>;
}
let calls: Call[] = [];
const realFetch = globalThis.fetch;

function installFetch(): void {
  globalThis.fetch = vi.fn(async (input: unknown, init?: unknown) => {
    const i = (init ?? {}) as { body?: string; method?: string };
    const url = String(input);
    calls.push({ url, body: i.body ? (JSON.parse(i.body) as Record<string, unknown>) : { _method: i.method ?? 'GET' } });
    if (url.endsWith('/api/fabric/whatsapp')) {
      if ((i.method ?? 'GET') === 'GET') return { ok: true, status: 200, json: async () => ({ available: true, reason: 'ready', outcomes: true }) } as unknown as Response;
      return { ok: true, status: 202, json: async () => ({ queued: true, id: 'wam_test_1' }) } as unknown as Response;
    }
    if (url.endsWith('/api/fabric/email')) return { ok: true, status: 200, json: async () => ({ sent: true }) } as unknown as Response;
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
}

const emails = () => calls.filter((c) => c.url.endsWith('/api/fabric/email'));
/** Only what we actually handed to the queue — a GET status probe is not a send. */
const sends = () => calls.filter((c) => c.url.endsWith('/api/fabric/whatsapp') && typeof c.body.to === 'string');
const waText = () => sends().map((c) => String(c.body.text));
const mailBodies = () => emails().map((c) => String((c.body as { text?: string }).text ?? ''));

beforeAll(async () => {
  app = await freshApp({ fabric: true, publicUrl: 'https://masjid.example.org' });
  onboarding = await import('../src/people/onboarding');
  audience = await import('../src/structure/audience');
  whatsapp = await import('../src/whatsapp');
  settingsMod = await import('../src/settings');
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [studentFees, feePlans, students, classes, courses, guardianFamilies, guardians, families, whatsappLog, settings, auditLog]) db.delete(t).run();
  db.delete(users).run();
  calls = [];
  whatsapp.resetWhatsAppStatusCache();
  installFetch();
});

/** A household with one guardian who has both a number and an address, and `kids` children. */
async function household(surname: string, kids: string[], opts: { phone?: string | null; email?: string | null } = {}) {
  const admin = caller('admin');
  const plan =
    app.dbmod.db.select({ id: feePlans.id }).from(feePlans).get()?.id ??
    (await admin.billing.feePlanCreate({ name: 'Monthly tuition', amountCents: 5000, cadence: 'monthly' })).id;
  const fam = await admin.people.familyCreate({ name: surname });
  await admin.people.guardianCreate({
    familyId: fam.id,
    name: `Abu ${surname}`,
    phone: opts.phone === null ? undefined : (opts.phone ?? '5551234567'),
    email: opts.email === null ? undefined : (opts.email ?? `abu.${surname.toLowerCase()}@test.org`),
  });
  const ids: string[] = [];
  for (const k of kids) ids.push((await admin.people.studentCreate({ familyId: fam.id, fullName: `${k} ${surname}`, feePlanId: plan })).id);
  return { familyId: fam.id, studentIds: ids, feePlanId: plan };
}

/** WhatsApp on, unpaused. The onboarding message has no per-event switch — it is a button, not an event. */
async function waOn(opts: { paused?: boolean } = {}) {
  await caller('admin').whatsapp.set({ enabled: true, paused: opts.paused ?? false });
}

// ── Who it reaches ──────────────────────────────────────────────────────────
describe('who the message reaches', () => {
  /**
   * THE SIBLING RULE, at the level that actually decides it. The browser ticks siblings so an office can
   * see it; this is the collapse that makes it true, and the number that matters is 1, not 3.
   */
  it('collapses a household to ONE message however many of its children are picked', async () => {
    const h = await household('Ismail', ['Yusuf', 'Maryam', 'Bilal']);
    expect(audience.householdsFor(h.studentIds)).toEqual([h.familyId]);
    expect(audience.householdsFor([h.studentIds[0]])).toEqual([h.familyId]);
  });

  it('reaches the siblings’ household even when only one child was named', async () => {
    const h = await household('Ismail', ['Yusuf', 'Maryam']);
    const r = await caller('admin').people.onboardingPreview({ target: { kind: 'students', studentIds: [h.studentIds[0]] } });
    // One student asked for, one household — and the household is the unit that gets written to.
    expect(r.students).toBe(1);
    expect(r.households).toBe(1);
  });

  it('counts every household once across a mixed selection', async () => {
    const a = await household('Ismail', ['Yusuf', 'Maryam']);
    const b = await household('Farooqi', ['Aisha']);
    const r = await caller('admin').people.onboardingPreview({
      target: { kind: 'students', studentIds: [...a.studentIds, ...b.studentIds] },
    });
    expect(r.students).toBe(3);
    expect(r.households).toBe(2);
  });

  it('“everyone” means every household with an active child, and nobody else', async () => {
    await household('Ismail', ['Yusuf']);
    await household('Farooqi', ['Aisha']);
    const r = await caller('admin').people.onboardingPreview({ target: { kind: 'all' } });
    expect(r.households).toBe(2);
  });

  /** A withdrawn child's family is not a family to onboard, and the resolver is the one place that says
   *  so — shared with the billing bulk targets, which is why it cannot drift. */
  it('leaves out a withdrawn child, on every shape of target', async () => {
    const h = await household('Ismail', ['Yusuf']);
    await caller('admin').people.studentUpdate({ id: h.studentIds[0], status: 'withdrawn' });
    expect(audience.resolveAudience({ kind: 'all' })).toHaveLength(0);
    expect(audience.resolveAudience({ kind: 'students', studentIds: h.studentIds })).toHaveLength(0);
    expect((await caller('admin').people.onboardingPreview({ target: { kind: 'all' } })).households).toBe(0);
  });

  it('says how many households can be reached on each channel, and how many on neither', async () => {
    await household('Ismail', ['Yusuf']); // phone + email
    await household('Farooqi', ['Aisha'], { phone: null }); // email only
    await household('Sayed', ['Luqman'], { phone: null, email: null }); // neither
    const r = await caller('admin').people.onboardingPreview({ target: { kind: 'all' } });
    expect(r.households).toBe(3);
    expect(r.withPhone).toBe(1);
    expect(r.withEmail).toBe(2);
    // The two with no usable number. Reported rather than folded into the total: "sent to 3" when one of
    // them was never written to is a lie by omission.
    expect(r.unreachableByPhone).toBe(2);
  });
});

// ── What it says ────────────────────────────────────────────────────────────
describe('what the message says', () => {
  it('tells the family to get their sheet from the office', async () => {
    const body = onboarding.renderOnboarding('body', { family: 'Ismail family', children: ['Yusuf'] });
    expect(body.toLowerCase()).toContain('family sheet');
    expect(body.toLowerCase()).toContain('office');
  });

  /**
   * §14, and the reason the message points at the sheet instead of being helpful. A Student ID is the
   * whole credential on the payment path; the sheet carries it and is handed over in person.
   */
  it('never carries a Student ID, on either channel, even when one exists', async () => {
    await waOn();
    const h = await household('Ismail', ['Yusuf']);
    const code = app.dbmod.db.select({ c: students.studentCode }).from(students).where(eq(students.id, h.studentIds[0])).get()?.c;
    expect(code).toBeTruthy();
    calls = [];
    await caller('admin').people.onboardingSend({ target: { kind: 'all' } });
    for (const text of [...waText(), ...mailBodies()]) expect(text).not.toContain(code!);
    // And there is no tag that could put one there, which is the enforcement rather than the rule.
    expect(onboarding.ONBOARDING_TAGS as readonly string[]).not.toContain('code');
    expect(onboarding.ONBOARDING_TAGS as readonly string[]).not.toContain('studentCode');
  });

  it('fills in the school, the household and the children', () => {
    const school = settingsMod.getSchoolName();
    settingsMod.setOnboardingText({ body: 'For [family]: [children] at [school].' });
    expect(onboarding.renderOnboarding('body', { family: 'Ismail family', children: ['Yusuf', 'Maryam'] })).toBe(
      `For Ismail family: Yusuf and Maryam at ${school}.`,
    );
    // One child is a name, not a one-item list; none at all still has to read as a sentence rather than
    // leaving a hole where the names should be.
    expect(onboarding.renderOnboarding('body', { family: 'Ismail family', children: ['Yusuf'] })).toContain('Yusuf at');
    expect(onboarding.renderOnboarding('body', { family: 'Ismail family', children: [] })).toContain('your children at');
    settingsMod.setOnboardingText({ body: null });
  });

  /** The line that stops a cautious parent blocking an unknown number. WhatsApp only — in an email it
   *  would be describing a channel the reader is not on. */
  it('adds the which-number line on WhatsApp and NOT in the email', async () => {
    const vars = { family: 'Ismail family', children: ['Yusuf'] };
    const wa = onboarding.onboardingWhatsApp(vars);
    const email = onboarding.renderOnboarding('body', vars);
    expect(wa).toContain('come from this number');
    expect(email).not.toContain('come from this number');
    // The WhatsApp form is the body PLUS that line, not a different message.
    expect(wa.startsWith(email)).toBe(true);
  });

  it('is the madrasah’s own wording on both channels', async () => {
    await waOn();
    await household('Ismail', ['Yusuf']);
    settingsMod.setOnboardingText({ subject: 'Salam from [school]', body: 'Our own words for [family].', whatsappNote: 'Save this number.' });
    calls = [];
    await caller('admin').people.onboardingSend({ target: { kind: 'all' } });
    expect(waText()[0]).toBe('Our own words for Ismail family.\n\nSave this number.');
    expect(mailBodies()[0]).toContain('Our own words for Ismail family.');
    expect(String((emails()[0].body as { subject?: string }).subject)).toBe(`Salam from ${settingsMod.getSchoolName()}`);
    settingsMod.setOnboardingText({ subject: null, body: null, whatsappNote: null });
  });

  /** Clearing a box means "use the shipped sentence", never "send an empty message". */
  it('falls back to the shipped wording when a box is cleared', () => {
    settingsMod.setOnboardingText({ body: '   ' });
    expect(onboarding.renderOnboarding('body', { family: 'X', children: [] })).toContain('family sheet');
  });
});

// ── Sending ─────────────────────────────────────────────────────────────────
describe('sending it', () => {
  it('goes out on both channels, one message per household', async () => {
    await waOn();
    await household('Ismail', ['Yusuf', 'Maryam']);
    calls = [];
    const r = await caller('admin').people.onboardingSend({ target: { kind: 'all' } });
    expect(r.households).toBe(1);
    expect(r.messaged).toBe(1);
    expect(r.emailed).toBe(1);
    expect(sends()).toHaveLength(1);
    expect(emails()).toHaveLength(1);
  });

  /**
   * WRITES TO EVERY ADULT WITH A NUMBER, unlike the missing-email outreach which picks one. The
   * which-number notice is about the phone it arrives on, so a parent whose handset never got it still
   * has an unknown number texting them about their children.
   */
  it('messages both parents’ numbers, not just the first', async () => {
    await waOn();
    const h = await household('Ismail', ['Yusuf']);
    await caller('admin').people.guardianCreate({ familyId: h.familyId, name: 'Umm Yusuf', phone: '5559998888' });
    calls = [];
    await caller('admin').people.onboardingSend({ target: { kind: 'all' } });
    expect(sends()).toHaveLength(2);
    expect(sends().map((c) => c.body.to).sort()).toEqual(['+15551234567', '+15559998888']);
  });

  /** A person said no. No button in an admin screen outranks that (§9). */
  it('never messages a guardian who opted out — but still emails the household', async () => {
    await waOn();
    const h = await household('Ismail', ['Yusuf']);
    const g = app.dbmod.db.select({ id: guardians.id }).from(guardians).get()!;
    await caller('admin').people.guardianWhatsApp({ id: g.id, optOut: true });
    calls = [];
    const r = await caller('admin').people.onboardingSend({ target: { kind: 'all' } });
    expect(sends()).toHaveLength(0);
    expect(r.skipped.opted_out).toBe(1);
    expect(r.emailed).toBe(1);
  });

  /** The pause NARROWS to the test student's household rather than stopping — the only way to try a real
   *  message on one family without letting it reach the roster. */
  it('respects the WhatsApp pause, and lets the test student’s household through it', async () => {
    const keep = await household('Ismail', ['Yusuf']);
    await household('Farooqi', ['Aisha']);
    await caller('admin').whatsapp.set({ enabled: true, paused: true, testStudentId: keep.studentIds[0] });
    calls = [];
    const r = await caller('admin').people.onboardingSend({ target: { kind: 'all' } });
    expect(sends()).toHaveLength(1);
    expect(sends()[0].body.to).toBe('+15551234567');
    expect(r.skipped.paused).toBe(1);
  });

  it('records the send in the audit trail as counts, never as names or numbers', async () => {
    await waOn();
    await household('Ismail', ['Yusuf']);
    await caller('admin').people.onboardingSend({ target: { kind: 'all' } });
    const row = app.dbmod.db.select().from(auditLog).all().find((r) => r.action === 'people.onboardingSend');
    expect(row).toBeTruthy();
    const detail = JSON.stringify(row!.detail ?? {});
    expect(detail).toContain('households');
    expect(detail).not.toContain('Ismail');
    expect(detail).not.toContain('5551234567');
  });

  /** The log is an audit trail, not a copy of what was said — a tuition message names a child. */
  it('logs the send without the message body', async () => {
    await waOn();
    await household('Ismail', ['Yusuf']);
    await caller('admin').people.onboardingSend({ target: { kind: 'all' } });
    const rows = app.dbmod.db.select().from(whatsappLog).all();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.event === 'onboarding')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('family sheet');
  });

  it('is refused to finance — writing to every family speaks for the madrasah', async () => {
    await expect(caller('finance').people.onboardingSend({ target: { kind: 'all' } })).rejects.toThrow();
    await expect(caller('finance').people.onboardingPreview({ target: { kind: 'all' } })).rejects.toThrow();
  });
});

// ── The bound ───────────────────────────────────────────────────────────────
describe('the bound on one press', () => {
  /**
   * Bounded AND reported. Two hundred messages in one burst is how a masjid's number gets restricted; a
   * bound that hid the remainder would be the silent truncation this release removed everywhere else.
   */
  it('sends a batch and says how many households are still to go', async () => {
    await waOn();
    const admin = caller('admin');
    const plan = (await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' })).id;
    // One more than the batch, which is all it takes to prove the remainder is reported.
    const total = 51;
    for (let i = 0; i < total; i++) {
      const fam = await admin.people.familyCreate({ name: `House${i}` });
      await admin.people.guardianCreate({ familyId: fam.id, name: `Adult ${i}`, phone: '5551234567' });
      await admin.people.studentCreate({ familyId: fam.id, fullName: `Child ${i}`, feePlanId: plan });
    }
    const preview = await admin.people.onboardingPreview({ target: { kind: 'all' } });
    expect(preview.households).toBe(total);
    expect(preview.batchSize).toBeLessThan(total);

    const r = await admin.people.onboardingSend({ target: { kind: 'all' } });
    expect(r.households).toBe(preview.batchSize);
    expect(r.remaining).toBe(total - preview.batchSize);
  });
});

// ── The wording surface ─────────────────────────────────────────────────────
describe('the wording an office can change', () => {
  it('serves the registry, so the settings screen hard-codes no sentence', async () => {
    const r = await caller('admin').settings.onboardingTextGet();
    expect(r.keys).toEqual([...onboarding.ONBOARDING_KEYS]);
    expect(r.defaults).toEqual(onboarding.ONBOARDING_DEFAULTS);
    expect(r.overrides).toEqual({});
    expect(r.tags).toContain('children');
  });

  it('previews both channel forms, so the extra WhatsApp line is visible before it is sent', async () => {
    await household('Ismail', ['Yusuf']);
    const r = await caller('admin').settings.onboardingTextGet();
    expect(r.sample).toBe('household');
    expect(r.preview.whatsapp).toContain('come from this number');
    expect(r.preview.email).not.toContain('come from this number');
  });

  it('has an example household to preview against on an empty install', async () => {
    const r = await caller('admin').settings.onboardingTextGet();
    expect(r.sample).toBe('example');
    expect(r.preview.email).toBeTruthy();
  });

  it('saves a box, reports it as the madrasah’s, and reverts on reset', async () => {
    const admin = caller('admin');
    await admin.settings.onboardingTextSet({ boxes: [{ key: 'body', text: 'Mine.' }] });
    expect((await admin.settings.onboardingTextGet()).overrides).toEqual({ body: 'Mine.' });
    await admin.settings.onboardingTextSet({ reset: true });
    expect((await admin.settings.onboardingTextGet()).overrides).toEqual({});
  });

  it('refuses a key that is not in the registry', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately sending what a stale client might
    await expect(caller('admin').settings.onboardingTextSet({ boxes: [{ key: 'somethingElse' as any, text: 'x' }] })).rejects.toThrow();
  });

  it('is admin-only, like every other setting', async () => {
    await expect(caller('finance').settings.onboardingTextGet()).rejects.toThrow();
  });

  /**
   * …and every box has a LABEL on the settings screen. Same gap the alert catalog and the sheet registry
   * both had: Settings generates a field per key and i18next renders a MISSING key as the key itself, so
   * a new box silently puts "settings.onboarding_body" in front of an admin.
   */
  it('has a settings label for every box', () => {
    const en = JSON.parse(readFileSync(path.resolve(__dirname, '..', '..', 'web', 'src', 'lib', 'i18n', 'en.json'), 'utf8')) as {
      settings: Record<string, string>;
    };
    for (const key of onboarding.ONBOARDING_KEYS) {
      expect(en.settings[`onboarding_${key}`], `missing i18n key settings.onboarding_${key}`).toBeTruthy();
    }
  });
});
