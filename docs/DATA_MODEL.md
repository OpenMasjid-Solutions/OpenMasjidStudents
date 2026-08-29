<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# DATA_MODEL — schema notes, non-trivial decisions, and the assumptions log

> **Status: stub + living log.** Canonical schema spec is `CLAUDE.md` §9. This file records
> (a) non-trivial modeling decisions as they are made, and (b) the **assumptions log** for the
> §20 open questions — per the working agreement, if a build step touches an open question we ask
> Hasan first; otherwise we proceed with the documented assumption and record it here.

## Tables

> **This list described the PRE-0.35.0 academic schema until 0.50.0** — roughly thirty-four tables
> that had not existed for fifteen releases (`attendance`, `grades`, `exams`, `report_cards`,
> `transcripts`, `admissions`, `enrollments`, `student_field_defs`, `attachments`, `fabric_inbox`
> …), while every table added since was missing. It is now generated from the real
> `packages/server/src/db/schema.ts`. If you change the schema, change this.

The **33 tables** that exist, grouped by what they are for:

| Area | Tables |
| --- | --- |
| Config | `settings` |
| Accounts | `users`, `sessions`, `invites`, `password_resets` |
| Structure | `schools`, `user_schools`, `school_years`, `terms`, `courses`, `classes` |
| People | `families`, `students`, `guardians`, `guardian_families`, `guardian_users`, `emergency_contacts` |
| Fees | `fee_plans`, `student_fees`, `charge_items`, `charges` |
| Billing | `invoices`, `invoice_items`, `payments`, `payment_allocations`, `carry_ins`, `past_due_reminders` |
| Cards | `payment_methods`, `autopay_enrollments`, `autopay_runs` |
| Notifications | `alert_recipients`, `whatsapp_log` |
| Trail | `audit_log` |

Notable absences, each deliberate:

- **`stripe_events`** — dropped in 0.48.0 (migration 0037). It deduplicated webhook deliveries and
  there is no webhook (§13.4); a money schema carrying a table nobody writes is an invitation to wire
  the next thing to it.
- **`attachments`** — payment-proof uploads were planned once and never built. There is no upload
  path and no `/data/attachments` (§4).
- **`enrollments`** — fees attach to the STUDENT (`student_fees`), not to a class enrollment, so each
  child's bill is their own.

Non-negotiable rules live in CLAUDE.md §9: Student IDs unique and always generated; money in integer
cents; idempotency keys UNIQUE; **balances derived, never stored**; payments immutable (reversals, not
edits); allocation derived and per line, with a payer's instruction re-honored; dates stored ISO and
compared as TEXT; FKs `ON DELETE RESTRICT` on money paths. Every table carries `id` and `created_at`,
and `updated_at` wherever a row is ever updated.

## Non-trivial decisions

- **Homework module: dropped.** Per Hasan (2026-07-15), no homework-specific feature. The
  gradebook's assignments/assessments cover graded work; there is no separate homework entity.

- **UI = the family's shared "liquid glass" CSS design system, NOT shadcn/ui.** Per Hasan
  (2026-07-15) and recon: OpenMasjidOS/Display/Kiosk share `styles/{tokens,glass,app}.css` +
  hand-rolled inline-SVG primitives; none use shadcn/Radix/tailwind-merge. We port that system
  verbatim from OpenMasjidOS `packages/ui` for byte-parity + re-sync (§15). **This deviates from
  CLAUDE.md §7's "shadcn/ui (copied-in Radix)" and "Tailwind CSS v4" lines** — parity (§15, the
  harder constraint + Hasan's explicit "ui.ux same as them") wins. Ported files keep their SPDX
  header + an origin comment and stay structurally identical to upstream so theme fixes re-sync.

- **Default accent = cyan `#22D3EE` + gold `#F59E0B` over deep navy `#030D1A`.** Per Hasan
  (2026-07-15): match the LIVE siblings (Display/Kiosk, and OS's default accent), not the
  EMERALD described in CLAUDE.md §9 text. The token system supports swappable accents, so this
  is a one-token change if revisited. **Deviates from §9's emerald language** — deliberate.

- **Backend = tRPC + Drizzle + npm-workspaces monorepo (per §7/§8), NOT the siblings' pattern.**
  Recon: Donations/Kiosk use plain Fastify REST + raw better-sqlite3 (`Store` class) + a `server/`
  `web/` split (no workspaces, no tRPC, no Drizzle). Our §7/§8 deliberately choose the more
  structured stack because this app's data model (§9, ~50 tables, FKs, migrations, immutable
  versioned artifacts) needs it and the spec is built around tRPC (`AppRouter` type import §6/§8,
  role+origin middleware §5). Following §7 exactly; noting the sibling divergence here.

- **Repo + image name = `OpenMasjidStudents` → `ghcr.io/openmasjid-solutions/openmasjidstudents`.**
  Per Hasan (2026-07-15): keep the current folder/GitHub name. **App id stays `students`** (locked by
  the Fabric contract — Donations & Kiosk already reference `students/billing`; the docs' canonical
  example is `students/billing`). **Deviates from CLAUDE.md §2's image `openmasjid-students`.** The
  APPS catalog's stale `student-manager` coming-soon teaser must be renamed → `students` when we list
  (an OpenMasjidAPPS-repo change, step 14/release).

- **Fabric broker + Cloudflare tunnel already exist in OpenMasjidOS v0.40.0** (not a pending work
  order): `POST /api/fabric/app/:targetAppId/:capability/:method` (appLink.ts) and injected
  `OPENMASJID_PUBLIC_URL` are live. Env var names (`OPENMASJID_APP_ID/BASE_URL/APP_SECRET/PUBLIC_URL`),
  `/api/auth/session`, `/api/fabric/notify`, `/api/fabric/stripe`, `/api/public/appearance` all match
  our assumptions. Two notes: OS has **no `resources:` manifest key** (omit it); the public-URL
  endpoint `/api/fabric/site` is gated on a `domain:` capability our manifest can add later if needed
  (the injected `OPENMASJID_PUBLIC_URL` path works without it).

- **Alerts fan out to three places, and an ALERT RECIPIENT IS AN ADDRESS, NOT AN ACCOUNT** (0.44.0,
  `alerts/index.ts` + `alert_recipients`). There were two channels before, and both could be silently
  dead: `notifyPlatform` posts to a masjid webhook most installs never configure, and `raiseAlert`
  reaches OpenMasjidOS but only for ids declared in the **catalog entry the masjid installed from** — so
  a newly-declared id is answered `400 Unknown alert` until a release lands, fail-soft, invisibly.
  `payment-short` spent all of 0.43.0 in exactly that state. So `alertStaff(event, msg)` now also emails
  the addresses the office listed, which needs no manifest, no catalog and no webhook.
  - **Not a column on `users`**: the person who must know that autopay switched itself off is often not
    someone who logs in (the treasurer, the imām, a trustee). A recipient row grants no access.
  - **`events` as JSON, not a join table**: a handful of rows, always read and written whole, never
    queried BY event. `alerts/index.ts` owns the catalog and filters unknown ids on read, so a stale
    row can never widen what it receives.
  - **Two texts per alert, and `publicText` is REQUIRED**: `text` goes by email to the addresses an
    admin typed and MAY name the household and the amount — without that an alert is unactionable, which
    is what the old "a family's card failed" wording was. `publicText` goes to the masjid webhook and the
    OpenMasjidOS alert channel, which are third-party sinks (a webhook is usually Slack or Discord), so
    it carries no household and no name-beside-an-amount — an amount alone is fine, which is where §14's
    line has always been. It is a required field rather than defaulting to `text` on purpose: a default
    would leak a family's name into a chat channel the first time somebody forgot it, and nothing would
    ever surface that. Neither text may carry a **Student ID** (a payment credential), card details, or
    anything from a payment proof. Logs get the event id and a count only, never an address or a body.
  - **The webhook half of that is now a default, not an absolute** (0.51.0-dev.17). An office may switch
    its own webhook over to the naming `text` — it is how "Yusuf Ismail paid $250" reaches a masjid's
    staff channel, which is a thing madāris ask for. The design work is entirely in keeping the grant
    narrow: `webhookNamesStudent` is off on every install, admin-only, audited both ways, and is only one
    of THREE conditions — `SPEC[event].webhook && SPEC[event].webhookMayName && the setting`. Eligibility
    is declared per event and `payment-received` is the only one that has it, so consent to a payment
    notice is not consent to the past-due roster or to a refund notice naming the invoice lines. The
    **OpenMasjidOS alert channel is not covered**: `raiseAlert` takes `publicText` unconditionally, and
    the two sends are deliberately not hoisted into one shared variable. `webhookTextFor` is the single
    place that decides, and it is an exported function rather than an inline ternary because the
    eligibility half has no reachable counter-example today — firing an ineligible event posts nothing to
    the webhook at all, so the obvious test for it is vacuous. `notifyPlatform` also logs a rejected
    status now, which it never did: an office that opens this channel will reasonably expect to see
    messages arrive, and silence used to be indistinguishable from success.
  - `platformAlertIds()` exists purely so `test/alerts.test.ts` can hold the code against
    `manifest.yaml`. It only guards the half that lives in this repo — the catalog entry is the other
    half, and a release has to carry it (§19 step 6).
  - **Parent emails are gated inside `mail/notify.ts`**, not at the call sites: receipts are sent from
    five places (portal, autopay, kiosk, donation site, and the office's own cash entry), and a check
    per caller is a check somebody forgets. 0.44.0 also added the three that were missing — cash, kiosk
    and donation-site payments told the family nothing before.

- **`payments.recorded_by_name` is a DISPLAY name; `audit_log.actor_name` is the USERNAME** (0.44.0,
  `recordingActor` vs `auditActor` in `trpc/trpc.ts`). Two different questions: the office asks "who
  took this cash?" and wants a person's name, while the audit trail wants the account identity, which is
  unique and is what an admin disables. An OpenMasjidOS SSO session has no local account, so it records
  plain `Admin` — the platform's `username` is untrusted display text from another system (§12) and this
  row is immutable.

## Origin policy — reconciliation with §12.4 (IMPORTANT)

`CLAUDE.md` §12.4 says classify a request as `tunnel` if **`cf-ray` is present OR
`x-forwarded-proto: https`**. We implement a **fail-closed, IP-based** rule that preserves
the *intent* (admin = LAN-only) and hardens it. Reason (confirmed against OpenMasjidOS
v0.40.0 source, and an adversarial review that found the naive rule exploitable):

1. This app is `https: true`. On the **LAN**, OpenMasjidOS runs a per-app TLS proxy
   (`packages/core/src/system/app-proxy.ts`) that **always** forwards
   `x-forwarded-proto: https` — even for a LAN admin. The tunnel ingress
   (`ingress.ts`) sets `x-forwarded-proto: https` **and** `cf-ray`. So `x-forwarded-proto`
   cannot distinguish LAN-https from tunnel — using it would lock admins out of the LAN.
2. Worse, **"no `cf-ray`" is NOT proof of a trusted LAN**: a request that reaches our
   published port directly from the internet (an unfirewalled VPS / port-forward) also has
   no `cf-ray`. Classifying that as `lan` would expose admin — and, on a fresh install,
   let an internet attacker create the first admin. So absence-of-a-header must never grant.

**The rule (`packages/server/src/security/origin.ts`):**
- `tunnel` if `cf-ray` is present (genuine Cloudflare) **OR** the effective client IP is
  public. `lan` **only** when the effective client IP is **private/loopback/link-local**.
- Effective client IP trusts `cf-connecting-ip`/`x-forwarded-for` **only when the TCP peer
  is itself local** (an OS proxy / loopback); a direct client's forged forwarding headers
  are ignored (the unspoofable socket peer wins). `x-forwarded-proto` is used ONLY for the
  cookie `Secure` flag, never for the policy.
- **Fail-closed + safe both directions:** a public client can never be `lan` (spoofing
  `cf-ray` or a private XFF only *downgrades* to `tunnel`); a tunnel client can't strip
  `cf-ray` and can't forge a private peer. On a VPS, admin therefore requires a genuinely
  local path (e.g. SSH-tunnel to loopback) — exactly §12.4's "admin never over the internet."

Covered by `security/origin.test.ts` (incl. the VPS/public-client cases) + the
`test/auth.test.ts` matrix. **If the OS changes how its proxies set peer/forwarding
headers, revisit this.** Operators should still firewall the published port on
internet-exposed hosts (defense in depth) — see `docker-compose.yml`.

## Assumptions log (§20 open questions)

Working assumptions in force unless/until Hasan says otherwise. **Ask before the step that depends on it.**

| # | Question | Working assumption | Confirm before step |
|---|----------|--------------------|---------------------|
| 1 | OS-side names (`tunnel:`, `fabric:`, `OPENMASJID_PUBLIC_URL`) | Use the names in CLAUDE.md; reconcile once the OS work order lands | 14–17 (Fabric/tunnel) |
| 2 | Default host port | `8360` (host) → `8080` (container) | Manifest/compose (step 1) |
| 3 | Autopay trigger; portal overpay | Charge **on due date**; overpay allowed → family credit | 16 (autopay) |
| 4 | Parent self-registration default | **ON** (child's Student ID + on-file guardian email + email verify) | 11 (portal) |
| 5 | Gradebook visibility to parents | Visible **immediately on entry** (publish workflow deferred) | 5 (gradebook) |
| 6 | SMTP provider | Per-masjid in-app settings only (no house relay) | portal/mail steps |
| 7 | PIN policy + name match | **ANSWERED (Hasan, 2026-07-26): no PINs.** Removed in v0.39.0 — the Student ID (`YUS1234`) is the whole credential, because the only thing it authorizes is *paying* someone's tuition. Replaced by a name-confirmation step (`identify`) plus a shared per-ID lockout. Contract → **v2**. | done |
| 8 | Existing campaign-type enum values `tuition` joins | **ANSWERED (recon):** enum is `donation \| zakat \| tuition` in BOTH Donations (`server` + `web`) and Kiosk (added v0.9.12). `tuition` ALREADY EXISTS — we mirror it, nothing to add. Type drives the card-fee rule (donation=optional cover, zakat=forced cover, tuition=admin-toggle). | 14 (Fabric provider) |
| 9 | Default madrasa scale + merit categories | Ship the CLAUDE.md defaults (Mumtāz…Rāsib; Ādāb, Sunnah, Hifz milestone, Helping others), admin-editable | 5/6 |
| 10 | Report cards: scale bands + teacher remark | Show scale band by default; keep optional per-student remark | 7 |
| 11 | `/apply` default field set | guardian name+contact, child name+DOB, program interest | 12 (admissions) |
| 12 | Transcripts: terms × classes × final grade | Sufficient for v1 (no credit-hours/GPA) | 8 (transcripts) |

> **Q8 is the one recon must answer.** The real campaign-type enum values in OpenMasjidDonations
> and OpenMasjidKiosk get pasted here once confirmed, so step 14 registers `tuition` alongside them correctly.
