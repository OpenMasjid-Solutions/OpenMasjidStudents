// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * SQLite (WAL) via better-sqlite3 + Drizzle. Migrations are committed under
 * ./drizzle and applied on boot (forward-only). The DB file lives on the /data
 * volume and holds minors' PII plus every payment record, so the file itself is a
 * secret and backups of it must be handled as one (CLAUDE.md §9, §14).
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { config } from '../config';
import { makeLog } from '../logger';
import * as schema from './schema';

const log = makeLog('db');

fs.mkdirSync(config.dataDir, { recursive: true });
const sqlite = new Database(path.join(config.dataDir, 'students.db'));
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });
export type DB = typeof db;
/** The raw better-sqlite3 handle. Needed for statements Drizzle doesn't model — `VACUUM INTO` and
 *  `PRAGMA integrity_check` (db/snapshot.ts). Nothing else should reach for this. */
export const rawSqlite = sqlite;

/**
 * Apply committed migrations. Idempotent — Drizzle tracks what has been applied.
 * Works in dev (src/db → ../../drizzle) and prod (dist/db → ../../drizzle, where
 * the Dockerfile copies the committed migrations alongside dist). Tests pass an
 * explicit folder to avoid depending on __dirname under the test runner.
 *
 * FOREIGN KEYS ARE OFF FOR THE DURATION, and that is required rather than lax.
 *
 * SQLite cannot change a table's columns in place, so drizzle emits the standard rebuild —
 * create `__new_x`, copy, DROP the original, rename. Every drizzle rebuild therefore starts with
 * `PRAGMA foreign_keys=OFF`, which assumes it can take effect. It cannot: the migrator wraps the
 * whole file in a transaction, and SQLite silently ignores that pragma inside one. With FK
 * enforcement left on, dropping a table that anything references fails — so a rebuild of, say,
 * `students` works perfectly on an empty database and fails to boot on a real one the moment a
 * single child has an invoice. (`defer_foreign_keys` is not a way out either: DROP TABLE bumps
 * SQLite's deferred-violation counter, and recreating the table does not clear it, so the COMMIT
 * still fails with nothing dangling.)
 *
 * So the switch is thrown HERE, outside any transaction, where it actually applies — and thrown
 * back afterwards. The safety net that replaces it is `foreign_key_check`: run once the migrations
 * are in, it reports any row a migration orphaned while the guard was down. That is logged loudly
 * rather than thrown, because refusing to boot over it would leave an admin with no way in to fix
 * anything — but it must never be ignored.
 */
export function runMigrations(folder?: string): void {
  const migrationsFolder = folder ?? path.resolve(__dirname, '..', '..', 'drizzle');
  sqlite.pragma('foreign_keys = OFF');
  try {
    migrate(db, { migrationsFolder });
  } finally {
    sqlite.pragma('foreign_keys = ON');
  }
  const orphaned = sqlite.pragma('foreign_key_check') as unknown[];
  if (orphaned.length) {
    // Table + row ids only — never the row contents, which are minors' PII (§14).
    log.error('migrations left rows with a broken reference', { count: orphaned.length, sample: orphaned.slice(0, 5) });
  }
  log.info('migrations applied');
}
