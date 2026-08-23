// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * MESSAGES REPORTED SENT THAT MAY NOT HAVE ARRIVED (0.51.0-dev.9, platform 0.51.2).
 *
 * A masjid's WhatsApp session expired on its own, OpenMasjidOS did not notice, and for over a day every
 * message was accepted, recorded `sent`, and delivered nowhere. `GET /api/fabric/whatsapp/suspect` hands
 * back the windows it was wrong about; the platform cannot resend them because it deletes message
 * contents on handover, so what this app does about it is entirely this app's decision.
 *
 * What has to hold, and each of these is a way to be wrong that looks fine on screen:
 *
 *  1. **An empty answer and an unanswerable question are different.** `{windows: []}` is the normal "all
 *     clear". A 403, a 429, an unreachable platform or a malformed body must NEVER read as all-clear —
 *     reassurance we did not actually receive is worse than none, and this is the same trap the group
 *     list documents (`whatsappGroups`).
 *  2. **A covered row stops claiming it was sent.** That is the whole deliverable: a log asserting
 *     delivery it cannot vouch for is what stops an office phoning the family.
 *  3. **Only `sent` rows are touched.** A `failed`, `expired` or `skipped` row has a more specific answer
 *     already; a `queued` one never claimed delivery and may still go out properly.
 *  4. **Nothing is resent.** Not automatically and not on a button — the reasoning is in
 *     whatsapp/suspect.ts, and the decisive part is that no message body is stored, so anything
 *     "resent" would be a different message under the same name.
 *  5. **The households with no email address are named separately.** Everyone else got the email, so
 *     they were told; for these, WhatsApp was the only channel and the notice is genuinely lost.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshApp, makeCtx } from './harness';
import { families, feePlans, guardianFamilies, guardians, settings, auditLog, students, studentFees, users, whatsappLog } from '../src/db/schema';
import type { Role } from '../src/db/schema';

let app: Awaited<ReturnType<typeof freshApp>>;
let suspect: typeof import('../src/whatsapp/suspect');
let settingsMod: typeof import('../src/settings');
let whatsapp: typeof import('../src/whatsapp');

const caller = (role: Role) => app.appRouter.createCaller(makeCtx({ origin: 'lan', session: { role, source: 'local', username: role, userId: `usr_${role}` } }).ctx);

/** What the platform's suspect endpoint answers. */
let reply: { http: number; body: unknown } = { http: 200, body: { windows: [] } };
let calls: string[] = [];
const realFetch = globalThis.fetch;

function installFetch(): void {
  globalThis.fetch = vi.fn(async (input: unknown, init?: unknown) => {
    const url = String(input);
    const i = (init ?? {}) as { method?: string };
    calls.push(url);
    if (url.endsWith('/api/fabric/whatsapp/suspect')) {
      return { ok: reply.http < 300, status: reply.http, json: async () => reply.body } as unknown as Response;
    }
    if (url.endsWith('/api/fabric/whatsapp')) {
      if ((i.method ?? 'GET') === 'GET') return { ok: true, status: 200, json: async () => ({ available: true, reason: 'ready', outcomes: true }) } as unknown as Response;
      return { ok: true, status: 202, json: async () => ({ queued: true, id: 'wam_1' }) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
}

const TS = new Date('2026-08-20T12:00:00Z');

beforeAll(async () => {
  app = await freshApp({ fabric: true, publicUrl: 'https://masjid.example.org' });
  suspect = await import('../src/whatsapp/suspect');
  settingsMod = await import('../src/settings');
  whatsapp = await import('../src/whatsapp');
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  const { db } = app.dbmod;
  for (const t of [studentFees, feePlans, students, guardianFamilies, guardians, families, whatsappLog, settings, auditLog]) db.delete(t).run();
  db.delete(users).run();
  calls = [];
  reply = { http: 200, body: { windows: [] } };
  installFetch();
});

/** A household, and one `sent` log row for it at `at`. */
async function household(surname: string, opts: { email?: string | null; at?: Date; status?: string; event?: string } = {}) {
  const admin = caller('admin');
  const plan =
    app.dbmod.db.select({ id: feePlans.id }).from(feePlans).get()?.id ??
    (await admin.billing.feePlanCreate({ name: 'Tuition', amountCents: 5000, cadence: 'monthly' })).id;
  const fam = await admin.people.familyCreate({ name: surname });
  const g = await admin.people.guardianCreate({
    familyId: fam.id,
    name: `Abu ${surname}`,
    phone: '5551234567',
    email: opts.email === null ? undefined : (opts.email ?? `abu.${surname.toLowerCase()}@test.org`),
  });
  await admin.people.studentCreate({ familyId: fam.id, fullName: `Yusuf ${surname}`, feePlanId: plan });
  const rowId = `wal_${surname}`;
  app.dbmod.db
    .insert(whatsappLog)
    .values({
      id: rowId,
      event: opts.event ?? 'receipt',
      recipientKind: 'guardian',
      recipientId: g.id,
      familyId: fam.id,
      status: (opts.status ?? 'sent') as 'sent',
      reason: null,
      platformId: 'wam_1',
      createdAt: opts.at ?? TS,
    })
    .run();
  return { familyId: fam.id, rowId };
}

const rowById = (id: string) => app.dbmod.db.select().from(whatsappLog).all().find((r) => r.id === id);
/** A window that covers `TS`. */
const covering = () => ({ from: TS.getTime() - 60_000, to: TS.getTime() + 60_000, count: 1 });

// ── "All clear" vs "I could not ask" ────────────────────────────────────────
describe('an empty answer and an unanswerable question are not the same', () => {
  it('treats an empty windows array as the all-clear it is', async () => {
    await household('Ismail');
    const r = await suspect.checkSuspectWindows();
    expect(r.checked).toBe(true);
    expect(r.newWindows).toBe(0);
    expect(suspect.suspectSummary().total).toBe(0);
  });

  /** The whole trap: a refusal also has no windows in it. Reading that as "nothing to worry about" is
   *  the failure this endpoint exists to fix, wearing a different hat. */
  it('does not read a refusal as an all-clear', async () => {
    for (const http of [403, 429, 500]) {
      reply = { http, body: {} };
      const r = await suspect.checkSuspectWindows();
      expect(r.checked, `http ${http} must not count as checked`).toBe(false);
      expect(r.reason).toBe(`http_${http}`);
    }
  });

  it('does not read a malformed 200 as an all-clear', async () => {
    reply = { http: 200, body: { nothing: true } };
    const r = await suspect.checkSuspectWindows();
    expect(r.checked).toBe(false);
    expect(r.reason).toBe('bad_shape');
  });

  /** An older platform has no such route. That is not an alarm and not a fault. */
  it('reports an older platform as unsupported rather than as a problem', async () => {
    reply = { http: 404, body: {} };
    const r = await suspect.checkSuspectWindows();
    expect(r.checked).toBe(false);
    expect(r.reason).toBe('unsupported');
  });

  /** A NaN bound would select every row in the log — which is the office being told their whole term of
   *  messages might not have arrived. Dropped rather than guessed at. */
  it('discards a window it cannot read as a real interval', async () => {
    const h = await household('Ismail');
    reply = { http: 200, body: { windows: [{ from: 'yesterday', to: null, count: 3 }, { from: 5, to: 1, count: 1 }] } };
    const r = await suspect.checkSuspectWindows();
    expect(r.newWindows).toBe(0);
    expect(rowById(h.rowId)?.status).toBe('sent');
  });
});

// ── Marking ─────────────────────────────────────────────────────────────────
describe('what a window does to our own records', () => {
  it('stops a covered row claiming it was sent', async () => {
    const h = await household('Ismail');
    reply = { http: 200, body: { windows: [covering()] } };
    const r = await suspect.checkSuspectWindows();
    expect(r.marked).toBe(1);
    expect(rowById(h.rowId)?.status).toBe('unknown');
    expect(rowById(h.rowId)?.reason).toBe(suspect.SUSPECT_REASON);
  });

  it('leaves a row outside the window alone', async () => {
    const inside = await household('Ismail');
    const outside = await household('Farooqi', { at: new Date('2026-08-19T12:00:00Z') });
    reply = { http: 200, body: { windows: [covering()] } };
    await suspect.checkSuspectWindows();
    expect(rowById(inside.rowId)?.status).toBe('unknown');
    expect(rowById(outside.rowId)?.status).toBe('sent');
  });

  /**
   * Only `sent` rows. Everything else already has a MORE specific answer than "we do not know", and
   * overwriting it would lose information rather than add it — a `skipped` row never went near the
   * gateway, and a `queued` one never claimed delivery and may still go out properly now the link is back.
   */
  it('never overwrites a more specific outcome', async () => {
    const q = await household('Queued', { status: 'queued' });
    const f = await household('Failed', { status: 'failed' });
    const s = await household('Skipped', { status: 'skipped' });
    const e = await household('Expired', { status: 'expired' });
    reply = { http: 200, body: { windows: [covering()] } };
    await suspect.checkSuspectWindows();
    expect(rowById(q.rowId)?.status).toBe('queued');
    expect(rowById(f.rowId)?.status).toBe('failed');
    expect(rowById(s.rowId)?.status).toBe('skipped');
    expect(rowById(e.rowId)?.status).toBe('expired');
  });

  /** The platform may keep returning a window for as long as it remembers it. An office watching the
   *  count climb hourly for one incident would reasonably think it was still happening. */
  it('does not re-report the same window on a second poll', async () => {
    await household('Ismail');
    reply = { http: 200, body: { windows: [covering()] } };
    expect((await suspect.checkSuspectWindows()).newWindows).toBe(1);
    expect((await suspect.checkSuspectWindows()).newWindows).toBe(0);
    expect(suspect.suspectSummary().windows).toHaveLength(1);
  });
});

// ── What the office is told ─────────────────────────────────────────────────
describe('what the office is told', () => {
  it('names the households with no email address, because those are the lost ones', async () => {
    await household('Ismail'); // has an email — the email arrived
    const noMail = await household('Sayed', { email: null });
    reply = { http: 200, body: { windows: [covering()] } };
    await suspect.checkSuspectWindows();

    const s = suspect.suspectSummary();
    expect(s.total).toBe(2);
    expect(s.householdsWithoutEmail).toHaveLength(1);
    expect(s.householdsWithoutEmail[0].familyId).toBe(noMail.familyId);
    // Named by their children, which is what an office recognizes.
    expect(s.householdsWithoutEmail[0].label).toContain('Yusuf');
  });

  it('says nothing was lost when every affected family also has an email', async () => {
    await household('Ismail');
    reply = { http: 200, body: { windows: [covering()] } };
    await suspect.checkSuspectWindows();
    const s = suspect.suspectSummary();
    expect(s.total).toBe(1);
    expect(s.householdsWithoutEmail).toEqual([]);
  });

  it('breaks the count down by what the messages were about', async () => {
    await household('Ismail', { event: 'receipt' });
    await household('Farooqi', { event: 'invoice-ready' });
    await household('Sayed', { event: 'invoice-ready' });
    reply = { http: 200, body: { windows: [covering()] } };
    await suspect.checkSuspectWindows();
    expect(suspect.suspectSummary().byEvent).toEqual([
      { event: 'invoice-ready', count: 2 },
      { event: 'receipt', count: 1 },
    ]);
  });

  /** Nothing is resent — not by the scheduler and not by any procedure. The check itself must never
   *  hand a message to the queue, which is the one thing that would make a bad day worse. */
  it('queues no message of its own', async () => {
    await household('Ismail');
    reply = { http: 200, body: { windows: [covering()] } };
    calls = [];
    await suspect.checkSuspectWindows();
    expect(calls.filter((u) => u.endsWith('/api/fabric/whatsapp')).length).toBe(0);
  });
});

// ── Acknowledging ───────────────────────────────────────────────────────────
describe('acknowledging it', () => {
  /**
   * The banner goes; the honesty stays. Rows drop the reason so the summary empties, and remain
   * `unknown` rather than reverting to `sent` — we still do not know that they arrived, and rewriting a
   * log to tidy a screen is the exact dishonesty this feature exists to remove.
   */
  it('clears the banner without claiming the messages arrived', async () => {
    const h = await household('Ismail');
    reply = { http: 200, body: { windows: [covering()] } };
    await suspect.checkSuspectWindows();
    expect(suspect.suspectSummary().total).toBe(1);

    const cleared = suspect.acknowledgeSuspect();
    expect(cleared).toBe(1);
    expect(suspect.suspectSummary().total).toBe(0);
    expect(suspect.suspectSummary().windows).toEqual([]);
    expect(rowById(h.rowId)?.status).toBe('unknown');
    expect(rowById(h.rowId)?.status).not.toBe('sent');
  });

  it('is admin-only, and audited', async () => {
    await expect(caller('finance').whatsapp.suspect()).rejects.toThrow();
    await caller('admin').whatsapp.suspectAck();
    expect(app.dbmod.db.select().from(auditLog).all().some((r) => r.action === 'whatsapp.suspectAck')).toBe(true);
  });
});

// ── Stored state ────────────────────────────────────────────────────────────
describe('the remembered windows', () => {
  /** These bounds become a `WHERE created_at BETWEEN`, so a hand-edited or corrupted row must not be
   *  able to select the whole log. Validated on read, like every other JSON setting. */
  it('drops a stored window that is not a real interval', () => {
    settingsMod.setSetting(
      settingsMod.SETTING_KEYS.whatsappSuspect,
      JSON.stringify([{ from: 'x', to: 2, count: 1 }, { from: 5, to: 1, count: 1 }, { from: 1, to: 2, count: 1, seenAt: 3, marked: 1 }]),
    );
    expect(settingsMod.getSuspectState()).toEqual([{ from: 1, to: 2, count: 1, seenAt: 3, marked: 1 }]);
  });

  it('survives a corrupt row without throwing', () => {
    settingsMod.setSetting(settingsMod.SETTING_KEYS.whatsappSuspect, 'not json');
    expect(settingsMod.getSuspectState()).toEqual([]);
  });
});

// ── Platform 0.51.1-dev.13: exact ids, a cause, and an explicit ok ──────────
describe('matching by platform id rather than by clock', () => {
  /**
   * WHY IDS BEAT THE TIME RANGE, and it is not a micro-optimization. / are when the PLATFORM
   * reported those messages sent; our own  is when WE handed them over, with the paced queue
   * in between. So a message queued just before the window and sent inside it was missed, and one queued
   * inside it but sent afterwards was marked when it should not have been — wrong at both edges.
   */
  it('marks exactly the ids the platform names, ignoring the clock', async () => {
    const inWindow = await household('Ismail', { at: new Date('2026-08-01T00:00:00Z') });
    const other = await household('Farooqi', { at: new Date('2026-08-20T12:00:00Z') });
    // Point the row's platform id at something the window will name.
    app.dbmod.db.update(whatsappLog).set({ platformId: 'wam_named' }).where(eq(whatsappLog.id, inWindow.rowId)).run();

    reply = { http: 200, body: { ok: true, windows: [{ ...covering(), ids: ['wam_named'], truncated: false, cause: 'session-expired' }] } };
    await suspect.checkSuspectWindows();

    // Marked despite its timestamp being WEEKS outside the window…
    expect(rowById(inWindow.rowId)?.status).toBe('unknown');
    // …and the one sitting inside the window is untouched, because the platform did not name it.
    expect(rowById(other.rowId)?.status).toBe('sent');
  });

  /** A truncated list would leave the overflow silently unmarked — the same invisible under-reporting
   *  this whole feature exists to remove. So a truncated window falls back to the complete time range. */
  it('falls back to the time range when the id list was capped', async () => {
    const h = await household('Ismail');
    reply = { http: 200, body: { ok: true, windows: [{ ...covering(), ids: ['wam_someone_else'], truncated: true, cause: 'unknown' }] } };
    await suspect.checkSuspectWindows();
    expect(rowById(h.rowId)?.status).toBe('unknown');
  });

  /** An older platform sends no ids at all, and the range is all there is. */
  it('still works on a platform that sends no ids', async () => {
    const h = await household('Ismail');
    reply = { http: 200, body: { windows: [covering()] } };
    await suspect.checkSuspectWindows();
    expect(rowById(h.rowId)?.status).toBe('unknown');
  });

  it('remembers what the platform said went wrong', async () => {
    await household('Ismail');
    reply = { http: 200, body: { ok: true, windows: [{ ...covering(), ids: [], truncated: false, cause: 'session-expired' }] } };
    await suspect.checkSuspectWindows();
    expect(suspect.suspectSummary().windows[0].cause).toBe('session-expired');
  });

  /** More causes may be added; an unrecognized one must not become a blank or a crash. */
  it('reads an unknown cause as unknown', async () => {
    await household('Ismail');
    reply = { http: 200, body: { ok: true, windows: [{ ...covering(), cause: 'something-new-2027' }] } };
    await suspect.checkSuspectWindows();
    expect(suspect.suspectSummary().windows[0].cause).toBe('something-new-2027');

    settingsMod.setSuspectState([]);
    reply = { http: 200, body: { ok: true, windows: [{ ...covering(), from: 1, to: 2 }] } };
    await suspect.checkSuspectWindows();
    expect(suspect.suspectSummary().windows.some((w) => w.cause === 'unknown')).toBe(true);
  });

  /**
   *  on a 200 is a refusal wearing a success, and this app asked for the field precisely so
   * that could not read as an all-clear. An ABSENT  is an older platform and stays trusted.
   */
  it('treats an explicit ok:false as unanswered, not as all-clear', async () => {
    const h = await household('Ismail');
    reply = { http: 200, body: { ok: false, windows: [] } };
    const r = await suspect.checkSuspectWindows();
    expect(r.checked).toBe(false);
    expect(r.reason).toBe('not_ok');
    expect(rowById(h.rowId)?.status).toBe('sent');
  });
});

/**
 * THE FALLBACK'S KNOWN FALSE POSITIVE, pinned so it stays a documented trade rather than a surprise
 * (platform 0.51.1-dev.13 correction).
 *
 * Now that the platform HOLDS messages through an outage, a message queued during the window and
 * delivered perfectly after the re-link still sits inside the time range. The range cannot tell that
 * apart; a complete id list can, and is authoritative in both directions — a message it does not name
 * was not lost, whatever the timing looks like.
 *
 * We accept the false positive in the FALLBACK because of what it costs here: this app does not resend, so
 * an over-marked row is an office told to consider phoning a family who was in fact reached. An app that
 * resent on this signal could not make that trade — which is the whole reason to prefer ids when they exist.
 */
describe('ids are authoritative in both directions', () => {
  it('does NOT mark a message the id list leaves out, even when the timing matches', async () => {
    const delivered = await household('Ismail');
    app.dbmod.db.update(whatsappLog).set({ platformId: 'wam_delivered_fine' }).where(eq(whatsappLog.id, delivered.rowId)).run();

    // The window names somebody else's message; ours is inside the range but not in the list.
    reply = { http: 200, body: { ok: true, windows: [{ ...covering(), ids: ['wam_a_different_one'], truncated: false, cause: 'session-expired' }] } };
    await suspect.checkSuspectWindows();

    expect(rowById(delivered.rowId)?.status).toBe('sent');
    expect(suspect.suspectSummary().total).toBe(0);
  });

  /** …whereas the range alone cannot tell the two apart, which is the documented cost of the fallback. */
  it('over-marks on the range fallback, which is why ids are preferred', async () => {
    const delivered = await household('Ismail');
    reply = { http: 200, body: { ok: true, windows: [{ ...covering(), ids: [], truncated: false }] } };
    await suspect.checkSuspectWindows();
    // Marked purely on timing. Over-reporting, in the safe direction for an app that never resends.
    expect(rowById(delivered.rowId)?.status).toBe('unknown');
  });
});

/**
 * A WINDOW IS A SNAPSHOT, NOT A RUNNING TALLY (platform 0.51.1-dev.13 correction). Everything in it is
 * fixed at detection, so seven days of hourly polling hands back the identical window — and the office
 * must be told about it once, not once an hour.
 */
describe('a re-reported window is the same window', () => {
  it('stays reported once across a week of identical polls', async () => {
    await household('Ismail');
    const w = { ...covering(), ids: [], truncated: false, cause: 'session-expired' };
    reply = { http: 200, body: { ok: true, windows: [w] } };

    expect((await suspect.checkSuspectWindows()).newWindows).toBe(1);
    // The platform retains it for 7 days; every one of those polls returns the same snapshot.
    for (let i = 0; i < 5; i++) expect((await suspect.checkSuspectWindows()).newWindows).toBe(0);
    expect(suspect.suspectSummary().windows).toHaveLength(1);
    expect(suspect.suspectSummary().total).toBe(1);
  });

  /** A genuinely SECOND incident — a key rotation during recovery — is a different window and is told. */
  it('reports a second incident as its own window', async () => {
    await household('Ismail');
    reply = { http: 200, body: { ok: true, windows: [{ ...covering(), cause: 'session-expired' }] } };
    await suspect.checkSuspectWindows();

    const later = { from: TS.getTime() + 600_000, to: TS.getTime() + 900_000, count: 1, ids: [], truncated: false, cause: 'key-rejected' };
    reply = { http: 200, body: { ok: true, windows: [{ ...covering(), cause: 'session-expired' }, later] } };
    expect((await suspect.checkSuspectWindows()).newWindows).toBe(1);
    expect(suspect.suspectSummary().windows.map((x) => x.cause).sort()).toEqual(['key-rejected', 'session-expired']);
  });
});

/**
 * NO AGE-BASED GIVE-UP on `status/<id>`, which Kiosk flagged for everyone. Retention used to run from
 * queueing, so a 24-hour cutoff looked reasonable; the platform now keeps a still-queued message's record
 * for as long as it waits, and abandoning it after a day would leave it reading `queued` for ever.
 */
describe('a long-held message is still asked about', () => {
  it('polls a queued row far older than a day', async () => {
    const old = await household('Ismail', { status: 'queued', at: new Date(TS.getTime() - 6 * 86_400_000) });
    app.dbmod.db.update(whatsappLog).set({ platformId: 'wam_held' }).where(eq(whatsappLog.id, old.rowId)).run();
    // The poller correctly no-ops while the feature is off, so it has to be on for this to mean anything.
    await caller('admin').whatsapp.set({ enabled: true });
    whatsapp.resetWhatsAppStatusCache();
    const r = await whatsapp.refreshWhatsappOutcomes();
    // Six days old and still asked about — no cutoff dropped it.
    expect(r.checked).toBe(1);
  });
});
