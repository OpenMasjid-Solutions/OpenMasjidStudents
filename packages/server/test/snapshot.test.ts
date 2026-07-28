// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The `VACUUM INTO` database snapshot (db/snapshot.ts).
 *
 * WHY: OpenMasjidOS backs an app up by tarring its volume with the container still running. In WAL
 * mode that can capture a mutually inconsistent db/-wal pair, and `tar` exits 0 either way — so a
 * torn archive is indistinguishable from a good one until a restore fails. A snapshot means the
 * archive always contains one self-consistent, restorable copy.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { freshApp, makeCtx } from './harness';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let snap: typeof import('../src/db/snapshot');
const caller = (role: Role) => app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

beforeAll(async () => {
  app = await freshApp();
  snap = await import('../src/db/snapshot');
});

describe('writeSnapshot', () => {
  it('writes a self-consistent copy with a manifest, and it opens cleanly on its own', async () => {
    // Real data, so the snapshot has something to prove.
    const admin = caller('admin');
    const fam = await admin.people.familyCreate({ name: 'Ismail' });
    const plan = await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 35000, cadence: 'monthly' });
    await admin.people.studentCreate({ familyId: fam.id, fullName: 'Yusuf Ismail', feePlanId: plan.id });

    const r = snap.writeSnapshot();
    expect(r.ok).toBe(true);
    expect(r.bytes).toBeGreaterThan(0);

    const dir = snap.snapshotDir();
    const file = path.join(dir, 'students.db');
    expect(fs.existsSync(file)).toBe(true);

    // The whole point: NO side files. A VACUUM INTO output is a complete database by itself, which is
    // what makes it safe for an external tar to pick up.
    expect(fs.existsSync(`${file}-wal`)).toBe(false);
    expect(fs.existsSync(`${file}-shm`)).toBe(false);

    // And it really is a working database containing the row we just wrote.
    const probe = new Database(file, { readonly: true });
    try {
      expect((probe.pragma('integrity_check') as { integrity_check: string }[])[0].integrity_check).toBe('ok');
      const row = probe.prepare('select full_name as f from students limit 1').get() as { f: string };
      expect(row.f).toBe('Yusuf Ismail');
    } finally {
      probe.close();
    }

    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8'));
    expect(manifest).toMatchObject({ integrity: 'ok' });
    expect(manifest.bytes).toBeGreaterThan(0);
    expect(typeof manifest.takenAt).toBe('string');
  });

  it('is repeatable — a second run replaces the first (VACUUM INTO refuses to overwrite, so this is the bit that could break)', async () => {
    expect(snap.writeSnapshot().ok).toBe(true);
    const second = snap.writeSnapshot();
    expect(second.ok).toBe(true);
    expect(fs.existsSync(path.join(snap.snapshotDir(), 'students.db'))).toBe(true);
  });

  it('picks up rows written between snapshots', async () => {
    const admin = caller('admin');
    await admin.people.familyCreate({ name: 'Farooqi' });
    snap.writeSnapshot();
    const probe = new Database(path.join(snap.snapshotDir(), 'students.db'), { readonly: true });
    try {
      const names = (probe.prepare('select name from families').all() as { name: string }[]).map((r) => r.name);
      expect(names).toContain('Farooqi');
    } finally {
      probe.close();
    }
  });

  it('leaves no temp file behind', async () => {
    snap.writeSnapshot();
    const leftovers = fs.readdirSync(snap.snapshotDir()).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });
});
