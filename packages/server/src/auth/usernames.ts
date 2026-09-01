// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * How a username is MATCHED — one place, because two places disagreed (0.48.0).
 *
 * THE BUG. Signing in has always looked an account up case-INSENSITIVELY, and for a good reason: a
 * parent's username IS their email address, and a phone keyboard capitalizes the first letter, so a
 * case-sensitive login would lock out families for a keystroke they cannot see. But every place that
 * asked "is this username taken?" compared it case-SENSITIVELY (`users.username` is UNIQUE, and SQLite's
 * default collation is binary). So `Office` and `office` were both accepted as separate accounts — and
 * then only ONE of them could ever be signed into, because the lookup matches both and takes the first
 * row. An admin creating a second admin that way produces an account nobody can use, with no error
 * anywhere to say so. Confirmed by probe, not by reading: `staff.create` accepted the pair, and login
 * with the second account's own password signed in as the FIRST one's role.
 *
 * THE RULE, now stated once and used by every door (login, staff create, invite mint, invite accept):
 * usernames are compared case-insensitively, so `Office` and `office` are the SAME name and the second
 * one is refused at creation.
 *
 * `findUserByUsername` tries an EXACT match first and only then a case-insensitive one. That ordering is
 * what looks after an install that already has such a pair: each person still reaches their own account
 * by typing their own name, and the loose match remains for the parent whose keyboard capitalized
 * something. It also keeps the single indexed lookup as the common path.
 */
import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import type { DB } from '../db';
import { users } from '../db/schema';

/** Anything that can run a query — the live handle or an open transaction. */
type Queryable = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

/** The form a username is compared as. Never what gets STORED — the account keeps the case it was
 *  created with, because that is what an admin typed and expects to see on the staff screen. */
export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

/** The account this username signs into, whatever case it was typed in. */
export function findUserByUsername(value: string) {
  const typed = value.trim();
  if (!typed) return undefined;
  return (
    db.select().from(users).where(eq(users.username, typed)).get() ??
    db.select().from(users).where(sql`lower(${users.username}) = ${normalizeUsername(typed)}`).get()
  );
}

/**
 * Is this username already in use — in ANY case?
 *
 * Takes a `Queryable` so the same question can be asked again inside the transaction that inserts,
 * which is what closes the double-submit race (see `inviteAccept`).
 */
export function usernameTaken(tx: Queryable, value: string): boolean {
  const name = normalizeUsername(value);
  if (!name) return false;
  return !!tx.select({ id: users.id }).from(users).where(sql`lower(${users.username}) = ${name}`).get();
}
