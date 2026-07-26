// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * A byte-consistent snapshot of the database, on the data volume, for OpenMasjidOS to back up.
 *
 * WHY THIS EXISTS. The platform backs an app up by tarring its Docker volume while the container is
 * still RUNNING (`OpenMasjidOS/packages/core/src/system/backup.ts`). We run SQLite in WAL mode, so at
 * rest there are three files — `students.db`, `-wal`, `-shm` — and an external tool reading them
 * sequentially can capture a mutually inconsistent set. `tar` exits 0 either way, so nothing upstream
 * can even detect it: a torn capture is indistinguishable from a good one until someone tries to
 * restore it. SQLite's own documentation is explicit that you must not copy a live database this way.
 *
 * `VACUUM INTO` is the supported answer. It takes a read transaction and writes a fully-formed,
 * self-consistent database file — no WAL, no side files — so whatever the tar catches, the archive
 * always contains one restorable copy. We then verify it with `integrity_check` before publishing it,
 * so a broken snapshot is never left sitting where it looks authoritative.
 *
 * This does NOT replace the platform fixing its own capture; it means an app that cares can be safe
 * regardless. Cheap: a read transaction, not a lock — writers keep working in the WAL.
 */
import fs from 'node:fs';
import path from 'node:path';
import { rawSqlite } from './index';
import { config } from '../config';
import { makeLog } from '../logger';

const log = makeLog('snapshot');

/** Directory on the data volume holding the snapshot + its manifest. */
export function snapshotDir(): string {
  return path.join(config.dataDir, 'snapshot');
}

export interface SnapshotResult {
  ok: boolean;
  bytes?: number;
  error?: string;
}

/**
 * Write (or refresh) the snapshot. Steps, in this order for a reason:
 *   1. `VACUUM INTO` a temp file — VACUUM INTO REFUSES to overwrite, so it must be a fresh path.
 *   2. Open the temp file and run `integrity_check`, so we never publish a corrupt snapshot.
 *   3. Rename over the live snapshot — atomic on the same filesystem, so a reader (or a tar) sees
 *      either the old complete file or the new one, never a half-written one.
 */
export function writeSnapshot(): SnapshotResult {
  const dir = snapshotDir();
  const target = path.join(dir, 'students.db');
  const tmp = path.join(dir, `students.db.tmp-${process.pid}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    // A leftover temp from a crashed run would make VACUUM INTO fail.
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });

    rawSqlite.prepare('VACUUM INTO ?').run(tmp);

    // Verify before publishing. Opening read-only keeps this from creating side files of its own.
    let integrity = 'unknown';
    let pageCount = 0;
    try {
      // Reuse the same driver rather than importing better-sqlite3 twice.
      const Database = (rawSqlite.constructor as unknown) as new (p: string, o?: { readonly?: boolean }) => {
        pragma: (s: string) => unknown;
        close: () => void;
      };
      const probe = new Database(tmp, { readonly: true });
      try {
        const rows = probe.pragma('integrity_check') as { integrity_check?: string }[];
        integrity = rows?.[0]?.integrity_check ?? 'unknown';
        const pc = probe.pragma('page_count') as { page_count?: number }[];
        pageCount = pc?.[0]?.page_count ?? 0;
      } finally {
        probe.close();
      }
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      return { ok: false, error: `verify failed: ${(e as Error).message}` };
    }
    if (integrity !== 'ok') {
      fs.rmSync(tmp, { force: true });
      return { ok: false, error: `integrity_check returned ${integrity}` };
    }

    const bytes = fs.statSync(tmp).size;
    fs.renameSync(tmp, target); // atomic publish
    // A manifest so whoever restores can tell what they have without opening SQLite.
    fs.writeFileSync(
      path.join(dir, 'MANIFEST.json'),
      JSON.stringify({ takenAt: new Date().toISOString(), appVersion: config.version, bytes, pageCount, integrity, note: 'VACUUM INTO snapshot — self-consistent, safe to restore even if the surrounding archive caught the live DB mid-write.' }, null, 2),
    );
    return { ok: true, bytes };
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    const error = (e as Error).message;
    log.warn('snapshot failed', { error });
    return { ok: false, error };
  }
}
