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
import { runAutopay, runAutopayNotice, runCardExpiryNotice } from './autopay';
import { reconcile } from './reconcile';
import { refreshSiteInfo } from '../fabric/platform';
import { writeSnapshot } from '../db/snapshot';
import { runAutoInvoice } from '../billing/autoInvoice';
import { runPastDue } from '../billing/pastDue';
import { pruneWhatsappLog, refreshWhatsAppStatus } from '../whatsapp';

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

  // Past due, daily at 08:00 — AFTER reconciliation (07:00), deliberately: a card payment whose webhook
  // was lost is recovered at 07:00, and chasing that family an hour earlier would be this app's fault.
  // The job itself decides whether anything is overdue, whether the grace period has passed, and whether
  // each household is due another reminder, so a missed day costs nothing.
  //
  // Inside the fabric guard, unlike auto-invoicing: every output of this job is an email, and a
  // standalone install has no transport to send one with (mail is OpenMasjidOS's, §12).
  if (!fabricConfigured()) {
    started = true;
    log.info('schedulers started (standalone — snapshot + auto invoicing only)');
    return;
  }
  new Cron('0 8 * * *', async () => {
    try {
      await runPastDue(todayIso());
    } catch (e) {
      log.error('past due run failed', { error: (e as Error).message });
    }
  });
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
  // Daily at 09:00 — "we'll charge your card on Tuesday" (0.50.0). AFTER the 06:00 run, deliberately:
  // a household charged this morning must not then be told a charge is coming, and the notice looks
  // three days ahead so the two never describe the same invoice. Stateless — see `autopayUpcoming`.
  //
  // On the FIRST of the month it also warns about a card that is about to expire, which is the whole
  // of that job's idempotency: at most two notices per card, never a daily nag.
  new Cron('0 9 * * *', async () => {
    const today = todayIso();
    try {
      await runAutopayNotice(today);
      if (today.endsWith('-01')) await runCardExpiryNotice(today);
    } catch (e) {
      log.error('autopay notices failed', { error: (e as Error).message });
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
  // Every 15 minutes — re-ask whether WhatsApp can send (0.50.0). The gateway is a linked PHONE: it
  // goes offline when the handset does, it can be unlinked, and the number can be restricted, none of
  // which produces an event we would hear about. Keeping the answer warm means a send never pays for a
  // status hop and the settings screen tells the truth without an admin pressing anything.
  new Cron('*/15 * * * *', async () => {
    await refreshWhatsAppStatus();
  });
  // …and once at boot. A cron's first tick is a quarter of an hour away, and until it came the cache
  // was cold — which the settings screen read as "not ready" and used to grey out the Send-a-test
  // button on an install that was working perfectly (0.50.0-dev.4).
  void refreshWhatsAppStatus();
  // Weekly — trim the WhatsApp queue log. It is an operational trail, not a record anybody bills from
  // (and it holds no message bodies), so an install running for years should not carry every line.
  new Cron('0 3 * * 0', () => {
    try {
      const removed = pruneWhatsappLog();
      if (removed) log.info('whatsapp log pruned', { removed });
    } catch (e) {
      log.warn('whatsapp log prune failed', { error: (e as Error).message });
    }
  });
  log.info('schedulers started');
}
