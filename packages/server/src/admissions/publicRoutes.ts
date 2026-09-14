// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * THE PUBLIC ADMISSIONS INQUIRY FORM — the only unauthenticated write surface in this project, and it
 * stays that way (0.52.0, CLAUDE.md §4a Phase 2 / §12.4 / §14, docs/ADMISSIONS.md §2).
 *
 * Plain Fastify routes registered before the SPA fallback, alongside `/fabric/*` and the printable
 * documents, and OUTSIDE the tRPC role/origin middleware entirely. **There are no Fastify hooks in
 * this repo** — nothing is applied globally to a plain route, not origin classification, not rate
 * limiting, not security headers — so every control below is written out here rather than inherited,
 * which is exactly why §14 states each one separately instead of saying "the usual".
 *
 * ── Reachable from LAN AND tunnel, with no session. That is the point of it ──
 *
 * The origin table gains a row and nothing else moves: admin is still refused over the tunnel at
 * login and at session use, and READING an inquiry inside the app is `adminProcedure` and therefore
 * LAN-only. `cf-ray` short-circuits before the client IP is examined, so a phone on the masjid Wi-Fi
 * that opened the bookmarked public URL is `tunnel` — which is why these routes do not look at the
 * origin at all rather than trying to be clever about it.
 *
 * This is NOT a Fabric capability and must never live under `/fabric/*`, whose whole shape —
 * secret-gated, LAN-only, 404 over the tunnel — is the opposite of what a public form needs (§11.1).
 *
 * ── THE ONE RESPONSE ────────────────────────────────────────────────────────
 *
 * `POST /public/inquiry` answers `200 {"ok":true}` and NOTHING ELSE, whatever happened: stored,
 * recognized as a repeat, missing a required field, tripped the honeypot, filled in faster than a
 * person can type, over one source's rate limit, over the install's ceiling for the day, or arriving
 * after the office closed intake. Six of those seven store nothing.
 *
 * That is not politeness, it is the same no-enumeration rule `lookup` follows (§11.2) applied to a
 * surface with no lockout behind it: any difference in body, status or shape answers "is this child,
 * this email, this family already known to you?" for anybody who cares to ask. The page shows the
 * madrasah's own thank-you, which it already has, so the response carries no text to differ in.
 *
 * ── Layered anti-abuse, none of which needs the internet ────────────────────
 *
 * A masjid with no outbound connectivity must still be able to take an inquiry, so there is no
 * captcha by default and no third-party anything. What there is instead: a honeypot field; a minimum
 * time-to-submit carried in a SIGNED token, because an unsigned timestamp is a number a bot edits; a
 * per-source rate limit whose key is folded to a /64 (0.52.0-dev.6 — an evicting map used to forgive
 * exactly the flood a public form invites); server-side field caps; a body cap on the route itself,
 * far under the app's 1 MiB; and a whole-install ceiling for the day, because nothing else bounds
 * what a thousand sources do between them and a flooded office is a broken office.
 *
 * ── Nothing submitted reaches a log line ────────────────────────────────────
 *
 * Not the name, the email, the message, or a truncated preview. The route logs an outcome word and
 * counts. §14's no-PII rule, plus one addition worth saying out loud: this body is attacker-
 * controlled, so logging it would also make the log a place to inject.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { makeLog } from '../logger';
import { esc } from '../billing/statements';
import { alertStaff } from '../alerts';
import { DailyCeiling, SubmitLimiter } from '../security/rateLimit';
import { rateLimitKey } from '../security/origin';
import { config } from '../config';
import { getAccentColor, getAdmissions, getSchoolLogo, getSchoolName, getSetting, parseLogoDataUri, setSetting } from '../settings';
import { INQUIRY_CAPS, storeInquiry } from './inquiry';
import { admissionsTextHtml, admissionsTextPlain } from './text';
import { READMISSION_CAPS, READMISSION_FIELDS, readmissionByToken, submitReadmission } from './readmission';

/** Ids and outcome words only — never a name, an address or a body (§14). */
const log = makeLog('admissions');

/**
 * Per-source cap. Deliberately not tight: a household with several children genuinely submits three
 * forms in one sitting, and a whole madrasah can sit behind one address. What this stops is a script,
 * and the install-wide ceiling is what stops a thousand scripts.
 */
const inquiryLimiter = new SubmitLimiter(10, 60 * 60_000); // 10 / hour per /64

/** The whole-install ceiling for one day; its size is the office's setting, read at each call. */
const inquiryCeiling = new DailyCeiling();

/** How long a rendered form stays submittable. Generous — a tab left open over a weekend is not an
 *  attack — and bounded so a token minted once is not good forever. */
const FORM_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The route's own body cap, far under the app-wide 1 MiB (index.ts). The largest honest submission
 *  is a 2,000-character message plus six short fields; 16 KiB is generous for that and refuses a
 *  megabyte of JSON before it is ever parsed. */
const BODY_LIMIT = 16 * 1024;

/**
 * The key that signs a form's render time.
 *
 * Stored rather than generated per process, and that is a deliberate correction of the obvious
 * design: a per-process secret means a restart between opening the form and submitting it turns a
 * real family's inquiry into a silently discarded one, and — because the response cannot differ —
 * they would never find out. Generated once, lazily, so no install carries it until the form is
 * first used.
 *
 * It authenticates nothing and grants nothing: all it does is stop a bot editing a timestamp. The
 * database file is already a secret whatever is in it (§9).
 */
const FORM_SECRET_KEY = 'admissions_form_secret';

function formSecret(): string {
  const existing = getSetting(FORM_SECRET_KEY);
  if (existing && existing.length >= 32) return existing;
  const fresh = randomBytes(32).toString('base64url');
  setSetting(FORM_SECRET_KEY, fresh);
  return fresh;
}

function signStamp(ms: number): string {
  return createHmac('sha256', formSecret()).update(String(ms)).digest('base64url');
}

export function mintFormToken(now = Date.now()): string {
  return `${now}.${signStamp(now)}`;
}

/** Was this form rendered by us, long enough ago to have been filled in by a person, and recently
 *  enough to still count? Any answer but yes is a silent drop. */
export function formTokenOk(token: string, minSeconds: number, now = Date.now()): boolean {
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const ms = Number(token.slice(0, dot));
  if (!Number.isFinite(ms)) return false;
  const given = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(signStamp(ms));
  // Constant-time, like every other secret compare in this app — the signature is short and the
  // comparison is cheap, and doing it the careless way here would be the one place it is not obvious.
  if (given.length !== want.length || !timingSafeEqual(given, want)) return false;
  const age = now - ms;
  if (age < minSeconds * 1000) return false; // filled in faster than a person types
  if (age > FORM_TOKEN_TTL_MS) return false;
  return true;
}

/**
 * Where the browser must POST, and where the embed's iframe must point.
 *
 * Absolute-from-the-root and carrying the tunnel's path prefix, because `rewriteUrl` strips that
 * prefix before routing (index.ts) — so every route in this app is written at the root while the
 * browser's address bar is not. A relative URL would be wrong on the embed page, whose path has one
 * more segment than the route it has to reach.
 */
const POST_PATH = `${config.basePath}/public/inquiry`;
const EMBED_PATH = `${config.basePath}/public/inquiry/embed`;

/**
 * The submitted shape. Every field capped, nothing required at this layer — `isSubmittable` decides
 * what is worth storing, and a missing field is dropped with the same acknowledgement as everything
 * else rather than answered with a validation error a caller could learn from.
 */
const BODY = z.object({
  childName: z.string().max(INQUIRY_CAPS.childName * 2).optional(),
  childDob: z.string().max(40).optional(),
  askedAbout: z.string().max(INQUIRY_CAPS.askedAbout * 2).optional(),
  parentName: z.string().max(INQUIRY_CAPS.parentName * 2).optional(),
  email: z.string().max(INQUIRY_CAPS.email * 2).optional(),
  phone: z.string().max(INQUIRY_CAPS.phone * 2).optional(),
  message: z.string().max(INQUIRY_CAPS.message * 2).optional(),
  /** The honeypot. Named like something a form filler wants to complete, hidden from people, and any
   *  value at all in it means this was not a person. */
  website: z.string().max(200).optional(),
  /** The signed render time. */
  t: z.string().max(200).optional(),
});

/** The acknowledgement. One frozen string, so there is nothing to accidentally vary. */
const ACK = JSON.stringify({ ok: true });

function sendAck(reply: FastifyReply): FastifyReply {
  return reply
    .code(200)
    .header('content-type', 'application/json; charset=utf-8')
    .header('cache-control', 'no-store')
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'no-referrer')
    .send(ACK);
}

/**
 * The CSP for the form page.
 *
 * NOT `STATEMENT_CSP`, and not a widened copy of it: that constant sets `frame-ancestors 'none'` and
 * `form-action 'none'`, which are the exact opposites of what an embeddable form needs, and
 * `statementRoute.test.ts` asserts all four of its directives verbatim because widening it widens the
 * route that prints every child's Student ID (§14).
 *
 * `frameAncestors` is the caller's decision: `'none'` for the hosted page, the office's allowlist for
 * the embed target. The allowlist is re-validated on read in `getAdmissions`, so `*` cannot reach
 * here — an entry that is not a bare scheme-and-host is dropped rather than repaired.
 */
function pageCsp(frameAncestors: string): string {
  return [
    "default-src 'none'",
    'img-src data:', // the inlined logo, magic-byte checked on the way out — nothing remote
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'", // the submit handler; there is no JSON body parser without fetch
    "connect-src 'self'", // ...and it posts back here and nowhere else
    "form-action 'none'",
    `frame-ancestors ${frameAncestors}`,
    "base-uri 'none'",
  ].join('; ');
}

/** The office's allowlist as a CSP source list, or `'none'` when they have allowlisted nobody. */
function frameAncestorsFor(origins: string[]): string {
  return origins.length ? origins.join(' ') : "'none'";
}

function logoTag(): string {
  const raw = getSchoolLogo();
  const parsed = raw ? parseLogoDataUri(raw) : null;
  if (!parsed) return '';
  // Re-validated on the way OUT rather than trusted from the settings row, exactly as `/api/logo`
  // does — this lands inside an `<img>` on a page a stranger's browser renders.
  const uri = `data:${parsed.mime};base64,${parsed.bytes.toString('base64')}`;
  return `<img class="logo" alt="" src="${esc(uri)}">`;
}

/**
 * THE FIXED FIELD SET (decision 9: fixed, not configurable — a configurable public form is a
 * configurable attack surface). The office may change what the page SAYS, never what it asks.
 *
 * English literals rather than i18next keys, like every other server-rendered document in this app
 * (`billing/statements.ts`, `people/idSheet.ts`): i18next lives in the browser bundle, and this page
 * is assembled server-side and served to somebody who has not loaded the app. The PROSE around them
 * is the madrasah's own (`admissions/text.ts`), which is the part that actually needed a voice.
 */
const FIELDS: { name: string; label: string; type: string; cap: number; required?: boolean; multiline?: boolean }[] = [
  { name: 'childName', label: 'Child’s name', type: 'text', cap: INQUIRY_CAPS.childName, required: true },
  { name: 'childDob', label: 'Date of birth (optional)', type: 'date', cap: INQUIRY_CAPS.childDob },
  { name: 'askedAbout', label: 'What are you asking about? (optional)', type: 'text', cap: INQUIRY_CAPS.askedAbout },
  { name: 'parentName', label: 'Your name', type: 'text', cap: INQUIRY_CAPS.parentName, required: true },
  { name: 'email', label: 'Email', type: 'email', cap: INQUIRY_CAPS.email },
  { name: 'phone', label: 'Phone', type: 'tel', cap: INQUIRY_CAPS.phone },
  { name: 'message', label: 'Anything you would like to tell us (optional)', type: 'text', cap: INQUIRY_CAPS.message, multiline: true },
];

/**
 * The page, whole. Assembled server-side and escaped, like every other document this app serves.
 *
 * No JavaScript from anywhere but this file, no font, no stylesheet, no image that is not a data URI
 * — partly because the CSP above says so, and partly because this page is the one thing a masjid
 * embeds in a site we know nothing about. It has to be small, self-contained and impossible to blame.
 *
 * It POSTS JSON with `fetch` rather than being a plain HTML form, and that is forced: the app
 * registers a parser for `application/json` ONLY, so a urlencoded form post is answered 415 by
 * Fastify before any handler runs — a different response, which would break the one rule this surface
 * has. `<noscript>` therefore says to call the office, which is honest rather than silent.
 */
/**
 * The chrome both public pages share — one stylesheet, one shell.
 *
 * `__ACCENT__` is substituted rather than interpolated so this stays a constant: the accent is
 * re-validated against a hex pattern on read (`getAccentColor`), because it lands inside a `<style>`
 * block, and a template literal here would make it look like any other value.
 */
const PAGE_STYLE = `
    :root { color-scheme: light dark; --accent: __ACCENT__; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 1.25rem; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #17211f; background: #f6f8f7; }
    @media (prefers-color-scheme: dark) { body { color: #e8efec; background: #10161a; } .box { background: #182026; border-color: #2a3740; } input, textarea { background: #0f161a; color: inherit; border-color: #33424c; } }
    .wrap { max-width: 34rem; margin: 0 auto; }
    .logo { max-height: 56px; max-width: 60%; display: block; margin-block-end: 0.75rem; }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
    p { margin: 0 0 0.75rem; }
    .box { background: #fff; border: 1px solid #dfe6e3; border-radius: 14px; padding: 1.1rem; }
    label { display: block; font-weight: 600; font-size: 0.92rem; margin-block: 0.85rem 0.25rem; }
    input, textarea { width: 100%; padding: 0.55rem 0.65rem; font: inherit; border: 1px solid #cfd8d5; border-radius: 9px; }
    textarea { min-height: 6rem; resize: vertical; }
    button { margin-block-start: 1.1rem; width: 100%; padding: 0.7rem 1rem; font: inherit; font-weight: 600; color: #fff; background: var(--accent); border: 0; border-radius: 10px; cursor: pointer; }
    button[disabled] { opacity: 0.6; cursor: default; }
    .hint { font-size: 0.85rem; opacity: 0.75; }
    .hp { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
    button.ghost { color: var(--accent); background: transparent; border: 1px solid currentColor; }
    .done { display: none; }
  `;

/** The document both pages are poured into. Nothing external: no font, no stylesheet, no image that
 *  is not a data URI — partly because the CSP says so, and partly because this is the one page a
 *  masjid embeds in a site we know nothing about. It has to be impossible to blame. */
function page(school: string, style: string, inner: string, script = ''): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${school}</title>
<style>${style}</style>
</head><body><div class="wrap">
${logoTag()}
${inner}
</div>${script ? `<script>${script}</script>` : ''}</body></html>`;
}

function renderPage(opts: { open: boolean; token: string }): string {
  const school = esc(getSchoolName());
  const style = PAGE_STYLE.replace('__ACCENT__', esc(getAccentColor()));

  const fields = opts.open
    ? FIELDS.map((f) => {
        const id = `f_${f.name}`;
        const input = f.multiline
          ? `<textarea id="${id}" name="${f.name}" maxlength="${f.cap}"></textarea>`
          : `<input id="${id}" name="${f.name}" type="${f.type}" maxlength="${f.cap}"${f.required ? ' required' : ''}>`;
        return `<label for="${id}">${esc(f.label)}</label>${input}`;
      }).join('\n')
    : '';

  const body = opts.open
    ? `${admissionsTextHtml('intro')}
      <form id="frm" novalidate>
        ${fields}
        <div class="hp" aria-hidden="true"><label for="f_website">Website</label><input id="f_website" name="website" type="text" tabindex="-1" autocomplete="off"></div>
        <input type="hidden" name="t" value="${esc(opts.token)}">
        <button type="submit" id="btn">Send</button>
      </form>
      <p class="hint" id="privacy">${esc(admissionsTextPlain('privacy'))}</p>
      <noscript><p class="hint">This form needs JavaScript. Please contact the office instead.</p></noscript>`
    : admissionsTextHtml('closed');

  // The thank-you is already on the page, so the server's answer carries no text and therefore has
  // nothing that could differ between one submission and the next.
  const done = `<div class="done" id="done">${admissionsTextHtml('thanks')}</div>`;

  const script = opts.open
    ? `
    (function () {
      var f = document.getElementById('frm'), b = document.getElementById('btn'), d = document.getElementById('done');
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        b.disabled = true;
        var data = {};
        new FormData(f).forEach(function (v, k) { data[k] = String(v); });
        fetch(${JSON.stringify(POST_PATH)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
          .then(function () { f.style.display = 'none'; var p = document.getElementById('privacy'); if (p) p.style.display = 'none'; d.style.display = 'block'; })
          .catch(function () { b.disabled = false; });
      });
    })();`
    : '';

  return page(school, style, `<h1>${school}</h1><div class="box">${body}${done}</div>`, script);
}

/** The fields a family may confirm or change, with the label they see. A FIXED set (decision 9). */
const READMISSION_BOXES: { name: (typeof READMISSION_FIELDS)[number]; label: string }[] = [
  { name: 'address', label: 'Home address' },
  { name: 'guardianName', label: 'Parent or guardian' },
  { name: 'guardianPhone', label: 'Phone' },
  { name: 'guardianEmail', label: 'Email' },
  { name: 'languages', label: 'Languages spoken at home' },
  { name: 'nationality', label: 'Nationality' },
];

const READMISSION_BODY = z.object({
  token: z.string().min(1).max(200),
  returning: z.boolean(),
  address: z.string().max(400).optional(),
  languages: z.string().max(200).optional(),
  nationality: z.string().max(200).optional(),
  guardianName: z.string().max(200).optional(),
  guardianPhone: z.string().max(80).optional(),
  guardianEmail: z.string().max(300).optional(),
});

/**
 * The re-admission page — the same chrome as the inquiry form, PRE-FILLED from the current record.
 *
 * Pre-filling is what makes the diff small and the family's job short: most of what comes back is
 * what was already there, and `diffSubmission` writes only what actually moved. Every value is
 * escaped on the way into the attribute, like every other document this app assembles.
 */
function renderReadmissionPage(found: ReturnType<typeof readmissionByToken>, token: string): string {
  const school = esc(getSchoolName());
  const accent = esc(getAccentColor());
  const style = PAGE_STYLE.replace('__ACCENT__', accent);

  if (!found.ok) {
    const says: Record<string, string> = {
      unknown: 'We could not find that link. Please ask the office for a new one.',
      expired: 'That link has expired. Please ask the office for a new one.',
      used: 'That form has already been sent — thank you. There is nothing more to do.',
      closed: 'The office has already dealt with this one. Thank you.',
    };
    return page(school, style, `<h1>${school}</h1><div class="box"><p>${esc(says[found.reason] ?? says.unknown)}</p></div>`);
  }

  const c = found.current;
  const boxes = READMISSION_BOXES.map((b) => {
    const id = `r_${b.name}`;
    return `<label for="${id}">${esc(b.label)}</label><input id="${id}" name="${b.name}" type="text" maxlength="${READMISSION_CAPS[b.name]}" value="${esc(c[b.name])}">`;
  }).join('\n');

  const body = `<p>Assalamu alaikum. Please check that what we hold for <b>${esc(c.fullName)}</b> is still right, change anything that is not, and tell us whether they are coming back.</p>
      <form id="frm" novalidate>
        ${boxes}
        <input type="hidden" name="token" value="${esc(token)}">
        <button type="submit" id="btn" data-returning="1">Yes — we are coming back</button>
        <button type="button" id="no" class="ghost">No — not returning this year</button>
      </form>
      <p class="hint">This goes to the madrasah office, who will check it before anything is changed.</p>`;

  const done = `<div class="done" id="done"><p>Jazak Allah khayran — we have your answer. There is nothing more to do.</p></div>`;

  const script = `
    (function () {
      var f = document.getElementById('frm'), b = document.getElementById('btn'), n = document.getElementById('no'), d = document.getElementById('done');
      function send(returning) {
        b.disabled = true; n.disabled = true;
        var data = { returning: returning };
        new FormData(f).forEach(function (v, k) { data[k] = String(v); });
        fetch(${JSON.stringify(`${config.basePath}/public/readmission`)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
          .then(function (r) { return r.json(); })
          .then(function (r) { if (r && r.ok) { f.style.display = 'none'; d.style.display = 'block'; } else { b.disabled = false; n.disabled = false; } })
          .catch(function () { b.disabled = false; n.disabled = false; });
      }
      f.addEventListener('submit', function (e) { e.preventDefault(); send(true); });
      n.addEventListener('click', function () { send(false); });
    })();`;

  return page(school, style, `<h1>${school}</h1><div class="box">${body}${done}</div>`, script);
}

function sendPage(reply: FastifyReply, html: string, frameAncestors: string): FastifyReply {
  return reply
    .code(200)
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .header('content-security-policy', pageCsp(frameAncestors))
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'no-referrer')
    .send(html);
}

export function registerPublicInquiryRoutes(app: FastifyInstance): void {
  /** The office has not opened this door. Every route behaves as though the feature does not exist,
   *  which for an install that never turns it on is exactly true. */
  const off = (reply: FastifyReply) => reply.code(404).send({ error: 'Not found.' });

  app.get('/public/inquiry', async (_req: FastifyRequest, reply: FastifyReply) => {
    const cfg = getAdmissions();
    if (!cfg.publicForm) return off(reply);
    // The hosted page — a link a masjid puts in a newsletter. Nobody frames this one.
    return sendPage(reply, renderPage({ open: cfg.open, token: mintFormToken() }), "'none'");
  });

  app.get('/public/inquiry/embed', async (_req: FastifyRequest, reply: FastifyReply) => {
    const cfg = getAdmissions();
    if (!cfg.publicForm) return off(reply);
    // The same page, differing ONLY in who may frame it. An empty allowlist means nobody can, which
    // is how "embedding is off" is expressed — there is no separate switch to fall out of step with.
    return sendPage(reply, renderPage({ open: cfg.open, token: mintFormToken() }), frameAncestorsFor(cfg.embedOrigins));
  });

  /** The one-line embed: a script tag on the masjid's own site that writes an iframe pointing here. */
  app.get('/public/inquiry.js', async (req: FastifyRequest, reply: FastifyReply) => {
    const cfg = getAdmissions();
    if (!cfg.publicForm) return off(reply);
    const src = `${baseUrlOf(req)}${EMBED_PATH}`;
    const js = `(function(){var s=document.currentScript;var f=document.createElement('iframe');
f.src=${JSON.stringify(src)};f.loading='lazy';f.title='Admissions inquiry';f.style.cssText='width:100%;max-width:36rem;height:52rem;border:0';
(s&&s.parentNode?s.parentNode:document.body).insertBefore(f,s||null);})();`;
    return reply
      .code(200)
      .header('content-type', 'application/javascript; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .send(js);
  });

  /**
   * THE RE-ADMISSION FORM, behind a one-time token (0.52.0-dev.9, docs/ADMISSIONS.md §5).
   *
   * **Not the same kind of surface as the inquiry form above, and the difference is the whole
   * reason the two live side by side.** That one is unauthenticated by design and therefore answers
   * identically whatever happens. This one is authenticated BY THE TOKEN — 256 bits, single-use,
   * stored only as a hash, exactly like an invite or a password reset (§12.4's origin table lists it
   * as its own row for that reason). There is nothing to enumerate, so it says plainly when a link
   * has expired or already been used: a family staring at "not found" when the real answer is "you
   * already sent this" is a phone call to the office.
   *
   * It writes nothing to the household. What a family sends is stored INERT on the re-admission row
   * as a PROPOSAL, and the office reviews it as a diff before a single field moves — §4's one
   * exception to "no parent-initiated data edits" is exactly that shape.
   *
   * Switched on with the same `publicForm` setting, because it is the same decision: whether this
   * install answers to families over the internet at all.
   */
  app.get('/public/readmission', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!getAdmissions().publicForm) return off(reply);
    const token = String((req.query as { token?: string } | undefined)?.token ?? '');
    const found = token ? readmissionByToken(token) : { ok: false as const, reason: 'unknown' as const };
    return sendPage(reply, renderReadmissionPage(found, token), "'none'");
  });

  app.post('/public/readmission', { bodyLimit: BODY_LIMIT }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!getAdmissions().publicForm) return off(reply);
    const parsed = READMISSION_BODY.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, reason: 'invalid' });
    // Throttled per source like every internet-facing submission, even behind a token: the token is
    // unguessable, but the endpoint is still a place to hammer.
    if (!inquiryLimiter.allow(rateLimitKey(req))) return reply.code(429).send({ ok: false, reason: 'rate' });
    const { token, returning, ...fields } = parsed.data;
    const res = submitReadmission(token, fields, { returning, actor: { userId: null, role: 'public', name: 'Re-admission form' } });
    log.info('readmission', { ok: res.ok, reason: res.reason ?? null });
    return reply.code(res.ok ? 200 : 409).header('cache-control', 'no-store').send({ ok: res.ok, reason: res.reason ?? null });
  });

  app.post('/public/inquiry', { bodyLimit: BODY_LIMIT }, async (req: FastifyRequest, reply: FastifyReply) => {
    const cfg = getAdmissions();
    if (!cfg.publicForm) return off(reply);

    // From here on there is exactly ONE response. Every `return sendAck(reply)` below is the same
    // bytes, and the only thing that differs is whether a row was written.
    const parsed = BODY.safeParse(req.body ?? {});
    if (!parsed.success) return sendAck(reply);
    const b = parsed.data;

    // The honeypot: a field no person can see and every naive form-filler completes.
    if ((b.website ?? '').trim()) return drop(reply, 'honeypot');
    if (!b.t || !formTokenOk(b.t, cfg.minSeconds)) return drop(reply, 'token');
    if (!cfg.open) return drop(reply, 'closed');
    if (!inquiryLimiter.allow(rateLimitKey(req))) return drop(reply, 'rate');
    // Checked LAST of the gates, so a flood of junk does not spend the day's budget before a real
    // family's submission gets to be counted.
    if (!inquiryCeiling.allow(cfg.dailyMax)) return drop(reply, 'ceiling');

    const res = storeInquiry(b, { source: 'public', actor: { userId: null, role: 'public', name: 'Admissions form' } });
    log.info('inquiry', { outcome: res.outcome });

    if (res.outcome === 'stored' && res.inquiry) {
      const name = res.inquiry.childName;
      void alertStaff('admissions-inquiry', {
        title: 'New admissions inquiry',
        // Goes only to addresses an admin typed into Settings. A name beside no amount has always
        // been allowed there, and without it the alert is not actionable.
        text: `${name} — a family has asked about a place. Open Admissions to read it.`,
        // The masjid webhook and the OpenMasjidOS alert channel are sinks this app cannot see (§14).
        // Consent to being told a payment landed is not consent to publishing the name of a child
        // whose family only asked a question, so this names nobody at all.
        publicText: '1 new admission inquiry.',
      });
    }
    return sendAck(reply);
  });

  /** Everything that is not stored still answers identically; the outcome word goes to the log and
   *  nowhere near the response. */
  function drop(reply: FastifyReply, why: string): FastifyReply {
    log.info('inquiry', { outcome: 'dropped', why });
    return sendAck(reply);
  }
}

/**
 * The absolute base this app is reachable at, for the iframe the snippet writes.
 *
 * Taken from the REQUEST rather than from the platform's idea of our public URL, and that is the one
 * design choice in this route: the snippet was itself fetched from whatever address the masjid pasted
 * into their website, so that address is the one certainly reachable from wherever this page is being
 * read. `portalBase()` would be more authoritative and less true — it is empty on an install that has
 * never been exposed, which is exactly an install testing the embed on its own LAN.
 */
function baseUrlOf(req: FastifyRequest): string {
  const forwarded = String(req.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const proto = req.headers['cf-ray'] || forwarded === 'https' ? 'https' : 'http';
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '')
    .split(',')[0]
    .trim();
  return host ? `${proto}://${host}` : '';
}
