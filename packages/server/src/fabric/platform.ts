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
 * cooldowns, rolling hourly and daily caps, quiet hours. That single queue is the entire defence for
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
}

/** Can this masjid send WhatsApp at all? Fail-soft: anything unexpected reads as `unreachable`, which
 *  is the state that tells an admin to go and look rather than implying they never set it up. */
export async function whatsappStatus(): Promise<WhatsAppStatus> {
  if (!fabricConfigured()) return { available: false, reason: 'not-configured', source: 'local' };
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
      return { available: false, reason, source: 'http', httpStatus: res.status };
    }
    const j = (await res.json().catch(() => null)) as { available?: unknown; reason?: unknown } | null;
    const said = typeof j?.reason === 'string' && (PLATFORM_REASONS as readonly string[]).includes(j.reason) ? (j.reason as WhatsAppReason) : null;
    // A 200 with a reason we don't recognise is the platform talking to a client that is out of date,
    // not a gateway problem — `unreachable` is the honest fallback and never claims "not set up".
    return { available: j?.available === true, reason: said ?? 'unreachable', source: 'platform', httpStatus: res.status };
  } catch {
    return { available: false, reason: 'unreachable', source: 'local' };
  }
}

/** What happened when we handed one message over. `queued` is NOT `sent` — see `sendPlatformWhatsApp`. */
export type WhatsAppQueueResult = { queued: true } | { queued: false; reason: string };

/**
 * Hand ONE message for ONE recipient to the platform's queue.
 *
 * `to` must already be E.164 (`+15550101234`) — whatsapp/numbers.ts is the one place that gets a
 * stored number into that shape. One recipient per call is the API's design, not a limitation to work
 * around: the queue paces a loop correctly, and "one parent at a time" is the shape this whole feature
 * is supposed to have.
 *
 * A 202 means QUEUED. Delivery is seconds to minutes away, and hours if it lands in the masjid's quiet
 * hours. Nothing may block on this, and no screen may ever say "sent" on the strength of it.
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
    if (res.status === 202 || res.ok) return { queued: true };
    // 400 bad number / empty text / no gateway / queue full · 403 we didn't declare `whatsapp: true`
    // · 429 slow down. All four are the platform protecting the masjid's number; none is retried here.
    log.warn('whatsapp queue rejected', { status: res.status });
    return { queued: false, reason: `http_${res.status}` };
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
