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

/** Apply committed migrations. Idempotent — Drizzle tracks what has been applied.
 *  Works in dev (src/db → ../../drizzle) and prod (dist/db → ../../drizzle, where
 *  the Dockerfile copies the committed migrations alongside dist). Tests pass an
 *  explicit folder to avoid depending on __dirname under the test runner. */
export function runMigrations(folder?: string): void {
  const migrationsFolder = folder ?? path.resolve(__dirname, '..', '..', 'drizzle');
  migrate(db, { migrationsFolder });
  log.info('migrations applied');
}
