// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Admin commands over WhatsApp — `POST /fabric/commands/run` (0.50.0-dev.15).
 *
 * Two things are being proved here, and the second is the one that matters more.
 *
 * THE GATE. This is a new route on the Fabric prefix, so it gets the same §11.1 treatment the billing
 * provider does — tunnel refused before anything else, our own secret constant-time compared — PLUS a
 * caller check the provider does not need: only `omos:platform` may run a command. Without that, any
 * other app holding a broker path to us could reach an admin-only handler, which is exactly why the
 * platform makes `commands` a reserved capability that cannot appear in `fabric.provides`.
 *
 * WHAT THE ANSWER MAY CONTAIN. The reply lands in a WhatsApp thread that keeps a copy forever, on
 * whichever phone is authorized today. So it is counts and totals and NEVER a list of who is behind —
 * the opposite of the alert emails, which name children now (§9) because an admin chose those
 * addresses one event at a time. That difference is the whole design and it is what these tests pin.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { freshApp, makeCtx } from './harness';
import { students, families, invoices, payments, paymentAllocations, invoiceItems, studentFees, feePlans, users, settings } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let http: FastifyInstance;
const SECRET = 'test-secret'; // freshApp({fabric:true}) sets OPENMASJID_APP_SECRET to this
const caller = (role: Role) => app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp({ fabric: true });
  const { registerFabricCommands } = await import('../src/fabric/commands'); // AFTER env is set
  http = Fastify();
  registerFabricCommands(http);
  await http.ready();
});

beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [paymentAllocations, payments, invoiceItems, invoices, studentFees, feePlans, students, families, settings]) db.delete(t).run();
  db.delete(users).run();
});

const run = (
  command: string,
  opts: { secret?: string | null; caller?: string | null; tunnel?: boolean; body?: unknown } = {},
) =>
  http.inject({
    method: 'POST',
    url: '/fabric/commands/run',
    headers: {
      'content-type': 'application/json',
      ...(opts.secret === null ? {} : { 'x-openmasjid-app-secret': opts.secret ?? SECRET }),
      ...(opts.caller === null ? {} : { 'x-openmasjid-caller-app': opts.caller ?? 'omos:platform' }),
      ...(opts.tunnel ? { 'cf-ray': 'test' } : {}),
    },
    payload: JSON.stringify(opts.body ?? { command, requestId: 'req_1', locale: 'en' }),
  });

/**
 * An admin ROW plus a child on a plan, optionally with an overdue bill and a payment.
 *
 * The user row is not decoration: `caller()` builds a context with a session in it, which is enough for
 * a tRPC procedure but says nothing about the database — and "has this install been set up?" is
 * answered by whether an admin account exists (`auth/firstRun.ts`). Without the row, every command
 * answers 503 and every assertion below would be testing the not-ready path by accident.
 */
async function seed(opts: { overdue?: boolean; paid?: number } = {}) {
  const ts = new Date();
  app.dbmod.db
    .insert(users)
    .values({ id: 'usr_admin', username: 'office', passwordHash: 'x', role: 'admin', status: 'active', mustChangePassword: false, createdAt: ts, updatedAt: ts })
    .run();
  const admin = caller('admin');
  const fam = await admin.people.familyCreate({ name: 'Ismail family' });
  const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 25000, cadence: 'monthly' });
  const s = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });
  if (opts.overdue) {
    await admin.billing.generateFamily({ familyId: fam.id, periodKey: '2026-01', label: 'Tuition — Jan 2026', dueDate: '2026-01-01' });
  }
  if (opts.paid) {
    await admin.billing.recordManualPayment({ studentId: s.id, amountCents: opts.paid, channel: 'cash', occurredAt: new Date().toISOString().slice(0, 10) });
  }
  return { familyId: fam.id, studentId: s.id };
}

/** Whether the install reads as set up — the thing `seed` establishes and the 503 test needs absent. */
function anAdminExists(): boolean {
  return !!app.dbmod.db.select({ id: users.id }).from(users).limit(1).get();
}

describe('the gate', () => {
  it('refuses a tunnel-origin call before it even looks at the secret', async () => {
    const res = await run('stats', { tunnel: true });
    expect(res.statusCode).toBe(404);
    // And with a perfectly good secret, because the origin is the point.
    expect((await run('stats', { tunnel: true, secret: SECRET })).statusCode).toBe(404);
  });

  it('401s a missing or wrong secret', async () => {
    expect((await run('stats', { secret: null })).statusCode).toBe(401);
    expect((await run('stats', { secret: 'wrong-but-same-length' })).statusCode).toBe(401);
  });

  /**
   * THE CHECK THE BILLING PROVIDER DOES NOT NEED. Our secret proves the platform sent this — but an app
   * that got hold of it, or a future broker path, must not be able to run an ADMIN command. The caller
   * header is the platform's own identity and cannot be forged as an app id, because the colon is
   * outside the charset app ids are validated against.
   */
  it('refuses anyone but the platform, even holding the right secret', async () => {
    expect((await run('stats', { caller: null })).statusCode).toBe(403);
    expect((await run('stats', { caller: 'donations' })).statusCode).toBe(403);
    expect((await run('stats', { caller: 'kiosk' })).statusCode).toBe(403);
    // Near-misses, since this is compared exactly and not merely searched for.
    expect((await run('stats', { caller: 'omos:platform ' })).statusCode).toBe(403);
    expect((await run('stats', { caller: 'omos:platformx' })).statusCode).toBe(403);
  });

  it('lets the platform through', async () => {
    await seed();
    expect((await run('stats')).statusCode).toBe(200);
  });
});

describe('what it answers', () => {
  it('says not_ready before the madrasah has been set up', async () => {
    expect(anAdminExists()).toBe(false);
    const res = await run('stats');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, code: 'not_ready' });
  });

  it('404s a command the manifest does not declare, in the documented shape', async () => {
    await seed();
    const res = await run('send-reminders');
    expect(res.statusCode).toBe(404);
    // `code` is what the platform reads to say "no such command" rather than "something went wrong".
    expect(res.json()).toMatchObject({ ok: false, code: 'unknown_command' });
  });

  it('400s a body that is not a command request', async () => {
    await seed();
    expect((await run('stats', { body: { nope: true } })).statusCode).toBe(400);
  });

  it('reports the money, the roster and who is behind — as counts', async () => {
    await seed({ overdue: true, paid: 5000 });
    const res = await run('stats');
    const text = String(res.json().text);
    expect(res.json().ok).toBe(true);
    expect(text).toContain('Outstanding: $200.00'); // $250 billed − $50 paid
    expect(text).toContain('In this month: $50.00 from 1 payment');
    expect(text).toContain('Past due: 1 student');
    expect(text).toContain('Students: 1 active in 1 household');
  });

  /**
   * THE INVARIANT. Alerts name children; a command reply must not. A chat keeps its copy forever and
   * the phone that holds it changes, so this is the one surface where the roster stays behind a login.
   */
  it('never names a child, however overdue they are', async () => {
    await seed({ overdue: true });
    const text = String((await run('stats')).json().text);
    expect(text).not.toContain('Yusuf');
    expect(text).not.toContain('Ismail');
    // …and says where the names are instead, so the answer is still useful.
    expect(text).toContain('Open the app');
  });

  it('says nobody is behind rather than printing a zero', async () => {
    await seed();
    const text = String((await run('stats')).json().text);
    expect(text).toContain('Past due: nobody');
    expect(text).not.toContain('Open the app');
  });

  it('stays inside the platform’s 1000-character cap', async () => {
    await seed({ overdue: true, paid: 5000 });
    expect(String((await run('stats')).json().text).length).toBeLessThanOrEqual(1000);
  });

  /** A reconciliation that has never run is the state that silently loses a kiosk payment, so it is
   *  worth a line — and it must not read as a date when there isn't one. */
  it('says when Stripe was last checked, or that it never was', async () => {
    await seed();
    expect(String((await run('stats')).json().text)).toContain('Checked with Stripe: not yet');
  });
});

describe('the arithmetic behind it', () => {
  /**
   * OWED AND CREDIT ARE SUMMED PER STUDENT, NEVER NETTED INSTALL-WIDE.
   *
   * The cheap way to total a madrasah's position is one pair of aggregate queries — everything invoiced
   * minus everything paid. That reports a school with one child $100 behind and another $100 ahead as
   * perfectly square, which is the one answer that is definitely wrong: somebody still has to chase the
   * first child, and the second child's credit is not available to pay for them.
   */
  it('does not let one child’s credit hide another child’s arrears', async () => {
    const ts = new Date();
    app.dbmod.db
      .insert(users)
      .values({ id: 'usr_admin', username: 'office', passwordHash: 'x', role: 'admin', status: 'active', mustChangePassword: false, createdAt: ts, updatedAt: ts })
      .run();
    const admin = caller('admin');
    const fam = await admin.people.familyCreate({ name: 'Ismail family' });
    const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 10000, cadence: 'monthly' });
    const behind = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });
    const ahead = await admin.people.studentCreate({ familyId: fam.id, fullName: 'Maryam Ismail', feePlanId: plan.id });
    await admin.billing.generateFamily({ familyId: fam.id, periodKey: '2026-01', label: 'Tuition — Jan 2026', dueDate: '2026-01-01' });
    // Maryam pays double; Yusuf pays nothing. Net across the install is zero — and that is not the answer.
    await admin.billing.recordManualPayment({ studentId: ahead.id, amountCents: 20000, channel: 'cash', occurredAt: '2026-01-05' });

    const { tuitionStats } = await import('../src/billing/stats');
    const s = tuitionStats('2026-02-01');
    expect(s.outstandingCents).toBe(10000);
    expect(s.creditCents).toBe(10000);
    // And the readout says both, rather than one figure that cancels itself.
    const { statsMessage } = await import('../src/fabric/commands');
    const text = statsMessage('2026-02-01');
    expect(text).toContain('Outstanding: $100.00');
    expect(text).toContain('Paid ahead: $100.00');
    expect(behind.id).toBeTruthy();
  });

  /** A reversal is a negative row dated when it was reversed, so a payment taken and reversed in the
   *  same month must net to nothing in "in this month" — not count twice, and not count once. */
  it('nets a reversal against the month it was reversed in', async () => {
    const { studentId } = await seed();
    const admin = caller('admin');
    const today = new Date().toISOString().slice(0, 10);
    const p = await admin.billing.recordManualPayment({ studentId, amountCents: 7500, channel: 'cash', occurredAt: today });
    const { tuitionStats } = await import('../src/billing/stats');
    expect(tuitionStats(today).collectedThisMonthCents).toBe(7500);
    await admin.billing.reversePayment({ paymentId: p.paymentId });
    expect(tuitionStats(today).collectedThisMonthCents).toBe(0);
  });

  /**
   * A MID-YEAR GO-LIVE IS NOT THIS MONTH'S TAKINGS.
   *
   * `billing/carryIn.ts` writes a dated `carry_in` payment for every child who arrives already paid
   * up, dated at the GO-LIVE day — which is this month for the office doing the setup. Counting those
   * would announce "$120.00 came in this month" on the day somebody recorded history that was settled
   * months ago, and it would be the first number this app ever showed them.
   */
  it('does not count a mid-year carry-in as money taken this month', async () => {
    const { studentId } = await seed();
    const today = new Date().toISOString().slice(0, 10);
    const { recordPayment } = await import('../src/billing/ledger');
    recordPayment(
      { studentId, amountCents: 12000, channel: 'carry_in', occurredAt: new Date(), memo: null, idempotencyKey: `carry:${studentId}` },
      { userId: null, role: 'admin', name: 'setup' },
    );
    const { tuitionStats } = await import('../src/billing/stats');
    const s = tuitionStats(today);
    expect(s.collectedThisMonthCents).toBe(0);
    expect(s.paymentsThisMonth).toBe(0);
    // …but it absolutely still counts against what the child owes.
    expect(s.creditCents).toBe(12000);
  });

  /** A withdrawn child's unpaid bill is still owed — scoping the totals to active students would write
   *  real debt off silently, which is the rule `familyStudentIds` already states for balances. */
  it('still counts what a withdrawn child owes', async () => {
    const { studentId } = await seed({ overdue: true });
    const { tuitionStats } = await import('../src/billing/stats');
    const before = tuitionStats('2026-02-01').outstandingCents;
    expect(before).toBe(25000);
    await caller('admin').people.studentUpdate({ id: studentId, status: 'withdrawn' });
    const after = tuitionStats('2026-02-01');
    expect(after.outstandingCents).toBe(25000);
    // …while the roster count does drop, because that one is about who is being taught.
    expect(after.activeStudents).toBe(0);
  });
});

describe('the manifest and the code agree', () => {
  /**
   * The same class of guard `alerts.test.ts` holds for alert ids: a command the code can run but the
   * manifest never declared is unreachable, and one the manifest declares that the code answers 404 to
   * is worse — an admin sees it on the menu and it fails when they pick it.
   */
  it('declares exactly the commands the handler implements', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const manifest = readFileSync(path.resolve(__dirname, '../../../manifest.yaml'), 'utf8');
    const ids = [...manifest.matchAll(/^ {2}- id: ([a-z0-9-]+)$/gm)].map((m) => m[1]);
    // `alerts:` uses the same two-space list shape, so narrow to the commands block.
    const block = manifest.slice(manifest.indexOf('\ncommands:'));
    const commandIds = [...block.matchAll(/^ {2}- id: ([a-z0-9-]+)$/gm)].map((m) => m[1]);
    expect(commandIds).toEqual(['stats']);
    expect(ids).toContain('stats');

    await seed();
    for (const id of commandIds) {
      const res = await run(id);
      expect(res.statusCode, `manifest declares "${id}" but the handler does not answer it`).toBe(200);
    }
  });

  /** Platform rule: `commands` is reserved and must never appear under `fabric.provides` — that would
   *  expose this admin handler to every other app through the broker. Refused by the catalog build, so
   *  getting it wrong fails in a different repo; cheaper to catch here. */
  it('does not offer `commands` as a fabric capability', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const manifest = readFileSync(path.resolve(__dirname, '../../../manifest.yaml'), 'utf8');
    const provides = manifest.slice(manifest.indexOf('\nfabric:'), manifest.indexOf('\ncommands:'));
    expect(provides).not.toMatch(/capability:\s*commands/);
  });
});
