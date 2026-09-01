// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The ONE place that decides which household is the notification test household (0.50.0).
 *
 * A real student, chosen in Settings, whose household **receives notifications even while everything
 * is paused** — so an office can watch a real receipt arrive on a real phone and in a real inbox
 * before two hundred families do.
 *
 * IT COVERS BOTH CHANNELS, and that is a correction rather than a design (0.50.0-dev.4). It shipped
 * inside the WhatsApp config and it lifted only the WhatsApp pause, so an office that set a test
 * student, made a payment and waited got nothing at all: the parent-EMAIL pause is a separate switch,
 * defaults on for a fresh install, and held the receipt back silently. "That student's household will
 * actually receive notifications even if paused" has to mean notifications, not one kind of them.
 *
 * So it lives here, in settings, rather than in `whatsapp/` — both `mail/notify.ts` and
 * `whatsapp/index.ts` ask this module, and neither has to know about the other. The VALUE is still
 * stored on the WhatsApp settings row because that is where the office sets it and moving the key
 * would strand the installs that already have one.
 *
 * What it overrides is exactly one thing: **a pause**. Not a channel that is switched off, not an
 * event nobody selected, and never a person's opt-out.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { students } from '../db/schema';
import { getWhatsApp } from './index';

export function getTestStudentId(): string {
  return getWhatsApp().testStudentId;
}

/**
 * The household a pause does not apply to, or null.
 *
 * Resolved from the STUDENT on every call rather than stored as a family id: a child moved between
 * households (a sibling link, a merge) takes the setting with them instead of leaving it pointing at
 * a household nobody meant to test with. A withdrawn or deleted student resolves to null, which fails
 * closed — the pause simply holds for everybody, and the settings screen says the student is gone
 * rather than leaving the exception looking configured while nothing gets through.
 */
export function testFamilyId(): string | null {
  const id = getTestStudentId();
  if (!id) return null;
  return db.select({ familyId: students.familyId }).from(students).where(and(eq(students.id, id), eq(students.status, 'active'))).get()?.familyId ?? null;
}

/** Is this household held back by `paused` right now? The test household never is. */
export function pausedFor(paused: boolean, familyId: string | null | undefined): boolean {
  if (!paused) return false;
  return !familyId || testFamilyId() !== familyId;
}
