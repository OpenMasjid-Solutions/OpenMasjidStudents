// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * "Has this install been set up at all?" — one place, because two callers now ask it.
 *
 * It lived inside `trpc/auth.ts` as a private helper, which was right while the login screen was the
 * only thing that cared. The WhatsApp `stats` command cares too: an install with no admin account has
 * no students, no currency and no school name, so it would answer "0 students, $0.00" — which reads as
 * a broken madrasah rather than an unfinished one. Both need the same answer to the same question, and
 * a second definition of "set up" is how the two drift (CLAUDE.md §20).
 */

import { db } from '../db';
import { users } from '../db/schema';

/** True once the first admin exists. The whole app is anonymous-but-for-first-run before that (§12). */
export function hasAnyUser(): boolean {
  return !!db.select({ id: users.id }).from(users).limit(1).get();
}
