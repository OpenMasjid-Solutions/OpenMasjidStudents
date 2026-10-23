// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The migration journal — the file that decides whether a migration runs on an install that has data.
 *
 * **This is the highest-consequence footgun in the repo and nothing checked it until now** (0.52.0).
 *
 * Drizzle's better-sqlite3 migrator reads `meta/_journal.json`, looks up the newest `created_at` already
 * recorded in `__drizzle_migrations`, and applies only the entries whose `when` is GREATER than it. The
 * hash it stores alongside is written and never compared. So `when` — and nothing else — is what makes a
 * migration run.
 *
 * Since 0032 those `when` values have been **typed by hand** rather than produced by `drizzle-kit
 * generate`. A migration whose `when` is not strictly greater than the one before it:
 *
 *   - applies perfectly on a FRESH database, because there is no newest-applied row to compare against,
 *     so every test, every CI run and every new install looks green; and
 *   - is skipped FOREVER on a live one — the app boots, reports success, and then fails at runtime on a
 *     missing table or column, with nothing anywhere saying which migration was skipped or why.
 *
 * §4a adds roughly eighteen tables across six independently shipping phases, every one of them landing on
 * installs that already hold students, invoices and payments. That is a lot of chances to type a number
 * slightly too small. These four assertions are the whole guard, and they are cheap:
 *
 *   1. `when` is STRICTLY increasing — the rule the migrator actually enforces.
 *   2. `idx` is 0,1,2,… in order — how drizzle names and orders the entries.
 *   3. Every journal entry has its `.sql` file — a listed migration with no file throws on boot.
 *   4. Every `.sql` file is listed — an UNLISTED file is the silent one: it is simply never applied, and
 *      the only symptom is a missing table much later.
 *
 * CLAUDE.md §9 ("a migration's `when` must be strictly increasing, and a test enforces it"), §4a Phase 0.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

type Entry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };

const drizzleDir = path.resolve(__dirname, '..', 'drizzle');
const journal = JSON.parse(readFileSync(path.join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
  version: string;
  dialect: string;
  entries: Entry[];
};

describe('the migration journal', () => {
  it('has entries at all, so a broken read fails loudly rather than vacuously passing', () => {
    expect(journal.entries.length).toBeGreaterThan(40);
  });

  it('IS STRICTLY INCREASING in `when` — the one rule the migrator enforces', () => {
    // Reported as the full list of offending pairs rather than the first failure, so a bad bump is fixed
    // in one pass instead of one migration at a time.
    const backwards = journal.entries
      .slice(1)
      .map((e, i) => ({ prev: journal.entries[i], entry: e }))
      .filter(({ prev, entry }) => entry.when <= prev.when)
      .map(({ prev, entry }) => `${entry.tag} (when=${entry.when}) is not after ${prev.tag} (when=${prev.when})`);
    expect(backwards).toEqual([]);
  });

  it('numbers its entries 0,1,2,… with no gap and no repeat', () => {
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i));
  });

  it('names a real .sql file for every entry', () => {
    const files = new Set(readdirSync(drizzleDir).filter((f) => f.endsWith('.sql')));
    const missing = journal.entries.map((e) => `${e.tag}.sql`).filter((f) => !files.has(f));
    expect(missing).toEqual([]);
  });

  it('lists every .sql file it has — an unlisted migration is simply never applied', () => {
    const listed = new Set(journal.entries.map((e) => `${e.tag}.sql`));
    const orphans = readdirSync(drizzleDir)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) => !listed.has(f));
    expect(orphans).toEqual([]);
  });

  it('keeps the file prefix and the entry order in step, so 0041 cannot sort before 0040', () => {
    // The numeric prefix is how a human reads the sequence; `idx` is how drizzle applies it. They have
    // agreed so far by convention alone, and a mismatch would make the journal unreadable at review time
    // — which is when a bad `when` is meant to be caught.
    const prefixes = journal.entries.map((e) => Number(e.tag.slice(0, 4)));
    expect(prefixes).toEqual(journal.entries.map((_, i) => i));
  });
});
