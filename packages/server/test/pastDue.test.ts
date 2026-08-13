// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Chasing an overdue balance (0.48.0).
 *
 * Four things are worth testing, and the wording of the email is not one of them:
 *
 *  1. WHO IS ACTUALLY OVERDUE. "Past due" is a bill whose due date has passed and still has money on it
 *     — not the household's whole balance, which would include next month's invoice the day it is
 *     generated and tell a family they were behind when they were not. An undated bill is never overdue,
 *     because nobody ever told them a date.
 *  2. IT IS NOT A NUISANCE. A daily job that emails every overdue family every day is what gets a
 *     madrasah's mail marked as spam — taking the invites and the receipts with it. So: a grace period,
 *     a per-household cadence, and a cooldown that starts only when somebody was ACTUALLY written to.
 *  3. IT CANNOT SURPRISE ANYONE. Parent reminders are off until an office turns them on, and the master
 *     parent-mail pause still overrides everything.
 *  4. THE OFFICE'S DIGEST OBEYS §14. Its email may name households, because an admin typed those
 *     addresses; the copy that goes to the webhook and the platform channel may not.
 *
 * Asserted at the TRANSPORT — the one `fetch` to the platform's email endpoint — like
 * parentMailPause.test.ts. If an address reaches that call, a real parent got mail.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { freshApp } from './harness';
import {
  alertRecipients, families, guardians, guardianFamilies, invoiceItems, invoices,
  pastDueReminders, paymentAllocations, payments, settings as settingsTable, students,
} from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let pastDue: typeof import('../src/billing/pastDue');
let settings: typeof import('../src/settings');

/** Every message the app actually tried to send: who, and what was in it. */
let sent: { to: string; subject: string; text: string }[] = [];
/** Every de-identified alert pushed at the platform channel + the masjid webhook. */
let publicPushes: string[] = [];
const realFetch = globalThis.fetch;

const TS = new Date('2026-01-01T00:00:00Z');

beforeAll(async () => {
  app = await freshApp({ fabric: true, publicUrl: 'https://masjid.test/students' });
  pastDue = await import('../src/billing/pastDue');
  settings = await import('../src/settings');
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, invoiceItems, invoices, pastDueReminders, guardianFamilies, guardians, students, families, alertRecipients, settingsTable]) {
    db.delete(t).run();
  }
  sent = [];
  publicPushes = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: unknown) => {
    const url = String(input);
    const body = ((init ?? {}) as { body?: string }).body;
    if (url.endsWith('/api/fabric/email') && body) {
      const b = JSON.parse(body) as { to: string; subject: string; text: string };
      sent.push({ to: b.to, subject: b.subject, text: b.text });
    }
    if ((url.endsWith('/api/fabric/alert') || url.endsWith('/api/fabric/notify')) && body) publicPushes.push(body);
    const json = url.endsWith('/api/fabric/site')
      ? { enabled: true, domain: 'masjid.test', publicUrl: 'https://masjid.test/students', basePath: '/students' }
      : { sent: true };
    return { ok: true, status: 200, json: async () => json } as unknown as Response;
  }) as unknown as typeof fetch;
});

/** A household with one child, one guardian, and an optional email address. */
function household(id: string, label: string, email: string | null = 'parent@example.org') {
  const { db } = app.dbmod;
  db.insert(families).values({ id, name: label, status: 'active', createdAt: TS, updatedAt: TS }).run();
  db.insert(students).values({ id: `stu_${id}`, familyId: id, fullName: `${label} child`, status: 'active', studentCode: null, createdAt: TS, updatedAt: TS }).run();
  db.insert(guardians).values({ id: `grd_${id}`, name: `Parent of ${label}`, email, phone: '5550100', createdAt: TS, updatedAt: TS }).run();
  db.insert(guardianFamilies).values({ guardianId: `grd_${id}`, familyId: id, relation: 'father', isEmergencyContact: false, createdAt: TS }).run();
  return `stu_${id}`;
}

/** An invoice for a child, optionally dated and optionally part-paid. One per (student, period), which
 *  the schema enforces — so each bill gets its own month rather than a shared constant. */
let periodSeq = 0;
function bill(id: string, studentId: string, amountCents: number, dueDate: string | null, paidCents = 0) {
  const { db } = app.dbmod;
  const periodKey = `2026-${String((periodSeq++ % 12) + 1).padStart(2, '0')}`;
  db.insert(invoices).values({ id, studentId, label: `Tuition ${id}`, periodKey, dueDate, status: paidCents > 0 ? 'partially_paid' : 'open', createdAt: TS, updatedAt: TS }).run();
  db.insert(invoiceItems).values({ id: `iti_${id}`, invoiceId: id, description: 'Monthly tuition', amountCents, studentId, createdAt: TS }).run();
  if (paidCents > 0) {
    db.insert(payments).values({ id: `pay_${id}`, studentId, amountCents: paidCents, channel: 'cash', occurredAt: TS, idempotencyKey: `k_${id}`, createdAt: TS }).run();
    db.insert(paymentAllocations).values({ id: `alc_${id}`, paymentId: `pay_${id}`, invoiceId: id, amountCents: paidCents, createdAt: TS }).run();
  }
}

describe('who is past due', () => {
  it('counts what is left on a bill whose due date has passed — not the whole balance', async () => {
    const stu = household('fam_1', 'Ismail family');
    bill('inv_late', stu, 20000, '2026-03-01', 5000); // $150 still owing, overdue
    bill('inv_soon', stu, 30000, '2026-04-15'); // not due yet — must not be counted

    const [fam] = pastDue.pastDueFamilies('2026-04-01');
    expect(fam.amountCents).toBe(15000);
    expect(fam.oldestDue).toBe('2026-03-01');
    expect(fam.invoices.map((i) => i.id)).toEqual(['inv_late']);
    expect(fam.daysOverdue).toBe(31);
  });

  it('never chases a bill with no due date, or one due today', async () => {
    const stu = household('fam_1', 'Ismail family');
    bill('inv_undated', stu, 20000, null); // nobody was ever told a date
    bill('inv_today', stu, 20000, '2026-04-01');
    expect(pastDue.pastDueFamilies('2026-04-01')).toEqual([]);
  });

  it('drops a bill once it is settled, whatever its status row says', async () => {
    const stu = household('fam_1', 'Ismail family');
    // Fully paid but left `partially_paid` — the balance is derived (§9), so the status must not decide.
    bill('inv_1', stu, 20000, '2026-03-01', 20000);
    expect(pastDue.pastDueFamilies('2026-04-01')).toEqual([]);
  });

  it('groups by household and puts the biggest first', async () => {
    const a = household('fam_a', 'Ahmed family');
    const b = household('fam_b', 'Bilal family');
    bill('inv_a', a, 10000, '2026-03-01');
    bill('inv_b', b, 50000, '2026-03-20');
    expect(pastDue.pastDueFamilies('2026-04-01').map((f) => f.label)).toEqual(['Bilal family', 'Ahmed family']);
  });
});

describe('reminding parents', () => {
  beforeEach(() => {
    settings.setPastDue({ parentEmails: true, graceDays: 3, everyDays: 7, minAmountCents: 100 });
  });

  it('says nothing at all until an office turns it on', async () => {
    settings.setPastDue({ parentEmails: false });
    const stu = household('fam_1', 'Ismail family');
    bill('inv_1', stu, 20000, '2026-03-01');
    const r = await pastDue.runPastDue('2026-04-01');
    expect(r.overdue).toBe(1);
    expect(r.emailed).toBe(0);
    expect(sent.filter((m) => m.to === 'parent@example.org')).toEqual([]);
  });

  it('is off by default on a fresh install', () => {
    const { db } = app.dbmod;
    db.delete(settingsTable).run();
    expect(settings.getPastDue().parentEmails).toBe(false);
  });

  it('waits out the grace period — a bill due yesterday is not chased today', async () => {
    const stu = household('fam_1', 'Ismail family');
    bill('inv_1', stu, 20000, '2026-03-31');
    expect((await pastDue.runPastDue('2026-04-01')).emailed).toBe(0);
    // Day 3 after the due date is the first day it is said out loud.
    expect((await pastDue.runPastDue('2026-04-03')).emailed).toBe(1);
  });

  it('reminds once, then holds its tongue until the cadence is up', async () => {
    const stu = household('fam_1', 'Ismail family');
    bill('inv_1', stu, 20000, '2026-03-01');

    expect((await pastDue.runPastDue('2026-04-01')).emailed).toBe(1);
    expect(sent.some((m) => m.to === 'parent@example.org')).toBe(true);

    // The next six daily ticks must produce nothing. This is the whole reason the table exists: a
    // reminder a day is not a reminder, it is what gets a school's mail filtered into spam.
    for (const day of ['2026-04-02', '2026-04-03', '2026-04-04', '2026-04-05', '2026-04-06', '2026-04-07']) {
      const r = await pastDue.runPastDue(day);
      expect(r.emailed).toBe(0);
      expect(r.waiting).toBe(1);
    }
    expect((await pastDue.runPastDue('2026-04-08')).emailed).toBe(1);
  });

  it('does not start a cooldown on a family it could not reach', async () => {
    // No address on file. The run must not record a "last sent" — otherwise the day the office finally
    // adds an email, that family waits another week for no reason anybody could see.
    const stu = household('fam_1', 'Ismail family', null);
    bill('inv_1', stu, 20000, '2026-03-01');
    const r = await pastDue.runPastDue('2026-04-01');
    expect(r.unreachable).toBe(1);
    expect(r.emailed).toBe(0);
    expect(app.dbmod.db.select().from(pastDueReminders).all()).toEqual([]);

    // Add the address; the very next run reaches them.
    app.dbmod.db.update(guardians).set({ email: 'late@example.org' }).run();
    expect((await pastDue.runPastDue('2026-04-02')).emailed).toBe(1);
  });

  it('stops entirely while parent mail is paused', async () => {
    const stu = household('fam_1', 'Ismail family');
    bill('inv_1', stu, 20000, '2026-03-01');
    settings.setParentMailPaused(true);
    const r = await pastDue.runPastDue('2026-04-01');
    expect(r.emailed).toBe(0);
    expect(sent.filter((m) => m.to === 'parent@example.org')).toEqual([]);
    settings.setParentMailPaused(false);
  });

  it('ignores a trivial amount', async () => {
    const stu = household('fam_1', 'Ismail family');
    bill('inv_1', stu, 40, '2026-03-01'); // 40¢ of rounding is not worth an email
    expect((await pastDue.runPastDue('2026-04-01')).emailed).toBe(0);
  });

  it('reads as a reminder, and names no child', async () => {
    const stu = household('fam_1', 'Ismail family');
    bill('inv_1', stu, 20000, '2026-03-01');
    await pastDue.runPastDue('2026-04-01');
    const m = sent.find((x) => x.to === 'parent@example.org')!;
    expect(m.subject).toContain('reminder');
    expect(m.text).toContain('$200.00');
    expect(m.text).toContain('speak to the office');
    // One adult pays for the household, so the message is the household's — and a Student ID is a
    // payment credential that never goes in an email (§14).
    expect(m.text).not.toContain('Ismail family child');
  });
});

describe('telling the office', () => {
  beforeEach(() => {
    const { db } = app.dbmod;
    db.insert(alertRecipients)
      .values({ id: 'alr_1', email: 'office@masjid.test', label: 'Office', events: ['past-due'], createdAt: TS, updatedAt: TS })
      .run();
  });

  it('names the households and the amounts — that is what makes it actionable', async () => {
    const a = household('fam_a', 'Ahmed family');
    bill('inv_a', a, 25000, '2026-03-01');
    await pastDue.runPastDue('2026-04-01');
    const digest = sent.find((m) => m.to === 'office@masjid.test')!;
    expect(digest.subject).toContain('past due');
    expect(digest.text).toContain('Ahmed family');
    expect(digest.text).toContain('$250.00');
  });

  it('tells the office even when parent reminders are off — and says so', async () => {
    settings.setPastDue({ parentEmails: false });
    const a = household('fam_a', 'Ahmed family');
    bill('inv_a', a, 25000, '2026-03-01');
    await pastDue.runPastDue('2026-04-01');
    expect(sent.find((m) => m.to === 'office@masjid.test')!.text).toContain('Parent reminders are switched off');
  });

  it('puts NO household name on the webhook or the platform channel (§14)', async () => {
    const a = household('fam_a', 'Ahmed family');
    bill('inv_a', a, 25000, '2026-03-01');
    await pastDue.runPastDue('2026-04-01');
    // Something was pushed — otherwise this assertion is vacuous.
    expect(publicPushes.length).toBeGreaterThan(0);
    for (const body of publicPushes) {
      expect(body).not.toContain('Ahmed family');
      expect(body).toContain('past due');
    }
  });

  it('digests on its own cadence, and says nothing when nobody is behind', async () => {
    const a = household('fam_a', 'Ahmed family');
    bill('inv_a', a, 25000, '2026-03-01');
    expect((await pastDue.runPastDue('2026-04-01')).staffAlerted).toBe(true);
    expect((await pastDue.runPastDue('2026-04-02')).staffAlerted).toBe(false);
    expect((await pastDue.runPastDue('2026-04-08')).staffAlerted).toBe(true);

    // Everything paid off: an empty "0 families are behind" every week is how a recipient learns to
    // ignore the channel.
    app.dbmod.db.delete(invoices).run();
    sent = [];
    expect((await pastDue.runPastDue('2026-04-20')).staffAlerted).toBe(false);
    expect(sent).toEqual([]);
  });

  it('"Run now" overrides the cadence, because a person pressed it', async () => {
    settings.setPastDue({ parentEmails: true });
    const a = household('fam_a', 'Ahmed family');
    bill('inv_a', a, 25000, '2026-03-01');
    expect((await pastDue.runPastDue('2026-04-01')).emailed).toBe(1);
    expect((await pastDue.runPastDue('2026-04-02')).emailed).toBe(0);
    const forced = await pastDue.runPastDue('2026-04-02', { force: true });
    expect(forced.emailed).toBe(1);
    expect(forced.staffAlerted).toBe(true);
  });
});

describe('the settings themselves', () => {
  it('refuses a cadence of zero — that is a daily email about money', () => {
    settings.setPastDue({ everyDays: 0 });
    expect(settings.getPastDue().everyDays).toBeGreaterThanOrEqual(1);
  });

  it('falls back rather than trusting a hand-edited row', () => {
    settings.setSetting(settings.SETTING_KEYS.pastDue, '{"graceDays":"lots","everyDays":-4}');
    const cfg = settings.getPastDue();
    expect(cfg.graceDays).toBe(3);
    expect(cfg.everyDays).toBe(7);
    expect(cfg.parentEmails).toBe(false);
  });
});
