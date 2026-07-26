// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * In-process schedulers (CLAUDE.md §7, §13.3, §11.4). The daily autopay run + the daily Stripe
 * reconciliation safety net. Best-effort — a failed tick logs and the next tick recovers (the
 * autopay due-date query and reconciliation are both stateless/idempotent). Started only when the
 * platform + Stripe are wired in; a standalone install schedules nothing.
 */
import { Cron } from 'croner';
import { fabricConfigured } from '../config';
import { makeLog } from '../logger';
import { runAutopay } from './autopay';
import { reconcile } from './reconcile';
import { refreshSiteInfo } from '../fabric/platform';
import { writeSnapshot } from '../db/snapshot';
import { runAutoInvoice } from '../billing/autoInvoice';

const log = makeLog('scheduler');
let started = false;

/** ISO date (UTC) for "today". */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function startSchedulers(): void {
  if (started) return;

  // The DB snapshot is scheduled FIRST and deliberately OUTSIDE the fabricConfigured() guard below.
  // It protects the data whether or not the platform is wired in — and a standalone install is
  // arguably the one that most needs it, since nobody else is looking after its data. Every 30
  // minutes; a snapshot is a read transaction, so writers are unaffected.
  new Cron('*/30 * * * *', () => {
    const r = writeSnapshot();
    if (!r.ok) log.warn('db snapshot failed', { error: r.error });
  });
  // Take one at boot too, so a container that is restarted more often than every 30 minutes still
  // leaves a usable snapshot on the volume.
  const first = writeSnapshot();
  if (!first.ok) log.warn('initial db snapshot failed', { error: first.error });

  // Invoice auto-generation, also OUTSIDE the fabricConfigured() guard: it is pure local billing and
  // needs no platform at all, so a standalone install gets it too. Daily at 02:00, and the job itself
  // decides whether today is the configured day, whether the month is inside the school year, and
  // whether it has already run for this period — so a missed day is caught up rather than skipped.
  new Cron('0 2 * * *', () => {
    try {
      const r = runAutoInvoice();
      if (r.ran) log.info('auto invoice run', { periodKey: r.periodKey, created: r.created });
    } catch (e) {
      log.error('auto invoice run failed', { error: (e as Error).message });
    }
  });

  if (!fabricConfigured()) {
    started = true;
    log.info('schedulers started (standalone — snapshot + auto invoicing only)');
    return;
  }
  started = true;
  // Daily at 06:00 — charge every autopay-ON family whatever is due, then let the webhooks settle.
  new Cron('0 6 * * *', async () => {
    try {
      const r = await runAutopay(todayIso());
      log.info('autopay run complete', { attempted: r.attempted });
    } catch (e) {
      log.error('autopay run failed', { error: (e as Error).message });
    }
  });
  // Daily at 07:00 — reconcile against Stripe: record any succeeded tuition PI a broker call or a
  // webhook missed (incl. this morning's autopay charges), so money is never lost, only delayed (§11.4).
  new Cron('0 7 * * *', async () => {
    try {
      const r = await reconcile({ userId: null, role: 'system', name: 'reconciliation' });
      if (r.ok) log.info('reconcile run complete', { scanned: r.scanned, recorded: r.recorded });
    } catch (e) {
      log.error('reconcile run failed', { error: (e as Error).message });
    }
  });
  // Every 15 minutes — re-ask the platform for our public URL (manifest `domain: true`). It changes
  // when an admin turns on Remote access, renames the path, or sets a custom domain, and an invite
  // minted with a stale base is a dead link in someone's inbox. Cheap, fail-soft, no PII.
  new Cron('*/15 * * * *', async () => {
    await refreshSiteInfo();
  });
  log.info('schedulers started');
}
