// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * THE Fabric provider — capability `students/billing` (CLAUDE.md §11, the shared 4-repo contract).
 * Plain Fastify routes at POST /fabric/billing/<method>, called by the OS core (which proves it's
 * the platform by presenting THIS app's own secret). Every response carries `"v": 2`.
 *
 * CONTRACT v2 (0.39.0) — student ID only, no PIN. `lookup` used to take a child's name plus a
 * 6-digit PIN; both are gone. A consumer now sends the typed student ID and nothing else, because the
 * only thing that ID lets a stranger do is *pay someone else's tuition* — a secret buys no safety
 * worth the friction it costs a parent at a kiosk. What replaces it: `identify` echoes the name back
 * so the parent confirms the right child before any money or balance appears, and every code probe
 * shares one hard per-code lockout (`codeLookupLimiter`). Requests are still accepted with `v: 1` so
 * an un-upgraded consumer's record-payment/check/info keep working — only `lookup` changed shape.
 *
 * Security (§11.1, §14): constant-time secret compare, 401 FIRST; refuse tunnel-origin outright;
 * zod before logic; idempotency at the DB. Lookups give a UNIFORM `found:false` for every mismatch
 * flavor (no enumeration oracle) and never return full last names / DOB / contact. record-payment
 * flows through the ONE ledger write path. External payments fire a best-effort Fabric notification.
 */
import { timingSafeEqual } from 'node:crypto';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../db';
import { students, families, invoices, invoiceItems, payments } from '../db/schema';
import { config } from '../config';
import { classifyOrigin } from '../security/origin';
import { codeLookupLimiter } from '../security/rateLimit';
import { familyBalance, studentBalance, familyStudentIds, splitAcrossFamily, recordedSplit, invoiceTotal, invoicePaid, recordSplit, type SplitShare } from '../billing/ledger';
import { invoiceLines } from '../billing/lines';
import { formatMoney, MIN_PAYMENT_CENTS } from '../db/money';
import { getSchoolName, getCurrency, getExternalPaymentsEnabled } from '../settings';
import { audit } from '../audit';
import { alertStaff, householdName } from '../alerts';
import { sendReceipt } from '../mail/notify';
import { normalizeStudentCode } from '../billing/studentCodes';
import { givenName, lastInitial } from '../people/names';

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

/**
 * Count a failed student-ID probe, and raise an alert the moment that code locks.
 *
 * An ALERT rather than a notification because it can reach the admin's email, whereas the webhook is
 * off until someone configures one — and "somebody is sweeping student IDs" is the worst one to lose
 * silently. Now that the ID is the only credential, this alert is the sole way a masjid finds out.
 * The code itself is never in the text (§14).
 */
function failCode(code: string): void {
  const wasLocked = codeLookupLimiter.retryAfterMs(code) > 0;
  codeLookupLimiter.fail(code);
  if (!wasLocked && codeLookupLimiter.retryAfterMs(code) > 0) {
    void alertStaff('lookup-lockout', {
      title: 'A Student ID was locked',
      // The code itself is never in EITHER text (§14) — it is a payment credential.
      text: 'One student’s ID was locked for an hour after repeated failed lookups at the kiosk or on the donation site. If nobody is expecting that, someone may be guessing IDs.',
      publicText: 'A tuition student-ID lookup was locked after repeated failed attempts.',
    });
  }
}

/** The contract version every response carries. */
const CONTRACT_V = 2 as const;

/**
 * Turn an invoice-level allocation into the per-child split and the line-level instruction the ledger
 * honours — a best-effort HINT, never a reason to refuse money.
 *
 * The contract has taken `allocations: [{invoiceId, amountCents}]` since v1, and until 0.43.0 this app
 * parsed it and threw it away: a consumer asking for money to land on a particular bill got
 * oldest-due-first anyway, with nothing to say so. Filling that invoice's own lines in order is what
 * "pay this invoice" has always meant, so the intent is preserved exactly.
 *
 * WHY BEST-EFFORT. Stripe has already taken the card by the time this runs, and an invoice can easily
 * be smaller than the allocation names it — the office recorded a cash payment against it between the
 * consumer's `lookup` and its `record-payment`, or the consumer simply over-asked. Refusing the whole
 * call there would leave a captured charge unrecorded and a consumer outbox retrying into the same
 * deterministic 422 forever. So whatever the named lines cannot absorb becomes ordinary undirected money
 * on that same child, which the ledger allocates oldest-due-first and holds as credit if there is
 * nothing left to pay — exactly what the contract already promises for a surplus.
 *
 * Returns null when an invoice is not this family's (a real consumer bug, and a 422 is the right answer).
 */
/** One share per child, whatever shape the caller sent. `recordSplit` keys each row by child, so two
 *  entries for the same child must be added together before they reach it or the second looks like a
 *  replay of the first and is dropped. */
function mergeShares(shares: { studentId: string; amountCents: number }[]): SplitShare[] {
  const byStudent = new Map<string, SplitShare>();
  for (const s of shares) {
    const cur = byStudent.get(s.studentId) ?? { studentId: s.studentId, amountCents: 0 };
    cur.amountCents += s.amountCents;
    byStudent.set(s.studentId, cur);
  }
  return [...byStudent.values()];
}

function allocationShares(allocations: { invoiceId: string; amountCents: number }[], kidIds: Set<string>): SplitShare[] | null {
  const byStudent = new Map<string, SplitShare>();
  for (const a of allocations) {
    const inv = db.select({ studentId: invoices.studentId, status: invoices.status }).from(invoices).where(eq(invoices.id, a.invoiceId)).get();
    if (!inv || !kidIds.has(inv.studentId) || inv.status === 'void') return null;
    const share = byStudent.get(inv.studentId) ?? { studentId: inv.studentId, amountCents: 0, directed: [] };
    share.amountCents += a.amountCents;
    let left = a.amountCents;
    for (const l of invoiceLines(db, a.invoiceId)) {
      if (left <= 0) break;
      if (l.balanceCents <= 0) continue; // settled, or a credit line — nothing to point money at
      const take = Math.min(left, l.balanceCents);
      share.directed!.push({ itemId: l.itemId, amountCents: take });
      left -= take;
    }
    byStudent.set(inv.studentId, share);
  }
  return [...byStudent.values()];
}

/** Accepted REQUEST versions. v1 is still taken because `info`, `record-payment` and `check` are
 *  byte-identical between v1 and v2 — refusing them would break the money path of a Donations/Kiosk
 *  build that has not shipped its v2 update yet. `lookup` is the one method whose shape changed, and
 *  a v1-shaped lookup (name + pin) simply fails its own zod, whatever `v` it claims. */
const V = z.union([z.literal(1), z.literal(2)]);

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

  /**
   * info — what a consumer needs to render the tuition campaign shell.
   *
   * `allowAdvance` is the answer to "may a parent pay when nothing is due?" — and it is YES, always.
   * Tuition is not a donation appeal: parents pay a term up front, hand over cash at the start of
   * Ramadan, or clear the year in one go. This app has recorded that correctly since 0.40.0 (money
   * beyond the open invoices sits as that child's credit and the next invoice absorbs it), so a
   * consumer that greys out its amount field at a zero balance is refusing money the school wants.
   *
   * It is advertised rather than assumed because a consumer has no other way to know: `lookup`
   * returning `balanceCents: 0` looks exactly like "there is nothing to pay here". `minAmountCents`
   * is the floor a consumer should put on its amount input — matching the parent portal's own
   * minimum, and comfortably above what Stripe will refuse to charge.
   */
  app.post('/fabric/billing/info', async (req, reply) => {
    if (!gate(req, reply)) return;
    const parsed = z.object({ v: V }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid', message: 'Bad request.' } });
    return reply.send({
      v: CONTRACT_V,
      enabled: getExternalPaymentsEnabled(),
      schoolName: getSchoolName(),
      currency: getCurrency(),
      tagline: 'Pay tuition with your child’s Student ID',
      allowAdvance: true,
      minAmountCents: MIN_PAYMENT_CENTS,
    });
  });

  /**
   * identify — echo back WHO a typed student ID belongs to, so a consumer can ask "is this the right
   * child?" before showing a balance or taking money. That confirmation step IS the check that used to
   * be a PIN: a parent who mistypes an ID sees someone else's *first name* and stops, rather than
   * paying a stranger's tuition.
   *
   * Returns a first name + last initial and NOTHING ELSE — no balance, no invoices, no siblings, no
   * family id. Keeping the confirm step this thin is what makes it safe to answer before the parent
   * has confirmed anything; `lookup` is where a balance appears. Capped per code by
   * `codeLookupLimiter`, which is now the app's only defence on this surface.
   *
   * Also gated on the admin's external-payments toggle: with tuition payments switched off there is
   * no reason for this to answer at all.
   */
  app.post('/fabric/billing/identify', async (req, reply) => {
    if (!gate(req, reply)) return;
    const parsed = z.object({ v: V, studentCode: z.string().min(1).max(32) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid', message: 'Bad request.' } });
    if (!getExternalPaymentsEnabled()) return reply.send({ v: CONTRACT_V, found: false });

    const code = normalizeStudentCode(parsed.data.studentCode);
    if (codeLookupLimiter.retryAfterMs(code) > 0) return reply.send({ v: CONTRACT_V, found: false });

    const student = code
      ? db.select({ fullName: students.fullName, status: students.status, studentCode: students.studentCode }).from(students).where(eq(students.studentCode, code)).get()
      : undefined;
    if (!student || student.status !== 'active') {
      failCode(code);
      return reply.send({ v: CONTRACT_V, found: false });
    }
    codeLookupLimiter.succeed(code);
    return reply.send({
      v: CONTRACT_V,
      found: true,
      // Deliberately minimal, and deliberately NOT the family id — confirming a name must not become
      // a way to address a family. The student's name is one field internally; it is SPLIT here so the
      // response keeps giving out a given name and a single initial, never the family's surname (§14).
      student: { studentCode: student.studentCode, firstName: givenName(student.fullName), lastInitial: lastInitial(student.fullName) },
    });
  });

  /**
   * lookup — resolve a typed student ID to a balance (or a credit) + the siblings it can be paid
   * alongside.
   *
   * v2: the ID is the whole credential. There is no `name` and no `pin` any more — a consumer calls
   * `identify` first so the parent confirms the child by name, then calls this. Uniform `found:false`
   * on any mismatch, and the same per-code lockout as `identify` (they share one bucket, so sweeping
   * the ID space through whichever endpoint answers faster gains nothing).
   */
  app.post('/fabric/billing/lookup', async (req, reply) => {
    if (!gate(req, reply)) return;
    const parsed = z.object({ v: V, studentCode: z.string().min(1).max(32) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid', message: 'Bad request.' } });
    if (!getExternalPaymentsEnabled()) return reply.send({ v: CONTRACT_V, found: false });

    const code = normalizeStudentCode(parsed.data.studentCode);
    // Locked code → uniform not-found (no signal that the ID is otherwise real).
    if (codeLookupLimiter.retryAfterMs(code) > 0) return reply.send({ v: CONTRACT_V, found: false });

    const student = code
      ? db
          .select({ id: students.id, familyId: students.familyId, status: students.status })
          .from(students)
          .where(eq(students.studentCode, code))
          .get()
      : undefined;
    if (!student || student.status !== 'active') {
      failCode(code);
      return reply.send({ v: CONTRACT_V, found: false }); // identical shape, whatever mismatched
    }
    codeLookupLimiter.succeed(code);

    const fam = db.select({ id: families.id, name: families.name }).from(families).where(eq(families.id, student.familyId)).get();
    const kids = db.select({ id: students.id, studentCode: students.studentCode, fullName: students.fullName }).from(students).where(and(eq(students.familyId, student.familyId), eq(students.status, 'active'))).all();
    const currency = getCurrency();
    const kidIds = kids.map((k) => k.id);
    const famBal = familyBalance(student.familyId);
    // Every open invoice across the family, tagged with the child it belongs to — bills are per
    // student now, so a consumer showing "Tuition — Jul" three times needs to say whose is whose.
    const open = (
      kidIds.length
        ? db
            .select({ id: invoices.id, label: invoices.label, dueDate: invoices.dueDate, studentId: invoices.studentId })
            .from(invoices)
            .where(and(inArray(invoices.studentId, kidIds), inArray(invoices.status, ['open', 'partially_paid'])))
            .all()
        : []
    )
      .map((i) => ({
        id: i.id,
        studentId: i.studentId,
        label: i.label,
        dueDate: i.dueDate,
        balanceCents: invoiceTotal(db, i.id) - invoicePaid(db, i.id),
        /**
         * WHAT THE BILL IS MADE OF (0.43.0, additive) — one entry per line, so a consumer can list
         * "Monthly tuition $200" and "Book fee $50" instead of one $250 lump the parent has to accept
         * whole. `kind` is what makes them presentable separately, and `itemId` is what a parent's
         * choice is sent back as (see record-payment's `lines`).
         *
         * The arithmetic a consumer can rely on: these `balanceCents` add up to the invoice's own
         * `balanceCents`. A credit line (a bursary, a correction) reports 0 because its value is
         * already deducted from the lines above it — so summing what the parent ticked is always safe.
         *
         * EVERY line of the bill is listed, including any already settled (`balanceCents: 0`) — a
         * parent looking at a part-paid bill should see what is already dealt with. A consumer offering
         * things to pay should show only the lines with a balance.
         */
        items: invoiceLines(db, i.id).map((l) => ({ id: l.itemId, label: l.label, kind: l.kind, amountCents: l.amountCents, balanceCents: l.balanceCents })),
      }))
      .filter((i) => i.balanceCents > 0);

    const matched = studentBalance(student.id);
    return reply.send({
      v: CONTRACT_V,
      found: true,
      matchedStudent: { id: student.id, balanceCents: matched.owedCents, creditCents: matched.creditCents },
      family: {
        id: fam?.id ?? student.familyId,
        label: fam?.name ?? '',
        // NEVER full last names, DOB, or contact (§14) — first name + last initial only. `studentId`
        // is the internal id a consumer passes back to record-payment; `studentCode` is there so the
        // kiosk can show a sibling and pay for them WITHOUT the parent typing that child's ID.
        // `balanceCents` per child is new at v2: with one bill per child, "pay for Maryam" needs to
        // know what Maryam owes, not just the household total.
        students: kids.map((k) => {
          const b = studentBalance(k.id);
          return {
            studentId: k.id,
            studentCode: k.studentCode,
            firstName: givenName(k.fullName),
            lastInitial: lastInitial(k.fullName),
            balanceCents: b.owedCents,
            creditCents: b.creditCents,
          };
        }),
        balanceCents: famBal.owedCents,
        /**
         * Money paid beyond what has been billed — a term paid up front, a Ramadan lump sum.
         *
         * Sent alongside `balanceCents` because ONE number cannot carry both without lying: this app
         * derives a balance as invoiced − paid, so a family £150 ahead and a family exactly square
         * both come out as `balanceCents: 0`, and a kiosk showing only that tells a parent who has
         * already paid the year that they owe nothing — true, but not what they came to check.
         *
         * Both fields are non-negative and at most one is ever non-zero. There is no stored credit
         * table: it is derived like everything else, and the child's next invoice absorbs it.
         */
        creditCents: famBal.creditCents,
        currency,
        openInvoices: open,
      },
    });
  });

  /**
   * record-payment — record an external (donations-web | kiosk) payment. Idempotent via the ledger.
   *
   * v2: payments are per student, but one card charge often covers several children. So the caller may
   * send `students: [{studentId, amountCents}, …]` — the amounts a parent chose per child — and we
   * write one ledger row each, keyed `${idempotencyKey}:${studentId}`.
   *
   * A caller that sends no split still works: `splitAcrossFamily` walks the family's open invoices
   * oldest-due-first and derives one. That keeps a v1-shaped body (family + amount) correct rather
   * than merely accepted, which matters because this is the money path — see the `v: 1` note at the
   * top of the file. `paymentId` in the response is the FIRST row written, kept so a v1 consumer that
   * stores it still gets something meaningful; `payments[]` carries the full per-child truth.
   *
   * 0.43.0 — `lines`: the parent ticked specific things to pay ("just the book fee"). It supersedes
   * `students`, because the lines say whose bills they are, and it is HONOURED rather than merely
   * accepted: the choice is stored on the payment and re-applied every time allocation is recomputed,
   * so the line the parent chose still reads as settled on next month's statement.
   *
   * `allocations` (invoice-level, in the contract since v1) was parsed and then IGNORED before 0.43.0 —
   * every such payment was silently allocated oldest-due-first instead. It now works, normalised into
   * the same line mechanism by filling the invoice's own lines in order.
   */
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
        /** Per-child amounts, when the parent chose them. Must sum to `amountCents`. */
        students: z.array(z.object({ studentId: z.string().min(1).max(64), amountCents: z.number().int().min(1).max(100_000_000) })).max(50).optional(),
        /** The exact LINES the parent chose to pay (0.43.0). Must sum to `amountCents`; supersedes
         *  `students`, since a line already says which child's bill it is. */
        lines: z.array(z.object({ itemId: z.string().min(1).max(64), amountCents: z.number().int().min(1).max(100_000_000) })).max(200).optional(),
        allocations: z.array(z.object({ invoiceId: z.string().min(1).max(64), amountCents: z.number().int().min(1).max(100_000_000) })).max(100).optional(),
        payerNote: z.string().max(200).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid', message: 'Bad request.' } });
    const d = parsed.data;

    if (!db.select({ id: families.id }).from(families).where(eq(families.id, d.familyId)).get()) {
      return reply.code(404).send({ error: { code: 'family_not_found', message: 'Family not found.' } });
    }

    // Seen this charge before? Answer from what was recorded and write NOTHING. This has to come
    // before deriving a split, because `splitAcrossFamily` reads the very invoices the first call paid
    // down — re-deriving would produce a different split under new per-student keys and record the
    // money twice (§9: a replay is a no-op).
    const already = recordedSplit(d.idempotencyKey);
    if (already.length) {
      // A charge covering several children is written one row per child and NOT in one transaction, so a
      // crash (or a throw on the second child) can leave it half recorded. Presence alone cannot tell
      // that apart from a complete replay, and answering "recorded" to a short one loses a sibling's
      // money silently — the consumer settles its outbox and reconciliation skips the PI as seen. We
      // still answer as a replay, because re-deriving here is what would double-charge; but the masjid
      // is told, so it can be corrected by hand rather than discovered in a year-end total.
      const recordedCents = already.reduce((s, p) => s + p.amountCents, 0);
      if (recordedCents < d.amountCents) {
        void alertStaff('payment-short', {
          title: 'A payment was only partly recorded',
          text: `${householdName(d.familyId)} paid ${formatMoney(d.amountCents, getCurrency())} but only ${formatMoney(recordedCents, getCurrency())} reached the ledger. Check their record and enter the difference by hand.`,
          publicText: `A tuition payment of ${formatMoney(d.amountCents, getCurrency())} was only partly recorded (${formatMoney(recordedCents, getCurrency())}). Check the family's record and enter the difference by hand.`,
        });
      }
      return reply.send({
        v: CONTRACT_V,
        recorded: true,
        paymentId: already[0].paymentId,
        duplicate: true,
        payments: already.map((p) => ({ studentId: p.studentId, paymentId: p.paymentId, amountCents: p.amountCents, duplicate: true })),
      });
    }

    // An explicit split must belong to THIS family and add up — otherwise a consumer bug could park a
    // payment on another household's child, which no later correction would make obvious.
    let shares: SplitShare[];
    const kidIds = new Set(familyStudentIds(d.familyId));
    if (d.lines?.length) {
      // Lines carry their own child, so they define the split as well as the instruction. Anything that
      // does not resolve to a live bill of THIS family is a 422 rather than a silent reallocation —
      // "we ignored what you asked for" is the failure this replaced.
      const byStudent = new Map<string, SplitShare>();
      let total = 0;
      for (const l of d.lines) {
        const owner = db
          .select({ studentId: invoices.studentId, status: invoices.status, itemAmount: invoiceItems.amountCents })
          .from(invoiceItems)
          .innerJoin(invoices, eq(invoices.id, invoiceItems.invoiceId))
          .where(eq(invoiceItems.id, l.itemId))
          .get();
        if (!owner || !kidIds.has(owner.studentId) || owner.status === 'void' || l.amountCents > owner.itemAmount) {
          return reply.code(422).send({ error: { code: 'invalid_allocation', message: 'A line does not belong to an open bill of that family.' } });
        }
        const cur = byStudent.get(owner.studentId) ?? { studentId: owner.studentId, amountCents: 0, directed: [] };
        cur.amountCents += l.amountCents;
        cur.directed!.push({ itemId: l.itemId, amountCents: l.amountCents });
        byStudent.set(owner.studentId, cur);
        total += l.amountCents;
      }
      if (total !== d.amountCents) {
        return reply.code(422).send({ error: { code: 'invalid_allocation', message: 'The chosen lines must add up to amountCents.' } });
      }
      shares = [...byStudent.values()];
    } else if (d.allocations?.length) {
      const fromAllocations = allocationShares(d.allocations, kidIds);
      if (!fromAllocations) {
        return reply.code(422).send({ error: { code: 'invalid_allocation', message: 'An invoice does not belong to that family.' } });
      }
      if (fromAllocations.reduce((s, x) => s + x.amountCents, 0) !== d.amountCents) {
        return reply.code(422).send({ error: { code: 'invalid_allocation', message: 'The allocations must add up to amountCents.' } });
      }
      shares = fromAllocations;
    } else if (d.students?.length) {
      if (d.students.some((s) => !kidIds.has(s.studentId))) {
        return reply.code(422).send({ error: { code: 'invalid_allocation', message: 'A student does not belong to that family.' } });
      }
      if (d.students.reduce((s, x) => s + x.amountCents, 0) !== d.amountCents) {
        return reply.code(422).send({ error: { code: 'invalid_allocation', message: 'The per-student amounts must add up to amountCents.' } });
      }
      // Merged by child, NOT taken as given. A consumer that builds one entry per open invoice sends the
      // same studentId twice for a child with two bills; each row would then be keyed
      // `${idempotencyKey}:${studentId}` and the second would be swallowed as a replay of the first —
      // part of a real charge silently dropped while the response said it was recorded.
      shares = mergeShares(d.students);
    } else {
      shares = splitAcrossFamily(d.familyId, d.amountCents, d.studentId ?? null);
    }
    if (!shares.length) {
      return reply.code(422).send({ error: { code: 'invalid_allocation', message: 'That family has no student to record a payment against.' } });
    }

    const occurredAt = d.occurredAt ? new Date(d.occurredAt) : new Date();
    let res: ReturnType<typeof recordSplit>;
    try {
      res = recordSplit(
        {
          channel: d.channel,
          occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
          idempotencyKey: d.idempotencyKey,
          memo: d.payerNote ?? null,
          externalRef: d.externalRef ?? null,
        },
        shares,
        { userId: null, role: 'fabric', name: (Array.isArray(req.headers['x-openmasjid-caller-app']) ? req.headers['x-openmasjid-caller-app'][0] : req.headers['x-openmasjid-caller-app']) ?? d.channel },
      );
    } catch (e) {
      if ((e as Error).message === 'invalid_allocation') return reply.code(422).send({ error: { code: 'invalid_allocation', message: 'An allocation is invalid.' } });
      throw e;
    }
    if (!res.duplicate) {
      audit({ userId: null, role: 'fabric', name: d.channel }, 'payment.record', { entity: 'family', entityId: d.familyId, detail: { channel: d.channel, amountCents: d.amountCents, students: res.parts.length } });
      void alertStaff('payment-received', {
        title: 'Tuition payment received',
        text: `${householdName(d.familyId)} paid ${formatMoney(d.amountCents, getCurrency())} (${d.channel === 'kiosk' ? 'at the kiosk' : 'on the donation site'}).`,
        // Amount + channel only — never a family/student name (§14: no name+amount together).
        publicText: `A tuition payment of ${formatMoney(d.amountCents, getCurrency())} was received (${d.channel}).`,
      });
      // A receipt for money handed over at the kiosk or on the website, to the guardians on file —
      // the payer standing at the screen may not be the parent, and it is the parent who needs the
      // record. Gated on the office's parent-email switch inside sendReceipt.
      void sendReceipt(d.familyId, formatMoney(d.amountCents, getCurrency()));
    }
    return reply.send({
      v: CONTRACT_V,
      recorded: true,
      paymentId: res.parts[0]?.paymentId,
      duplicate: res.duplicate,
      payments: res.parts.map((p) => ({ studentId: p.studentId, paymentId: p.paymentId, amountCents: shares.find((s) => s.studentId === p.studentId)?.amountCents ?? 0, duplicate: p.duplicate })),
    });
  });

  /**
   * check — retry helper for consumer outboxes: has this idempotency key been recorded?
   *
   * A charge covering several children is stored as one row PER CHILD, keyed `${key}:${studentId}`, so
   * matching the bare key alone would answer "not recorded" for every split payment and send a
   * consumer's outbox into an endless retry — double-charging nobody, but never settling either. So
   * this matches the exact key OR any per-student suffix of it.
   */
  app.post('/fabric/billing/check', async (req, reply) => {
    if (!gate(req, reply)) return;
    const parsed = z.object({ v: V, idempotencyKey: z.string().min(1).max(128) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid', message: 'Bad request.' } });
    const key = parsed.data.idempotencyKey;
    // Prefix-matched with substr, NOT `LIKE key || ':%'`: `_` is a LIKE wildcard and Stripe ids are
    // full of them (`pi_3Pabc…`), so a LIKE pattern would need an ESCAPE clause to be correct at all.
    // An exact substr comparison has no pattern semantics to get wrong.
    const rows = db
      .select({ id: payments.id })
      .from(payments)
      .where(or(eq(payments.idempotencyKey, key), sql`substr(${payments.idempotencyKey}, 1, ${key.length + 1}) = ${`${key}:`}`))
      .all();
    if (!rows.length) return reply.send({ v: CONTRACT_V, recorded: false });
    return reply.send({ v: CONTRACT_V, recorded: true, paymentId: rows[0].id, paymentIds: rows.map((r) => r.id) });
  });
}
