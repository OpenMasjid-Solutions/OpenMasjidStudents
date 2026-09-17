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
import { sendInquiryAck } from '../mail/notify';
import { DailyCeiling, SubmitLimiter } from '../security/rateLimit';
import { classifyOrigin, rateLimitKey } from '../security/origin';
import { config } from '../config';
import { getAccentColor, getAdmissions, getSchoolLogo, getSchoolName, getSetting, isEmbedOrigin, parseLogoDataUri, setSetting } from '../settings';
import { INQUIRY_CAPS, storeInquiry } from './inquiry';
import { admissionsTextHtml, admissionsTextPlain } from './text';
import { READMISSION_CAPS, READMISSION_FIELDS, readmissionByToken, submitReadmission } from './readmission';
import {
  ADMISSION_CAPS,
  admissionByToken,
  kioskByToken,
  kioskForm,
  kioskInquiries,
  submitAdmission,
  submitAdmissionFromKiosk,
  type AdmissionField,
  type AdmissionLookup,
} from './admissionForm';

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
const READMISSION_POST_PATH = `${config.basePath}/public/readmission`;

/**
 * A JSON literal safe to put INSIDE a `<script>` block.
 *
 * `JSON.stringify` escapes for JSON, not for HTML, and the HTML parser closes a script element at the
 * first literal `</script` wherever it appears — including inside a string. The values here come from
 * the platform's own public URL rather than from a stranger, so this is not a live hole; it is one
 * line that removes the class, on the one page in this app served to the open internet.
 */
function jsonInScript(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c');
}

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

/**
 * CROSS-ORIGIN PERMISSION FOR THE WIDGET — the allowlist an office already keeps, reused.
 *
 * The embedded form now lives IN the masjid's page rather than in an iframe of ours, so its POST is
 * cross-origin and the browser will not make it without being told. What decides is
 * `admissions.embedOrigins` — the same list that was already the `frame-ancestors` allowlist, and
 * the same validator (`isEmbedOrigin`) refusing anything that is not exactly a scheme, host and
 * port. Two lists would be two answers to "whose site may carry our form".
 *
 * The origin is ECHOED, never `*`, and only when it is on the list. `*` would let any page on the
 * internet post to this endpoint from a visitor's browser; echoing an allowlisted origin says the
 * office named this site.
 *
 * Note what this does NOT do: it grants no credentials (`Access-Control-Allow-Credentials` is
 * absent, so the request is anonymous whatever cookies a visitor holds), and it is not a security
 * boundary for the DATA — the endpoint answers identically to everybody with or without CORS, and
 * every control in §14 applies before this header is ever written. It is a browser permission, not
 * an authorization.
 */
function allowEmbedOrigin(req: FastifyRequest, reply: FastifyReply): void {
  const origin = String(req.headers.origin ?? '').trim().toLowerCase();
  if (!origin || !isEmbedOrigin(origin)) return;
  if (!getAdmissions().embedOrigins.includes(origin)) return;
  reply
    .header('access-control-allow-origin', origin)
    // Tells a cache that the answer depends on who asked — without it a shared cache can hand one
    // site's allow header to another.
    .header('vary', 'Origin')
    .header('access-control-allow-methods', 'POST, OPTIONS')
    .header('access-control-allow-headers', 'content-type')
    .header('access-control-max-age', '600');
}

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
interface InquiryBox {
  name: string;
  label: string;
  type: string;
  cap: number;
  required: boolean;
  multiline?: boolean;
}

const FIELDS: { name: string; label: string; type: string; cap: number; alwaysRequired?: boolean; multiline?: boolean }[] = [
  { name: 'childName', label: 'Child’s name', type: 'text', cap: INQUIRY_CAPS.childName, alwaysRequired: true },
  { name: 'childDob', label: 'Date of birth', type: 'date', cap: INQUIRY_CAPS.childDob },
  { name: 'askedAbout', label: 'What are you asking about?', type: 'text', cap: INQUIRY_CAPS.askedAbout },
  { name: 'parentName', label: 'Your name', type: 'text', cap: INQUIRY_CAPS.parentName, alwaysRequired: true },
  { name: 'email', label: 'Email', type: 'email', cap: INQUIRY_CAPS.email },
  { name: 'phone', label: 'Phone', type: 'tel', cap: INQUIRY_CAPS.phone },
  { name: 'message', label: 'Anything you would like to tell us', type: 'text', cap: INQUIRY_CAPS.message, multiline: true },
];

/**
 * The form's boxes as this install actually asks them — ONE list, read by all three renderings.
 *
 * The hosted page, the iframe page and the embeddable widget must ask for the same things and mark
 * the same ones required, or a family filling in the widget is silently dropped for a box the hosted
 * page never showed them (§14's identical-response rule makes that failure invisible, which is
 * exactly why it must not be possible).
 *
 * "(optional)" is APPENDED rather than written into the label, because whether a box is optional is
 * now the office's answer and a baked-in suffix would go stale the moment they changed it.
 */
function inquiryBoxes(): InquiryBox[] {
  const req = new Set(getAdmissions().requiredInquiryFields);
  return FIELDS.map((f) => {
    const required = f.alwaysRequired === true || req.has(f.name);
    return { name: f.name, type: f.type, cap: f.cap, multiline: f.multiline, required, label: required ? f.label : `${f.label} (optional)` };
  });
}

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
 *
 * ── EVERY COLOR IS A TOKEN, AND THE DARK BRANCH ONLY REDEFINES TOKENS ────────
 *
 * It was written the other way until 0.52.0-dev.11 and shipped visibly broken: the
 * `prefers-color-scheme: dark` block sat ABOVE the rules it meant to override, and a media query
 * adds no specificity — so the card's white background on the next line won, while `body`'s color
 * stayed the dark theme's near-white because nothing later re-declared it. On a dark phone that is a
 * white card carrying pale grey labels, which is unreadable; it is the same lesson §15 records about
 * overriding every branch of a ported rule. Tokens make source order irrelevant.
 *
 * `test/publicInquiry.test.ts` holds the rule: the dark block may declare nothing but custom
 * properties, and no rule outside the token blocks may name a color literal.
 *
 * ── LANDSCAPE ───────────────────────────────────────────────────────────────
 *
 * A tablet on its side is about 1024px wide and 700 tall, and a single 34rem column down the middle
 * of it wastes the screen and puts the button below the fold — which, on a device somebody is
 * holding out to you, is the difference between a form that gets finished and one that gets handed
 * back. Past 60rem the fields sit two-up.
 *
 * Keyed on WIDTH rather than `orientation`, deliberately: a phone in landscape is ~850px and
 * genuinely wants one column, and `orientation: landscape` cannot tell the two apart.
 *
 * The grid targets a per-field WRAPPER (`.f`) rather than the label and the box as siblings — as
 * siblings they land in two different columns, and every label ends up above somebody else's answer.
 * A textarea carries `.wide` and keeps the full width. `.f > label:first-child` drops the label's
 * own top margin because the wrapper supplies the spacing, so a grid row does not start with an
 * indent the column beside it does not have.
 *
 * A LABEL USES `--ink`, NOT `--ink-muted`. It is read at a glance while typing, and grey labels were
 * the other half of what made the first version unreadable. `--ink-muted` is for the small print
 * under the button, which is read once or never.
 *
 * ── AND THE REASONING STAYS UP HERE, NOT IN THE STYLESHEET ───────────────────
 *
 * This constant is served, in full, on the one page in this app that strangers load — often embedded
 * in a masjid's own website. A paragraph of English explaining a bug we once had is bytes on every
 * request and internal reasoning published to people who did not ask for it. The CSS itself carries
 * only what a reader editing THAT LINE needs.
 */
const PAGE_STYLE = `
    :root {
      color-scheme: light dark;
      --accent: __ACCENT__;
      --ink: #17211f;
      --ink-muted: #5b6b66;
      --page: #f6f8f7;
      --card: #ffffff;
      --line: #dfe6e3;
      --field: #ffffff;
      --field-line: #cfd8d5;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --ink: #e8efec;
        --ink-muted: #9fb3ac;
        --page: #10161a;
        --card: #182026;
        --line: #2a3740;
        --field: #0f161a;
        --field-line: #33424c;
      }
    }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 1.25rem; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: var(--page); }
    .wrap { max-width: 34rem; margin: 0 auto; }
    @media (min-width: 60rem) {
      .wrap { max-width: 56rem; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 1.1rem; align-items: start; }
      .grid > .wide { grid-column: 1 / -1; }
    }
    .f > label:first-child { margin-block-start: 0; }
    .f { margin-block-start: 0.85rem; }
    .logo { max-height: 56px; max-width: 60%; display: block; margin-block-end: 0.75rem; }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
    p { margin: 0 0 0.75rem; }
    .box { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 1.1rem; }
    label { display: block; font-weight: 600; font-size: 0.92rem; margin-block: 0.85rem 0.25rem; color: var(--ink); }
    label .opt { font-weight: 400; color: var(--ink-muted); }
    input, textarea { width: 100%; padding: 0.55rem 0.65rem; font: inherit; color: var(--ink); background: var(--field); border: 1px solid var(--field-line); border-radius: 9px; }
    input:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    textarea { min-height: 6rem; resize: vertical; }
    button { margin-block-start: 1.1rem; width: 100%; padding: 0.7rem 1rem; font: inherit; font-weight: 600; color: #fff; background: var(--accent); border: 0; border-radius: 10px; cursor: pointer; }
    button[disabled] { opacity: 0.6; cursor: default; }
    .hint { font-size: 0.85rem; color: var(--ink-muted); }
    .hp { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
    button.ghost { color: var(--accent); background: transparent; border: 1px solid currentColor; }
    .pick { display: block; padding: 0.8rem 0.9rem; margin-block-end: 0.5rem; border: 1px solid var(--field-line); border-radius: 10px; color: var(--ink); text-decoration: none; font-weight: 600; }
    .attrib { margin-block-start: 1.25rem; font-size: 0.75rem; color: var(--ink-muted); text-align: center; }
    .done { display: none; }
  `;

/** The document both pages are poured into. Nothing external: no font, no stylesheet, no image that
 *  is not a data URI — partly because the CSP says so, and partly because this is the one page a
 *  masjid embeds in a site we know nothing about. It has to be impossible to blame. */
/**
 * THE ATTRIBUTION LINE, on every page this app serves to a family.
 *
 * Hasan asked for it and asked that it not say "powered": "at the end of any embed's or forms and
 * stuff, if you could write Powered by OpenMasjidStudents or any other wording besides 'Powered'".
 *
 * Plain text, no link. A masjid's admissions form is not a place to send a family somewhere else,
 * and a link would be the one outbound reference on a page whose CSP is `default-src 'none'`
 * precisely so there are none.
 */
const ATTRIBUTION = 'Managed with OpenMasjid Students';

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
<p class="attrib">${ATTRIBUTION}</p>
</div>${script ? `<script>${script}</script>` : ''}</body></html>`;
}

function renderPage(opts: { open: boolean; token: string }): string {
  const school = esc(getSchoolName());
  const style = PAGE_STYLE.replace('__ACCENT__', esc(getAccentColor()));

  const fields = opts.open
    ? inquiryBoxes().map((f) => {
        const id = `f_${f.name}`;
        const input = f.multiline
          ? `<textarea id="${id}" name="${f.name}" maxlength="${f.cap}"></textarea>`
          : `<input id="${id}" name="${f.name}" type="${f.type}" maxlength="${f.cap}"${f.required ? ' required' : ''}>`;
        return `<div class="f${f.multiline ? ' wide' : ''}"><label for="${id}">${esc(f.label)}</label>${input}</div>`;
      }).join('\n')
    : '';

  const body = opts.open
    ? `${admissionsTextHtml('intro')}
      <form id="frm" novalidate>
        <div class="grid">${fields}</div>
        <div class="hp" aria-hidden="true"><label for="f_website">Website</label><input id="f_website" name="website" type="text" tabindex="-1" autocomplete="off"></div>
        <input type="hidden" name="t" value="${esc(opts.token)}">
        <button type="submit" id="btn">Send</button>
      </form>
      <p class="hint" id="note"></p>
      <p class="hint" id="privacy">${esc(admissionsTextPlain('privacy'))}</p>
      <noscript><p class="hint">This form needs JavaScript. Please contact the office instead.</p></noscript>`
    : admissionsTextHtml('closed');

  // The thank-you is already on the page, so the server's answer carries no text and therefore has
  // nothing that could differ between one submission and the next.
  const done = `<div class="done" id="done">${admissionsTextHtml('thanks')}</div>`;

  const script = opts.open
    ? `
    (function () {
      var f = document.getElementById('frm'), b = document.getElementById('btn'), d = document.getElementById('done'), note = document.getElementById('note');
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        // CHECKED HERE BECAUSE THE SERVER CANNOT TELL THEM. Every submission gets the same
        // acknowledgement whatever happened (§14's no-enumeration rule), so a family who left a
        // required box empty would otherwise be thanked and never heard from again. The widget has
        // done this since 0.52.0-dev.14; the hosted page had not, which made a required field an
        // invisible way to lose a real family.
        var missing = [];
        for (var i = 0; i < f.elements.length; i++) {
          var el = f.elements[i];
          if (el.hasAttribute && el.hasAttribute('required') && !String(el.value || '').trim()) {
            var lab = f.querySelector('label[for="' + el.id + '"]');
            missing.push(lab ? lab.textContent : el.name);
          }
        }
        if (missing.length) { note.textContent = 'Please fill in: ' + missing.join(', '); return; }
        note.textContent = '';
        b.disabled = true;
        var data = {};
        new FormData(f).forEach(function (v, k) { data[k] = String(v); });
        fetch(${jsonInScript(POST_PATH)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
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

/**
 * The admission form's body.
 *
 * `passthrough`-shaped on purpose — the FIELD SET IS NOT KNOWN HERE. It is whatever the student-field
 * registry has switched on, which an office changes in Settings, so a fixed zod shape would silently
 * drop a field the moment somebody enabled one. What this schema does is bound the SHAPE: a token, a
 * sane number of keys, and every value a string or boolean within a cap. Which keys are meaningful,
 * and what each may contain, is settled once in `admissions/admissionForm.ts` against the fields the
 * form actually rendered — a key nobody was asked for is dropped there rather than stored.
 */
const ADMISSION_BODY = z
  .object({ token: z.string().min(1).max(200) })
  .catchall(z.union([z.string().max(ADMISSION_CAPS.longtext * 2), z.boolean()]))
  .refine((o) => Object.keys(o).length <= 60, { message: 'too many fields' });

const KIOSK_BODY = z
  .object({ token: z.string().min(1).max(200), inquiry: z.string().min(1).max(64) })
  .catchall(z.union([z.string().max(ADMISSION_CAPS.longtext * 2), z.boolean()]))
  .refine((o) => Object.keys(o).length <= 60, { message: 'too many fields' });

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
const ADMISSION_POST_PATH = `${config.basePath}/public/admission`;

/**
 * The form's boxes, from the field list.
 *
 * ONE renderer for both doors — the family's link and the tablet. Two would be two places for the
 * medical select to become a checkbox, or for a cap to be forgotten, and the whole point of the
 * field list is that neither door has an opinion of its own about what the form asks.
 */
function admissionBoxes(fields: AdmissionField[]): string {
  return fields
    .map((f) => {
      const id = `a_${f.key}`;
      const req = f.required ? ' <span class="opt">(required)</span>' : '';
      const label = `<label for="${id}">${esc(f.label)}${req}</label>`;
      const wrap = (inner: string) => `<div class="f${f.kind === 'longtext' ? ' wide' : ''}">${label}${inner}</div>`;
      if (f.kind === 'flag') {
        // A flag is a real three-state in the registry — yes, no, and "nobody has asked yet" — so it
        // is a select rather than a checkbox. An unticked checkbox and a question nobody answered are
        // the same bytes, and for a medical consent that difference is the whole point.
        return wrap(`<select id="${id}" name="${f.key}"><option value="">—</option><option value="1">Yes</option><option value="0">No</option></select>`);
      }
      if (f.kind === 'longtext') {
        return wrap(`<textarea id="${id}" name="${f.key}" maxlength="${ADMISSION_CAPS.longtext}">${esc(f.prefill)}</textarea>`);
      }
      const type = f.kind === 'date' ? 'date' : 'text';
      return wrap(`<input id="${id}" name="${f.key}" type="${type}" maxlength="${ADMISSION_CAPS[f.kind]}" value="${esc(f.prefill)}">`);
    })
    .join('\n');
}

/**
 * THE ADMISSION FORM, server-rendered like every other family-facing page here (0.52.0-dev.12).
 *
 * Not React, and that is forced rather than chosen: the React app is behind a login and this page is
 * opened by somebody with a token and no session. The whole family-facing surface of this app —
 * inquiry, re-admission, and now this — is assembled here, escaped here, and served with the same
 * headers and the same CSP.
 *
 * The field set comes from `admissions/admissionForm.ts`, which asks the student-field registry, so
 * this function renders whatever the office switched on and never carries a list of its own.
 */
function renderAdmissionPage(found: AdmissionLookup, token: string): string {
  const school = esc(getSchoolName());
  const accent = esc(getAccentColor());
  const style = PAGE_STYLE.replace('__ACCENT__', accent);

  if (!found.ok) {
    // Says WHICH failure, unlike the inquiry form — see `admissionByToken`'s header. A token holder
    // is not a stranger being probed, they are somebody staring at a form that will not open.
    const says: Record<string, string> = {
      unknown: 'We could not find that link. Please ask the office for a new one.',
      expired: 'That link has expired. Please ask the office for a new one.',
      used: 'That form has already been sent — jazakumullahu khairan.',
      closed: 'The office has already dealt with this one. Jazakumullahu khairan.',
    };
    return page(school, style, `<h1>${school}</h1><div class="box"><p>${esc(says[found.reason] ?? says.unknown)}</p></div>`);
  }

  const boxes = admissionBoxes(found.fields);

  const body = `<p>Please complete this form for <b>${esc(found.inquiry.childName)}</b>.</p>
      <form id="frm" novalidate>
        <div class="grid">${boxes}</div>
        <input type="hidden" name="token" value="${esc(token)}">
        <button type="submit" id="btn">Send to the office</button>
      </form>
      <p class="hint">The office checks this before anything is added to their records.</p>`;

  const done = `<div class="done" id="done"><p>Jazakumullahu khairan — we have your form. The office will be in touch.</p></div>`;

  const script = `
    (function () {
      var f = document.getElementById('frm'), b = document.getElementById('btn'), d = document.getElementById('done');
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        b.disabled = true;
        var data = {};
        new FormData(f).forEach(function (v, k) { data[k] = String(v); });
        fetch(${jsonInScript(ADMISSION_POST_PATH)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
          .then(function (r) { return r.json(); })
          .then(function (r) {
            if (r && r.ok) { f.style.display = 'none'; d.style.display = 'block'; }
            else { b.disabled = false; if (r && r.reason === 'incomplete') { alert('Please fill in everything marked required.'); } }
          })
          .catch(function () { b.disabled = false; });
      });
    })();`;

  return page(school, style, `<h1>${school}</h1><div class="box">${body}${done}</div>`, script);
}

const KIOSK_PATH = `${config.basePath}/public/admission/kiosk`;

/** Shared chrome for the three tablet screens. */
function kioskShell(inner: string, script = ''): string {
  const school = esc(getSchoolName());
  return page(school, PAGE_STYLE.replace('__ACCENT__', esc(getAccentColor())), `<h1>${school}</h1><div class="box">${inner}</div>`, script);
}

/** The tablet's session has ended, or nobody started one. Says so plainly — whoever is looking at
 *  this is staff, standing beside the device. */
function renderKioskGone(): string {
  return kioskShell('<p>This tablet is not signed in. Someone in the office needs to start tablet mode again.</p>');
}

/**
 * WHO IS THIS FORM FOR? — the picker, and the reason tablet mode exists at all.
 *
 * Hasan: "there should be an option to select which student the admission form is for because I
 * wanted to pre-fill the fields from the inquiry form." Names and ids only; `kioskInquiries` will
 * not hand this page an email, a phone number or anything a family wrote, because whoever is holding
 * the tablet is not necessarily the family whose turn it is.
 */
function renderKioskPicker(token: string): string {
  const rows = kioskInquiries();
  const list = rows.length
    ? rows
        .map(
          (r) =>
            `<p><a class="pick" href="${esc(KIOSK_PATH)}?token=${encodeURIComponent(token)}&amp;inquiry=${encodeURIComponent(r.id)}">${esc(r.childName)}</a></p>`,
        )
        .join('\n')
    : '<p class="hint">There is nobody waiting on an admission form. The office adds a family first.</p>';
  return kioskShell(`<p>Please choose your child’s name.</p>${list}`);
}

/** The form itself, once a family has been chosen. Same fields, same rules, same renderer shape as
 *  the family's own link — only the door differed. */
function renderKioskForm(chosen: { inquiry: { id: string; childName: string }; fields: AdmissionField[] }, token: string): string {
  const boxes = admissionBoxes(chosen.fields);
  const body = `<p>Please complete this form for <b>${esc(chosen.inquiry.childName)}</b>.</p>
      <form id="frm" novalidate>
        <div class="grid">${boxes}</div>
        <input type="hidden" name="token" value="${esc(token)}">
        <input type="hidden" name="inquiry" value="${esc(chosen.inquiry.id)}">
        <button type="submit" id="btn">Send to the office</button>
      </form>
      <p class="hint">The office checks this before anything is added to their records.</p>`;
  // Returns to the picker so the tablet is ready for the next family without anybody touching it.
  const done = `<div class="done" id="done"><p>Jazakumullahu khairan. Please hand the tablet back to the office.</p>
      <p><a class="pick" href="${esc(KIOSK_PATH)}?token=${esc(token)}">Start again</a></p></div>`;
  const script = `
    (function () {
      var f = document.getElementById('frm'), b = document.getElementById('btn'), d = document.getElementById('done');
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        b.disabled = true;
        var data = {};
        new FormData(f).forEach(function (v, k) { data[k] = String(v); });
        fetch(${jsonInScript(KIOSK_PATH)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
          .then(function (r) { return r.json(); })
          .then(function (r) {
            if (r && r.ok) { f.style.display = 'none'; d.style.display = 'block'; }
            else { b.disabled = false; if (r && r.reason === 'incomplete') { alert('Please fill in everything marked required.'); } }
          })
          .catch(function () { b.disabled = false; });
      });
    })();`;
  return kioskShell(`${body}${done}`, script);
}

function renderReadmissionPage(found: ReturnType<typeof readmissionByToken>, token: string): string {
  const school = esc(getSchoolName());
  const accent = esc(getAccentColor());
  const style = PAGE_STYLE.replace('__ACCENT__', accent);

  if (!found.ok) {
    const says: Record<string, string> = {
      unknown: 'We could not find that link. Please ask the office for a new one.',
      expired: 'That link has expired. Please ask the office for a new one.',
      used: 'That form has already been sent — jazakumullahu khairan. There is nothing more to do.',
      closed: 'The office has already dealt with this one. Jazakumullahu khairan.',
    };
    return page(school, style, `<h1>${school}</h1><div class="box"><p>${esc(says[found.reason] ?? says.unknown)}</p></div>`);
  }

  const c = found.current;
  const boxes = READMISSION_BOXES.map((b) => {
    const id = `r_${b.name}`;
    return `<div class="f"><label for="${id}">${esc(b.label)}</label><input id="${id}" name="${b.name}" type="text" maxlength="${READMISSION_CAPS[b.name]}" value="${esc(c[b.name])}"></div>`;
  }).join('\n');

  const body = `<p>Assalamu alaikum. Please check that what we hold for <b>${esc(c.fullName)}</b> is still right, change anything that is not, and tell us whether they are coming back.</p>
      <form id="frm" novalidate>
        <div class="grid">${boxes}</div>
        <input type="hidden" name="token" value="${esc(token)}">
        <button type="submit" id="btn" data-returning="1">Yes — we are coming back</button>
        <button type="button" id="no" class="ghost">No — not returning this year</button>
      </form>
      <p class="hint">This goes to the madrasah office, who will check it before anything is changed.</p>`;

  const done = `<div class="done" id="done"><p>Jazakumullahu khairan — we have your answer. There is nothing more to do.</p></div>`;

  const script = `
    (function () {
      var f = document.getElementById('frm'), b = document.getElementById('btn'), n = document.getElementById('no'), d = document.getElementById('done');
      function send(returning) {
        b.disabled = true; n.disabled = true;
        var data = { returning: returning };
        new FormData(f).forEach(function (v, k) { data[k] = String(v); });
        fetch(${jsonInScript(READMISSION_POST_PATH)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
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
  /**
   * THE EMBEDDABLE WIDGET — the form INSIDE the masjid's own page, not in a box on it.
   *
   * Hasan asked for the QuickSchools shape: `<div id="enquiry-form"></div>` plus one async script
   * that fills it in, "where it blends in with the website perfectly". The old version injected an
   * IFRAME, which is why it never blended: an iframe is a separate document with its own stylesheet,
   * so it is a rectangle of our design sitting on somebody else's page, with a scrollbar and a height
   * we had to guess.
   *
   * So this builds real DOM in the host page and SETS ALMOST NO STYLES. Inputs inherit the site's
   * font, its colors and its form styling, because we do not fight it — that is what blending is.
   * Every node carries an `oms-` class so a site that wants to style it can.
   *
   * ── Built with createElement, never innerHTML ───────────────────────────────
   *
   * This is the one piece of code this app runs inside somebody else's document. `innerHTML` there
   * would mean one escaping mistake becomes an XSS on the masjid's website rather than on ours, and
   * a host CSP with no `unsafe-inline` would break it besides. Building nodes and assigning
   * `textContent` cannot inject markup at all, which is a stronger statement than "we escaped it".
   *
   * ── Why `divId` and not just "beside the script tag" ────────────────────────
   *
   * `document.currentScript` is null when a site's optimizer defers, bundles or re-inserts the tag,
   * which is most WordPress caching plugins. A named div is a promise the page keeps. Both are
   * supported: the div wins, the script's own position is the fallback.
   */
  app.get('/public/inquiry.js', async (req: FastifyRequest, reply: FastifyReply) => {
    const cfg = getAdmissions();
    if (!cfg.publicForm) return off(reply);
    const divId = String((req.query as { divId?: string } | undefined)?.divId ?? '').slice(0, 80);
    const payload = {
      action: `${baseUrlOf(req)}${config.basePath}/public/inquiry`,
      divId,
      open: cfg.open,
      token: mintFormToken(),
      intro: admissionsTextPlain('intro'),
      privacy: admissionsTextPlain('privacy'),
      thanks: admissionsTextPlain('thanks'),
      closed: admissionsTextPlain('closed'),
      fields: inquiryBoxes(),
    };
    const js = `(function(){
  var C = ${jsonInScript(payload)};
  var s = document.currentScript;
  function mount() {
    var root = C.divId ? document.getElementById(C.divId) : null;
    if (!root && s && s.parentNode) { root = document.createElement('div'); s.parentNode.insertBefore(root, s); }
    if (!root) return;
    root.className = (root.className ? root.className + ' ' : '') + 'oms-admissions';
    function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
    if (!C.open) { root.appendChild(el('p', 'oms-closed', C.closed)); return; }
    if (C.intro) root.appendChild(el('p', 'oms-intro', C.intro));
    var form = el('form', 'oms-form');
    form.setAttribute('novalidate', 'novalidate');
    var inputs = {};
    C.fields.forEach(function (f) {
      var wrap = el('div', 'oms-field');
      var id = 'oms_' + f.name;
      var lab = el('label', 'oms-label', f.label);
      lab.setAttribute('for', id);
      var box = f.multiline ? el('textarea', 'oms-input') : el('input', 'oms-input');
      box.id = id; box.name = f.name;
      if (!f.multiline) box.type = f.type;
      box.setAttribute('maxlength', String(f.cap));
      if (f.required) box.setAttribute('required', 'required');
      inputs[f.name] = box;
      wrap.appendChild(lab); wrap.appendChild(box); form.appendChild(wrap);
    });
    var hp = el('div', 'oms-hp');
    hp.setAttribute('aria-hidden', 'true');
    hp.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden';
    var hpi = el('input'); hpi.name = 'website'; hpi.tabIndex = -1; hpi.setAttribute('autocomplete', 'off');
    hp.appendChild(hpi); form.appendChild(hp);
    var btn = el('button', 'oms-submit', 'Send');
    btn.type = 'submit';
    form.appendChild(btn);
    var note = el('p', 'oms-note', '');
    var priv = el('p', 'oms-privacy', C.privacy);
    root.appendChild(form); root.appendChild(note); root.appendChild(priv);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var missing = C.fields.filter(function (f) { return f.required && !String(inputs[f.name].value || '').trim(); });
      if (missing.length) { note.textContent = 'Please fill in: ' + missing.map(function (f) { return f.label; }).join(', '); return; }
      if (!String(inputs.email.value || '').trim() && !String(inputs.phone.value || '').trim()) {
        note.textContent = 'Please give an email address or a phone number so we can reply.';
        return;
      }
      note.textContent = '';
      btn.disabled = true;
      var data = { t: C.token, website: hpi.value };
      C.fields.forEach(function (f) { data[f.name] = String(inputs[f.name].value || ''); });
      fetch(C.action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
        .then(function (r) { return r.json(); })
        .then(function () { root.textContent = ''; root.appendChild(el('p', 'oms-thanks', C.thanks)); })
        .catch(function () { btn.disabled = false; note.textContent = 'That did not send. Please try again, or contact the office.'; });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();`;
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

  app.get('/public/admission', async (req: FastifyRequest, reply: FastifyReply) => {
    // Gated on the SAME switch as everything else family-facing here. An office that has not opened
    // admissions has not opened this either, and one switch is one thing to reason about.
    if (!getAdmissions().publicForm) return off(reply);
    const token = String((req.query as { token?: string } | undefined)?.token ?? '');
    const found = token ? admissionByToken(token) : ({ ok: false, reason: 'unknown' } as const);
    // `'none'` — this page is never embedded. The inquiry form is the one an office puts on their
    // website; an admission form carries a child's details and belongs in nobody's iframe.
    return sendPage(reply, renderAdmissionPage(found, token), "'none'");
  });

  app.post('/public/admission', { bodyLimit: BODY_LIMIT }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!getAdmissions().publicForm) return off(reply);
    const parsed = ADMISSION_BODY.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, reason: 'invalid' });
    // Throttled per source like every internet-facing submission, even behind a token: the token is
    // unguessable, but the endpoint is still a place to hammer.
    if (!inquiryLimiter.allow(rateLimitKey(req))) return reply.code(429).send({ ok: false, reason: 'rate' });
    const { token, ...fields } = parsed.data;
    const res = submitAdmission(token, fields, { actor: { userId: null, role: 'public', name: 'Admission form' } });
    // NOTHING THE FAMILY TYPED REACHES THIS LINE — not a name, not a field key, and above all not an
    // allergy (§14). The outcome word and nothing else.
    log.info('admission', { ok: res.ok, reason: res.reason ?? null });
    return reply.code(res.ok ? 200 : 409).header('cache-control', 'no-store').send({ ok: res.ok, reason: res.reason ?? null });
  });

  /**
   * TABLET MODE — the picker, and the form once a family is chosen.
   *
   * THE ORIGIN CHECK IS THE FIRST THING IN BOTH HANDLERS, before the token is even looked at, and it
   * is written out here rather than inherited because there are no Fastify hooks in this repo (§14).
   * `classifyOrigin` is the same function the tRPC middleware consults, so tablet mode cannot drift
   * from the origin policy the rest of the app enforces.
   */
  function kioskBlocked(req: FastifyRequest, reply: FastifyReply): FastifyReply | null {
    const cfg = getAdmissions();
    if (!cfg.publicForm || !cfg.kiosk) return off(reply);
    // LAN-only unless an office opted in. `cf-ray` short-circuits before the client IP is examined,
    // so a tablet on masjid Wi-Fi that opened the bookmarked PUBLIC url is `tunnel` and is refused —
    // correctly, and the Settings copy says to use the LAN address.
    if (!cfg.kioskRemote && classifyOrigin(req) === 'tunnel') return off(reply);
    return null;
  }

  app.get('/public/admission/kiosk', async (req: FastifyRequest, reply: FastifyReply) => {
    const blocked = kioskBlocked(req, reply);
    if (blocked) return blocked;
    const q = (req.query ?? {}) as { token?: string; inquiry?: string };
    const token = String(q.token ?? '');
    if (!kioskByToken(token).ok) return sendPage(reply, renderKioskGone(), "'none'");
    const chosen = q.inquiry ? kioskForm(String(q.inquiry)) : null;
    return sendPage(reply, chosen ? renderKioskForm(chosen, token) : renderKioskPicker(token), "'none'");
  });

  app.post('/public/admission/kiosk', { bodyLimit: BODY_LIMIT }, async (req: FastifyRequest, reply: FastifyReply) => {
    const blocked = kioskBlocked(req, reply);
    if (blocked) return blocked;
    const parsed = KIOSK_BODY.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, reason: 'invalid' });
    if (!inquiryLimiter.allow(rateLimitKey(req))) return reply.code(429).send({ ok: false, reason: 'rate' });
    const { token, inquiry, ...fields } = parsed.data;
    const res = submitAdmissionFromKiosk(token, inquiry, fields, { actor: { userId: null, role: 'public', name: 'Admission form (tablet)' } });
    log.info('admission', { via: 'kiosk', ok: res.ok, reason: res.reason ?? null });
    return reply.code(res.ok ? 200 : 409).header('cache-control', 'no-store').send({ ok: res.ok, reason: res.reason ?? null });
  });

  // The browser's preflight for the widget's POST. Answers 204 with the same allowlist check and
  // nothing else — a preflight that told an un-allowlisted site anything would be the leak.
  app.options('/public/inquiry', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!getAdmissions().publicForm) return off(reply);
    allowEmbedOrigin(req, reply);
    return reply.code(204).header('cache-control', 'no-store').send();
  });

  app.post('/public/inquiry', { bodyLimit: BODY_LIMIT }, async (req: FastifyRequest, reply: FastifyReply) => {
    const cfg = getAdmissions();
    if (!cfg.publicForm) return off(reply);
    // Written before any gate below, so the ONE response really is one response: a submission that
    // was dropped and one that was stored must not differ by a header either.
    allowEmbedOrigin(req, reply);

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
      // The acknowledgement, if the office asked for one. Fire-and-forget and never awaited: the
      // response must not take longer for a submission that was stored than for one that was not,
      // or the timing becomes the difference the body carefully is not. `sendInquiryAck` holds every
      // gate — the master parent-mail pause, the office's switch, the transport — and it carries
      // nothing the sender wrote.
      if (res.inquiry.email) void sendInquiryAck(res.inquiry.email);
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
