// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * STORING AN INQUIRY (0.52.0, CLAUDE.md §4a Phase 2, docs/ADMISSIONS.md §1–2).
 *
 * The one place a submission becomes a row, whether it arrived through the public form or was typed
 * in by the office for a walk-in. Everything about WHO may submit and how often is the route's job
 * (`admissions/publicRoutes.ts`); this module is about what is stored and what is refused as data.
 *
 * ── An inquiry is not a student and not a household ─────────────────────────
 *
 * Nothing here touches `students`, `families`, `guardians` or `charges`, and nothing here mints a
 * Student ID. That is the hardest rule in the phase (§4a) and the reason this file is short: the
 * temptation is to "just create the student as pending" so the rest of the app can see them, which
 * would put an unconfirmed, publicly submitted record on the payment path (§11.2, §14). The ID is
 * minted at conversion, in `admissions/convert.ts`, and nowhere else.
 *
 * ── Two things that look like validation and are actually about disclosure ──
 *
 * `dedupeDigest` is a ONE-WAY hash. A readable "name|email" column would be the same personal data
 * stored a second time for no reason, and the only question ever asked of it is "have we seen exactly
 * this recently?", which a digest answers. It is not unique: a family asking again next year is not a
 * mistake, and refusing them would be a worse failure than a duplicate row.
 *
 * And a duplicate is DROPPED SILENTLY. It cannot be reported, because the response to a submission is
 * identical whatever happened to it — telling a caller "we already have that" would answer the
 * question "is this family known to you?" for anybody who asked it (§14's no-enumeration rule, which
 * `lookup` follows on a surface that at least has a lockout behind it; this one has none).
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, gte } from 'drizzle-orm';
import { db } from '../db';
import { rid } from '../db/ids';
import { inquiries, type Inquiry } from '../db/schema';
import { isIsoDay } from '../settings/dates';
import { getAdmissions } from '../settings';
import { type AuditActor } from '../audit';
import { recordArrival } from './transition';

/**
 * FIELD LENGTH CAPS, enforced server-side whatever the form said (§14).
 *
 * A public surface's caps are not a UX nicety: the row is read back onto an office screen and, later,
 * into a printed page, and the browser's `maxlength` is advice to a browser. Generous enough that a
 * real family is never truncated — a message is a few paragraphs, a name is a name — and small enough
 * that the whole submission is bounded well under the route's own body cap.
 */
export const INQUIRY_CAPS = {
  childName: 120,
  childDob: 10, // an ISO day or nothing
  askedAbout: 120,
  parentName: 120,
  email: 200,
  phone: 40,
  message: 2_000,
} as const;

/** How long two identical submissions count as the same one. A week: long enough to cover "I wasn't
 *  sure it sent, let me do it again tomorrow", short enough that asking again next term is its own
 *  inquiry rather than a silently discarded one. */
export const DEDUPE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What arrives, from either door. EVERY field is optional here — including the two that are actually
 * required — because the public route must not answer a missing field differently from a stored one,
 * and a type that refused to represent an incomplete submission would force that difference into
 * existence at the boundary. `isSubmittable` is where "not worth storing" is decided, once.
 */
export interface InquiryInput {
  childName?: string | null;
  childDob?: string | null;
  askedAbout?: string | null;
  parentName?: string | null;
  email?: string | null;
  phone?: string | null;
  message?: string | null;
}

const clean = (v: string | null | undefined, cap: number): string => (v ?? '').replace(/\s+/g, ' ').trim().slice(0, cap);

/** Free text keeps its line breaks — a message typed in paragraphs is read in paragraphs. Control
 *  characters go, because nothing legitimate types them and they render as nothing at all. */
// eslint-disable-next-line no-control-regex -- deliberate: strip C0 controls except tab and newline
const cleanMultiline = (v: string | null | undefined, cap: number): string =>
  (v ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim()
    .slice(0, cap);

export interface NormalizedInquiry {
  childName: string;
  childDob: string | null;
  askedAbout: string | null;
  parentName: string;
  email: string | null;
  phone: string | null;
  message: string | null;
}

/**
 * Trim, cap and normalize — never reject.
 *
 * Refusing a submission for being malformed would be a way to learn what this app considers valid,
 * one field at a time, from an unauthenticated surface. The only genuinely required things are a
 * child's name and a parent's name (`isSubmittable` below); everything else is stored as whatever was
 * typed, bounded. A date that is not a real day is dropped rather than refused — `2026-13-45` has the
 * right shape and is not a day (§9), and an office reading "no date of birth given" is better served
 * than one reading a date that cannot exist.
 */
export function normalizeInquiry(input: InquiryInput): NormalizedInquiry {
  const dob = clean(input.childDob, INQUIRY_CAPS.childDob);
  return {
    childName: clean(input.childName, INQUIRY_CAPS.childName),
    childDob: isIsoDay(dob) ? dob : null,
    askedAbout: clean(input.askedAbout, INQUIRY_CAPS.askedAbout) || null,
    parentName: clean(input.parentName, INQUIRY_CAPS.parentName),
    email: clean(input.email, INQUIRY_CAPS.email).toLowerCase() || null,
    phone: clean(input.phone, INQUIRY_CAPS.phone) || null,
    message: cleanMultiline(input.message, INQUIRY_CAPS.message) || null,
  };
}

/**
 * THE PUBLIC FORM'S FIELDS — the fixed set (decision 9), with the names Settings uses.
 *
 * `childName` and `parentName` are not here as options: they are required whatever an office says,
 * because a row without them is not an inquiry an office can act on. Everything else is the office's
 * choice — and the LABELS are English literals for the same reason `people/fields.ts` keeps its
 * own: this list is rendered into a page served outside React, which has no i18n.
 */
export const INQUIRY_FIELDS = [
  { key: 'childName', label: "Child's name", alwaysRequired: true },
  { key: 'childDob', label: 'Date of birth', alwaysRequired: false },
  { key: 'askedAbout', label: 'What are you asking about?', alwaysRequired: false },
  { key: 'parentName', label: 'Your name', alwaysRequired: true },
  { key: 'email', label: 'Email', alwaysRequired: false },
  { key: 'phone', label: 'Phone', alwaysRequired: false },
  { key: 'message', label: 'Anything you would like to tell us', alwaysRequired: false },
] as const;
export type InquiryFieldKey = (typeof INQUIRY_FIELDS)[number]['key'];

/**
 * The minimum that makes a row worth an office's attention.
 *
 * Two floors, and they are different things. The FIRST is structural and cannot be configured: a
 * child's name, somebody's name, and a way to reply. The SECOND is whatever else the office marked
 * required in Settings (0.52.0-dev.14).
 *
 * **A submission below either is discarded with the SAME acknowledgement as one that was stored**
 * (§14). That is uncomfortable — a family who missed a box is never told — which is exactly why the
 * form marks required fields and checks them in the browser before it posts. The silence is the
 * no-enumeration rule; the marking is what stops it costing a real family a place.
 */
export function isSubmittable(n: NormalizedInquiry, required: readonly string[] = getAdmissions().requiredInquiryFields): boolean {
  if (!(n.childName.length > 0 && n.parentName.length > 0 && (n.email !== null || n.phone !== null))) return false;
  for (const key of required) {
    const v = (n as unknown as Record<string, unknown>)[key];
    if (typeof v !== 'string' || !v.trim()) return false;
  }
  return true;
}

/**
 * A one-way digest of "who this is", for recognizing a repeat.
 *
 * Case- and space-insensitive on the name so "Yusuf  Ismail" and "yusuf ismail" are one family, and
 * keyed on the contact given as well, because two children of different families can share a name.
 * SHA-256 rather than something cheaper for no cryptographic reason — it is what this codebase
 * already hashes tokens with, and a second hash function is a second thing to reason about.
 */
export function dedupeDigest(n: NormalizedInquiry): string {
  const parts = [n.childName.toLowerCase(), n.email ?? '', (n.phone ?? '').replace(/\D+/g, '')];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

/** Has this exact submission already arrived inside the window? */
export function recentDuplicate(digest: string, at: Date): Inquiry | undefined {
  return db
    .select()
    .from(inquiries)
    .where(and(eq(inquiries.dedupeKey, digest), gte(inquiries.createdAt, new Date(at.getTime() - DEDUPE_WINDOW_MS))))
    .orderBy(desc(inquiries.createdAt))
    .get();
}

export type StoreOutcome = 'stored' | 'duplicate' | 'incomplete';

export interface StoreResult {
  outcome: StoreOutcome;
  /** The row, when one was written. NEVER put this in a response to the public form. */
  inquiry?: Inquiry;
}

/**
 * Write one inquiry.
 *
 * Returns what happened so the CALLER can count it and decide whether to raise an alert — and the
 * public route deliberately throws that answer away, responding identically either way.
 */
export function storeInquiry(
  input: InquiryInput,
  opts: { source: 'public' | 'office'; actor: AuditActor; schoolId?: string | null; schoolYearId?: string | null; at?: Date },
): StoreResult {
  const at = opts.at ?? new Date();
  const n = normalizeInquiry(input);
  if (!isSubmittable(n)) return { outcome: 'incomplete' };

  const digest = dedupeDigest(n);
  const already = recentDuplicate(digest, at);
  if (already) return { outcome: 'duplicate', inquiry: already };

  const row = {
    id: rid('inq'),
    // NOT set from a public submission: a stranger choosing a school by id is the probe `asked_about`
    // exists to prevent. The office assigns it while reviewing.
    schoolId: opts.schoolId ?? null,
    schoolYearId: opts.schoolYearId ?? null,
    ...n,
    state: 'new' as const,
    source: opts.source,
    waitlistPosition: null,
    waitlistReason: null,
    submittedPayload: null,
    studentId: null,
    familyId: null,
    dedupeKey: digest,
    createdAt: at,
    updatedAt: at,
  };

  const stored = db.transaction((tx) => {
    tx.insert(inquiries).values(row).run();
    recordArrival(tx as unknown as Parameters<typeof recordArrival>[0], row.id, opts.source, opts.actor, at);
    return row as Inquiry;
  });

  return { outcome: 'stored', inquiry: stored };
}
