<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# CLAUDE.md — OpenMasjidStudents

> This file is the single source of truth for the OpenMasjidStudents project. Read it fully before writing any code. When in doubt, follow this document over your own assumptions. If something here is ambiguous, ask before guessing.
>
> ⚠️ **SCOPE PIVOT (v0.35.0).** This app was **descoped from a full SIS to tuition/fee management only.** All academics were **removed**: classes, scheduling/timetable, attendance, gradebook, grading scales, merit points, comment bank, exams, report cards, transcripts, term finals, the admissions pipeline (incl. the public `/apply` form), the Report Creator, custom student fields, student notes/incidents, and the **teacher** role. What remains is students (each with a generated **Student ID**; no PINs — removed in v0.39.0), fee plans, PER-STUDENT invoices and payments (0.39.0 — the family discount went with that change), the ledger, manual + Stripe/portal/autopay payments, statements, and the `students/billing` Fabric provider. **Fees are now assigned PER STUDENT** (`student_fees`), not per class enrollment. **The code is authoritative** — where a section below still describes an academic feature, it no longer applies; §11 (Fabric contract), §12 (auth/origin), §13 (payments), §14 (security), §16, §19 remain in force.
>
> **Product target, in one line:** self-hosted **tuition & fee management for a madrasa** — students with a generated Student ID, per-student fee plans, per-student invoices, a derived ledger, and payments by cash/Stripe (parent portal + autopay) **plus the OpenMasjid Donations site and Kiosk** over the Fabric.
>
> This app depends on two sibling work orders that land in other repos: **`OpenMasjidOS/docs/FABRIC_APP_LINK_AND_TUNNEL.md`** (the Fabric app-to-app broker + Cloudflare uplink) and the `STUDENTS_INTEGRATION.md` briefs in **OpenMasjidDonations** and **OpenMasjidKiosk**. §11 of this file is the shared contract all four repos must agree on. If the contract changes here, it changes everywhere.

---

## 1. What we are building (one paragraph)

**OpenMasjidStudents** is a self-hosted **tuition & fee management** app **built for madāris** that runs as an **OpenMasjidOS app**: one Docker container, installed from the App Store, all data on the masjid's own hardware. It is a **three-role app**: **admins** manage families, students, fee plans and settings (LAN-only, by design); a **finance manager** runs billing (invoices, the ledger, manual + card payments); and **parents** get their own phone-first portal with the family balance and one unified payment history — **payable by card right in the app (Stripe)**, with **autopay** and saved cards. Every student gets an auto-generated **Student ID** (`YUS1234` — first three letters of the first name + 4 digits); fees are assigned **per student** as **fee plans** (monthly / per-term / one-time) and billed as **one invoice per student** each period (the parent still sees one combined balance and pays once). Finance records cash/Zelle/check by hand, and prints **statements** carrying each child's Student ID and a portal-signup QR. Finance and parents work over the **Cloudflare uplink the OS provides**; the admin surface stays on the masjid LAN. Tuition paid with a **child’s Student ID** through **OpenMasjidDonations** and **OpenMasjidKiosk** flows automatically into the same ledger over the **OpenMasjidOS Fabric** — this app is the **provider** of the `students/billing` capability those apps consume.

Think: **"the madrasa's tuition & fee desk, in one container the masjid owns — and payable anywhere: the portal, the kiosk, or the donation site."**

---

## 2. Where this fits (repos and boundaries)

| Repo | Role in this feature |
| --- | --- |
| **`OpenMasjidStudents`** (this repo) | The app: server, all four role UIs, database, direct Stripe payments (portal + autopay), the **provider** side of the `students/billing` Fabric capability. |
| **`OpenMasjidOS`** | The platform. Fabric core APIs, per-app secret, app-to-app broker, Cloudflare tunnel uplink, HTTPS serving for Stripe apps. Work order: `docs/FABRIC_APP_LINK_AND_TUNNEL.md`. |
| **`OpenMasjidAPPS`** | The catalog. This app ships as its own repo + manifest; new manifest keys (`fabric:`, `tunnel:`) must be validated there too. |
| **`OpenMasjidDonations`** | **Consumer** of `students/billing`: its campaign system gains a **`tuition` campaign type** that is *fully managed by this container* — label from `info`, flow is **Student ID** → confirm the name → balance → pay. Brief: `docs/STUDENTS_INTEGRATION.md` there. |
| **`OpenMasjidKiosk`** | **Consumer** of `students/billing`: same **`tuition` campaign type** as a kiosk tile (Stripe Reader M2), same Student ID flow. Brief: `docs/STUDENTS_INTEGRATION.md` there. |

**App identity:** app id **`students`** (compose project `omos-students`, data at `/opt/openmasjid/apps/students/`), display name **OpenMasjid Students**, repo **`OpenMasjid-Solutions/OpenMasjidStudents`**, image **`ghcr.io/openmasjid-solutions/openmasjidstudents:<semver>`** (public, multi-arch amd64+arm64; the CI derives the image name from the repo basename lowercased — no hyphen), category **`admin`**.

**Scope rule:** this app never talks to Donations or Kiosk directly, and they never talk to it directly — **everything crosses through the OS core's Fabric broker** (§11). The one external system this app *does* talk to directly is **Stripe** (portal payments, autopay, webhooks), using keys fetched over the Fabric.

**Madrasa-first is a design rule, not decoration:** class types, grading-scale defaults, merit categories, admissions fields, and report/transcript templates all ship with madrasa-native defaults (below) — while every one of them stays admin-editable, every label goes through i18n (Arabic/Urdu-ready), and, per the org rule, sacred text never appears as decorative chrome.

---

## 3. Licensing — same hard rules as the rest of the org

- License: **AGPL-3.0-only**, with the org **CLA** (dual-licensing) — copy `CLA.md`, `CONTRIBUTING.md`, and the CLA-assistant workflow pattern from `OpenMasjidOS`.
- **Every new file starts with the SPDX header** in its comment syntax — `// SPDX-License-Identifier: AGPL-3.0-only` (ts/tsx/js/css), `# …` (yml/sh/Dockerfile), `<!-- … -->` (md/html) — followed by `Copyright (C) 2026 OpenMasjid-Solutions`. Never strip an existing header.
- Never copy code from AGPL-incompatible sources — and **never copy QuickSchools' UI text, templates, assets, or code**; they are the feature benchmark, nothing more. Re-implement from behaviour. Permissive deps (MIT/ISC/BSD) are fine. When in doubt, write it yourself.
- **No AI co-author trailers in commits.** Conventional-commit messages (`feat:`, `fix:`, `docs:` …), small focused commits.
- Fonts and assets must be license-clean (OFL etc., as done in OpenMasjidDisplay).

---

## 4. Scope

### ✅ In scope (v1)

**People (the billing subjects)**
- Students (**one `fullName` field** — not a first/last pair, since many madrasa names do not split into two western halves; DOB optional, status active/withdrawn, notes). **Adding people starts with a STUDENT** (`people.studentAdd`) — there is no "add a family" step and nobody is ever asked to NAME a family (0.39.0). A household is formed by linking a new child to an existing sibling (`linkToStudentId` when adding, `people.familyAddSibling` afterwards — pick the household on screen plus the child to bring into it, which MERGES the two households; `studentUnlinkSiblings` undoes it). Its label is DERIVED from the children's surnames (`familyLabel`, in people/household.ts): one surname → "Ismail family", several → "Farooqi / Ismail", sorted so it never depends on who was added first. **guardians** (name, phone, email) attach to the HOUSEHOLD, which is exactly why linking a sibling is what makes the parent details apply to them — nothing is copied per student. **emergency contacts** (flag guardians and/or add extra contacts per household).
- **Student IDs**: every student gets an **auto-generated Student ID at registration** — the first three letters of their name + 4 digits (`YUS1234`), UNIQUE per install. It is how a parent pays at the Donations site / Kiosk and one half of the portal self-registration door. **There is no PIN** (removed v0.39.0): the only thing a stranger with someone else’s ID can do is pay their tuition, so the compensating controls are an on-screen name confirmation plus a hard per-ID lockout, not a shared secret (§11.2, §14). IDs are printed on statements next to each child.

**Finance (billing — the whole app)**
- **Fee plans**: amount (integer cents), cadence `monthly | per-term | one-time`, **assigned per STUDENT** (`student_fees`), with a per-student amount **override** — which is also how a sibling/hardship discount is expressed. (The family-level discount was removed in 0.39.0: with one bill per child it had nowhere honest to sit.)
- **Invoices** per STUDENT (generated for a month/term via a "Generate" action; optional auto-generate), line items (one per plan), statuses `open | partially_paid | paid | void`, due dates.
- **Ledger & balances**: every balance is derived, never stored. A payment belongs to ONE STUDENT and auto-allocates to *their* invoices oldest-due-first; overpayment stays as **that child's credit**, absorbed by their next invoice. A family balance is simply the sum of its children's, because one adult pays for all of them — and one card charge covering several children is recorded as one row per child (`billing/ledger.ts` `recordSplit`/`splitAcrossFamily`).
- **External payments** arrive over Fabric from Donations and Kiosk (§11); **portal and autopay payments** (§13) land in the same ledger. Finance *sees* the channel, Stripe reference, and status without doing anything.
- **Manual payments**: channel `cash | zelle | check | other`, amount, date, memo, attached **proof** (jpg/png/webp/pdf, ≤10 MB), served only to `finance`/`admin`.
- **Printable statements** (print-CSS HTML): balance, open invoices, recent payments, each child’s **Student ID**, and a **QR code to the parent-portal signup** — plus one line telling parents they can pay with their child’s Student ID on the donation site or the kiosk.
- **Stripe reconciliation** (safety net): daily job + on-demand button for PaymentIntents tagged `purpose=students-billing` (§11.4).
- Parent-account tools: create/invite guardians, resend invites, disable accounts, see autopay status per family.

**Parent portal (tunnel-first — the headline)**
- Login lands on **My family**: the kids (with their Student IDs), the family balance, open invoices, and one unified payment history (kiosk / donation site / portal / autopay / cash).
- **Pay now**: pay the full balance or a chosen amount by card, in-app, via **Stripe Elements**.
- **Saved cards**: add/remove payment methods (SetupIntents, off-session capable), pick a default.
- **Autopay**: per-family toggle — charge the default card automatically when invoices come due; decline handling with retries + emails; parent can turn it off any time (§13).
- Receipts by email; profile basics (name, phone, password).

**Platform integration**
- Fabric **appearance inherit**, **SSO** (`sso: true`, LAN admin only), **notifications** (`notifications: true` — payments, autopay failures to the masjid webhook), and the **provider** side of `students/billing` (§11).
- **Cloudflare uplink** (`tunnel: true`): stable public HTTPS URL, injected as `OPENMASJID_PUBLIC_URL`; used for parent/finance access, QR links, and inbound Stripe webhooks.
- **`https: true`** in the manifest — the parent portal embeds Stripe Elements, which requires a secure context.
- **SMTP (in-app admin setting, strongly recommended)**: parent invites, password resets, payment receipts, autopay failure notices. **Transactional only in v1**. Without SMTP the portal still works — invites become copy/print links, resets go through the office.
- **Audit log** on every sensitive write: fee assignment, invoices, payments, reversals, autopay changes, role/user changes — who, when, before → after.
- **Access-origin policy**: `admin` sessions work **only on the masjid LAN**; `finance` and `parent` work on LAN **and** over the Cloudflare uplink (§12.4 — hard constraint).
- i18n (i18next) + full **RTL**; light/dark via Fabric appearance; `prefers-reduced-motion`.

### ❌ Out of scope — do not build these

- **All academics / SIS** (removed in the v0.35.0 pivot): classes, scheduling/timetable, attendance, gradebook, grading scales, merit, comment bank, exams, report cards, transcripts, term finals, admissions/the `/apply` form, the Report Creator, custom student fields, documents-on-file, student notes/incidents, and the **teacher/student** roles. Do not reintroduce any of these.
- **Stripe Billing subscriptions/invoices.** Autopay is saved-card + off-session PaymentIntents driven by **our** scheduler and **our** invoices (§13.3). Our ledger is the source of truth; never mirror it into Stripe objects.
- Card-present hardware in this app (that's Kiosk's job); ACH/bank debits; wallets beyond what Elements gives for free.
- Parent-initiated data edits (changes go through the office); push notifications.
- Multi-tenant anything (one install = one masjid); payroll, staff HR, zakat handling; a public REST API beyond §11.

### 🔭 Later (deferred by decision — design for, don't implement)

Grade-publish and the whole SIS were removed, not parked — see ❌. Payment-side deferrals only: ACH autopay; TOTP 2FA for staff.

---

## 5. Roles, permissions, and origin policy (hard constraints — enforce server-side)

Every tRPC procedure declares a required role **and** allowed origin; checks live in middleware, never only in the UI. Teachers are scoped to their assigned classes; parents are scoped to **their own linked families** — enforced in queries, not UI filters.

**Origin policy (Hasan's rule):**

| Role | LAN | Cloudflare tunnel |
| --- | :-: | :-: |
| `admin` | ✅ | ❌ **blocked — login and existing sessions both** |
| `teacher` | ✅ | ✅ |
| `finance` | ✅ | ✅ |
| `parent` | ✅ | ✅ |
| *(public admissions form)* | ✅ | ✅ *(no auth; §14 hostile-input rules)* |

**Permission matrix:**

| Capability | `admin` | `teacher` | `finance` | `parent` |
| --- | :-: | :-: | :-: | :-: |
| Users, roles, settings (SMTP, Stripe, scales, merit categories, custom-field defs) | ✅ | ❌ | ❌ | ❌ |
| Students / families / guardians / emergency contacts — write | ✅ | ❌ | ❌ | ❌ |
| Students directory — read | ✅ | own classes | ✅ | own family only |
| Custom-field values — write / read | ✅ / ✅ | ❌ / own students | ❌ / ✅ | ❌ / ❌ |
| Documents on file | ✅ | read `staff`-visible, own students | ❌ | ❌ |
| Incidents — write / read | ✅ | own students / own students | ❌ | shared-only, own kids |
| Student notes (activity log) | ✅ | own students | ❌ | ❌ |
| Guardian contact — read | ✅ | own students | ✅ | own family |
| Classes, terms, enrollments, timetable — write | ✅ | ❌ | ❌ | ❌ |
| Timetable — read | ✅ | own schedule | ✅ | own kids |
| Attendance — write / read | ✅ / ✅ | own classes | ❌ | ❌ / own kids |
| Gradebook — write / read | ✅ / ✅ | own classes | ❌ | ❌ / own kids |
| Grading scales + final-grade formula config | ✅ | ❌ | ❌ | ❌ |
| Gradebook history — view / restore | ✅ / ✅ | own classes / ❌ | ❌ | ❌ |
| Merit — award / read | ✅ / ✅ | own classes | ❌ | ❌ / own kids |
| Comment bank — shared / personal | ✅ / – | read / own | ❌ | ❌ |
| Exams — define / assign to classes / max marks | ✅ | ❌ | ❌ | ❌ |
| Exam scores + term remarks — write | ✅ | own classes | ❌ | ❌ |
| Term close / reopen (freeze finals) | ✅ | ❌ | ❌ | ❌ |
| Report cards & transcripts — generate / regenerate / publish | ✅ | ❌ | ❌ | ❌ |
| Report cards & transcripts — read (any version) | ✅ | own classes | ❌ | own kids, **published only** |
| Admissions pipeline (incl. one-click enroll) | ✅ | ❌ | ✅ | ❌ (public form is anonymous) |
| Report Creator | all datasets | ❌ | billing + directory datasets | ❌ |
| **Fee plans — define / archive / delete** (0.42.0) | ✅ | ❌ | ❌ **read only** | ❌ |
| Invoices: generate, void, one-off charges | ✅ | ❌ | ✅ | ❌ (view own invoices) |
| Ledger / all payments — read | ✅ | ❌ | ✅ | own family only |
| Record manual payment + proof | ✅ | ❌ | ✅ | ❌ |
| View payment proofs | ✅ | ❌ | ✅ | ❌ (not even own) |
| **Pay by card (Elements)** | ❌ (no reason) | ❌ | ❌ | ✅ own family |
| **Saved cards / autopay manage** | ✅ (disable only) | ❌ | view status | ✅ own family |
| Parent invites / account admin | ✅ | ❌ | ✅ | ❌ |
| View student IDs, print statements | ✅ | ❌ | ✅ | ❌ (own kids' IDs shown read-only) |
| Audit log — read | ✅ | ❌ | billing only | ❌ |
| CSV export | ✅ | ❌ | billing only | ❌ |

Clean walls, on purpose: **teachers never see money; finance never sees grades, incidents, or notes; parents never see other families — or payment proofs, staff notes, or unshared incidents.** If a feature seems to need to cross a wall, stop and ask.

---

## 6. Architecture

```
        LAN (masjid Wi-Fi)                        Internet (Cloudflare tunnel via the OS)
  ┌──────────────────────────────┐        ┌───────────────────────────────────────────┐
  │ ADMIN (only here)            │        │ Parents (portal, pay, autopay)             │
  │ + teacher/finance/parents    │        │ Teachers (attendance/grades)               │
  │   on masjid Wi-Fi            │        │ Finance (billing) · Public admissions form │
  └──────────────┬───────────────┘        │ Stripe → webhooks → OPENMASJID_PUBLIC_URL  │
                 │ HTTPS (platform-served,│ └───────────────────┬───────────────────────┘
                 │ https:true port)       │                     │ HTTPS (public URL)
                 ▼                        ▼                     ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │                OpenMasjidStudents — ONE container                         │
   │  Fastify + tRPC (+ static built React UI: admin/teacher/finance/parent)  │
   │  SIS · timetable · merit · exams · report cards · transcripts            │
   │  Admissions pipeline · Report Creator (dataset registry, no raw SQL)     │
   │  SQLite (WAL) via Drizzle  •  /data volume (db + attachments + reports)  │
   │  Auth (argon2id) + roles + ORIGIN POLICY (admin = LAN-only)               │
   │  Stripe: Elements PIs, SetupIntents, off-session autopay, webhook intake  │
   │  Scheduler: autopay runs, invoice auto-generate, reconciliation           │
   │  /fabric/billing/*  ← secret-gated provider endpoints (LAN-only)          │
   └───────────────▲──────────────────────────────────┬───────────────────────┘
                   │ core → app (brokered calls from   │ app → core: SSO check,
                   │ Donations / Kiosk, authenticated  │ notify, stripe keys,
                   │ by THIS app's own APP_SECRET)     │ appearance
   ┌───────────────┴──────────────────────────────────▼───────────────────────┐
   │                          OpenMasjidOS core                                 │
   │  /api/auth/session   /api/fabric/notify   /api/fabric/stripe               │
   │  /api/fabric/app/students/billing/*  ← NEW broker (OS work order)          │
   │  Cloudflare tunnel: exposes app paths ONLY; /api/fabric/* and the app's    │
   │  /fabric/* prefix are NEVER reachable through the tunnel                   │
   └─────────────────────────────────────────────────────────────────────────────┘
```

- **One image, one container**; multi-stage Dockerfile; the Node daemon serves the tRPC API, the Stripe webhook route, the public admissions form, the Fabric provider routes, and the built static UI. One published web port (default host `8360` → container `8080`); the platform's `https: true` handling gives it a TLS host port on the LAN.
- **SQLite in WAL mode** on `/data`. All money in **integer cents**.
- One React app, four route trees (`/admin`, `/teach`, `/billing`, `/family`) behind one login — the shell routes by role — plus the anonymous `/apply` admissions form. Parent portal is designed **phone-first**.
- Type safety end-to-end: UI imports the server's tRPC `AppRouter` **type only**.
- **Standalone rule**: with no platform, no tunnel, no Donations/Kiosk, and no SMTP, the app still fully works on the LAN — SIS, timetable, exams, report cards, transcripts, and manual-payment billing all function; every integration degrades gracefully. (Without the tunnel, the portal and admissions form are LAN-only and Stripe webhooks fall back to reconciliation, §13.5.)

---

## 7. Tech stack (mirrors the org's house stack — confirm before deviating)

| Layer | Choice | Notes |
| --- | --- | --- |
| Language | **TypeScript everywhere**, `strict` | No `any` without a justifying comment. |
| Repo layout | **npm workspaces monorepo** (`packages/*`) | Same as OpenMasjidOS. |
| Backend | **Node.js 20+**, **Fastify**, **tRPC** | Plain Fastify routes for `/fabric/*`, `/api/stripe/webhook`, `/apply`. |
| DB | **SQLite (WAL)** via **better-sqlite3** + **Drizzle ORM** | Migrations committed; run on boot. |
| Validation | **zod** at every tRPC / `/fabric` / webhook / admissions boundary | |
| Auth | **argon2id** + signed, HTTP-only, `Secure` cookies | Origin policy middleware (§12.4). |
| Payments | **`stripe`** (Node SDK) + **`@stripe/stripe-js`/Elements** | Keys via Fabric (§13.1). Card data never touches our server. |
| Scheduler | **croner** (or `node-cron`) in-process | Autopay runs, auto-generate, reconciliation. |
| Email | **nodemailer** (SMTP from in-app settings) | Transactional only in v1. Optional but recommended. |
| Frontend | **React 18 + Vite** | |
| Styling | **Tailwind CSS v4** + CSS custom properties | Tokens only. |
| Components | **shadcn/ui** (copied-in Radix) | |
| Animation | **Motion** | Reduced-motion, always. |
| Data/state | **TanStack Query** via tRPC React integration | |
| Icons | **lucide-react** + org masjid glyphs | |
| i18n | **i18next / react-i18next**, RTL-aware | English first; Arabic/Urdu-ready. |
| QR | small MIT QR lib (e.g. `qrcode`) | Statements + portal signup links. |
| Report-card & transcript PDFs | **`@react-pdf/renderer`** (pure JS, server-side) | **No headless Chromium — Pi-friendly.** Embed an OFL Arabic-capable font (Amiri / Noto Naskh) for names/labels. If Arabic shaping misbehaves, fall back to `pdfkit`+fontkit — decide once, in `reports/`. Class print = one combined document, page break per student (no merge lib). |
| Report Creator | in-house dataset registry + Drizzle query composition | **No SQL from user input, ever** — datasets, columns, filters are code-defined enums the UI picks from. |
| Uploads | Fastify multipart → `/data/attachments` | §14 rules. |
| Build/deploy | Docker multi-stage → one runtime image | Public, multi-arch, pinned tags. |

Keep it Pi-friendly. Ask before adding heavy dependencies.

---

## 8. Repository structure

```
OpenMasjidStudents/
├── CLAUDE.md / README.md / LICENSE / CLA.md / CONTRIBUTING.md / VERSION / CHANGELOG.md
├── manifest.yaml / docker-compose.yml / Dockerfile / package.json
├── .github/workflows/build-image.yml    # CI: multi-arch image → GHCR on main (release flow, §19)
│
├── packages/
│   ├── server/
│   │   └── src/
│   │       ├── index.ts                 # boot: Fastify + tRPC + static UI + /fabric + /api/stripe/webhook + /apply
│   │       ├── db/                      # drizzle schema + migrations + money helpers
│   │       ├── trpc/
│   │       │   ├── router.ts            # root AppRouter (type exported to UI)
│   │       │   ├── auth.ts              # login, users, invites, resets, SSO fast-path
│   │       │   ├── people.ts            # students, families, guardians, custom fields, docs, notes, incidents
│   │       │   ├── classes.ts           # terms, classes (types+subjects), enrollments, teacher assignment
│   │       │   ├── schedule.ts          # timetable sessions, views, conflict warnings
│   │       │   ├── attendance.ts / grades.ts   # grades.ts incl. scales, formulas, gradebook history
│   │       │   ├── merit.ts / comments.ts
│   │       │   ├── exams.ts             # exam definitions, class assignment, score-entry grid, completion
│   │       │   ├── reports.ts           # report cards + transcripts: generate / versions / publish / fetch; term close
│   │       │   ├── admissions.ts        # pipeline stages, notes, one-click enroll
│   │       │   ├── reportcreator.ts     # saved reports over the dataset registry
│   │       │   ├── billing.ts           # fee plans, invoices, ledger, manual payments
│   │       │   ├── portal.ts            # parent-scoped reads + pay-now + cards + autopay
│   │       │   └── admin.ts             # settings (SMTP, Stripe, scales, merit cats, policies), exports, audit
│   │       ├── payments/
│   │       │   ├── stripe.ts            # client from Fabric keys; PI/SetupIntent helpers
│   │       │   ├── webhook.ts           # signature verify, event dedupe, → ledger
│   │       │   ├── autopay.ts           # scheduler runs, retry ladder, disable+notify
│   │       │   └── reconcile.ts         # metadata reconciliation job (§11.4)
│   │       ├── fabric/
│   │       │   ├── provider.ts          # /fabric/billing/* (§11) — secret-gated
│   │       │   └── platform.ts          # session check, notify, appearance, stripe keys
│   │       ├── billing/                 # allocation engine, student IDs, statements
│   │       ├── reports/                 # @react-pdf templates (report card + transcript), batch generator, versioning (→ /data/reports)
│   │       ├── reporting/               # Report Creator dataset registry + query composition (role-scoped)
│   │       ├── admissions/              # public-form handling (hostile input), pipeline logic
│   │       ├── mail/                    # nodemailer + templates (invite/reset/receipt/autopay)
│   │       ├── attachments/ / audit/
│   │       └── security/origin.ts       # LAN-vs-tunnel detection + role policy (§12.4)
│   └── web/
│       └── src/
│           ├── routes/
│           │   ├── login/               # + invite-accept + self-register + reset
│           │   ├── apply/               # public admissions form (anonymous)
│           │   ├── admin/  teach/  billing/
│           │   └── family/              # parent portal: home, schedule, grades, merit, reports, pay, cards, autopay
│           ├── components/  lib/ (trpc, theme, i18n, motion, stripe)
│           └── …
└── docs/
    ├── FABRIC_BILLING_CONTRACT.md       # §11 extracted verbatim (the cross-repo contract)
    ├── PAYMENTS.md                      # §13 flows, webhook events, autopay ladder
    └── DATA_MODEL.md
```

---

## 9. Data model (Drizzle/SQLite — key rules)

Tables: `users`, `sessions`, `invites`, `families`, `students`, `guardians`, `guardian_families`, `guardian_users` (guardian ↔ user link, gives a parent account its family scope), `emergency_contacts`, `student_field_defs`, `student_field_values`, `student_documents`, `student_notes`, `incidents`, `terms`, `classes` (incl. `type`: `maktab|hifz|nazrah|alim|custom` + `custom_label`), `class_subjects` (ordered, free text), `class_teachers`, `class_sessions` (timetable), `enrollments`, `attendance`, `grading_scales` + `scale_bands`, `class_grade_config` (formula weights + scale), `grade_items`, `grades`, `gradebook_snapshots`, `merit_categories` + `merit_awards`, `comment_snippets` (shared|personal), `exams`, `exam_classes`, `exam_class_subjects` (the **snapshot** of a class's subjects + per-subject `max_marks` at assignment time), `exam_scores`, `term_remarks`, `term_finals`, `report_cards`, `transcripts`, `admissions` (+ `admission_notes`), `saved_reports`, `fee_plans`, `student_fees`, `invoices` (per student), `invoice_items`, `payments` (per student), `payment_allocations`, `payment_methods` (Stripe PM refs — id/brand/last4/exp only, **never PANs**), `autopay_enrollments`, `autopay_runs`, `stripe_events` (webhook dedupe), `attachments`, `audit_log`, `fabric_inbox`, `settings`. Student IDs live on `students` (`student_code`, UNIQUE) — retrievable by design (they’re printed on statements). The DB file holds minors’ PII and every payment record, so the file itself is a secret regardless.

Non-negotiable rules:

- **A student has ONE name column** (`students.full_name`). The Student ID prefix and the household label both DERIVE their piece of it at the point of use (people/names.ts) rather than storing a split, so one field stays authoritative. The Fabric contract still exposes `firstName` + `lastInitial` and still never returns a full surname (§11.2) — those are derived too.
- **Staff carry no phone number.** The app never contacts staff by phone, so `users.phone` was dropped; phone numbers exist only on guardians and emergency contacts, where there is a reason to ring them.
- **Allocation is DERIVED, not incremental.** An invoice’s status comes from `payment_allocations`, so money paid before a bill existed has to be attached once that bill appears — `ledger.reallocateStudent` recomputes a student’s whole mapping oldest-due-first whenever an invoice or charge changes. Payments themselves are never touched.
- **Student IDs are UNIQUE per install** (the lookup index for every payment path, §11.2) and always GENERATED, never chosen or imported — two children sharing one would land a payment on the wrong record. They appear **nowhere** in logs or Stripe metadata (statements and staff screens are the intended places).
- **Exam subjects are a snapshot**: `exam_class_subjects` is copied from `class_subjects` when an exam is assigned to a class (with editable `max_marks`); later edits to the class's subject list never touch existing exams. `exam_scores` UNIQUE per (exam_class, student, subject); `value` is a number **or** an explicit state `absent | exempt` — blanks mean "not yet entered" and block completion, nothing else.
- **Term finals are frozen facts**: computed from the class's `class_grade_config` at term close and written to `term_finals`; transcripts read **only** `term_finals`, never live gradebooks. Reopening a term regenerates the affected finals — audited both ways.
- **Report cards and transcripts are immutable, versioned artifacts**: a row = (student, term-or-cumulative, version, generated_by/at, published_at?, pdf path under `/data/reports/`) — regeneration inserts version N+1 (audited); no update/delete path for the PDF or the row. Publishing flips `published_at` only.
- **Gradebook snapshots are append-only** (every save); "restore" writes a new state forward, it never rewrites history.
- **Admissions rows are hostile input**: created by the anonymous form → strict zod, hard length caps, stored as plain data (never rendered as HTML), no file uploads on the public form in v1.
- **Custom fields are typed at the definition**: `student_field_values` validate against their `student_field_defs` type on every write; defs are soft-deleted so old values keep meaning.
- **Money = integer cents**; currency per install (default `usd`); no floats; one formatting helper.
- **Idempotency**: `payments.idempotency_key` UNIQUE (Stripe PI id, whatever the channel — portal, autopay, donations-web, kiosk). Replays return the original result.
- **Payment channels**: `donations-web | kiosk | portal | autopay | cash | zelle | check | other`. One `billing/ledger.ts` records them all — the fabric provider, the webhook handler, and the manual-payment UI are thin callers of the same function.
- **Invoices and payments are per STUDENT** (`invoices.student_id`, `payments.student_id`, both NOT NULL since 0.39.0). One card charge for several children fans out to one row per child, keyed `${idempotencyKey}:${studentId}` so the UNIQUE index still makes a replay a no-op per child. Anything that DERIVES a split must check `recordedSplit(key)` first — re-deriving after a successful call reads the invoices it already paid down and would record the money twice.
- **Balances derived, never stored**; **payments immutable** (corrections = reversal rows); soft-delete for anything money/grades reference; FKs `ON DELETE RESTRICT` on money paths.
- `stripe_events.event_id` UNIQUE — a replayed webhook is a no-op.
- `autopay_runs` UNIQUE on (family, run_date): the scheduler's own idempotency, and the Stripe idempotency key for PI creation is derived from it (§13.3).
- Attendance UNIQUE per (student, class, date). Every table: id, created_at, updated_at.

---

## 10. Catalog manifest (`manifest.yaml`)

Follows `OpenMasjidOS/docs/APP_MANIFEST_SPEC.md` + `OpenMasjidAPPS/docs/BUILDING_AN_APP.md`. Sketch:

```yaml
id: students
name: OpenMasjid Students
version: 0.1.0
tagline: The madrasa office in one app — attendance, grades, report cards, tuition
category: admin
author: OpenMasjid-Solutions
license: AGPL-3.0-only
sso: true                # platform admin opens it signed-in on the LAN
notifications: true      # payment/autopay/admissions alerts to the masjid webhook
stripe: true             # keys via GET /api/fabric/stripe — used for real charges (§13)
https: true              # REQUIRED: the parent portal embeds Stripe Elements (secure context)
tunnel: true             # NEW manifest key — public HTTPS uplink (OS work order)
fabric:                  # NEW manifest key — app-to-app (OS work order)
  provides:
    - capability: billing
settings:
  - key: SCHOOL_NAME
    label: School name
    type: text
  - key: CURRENCY
    label: Currency
    type: select
    options: [usd, cad, gbp, eur]
    default: usd
  - key: STRIPE_ACCOUNT
    label: Stripe account for tuition payments
    type: stripe-account
ports:
  - container: 8080
    label: Web interface
```

The compose **must reference** the Fabric env vars in `environment:` (`${VAR}` substitution — forget one and the Fabric silently no-ops): `OPENMASJID_APP_ID`, `OPENMASJID_BASE_URL`, `OPENMASJID_APP_SECRET`, and `OPENMASJID_PUBLIC_URL` (tunnel URL; empty when not exposed — var name owned by the OS work order, keep in sync). The compose `image:` line is **digest-pinned per release** — `ghcr.io/openmasjid-solutions/openmasjidstudents:<semver>@sha256:<digest>` (§19), never a floating tag. SMTP is **not** manifest settings — it's an in-app admin settings page (host/port/user/password/from), stored in the DB, secrets never logged.

---

## 11. THE SHARED CONTRACT — Fabric capability `students/billing` (v2)

> Source of truth for four repos. Copy verbatim into `docs/FABRIC_BILLING_CONTRACT.md`; the OS/Donations/Kiosk briefs point here. Version the contract (`"v": 2` in every response — v2 dropped the PIN from `lookup`; see `docs/FABRIC_BILLING_CONTRACT.md` §11.0 for the v1→v2 note and what a consumer must change). Consumers surface this capability as a **`tuition` campaign type** in their own campaign systems: the campaign shell (tile/card) lives in Donations/Kiosk, but everything inside it — label, lookup, balances, recording — is **fully managed by this container** via the methods below. **The parent portal (§13) does NOT change this contract** — portal/autopay payments are recorded internally and only touch §11.3 (a third `omos_app` value).

### 11.1 Transport (all four repos must agree)

- Consumers (Donations, Kiosk) call the **OS broker**, never this app directly:
  `POST ${OPENMASJID_BASE_URL}/api/fabric/app/students/billing/<method>` with header `X-OpenMasjid-App-Secret: <the CALLER's own secret>` and a JSON body.
- The core verifies the caller's secret + that the caller's manifest declares `fabric.consumes: [students/billing]`, then proxies to this app's published port at `POST /fabric/billing/<method>`, setting:
  - `X-OpenMasjid-App-Secret: <THIS app's own secret>` — proof the request came from the platform (only the platform knows our secret);
  - `X-OpenMasjid-Caller-App: donations | kiosk` — trusted caller identity, set by the core.
- **This app must:** 401 any `/fabric/*` request whose secret header doesn't match `OPENMASJID_APP_SECRET` (constant-time compare); ignore/strip client-supplied `X-OpenMasjid-Caller-App` on non-Fabric routes; never serve `/fabric/*` to tunnel-origin requests (defense in depth — the OS blocks the prefix too). Limits: JSON only, ≤256 KB, respond < 10 s.
- Errors from this app: HTTP status + `{ "error": { "code", "message" } }`. Broker-generated errors arrive as `{ "fabric_error": { "code", "message" } }` (`target_not_installed`, `target_unreachable`, `timeout`, `not_granted`, `rate_limited`) — consumers must fail soft on those.

### 11.2 Methods this app provides

**`POST /fabric/billing/info`** — what consumers need to render the tuition campaign shell.
```jsonc
{ "v": 1 }
→ { "v": 1, "enabled": true, "schoolName": "An-Noor Weekend School", "currency": "usd",
    "tagline": "Pay tuition with your child's Student ID",
    "allowAdvance": true, "minAmountCents": 100 }   // 0.41.0, additive
// "enabled": false (setup incomplete or external payments turned off by admin) → consumers hide the campaign
// allowAdvance: a parent may pay when NOTHING is due (a term up front, a Ramadan lump sum) — consumers
// must offer the amount field at a zero balance, floored at minAmountCents. See the contract doc §11.0a.
```

**`POST /fabric/billing/identify`** — echo back WHO a typed Student ID belongs to, so a consumer can ask "is this the right child?" **before** any balance appears. Call it first; that confirmation is what replaced the PIN. Returns a first name + last initial and nothing else — no balance, no invoices, no siblings, not even the family id.
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
    "openInvoices": [{ "id": "inv_9", "studentId": "stu_1", "label": "Tuition — Jul 2026", "dueDate": "2026-07-01", "balanceCents": 20000 }]
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
  "allocations": [{ "invoiceId": "inv_9", "amountCents": 15000 }],   // optional; omitted → auto-allocate oldest-due-first
  "payerNote": "paid by grandmother" }        // optional, ≤200 chars, displayed to finance
// 200 (first time)      { "v": 1, "recorded": true, "paymentId": "pay_71", "duplicate": false }
// 200 (replay)          { "v": 1, "recorded": true, "paymentId": "pay_71", "duplicate": true }
// 404 unknown family    { "error": { "code": "family_not_found", "message": "…" } }
// 422 bad allocation    { "error": { "code": "invalid_allocation", "message": "…" } }
```
Surplus beyond open invoices becomes family credit. A recorded external payment fires a Fabric **notification** and an audit entry.

**`POST /fabric/billing/check`** — retry helper for consumer outboxes.
```jsonc
{ "v": 1, "idempotencyKey": "pi_3PabcDEF" }  →  { "v": 1, "recorded": true, "paymentId": "pay_71" } | { "v": 1, "recorded": false }
```

### 11.3 Stripe metadata contract (on EVERY tuition PaymentIntent, whoever mints it)

```
purpose            = students-billing        ← the discriminator; REQUIRED
omos_app           = donations | kiosk | students-portal    ← students-portal is set ONLY by this app (§13)
students_family_id = fam_x1                  ← REQUIRED (from lookup / known internally)
students_student_id = stu_1                  ← optional, the matched student
```
**Never put a Student ID or a child's name in Stripe metadata, descriptions, or URLs** — metadata is visible in Stripe dashboards and exports. Description: `School balance — <family label>`. **Receipts must say "payment", never "donation"** — tuition is generally not tax-deductible; consumers exclude `purpose=students-billing` from donation totals and year-end letters, and this app's own receipts follow the same wording rule.

### 11.4 Reconciliation (this app's safety net — covers three channels)

Daily job + on-demand "Reconcile now" button (finance): fetch keys via `GET ${OPENMASJID_BASE_URL}/api/fabric/stripe?account=<STRIPE_ACCOUNT>` (with our secret), list succeeded PaymentIntents where `metadata.purpose == "students-billing"` since the last cursor, and record any whose PI id isn't already an idempotency key — flagged `via: reconciliation`. Covers missed broker calls from Donations/Kiosk **and missed webhooks for our own portal/autopay PIs**. The push paths are optimizations; **money is never lost**, only delayed.

---

## 12. Auth, roles, SSO, tunnel — and the origin policy

- **App-local accounts are primary.** Username/email + argon2id, server-side sessions, HTTP-only `Secure` SameSite cookies, login rate-limited with generic errors. Admin/finance create staff users; forced password set on first login.
- **Parent accounts** (two doors, both land on a `guardian_users` link):
  1. **Invite** (default): finance/admin picks a guardian → the app emails (or prints, if no SMTP) a one-time invite link (CSPRNG token, 7-day expiry, single use) → parent sets a password. Admissions' one-click enroll sends this automatically.
  2. **Self-registration** (admin toggle, default ON): parent visits `/family/register`, enters **a child’s Student ID plus a guardian email already on file for that child’s family**, then verifies via emailed link (email required for this door; hidden when the platform has no mail). The on-file email is the load-bearing half: an ID alone can only *pay* (§11.2), so minting an ACCOUNT from one would be an escalation — requiring an address the office already recorded means the invite can only land in an inbox the school chose. Throttled per IP and per ID (the same lockout bucket the Fabric lookup uses).
  Password reset mirrors the doors: email link when SMTP is on; office re-invite when off.
- **First run**: create the app `admin` (LAN only, naturally). No anonymous access to anything but login/first-run/invite/register/reset pages, the public `/apply` admissions form, and the secret-gated `/fabric/*` + `/api/stripe/webhook`.
- **SSO fast-path (LAN only)**: per the platform spec — backend forwards the incoming `omos_session` cookie to `GET ${OPENMASJID_BASE_URL}/api/auth/session` with `X-OpenMasjid-App-Secret`; on `{authenticated:true}` mint an app session as `admin`. Cache positives ~45 s, cap SSO sessions ~1 h, treat `username` as untrusted display text. Identity signal only. (SSO mapping to `admin` is consistent with the origin policy: the platform cookie never rides the tunnel.)
- **12.4 Origin policy enforcement (DO NOT REGRESS):**
  - Every request gets classified once in `security/origin.ts`: **`tunnel`** if `cf-ray` is present or `x-forwarded-proto: https` arrives from the OS ingress (the OS strips client-supplied forwarded headers and sets trusted values — that hygiene is what we rely on); otherwise **`lan`**. Note the safe failure direction: spoofing *toward* `tunnel` only ever **removes** privileges.
  - `admin` **login attempts from tunnel are refused** with a friendly message ("Admin sign-in only works on the masjid network") and **existing `admin` sessions presented from tunnel get 403** — both, so a LAN-minted admin cookie is useless remotely.
  - `teacher | finance | parent` allowed from both origins. `/fabric/*` refuses tunnel-origin outright (§11.1).
  - The policy lives in one middleware consulted by every tRPC procedure; per-procedure overrides are forbidden without a CLAUDE.md change.
- **Tunnel niceties**: absolute links/QRs/invite emails use `OPENMASJID_PUBLIC_URL` when set; the SSO cookie simply won't be present over the tunnel — fall back to app login silently.

---

## 13. Payments in this app — parent portal pay-now + autopay

> The Donations/Kiosk flows still exist for walk-ins and families without portal accounts; the portal is the first-class path. **One rule above all: card data never touches our server** — Stripe Elements in the browser, PI/SetupIntent confirmation via Stripe, our backend only ever sees Stripe ids.

### 13.1 Stripe client & keys
- On boot (and on settings change) fetch the configured account's keys over the Fabric: `GET ${OPENMASJID_BASE_URL}/api/fabric/stripe?account=<STRIPE_ACCOUNT>`. Publishable key → the browser; secret key → server memory only (never DB, never logs). If the platform is unreachable, payments features show "temporarily unavailable" and everything else keeps working.
- Each family that saves a card or enables autopay gets a **Stripe Customer** (id stored on `families`).

### 13.2 Pay now (parent, Elements)
1. Parent picks amount (full balance pre-filled; ≥ $1.00; optional per-invoice ticks → `allocations`).
2. Server creates a PaymentIntent: amount, currency, customer, **metadata per §11.3** (`omos_app=students-portal`, `students_family_id`), `description: "School balance — <family label>"`, and an app-side `portal_payment_intents` row keyed to the family.
3. Browser confirms with Elements (card on file selectable; "save this card" = `setup_future_usage: off_session`).
4. **Ledger truth lands on the webhook** (`payment_intent.succeeded` → `ledger.record`, channel `portal`, idempotency key = PI id). The UI may show optimistic success after client confirmation, worded softly ("Payment received — it'll show on your account momentarily"), then refetch.
5. Email receipt (wording: "payment", never "donation"). Fabric notify to the masjid webhook.

### 13.3 Autopay (saved card + our scheduler — NOT Stripe subscriptions)
- **Enroll**: parent adds/picks a default card (SetupIntent, `usage: off_session`), toggles autopay for the family. Clear consent copy: what gets charged, when, and how to turn it off — store the consent timestamp.
- **Run**: daily scheduler (croner) per family with autopay ON: sum open invoice balances with `due_date <= today`; if > 0, create `autopay_runs` row (UNIQUE family+date — our idempotency), then an **off-session PaymentIntent** with Stripe idempotency key derived from the run id, metadata per §11.3, allocations to those invoices. Webhook records it (channel `autopay`).
- **Decline / SCA ladder**: retry the run on day +2 and day +5 (new runs, same unpaid invoices). Email the parent on each failure with a "pay now / update card" link (authentication-required cards get sent to pay-now, where Elements can complete SCA). After the third failure: **auto-disable autopay**, email the parent, Fabric-notify finance. Never retry more than the ladder; never charge a disabled enrollment.
- Finance sees autopay status per family; admin can force-disable. Parents can cancel anytime (effective immediately; audited).

### 13.4 Webhooks
- Route: `POST /api/stripe/webhook` at `OPENMASJID_PUBLIC_URL` — **signature-verified** (raw-body route), event-deduped via `stripe_events`, then dispatched. Handle at minimum: `payment_intent.succeeded`, `payment_intent.payment_failed`, `setup_intent.succeeded`, `charge.refunded` (refund → reversal row + notify finance). Unknown events: 200 + ignore.
- **Endpoint management**: on boot, if `OPENMASJID_PUBLIC_URL` is set and no endpoint is registered, create the webhook endpoint via the Stripe API (idempotent — look for our URL first) and store the signing secret in `settings` (DB, not logs). Fallback: admin pastes a signing secret manually in Settings → Payments. Only events minted by **this** app matter here — Donations/Kiosk keep their own webhooks; ours filters `metadata.omos_app == "students-portal"` defensively anyway.

### 13.5 Failure doctrine
- No tunnel / no webhook delivery → reconciliation (§11.4) records portal/autopay PIs within a day. Money is never lost; the parent's optimistic-success wording (13.2.4) is honest about the small delay.
- Stripe down / keys unavailable → pay-now and autopay pause visibly; ledger, grades, everything else unaffected. Autopay runs skipped while paused are picked up by the next run (due-date query is stateless).

---

## 14. Sensitive data & security invariants — DO NOT REGRESS

This is the org's most sensitive app — **records about children, now internet-facing, now moving money, now including discipline notes and a public intake form**. Every invariant here is load-bearing:

- **Data minimization**: no SSNs, no medical fields, no photos in v1 (custom fields exist, but the shipped defaults stay minimal — resist stuffing sensitive categories into them). DOB optional. `lookup` (§11.2) never returns full last names, DOB, addresses, or guardian contact. The parent portal shows a family only to users linked via `guardian_users` — tested per procedure.
- **Origin policy (§12.4)** is a security invariant, not a preference: admin auth is impossible via tunnel, both at login and at session-use time.
- **The public admissions form is the most hostile surface in the app**: anonymous, internet-reachable. Strict zod + hard length caps, honeypot field, per-IP rate limit + daily cap, optional Turnstile hook, no file uploads, submissions stored as inert data and always rendered as text (never HTML), no information ever returned about existing students/families. It can *create* pipeline rows and nothing else.
- **Incidents and staff notes are staff-eyes-only by default**: an incident reaches a parent only via its explicit per-incident toggle; notes never do. Finance sees neither. Report Creator datasets must respect the same walls (no incidents/notes datasets outside admin).
- **Report Creator executes no user-supplied SQL or expressions — ever.** Datasets, columns, filters, and aggregations are code-defined enums composed through Drizzle bindings. A saved report is data (JSON of picks), not code. Dataset registry entries declare their minimum role; the runner re-checks on every execution.
- **Card data never touches the server** (Elements only); Stripe secret key in memory only; webhook route verifies signatures on the raw body and dedupes events; PM records store brand/last4/exp only.
- **No PII in logs** — ids and event names only; never names+amounts together; Fabric, webhook, and admissions bodies never logged.
- Role checks server-side on every procedure; teacher scoping and **parent family-scoping** enforced in queries.
- **Attachments**: magic-byte allow-list (jpg/png/webp/pdf), ≤10 MB, randomized names under `/data/attachments/`, EXIF/GPS stripped, three visibility classes enforced at the serving route — `payment-proof` (finance|admin only — **parents never see proofs**, not even their own), `student-document` (admin, or staff when so marked), `class-material` (staff + enrolled families). Never a public static mount.
- **Report-card and transcript PDFs are minors' academic records**: stored under `/data/reports/` with randomized names, served **only** through the authed route that re-checks the matrix on every fetch (admin: any; teacher: own classes; parent: own kids, `published_at` set); never guessable URLs; generation/regeneration/publish/term-close all audited.
- **A Student ID is the whole credential on the payment path, and it is GUESSABLE — the limiter is the control, not a secret**: `ABC1234` is ~10k guesses per name prefix, so lookups are throttled per-IP by the consumers, per-caller by the broker, **and per-ID here** — 6 failed probes/hour locks that ID for an hour and raises an admin alert. `identify`, `lookup` and parent self-registration **share one bucket** so failures cannot be laundered across endpoints. Uniform `found:false` for every mismatch flavor. This is safe only because of how narrow the ID’s authority is (see a balance, pay it) — if a future feature would let an ID *do* anything more, it needs a second factor first. IDs never in logs or Stripe metadata. **Invite/reset/verify tokens**: CSPRNG, single-use, expiring, stored hashed.
- Fabric provider: constant-time secret compare, zod before logic, 401 first; idempotency at the DB.
- Audit log append-only; payments immutable (reversals only); term finals/report cards/transcripts immutable (new versions only); Drizzle-bound SQL only; CSV formula-injection escaping (`=`,`+`,`-`,`@` prefixes) — doubly important now that Report Creator exports CSV.
- Internet-facing rate limits: login, register, reset, pay-now creation, admissions form — per-IP and per-account.
- Backups: `/data` contains minors' PII, **academic and disciplinary records, and payment records** — document that admins must treat backup files carefully.

---

## 15. Design & voice

Inherit the org design system (OpenMasjidOS `CLAUDE.md §14`): calm, dignified, masjid-themed; emerald primary, gold accents; dark default; Motion springs; WCAG AA; geometric motifs only — **never sacred text as decoration**. Apply the Fabric appearance payload; optionally live-poll `/api/public/appearance`.

**Platform-family UI parity is a requirement, not a vibe.** A masjid admin opening this app from the OpenMasjidOS dashboard should not be able to tell they left it — and that includes the **`/admin` route tree**, not just the parent portal. Concretely: the same Tailwind v4 token architecture (`tokens.css`, `data-theme="dark|light"` flip — no hardcoded hex anywhere), the same shadcn/ui component set, the same Motion spring presets, the same typography stack (clean sans for UI, the display face for headings, the bundled Naskh face for RTL), the same emerald/gold palette, arch-topped-card motifs, skeleton shimmer loaders, staggered grid entrances. **Before any UI work, port the theme tokens (`packages/ui/.../lib/theme/tokens.css`), the `lib/motion` presets, and the shadcn setup from OpenMasjidOS into `packages/web`** — same-org AGPL, so unlike external code, copying these within OpenMasjid-Solutions repos is allowed and encouraged (keep the SPDX headers, note the origin in a comment). Keep the ported files structurally identical to upstream so theme fixes can be re-synced. Fabric appearance inherit keeps the look synced at runtime; token parity makes it native even standalone.

**Madrasa-first, localizable, never hardcoded**: terms like *Ustādh/Ustādha*, *Ādāb*, *Mumtāz*, *ḥifẓ* appear as shipped **defaults and i18n strings**, editable per masjid — the code knows "teacher", "merit category", "scale band". The **parent portal is the face of the madrasa** — highest polish bar, phone-first (big tap targets, bottom nav, one-thumb payment flow). **The report card and transcript are the artifacts families keep** — dignified header (school name, term, class + type), clean marks table, the org's geometric restraint, an Arabic-capable face for names, and they must look right printed in black-and-white on a masjid photocopier. Voice: plain and warm for parents (✅ "Your balance is $350" / "Autopay is on — we'll charge your Visa ···4242 when tuition is due" ❌ "off_session PaymentIntent requires_action"), and for staff (the finance manager is a volunteer, not an accountant). Errors: one friendly sentence + what to do next; details to the log.

---

## 16. Coding conventions

Everything in OpenMasjidOS `CLAUDE.md §15` applies (clarity over cleverness; comment the *why*; strict TS; shared types via `AppRouter` type-only import; zod at boundaries; typed friendly tRPC errors; never log secrets). Additions:

- All money math in `billing/ledger.ts`; **one** `ledger.record` used by fabric provider, webhook handler, autopay, and the manual-payment UI. Unit tests: exact pay, partial, overpay→credit, multi-invoice, replayed idempotency key, reversal, and one per channel.
- All Stripe interaction through `payments/stripe.ts`; nothing else imports the SDK. Webhook handlers thin → ledger/mail modules.
- Final-grade math lives in one `grades/final.ts` function (formula weights × scale banding) used by both term close and any preview — never re-derived ad hoc.
- Report Creator datasets are registered in `reporting/registry.ts` only — adding a dataset means adding an entry there (with its minimum role), never inlining queries in the router.
- `/fabric`, `/api/stripe/webhook`, and `/apply` are plain Fastify routes registered before the static UI, excluded from any auth/session middleware but gated by their own checks (secret / signature / rate-limit + zod).
- Every string through i18next; logical-property RTL-safe layouts; migrations forward-only.
- UI tokens/motion presets are the OpenMasjidOS ports (§15), kept structurally identical to upstream so theme fixes re-sync cleanly; any deviation gets a one-line comment saying why.

---

## 17. Build & run commands (keep these working)

```
npm install         # all workspaces
npm run dev         # server + web, hot reload (server :8080; Vite :5173 proxying /trpc, /api, /fabric, /apply)
npm run build       # typecheck + build web and server
npm run lint        # eslint + tsc --noEmit
npm run test        # vitest (ledger, fabric contract, webhook, autopay ladder, origin policy, finals math, dataset registry, admissions input)
npm run image       # build & tag ghcr.io/openmasjid-solutions/openmasjidstudents:dev
```

Dev: `.env` with fake Fabric vars; curl fixtures for `/fabric/billing/*`; **Stripe test mode + `stripe listen --forward-to localhost:8080/api/stripe/webhook`** for the payment paths; a tiny mock of `/api/auth/session` + `/api/fabric/stripe` in `packages/server/test/`. Simulate tunnel origin locally by sending `cf-ray: dev` to exercise the origin policy.

---

## 18. Definition of done (any feature)

Builds via `npm run build`; `tsc` + eslint clean; ledger/contract/webhook/origin tests pass; **role × origin matrix verified for touched routes** (an admin session over simulated tunnel gets 403; a parent token literally cannot fetch another family, an unshared incident, or a staff note — tested, not assumed); works light+dark, LTR+RTL, reduced-motion honored; new/changed screens reviewed side-by-side with the OpenMasjidOS dashboard for token/motion/typography parity (§15); works with Fabric/SMTP/tunnel absent (standalone) and present; payment features tested against Stripe test mode incl. a declined card; report-card generation tested against a full-class fixture (incl. `absent`/`exempt` and a v2 regeneration); transcript generation tested against a multi-term fixture; admissions form tested against hostile input (oversized, scripted, rate-limit); no raw error reaches the user; all strings in i18next; SPDX on every new file; audit entries for every sensitive write touched.

---

## 19. Version control & release policy — how a version actually ships

`VERSION` file at repo root, single source of truth, `MAJOR.MINOR.PATCH`; `1.0.0` reserved for launch. **Current: `0.1.0`.** Default branch: **`main`**.

**The key idea (two repos):** this repo builds and **digest-pins** the Docker image; the catalog repo (`OpenMasjidAPPS`) is what makes a version downloadable — bumping this app's entry in `OpenMasjidAPPS/registry.yaml` triggers its "Build catalog" CI, which regenerates `catalog.json`, which is what every OpenMasjidOS install fetches. **Nothing is "released" until the registry bump lands.**

**Auth pieces (none typed per release):**
1. `gh` CLI's stored token — authenticates pushes and the registry edit.
2. GHCR push = CI's built-in `GITHUB_TOKEN` — the image is pushed by this repo's **"Build image" GitHub Action** (`.github/workflows/build-image.yml`), **never from a laptop**. One-time setup after the first build: set the GHCR package to **Public**.
3. ~~APK signing keystore~~ — **N/A here.** This is a web-only app; the keystore secrets (`SIGNING_KEYSTORE_BASE64` etc.) are Kiosk-specific. Do not add Android/APK steps to this repo.

**The release runbook (every release, in order):**
1. Bump the version **everywhere**: `VERSION`, `manifest.yaml`'s `version:`, root + workspace `package.json`s, and a `CHANGELOG.md` entry. **The server does NOT need editing** — `config.version` reads `packages/server/package.json` at runtime (it was a hand-typed literal until 0.42.1 and drifted two releases, telling every masjid they were on 0.40.0). `packages/server/test/version.test.ts` asserts all of these agree, so a half-finished bump fails CI instead of shipping; the CHANGELOG entry is checked there too, since **What's new** in the app is built from that file.
2. Commit on a branch; validate the build is green (CI on the branch).
3. FF-merge to `main` and push → triggers **"Build image"** → pushes the **multi-arch** (amd64+arm64) image to GHCR.
4. Grab the **`@sha256` digest** from that build and pin it in `docker-compose.yml`'s `image:` line.
5. Commit the pin, `git tag v<version>`, push `main` + the tag. (The tag lands on the **pin commit**, so the catalog serves the pinned compose — that's the point.)
6. Bump `OpenMasjidAPPS/registry.yaml` for `students`: `ref: v<version>` **plus the immutable `commit:` SHA** of that tag. Via PR, or — house standard, since we own the org — a direct commit to its `main` with `gh api -X PUT …/registry.yaml`.
7. That commit runs **"Build catalog"** → `catalog.json` regenerates → the update is live; installs offer **Update**.

The `version:` in the registry entry, `manifest.yaml`, and `VERSION` must agree; the digest pin and the tag must point at the same commit lineage. Commit messages per house style (`chore: bump version to x.y.z`, `chore(release): pin image digest for vx.y.z`).

**Contract versioning is separate**: `students/billing` responses carry `"v": 1`; breaking the shape means `v: 2` + coordinating all four repos — don't do it casually. (Adding the `students-portal` metadata value was additive, not breaking.)

---

## 20. Working agreement for Claude (the coding agent)

- Read this file every session. §3 (licensing), §5 (roles + origin), §9 (data rules), §11 (contract), §12.4 (origin policy), §13 (payments), §14 (security), §15 (UI parity) are **hard constraints**.
- Build **vertically** — one full slice (schema + router + UI + i18n + tests) before the next. Suggested order:
  1. Monorepo skeleton, SQLite+Drizzle boot, Dockerfile, **`.github/workflows/build-image.yml` (multi-arch → GHCR, §19)**, SPDX/CLA scaffolding, `VERSION` + `CHANGELOG.md`.
  2. **Auth**: local users + roles + sessions + first-run; **origin-policy middleware with tests**; SSO fast-path behind env presence.
  3. **People & SIS**: families, students, guardians, emergency contacts + `guardian_users`; then custom fields, documents, notes, incidents.
  4. Terms/classes (types + subjects)/enrollments + teacher assignment + **weekly timetable** (views + conflict warnings) + staff profiles.
  5. Teacher UI: attendance (audited late edits), then gradebook + **scales / final-grade config / gradebook history**.
  6. **Merit points**, **comment bank**.
  7. **Exams & report cards**: admin exam builder (assign classes, subject snapshot + max marks) → teacher score grid with completion tracking → PDF pipeline (`reports/`, one template family, versioned artifacts) → class combined PDF → publish flow.
  8. **Term close → finals → transcripts** (multi-term fixture, batch generation, publish).
  9. **Billing core**: fee plans → invoice generation → ledger/allocation engine (tests first) → manual payments + proof uploads.
  10. Student IDs (auto-generate on registration, per-ID lockout) + printable statement (IDs per child, portal-signup QR).
  11. **Parent portal, read-only slice**: invites/self-register, My-family home, schedule/grades/merit/attendance/report-cards/transcripts/balance/history views.
  12. **Admissions**: pipeline + one-click enroll first (staff-facing), the public `/apply` form last within the slice (it's the hostile surface — land it with its tests).
  13. **Report Creator**: dataset registry (role-scoped) → builder UI → saved reports → CSV/print.
  14. **Fabric provider** `/fabric/billing/*` (contract tests against §11 fixtures) + notifications.
  15. **Pay now** (Elements + webhook intake + receipts) — Stripe test mode end-to-end.
  16. **Saved cards + autopay** (scheduler, retry ladder, disable+notify).
  17. Stripe reconciliation job (§11.4); appearance inherit; tunnel/public-URL hardening; RTL + polish pass.
- Steps 1–13 must not block on the OS work order — the app is fully usable on the LAN: complete SIS, timetable, merit, exams, report cards, transcripts, admissions, custom reports, and manual-payment billing. Steps 14–17 integrate as the OS broker/tunnel land; test with curl fixtures + `cf-ray: dev` meanwhile.
- If a task seems to need card-present hardware, Stripe Billing subscriptions, a constraint-solver scheduler, student logins, or bulk messaging — **stop**: the first two belong elsewhere (§13.3 / Kiosk), the rest are 🔭 deferred by decision.
- Write non-trivial decisions into `docs/DATA_MODEL.md` / `docs/PAYMENTS.md`.

### Open questions to confirm with Hasan before the affected step

1. Exact OS-side names (`tunnel:`, `fabric:`, `OPENMASJID_PUBLIC_URL`) once the OS work order lands — reconcile if the implementation diverges.
2. Default host port (`8360` proposed) — confirm free across the beta masajid.
3. Autopay default trigger: **on due date** (assumed) vs "on invoice generation"; overpay allowance on portal pay-now (assumed: allowed, becomes credit).
4. Parent **self-registration ON by default** (assumed, child’s Student ID + on-file email + email verify) vs invite-only.
5. Gradebook grades visible to parents **immediately on entry** (assumed for v1) vs behind a teacher "publish" step.
6. SMTP: is there a house-preferred provider/relay for the beta masajid, or per-masjid settings only (assumed)?
7. ~~PIN policy~~ — **settled (v0.39.0): no PINs.** Student ID only, with a name-confirmation step and a per-ID lockout (§11.2, §14).
8. The names of the two existing campaign types in OpenMasjidDonations/Kiosk that `tuition` joins (the consumer briefs say "verify in-repo" — confirm the real enum values).
9. Default **madrasa grading scale** bands (`Mumtāz / Jayyid Jiddan / Jayyid / Maqbūl / Rāsib`) and default **merit categories** (Ādāb, Sunnah practice, Hifz milestone, Helping others) — bless or edit the shipped defaults.
10. Report cards: **letter/scale bands shown by default** now that scales exist (assumed yes) — and the optional per-student teacher remark stays (assumed yes)?
11. Admissions `/apply` form: the default field set (guardian name+contact, child name+DOB, program interest) — anything the beta masajid always ask at intake that should ship as a default custom field?
12. Transcripts: terms × classes × final grade is assumed sufficient for the ʿālim course — or do any of the beta madāris need credit-hours / ijāzah-style completion lines on the document in v1?