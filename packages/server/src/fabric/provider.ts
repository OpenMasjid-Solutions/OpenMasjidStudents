// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * THE Fabric provider — capability `students/billing` (CLAUDE.md §11, the shared 4-repo contract).
 * Plain Fastify routes at POST /fabric/billing/<method>, called by the OS core (which proves it's
 * the platform by presenting THIS app's own secret). Every response carries `"v": 1`.
 *
 * Security (§11.1, §14): constant-time secret compare, 401 FIRST; refuse tunnel-origin outright;
 * zod before logic; idempotency at the DB. The name+PIN lookup gives a UNIFORM `found:false` for
 * every mismatch flavor (no enumeration oracle) and never returns full last names / DOB / contact,
 * and a per-PIN lockout compensates for the PIN's low entropy. record-payment flows through the ONE
 * ledger write path. External payments fire a best-effort Fabric notification.
 */
import { timingSafeEqual } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../db';
import { students, families, invoices, payments } from '../db/schema';
import { config } from '../config';
import { classifyOrigin } from '../security/origin';
import { pinLookupLimiter } from '../security/rateLimit';
import { nameMatches } from '../people/match';
import { familyBalance, invoiceTotal, invoicePaid, recordPayment } from '../billing/ledger';
import { formatMoney } from '../db/money';
import { getSchoolName, getCurrency, getExternalPaymentsEnabled } from '../settings';
import { audit } from '../audit';
import { notifyPlatform, raiseAlert } from './platform';

/** Constant-time check of the platform-proof header against our own secret. Disabled (always false)
 *  when no secret is configured — so a standalone install never accepts Fabric calls. */
function secretOk(provided: string | undefined): boolean {
  const secret = config.omosAppSecret;
  if (!secret || !provided) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const V = z.literal(1);

export function registerFabricProvider(app: FastifyInstance): void {
  // One guard for the whole prefix: refuse tunnel-origin, then require our secret (401 first).
  const gate = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (classifyOrigin(req) === 'tunnel') {
      reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } });
      return false;
    }
    const provided = req.headers['x-openmasjid-app-secret'];
    if (!secretOk(Array.isArray(provided) ? provided[0] : provided)) {
      reply.code(401).send({ error: { code: 'unauthorized', message: 'Invalid app secret.' } });
      return false;
    }
    return true;
  };

  // info — what a consumer needs to render the tuition campaign shell.
  app.post('/fabric/billing/info', async (req, reply) => {
    if (!gate(req, reply)) return;
    const parsed = z.object({ v: V }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid', message: 'Bad request.' } });
    return reply.send({ v: 1, enabled: getExternalPaymentsEnabled(), schoolName: getSchoolName(), currency: getCurrency(), tagline: 'Pay tuition with your child’s name and PIN' });
  });

  // lookup — resolve a student name + PIN to a family + balance. Uniform found:false on any mismatch.
  app.post('/fabric/billing/lookup', async (req, reply) => {
    if (!gate(req, reply)) return;
    const parsed = z.object({ v: V, name: z.string().min(1).max(200), pin: z.string().min(1).max(20) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid', message: 'Bad request.' } });
    const { name, pin } = parsed.data;

    // Locked PIN → uniform not-found (no signal that the PIN is otherwise valid).
    if (pinLookupLimiter.retryAfterMs(pin) > 0) return reply.send({ v: 1, found: false });

    const student = db.select({ id: students.id, firstName: students.firstName, lastName: students.lastName, familyId: students.familyId, status: students.status }).from(students).where(eq(students.pin, pin)).get();
    const ok = !!student && student.status === 'active' && nameMatches(name, student.firstName, student.lastName);
    if (!ok) {
      const wasLocked = pinLookupLimiter.retryAfterMs(pin) > 0;
      pinLookupLimiter.fail(pin);
      if (!wasLocked && pinLookupLimiter.retryAfterMs(pin) > 0) {
        // Just transitioned to locked — someone is hammering this PIN. An ALERT, not a notification:
        // it can reach the admin's email, whereas the webhook is off until someone configures one, and
        // a silently-dropped "somebody is guessing PINs" is the worst one to lose. Never the PIN (§14).
        void raiseAlert('pin-lockout', 'A tuition name + PIN lookup was locked after repeated failed attempts.', { title: 'Tuition lookup locked' });
      }
      return reply.send({ v: 1, found: false }); // identical shape + no timing oracle beyond a hash
    }
    pinLookupLimiter.succeed(pin);

    const fam = db.select({ id: families.id, name: families.name }).from(families).where(eq(families.id, student!.familyId)).get();
    const kids = db.select({ firstName: students.firstName, lastName: students.lastName }).from(students).where(and(eq(students.familyId, student!.familyId), eq(students.status, 'active'))).all();
    const currency = getCurrency();
    const bal = familyBalance(student!.familyId);
    const open = db
      .select({ id: invoices.id, label: invoices.label, dueDate: invoices.dueDate, status: invoices.status })
      .from(invoices)
      .where(and(eq(invoices.familyId, student!.familyId), inArray(invoices.status, ['open', 'partially_paid'])))
      .all()
      .map((i) => ({ id: i.id, label: i.label, dueDate: i.dueDate, balanceCents: invoiceTotal(db, i.id) - invoicePaid(db, i.id) }))
      .filter((i) => i.balanceCents > 0);

    return reply.send({
      v: 1,
      found: true,
      matchedStudent: { id: student!.id },
      family: {
        id: fam?.id ?? student!.familyId,
        label: fam?.name ?? '',
        // NEVER full last names, DOB, or contact (§14) — first name + last initial only.
        students: kids.map((k) => ({ firstName: k.firstName, lastInitial: (k.lastName || '').charAt(0) })),
        balanceCents: bal.owedCents,
        currency,
        openInvoices: open,
      },
    });
  });

  // record-payment — record an external (donations-web | kiosk) payment. Idempotent via the ledger.
  app.post('/fabric/billing/record-payment', async (req, reply) => {
    if (!gate(req, reply)) return;
    const parsed = z
      .object({
        v: V,
        idempotencyKey: z.string().min(1).max(128),
        familyId: z.string().min(1).max(64),
        studentId: z.string().min(1).max(64).optional(),
        amountCents: z.number().int().min(1).max(100_000_000),
        currency: z.string().max(10).optional(),
        channel: z.enum(['donations-web', 'kiosk']),
        occurredAt: z.string().max(40).optional(),
        externalRef: z.record(z.unknown()).optional(),
        allocations: z.array(z.object({ invoiceId: z.string().min(1).max(64), amountCents: z.number().int().min(1).max(100_000_000) })).max(100).optional(),
        payerNote: z.string().max(200).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid', message: 'Bad request.' } });
    const d = parsed.data;

    if (!db.select({ id: families.id }).from(families).where(eq(families.id, d.familyId)).get()) {
      return reply.code(404).send({ error: { code: 'family_not_found', message: 'Family not found.' } });
    }
    const occurredAt = d.occurredAt ? new Date(d.occurredAt) : new Date();
    let res: ReturnType<typeof recordPayment>;
    try {
      res = recordPayment(
        { familyId: d.familyId, amountCents: d.amountCents, channel: d.channel, occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt, idempotencyKey: d.idempotencyKey, memo: d.payerNote ?? null, externalRef: d.externalRef ?? null, allocations: d.allocations },
        { userId: null, role: 'fabric', name: (Array.isArray(req.headers['x-openmasjid-caller-app']) ? req.headers['x-openmasjid-caller-app'][0] : req.headers['x-openmasjid-caller-app']) ?? d.channel },
      );
    } catch (e) {
      if ((e as Error).message === 'invalid_allocation') return reply.code(422).send({ error: { code: 'invalid_allocation', message: 'An allocation is invalid.' } });
      throw e;
    }
    if (!res.duplicate) {
      audit({ userId: null, role: 'fabric', name: d.channel }, 'payment.record', { entity: 'family', entityId: d.familyId, detail: { channel: d.channel, amountCents: d.amountCents } });
      // Amount + channel only — never a family/student name (§14: no name+amount together).
      void notifyPlatform(`A tuition payment of ${formatMoney(d.amountCents, getCurrency())} was received (${d.channel}).`, { title: 'Tuition payment' });
    }
    return reply.send({ v: 1, recorded: true, paymentId: res.paymentId, duplicate: res.duplicate });
  });

  // check — retry helper for consumer outboxes: has this idempotency key been recorded?
  app.post('/fabric/billing/check', async (req, reply) => {
    if (!gate(req, reply)) return;
    const parsed = z.object({ v: V, idempotencyKey: z.string().min(1).max(128) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid', message: 'Bad request.' } });
    const p = db.select({ id: payments.id }).from(payments).where(eq(payments.idempotencyKey, parsed.data.idempotencyKey)).get();
    return reply.send(p ? { v: 1, recorded: true, paymentId: p.id } : { v: 1, recorded: false });
  });
}
