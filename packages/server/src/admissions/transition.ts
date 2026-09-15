// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * THE ONE PLACE AN INQUIRY'S STATE CHANGES (0.52.0, CLAUDE.md §16, §4a Phase 2).
 *
 * docs/ADMISSIONS.md §3. Everything the office does to an inquiry — start reviewing it, waitlist it,
 * offer a place, decline, record that the family dropped out — is this function. Conversion is the
 * one caller that does something more (`admissions/convert.ts`), and it still ends here.
 *
 * ── Why a module for what looks like an UPDATE ──────────────────────────────
 *
 * Three rules have to hold together on every move, and each is the kind that gets forgotten at the
 * second call site rather than the first:
 *
 * 1. **The state is stored truth, never derived** (§9). It is what a transition SET it to, recorded
 *    with who, when and why — never an inference from whether a student row happens to exist.
 *    Deriving it is exactly how a half-failed conversion reads back as a success.
 * 2. **Two rows are written, and one function writes both.** The `audit_log` row because §14 requires
 *    it, and the `inquiry_events` row because the admissions screen has to SHOW the trail and nothing
 *    in this app reads the audit log (§5). That duplication is recorded rather than glossed in §9;
 *    what makes it safe is that they are written together and cannot disagree.
 * 3. **The waitlist closes its gaps.** A place is offered from the waitlist by the same transition as
 *    from review, so leaving `waitlisted` renumbers everybody below in the same transaction. A list
 *    with a hole at position 3 is a list an office stops trusting.
 *
 * ── `admitted` IS NOT AN OFFICE TRANSITION, AND THAT IS ENFORCED BY THE TYPES ──
 *
 * `transitionInquiry` cannot reach `admitted`: its parameter type excludes it. A student existing is
 * what `admitted` MEANS, so the only way in is `markAdmitted`, which `admissions/convert.ts` calls
 * inside the transaction that created the child. Without that split, "mark it admitted" is one
 * plausible-looking mutation away from an inquiry that claims a student who was never created.
 */
import { and, eq, gt, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db';
import { rid } from '../db/ids';
import { inquiries, inquiryEvents, type Inquiry, type InquiryState } from '../db/schema';
import { audit, type AuditActor } from '../audit';

/** A drizzle transaction or the database itself — every writer here takes one so a caller can fold
 *  this into a larger transaction (conversion does). */
type Tx = Pick<typeof db, 'select' | 'insert' | 'update'>;

/**
 * What the office may move an inquiry to. `admitted` is deliberately absent — see the header.
 */
export type OfficeTransition = Exclude<InquiryState, 'admitted'>;

/**
 * THE PIPELINE, as data rather than as a chain of `if`s.
 *
 *   new → reviewing → { waitlisted, offered, declined }
 *                      waitlisted → offered
 *                      offered    → admitted (conversion) | withdrawn
 *
 * `declined` is TERMINAL and the row is retained — an office asked "did we ever hear from them?"
 * needs an answer, and deleting the record is how that question stops having one.
 *
 * `withdrawn` is not terminal, and that is one deliberate liberty: a family who dropped out and came
 * back is ordinary, and the alternative is a second record for the same conversation. Going back from
 * `offered` to `waitlisted` is likewise allowed, because an offer is sometimes retracted and the
 * honest record of that is the place they went back to.
 *
 * **`admitted` IS REACHABLE FROM EVERY LIVE STATE, AND THAT IS A DEVIATION FROM THE DIAGRAM IN
 * docs/ADMISSIONS.md §3, MADE ON PURPOSE.** The drawing has one arrow into it, from `offered`. A
 * family who walks into the office and is admitted the same morning would then need four actions for
 * one conversation — type the inquiry, start reviewing, offer a place, admit — and the middle two
 * would be recording an offer nobody made. Friction like that is how a pipeline stops being used and
 * the office goes back to a notebook.
 *
 * Nothing is weakened by it: `admitted` still means a student EXISTS, and the only way to apply it is
 * still `markAdmitted` from inside `admissions/convert.ts`'s transaction. The trail records the move
 * that actually happened — `new → admitted` for a walk-in — rather than a tidier one that did not.
 */
export const NEXT_STATES: Record<InquiryState, readonly InquiryState[]> = {
  new: ['reviewing', 'waitlisted', 'offered', 'admitted', 'declined', 'withdrawn'],
  reviewing: ['waitlisted', 'offered', 'admitted', 'declined', 'withdrawn'],
  waitlisted: ['reviewing', 'offered', 'admitted', 'declined', 'withdrawn'],
  offered: ['waitlisted', 'admitted', 'declined', 'withdrawn'],
  declined: [],
  admitted: [],
  withdrawn: ['reviewing'],
};

export function canTransition(from: InquiryState, to: InquiryState): boolean {
  return NEXT_STATES[from].includes(to);
}

export class TransitionRefused extends Error {
  constructor(
    readonly from: InquiryState,
    readonly to: InquiryState,
  ) {
    super(`an inquiry cannot go from ${from} to ${to}`);
    this.name = 'TransitionRefused';
  }
}

export interface TransitionOpts {
  inquiryId: string;
  to: OfficeTransition;
  /** The office's own words, shown on the screen beside the move. Escaped at render like everything
   *  else that came from a keyboard. */
  reason?: string | null;
  actor: AuditActor;
  /** Only read when `to` is `waitlisted`. */
  waitlistReason?: string | null;
  at?: Date;
  tx?: Tx;
}

/** The next free waitlist position — 1-based, and the end of the queue. */
function nextWaitlistPosition(tx: Tx): number {
  const top = tx
    .select({ max: sql<number | null>`max(${inquiries.waitlistPosition})` })
    .from(inquiries)
    .where(eq(inquiries.state, 'waitlisted'))
    .get();
  return (top?.max ?? 0) + 1;
}

/**
 * Close the hole left by a row leaving the waitlist.
 *
 * Everybody below moves up one. Done in the same transaction as the move itself, so there is no
 * moment where two families share position 4 or where position 3 belongs to nobody.
 */
function closeWaitlistGap(tx: Tx, vacated: number, at: Date): void {
  tx.update(inquiries)
    .set({ waitlistPosition: sql`${inquiries.waitlistPosition} - 1`, updatedAt: at })
    .where(and(eq(inquiries.state, 'waitlisted'), isNotNull(inquiries.waitlistPosition), gt(inquiries.waitlistPosition, vacated)))
    .run();
}

/**
 * Write the state, the trail row and the audit row — the three things that must not come apart.
 *
 * Private on purpose: everything goes through `transitionInquiry` or `markAdmitted`, which is what
 * keeps `admitted` unreachable by accident.
 */
function writeTransition(
  tx: Tx,
  row: Inquiry,
  to: InquiryState,
  opts: { reason?: string | null; actor: AuditActor; at: Date; patch?: Partial<typeof inquiries.$inferInsert> },
): Inquiry {
  const { reason, actor, at } = opts;

  // The waitlist bookkeeping, before the row moves: leaving takes its position with it and closes the
  // gap; arriving takes the next one. A move from waitlisted to waitlisted is not a move.
  const patch: Partial<typeof inquiries.$inferInsert> = { state: to, updatedAt: at, ...(opts.patch ?? {}) };
  if (row.state === 'waitlisted' && to !== 'waitlisted') {
    if (row.waitlistPosition != null) closeWaitlistGap(tx, row.waitlistPosition, at);
    patch.waitlistPosition = null;
  }
  if (to === 'waitlisted' && row.state !== 'waitlisted') patch.waitlistPosition = nextWaitlistPosition(tx);

  tx.update(inquiries).set(patch).where(eq(inquiries.id, row.id)).run();

  tx.insert(inquiryEvents)
    .values({
      id: rid('iev'),
      inquiryId: row.id,
      fromState: row.state,
      toState: to,
      reason: reason?.trim() || null,
      actorUserId: actor.userId ?? null,
      actorName: actor.name ?? null,
      createdAt: at,
    })
    .run();

  // The forensic half. `reason` is the office's own prose about a family and stays OUT of it — the
  // trail records that a move happened and who made it; the words live on the row the office reads
  // (§14: ids, names of actions and counts, never the content).
  audit(actor, 'inquiry.transition', { entity: 'inquiry', entityId: row.id, detail: { from: row.state, to } });

  return { ...row, ...(patch as Partial<Inquiry>), state: to, updatedAt: at } as Inquiry;
}

export function inquiryById(id: string, tx: Tx = db): Inquiry | undefined {
  return tx.select().from(inquiries).where(eq(inquiries.id, id)).get();
}

/**
 * The first row of the trail: this inquiry arrived.
 *
 * Not a transition — there was no state before it, which is why `from_state` is nullable — but it
 * belongs to the same writer, because "every change of state is one row in `inquiry_events` and one
 * in `audit_log`" is only true if arriving counts as one too. A screen showing a trail that starts at
 * "moved to reviewing" is a screen that cannot tell you when the family first wrote.
 *
 * The audit row carries the SOURCE and nothing else. Everything on a public submission was typed by a
 * stranger, so none of it reaches the trail, a log line, or an alert's public text (§14) — and the
 * body being attacker-controlled means recording it would also make the audit log a place to inject.
 */
export function recordArrival(tx: Tx, inquiryId: string, source: 'public' | 'office', actor: AuditActor, at: Date): void {
  tx.insert(inquiryEvents)
    .values({
      id: rid('iev'),
      inquiryId,
      fromState: null,
      toState: 'new',
      reason: null,
      actorUserId: actor.userId ?? null,
      actorName: actor.name ?? null,
      createdAt: at,
    })
    .run();
  audit(actor, 'inquiry.received', { entity: 'inquiry', entityId: inquiryId, detail: { source } });
}

/**
 * Move an inquiry along the pipeline. Refuses anything `NEXT_STATES` does not allow, including a
 * move to the state it is already in — "no change" is not a transition, and recording one would put
 * a row in the trail that says nothing happened.
 */
export function transitionInquiry(opts: TransitionOpts): Inquiry {
  const at = opts.at ?? new Date();
  const run = (tx: Tx): Inquiry => {
    const row = inquiryById(opts.inquiryId, tx);
    if (!row) throw new Error('inquiry_not_found');
    if (!canTransition(row.state, opts.to)) throw new TransitionRefused(row.state, opts.to);
    return writeTransition(tx, row, opts.to, {
      reason: opts.reason,
      actor: opts.actor,
      at,
      patch: opts.to === 'waitlisted' ? { waitlistReason: opts.waitlistReason?.trim() || null } : undefined,
    });
  };
  return opts.tx ? run(opts.tx) : db.transaction((tx) => run(tx as unknown as Tx));
}

/**
 * The conversion ending: this inquiry became a student.
 *
 * Separate from `transitionInquiry` so that `admitted` cannot be reached by an office action, a
 * router input or a future bulk button — only by the code that actually created the child, inside
 * the transaction that created them. `studentId` and `familyId` are set here and only here, which is
 * what makes them the answer to "when did this family first ask?" rather than a field somebody
 * could have typed.
 */
export function markAdmitted(opts: { inquiryId: string; studentId: string; familyId: string; actor: AuditActor; at?: Date; tx: Tx }): Inquiry {
  const at = opts.at ?? new Date();
  const row = inquiryById(opts.inquiryId, opts.tx);
  if (!row) throw new Error('inquiry_not_found');
  if (!canTransition(row.state, 'admitted')) throw new TransitionRefused(row.state, 'admitted');
  return writeTransition(opts.tx, row, 'admitted', {
    actor: opts.actor,
    at,
    patch: { studentId: opts.studentId, familyId: opts.familyId },
  });
}

/**
 * Reorder the waitlist by hand (decision 7: manual ordering, no capacity).
 *
 * Classes carry no capacity today, and adding one means enforcing it in rollover, bulk class
 * assignment and admission — three paths that currently cannot fail and would all gain a new failure
 * mode. A visible position and a reason is what an office actually works from.
 *
 * Takes the ids in the order they should end up, and numbers them 1..n. Anything waitlisted but not
 * named keeps its relative order after them, so a screen that sends a partial list cannot silently
 * strand the rows it did not know about.
 */
export function reorderWaitlist(orderedIds: string[], actor: AuditActor, at = new Date()): number {
  return db.transaction((tx) => {
    const current = tx.select().from(inquiries).where(eq(inquiries.state, 'waitlisted')).all();
    const byId = new Map(current.map((r) => [r.id, r]));
    // DEDUPED, because this list arrives from a browser. The same id twice would be numbered twice —
    // the second write winning, the count wrong, and every row after it shifted by one — which is
    // precisely the hole in the queue this function exists to prevent. A Set also makes the
    // "everything not named" pass below a lookup rather than a scan per row.
    const named = [...new Set(orderedIds.filter((id) => byId.has(id)))];
    const namedSet = new Set(named);
    const rest = current
      .filter((r) => !namedSet.has(r.id))
      .sort((a, b) => (a.waitlistPosition ?? 0) - (b.waitlistPosition ?? 0))
      .map((r) => r.id);
    const finalOrder = [...named, ...rest];
    finalOrder.forEach((id, i) => {
      tx.update(inquiries)
        .set({ waitlistPosition: i + 1, updatedAt: at })
        .where(eq(inquiries.id, id))
        .run();
    });
    audit(actor, 'inquiry.waitlistReorder', { entity: 'inquiry', detail: { count: finalOrder.length } });
    return finalOrder.length;
  });
}
