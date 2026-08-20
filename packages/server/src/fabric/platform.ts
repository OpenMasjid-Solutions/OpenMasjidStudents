// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * Talking TO the OpenMasjidOS platform (CLAUDE.md §12 SSO fast-path). Server-to-server
 * only. The env (base URL + our per-app secret) is read from config, which reads it
 * every process start and never persists it (restore-resilient). All calls fail soft:
 * if the platform is unreachable, the app falls back to local login.
 */
import { config, fabricConfigured } from '../config';
import { makeLog } from '../logger';

/** Platform-call outcomes only — never a request/response body, so no PII and no secrets (§14). */
const log = makeLog('platform');

export interface PlatformProbe {
  /** false only if we tried to reach the platform and could not. */
  reachable: boolean;
  /** Present iff the platform confirms an authenticated dashboard session. */
  username?: string;
}

/**
 * SSO fast-path: forward the visitor's `omos_session` cookie to the platform's
 * session endpoint with our app secret. On {authenticated:true} the caller mints a
 * short-lived local admin session. `username` is an identity signal only — treated as
 * untrusted display text by the caller (§12). ~4s timeout; no redirects.
 */
export async function probePlatformSession(cookieHeader: string | undefined): Promise<PlatformProbe> {
  if (!fabricConfigured()) return { reachable: false };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${config.omosBaseUrl}/api/auth/session`, {
      method: 'GET',
      headers: {
        'X-OpenMasjid-App-Secret': config.omosAppSecret,
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(timer);
    if (!res.ok) return { reachable: true };
    const body = (await res.json()) as { authenticated?: boolean; username?: unknown };
    if (body.authenticated === true) {
      return { reachable: true, username: typeof body.username === 'string' ? body.username : undefined };
    }
    return { reachable: true };
  } catch {
    return { reachable: false };
  }
}

/** A non-secret reference to a Stripe account in the OS vault, for the in-app picker. */
export interface StripeAccountRef {
  id: string;
  label: string;
}

/**
 * List the masjid's Stripe accounts from the OS vault (id + label only, NEVER keys) so the admin can
 * pick which one tuition charges go through — the recommended pattern that keeps install one-click
 * (§10). Server→server, fail-soft → [] when the Fabric isn't configured, the platform is unreachable,
 * or it's an older platform without the endpoint. Never throws.
 */
export async function fetchStripeAccounts(): Promise<StripeAccountRef[]> {
  if (!fabricConfigured()) return [];
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/stripe/accounts`, {
      headers: { 'X-OpenMasjid-App-Secret': config.omosAppSecret },
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const j = (await res.json().catch(() => null)) as { accounts?: unknown } | null;
    const list = Array.isArray(j?.accounts) ? j!.accounts : [];
    return list
      .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object' && typeof (a as { id?: unknown }).id === 'string')
      .map((a) => ({ id: String(a.id), label: typeof a.label === 'string' && a.label ? a.label.slice(0, 80) : String(a.id) }));
  } catch {
    return [];
  }
}

// ── Our public address (manifest `domain: true`) ─────────────────────────────
/**
 * `GET /api/fabric/site` is the LIVE source of truth for our public URL; `OPENMASJID_PUBLIC_URL` is
 * only a convenience mirror the platform writes at install time, and it is empty until an admin
 * actually exposes the app. Invite and reset links are useless without an absolute, off-network URL,
 * so we ask the platform rather than trusting the mirror alone.
 *
 * Cached, because link minting is synchronous and must not await a network hop.
 */
export interface SiteInfo {
  enabled: boolean;
  publicUrl: string;
  basePath: string;
}

let siteCache: { at: number; info: SiteInfo } | null = null;
const SITE_TTL_MS = 60_000;

/** Refresh the cached site info. Called on boot and by the scheduler; safe to call any time. */
export async function refreshSiteInfo(): Promise<SiteInfo | null> {
  if (!fabricConfigured()) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/site`, {
      headers: { 'X-OpenMasjid-App-Secret': config.omosAppSecret },
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(timer);
    // 403 = we didn't declare `domain: true`, or the platform predates the endpoint. Either way the
    // env mirror is all we have; don't cache a failure as "no public URL".
    if (!res.ok) return null;
    const j = (await res.json().catch(() => null)) as { enabled?: unknown; publicUrl?: unknown; basePath?: unknown } | null;
    if (!j) return null;
    const info: SiteInfo = {
      enabled: j.enabled === true,
      publicUrl: typeof j.publicUrl === 'string' ? j.publicUrl : '',
      basePath: typeof j.basePath === 'string' ? j.basePath : '',
    };
    siteCache = { at: Date.now(), info };
    return info;
  } catch {
    return null;
  }
}

/** The cached public URL, or '' when we've never learned one. Sync — never blocks. */
export function cachedPublicUrl(): string {
  if (!siteCache) return '';
  // A stale value is still far better than none for minting a link; we just stop trusting it as
  // "definitely current" and let the scheduler refresh it.
  return siteCache.info.publicUrl;
}

// ── Email via the platform (manifest `email: true`) ───────────────────────────
/**
 * Send one transactional email through the masjid's OpenMasjidOS mail provider. This is the ONLY way
 * this app sends mail — it has no SMTP of its own and holds no mail credentials; the OS owns the
 * provider and the From address, so a masjid configures email once, there.
 *
 * Fail-soft and never throws — the caller treats `false` as "not sent" and degrades to a copy/print
 * link. Bodies are never logged.
 *
 * A 200 does NOT mean it sent. The platform answers `{ sent: true }` or `{ sent: false, reason }`
 * — HTTP 200 either way — because "the masjid has not configured a mail provider" is a normal
 * state, not a transport error. So we MUST read the body: trusting the status code would report a
 * suppressed invite as delivered, which is the exact silent failure this whole path exists to
 * remove. `reason` is a fixed enum from the platform (`not_configured`, `bad_recipient`, `empty`,
 * `rate_limited`, `error`) and carries no message content, so it is safe to log.
 */
export async function sendPlatformEmail(to: string, subject: string, text: string, html?: string): Promise<boolean> {
  if (!fabricConfigured()) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-OpenMasjid-App-Secret': config.omosAppSecret },
      body: JSON.stringify({ to, subject, text, ...(html ? { html } : {}) }),
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(timer);
    // 403 = we don't hold the `email` capability yet (the catalog entry predates it); 4xx/5xx = a
    // real transport failure. Both are "not sent", with no body worth trusting.
    if (!res.ok) {
      log.warn('platform email rejected', { status: res.status });
      return false;
    }
    const j = (await res.json().catch(() => null)) as { sent?: unknown; reason?: unknown } | null;
    if (j?.sent === true) return true;
    log.warn('platform email not sent', { reason: typeof j?.reason === 'string' ? j.reason : 'unknown' });
    return false;
  } catch {
    return false;
  }
}

// ── WhatsApp via the platform (manifest `whatsapp: true`) ────────────────────
/**
 * WhatsApp is the OS's connection, never ours (0.50.0).
 *
 * A masjid installs OpenWA — a SELF-HOSTED, reverse-engineered WhatsApp client — from the App Store
 * and links a phone to it. Nothing goes through a third-party sending service, and nothing here holds
 * a session. This app asks the platform to send; the platform owns the socket.
 *
 * WHY THAT SEPARATION IS LOAD-BEARING AND NOT PLUMBING. WhatsApp does not permit this, and a linked
 * number can be restricted or banned — there is no way to make that risk zero. The platform runs ONE
 * paced queue shared by every installed app: randomised gaps, typing indicators, per-recipient
 * cooldowns, rolling hourly and daily caps, quiet hours. That single queue is the entire defense for
 * the masjid's number, and it only works because no app goes around it. So: no direct gateway calls
 * from here, ever, and no design that assumes a send happens now or that hundreds a day are available
 * — the caps belong to the NUMBER, and every other installed app is drawing on the same allowance.
 */
/**
 * The four words the PLATFORM answers with, plus two of our own for the ways the call itself fails.
 *
 * `not-permitted` and `unsupported` exist because collapsing them into `not-configured` was a real
 * defect, not a simplification (fixed 0.50.0-dev.6). The code did exactly that, under a comment
 * claiming both "mean the same thing to an admin standing in front of the screen" — and they do not:
 *
 *   • `not-configured` sends an admin to OpenMasjidOS → Settings → WhatsApp to set the gateway up.
 *   • `not-permitted` (403) means the gateway is fine and THIS APP is not allowed to use it —
 *     the platform checks `app.whatsapp` on the entry the masjid installed from, exactly as it does
 *     for alert ids (§9). Nothing in OpenMasjidOS → Settings will fix that.
 *
 * That third case turned out to be REAL on the first install, and it is worth recording because two of
 * the three repos involved were innocent: this app declared `whatsapp: true` correctly, OpenMasjidOS
 * gated on `app.whatsapp` correctly — and `OpenMasjidAPPS`'s catalog builder copied capabilities
 * through a hand-maintained allow-list with no `whatsapp` line, so the key never reached
 * `catalog.json` and the platform correctly refused an app that, as far as it could see, had never
 * asked. `email` surviving while `whatsapp` vanished was the entire diagnosis, and the `source` +
 * `httpStatus` fields below are what made it findable from here at all.
 *
 * Fixed at the source (catalog `364f91b`): one shared capability list the builder type-checks and
 * copies from, plus a test that holds the documented manifest template against a built entry in both
 * directions. Declaring a capability is still necessary and never sufficient — verify against the
 * BUILT entry, never against our own manifest.
 *   • `unsupported` (404/405) means the platform predates the endpoint.
 *
 * A masjid with a working, linked gateway was told their server had no WhatsApp set up, and went and
 * checked a setting that was already correct. Guessing wrong in an error message costs somebody an
 * evening; the fix is to stop guessing and say which signal actually came back.
 */
export type WhatsAppReason = 'ready' | 'not-configured' | 'not-linked' | 'unreachable' | 'not-permitted' | 'unsupported';

/** The words the platform itself may send. Anything else on the wire is not trusted as a reason. */
const PLATFORM_REASONS = ['ready', 'not-configured', 'not-linked', 'unreachable'] as const;

export interface WhatsAppStatus {
  available: boolean;
  /** Each one needs different copy from us — see whatsapp/index.ts and the settings screen. */
  reason: WhatsAppReason;
  /**
   * WHERE the reason came from, which is the diagnostic that matters when a screen and a server
   * disagree: `platform` means OpenMasjidOS said this in a 200 response, `http` means we inferred it
   * from a status code, `local` means we never got as far as asking.
   */
  source: 'platform' | 'http' | 'local';
  /** The HTTP status, when there was one. Shown to an admin verbatim — it is the difference between
   *  "your gateway is off" and "this app was refused", and no amount of prose substitutes for it. */
  httpStatus?: number;
  /**
   * Can this platform tell us what became of a message? (0.51.0, OpenMasjidOS 0.51.1+.)
   *
   * ABSENT MEANS FALSE, which is the platform's stated convention for a capability flag (the same one
   * `media` uses) and the only safe reading: an older platform says nothing here, and treating silence
   * as support would have the settings screen promise an office a delivery state that never arrives.
   */
  outcomes: boolean;
}

/** Can this masjid send WhatsApp at all? Fail-soft: anything unexpected reads as `unreachable`, which
 *  is the state that tells an admin to go and look rather than implying they never set it up. */
export async function whatsappStatus(): Promise<WhatsAppStatus> {
  if (!fabricConfigured()) return { available: false, reason: 'not-configured', source: 'local', outcomes: false };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/whatsapp`, {
      headers: { 'X-OpenMasjid-App-Secret': config.omosAppSecret },
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(timer);
    if (!res.ok) {
      log.warn('whatsapp status rejected', { status: res.status });
      const reason: WhatsAppReason = res.status === 403 ? 'not-permitted' : res.status === 404 || res.status === 405 ? 'unsupported' : 'unreachable';
      return { available: false, reason, source: 'http', httpStatus: res.status, outcomes: false };
    }
    const j = (await res.json().catch(() => null)) as { available?: unknown; reason?: unknown; outcomes?: unknown } | null;
    const said = typeof j?.reason === 'string' && (PLATFORM_REASONS as readonly string[]).includes(j.reason) ? (j.reason as WhatsAppReason) : null;
    // A 200 with a reason we don't recognize is the platform talking to a client that is out of date,
    // not a gateway problem — `unreachable` is the honest fallback and never claims "not set up".
    return { available: j?.available === true, reason: said ?? 'unreachable', source: 'platform', httpStatus: res.status, outcomes: j?.outcomes === true };
  } catch {
    return { available: false, reason: 'unreachable', source: 'local', outcomes: false };
  }
}

/**
 * What happened when we handed one message over. `queued` is NOT `sent` — see `sendPlatformWhatsApp`.
 *
 * `id` (0.51.0) is the platform's own message id, returned alongside the 202 from OpenMasjidOS 0.51.1
 * onward. It is the handle for `whatsappMessageStatus`, and it is the difference between a log that
 * ends at "we handed it over" and one that can say what became of it. Absent on an older platform,
 * which is why every consumer treats it as optional rather than assuming it.
 */
export type WhatsAppQueueResult = { queued: true; note?: string; id?: string } | { queued: false; reason: string };

/** Where a message actually got to. `expired` is the platform dropping one it held over 24 hours. */
export type WhatsAppMessageState = 'queued' | 'sent' | 'failed' | 'expired';

/**
 * The outcome of one message, or why we could not find out.
 *
 * `unknown` is deliberately not an error state and must not be retried forever: the platform keeps
 * only the 200 most recent outcomes and scopes them to the asking app, so a 404 means "past the end
 * of that buffer, or never ours" — both of which are permanent answers to the question we asked.
 */
export type WhatsAppMessageStatus =
  | { ok: true; state: WhatsAppMessageState; reason: string | null; at: string | null }
  | { ok: false; unknown: true }
  | { ok: false; unknown: false; reason: string };

/**
 * What did the platform actually SAY? (0.51.0)
 *
 * `res.ok` was the whole test, and it turned two different answers into one. The contract is
 * `202 {"queued": true}` — so a 200, a 204, or a 202 whose body says `queued: false` all read as a
 * successful hand-over, and the queue log then said `queued` for a message the platform had not
 * taken. That is the exact shape of the fault that is impossible to diagnose from this side: our
 * records say we handed it over, and there is nothing anywhere to contradict them.
 *
 * So: an explicit `queued: false` is a FAILURE however it is dressed, and any success that is not
 * the documented 202 is queued-but-noted, with the status recorded in the log. `note` is deliberately
 * not an error — an OS that starts answering 200 must not stop this app sending — but it stops the
 * log from asserting something nobody checked.
 */
async function readQueueAnswer(res: Response): Promise<WhatsAppQueueResult> {
  if (!res.ok && res.status !== 202) return { queued: false, reason: `http_${res.status}` };
  const body = (await res.json().catch(() => null)) as { queued?: unknown; reason?: unknown; id?: unknown } | null;
  // The platform saying so outright beats any inference from the status code.
  if (body && body.queued === false) {
    const said = typeof body.reason === 'string' ? body.reason.slice(0, 40).replace(/[^a-z0-9_-]/gi, '') : '';
    return { queued: false, reason: said ? `refused_${said}` : `refused_${res.status}` };
  }
  // 0.51.1+ returns an id alongside the 202. Bounded and character-checked before it goes anywhere
  // near a URL path — it is about to be interpolated into one (`whatsappMessageStatus`).
  const id = typeof body?.id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(body.id) ? body.id : undefined;
  return res.status === 202 ? { queued: true, id } : { queued: true, note: `http_${res.status}`, id };
}

/**
 * What became of one message we handed over (0.51.0, needs OpenMasjidOS 0.51.1+).
 *
 * This closes the hole that made a real outage undiagnosable. A masjid turned WhatsApp on, every send
 * was accepted, and nothing arrived for more than a day — and because a 202 was the end of what this
 * app could know, our records and the office's screen both said "queued" with total confidence and no
 * way to be contradicted. (The cause was platform-side, and needed the platform's own logs to find.)
 *
 * Deliberately quiet about failure. This is a polled, best-effort enrichment of a log, not a step in
 * any flow — nothing waits on it and nothing is retried because of it, so an unreachable platform
 * simply leaves rows as they were.
 */
export async function whatsappMessageStatus(id: string): Promise<WhatsAppMessageStatus> {
  if (!fabricConfigured()) return { ok: false, unknown: false, reason: 'no_fabric' };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/whatsapp/status/${encodeURIComponent(id)}`, {
      headers: { 'X-OpenMasjid-App-Secret': config.omosAppSecret },
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(timer);
    // 404 is "no longer in the platform's 200-message buffer, or never ours" — a permanent answer, not
    // a transient one, so the caller stops asking rather than polling this id for ever.
    if (res.status === 404) return { ok: false, unknown: true };
    // A platform that has never heard of this route (older than 0.51.1) answers 404/405. The 404 above
    // catches the first, and 405 lands here as an ordinary failure, which is the right shape: nothing
    // is known and nothing is claimed.
    if (!res.ok) return { ok: false, unknown: false, reason: `http_${res.status}` };
    const j = (await res.json().catch(() => null)) as { state?: unknown; reason?: unknown; at?: unknown } | null;
    const states: WhatsAppMessageState[] = ['queued', 'sent', 'failed', 'expired'];
    if (!j || typeof j.state !== 'string' || !states.includes(j.state as WhatsAppMessageState)) {
      return { ok: false, unknown: false, reason: 'bad_shape' };
    }
    return {
      ok: true,
      state: j.state as WhatsAppMessageState,
      // Bounded and stripped: it lands in a log column and then on a screen.
      reason: typeof j.reason === 'string' && j.reason ? j.reason.slice(0, 60) : null,
      at: typeof j.at === 'string' && j.at ? j.at.slice(0, 40) : null,
    };
  } catch {
    return { ok: false, unknown: false, reason: 'unreachable' };
  }
}

/** A group the masjid's admin approved this app to post into. A label and an opaque id, nothing else —
 *  the platform never exposes the masjid's other groups, and we never learn who is in one. */
export interface WhatsAppGroup {
  id: string;
  label: string;
}

/**
 * The answer to "which groups may I post into?", with "I could not ask" kept SEPARATE from "none".
 *
 * Those two used to be the same empty array, and three things went wrong downstream, all of them the
 * kind that only shows up on a bad day:
 *
 *   • the screen hid the Groups section entirely, so a momentary platform hiccup looked exactly like
 *     an admin who had approved nothing — no error, no retry, just a feature that was there yesterday;
 *   • `groupSet` told an admin "that group isn't approved in OpenMasjidOS", sending them off to fix
 *     something that was not broken;
 *   • and nothing could ever say "you are still subscribed to a group that is no longer approved",
 *     because a withdrawn group and an unreachable platform were indistinguishable — see
 *     `trpc/whatsapp.ts` `groups`, where that distinction is what makes a stale row safe to show.
 *
 * A 429 makes this more than theoretical: the platform's Fabric limiter is per-IP across ALL of
 * `/api/fabric/*` (status, groups, send, Stripe keys, record-payment share one 120/min bucket), and it
 * answers `{ groups: [] }` with no error field at all. "Empty" is genuinely ambiguous on the wire.
 */
export type WhatsAppGroupList = { ok: true; groups: WhatsAppGroup[] } | { ok: false; reason: string };

/**
 * The groups an admin has approved for THIS app.
 *
 * The list is authorization, not decoration: an id we did not get from here is refused with 403, and
 * approval can be withdrawn at any moment. A confirmed-empty list means "no groups available" and the
 * feature is hidden rather than shown broken — the platform's own guidance, and the right shape for a
 * permission that is somebody else's to give.
 *
 * Still fail-soft — it never throws — but the failure is now reported rather than disguised as "none".
 */
export async function whatsappGroups(): Promise<WhatsAppGroupList> {
  if (!fabricConfigured()) return { ok: false, reason: 'no_platform' };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/whatsapp/groups`, {
      headers: { 'X-OpenMasjid-App-Secret': config.omosAppSecret },
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(timer);
    if (!res.ok) {
      // Status only — the body carries the masjid's own group nicknames (§14).
      log.warn('whatsapp groups rejected', { status: res.status });
      return { ok: false, reason: `http_${res.status}` };
    }
    const j = (await res.json().catch(() => null)) as { groups?: unknown } | null;
    // A 200 whose body is not the documented shape is a failure, not an empty list. Reading a
    // malformed answer as "no groups approved" is how a stale subscription would silently look
    // withdrawn — the one reading this code must not make.
    if (!j || !Array.isArray(j.groups)) return { ok: false, reason: 'bad_shape' };
    const groups = j.groups
      .filter((g): g is Record<string, unknown> => !!g && typeof g === 'object' && typeof (g as { id?: unknown }).id === 'string')
      .map((g) => ({ id: String(g.id), label: typeof g.label === 'string' && g.label ? g.label.slice(0, 120) : String(g.id) }));
    return { ok: true, groups };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

/**
 * Post ONE announcement into ONE approved group.
 *
 * A SEPARATE FUNCTION from `sendPlatformWhatsApp`, deliberately, and this is the enforcement rather
 * than a note in a document: the platform's rule is that a group post is for genuine announcements and
 * must never carry a family's own business, because their fees are not the other 199 members'. Every
 * per-family path in this app calls `sendPlatformWhatsApp`, which has no parameter that could name a
 * group — so a receipt cannot reach a group even by mistake, and the wall is in the type system.
 *
 * The wire shape is the same endpoint with `group` in place of `to`; sending both is a 400 by design,
 * which is another reason these are two functions and not one with an optional field.
 */
export async function sendPlatformWhatsAppGroup(groupId: string, text: string): Promise<WhatsAppQueueResult> {
  if (!fabricConfigured()) return { queued: false, reason: 'no_fabric' };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-OpenMasjid-App-Secret': config.omosAppSecret },
      body: JSON.stringify({ group: groupId, text }),
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(timer);
    const answer = await readQueueAnswer(res);
    // 403 here is specifically "that group is not approved (any more)" — an authorization answer, not
    // a malformed request, and the screen should tell an admin to re-approve it rather than hunt a bug.
    if (!answer.queued) log.warn('whatsapp group post rejected', { status: res.status, reason: answer.reason });
    return answer;
  } catch {
    return { queued: false, reason: 'unreachable' };
  }
}

/**
 * Hand ONE message for ONE recipient to the platform's queue.
 *
 * `to` must already be E.164 (`+15550101234`) — whatsapp/numbers.ts is the one place that gets a
 * stored number into that shape. One recipient per call is the API's design, not a limitation to work
 * around: the queue paces a loop correctly, and "one parent at a time" is the shape this whole feature
 * is supposed to have.
 *
 * A 202 means QUEUED, and the gap between that and delivery is larger than it sounds. The platform
 * serializes every sender behind one queue with a randomised 6–20s gap, a 60s per-recipient cooldown,
 * caps of 12/hour and 60/day (4/hour and 10/day for groups), a seven-day warm-up ramp on a freshly
 * linked number — and **quiet hours, 21:00–07:00 by default, checked FIRST**. A receipt queued at
 * 03:00 is held until 07:00. It is never dropped, but nothing may block on this, and no screen may
 * ever say "sent" on the strength of a 202 (see the settings copy, which says so in plain words).
 *
 * The BODY IS NEVER LOGGED, on any path including the failures — it routinely carries a child's name
 * and a family's fees (§14). Status codes and counts only.
 */
export async function sendPlatformWhatsApp(to: string, text: string): Promise<WhatsAppQueueResult> {
  if (!fabricConfigured()) return { queued: false, reason: 'no_fabric' };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-OpenMasjid-App-Secret': config.omosAppSecret },
      body: JSON.stringify({ to, text }),
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(timer);
    const answer = await readQueueAnswer(res);
    // 400 bad number / empty text / no gateway / queue full · 403 we didn't declare `whatsapp: true`
    // · 429 slow down. All four are the platform protecting the masjid's number; none is retried here.
    if (!answer.queued) log.warn('whatsapp queue rejected', { status: res.status, reason: answer.reason });
    return answer;
  } catch {
    return { queued: false, reason: 'unreachable' };
  }
}

// ── Admin alerts (manifest `alerts:`) ────────────────────────────────────────
/** The alert ids we declare in manifest.yaml. Declaring one IS the authorization — the platform
 *  refuses any id an app didn't declare — and the admin picks email/webhook/off per alert. */
export type AlertId = 'autopay-disabled' | 'lookup-lockout' | 'reconcile-recovered' | 'payment-short' | 'past-due' | 'payment-refunded' | 'test';

/** The platform's alert severities. Note these are NOT `notifyPlatform`'s levels — that endpoint
 *  takes `warn`, this one takes `warning`, and sending the wrong word silently downgrades to the
 *  platform's default. */
export type AlertLevel = 'info' | 'success' | 'warning' | 'error';

/**
 * Raise an admin alert. Unlike `notifyPlatform` (webhook only, and silently dead until an admin
 * configures one), an alert can reach the admin's EMAIL as well, which is why the security-relevant
 * events use this. Fail-soft; a muted alert is normal, not an error.
 *
 * The id field on the wire is `alert`, NOT `id` — the platform reads `body.alert` and 400s when it
 * is missing, so getting this wrong makes every alert vanish (fail-soft hides it completely).
 * The id must also be declared in our manifest `alerts:` list AND present in the CATALOG entry the
 * platform installed us from: declaring a new id here does nothing until the release + registry
 * bump lands, and until then the platform answers 400 "Unknown alert".
 */
export async function raiseAlert(id: AlertId, text: string, opts: { title?: string; level?: AlertLevel } = {}): Promise<boolean> {
  if (!fabricConfigured()) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/alert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-OpenMasjid-App-Secret': config.omosAppSecret },
      body: JSON.stringify({ alert: id, text, title: opts.title, level: opts.level ?? 'warning' }),
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(timer);
    if (!res.ok) {
      // 400 = an id the installed catalog entry doesn't declare; 403 = no secret match.
      log.warn('platform alert rejected', { alert: id, status: res.status });
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Fire a notification to the masjid webhook via the OS core (CLAUDE.md §4 — payments, autopay
 * failures, Student-ID lookup lockouts). The OS `/api/fabric/notify` contract is
 * `{ title?, text (required), level? }` (verified against the platform code). Best-effort: no-op when
 * the platform isn't wired in, never throws. `text` MUST NOT carry PII (never a name+amount pair, §14).
 *
 * Prefer `raiseAlert` for anything security-relevant: this endpoint is webhook-only and silently dead
 * until an admin configures one, whereas an alert can reach their email.
 */
export async function notifyPlatform(text: string, opts: { title?: string; level?: 'info' | 'warn' | 'error' } = {}): Promise<void> {
  if (!fabricConfigured()) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    await fetch(`${config.omosBaseUrl}/api/fabric/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-OpenMasjid-App-Secret': config.omosAppSecret },
      body: JSON.stringify({ text, title: opts.title, level: opts.level }),
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(timer);
  } catch {
    /* best-effort — a missed notification is never a failure of the operation that triggered it */
  }
}
