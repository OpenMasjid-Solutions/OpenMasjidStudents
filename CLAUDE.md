# CLAUDE.md — OpenMasjidStudents

> This file is the single source of truth for the OpenMasjidStudents project. Read it fully before writing any
> code. When in doubt, follow this document over your own assumptions. If something here is ambiguous, ask
> before guessing.
>
> **Product target, in one line:** self-hosted **tuition & fee management for a madrasa** — students with a
> generated Student ID, per-student fee plans, per-student invoices, a derived ledger, and payments by
> cash/Stripe (parent portal + autopay) **plus the OpenMasjid Donations site and Kiosk** over the Fabric.
>
> **This document was rewritten against the code at 0.48.0** (audit of 2026-08-13). It had carried a
> "SCOPE PIVOT" banner since v0.35.0 saying that several sections still described removed academic features
> and no longer applied — a banner is not documentation, so those sections now describe what actually
> exists. §11's wire contract, §12.4's origin policy, §13's payment flows, §14's security invariants and
> §19's release runbook are unchanged in substance; §4, §5, §6, §7, §8, §9, §10, §13.4, §17, §18 and §20 were
> corrected. **The section NUMBERS are load-bearing** — hundreds of code comments cite `§9`, `§12.4`, `§14`
> and the rest — so numbering never changes, only content.
>
> This app depends on two sibling work orders in other repos: **`OpenMasjidOS/docs/FABRIC_APP_LINK_AND_TUNNEL.md`**
> (the Fabric app-to-app broker + Cloudflare uplink) and the `STUDENTS_INTEGRATION.md` briefs in
> **OpenMasjidDonations** and **OpenMasjidKiosk**. §11 is the shared contract all four repos must agree on.
> If the contract changes here, it changes everywhere.

---

## Branching policy

> **Check this before you change anything.** `git branch --show-current` must print **`dev`**. If it
> prints anything else, switch before you edit a single file — do not "just fix this one thing" on
> another branch and sort the branch out afterwards.

The org runs **two update channels**, chosen by an Update Channel toggle in OpenMasjidOS. This repo has
one branch per channel:

| Branch | Channel | `manifest.yaml` `version:` | Image tags CI publishes | Compose `image:` |
| --- | --- | --- | --- | --- |
| **`dev`** | development | `X.Y.Z-dev.N` (prerelease) | `:X.Y.Z-dev.N` + `:dev` + `:dev-<sha>` | `…:X.Y.Z-dev.N` (the exact version) |
| **`main`** | stable | `X.Y.Z` | `:X.Y.Z` + `:latest` | release tag **+ `@sha256:` digest** |

**The rules, and they do not bend:**

1. **All development happens on `dev`** — every feature, fix, experiment, and docs change, in this
   session and every future one. **Never commit to `main`.** Work is committed and pushed to `dev` as
   normal; that needs no permission and should not be asked about.
2. **`main` changes only when Hasan says the words "merge to main"** (or "push to main"). Never merge,
   rebase onto, or cherry-pick into `main` on your own initiative — not for a hotfix, not for a typo,
   not for docs, and not because a fix looks urgent. Urgency is not authorization.
3. **Ask every time, at the end of every turn that pushed to `dev`.** Once an update is on `dev`,
   close the reply by asking whether he wants it pushed to `main` — and then keep working on `dev`
   until he actually says so. A turn that pushed to `dev` and did not ask has not finished. The answer
   is not remembered between updates: one "push to main" releases *that* update and nothing more, and
   the next push to `dev` gets the same question again. Silence, a new task, or an unrelated reply all
   mean **stay on `dev`**; only the explicit words move `main`.
4. **That merge IS the release.** It carries the whole §19 runbook with it: bump the version in all six
   places, merge `dev` into `main` (not a fast-forward — §19 step 3), let CI build, **re-pin the `@sha256`
   digest in `docker-compose.yml`**, tag THAT commit, then open a PR against **`OpenMasjidAPPS`'s `dev`
   branch** — never its `main`, which only a catalog maintainer moves. Nothing is released until that lands.
5. **Re-pinning the digest at step 4 is not optional bookkeeping.** `dev`'s compose names a *prerelease*
   tag. Merging that to `main` unchanged would ship a stable release pointing at a dev build's tag.
   `build-image.yml` refuses to publish a `v*` tag whose compose is not digest-pinned, or whose manifest
   version is still a prerelease — so the mistake fails loudly instead of shipping. Do not treat that
   guard as the plan.
6. **Every dev build gets its own version — `X.Y.Z-dev.N`.** `X.Y.Z` is the release being worked toward;
   `N` increments on every dev build you publish. It must **never** equal a stable version. Bumping it is
   part of pushing to `dev`, in the same six places §19 lists, **and in `docker-compose.yml`'s tag**.

**Why the prerelease version is load-bearing, not bookkeeping.** OpenMasjidOS detects an app update by
comparing the catalog's `version` against the installed one (`checkCatalogUpdate` → `isNewerVersion`);
`updateCatalogApp` returns "already up to date" when it is not newer, so `docker compose pull` never
runs. The dev channel was therefore **completely dead** for its first three builds: the dev catalog entry
declared the same version as stable and pointed at `:dev`, a tag that silently moved — so nothing
observable changed between builds, the platform could not notify anyone, and there was nothing to update
to. Distinct versions and immutable per-build tags are the fix. Two consequences worth knowing:

- **`isNewerVersion` is not semver.** It splits on `.` and `parseInt`s each part, so `0-dev` → `0` and
  `-dev.N` becomes a fourth numeric component: `0.46.0-dev.1` → `[0,46,0,1]`. Forward detection is
  correct (`0.45.2 < 0.46.0-dev.1 < 0.46.0-dev.2`), but a prerelease sorts **above** its own final
  release, so `0.46.0-dev.3 → 0.46.0` is *not* detected. A host coming off the dev channel stays put
  until the next patch. Platform-side; do not try to work around it here by inflating versions.
- **Never publish a dev catalog entry before its image exists.** The catalog pins the exact tag, so an
  entry that lands first gives a masjid a pull failure. Push to `dev`, let the build finish, then let the
  catalog pick it up.

**Channel wiring (what makes the dev channel actually a channel):**

- `.github/workflows/build-image.yml` resolves tags from the ref. Both channels publish
  `:<manifest version>`; on `dev` that is the tag the catalog pins, and it is safe **only** because the
  guard enforces that dev's version is always a `-dev.N` prerelease and so can never collide with a
  released stable tag. `:latest` stays main-only.
- The guard also refuses when the **compose tag and the manifest version disagree**, on any service — a
  stale tag would install the previous build while the catalog advertised the new version, which is a lie
  that looks exactly like success.
- Both channels build **multi-arch (amd64 + arm64)**. Masajid run this on Raspberry Pis, and the dev
  channel is where a Pi-only regression should surface.
- `ci.yml` (lint + test + build) runs on `dev` as well as `main`. `dev` is the branch that most needs it.
- The catalog needs **`dev_ref: dev`** alongside the stable `ref:` in this app's `OpenMasjidAPPS/registry.yaml`
  entry. That edit belongs to the catalog repo, not here — and once it is there the dev channel is
  self-serving: `dev_ref` follows this branch and the catalog rebuilds hourly, so **a dev build never needs a
  catalog change**. Only a STABLE release does, and that goes through a PR to the catalog's `dev` (§19 step 6).
- The CHANGELOG is filed under the **release** (`## [0.48.0]`), not per dev build; `version.test.ts`
  checks the base version, so `0.48.0-dev.3` is satisfied by the `0.48.0` heading.
- **The two channels read the SAME entry at different depths** — headlines on stable, everything on dev.
  That is a writing rule, not a build one; see §19's "One changelog, two audiences".

---

## 1. What we are building (one paragraph)

**OpenMasjidStudents** is a self-hosted **tuition & fee management** app **built for madāris** that runs as an
**OpenMasjidOS app**: one Docker container, installed from the App Store, all data on the masjid's own
hardware. It is a **three-role app**: **admins** manage students, households, fee plans and settings
(LAN-only, by design); a **finance manager** runs billing (invoices, charges, the ledger, manual payments,
refunds); and **parents** get their own phone-first portal with the family balance and one unified payment
history — **payable by card right in the app (Stripe)**, with **autopay** and saved cards, ordered by the
household. Every student gets an auto-generated **Student ID** (`YUS1234` — first three letters of the first
name + 4 digits); fees are assigned **per student** as **fee plans** (monthly / per-term / one-time) and
billed as **one invoice per student** each period (the parent still sees one combined balance and pays once).
Finance records cash/Zelle/check by hand, and prints **statements**, **household information sheets** and
**per-child invoices** carrying each child's Student ID and a portal-signup QR. Finance and parents work over
the **Cloudflare uplink the OS provides**; the admin surface stays on the masjid LAN. Tuition paid with a
**child's Student ID** through **OpenMasjidDonations** and **OpenMasjidKiosk** flows automatically into the
same ledger over the **OpenMasjidOS Fabric** — this app is the **provider** of the `students/billing`
capability those apps consume. A masjid running more than one programme on different calendars (a weekend
maktab beside a full-time hifz school) can define **schools** (0.47.0), which scope the calendar and the
class tree and never the household or the money.

Think: **"the madrasa's tuition & fee desk, in one container the masjid owns — and payable anywhere: the
portal, the kiosk, or the donation site."**

---

## 2. Where this fits (repos and boundaries)

| Repo | Role in this feature |
| --- | --- |
| **`OpenMasjidStudents`** (this repo) | The app: server, all three role UIs, database, direct Stripe payments (portal + autopay + refunds), the **provider** side of the `students/billing` Fabric capability. |
| **`OpenMasjidOS`** | The platform. Fabric core APIs, per-app secret, app-to-app broker, Cloudflare tunnel uplink, HTTPS serving for Stripe apps, transactional email, admin alerts, and (0.50.0) the **WhatsApp gateway + the one paced queue every app shares**. Work orders: `docs/FABRIC_APP_LINK_AND_TUNNEL.md`, `docs/WHATSAPP.md`. |
| **`OpenMasjidAPPS`** | The catalog. This app ships as its own repo + manifest; new manifest keys (`fabric:`, `tunnel:`, `alerts:`, `email:`, `domain:`) must be validated there too. |
| **`OpenMasjidDonations`** | **Consumer** of `students/billing`: its campaign system gains a **`tuition` campaign type** that is *fully managed by this container* — label from `info`, flow is **Student ID** → confirm the name → balance → pay. Brief: `docs/STUDENTS_INTEGRATION.md` there. |
| **`OpenMasjidKiosk`** | **Consumer** of `students/billing`: same **`tuition` campaign type** as a kiosk tile (Stripe Reader M2), same Student ID flow. Brief: `docs/STUDENTS_INTEGRATION.md` there. |

**App identity:** app id **`students`** (compose project `omos-students`, data at `/opt/openmasjid/apps/students/`),
display name **OpenMasjid Students**, repo **`OpenMasjid-Solutions/OpenMasjidStudents`**, image
**`ghcr.io/openmasjid-solutions/openmasjidstudents:<semver>`** (public, multi-arch amd64+arm64; the CI derives
the image name from the repo basename lowercased — no hyphen), category **`admin`**.

**Scope rule:** this app never talks to Donations or Kiosk directly, and they never talk to it directly —
**everything crosses through the OS core's Fabric broker** (§11). The one external system this app *does*
talk to directly is **Stripe** (portal payments, autopay, refunds, reconciliation), using keys fetched over
the Fabric.

**Madrasa-first is a design rule, not decoration:** shipped defaults, wording and printed artifacts are
madrasa-native, every label goes through i18n (Arabic/Urdu-ready), the office can rewrite the sentences on a
parent's sheet in Settings, and — per the org rule — sacred text never appears as decorative chrome.

---

## 3. Licensing — same hard rules as the rest of the org

- License: **AGPL-3.0-only**, with the org **CLA** (dual-licensing) — see `CLA.md`, `CONTRIBUTING.md`, and the
  CLA-assistant workflow, all mirroring `OpenMasjidOS`.
- **Every new file starts with the SPDX header** in its comment syntax — `// SPDX-License-Identifier: AGPL-3.0-only`
  (ts/tsx/js/css), `# …` (yml/sh/Dockerfile), `<!-- … -->` (md/html) — followed by
  `Copyright (C) 2026 OpenMasjid-Solutions`. Never strip an existing header.
- Never copy code from AGPL-incompatible sources — and **never copy QuickSchools' UI text, templates, assets,
  or code**; they are the feature benchmark, nothing more. Re-implement from behaviour. Permissive deps
  (MIT/ISC/BSD) are fine. When in doubt, write it yourself.
- **No AI co-author trailers in commits.** Conventional-commit messages (`feat:`, `fix:`, `docs:` …), small
  focused commits.
- Fonts and assets must be license-clean (OFL etc., as done in OpenMasjidDisplay).

---

## 4. Scope

### ✅ In scope (and built)

**People (the billing subjects)**
- Students (**one `fullName` field** — not a first/last pair, since many madrasa names do not split into two
  western halves; DOB optional, status active/withdrawn, notes). **Adding people starts with a STUDENT**
  (`people.studentAdd`) — there is no "add a family" step and nobody is ever asked to NAME a family (0.39.0).
  A household is formed by linking a new child to an existing sibling (`linkToStudentId` when adding,
  `people.familyAddSibling` afterwards — pick the household on screen plus the child to bring into it, which
  MERGES the two households; `studentUnlinkSiblings` undoes it). Its label is DERIVED from the children's
  surnames (`familyLabel`, in `people/household.ts`): one surname → "Ismail family", several → "Farooqi /
  Ismail", sorted so it never depends on who was added first. **Guardians** (name, phone, email, relation)
  attach to the HOUSEHOLD, which is exactly why linking a sibling is what makes the parent details apply to
  them — nothing is copied per student. **Emergency contacts** (flag guardians and/or add extra contacts per
  household). `people/siblingSuggest.ts` proposes households the office never linked.
- **Student IDs**: every student gets an **auto-generated Student ID at registration** — the first three
  letters of their name + 4 digits (`YUS1234`), UNIQUE per install. It is how a parent pays at the Donations
  site / Kiosk and one half of the portal self-registration door. **There is no PIN** (removed v0.39.0): the
  only thing a stranger with someone else's ID can do is pay their tuition, so the compensating controls are
  an on-screen name confirmation plus a hard per-ID lockout, not a shared secret (§11.2, §14).
- **Spreadsheet import** (`people/import.ts`): the office's own .xlsx or CSV, columns mapped on screen,
  guardians and siblings merged from continuation rows, dates read in the configured format, and a preview
  that names every row it would refuse. The web side reads .xlsx with no spreadsheet library (`lib/xlsx.ts`).

**Structure (grouping and the calendar, 0.46.0–0.47.0)**
- **Schools** — the calendar + grouping scope, NOT a tenant (§9). **School years** with terms, a real
  **rollover** (`structure/rollover.ts`) that promotes classes and carries children forward, and
  **courses → classes** as the roster tree. Classes are labels for grouping and bulk fee work; there is no
  timetable, attendance or gradebook and there will not be.
- `user_schools` optionally restricts a staff account to some schools. **No rows means all schools.**

**Finance (billing — the whole app)**
- **Fee plans**: amount (integer cents), cadence `monthly | per-term | one-time`, **assigned per STUDENT**
  (`student_fees`), with a per-student amount **override** — which is also how a sibling/hardship discount is
  expressed. (The family-level discount was removed in 0.39.0: with one bill per child it had nowhere honest
  to sit.) Writing plans is admin-only; finance reads them (0.42.0).
- **Charge items + charges**: a configurable catalogue of one-off things (a book fee, a trip) applied to one
  child or mass-applied to a class or course, each **snapshotting** its label and amount so re-pricing the
  item never rewrites history. A **negative** charge is how a credit, bursary or correction is expressed.
- **Invoices** per STUDENT (generated for a month/term by hand or by the nightly job), line items (one per
  plan, plus each charge), statuses `open | partially_paid | paid | void`, due dates, and a label resolved
  from a remembered template so the month on the bill always matches the period it is filed under.
- **Ledger & balances**: every balance is derived, never stored. A payment belongs to ONE STUDENT and
  auto-allocates to *their* invoices oldest-due-first, **per line**; overpayment stays as **that child's
  credit**, absorbed by their next invoice. A family balance is the sum of its children's, because one adult
  pays for all of them — and one card charge covering several children is recorded as one row per child
  (`billing/ledger.ts` `recordSplit`/`splitAcrossFamily`).
- **Starting mid-year** (`billing/carryIn.ts`, 0.43.0): a madrasah going live in February records what each
  child brings with them ONCE, as real dated ledger rows, and a billing floor stops the months before go-live
  ever being generated on top of it.
- **The year view** (`billing/yearCells.ts`, 0.42.0): every child × every month of the school year, at a
  glance, printable — which is how an office actually finds who is behind.
- **External payments** arrive over Fabric from Donations and Kiosk (§11); **portal and autopay payments**
  (§13) land in the same ledger. Finance *sees* the channel, Stripe reference, and status without doing
  anything.
- **Manual payments**: channel `cash | check | ach | zelle | other`, amount, date, memo, and optionally the
  exact lines the money was handed over for.
- **Refunds** (0.48.0, `payments/refunds.ts`): any transaction, grouped by Stripe PaymentIntent. A card
  payment is refunded at Stripe *and* reversed on the ledger, in that order; cash is reversed on the ledger
  with the screen saying plainly that a person still has to hand the money over. Full refunds only — a
  partial goes back as a credit on the next bill. A carried-forward balance is refused outright.
- **Past due** (0.48.0, `billing/pastDue.ts`): who is behind, on a grace period and a cadence the office
  sets; a reminder to the parent, a digest to the office.
- **Printable documents** (print-CSS HTML, served by `billing/statementRoutes.ts`): the household
  **statement**, the household **information sheet** (`people/onboardingSheet.ts`, with the office's own
  wording), the per-child **invoice** (`billing/invoiceDoc.ts`), and the **Student ID sheet by class**
  (`people/idSheet.ts`). All carry a portal-signup QR where it helps, and all print legibly in black and
  white on a masjid photocopier.
- **Stripe reconciliation** (safety net): daily job + on-demand button for PaymentIntents tagged
  `purpose=students-billing` (§11.4). Also what resolves an autopay run stuck at `pending`.
- Parent-account tools: create/invite guardians, resend invites, send a reset, disable accounts, see autopay
  status per household.

**Parent portal (tunnel-first — the headline)**
- Login lands on **My family**: the kids (with their Student IDs), the family balance, open invoices with the
  lines they are made of, and one unified payment history saying what each payment was FOR (kiosk / donation
  site / portal / autopay / cash).
- **The year at a glance**, the same squares the office sees (0.48.0).
- **Pay now**: pay the full balance, a chosen amount, or specific lines, by card or bank, via **Stripe
  Elements**.
- **Saved methods**: add/remove, and **order them** — first choice, second, third — which is the order
  autopay's retry ladder walks down (0.48.0).
- **Autopay**: per-family toggle — charge the first saved method automatically when invoices come due;
  decline handling with retries + emails; parent can turn it off any time (§13).
- Receipts by email; change your own password.

**Platform integration**
- Fabric **appearance inherit**, **SSO** (`sso: true`, LAN admin only), **notifications**, **email**
  (`email: true` — the platform owns the provider and the From address), **alerts** (`alerts:` — declared ids
  the admin can route), **domain** (`domain: true` — we learn our own public URL), and the **provider** side
  of `students/billing` (§11).
- **Cloudflare uplink** (`tunnel: true`): stable public HTTPS URL; used for parent/finance access, QR links
  and emailed invite/reset links. The app is **base-path aware** (`http/basePath.ts`) because the OS forwards
  the full prefix.
- **`https: true`** in the manifest — the parent portal embeds Stripe Elements, which requires a secure context.
- **Email alerts (0.44.0)**: admin Settings decides both halves — which emails PARENTS get (receipts,
  card-declined notices, past-due reminders; invites and resets always send), and **which addresses at the
  masjid** get told when something needs a person. A recipient is an address, not an account. See §9's alert
  rule for why this does not go through the platform's alert channel alone.
- **WhatsApp (0.50.0, `whatsapp: true`)** — **seven** parent messages and the same staff alerts, on the
  channel families actually read, through the masjid's own self-hosted OpenWA gateway. Every one of the
  seven exists on EMAIL too, with its own switch on each channel: `invoice-ready`, `receipt`, `past-due`,
  `autopay-upcoming`, `autopay-failed`, `card-expiring`, `payment-refunded`. **The platform owns
  the connection AND the single paced queue every app shares**, which is the entire defence for a number
  WhatsApp does not officially permit; this app never goes near a gateway and never designs for volume.
  Off by default, **paused by default**, every event off, with a **test student** whose household gets
  through the pause so a real message can be tried on one family. Parents opt out from their own portal;
  staff opt IN with a number and the alerts they want. One outreach button asks the households with no
  email address for one. Nothing auth-critical ever goes this way. Full doctrine: `docs/WHATSAPP.md`.
- **A master parent-mail pause**, for an install being set up or a mistake about to become 200 emails —
  and a second, independent one for WhatsApp, which starts ON (§9).
- **Installable on a phone** (0.48.0): a served web manifest carrying the masjid's own name and logo, an
  `apple-touch-icon` route for iOS, a deliberately near-empty service worker, and an install pop-up on every
  signed-in surface.
- **Audit log** on every sensitive write: fee assignment, invoices, payments, reversals, refunds, autopay
  changes, role/user changes — who, when, what.
- **Access-origin policy**: `admin` sessions work **only on the masjid LAN**; `finance` and `parent` work on
  LAN **and** over the Cloudflare uplink (§12.4 — hard constraint).
- **A snapshot of the database every 30 minutes** (`db/snapshot.ts`), because the platform tars a live volume.
- i18n (i18next) + RTL-safe layouts; light/dark via Fabric appearance; `prefers-reduced-motion`.

### ❌ Out of scope — do not build these

- **All academics / SIS** (removed in the v0.35.0 pivot): scheduling/timetable, attendance, gradebook, grading
  scales, merit, comment bank, exams, report cards, transcripts, term finals, admissions/the `/apply` form,
  the Report Creator, custom student fields, documents-on-file, student notes/incidents, and the
  **teacher/student** roles. Do not reintroduce any of these. Courses and classes survive **only** as labels
  for grouping and bulk fee work.
- **Stripe Billing subscriptions/invoices.** Autopay is saved-method + off-session PaymentIntents driven by
  **our** scheduler and **our** invoices (§13.3). Our ledger is the source of truth; never mirror it into
  Stripe objects.
- **Card-present hardware** in this app (that's Kiosk's job); wallets beyond what Elements gives for free.
- **Our own SMTP.** Mail goes through the platform (`email: true`). A standalone install sends nothing and
  degrades to copy/print links — that is a supported mode, not a bug.
- **Payment-proof attachments.** Planned once, never built; there is no upload path and no `/data/attachments`.
  If it comes back it comes back with §14's attachment rules intact.
- Parent-initiated data edits (changes go through the office); push notifications.
- Multi-tenant anything (one install = one masjid — and see §9 on why `schools` is not that); payroll, staff
  HR, zakat handling; a public REST API beyond §11.

### 🔭 Later (deferred by decision — design for, don't implement)

Partial refunds through the ledger (credits are the answer today); ACH autopay; TOTP 2FA for staff;
completing micro-deposit verification for saved bank accounts.

---

## 5. Roles, permissions, and origin policy (hard constraints — enforce server-side)

Three roles: **`admin`**, **`finance`**, **`parent`**. Every tRPC procedure declares a required role **and**
allowed origin; checks live in middleware (`trpc/trpc.ts`), never only in the UI. Parents are scoped to
**their own linked households** — enforced in queries (`trpc/familyAccess.ts`), not UI filters. A staff
account may additionally be restricted to certain **schools**, which narrows a view and never widens a role.

**Origin policy (Hasan's rule):**

| Role | LAN | Cloudflare tunnel |
| --- | :-: | :-: |
| `admin` | ✅ | ❌ **blocked — login and existing sessions both** |
| `finance` | ✅ | ✅ |
| `parent` | ✅ | ✅ |
| *(login / invite / reset / register pages)* | ✅ | ✅ *(§14 rate limits)* |
| *(`/fabric/*`)* | ✅ | ❌ **404 outright** |

**Permission matrix:**

| Capability | `admin` | `finance` | `parent` |
| --- | :-: | :-: | :-: |
| Settings: school name, currency, logo, colour, date format, contact, sheet wording | ✅ | ❌ | ❌ |
| Settings: Stripe account, email alerts, parent emails, past-due policy, self-registration | ✅ | ❌ | ❌ |
| Settings: WhatsApp (on/off, pause, events, country codes, test student, outreach, queue log) | ✅ | ❌ | ❌ |
| Staff accounts (create, role, disable, reset password, school limits) | ✅ | ❌ | ❌ |
| Staff WhatsApp number + which alerts they get on it | ✅ | ❌ | ❌ |
| **Opt out of WhatsApp** (and back in) | ❌ | ❌ | ✅ anyone on their own household |
| Schools, school years, terms, courses, classes, rollover — write | ✅ | ❌ | ❌ |
| Schools / years / courses / classes — read | ✅ | ✅ | ❌ |
| Students / households / guardians / emergency contacts — write | ✅ | ❌ | ❌ |
| Students directory — read | ✅ | ✅ | own household only |
| Guardian contact — read | ✅ | ✅ | own household |
| Spreadsheet import | ✅ | ❌ | ❌ |
| **Fee plans — define / archive / delete** (0.42.0) | ✅ | ❌ **read only** | ❌ |
| Fee assignment per student + amount override | ✅ | ✅ | ❌ |
| Charge items + charges (incl. mass apply, void) | ✅ | ✅ | ❌ |
| Invoices: generate, void; the year view; CSV export | ✅ | ✅ | ❌ (own bills only) |
| Ledger / all payments — read | ✅ | ✅ | own household only |
| Record manual payment | ✅ | ✅ | ❌ |
| Reverse a payment / **refund a transaction** | ✅ | ✅ | ❌ |
| Mid-year go-live: preview / commit | ✅ / ✅ | ✅ / ❌ | ❌ |
| Reconcile with Stripe | ✅ | ✅ | ❌ |
| Printable statements / sheets / invoices / ID sheets | ✅ | ✅ | ❌ (own kids' IDs shown in the portal) |
| **Pay by card (Elements)** | ❌ (no reason) | ❌ | ✅ own household |
| **Saved methods / order / autopay manage** | ✅ (see + force-disable) | view status | ✅ own household |
| Parent invites / resets / account admin | ✅ | ✅ | ❌ |
| Audit log — read | ✅ | ❌ | ❌ |

Clean walls, on purpose: **finance never sees settings or staff accounts; parents never see another
household, and never see the audit log or another child's record.** If a feature seems to need to cross a
wall, stop and ask.

---

## 6. Architecture

```
        LAN (masjid Wi-Fi)                        Internet (Cloudflare tunnel via the OS)
  ┌──────────────────────────────┐        ┌───────────────────────────────────────────┐
  │ ADMIN (only here)            │        │ Parents (portal, pay, autopay)             │
  │ + finance/parents on         │        │ Finance (billing, statements)              │
  │   masjid Wi-Fi               │        │ (Stripe is called OUTBOUND — no webhook)   │
  └──────────────┬───────────────┘        └───────────────────┬───────────────────────┘
                 │ HTTPS (platform-served,                    │ HTTPS (public URL, full path prefix)
                 │ https:true port)                           │
                 ▼                                            ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │                OpenMasjidStudents — ONE container                         │
   │  Fastify + tRPC (+ static built React UI: admin / billing / family)       │
   │  Students · households · schools/years/courses/classes · fee plans        │
   │  Invoices · charges · derived ledger · refunds · past due · year view     │
   │  Printable statements / sheets / invoices / ID sheets (print-CSS HTML)    │
   │  SQLite (WAL) via Drizzle  •  /data volume (db + 30-min snapshot)         │
   │  Auth (argon2id) + roles + ORIGIN POLICY (admin = LAN-only)                │
   │  Stripe: Elements PIs, SetupIntents, off-session autopay, refunds          │
   │  Scheduler: autopay · reconcile · auto-invoice · past due · snapshot        │
   │  /fabric/billing/*  ← secret-gated provider endpoints (LAN-only)           │
   │  /statements /sheets /invoices (authed)  ·  /api/logo /manifest.webmanifest│
   │  /apple-touch-icon.png /sw.js /api/public/appearance (open, no data)       │
   └───────────────▲──────────────────────────────────┬───────────────────────┘
                   │ core → app (brokered calls from   │ app → core: SSO check, notify,
                   │ Donations / Kiosk, authenticated  │ alert, email, site info,
                   │ by THIS app's own APP_SECRET)     │ stripe keys, appearance, WhatsApp
   ┌───────────────┴──────────────────────────────────▼───────────────────────┐
   │                          OpenMasjidOS core                                 │
   │  /api/auth/session  /api/fabric/notify  /api/fabric/alert                   │
   │  /api/fabric/email  /api/fabric/site    /api/fabric/stripe                  │
   │  /api/fabric/whatsapp  ← the masjid's own OpenWA gateway + ONE paced queue   │
   │  /api/fabric/app/students/billing/*  ← the broker (OS work order)           │
   │  Cloudflare tunnel: exposes app paths ONLY; /api/fabric/* and the app's     │
   │  /fabric/* prefix are NEVER reachable through the tunnel                    │
   └─────────────────────────────────────────────────────────────────────────────┘
```

- **One image, one container**; multi-stage Dockerfile; the Node daemon serves the tRPC API, the Fabric
  provider routes, the printable documents, the PWA files and the built static UI. One published web port
  (default host `8360` → container `8080`); the platform's `https: true` handling gives it a TLS host port on
  the LAN.
- **SQLite in WAL mode** on `/data`. All money in **integer cents**. Migrations run on boot.
- One React app, three route trees (`/admin`, `/billing`, `/family`) behind one login — the shell routes by
  role. The parent portal is designed **phone-first**, and since 0.48.0 the staff shell is too.
- Type safety end-to-end: the UI imports the server's tRPC `AppRouter` **type only**.
- **Standalone rule**: with no platform, no tunnel, no Donations/Kiosk and no mail, the app still fully works
  on the LAN — students, structure, fee plans, invoices, the ledger, manual payments, refunds of cash, every
  printable document. Every integration degrades gracefully and says why.

---

## 7. Tech stack (mirrors the org's house stack — confirm before deviating)

| Layer | Choice | Notes |
| --- | --- | --- |
| Language | **TypeScript everywhere**, `strict` | No `any` without a justifying comment. |
| Repo layout | **npm workspaces monorepo** (`packages/server`, `packages/web`) | Same as OpenMasjidOS. |
| Backend | **Node.js 20+ (CI: 22)**, **Fastify 5**, **tRPC 11** | Plain Fastify routes for `/fabric/*`, the printable documents and the PWA files. |
| DB | **SQLite (WAL)** via **better-sqlite3** + **Drizzle ORM** | Migrations committed; run on boot; forward-only. |
| Validation | **zod** at every tRPC / `/fabric` boundary | Including dates (§9). |
| Auth | **argon2id** (`@node-rs/argon2`) + signed, HTTP-only, `Secure` cookies | Origin policy middleware (§12.4). |
| Payments | **`stripe`** (Node SDK) + **`@stripe/stripe-js`/Elements** | Keys via Fabric (§13.1). Card data never touches our server. |
| Scheduler | **croner** in-process | Autopay, reconcile, auto-invoice, past due, snapshot. |
| Email | **the platform's provider** (`POST /api/fabric/email`) | No `nodemailer` — removed in the 2026-08-04 audit; nothing here holds mail credentials. |
| Frontend | **React 18 + Vite 6** | Relative asset base, so one build works at the root and under a path prefix. |
| Styling | **Tailwind CSS v4** + CSS custom properties | Tokens only; ported files stay structurally identical to upstream (§15). |
| Components | **shadcn/ui** (copied-in Radix) | |
| Animation | **Motion** | Reduced-motion, always. |
| Data/state | **TanStack Query** via tRPC React integration | |
| Icons | **lucide-react** + org masjid glyphs | |
| i18n | **i18next / react-i18next**, RTL-aware | English first; Arabic/Urdu-ready. |
| QR | **`qrcode`** (MIT) | Statements, sheets, portal signup links. |
| Printed documents | **print-CSS HTML**, assembled server-side and escaped | **No PDF renderer and no headless Chromium** — Pi-friendly, and a browser's own print dialog is what an office already knows. `@react-pdf/renderer` was removed with the academics. |
| Spreadsheets | hand-rolled reader (`web/src/lib/xlsx.ts`) | A .xlsx is a ZIP of XML and the browser has both halves; no spreadsheet dependency. |
| Build/deploy | Docker multi-stage → one runtime image | Public, multi-arch, digest-pinned per release. |

Keep it Pi-friendly. Ask before adding heavy dependencies.

---

## 8. Repository structure

```
OpenMasjidStudents/
├── CLAUDE.md / README.md / LICENSE / CLA.md / CONTRIBUTING.md / VERSION / CHANGELOG.md
├── manifest.yaml / docker-compose.yml / Dockerfile / package.json
├── .github/workflows/  ci.yml (lint+test+build) · build-image.yml (multi-arch → GHCR) · cla.yml
│
├── packages/
│   ├── server/
│   │   ├── drizzle/                     # committed migrations + _journal.json (forward-only)
│   │   └── src/
│   │       ├── index.ts                 # boot: Fastify + tRPC + static UI + /fabric + documents + PWA routes
│   │       ├── config.ts / logger.ts    # env (never persisted) · structured log, no PII
│   │       ├── db/                       # schema · migrations runner · ids · money · snapshot
│   │       ├── trpc/
│   │       │   ├── router.ts             # root AppRouter (type exported to the UI)
│   │       │   ├── trpc.ts               # context + role/origin middleware + audit/recording actors
│   │       │   ├── auth.ts               # login, sessions, invites, resets, self-registration, SSO
│   │       │   ├── staff.ts              # staff accounts, roles, school limits
│   │       │   ├── people.ts             # students, households, guardians, contacts, import
│   │       │   ├── structure.ts          # schools, years, terms, courses, classes, rollover
│   │       │   ├── billing.ts            # fee plans, charges, invoices, ledger, payments, refunds, mid-year
│   │       │   ├── portal.ts             # parent-scoped reads + pay-now + saved methods + autopay
│   │       │   └── settings.ts           # settings, alerts, past-due policy, Stripe account, diagnostics
│   │       ├── billing/                  # ledger · invoices · lines · paidFor · period · schoolYear ·
│   │       │                             # yearCells · carryIn · joinMidYear · autoInvoice · pastDue ·
│   │       │                             # statements · invoiceDoc · statementRoutes · studentCodes · csv
│   │       ├── payments/                 # stripe (the ONLY SDK importer) · autopay · refunds ·
│   │       │                             # reconcile · methods · scheduler
│   │       ├── fabric/                   # provider.ts (/fabric/billing/*) · platform.ts (calls to the OS)
│   │       ├── people/                   # names · household · relations · import · siblingSuggest ·
│   │       │                             # onboardingSheet · idSheet · sheetText
│   │       ├── schools/ structure/       # school scope resolution · year rollover
│   │       ├── settings/                 # settings store · dates (the one date edge)
│   │       ├── alerts/ mail/ audit/      # who hears about it · templates + senders · append-only trail
│   │       ├── whatsapp/                 # index.ts (every gate) · numbers.ts (E.164) · templates.ts
│   │       ├── security/                 # origin.ts (§12.4) · rateLimit.ts
│   │       ├── auth/                     # passwords · sessions · invites · usernames
│   │       └── http/                     # basePath · manifest (the PWA manifest builder)
│   │   └── test/                         # vitest: 800+ tests, incl. the security matrix
│   └── web/
│       └── src/
│           ├── routes/  login/ · admin/ · billing/ · family/
│           ├── components/  (FirstRunSetup, FamilyBilling, Refunds, MidYearSetup, InstallPrompt, …)
│           ├── lib/  (trpc, theme, i18n, motion, stripe, money, dates, phone, csv, xlsx, base)
│           ├── styles/  (tokens.css + app.css + glass.css ported from OpenMasjidOS; shell.css, admin.css ours)
│           └── public/  (icons, sw.js, apple-touch-icon.png)
└── docs/
    ├── FABRIC_BILLING_CONTRACT.md       # §11 extracted verbatim (the cross-repo contract)
    ├── PAYMENTS.md                      # §13 flows, the no-webhook doctrine, the autopay ladder
    ├── WHATSAPP.md                      # 0.50.0 — every gate, what never travels this way, numbers
    ├── DATA_MODEL.md                    # schema decisions, incl. the §12.4 reconciliation
    └── audit/                           # security audits: findings, remediation, what is still open
```

---

## 9. Data model (Drizzle/SQLite — key rules)

The tables, as they actually exist: `settings`, `users`, `sessions`, `invites`, `password_resets`,
`schools`, `user_schools`, `school_years`, `terms`, `courses`, `classes`, `families`, `students`,
`guardians`, `guardian_families`, `guardian_users`, `emergency_contacts`, `fee_plans`, `student_fees`,
`invoices`, `invoice_items`, `charge_items`, `charges`, `payments`, `payment_allocations`, `carry_ins`,
`past_due_reminders`, `payment_methods`, `autopay_enrollments`, `autopay_runs`, `alert_recipients`,
`whatsapp_log`, `audit_log`. Student IDs live on `students` (`student_code`, UNIQUE) — retrievable by design (they are
printed on statements). That list is the whole schema: `stripe_events` was dropped in 0.48.0 (migration
0037) because it deduped webhook deliveries and there is no webhook (§13.4) — a money schema with a table
nobody writes is an invitation to wire the next thing to it. The DB file holds minors' PII and every
payment record, so the file itself is a secret regardless.

Non-negotiable rules:

- **A SCHOOL scopes the calendar and the grouping. It never scopes the household or the money** (0.47.0).
  `schools` exists because a masjid may run a weekend maktab beside a full-time hifz programme on a
  different calendar, so `school_years.school_id` and `courses.school_id` (and through courses, classes)
  belong to one school, and `students.school_id` says which one a child attends. That is the whole of it.
  `families`, `invoices`, `payments`, `payment_allocations`, `autopay_*` and every fee plan are
  deliberately UNSCOPED: one adult pays the masjid once, so a household with a child in each school is
  one household with one balance, one portal login and one printed sheet. **This is not the multi-tenancy
  §4 rules out** — one install is still one masjid, and schools share every setting, every staff account
  and the Stripe account. `schools/index.ts` is the one place that resolves scope; `user_schools` is an
  opt-in RESTRICTION where **no rows means all schools**, so adding a second school can never silently
  lock an existing staff account out of the first, and a restriction narrows a view without ever widening
  a role (role is checked first, school second). Course names are unique per school, not per install.
- **Dates are stored ISO and only DISPLAYED otherwise** (0.47.0). `settings/dates.ts` owns all three edges:
  `formatDate` for output, `parseDateInput` for a spreadsheet column, and `isIsoDay` for a date arriving at a
  WRITE boundary — driven by one `date_format` setting. The storage format never moves, because every date
  column is compared as TEXT: a non-ISO value would break ordering silently, and `03/04` would mean two
  different days depending on who read it. ISO input is accepted whatever the setting, so this app's own
  export always re-imports. **A date on the money path is validated, not trusted** (0.48.0): the billing
  router refuses anything `isIsoDay` rejects, because a due date of `lol` stores happily and is then never
  chased and never autopaid, and an unparseable payment date reaches SQLite as NULL and 500s in the office's
  face. A regex is not enough — `2026-13-45` has the right shape and is not a day.
- **A student has ONE name column** (`students.full_name`). The Student ID prefix and the household label
  both DERIVE their piece of it at the point of use (`people/names.ts`) rather than storing a split, so one
  field stays authoritative. The Fabric contract still exposes `firstName` + `lastInitial` and still never
  returns a full surname (§11.2) — those are derived too.
- **Usernames are compared case-INSENSITIVELY, in one place** (`auth/usernames.ts`, 0.48.0). Login always
  matched loosely — a parent's username is their email address and a phone keyboard capitalises it — while
  every "is this name taken?" check compared exactly, and `users.username` is UNIQUE under a binary
  collation. So `Office` and `office` were both accepted and only one of them could ever be signed into. One
  helper now answers both questions; `findUserByUsername` tries an exact match first so an install that
  already has such a pair still works.
- **Staff carry a phone number again — because there is now a reason to (0.50.0).** `users.phone` was dropped
  once, and the rule was right for the reason it gave: the app never contacted staff by phone, so a number
  would have been personal data collected for no purpose. WhatsApp is that purpose — a declined card at nine
  on a Sunday evening reaches a treasurer's phone and does not reach their inbox. So the column is back
  **with** `phone_country` and `wa_events`, entirely opt-in per account, and clearing the number is the off
  switch. Minimisation is satisfied by the purpose, not by the absence; a number with no purpose is what the
  old rule forbade and still is.
- **WhatsApp gates in ONE place, and three of its defaults are the feature** (0.50.0, `whatsapp/index.ts`).
  `enabled` off, `paused` **ON** and every event off, on every install. The pause starting on is the one
  asymmetry with email, and it is deliberate: parent email is a channel every install has been using for
  releases, so pausing it by default would break working installs, whereas WhatsApp has never sent anything
  and the safe starting state is *configured but silent*. The pause **narrows** rather than stops — the
  **test student's household** still hears everything, which is the only way to try a real message without
  letting it reach a real roster; it is resolved from the STUDENT on every send (a moved child takes it with
  them, a withdrawn one fails closed) and it overrides a pause and nothing else. **It covers BOTH channels**
  (`settings/testStudent.ts`, which is why it lives in settings and not in `whatsapp/`): it lifted only the
  WhatsApp pause at first, so an office that set a test student and took a payment got nothing at all —
  the parent-EMAIL pause is a separate switch and held the receipt back silently. The email side honours it
  twice, at the sender AND in `guardianEmailsForFamily`, because that second line would otherwise cancel the
  exception the first one granted. `guardians.wa_opt_out` is the parent's own answer, stored on the PERSON
  rather than the household because it is a decision about a phone — and **nothing overrides it**, not the
  pause exception and not an office broadcast — but **any adult on a household may set it for anyone on that
  household**, because the portal IS the household (§5) and two parents sharing one balance and one set of
  cards should not need the office to switch a spouse's number on. Every parent message is an office-editable
  TEMPLATE with a fixed tag list per message (`whatsapp/templates.ts`); there is no tag for a Student ID or a
  card, which is the enforcement rather than a rule in a document. **A WhatsApp GROUP is a STAFF channel**
  (0.50.0) — a finance group subscribing to the same `ALERT_EVENTS` a staff account can, and the fifth
  fan-out of `alertStaff`. No parent event can reach one and nothing free-typed can either, because the
  platform's rule is that a group never carries a family's own business; per-family sends and group alerts
  use two functions with no shared parameter, so it is not expressible rather than merely forbidden. Which
  of an alert's two texts a group gets is the admin's `detail` switch, defaulting to the one that names
  NOBODY — this app cannot see who is in a group, and the wrong group is one mis-click away. **The three
  GLOBAL gates write no log
  row** — a switch that is off would fill the trail every invoice run — so `whatsapp.get` returns a
  `blockers` list instead and the screen prints it: without that an office turned the feature on, took a
  real payment and got no message AND no log entry, with nothing anywhere saying which gate did it. A new
  notification type is added to BOTH channels and defaults OFF on both; the two that ship ON by email
  (`receipt`, `autopayFailure`) do so only because an upgraded install was already sending them.
  `whatsapp_log` records event / recipient id / time / outcome and **never a message body**: a
  tuition message names a child and their fees, and a log is the copy that outlives the conversation.
  Nothing auth-critical (invite, reset, verification) is ever sent this way — a number can be banned
  overnight, and that day must not be the day nobody can sign in. `whatsapp/numbers.ts` is the one place a
  stored number becomes E.164; it refuses rather than guesses, because a number nobody can read is a fixable
  problem and a number mangled into somebody else's is not. See `docs/WHATSAPP.md`.
- **Allocation is DERIVED, not incremental.** An invoice's status comes from `payment_allocations`, so money
  paid before a bill existed has to be attached once that bill appears — `ledger.reallocateStudent` recomputes
  a student's whole mapping oldest-due-first whenever an invoice or charge changes. Payments themselves are
  never touched.
- **Allocation is PER LINE, and a payer's instruction survives the recompute** (0.43.0).
  `payment_allocations.invoice_item_id` names the line a payment covered (null = the invoice as a whole, which
  is every row written before 0.43.0; `billing/lines.ts` reads those by spreading them over the lines in
  order). When a parent chose lines — "this $50 is the book fee", at the kiosk, on the donation site or in the
  portal — that choice is stored on the payment (`payments.directed`, immutable like the rest of it) and
  re-honoured by every later `reallocateStudent` BEFORE the oldest-due-first sweep. Storing it is the whole
  point: an instruction applied only at the moment of payment is undone by the next invoice, and the line the
  parent deliberately settled would read as outstanding again. `billing/lines.ts` is the ONE place that turns
  an invoice into lines, and `orderedItems` there is the ONE canonical order (tuition → charges → credits) —
  the allocator uses it too, because a display order that differed from the allocation order would show
  balances against the wrong lines.
- **A mid-year start is a ledger artifact, never a setting** (0.43.0). A madrasa that goes live in February
  records what each child brings with them ONCE: a past-dated `carry-in` invoice ("Balance carried forward")
  if they owe, a dated `carry_in` payment if they are ahead — both real rows feeding the same
  `invoiced − paid` subtraction. The months before go-live are never generated, and
  `settings.billing_start_period` refuses them afterwards, because recording the autumn as one figure AND
  generating September would bill the same arrears twice. `billing/carryIn.ts` holds the whole derivation so
  the preview the office approves is computed by the code that then writes it. A `carry_in` payment is also
  the one payment that can never be refunded (§4).
- **Student IDs are UNIQUE per install** (the lookup index for every payment path, §11.2) and always
  GENERATED, never chosen or imported — two children sharing one would land a payment on the wrong record.
  They appear **nowhere** in logs or Stripe metadata (statements and staff screens are the intended places).
- **Money = integer cents**; currency per install (default `usd`); no floats; one formatting helper.
- **Idempotency**: `payments.idempotency_key` UNIQUE (Stripe PI id, whatever the channel — portal, autopay,
  donations-web, kiosk). Replays return the original result.
- **Payment channels**: `donations-web | kiosk | portal | autopay | cash | check | ach | zelle | other | carry_in`.
  One `billing/ledger.ts` records them all — the Fabric provider, the portal, autopay, reconciliation and the
  manual-payment UI are thin callers of the same function.
- **Invoices and payments are per STUDENT** (`invoices.student_id`, `payments.student_id`, both NOT NULL since
  0.39.0). One card charge for several children fans out to one row per child, keyed
  `${idempotencyKey}:${studentId}` so the UNIQUE index still makes a replay a no-op per child. Anything that
  DERIVES a split must check `recordedSplit(key)` first — re-deriving after a successful call reads the
  invoices it already paid down and would record the money twice. A prefix match on that key uses `substr`,
  never `LIKE`: `_` is a LIKE wildcard and Stripe ids are full of them.
- **Balances derived, never stored**; **payments immutable** (corrections = reversal rows, refunds = a Stripe
  refund plus those same reversal rows); soft-delete for anything money references; FKs `ON DELETE RESTRICT`
  on money paths.
- **An alert must be able to reach a human without the platform's help** (0.44.0). `alerts/index.ts` is the
  ONE place that decides who hears about an event, and it fans out three ways: the addresses the office listed
  (`alert_recipients` → our own email), the OpenMasjidOS alert channel when the event maps to a declared id,
  and the masjid webhook for routine ones. Both of the older channels can be silently dead — a webhook nobody
  configured, and `raiseAlert`, which is answered `400 Unknown alert` for any id missing from **the catalog
  entry the masjid installed from** (that is how `payment-short` was dropped for all of 0.43.0, fail-soft and
  invisible). So declaring an id in `manifest.yaml` is necessary but never sufficient, and
  `test/alerts.test.ts` fails the build when the code can raise an id the manifest does not declare — **or
  when an event has no label in the web app's `en.json`**, which is how `settings.ev_payment-refunded` reached
  a masjid's screen as a raw key. Every alert carries TWO texts and both are required: `text` (our email, to
  addresses an admin typed) MAY name a person and the amount, because without that it is unactionable;
  `publicText` (the webhook + the platform alert channel — third-party sinks) carries no name and no
  name-beside-an-amount, which is where §14's line has always been. Neither may carry a Student ID or card
  details. Parent-facing emails are gated inside `mail/notify.ts` (never per call site: receipts are sent from
  five places).
- **An alert names the STUDENT, never the household** (0.50.0-dev.14). It said "the Ismail family paid $250"
  for six releases, and that is one indirection away from what this app bills: **invoices and payments are
  per student**, so a household label makes an office do a lookup the alert could have done, and it hides the
  only number that matters — a family total of $430 does not say that it is Yusuf's two missed months and
  Maryam is square. It is also a label that identifies nothing on its own, being DERIVED from the children's
  surnames (`people/household.ts`): four Ismail households produce four identical alerts, and a mixed
  household reads "Farooqi / Ismail", naming a child who may not be the one who is behind. So
  `alerts/index.ts` exports `studentName`, `studentAmounts` (per-child, since one card charge is recorded as
  one row per child) and `childrenOf` — the last for the two facts that genuinely belong to the household, a
  CARD and an AUTOPAY enrolment, which name the children they pay FOR rather than pretending a child owns the
  card. The past-due digest counts and lists STUDENTS while still chasing one household once, and says both
  numbers, because otherwise an office wonders why 9 students produced 5 emails. **The privacy line does not
  move**: all of this is the `text` variant, where a name beside an amount was always allowed; `publicText`
  still names nobody, and `test/pastDue.test.ts` now asserts the child's name is absent from it too. Watch
  for vacuous assertions here — that test's helper used to name the child "<household label> child", so
  "the household name is gone" passed on a substring of the student's name.
- **`payments.recorded_by_name` is the person; `audit_log.actor_name` is the account** (0.44.0).
  `recordingActor(ctx)` stamps a money row with the staff member's display name, because the office reads it
  back asking "who took this cash?"; `auditActor(ctx)` keeps the username, because a forensic trail wants the
  identity an admin can disable. An SSO session has no local account and records plain `Admin` — never the
  platform's own untrusted display text (§12).
- `autopay_runs` UNIQUE on (family, run_date): the scheduler's own idempotency, and the Stripe idempotency key
  for PI creation is derived from it (§13.3).
- Every table: id, created_at, and updated_at where a row is ever updated.

---

## 10. Catalog manifest (`manifest.yaml`)

Follows `OpenMasjidOS/docs/APP_MANIFEST_SPEC.md` + `OpenMasjidAPPS/docs/BUILDING_AN_APP.md`. The real shape
(see the file itself for the alert descriptions and the reasoning comments):

```yaml
id: students
name: OpenMasjid Students
version: 0.48.0-dev.N        # X.Y.Z on main — §19
tagline: Tuition & fees for your madrasa — pay online, at the kiosk, or on the donation site
category: admin
icon: icon.svg
sso: true                # platform admin opens it signed-in on the LAN
notifications: true      # routine payment notices to the masjid webhook
stripe: true             # keys via GET /api/fabric/stripe — real charges (§13)
https: true              # REQUIRED: the parent portal embeds Stripe Elements (secure context)
tunnel: true             # public HTTPS uplink for parents + finance
domain: true             # learn our own public address at runtime (GET /api/fabric/site)
email: true              # transactional mail through the masjid's provider (POST /api/fabric/email)
whatsapp: true           # 0.50.0 — send through the masjid's own OpenWA gateway (§9, docs/WHATSAPP.md)
alerts:                  # declaring an id IS the authorization; the admin routes each one
  - id: autopay-disabled …
  - id: lookup-lockout …
  - id: reconcile-recovered …
  - id: payment-short …
  - id: past-due …
  - id: payment-refunded …
  - id: test …
fabric:
  provides:
    - capability: billing
ports:
  - container: 8080
    label: Web interface
```

**A capability declared here is necessary and never sufficient — check the BUILT entry, not this file.**
OpenMasjidOS reads capabilities from the catalog entry the masjid installed from, so a key that does not
survive the catalog build does not exist as far as the platform is concerned. `whatsapp: true` hit exactly
that in 0.50.0: the manifest was right, the build was green, and every call was answered `403` because
`OpenMasjidAPPS/scripts/build-catalog.mjs` copied capabilities through a hand-maintained allow-list with no
`whatsapp` line — `email` survived, `whatsapp` vanished, and the failure surfaced in a different repo from
the mistake.

The catalog repo has since killed the class rather than the instance (`364f91b`): `scripts/capabilities.mjs`
is now the ONE list the builder both type-checks and copies from, so "validated here but forgotten in the
entry" is no longer expressible, and a test scrapes the documented manifest template in
`docs/BUILDING_AN_APP.md` and asserts every capability it offers survives into a built entry — in both
directions, so one cannot be wired without being documented. **So a new capability should now carry through
on its own.** Verify it anyway, because the cost of not verifying is a 403 nobody can diagnose from here:
`git show origin/dev:catalog.json` in the catalog repo is the only thing that answers "did it actually ship?".

**No install-time `settings:` on purpose** — installation is one-click, and everything a masjid needs (school
name, currency, logo, which OpenMasjidOS Stripe account to charge, email alert recipients) is collected
INSIDE the app by the first-run setup and Settings, persisted to `/data`. Same pattern as OpenMasjid
Donations; the org rule is that the platform injects no masjid profile and each app owns its own config.

The compose **must reference** the Fabric env vars in `environment:` (`${VAR}` substitution — forget one and
the Fabric silently no-ops): `OPENMASJID_APP_ID`, `OPENMASJID_BASE_URL`, `OPENMASJID_APP_SECRET`, and
`OPENMASJID_PUBLIC_URL` (tunnel URL; empty when not exposed — var name owned by the OS work order, keep in
sync). The compose `image:` line is **digest-pinned per release** —
`ghcr.io/openmasjid-solutions/openmasjidstudents:<semver>@sha256:<digest>` (§19), never a floating tag.

---

## 11. THE SHARED CONTRACT — Fabric capability `students/billing` (v2)

> Source of truth for four repos. Copied verbatim into `docs/FABRIC_BILLING_CONTRACT.md`; the
> OS/Donations/Kiosk briefs point there. Version the contract (`"v": 2` in every response — v2 dropped the
> PIN from `lookup`; see `docs/FABRIC_BILLING_CONTRACT.md` §11.0 for the v1→v2 note and what a consumer must
> change). Consumers surface this capability as a **`tuition` campaign type** in their own campaign systems:
> the campaign shell (tile/card) lives in Donations/Kiosk, but everything inside it — label, lookup, balances,
> recording — is **fully managed by this container** via the methods below. **The parent portal (§13) does NOT
> change this contract** — portal/autopay payments are recorded internally and only touch §11.3 (a third
> `omos_app` value).

### 11.1 Transport (all four repos must agree)

- Consumers (Donations, Kiosk) call the **OS broker**, never this app directly:
  `POST ${OPENMASJID_BASE_URL}/api/fabric/app/students/billing/<method>` with header
  `X-OpenMasjid-App-Secret: <the CALLER's own secret>` and a JSON body.
- The core verifies the caller's secret + that the caller's manifest declares `fabric.consumes: [students/billing]`,
  then proxies to this app's published port at `POST /fabric/billing/<method>`, setting:
  - `X-OpenMasjid-App-Secret: <THIS app's own secret>` — proof the request came from the platform (only the
    platform knows our secret);
  - `X-OpenMasjid-Caller-App: donations | kiosk` — trusted caller identity, set by the core.
- **This app must:** 401 any `/fabric/*` request whose secret header doesn't match `OPENMASJID_APP_SECRET`
  (constant-time compare); ignore/strip client-supplied `X-OpenMasjid-Caller-App` on non-Fabric routes; never
  serve `/fabric/*` to tunnel-origin requests (defense in depth — the OS blocks the prefix too; we answer
  404). Limits: JSON only, ≤256 KB, respond < 10 s.
- Errors from this app: HTTP status + `{ "error": { "code", "message" } }`. Broker-generated errors arrive as
  `{ "fabric_error": { "code", "message" } }` (`target_not_installed`, `target_unreachable`, `timeout`,
  `not_granted`, `rate_limited`) — consumers must fail soft on those.

### 11.2 Methods this app provides

**`POST /fabric/billing/info`** — what consumers need to render the tuition campaign shell.
```jsonc
{ "v": 1 }
→ { "v": 2, "enabled": true, "schoolName": "An-Noor Weekend School", "currency": "usd",
    "tagline": "Pay tuition with your child's Student ID",
    "allowAdvance": true, "minAmountCents": 100 }   // 0.41.0, additive
// "enabled": false (setup incomplete or external payments turned off by admin) → consumers hide the campaign
// allowAdvance: a parent may pay when NOTHING is due (a term up front, a Ramadan lump sum) — consumers
// must offer the amount field at a zero balance, floored at minAmountCents. See the contract doc §11.0a.
```

**`POST /fabric/billing/identify`** — echo back WHO a typed Student ID belongs to, so a consumer can ask "is
this the right child?" **before** any balance appears. Call it first; that confirmation is what replaced the
PIN. Returns a first name + last initial and nothing else — no balance, no invoices, no siblings, not even
the family id.
```jsonc
{ "v": 2, "studentCode": "YUS1234" }
→ { "v": 2, "found": true, "student": { "studentCode": "YUS1234", "firstName": "Yusuf", "lastInitial": "I" } }
→ { "v": 2, "found": false }   // unknown / withdrawn / locked / external payments off
```

**`POST /fabric/billing/lookup`** — resolve a **Student ID** to a family + balance + sibling list.
```jsonc
// request — the ID alone (case/spaces/hyphens normalised here). No name, no PIN: v2 removed both.
{ "v": 2, "studentCode": "YUS1234" }
// Any mismatch — unknown ID, withdrawn child, locked ID, tuition payments switched off — gives an
// identical "found": false. `identify` and `lookup` share ONE per-ID lockout bucket (6 failures/hour),
// so probing through whichever endpoint answers faster gains nothing.
// 200 (found)
{ "v": 2, "found": true,
  "matchedStudent": { "id": "stu_1", "balanceCents": 20000, "creditCents": 0 },
  "family": {
    "id": "fam_x1", "label": "Ismail family",
    // NEVER full last names, DOB, or contact info. Per-child balance + credit, because bills are per child.
    "students": [{ "studentId": "stu_1", "studentCode": "YUS1234", "firstName": "Yusuf", "lastInitial": "I", "balanceCents": 20000, "creditCents": 0 }],
    "balanceCents": 20000, "creditCents": 0, "currency": "usd",
    // items (0.43.0, additive): what the bill is MADE OF, so a consumer lists tuition and a book fee
    // separately and a parent can pay one of them. sum(items[].balanceCents) === the invoice balance;
    // kind is tuition|charge|credit; a credit line reports 0. Pass the ids back as record-payment's
    // `lines` and that line is the one that gets settled (and STAYS settled — see §9's directed note).
    "openInvoices": [{ "id": "inv_9", "studentId": "stu_1", "label": "Tuition — Jul 2026", "dueDate": "2026-07-01", "balanceCents": 25000,
      "items": [{ "id": "iti_1", "label": "Monthly tuition", "kind": "tuition", "amountCents": 20000, "balanceCents": 20000 },
                { "id": "iti_2", "label": "Book fee", "kind": "charge", "amountCents": 5000, "balanceCents": 5000 }] }]
  } }
// creditCents (0.41.0, additive): money paid ahead. Non-negative, and at most one of the pair is
// non-zero — a DERIVED balance of 0 means "square" OR "paid ahead", and once an advance settles its
// invoice the credit is the only signal left (openInvoices is empty by then).
// 200 (not found) — same shape, same latency, whatever actually mismatched (no enumeration oracle)
{ "v": 2, "found": false }
```

**`POST /fabric/billing/record-payment`** — record an external payment. **Idempotent.**
```jsonc
// request
{ "v": 1,
  "idempotencyKey": "pi_3PabcDEF",           // REQUIRED, ≤128 chars. Convention: the Stripe PaymentIntent id.
  "familyId": "fam_x1",                       // REQUIRED — from a prior lookup in this session
  "studentId": "stu_1",                       // optional — the matchedStudent from lookup
  "amountCents": 15000, "currency": "usd",
  "channel": "donations-web",                 // "donations-web" | "kiosk"
  "occurredAt": "2026-07-15T18:03:22Z",
  "externalRef": { "stripePaymentIntentId": "pi_3PabcDEF", "stripeChargeId": "ch_...", "stripeAccountId": "acct_..." },
  "students": [{ "studentId": "stu_1", "amountCents": 15000 }],       // optional per-child split
  "lines": [{ "itemId": "iti_2", "amountCents": 5000 }],              // optional; supersedes `students`
  "allocations": [{ "invoiceId": "inv_9", "amountCents": 15000 }],    // optional; omitted → oldest-due-first
  "payerNote": "paid by grandmother" }        // optional, ≤200 chars, displayed to finance
// 200 (first time)      { "v": 2, "recorded": true, "paymentId": "pay_71", "duplicate": false, "payments": [...] }
// 200 (replay)          { "v": 2, "recorded": true, "paymentId": "pay_71", "duplicate": true,  "payments": [...] }
// 404 unknown family    { "error": { "code": "family_not_found", "message": "…" } }
// 422 bad allocation    { "error": { "code": "invalid_allocation", "message": "…" } }
```
Surplus beyond open invoices becomes that child's credit. A recorded external payment fires a Fabric
notification, an audit entry, and a receipt to the household's guardians.

**`POST /fabric/billing/check`** — retry helper for consumer outboxes.
```jsonc
{ "v": 1, "idempotencyKey": "pi_3PabcDEF" }  →  { "v": 2, "recorded": true, "paymentId": "pay_71", "paymentIds": [...] } | { "v": 2, "recorded": false }
```

### 11.3 Stripe metadata contract (on EVERY tuition PaymentIntent, whoever mints it)

```
purpose            = students-billing        ← the discriminator; REQUIRED
omos_app           = donations | kiosk | students-portal    ← students-portal is set ONLY by this app (§13)
students_family_id = fam_x1                  ← REQUIRED (from lookup / known internally)
students_student_id = stu_1                  ← optional, the matched student
students_channel   = portal | autopay        ← set by this app, so reconciliation can tell them apart
```
**Never put a Student ID or a child's name in Stripe metadata, descriptions, or URLs** — metadata is visible
in Stripe dashboards and exports. Description: `School balance — <family label>`. **Receipts must say
"payment", never "donation"** — tuition is generally not tax-deductible; consumers exclude
`purpose=students-billing` from donation totals and year-end letters, and this app's own receipts follow the
same wording rule.

### 11.4 Reconciliation (this app's safety net — covers every channel)

Daily job + on-demand "Reconcile now" button (finance): fetch keys via
`GET ${OPENMASJID_BASE_URL}/api/fabric/stripe?account=<STRIPE_ACCOUNT>` (with our secret), list succeeded
PaymentIntents where `metadata.purpose == "students-billing"` since the last cursor, and record any whose PI
id isn't already an idempotency key — flagged `via: reconciliation`. It covers missed broker calls from
Donations/Kiosk **and our own portal/autopay intents**, and it is the only thing that resolves an autopay run
stuck at `pending`. The cursor is held back below anything that errored or is still settling, so nothing is
skipped. The push paths are optimizations; **money is never lost**, only delayed.

---

## 12. Auth, roles, SSO, tunnel — and the origin policy

- **App-local accounts are primary.** Username/email + argon2id, server-side sessions, HTTP-only `Secure`
  SameSite cookies, login rate-limited **per client IP and per account name** (§14) with generic errors.
  Usernames are one name whatever their case (§9). Admin/finance create staff users; forced password set on
  first login. Changing a password signs out that account's other sessions.
- **Parent accounts** (two doors, both land on a `guardian_users` link):
  1. **Invite** (default): finance/admin picks a guardian → the app emails (or prints, if mail is unavailable)
     a one-time invite link (CSPRNG token, 7-day expiry, single use) → parent sets a password.
  2. **Self-registration** (admin toggle, default ON): parent visits `/family/register`, enters **a child's
     Student ID plus a guardian email already on file for that child's family**, then verifies via emailed
     link. The on-file email is the load-bearing half: an ID alone can only *pay* (§11.2), so minting an
     ACCOUNT from one would be an escalation — requiring an address the office already recorded means the
     invite can only land in an inbox the school chose. Throttled per IP and per ID (the same lockout bucket
     the Fabric lookup uses).
  Password reset mirrors the doors: an emailed link when mail works; an office-sent link when it does not.
- **First run**: create the app `admin` (LAN only, naturally), then a guided setup covering the school, the
  look, the year and terms, classes, fee plans, payments, email, staff and the student import. No anonymous
  access to anything but the login/first-run/invite/register/reset pages, the open-by-design branding routes
  (`/api/logo`, `/manifest.webmanifest`, `/apple-touch-icon.png`, `/sw.js`, `/api/public/appearance`), and the
  secret-gated `/fabric/*`.
- **SSO fast-path (LAN only)**: per the platform spec — the backend forwards the incoming `omos_session`
  cookie to `GET ${OPENMASJID_BASE_URL}/api/auth/session` with `X-OpenMasjid-App-Secret`; on
  `{authenticated:true}` mint an app session as `admin`, capped at 1 h. Treat `username` as untrusted display
  text. Identity signal only. (SSO mapping to `admin` is consistent with the origin policy: the platform
  cookie never rides the tunnel.)
- **12.4 Origin policy enforcement (DO NOT REGRESS):**
  - Every request is classified once in `security/origin.ts`. §12.4 originally said "`cf-ray` or
    `x-forwarded-proto: https` means tunnel", and that is unusable for an `https: true` app — the OS's own LAN
    TLS proxy sets `x-forwarded-proto` too, and *absence* of `cf-ray` is not proof of a trusted LAN (a request
    straight off the internet to an unfirewalled port has no `cf-ray` either). So `lan` is granted only on a
    POSITIVE signal: **the effective client IP is private/loopback/link-local**, and `cf-ray` still forces
    `tunnel`. Forwarded headers are trusted only when the TCP peer is itself local. The full reconciliation is
    in `docs/DATA_MODEL.md`. Note the safe failure direction: spoofing toward `tunnel` only ever **removes**
    privileges.
  - `admin` **login attempts from tunnel are refused** with a friendly message ("Admin sign-in only works on
    the masjid network") and **existing `admin` sessions presented from tunnel get 403** — both, so a
    LAN-minted admin cookie is useless remotely.
  - `finance | parent` allowed from both origins. `/fabric/*` refuses tunnel-origin outright (§11.1).
  - The policy lives in one middleware consulted by every tRPC procedure; per-procedure overrides are
    forbidden without a CLAUDE.md change.
- **Tunnel niceties**: absolute links/QRs/invite emails use the public URL the platform reports (`domain:
  true`), falling back to the `OPENMASJID_PUBLIC_URL` mirror; the session cookie's `Path` is scoped to the
  app's mount prefix so it is never sent to a sibling app on the same tunnel domain; the SSO cookie simply
  won't be present over the tunnel — fall back to app login silently.

---

## 13. Payments in this app — parent portal pay-now, autopay, refunds

> The Donations/Kiosk flows still exist for walk-ins and families without portal accounts; the portal is the
> first-class path. **One rule above all: card data never touches our server** — Stripe Elements in the
> browser, PI/SetupIntent confirmation via Stripe, our backend only ever sees Stripe ids.

### 13.1 Stripe client & keys
- On boot (and on settings change) fetch the configured account's keys over the Fabric:
  `GET ${OPENMASJID_BASE_URL}/api/fabric/stripe?account=<account>`. Publishable key → the browser; secret key
  → server memory only (never DB, never logs). If the platform is unreachable, payment features report
  "temporarily unavailable" and everything else keeps working — and a failed reload clears the previous
  client rather than leaving it live, so an account switch cannot keep charging the old account.
- Each household that saves a method or enables autopay gets a **Stripe Customer** (id on `families`).

### 13.2 Pay now (parent, Elements)
1. Parent picks an amount (full balance pre-filled; ≥ `MIN_PAYMENT_CENTS`; optional per-line ticks).
2. Server creates a PaymentIntent: amount, currency, customer, **metadata per §11.3**
   (`omos_app=students-portal`, `students_channel=portal`, `students_family_id`), description
   `School balance — <family label>`, `automatic_payment_methods` enabled so the household is offered whatever
   the masjid's account has switched on.
3. Browser confirms with Elements.
4. **The ledger truth lands on the RETURN**, not a webhook: `portal.confirmPayment` retrieves the PI, checks
   it is ours and this household's, and records it (channel `portal`, idempotency key = the PI id). The ticked
   lines become the payment's stored instruction.
5. Email receipt (wording: "payment", never "donation"). Alert to whoever the office listed.

### 13.3 Autopay (saved method + our scheduler — NOT Stripe subscriptions)
- **Enroll**: the parent adds a method (SetupIntent, `usage: off_session`) and toggles autopay for the
  household; the consent timestamp is stored.
- **Run**: daily scheduler (croner) per household with autopay ON: sum open invoice balances with
  `due_date <= today`, capped at what the household's derived balance actually says it owes; if > 0, create an
  `autopay_runs` row (UNIQUE family+date — our idempotency), then an **off-session PaymentIntent** with a
  Stripe idempotency key derived from the run id. An off-session confirm returns its outcome synchronously, so
  a success is recorded there and then (channel `autopay`).
- **Decline / SCA ladder**: retry on day +2 and day +5, and **each attempt tries the NEXT saved method in the
  household's own order** (0.48.0) rather than presenting the same declining card three times. Email the
  parent on each failure with a pay-now link. After the third failure: **auto-disable autopay**, email the
  parent, alert the office. An indeterminate outcome (network error) is left `pending` and never counted as a
  strike — reconciliation resolves it, and the pending-run guard blocks a re-charge meanwhile.
- Finance sees autopay status on a household's billing record, including which method will be charged; admin
  can force-disable. Parents can cancel any time (effective immediately; audited).

### 13.4 There is NO Stripe webhook
This is a deliberate architecture choice and the docs used to say the opposite. Every payment reaches the
ledger by one of four **pull** paths: the Fabric `record-payment` call (Donations/Kiosk), the portal's
confirm-on-return (13.2.4), autopay's synchronous confirm (13.3), and the daily reconciliation (§11.4). There
is no `/api/stripe/webhook` route, no signature verification and no webhook endpoint registration, because
there is nothing for a webhook to tell us that reconciliation will not — and a webhook is an internet-facing
route that must be exposed, verified and kept in step with Stripe's event catalogue. `stripe_events` is the
vestigial table from that design (§9). **A refund is the one Stripe call that changes our ledger
immediately** (`payments/refunds.ts`): Stripe first, then the mirror rows.

### 13.5 Failure doctrine
- No tunnel / a browser that never returned → reconciliation records the PI within a day.
- Stripe down / keys unavailable → pay-now, autopay and **card refunds** pause visibly and say so; cash
  reversals, the ledger and everything else are unaffected. Autopay runs skipped while paused are picked up by
  the next run (the due-date query is stateless).

---

## 14. Sensitive data & security invariants — DO NOT REGRESS

This is the org's most sensitive app — **records about children, internet-facing, moving money**. Every
invariant here is load-bearing:

- **Data minimization**: no SSNs, no medical fields, no photos. DOB optional. `lookup` (§11.2) never returns
  full last names, DOB, addresses or guardian contact. Saved payment methods store **type, brand, last4,
  expiry, wallet, bank name, account type — never a PAN, never a routing number, never a holder name**. The
  parent portal shows a household only to users linked via `guardian_users` — tested per procedure.
- **Origin policy (§12.4)** is a security invariant, not a preference: admin auth is impossible via tunnel,
  both at login and at session-use time.
- **A Student ID is the whole credential on the payment path, and it is GUESSABLE — the limiter is the
  control, not a secret**: `ABC1234` is ~10k guesses per name prefix, so lookups are throttled per-IP by the
  consumers, per-caller by the broker, **and per-ID here** — 6 failed probes/hour locks that ID for an hour
  and raises an admin alert. `identify`, `lookup` and parent self-registration **share one bucket** so
  failures cannot be laundered across endpoints. Uniform `found:false` for every mismatch flavour. This is
  safe only because of how narrow the ID's authority is (see a balance, pay it) — if a future feature would
  let an ID *do* anything more, it needs a second factor first. IDs never in logs or Stripe metadata.
- **Internet-facing rate limits, per-IP AND per-account**: login (both, 0.48.0), invite accept, reset request,
  reset confirm, self-registration. The per-account login bucket is deliberately looser than the per-IP one
  because its key is attacker-chosen — see `security/rateLimit.ts` for the trade-off, which is stated there
  rather than left implicit.
- **Invite/reset/verify tokens**: CSPRNG, single-use, expiring, stored **hashed** — like session tokens, so a
  stolen DB row cannot be replayed as a cookie or a link.
- **Card data never touches the server** (Elements only); the Stripe secret key lives in memory only; nothing
  else imports the SDK.
- **WhatsApp is the weakest channel here and is treated as one** (0.50.0). Nothing auth-critical is sent on
  it — no invite, no reset, no verification link, no one-time code — because the number can be banned
  overnight and that day must not be the day nobody can sign in. No Student ID, no card details, and **no
  message body is ever logged or stored**, on any path including failures. Both are tested, not assumed.
- **No PII in logs** — ids, codes and counts only; never names+amounts together; Fabric bodies never logged.
- Role checks server-side on every procedure; **parent household-scoping enforced in queries**.
- **Printed documents are minors' records**: served only through the authed route that re-checks the role ×
  origin matrix on every request, with `no-store`, `nosniff`, `no-referrer` and a CSP whose `default-src
  'none'` means an injected reference cannot phone home. Every interpolated value is escaped; the accent
  colour and the logo are re-validated on the way out (a hex pattern, and magic bytes) because they land
  inside a `<style>` block and an `<img>` on a page a browser renders.
- **The SPA shell** is `no-store` (a cached shell is how an update becomes a no-op) plus `nosniff` and
  `no-referrer` — the invite/reset pages carry a token in the query string, and a referrer is not the place
  for it (0.48.0).
- **Dates on the money path are validated** (§9): a date column is compared as text, so a non-ISO value is a
  silent, permanent fault rather than an error.
- Audit log append-only; payments immutable (reversals only); Drizzle-bound SQL only, never string-built;
  CSV formula-injection escaping (`=`,`+`,`-`,`@`,tab,CR prefixes) on every exported cell, because guardian
  names and payment memos are attacker-influenced strings.
- Fabric provider: constant-time secret compare, zod before logic, 401 first, tunnel 404 first of all;
  idempotency at the DB.
- Backups: `/data` contains minors' PII and every payment record — document that admins must treat backup
  files carefully. The 30-minute `VACUUM INTO` snapshot exists so a live-volume tar always contains one
  restorable copy.

---

## 15. Design & voice

Inherit the org design system (OpenMasjidOS `CLAUDE.md §14`): calm, dignified, masjid-themed; emerald primary,
gold accents; dark default; Motion springs; WCAG AA; geometric motifs only — **never sacred text as
decoration**. Apply the Fabric appearance payload; the same-origin `/api/public/appearance` relay keeps the
look in step at runtime.

**Platform-family UI parity is a requirement, not a vibe.** A masjid admin opening this app from the
OpenMasjidOS dashboard should not be able to tell they left it — and that includes the **`/admin` route
tree**, not just the parent portal. Concretely: the same Tailwind v4 token architecture (`tokens.css`,
`data-theme="dark|light"` flip — no hardcoded hex anywhere), the same shadcn/ui component set, the same
Motion spring presets, the same typography stack, the same emerald/gold palette, arch-topped-card motifs,
skeleton shimmer loaders, staggered grid entrances. The ported files (`tokens.css`, `app.css`, `glass.css`,
`Glyphs.tsx`) are kept **structurally identical to upstream** so theme fixes re-sync cleanly — every
deviation goes in `shell.css` / `admin.css` instead, and anything that must differ carries a one-line comment
saying why. Same-org AGPL, so copying these between OpenMasjid-Solutions repos is allowed and encouraged.

**Madrasa-first, localizable, never hardcoded**: madrasa-native wording ships as **defaults and i18n
strings**, and the office can rewrite the sentences on a family's printed sheet in Settings. **The parent
portal is the face of the madrasah** — highest polish bar, phone-first (big tap targets, bottom nav,
one-thumb payment flow), and since 0.48.0 the staff shell allows for a phone's notch and home bar too.
**The printed documents are the artifacts families keep** — a dignified header (school name, period, the
madrasah's own logo and colour), clean tables, the org's geometric restraint, and they must look right printed
in black-and-white on a masjid photocopier. Voice: plain and warm for parents (✅ "Your balance is $350" /
"Autopay is on — we'll charge your Visa ···4242 when tuition is due" ❌ "off_session PaymentIntent
requires_action"), and for staff (the finance manager is a volunteer, not an accountant). Errors: one friendly
sentence + what to do next; details to the log. **A confirmation dialog says what will actually happen**, and
only appears where something is hard to undo — a dialog on a harmless action is how people learn to click
through the ones that matter.

---

## 16. Coding conventions

Everything in OpenMasjidOS `CLAUDE.md §15` applies (clarity over cleverness; comment the *why*; strict TS;
shared types via a type-only `AppRouter` import; zod at boundaries; typed friendly tRPC errors; never log
secrets). Additions:

- **One place decides, and the comment says so.** All money math in `billing/ledger.ts`; one
  `ledger.record`/`recordSplit` used by the Fabric provider, the portal, autopay, reconciliation and the
  manual-payment UI. One `billing/lines.ts` for what a bill is made of and in what order. One
  `alerts/index.ts` for who hears about an event. One `schools/index.ts` for school scope. One
  `settings/dates.ts` for every date edge. One `auth/usernames.ts` for how a username matches. One
  `payments/methods.ts` for what a saved method is and what order they are tried in. One `payments/stripe.ts`
  that imports the SDK. One `whatsapp/index.ts` for whether a WhatsApp message goes out and to whom, and one
  `whatsapp/numbers.ts` for what a number is on the wire. Adding a second place is the bug.
- Unit tests for the ledger: exact pay, partial, overpay→credit, multi-invoice, replayed idempotency key,
  reversal, refund, and one per channel.
- `/fabric/*`, the printable documents and the PWA files are plain Fastify routes registered before the SPA
  fallback, excluded from any session middleware but gated by their own checks (secret / cookie + role +
  origin / nothing to gate).
- Every string through i18next — **including the ones a settings screen generates**, which is checked by a
  test (§9's alert rule). Logical-property RTL-safe layouts; migrations forward-only, with
  `--> statement-breakpoint` between statements and a `_journal.json` entry.

---

## 17. Build & run commands (keep these working)

```
npm install         # all workspaces
npm run dev         # server + web, hot reload (server :8080; Vite :5173 proxying /trpc, /api, /fabric, /statements)
npm run build       # typecheck + build web and server
npm run lint        # eslint + tsc --noEmit
npm run test        # vitest — both workspaces
npm run image       # build & tag ghcr.io/openmasjid-solutions/openmasjidstudents:local
```

> The local build tag is `:local`, **not** `:dev`. `:dev` is now a published moving tag (the development
> update channel), and Docker prefers a local image over pulling — so a local build tagged `:dev` would
> silently shadow the real dev image for anyone running `docker compose up` on the `dev` branch, and
> they would be testing their own stale build while believing they were on the channel.

**Test on Linux, not on Windows.** The app ships as a Linux container and CI runs on Ubuntu; a Windows run
uses win32 native binaries (better-sqlite3, argon2) that never ship. Use a WSL2 Ubuntu clone on ext4 —
never `npm ci` against `/mnt/c`, which would overwrite the Windows `node_modules` and thrash both.

Dev: `.env` with fake Fabric vars; curl fixtures for `/fabric/billing/*`; Stripe **test mode** for the
payment paths (there is no webhook to forward — see §13.4); a small mock of `/api/auth/session` and
`/api/fabric/stripe` in `packages/server/test/`. Simulate tunnel origin locally by sending `cf-ray: dev`.

---

## 18. Definition of done (any feature)

Builds via `npm run build`; `tsc` + eslint clean; the ledger / Fabric-contract / origin-policy tests pass;
**role × origin matrix verified for touched routes** (an admin session over simulated tunnel gets 403; a
parent token literally cannot fetch another household — tested, not assumed); works light+dark, LTR+RTL,
reduced-motion honoured; new/changed screens reviewed side-by-side with the OpenMasjidOS dashboard for
token/motion/typography parity (§15) **and checked on a phone-width viewport**; works with Fabric/mail/tunnel
absent (standalone) and present; payment features tested against Stripe test mode including a declined card;
printed documents checked in a real print preview, in black and white; every new date/money boundary validated
(§9); no raw error reaches the user; all strings in i18next — including generated keys; SPDX on every new
file; audit entries for every sensitive write touched; and the CHANGELOG entry written in the voice a masjid
reads, under the release heading — a **headline** if a masjid would notice it, under `### Also in this
release` if they would not (§19, "One changelog, two audiences").

---

## 19. Version control & release policy — how a version actually ships

`VERSION` file at repo root, single source of truth, `MAJOR.MINOR.PATCH`; `1.0.0` reserved for launch.
**`main` is at the last release; `dev` carries `X.Y.Z-dev.N` for the NEXT one** — so once `v0.49.0` ships,
`dev`'s next build is `0.50.0-dev.1`, not another `0.49.0-dev.N` (that release exists now; a prerelease of it
would be a lie about which way round they are). Default branch: **`main`**; all work on **`dev`** (see
Branching policy).

**The key idea (two repos):** this repo builds and **digest-pins** the Docker image; the catalog repo
(`OpenMasjidAPPS`) is what makes a version downloadable — this app's entry in `OpenMasjidAPPS/registry.yaml`
names the tag and commit its "Build catalog" CI reads, and the `catalog.json` that produces is what every
OpenMasjidOS install fetches. **Nothing is "released" until that lands** — and on the STABLE channel, landing
it is not ours to do: we open a PR against the catalog's `dev` branch and a catalog maintainer runs the
release (step 6).

**Auth pieces (none typed per release):**
1. `gh` CLI's stored token — authenticates pushes to this repo and opening the catalog PR. It can also write
   to the catalog directly; that it *can* is not permission to (step 6).
2. GHCR push = CI's built-in `GITHUB_TOKEN` — the image is pushed by this repo's **"Build image" GitHub
   Action** (`.github/workflows/build-image.yml`), **never from a laptop**. One-time setup after the first
   build: set the GHCR package to **Public**.
3. ~~APK signing keystore~~ — **N/A here.** This is a web-only app; the keystore secrets are Kiosk-specific.
   Do not add Android/APK steps to this repo.

### One changelog, two audiences (0.49.0)

**A stable release shows its HEADLINES. A dev build shows everything.** Same file, same entry, read at two
depths — because the two channels want opposite things. A masjid updating on the stable channel wants the
few things that changed for them; 0.48.0 ran to fifty bullets, which makes the first line as easy to skip
as the last. Whoever is running the dev channel is testing the build and wants all of it, including the
fixes too small to announce.

How to write one, every time:

- Open the release with its **headlines** — the major changes, additions and fixes, and nothing else.
  **Six to eight**, in the voice a masjid reads (§15), each one a thing they will notice.
- Then `### Also in this release`, and everything else under it: the refinements, the small fixes, the
  detail behind the headlines. That heading is the marker; **everything from it onward is dev-only**,
  including any further `###` sub-headings inside it.
- `lib/changelog.ts` decides which half to show from **the version the app is running** — a `-dev.N` build
  shows all of it, a release build shows the headlines, and an unknown version shows the headlines (the
  safe direction). On GitHub, where the whole history belongs, both halves always show.
- `changelog.test.ts` holds the newest entry to a short headline list, so a forgotten marker fails in CI
  rather than in front of a madrasah.
- **Never rewrite a shipped release's notes** to fit this. Entries written before the convention have no
  marker and correctly still show in full; they are what those masajid already read.

**The release runbook (every release, in order):**
1. Bump the version **everywhere**: `VERSION`, `manifest.yaml`'s `version:`, root + both workspace
   `package.json`s, `docker-compose.yml`'s image tag, and a `CHANGELOG.md` entry (headlines + marker, above).
   **The server does NOT need editing** — `config.version` reads `packages/server/package.json` at runtime
   (it was a hand-typed literal until 0.42.1 and drifted two releases, telling every masjid they were on
   0.40.0). `packages/server/test/version.test.ts` asserts all of these agree, so a half-finished bump fails
   CI instead of shipping; the CHANGELOG entry is checked there too, since **What's new** in the app is built
   from that file.
2. Commit on `dev`; validate the build is green (CI on the branch).
3. **Merge `dev` into `main`, carrying the stable version bump in the merge commit**, and push → triggers
   **"Build image"** → pushes the **multi-arch** (amd64+arm64) image to GHCR.

   Concretely: `git checkout main && git merge --no-ff --no-commit dev`, resolve the version conflicts to the
   plain `X.Y.Z` (they conflict every time, by design — `dev` says `X.Y.Z-dev.N` and `main` says the previous
   release), **leave `docker-compose.yml` naming the PREVIOUS release's digest**, then commit as
   `release: vX.Y.Z — <headline>`.

   It is **not** a fast-forward and cannot be: `main` carries every release and pin commit, which `dev` never
   receives, so the two have diverged permanently by design. (This step said "FF-merge" until 0.49.0, which
   would fail on the first `git merge --ff-only`.) Keeping the previous digest for this one commit is also
   deliberate and is what `version.test.ts` enforces: a stable version must name a digest-pinned image, and
   the new digest does not exist until step 3 has run.
4. Grab the **`@sha256` digest** from that build and pin it in `docker-compose.yml`'s `image:` line. Confirm
   it with `docker buildx imagetools inspect …:<version>` before trusting the log line.
5. Commit the pin, then `git tag v<version>` and push `main` + the tag.

   **TAG THE DIGEST-PIN COMMIT, NOT THE COMMIT BEFORE IT.** Do not tag until step 4's pin is committed. The
   catalog fetches a COMMIT and serves the `docker-compose.yml` it finds there, so a tag placed one commit
   early carries the PREVIOUS release's digest — and every masjid installing that version then runs the wrong
   code under the new version number, while the release looks entirely successful. **This has already
   happened twice in the org.** Check it before you push: `git tag --points-at HEAD` on the pin commit, and
   `git rev-list -n 1 v<version>` must be that same SHA — the one you then put in the catalog PR's `commit:`.
   (`docker-compose.yml` is in the workflow's `paths-ignore`, so neither the pin nor the tag rebuilds the
   image; the digest stays the one you pinned.)
6. **Open a PR against `OpenMasjid-Solutions/OpenMasjidAPPS` — base branch `dev`, NEVER `main`.** Change only
   this app's own entry in `registry.yaml`, nothing else in the file:

   ```yaml
     - id: students
       ref: v0.49.0        # the tag you just published — the human label
       commit: 222f0640…   # the 40-char SHA of that tagged commit — what actually gets FETCHED
   ```

   `git rev-list -n 1 v0.49.0` gives the SHA. If you followed steps 1–5 the tag and the pin commit are the
   same commit; **if they ever differ, pin the commit that carries the correct digest** — `commit:` is what
   the catalog fetches and `ref:` is only the label beside it. Leave `dev_ref: dev` alone.
7. **Stop there.** A catalog maintainer runs the release that moves the catalog's `main`. Do **not** commit to
   the catalog's `main`, and do **not** merge the catalog's `dev` into its `main`: those branches legitimately
   hold different builds of `catalog.json` — the dev channel's and the stable channel's — so merging either
   way publishes one channel's column to the other's masajid.

> **This section told you to do the opposite until 0.50.0, and I did.** It called a direct commit to the
> catalog's `main` (`gh api -X PUT …/registry.yaml`) "house standard, since we own the org". It is not:
> stable moves only through a catalog release, run by a maintainer. **v0.48.0 and v0.49.0 were both pushed
> straight to the catalog's `main` on 2026-08-13** under that instruction, and a maintainer had to reconcile
> the stable column afterwards. Open the PR against `dev` and wait for it.

**The dev channel needs none of steps 6–7.** `dev_ref: dev` tracks this repo's `dev` branch by itself and the
catalog rebuilds hourly, so a dev build never needs a catalog change at all. What the dev channel does ask is
that the prerelease version (`X.Y.Z-dev.N`) and the version-tagged image stay current — and that **the image
is published before the version bump is pushed**, since the catalog pins the exact tag and an entry that
arrives first hands a masjid a pull failure.

The `version:` in the registry entry, `manifest.yaml`, and `VERSION` must agree; the digest pin and the tag
must point at the same commit lineage. Commit messages per house style (`chore: bump version to x.y.z`,
`chore(release): pin image digest for vx.y.z`).

**Contract versioning is separate**: `students/billing` responses carry `"v": 2`; breaking the shape means
`v: 3` + coordinating all four repos — don't do it casually. (Adding the `students-portal` metadata value,
`creditCents`, and invoice `items` were all additive, not breaking.)

---

## 20. Working agreement for Claude (the coding agent)

- Read this file every session. **Branching policy** (above §1 — confirm you are on `dev` before editing
  anything), §3 (licensing), §5 (roles + origin), §9 (data rules), §11 (contract), §12.4 (origin policy),
  §13 (payments), §14 (security), §15 (UI parity) are **hard constraints**.
- Build **vertically** — one full slice (schema + router + UI + i18n + tests) before the next.
- **Where things are, when you need to change something:**

  | If the change is about… | Start in |
  | --- | --- |
  | who may do it | `trpc/trpc.ts` + `security/origin.ts` |
  | how a name, household label or Student ID is derived | `people/names.ts`, `people/household.ts`, `billing/studentCodes.ts` |
  | what a bill is made of, or what order money lands in | `billing/lines.ts`, then `billing/ledger.ts` |
  | a balance being wrong | `billing/ledger.ts` (`reallocateStudent` first) |
  | a month showing the wrong state | `billing/yearCells.ts`, `billing/period.ts` |
  | a card, a refund or a saved method | `payments/*` — and only `payments/stripe.ts` imports the SDK |
  | who gets told | `alerts/index.ts`, then `mail/notify.ts` (which fans out BOTH parent channels) |
  | a WhatsApp message — whether it goes, to whom, or what it says | `whatsapp/index.ts`, `whatsapp/numbers.ts`, `whatsapp/templates.ts` |
  | which household a pause does NOT apply to (either channel) | `settings/testStudent.ts` |
  | a printed sheet | `billing/statements.ts`, `billing/invoiceDoc.ts`, `people/onboardingSheet.ts`, `people/idSheet.ts` |
  | a date | `settings/dates.ts` |
  | the calendar or the roster tree | `structure/*`, `schools/index.ts` |

- **A fix goes where the rule lives, not where the symptom appeared.** Two places disagreeing about the same
  rule is the recurring shape of this codebase's real bugs — the username case defect, the display order that
  differed from the allocation order, the alert id declared in one file and consumed in another. When you find
  one, unify it and leave the reason in a comment.
- **Every non-obvious fix gets a test that fails without it.** Prove that: delete the fix, watch it go red,
  put it back. A guard that passes vacuously is worse than none.
- If a task seems to need card-present hardware, Stripe Billing subscriptions, a webhook, an academic feature,
  or a student/teacher login — **stop**: the first two belong elsewhere (Kiosk / §13.3), the third was removed
  by design (§13.4), and the rest are out of scope (§4).
- Write non-trivial decisions into `docs/DATA_MODEL.md` / `docs/PAYMENTS.md`; security findings and what was
  done about them into `docs/audit/`.

### Open questions to confirm with Hasan before the affected step

1. Default host port (`8360` proposed) — confirm free across the beta masajid.
2. Autopay's trigger is **on due date** (assumed and built) rather than on invoice generation; overpay on
   portal pay-now is allowed and becomes credit (built).
3. Parent **self-registration ON by default** (built: child's Student ID + on-file email + email verify).
4. The names of the two existing campaign types in OpenMasjidDonations/Kiosk that `tuition` joins (the
   consumer briefs say "verify in-repo" — confirm the real enum values).
5. **Partial refunds**: today the answer is a credit on the next bill, deliberately (§4 🔭). Say the word if
   an office needs a true partial refund through Stripe, since it means new money math in a second place.
6. **Saved bank accounts** can be added but micro-deposit verification is not finished — confirm whether any
   beta masjid actually takes ACH before that is built out.
7. ~~PIN policy~~ — **settled (v0.39.0): no PINs.** Student ID only, with a name-confirmation step and a
   per-ID lockout (§11.2, §14).
