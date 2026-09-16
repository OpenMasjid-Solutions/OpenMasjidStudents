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

The **39 tables** that exist, grouped by what they are for:

| Area | Tables |
| --- | --- |
| Config | `settings` |
| Accounts | `users`, `sessions`, `invites`, `password_resets` |
| Structure | `schools`, `user_schools`, `school_years`, `terms`, `courses`, `classes` |
| People | `families`, `students`, `student_notes`, `guardians`, `guardian_families`, `guardian_users`, `emergency_contacts` |
| Fees | `fee_plans`, `student_fees`, `charge_items`, `charges` |
| Billing | `invoices`, `invoice_items`, `payments`, `payment_allocations`, `carry_ins`, `past_due_reminders`, `standing_payments` |
| Cards | `payment_methods`, `autopay_enrollments`, `autopay_runs` |
| Admissions | `inquiries`, `inquiry_events`, `admission_links`, `readmissions` *(0.52.0-dev.7; states cut to four in -dev.11)* |
| Notifications | `alert_recipients`, `whatsapp_log` |
| Trail | `audit_log` |

Notable absences, each deliberate:

- **`stripe_events`** — dropped in 0.48.0 (migration 0037). It deduplicated webhook deliveries and
  there is no webhook (§13.4); a money schema carrying a table nobody writes is an invitation to wire
  the next thing to it.
- **`attachments`** — payment-proof uploads were planned once and never built, and student photos and
  admission documents were **considered and rejected** for the academic layer (0.52.0). There is still no
  upload path, no multipart plugin and no `/data/attachments` (CLAUDE.md §4 ❌). §14 now carries the six
  questions any future upload work must answer first — it did not when §4 started citing it.
- ~~**`enrollments`**~~ — **this absence is REVERSED for 0.52.0.** The reasoning below was that fees
  attach to the STUDENT (`student_fees`) and not to a class enrollment, so each child's bill is their
  own. That is still exactly right **about money**, and `student_fees` does not move. It was wrong about
  **time**: `students.class_id` is a single current pointer that rollover rewrites in place with no undo,
  and the class history cannot be recovered from `audit_log` because every class-change entry records the
  new value or a count and never the old one. Attendance needs "the roster on that date", so
  `enrollments` returns as a **temporal** table (see §"The academic layer" below), not as a place for
  money to attach.

## The academic layer (0.52.0 →) — planned tables

> **None of these exist yet.** CLAUDE.md §4a is the scope and its status table is the honest record of
> what has shipped; `docs/ADMISSIONS.md`, `docs/ATTENDANCE.md` and `docs/ACADEMICS.md` carry the column
> lists and the reasoning. **This section is updated as each phase lands** — a table moves from here into
> the list above in the same commit that creates its migration.

| Area | Tables | Phase |
| --- | --- | :-: |
| Roster over time | `enrollments` | 3 |
| Calendar | `closure_days`, `sessions` *(+ `school_years.teaching_days`)* | 3 |
| Attendance | `attendance_marks`, `registers` | 3 |
| Academics | `subjects`, `teachers`, `teaching_assignments`, `assessments`, `marks`, `hifz_records` | 4 |
| Report cards | `grading_schemes`, `grading_bands`, `report_cards`, `report_card_comments` | 5 |

Plus one column rather than a table: `school_years.teaching_days`.

**Phases 0 and 1 have SHIPPED, and Phase 2's SCHEMA has**, so their tables are in the list above and
not here: `charges.source_key` (migration 0041 — a nullable UNIQUE natural key, because `charges` had
no unique index at all and `chargeAdd` inserted with no existence check, so re-approving a
re-admission would have charged a family twice); the student-record columns and `student_notes`
(0042); the household details on `families` (0043); and **`inquiries`, `inquiry_events`,
`admission_links`, `readmissions` plus `school_years.admission_fee_cents` /
`readmission_fee_cents` (0044)**.

**0044 landed all four admissions tables at once, one build ahead of two of their writers**, and the
trade is worth recording. `admission_links` and `readmissions` have no writer until conversion and
re-admission ship. Normally that is exactly what CLAUDE.md §9 warns about — "a money schema with a
table nobody writes is an invitation to wire the next thing to it" — but these are not on the money
path, and the competing risk is larger: a hand-typed `_journal.json` `when` that is not strictly
greater applies perfectly on a fresh database and is **skipped forever** on a live one, so four
migrations is four chances at the highest-consequence mistake in this repo rather than one. An inert
table is the cheaper of the two.

Non-negotiable rules live in CLAUDE.md §9: Student IDs unique and always generated; money in integer
cents; idempotency keys UNIQUE; **balances derived, never stored**; payments immutable (reversals, not
edits); allocation derived and per line, with a payer's instruction re-honored; dates stored ISO and
compared as TEXT; FKs `ON DELETE RESTRICT` on money paths. Every table carries `id` and `created_at`,
and `updated_at` wherever a row is ever updated.

## Non-trivial decisions

- **THE v0.35.0 ACADEMICS PIVOT IS REVERSED** (0.52.0, per Hasan). The app gains a real student record,
  admissions, attendance, a gradebook and report cards, in six phases. CLAUDE.md §4a is the scope and
  carries the status per phase. Five schema decisions worth recording here because they are the ones a
  future reader will want the reasoning for, and each is argued in full in its `docs/` spec:
  - **`enrollments` returns as a temporal table, and `students.class_id` stays.** Deleting the pointer
    would be a large refactor of nine read paths for no gain; the fix is that **nothing writes it
    directly** any more — `structure/enrollment.ts` closes a row, opens a row and updates the pointer in
    one transaction, and placement, bulk placement, rollover, admission and re-admission all call it.
    **History begins the day it ships**; a term predating it reports "no roster history" rather than a
    number, because the alternative is a figure that looks right.
  - **A `registers` row exists separately from the marks**, so "nobody took this register" and "everyone
    was present" are distinguishable. Without it, register completion — the actual operational job — is
    unanswerable from the database.
  - **`charges.source_key` is a nullable UNIQUE natural key on `charges`**, not a guard inside
    admissions, because the next feature that raises money on a schedule will need it too. Repeating a
    key is a **no-op returning the existing charge**, since the caller is a bulk approve button.
  - **A finalized report card stores a STRUCTURED snapshot, not rendered HTML.** Freezing markup would
    pin the design system into a database row and break §15's re-sync, RTL and theme fixes. The house
    precedent is `snapshotCharge`: copy the fact, keep the id as provenance.
  - **Domain history tables (`inquiry_events`, the `corrected_by` stamps) knowingly duplicate a facet of
    `audit_log`**, because §5 records that *nothing reads the audit log*. One function writes both rows
    so they cannot disagree. Building a real reader for `audit_log` would make most of that duplication
    unnecessary and is recorded as open (CLAUDE.md §20).
- **Address, languages and nationality live on the HOUSEHOLD, not the student** (0.52.0-dev.4,
  migration 0043). They shipped on the child in dev.3 and moved a release later on Hasan's correction,
  before any stable release carried them. A family shares all three, so per-child meant three copies
  that drift and an office correcting an address had to remember how many children were on the record
  — the same reasoning that has always put guardians and emergency contacts on `families` (§9), and
  what makes linking a sibling share them, and — from 0.52.0-dev.5, a second correction — they are
  shown and edited on the HOUSEHOLD record and nowhere else: rendering them on a child's record as
  well put one value on three screens for a family of three, which is the duplication the move
  existed to end. `people/fields.ts` gained a `scope` per field so one
  registry still answers every question about one; `familyColumnsFor` projects the household through
  the same role allow-list the child goes through; and a field submitted to the wrong procedure is
  **refused**, because writing it into the wrong table would look on screen like a save that did
  nothing. The carry-across takes the first NON-EMPTY value per household, deterministically by row id.
- **The importer can UPDATE, and the Student ID is the identity** (0.52.0-dev.4). Five rules, each
  chosen because the obvious alternative costs a whole roster: a row's Student ID decides create vs
  update and a NAME is never matched on (two children called Muhammad Ali is a thing that happens); an
  ID matching nothing is an error rather than a silent create; an empty cell leaves the field alone,
  with `(clear)` to empty one on purpose; only what changed is written; and money and guardians are
  read for a new child and refused as a CHANGE to an existing one. Repeating an exported fee plan or
  guardian unchanged is silent — without that the export could never round-trip, which the test suite
  found rather than a masjid.
- **A re-admission submission is a PROPOSAL, and only what changed is written** (0.52.0-dev.9). §4
  rules out parent-initiated data edits; the one exception it grants is a form submitted through a
  one-time token link, "which is not an edit — it lands as a proposal the office reviews as a diff
  before anything is written". So the family's answer goes into `readmissions.submitted_payload`
  inert, and `diffSubmission` is what turns it into a list of changes. It is used by BOTH the
  office's preview and the approval that applies it, rather than each computing its own, which is
  what makes "preview and commit agree" a property of the code instead of a hope — and it is the
  thing docs/ADMISSIONS.md §5 asks to be proven by a test running both over the same input.
  An ABSENT field means the form never carried it; an EMPTY one means a family cleared a pre-filled
  box on purpose. Conflating them would either wipe untouched fields or refuse to clear a deliberate
  one. Repeating a pre-filled value writes nothing at all, so `updated_at` still means something
  after a whole school re-enrolls.
- **One-time link tokens live in `auth/tokens.ts`, and there were three copies before** (0.52.0-dev.9).
  An invite, a password reset and now two admission links are the same object: CSPRNG, single-use,
  expiring, stored only as a SHA-256 hash. docs/ADMISSIONS.md §1.3 says to extract rather than copy,
  and the reason is that a second implementation is a second place to get expiry, single-use or
  hashing wrong — on surfaces reachable from the internet. The extraction repointed invites and
  resets in the same commit rather than leaving a fourth copy beside three.
- **The re-admission link says WHICH failure it is, unlike the public inquiry form** (0.52.0-dev.9),
  and the difference is principled rather than inconsistent. The inquiry form's key is a child's name
  and an email address, so any variation in its answer is an enumeration oracle. A token is 256 bits
  and unguessable, so telling its holder "that link has already been used" tells nobody anything they
  did not already have — and a family staring at "not found" when the real answer is "you already
  sent this" is a phone call to the office.
- **An inquiry is a table of its own, and `inquiries.student_id` points FORWARD** (0.52.0-dev.7).
  The convenient design is to create the student straight away and mark them pending, so the rest of
  the app can already see them. That would put an unconfirmed, publicly submitted record on the
  payment path — a Student ID is the whole credential at the kiosk and on the donation site (§11.2),
  so minting one for somebody who filled in a web form is an escalation, not a shortcut. So an inquiry
  never mints an ID, never appears in the directory and is never billable; the ID is minted at
  conversion and nowhere else. The link is one nullable column on the INQUIRY, set only at conversion,
  which means nothing on the money path can reach back into it. `ON DELETE SET NULL` rather than
  `RESTRICT`, unlike every money path, so the deliberate hard-delete door (§9) is never jammed by a
  record of a conversation: the inquiry survives as an admission whose student was later erased, which
  is the honest thing for it to say.
- **THE PIPELINE IS FOUR STATES, AND THE TRAIL STILL NAMES THE THREE THAT WENT** (0.52.0-dev.11).
  `new | waitlisted | admission | declined | admitted`, cut from seven on Hasan's instruction:
  `reviewing` and `offered` described a conversation the app never witnesses, so they were maintained
  as bookkeeping for their own sake, and `withdrawn` duplicated `declined`. Migration 0045 maps live
  rows (`reviewing`→`new`, `offered`→`admission`, `withdrawn`→`declined`) and **deliberately does not
  touch `inquiry_events`** — a trail edited to match a later vocabulary has stopped being evidence.
  So `LegacyInquiryState` exists as a READ-only type, `AnyInquiryState` is what an event row is typed
  as, and `NEXT_STATES` keeps entries for the three removed keys so a hand-edited row or a restored
  mid-upgrade backup is workable rather than a crash on every board render.
- **A declined inquiry can be reopened, and any inquiry can be erased for good** (0.52.0-dev.11).
  Retaining every refusal forever was a choice, not a requirement, and it is wrong for what a public
  form actually collects — test rows, duplicates, abuse. `admissions.remove` is admin-only, refused on
  `admitted` (that row is a child's provenance), writes its audit row FIRST with the names and never
  the message body, and cascades the trail and any outstanding link. Deleting is the one exit from the
  waitlist that is not a transition, so it calls `vacateWaitlistPosition` in the same transaction —
  the numbering has one owner (§16) and a queue that runs 1, 3 is a queue an office stops trusting.
- **`admitted` is unreachable from the office's own transition, by TYPE** (0.52.0-dev.7).
  `transitionInquiry`'s parameter excludes it, and `markAdmitted` is a separate export that
  `admissions/convert.ts` calls inside the transaction that created the child. A student existing is
  what `admitted` MEANS, so without the split, "mark it admitted" is one plausible-looking mutation
  away from an inquiry that claims a student nobody created. The tRPC enum excludes it too — two
  guards, one against a caller naming the state, one against the sequence.
- **`inquiry_events` deliberately duplicates a facet of `audit_log`** (0.52.0-dev.7). §5 records that
  nothing in this app READS the audit log; the admissions screen needs "who declined this, and why, on
  what day" as a product surface. So a transition writes both rows, from one function
  (`admissions/transition.ts`), and they cannot disagree. Building a real reader for `audit_log` would
  make this table unnecessary and is still worth doing (CLAUDE.md §4 🔭). The two halves carry
  different things on purpose: the office's own prose about a family is on the event row it will be
  read from, and never in the forensic trail (§14).
- **The public form's policy is one JSON settings row, and every switch in it reads `=== true`**
  (0.52.0-dev.7). `getExternalPaymentsEnabled` uses `!== '0'` because its safe value is ON; none of
  these is. A truncated or hand-edited row must fail into a form that does not answer. The
  `embedOrigins` list is the sharpest case of re-validate-on-read in the codebase — those strings are
  interpolated into a `Content-Security-Policy: frame-ancestors` header, so anything that is not a
  bare scheme-and-host is dropped rather than repaired, and `*` cannot be produced because it cannot
  survive the predicate.
- **The form's minimum time-to-submit is SIGNED, and the key is stored rather than per process**
  (0.52.0-dev.7). An unsigned render timestamp is a number a bot edits, so it is HMAC'd. Holding the
  key in memory would have been the obvious choice and the wrong one: a restart between opening the
  form and sending it would turn a real family's inquiry into a silently discarded one, and — because
  the response is identical whatever happens — nobody would ever find out. It authenticates nothing
  and grants nothing; the database file is already a secret whatever is in it (§9).
- **Medical fields exist, and the column allow-list is what makes them safe** (0.52.0). §14's
  "no medical fields" is amended, not excepted — and adding the column is only half the work, because
  `people.familyGet` is an `adminOrFinanceProcedure` doing a bare `SELECT` and the finance shell renders
  the **same** `FamilyDetail` component (its `readOnly` prop is cosmetic — every occurrence wraps a
  button). So the default without a mechanism is "finance sees it, with no code change." `people/fields.ts`
  is the one place answering all three questions about a student column — does it exist, did the office
  disable it, may this role see it — on the `YEAR_VIEW_COLUMNS` pattern, filtered against an allow-list
  **on read**. A new column is visible to nobody until it is listed. **Photos were removed from the brief
  by Hasan**; SSNs and uploads stay forbidden.
- **Homework module: dropped.** Per Hasan (2026-07-15), no homework-specific feature — and still dropped
  under the 0.52.0 reversal: assessments cover a homework *mark* (`kind: 'homework'`), which is not the
  same thing as a homework module that sets, collects and chases work.

- **UI = the family's shared "liquid glass" CSS design system, NOT shadcn/ui.** Per Hasan
  (2026-07-15) and recon: OpenMasjidOS/Display/Kiosk share `styles/{tokens,glass,app}.css` +
  hand-rolled inline-SVG primitives; none use shadcn/Radix/tailwind-merge. We port that system
  verbatim from OpenMasjidOS `packages/ui` for byte-parity + re-sync (§15). CLAUDE.md §7 was corrected to match this in 0.50.0 and now records the same decision — parity (§15,
  the harder constraint + Hasan's explicit "ui.ux same as them") is why. Ported files keep their SPDX
  header + an origin comment and stay structurally identical to upstream so theme fixes re-sync.

- **Default accent = cyan `#22D3EE` + gold `#F59E0B` over deep navy `#030D1A`.** Per Hasan
  (2026-07-15): match the LIVE siblings (Display/Kiosk, and OS's default accent), not the
  EMERALD described in CLAUDE.md §15. The token system supports swappable accents, so this is a
  one-token change if revisited. §15's emerald/gold is the org default; this install ships cyan/gold.

- **Backend = tRPC + Drizzle + npm-workspaces monorepo (per §7/§8), NOT the siblings' pattern.**
  Recon: Donations/Kiosk use plain Fastify REST + raw better-sqlite3 (`Store` class) + a `server/`
  `web/` split (no workspaces, no tRPC, no Drizzle). Our §7/§8 deliberately choose the more
  structured stack because this app's data model (§9, ~50 tables, FKs, migrations, immutable
  versioned artifacts) needs it and the spec is built around tRPC (`AppRouter` type import §6/§8,
  role+origin middleware §5). Following §7 exactly; noting the sibling divergence here.

- **Repo + image name = `OpenMasjidStudents` → `ghcr.io/openmasjid-solutions/openmasjidstudents`.**
  Per Hasan (2026-07-15): keep the current folder/GitHub name. **App id stays `students`** (locked by
  the Fabric contract — Donations & Kiosk already reference `students/billing`; the docs' canonical
  example is `students/billing`). CLAUDE.md §2 names the same image. The
  APPS catalog's stale `student-manager` coming-soon teaser must be renamed → `students` when we list
  (an OpenMasjidAPPS-repo change, step 14/release).

- **Fabric broker + Cloudflare tunnel already exist in OpenMasjidOS v0.40.0** (not a pending work
  order): `POST /api/fabric/app/:targetAppId/:capability/:method` (appLink.ts) and injected
  `OPENMASJID_PUBLIC_URL` are live. Env var names (`OPENMASJID_APP_ID/BASE_URL/APP_SECRET/PUBLIC_URL`),
  `/api/auth/session`, `/api/fabric/notify`, `/api/fabric/stripe`, `/api/public/appearance` all match
  our assumptions. Two notes: OS has **no `resources:` manifest key** (omit it); the public-URL
  endpoint `/api/fabric/site` is gated on a `domain:` capability our manifest can add later if needed
  (the injected `OPENMASJID_PUBLIC_URL` path works without it).

- **Alerts fan out to five places, and an ALERT RECIPIENT IS AN ADDRESS, NOT AN ACCOUNT** (0.44.0,
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
    admin typed — and, since 0.50.0, to a staff member's own WhatsApp number and to an approved staff
    GROUP whose admin ticked `detail` — and MAY name the household and the amount — without that an alert is unactionable, which
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
    half, and a release has to carry it (§19 step 7).
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
| 5 | Gradebook visibility to parents | **REOPENED by the 0.52.0 reversal, and ANSWERED: finalized report cards only** (Hasan). Live marks would need a parent-facing academic read surface in Phase 4, before Phase 5's freeze machinery exists. | Phase 5 |
| 6 | SMTP provider | **ANSWERED:** mail goes through the platform (`POST /api/fabric/email`); this app holds no mail credentials and degrades to copy/print links when the platform is absent (§4, §7). | done |
| 7 | PIN policy + name match | **ANSWERED (Hasan, 2026-07-26): no PINs.** Removed in v0.39.0 — the Student ID (`YUS1234`) is the whole credential, because the only thing it authorizes is *paying* someone's tuition. Replaced by a name-confirmation step (`identify`) plus a shared per-ID lockout. Contract → **v2**. | done |
| 8 | Campaign-type enum values `tuition` joins | **ANSWERED (recon):** the enum is `donation`, `zakat`, `tuition` in BOTH Donations (`server` + `web`) and Kiosk (added v0.9.12). `tuition` ALREADY EXISTS — we mirror it, nothing to add. | done |
| 9 | Madrasa grading scale + merit categories | **REOPENED, half ANSWERED: one grading scheme per install**, versioned, with bands the madrasah writes (A/B/C, 90+/80+, Mumtāz / Jayyid jiddan / Jayyid), plus a per-SUBJECT type (graded / pass-fail / narrative) so hifz needs no second scheme. **Merit stays out** (CLAUDE.md §4 ❌). | Phase 5 |
| 10 | Report cards | **REOPENED and ANSWERED** — per student per term, draft → finalized, frozen as a **structured snapshot** re-rendered by current templates, printable HTML with no PDF toolchain, on a parent route and predicate of its own. `docs/ACADEMICS.md` §3. | Phase 5 |
| 11 | `/apply` field set | **REOPENED and ANSWERED: a FIXED set**, not office-configurable — a configurable public form is a configurable attack surface. Child name, child DOB (optional), the year/class asked about as free text, parent name, email, phone, free-text message. Nothing medical, nothing financial, no documents. `docs/ADMISSIONS.md` §1.1. | Phase 2 |
| 12 | Transcripts | **STILL OUT** (CLAUDE.md §4 ❌), and not reopened by the reversal. Phase 5's annual cumulative view across a year's finalized cards is the foundation one would be built on later. | — |
| 13 | Partial refunds through Stripe | A credit (a negative charge) on the next bill; full refunds only (§4 ⭐) | before any partial-refund work |
| 14 | Saved bank accounts / ACH | Addable, but micro-deposit verification is unfinished — confirm a beta masjid actually takes ACH first | before finishing ACH |
| 15 | Per-term fee billing | **A LIVE GAP, found in the 0.51.0 audit.** `feeLines` bills a per-term plan only on a `periodKind: 'term'` run, and no screen can ask for one — so a per-term plan is configured and never invoiced. The year quote now excludes it and both screens say so; wiring term periods properly needs a period-key format, a label rule, and a decision about the month-keyed year grid. | before offering per-term billing |

| 16 | The academic layer's thirteen decisions | **ALL SETTLED (Hasan, 0.52.0)** — enrollment fee charged on enrollment; parents see finalized cards only; empty cells mean "not provided" on insert and "leave unchanged" on update; one grading scheme per install; structured snapshot; no XLSX library; manual waitlist ordering with no capacity; no documents and no photo; fixed inquiry fields; the office reconfirms a returning child's fee plan from a pre-filled diff; attendance per class per session; the register is admin-only but keyed `(class, date, session)` with `taken_by_user_id` from day one; attendance not in the portal until the report card. The table in CLAUDE.md §20 is the index. | — |
| 17 | Does the teacher record ever gain a login? | **Out for now** (CLAUDE.md §4 ❌). `teachers` deliberately carries **no `user_id`**, so the model cannot drift into an auth path by accident; `docs/ATTENDANCE.md` §3.4 records what the minimum login would need. | before adding any column linking a teacher to a user |
| 18 | Does `audit_log` get a real reader? | **Open.** §5 records that nothing reads it. The academic layer therefore duplicates a facet of it wherever a history is a product surface; a reader would make most of that unnecessary. | before building a third such duplicate |
| 19 | Does finance ever see medical fields? | **No, for 0.52.0** — the medical wall (CLAUDE.md §5) with a role-keyed column allow-list. Expect it to be asked once a nurse or a first-aider is involved. | before widening `people/fields.ts` |

> **Rows 5 and 9–12 were kept rather than deleted when the pivot closed them, and that is exactly why
> they could be REOPENED in place in 0.52.0** rather than re-asked from scratch: a log that quietly drops
> its closed questions reads as though they were never asked, and three of these came back. Rows 13–15
> are the pre-existing open ones; 16–19 are the academic layer's (CLAUDE.md §20).
