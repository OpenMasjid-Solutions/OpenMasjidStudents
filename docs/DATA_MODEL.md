<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# DATA_MODEL — schema notes, non-trivial decisions, and the assumptions log

> **Status: stub + living log.** Canonical schema spec is `CLAUDE.md` §9. This file records
> (a) non-trivial modelling decisions as they are made, and (b) the **assumptions log** for the
> §20 open questions — per the working agreement, if a build step touches an open question we ask
> Hasan first; otherwise we proceed with the documented assumption and record it here.

## Tables (per §9 — built incrementally, one vertical slice at a time)

`users`, `sessions`, `invites`, `families`, `students`, `guardians`, `guardian_families`,
`guardian_users`, `emergency_contacts`, `student_field_defs`, `student_field_values`,
`student_documents`, `student_notes`, `incidents`, `terms`, `classes` (+ `type`, `custom_label`),
`class_subjects`, `class_teachers`, `class_sessions`, `enrollments`, `attendance`,
`grading_scales` + `scale_bands`, `class_grade_config`, `grade_items`, `grades`,
`gradebook_snapshots`, `merit_categories` + `merit_awards`, `comment_snippets`, `exams`,
`exam_classes`, `exam_class_subjects`, `exam_scores`, `term_remarks`, `term_finals`,
`report_cards`, `transcripts`, `admissions` (+ `admission_notes`), `saved_reports`, `fee_plans`,
`enrollment_fees`, `invoices`, `invoice_items`, `payments`, `payment_allocations`,
`payment_methods`, `autopay_enrollments`, `autopay_runs`, `stripe_events`, `attachments`,
`audit_log`, `fabric_inbox`, `settings`.

Non-negotiable rules live in §9 (Student IDs unique + always generated; exam subjects are a snapshot;
term finals are frozen; report cards/transcripts immutable + versioned; gradebook snapshots
append-only; money = integer cents; idempotency keys UNIQUE; balances derived; FKs RESTRICT on
money paths). Every table: `id`, `created_at`, `updated_at`.

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
| 7 | PIN policy + name match | **ANSWERED (Hasan, 2026-07-26): no PINs.** Removed in v0.39.0 — the Student ID (`YUS1234`) is the whole credential, because the only thing it authorises is *paying* someone's tuition. Replaced by a name-confirmation step (`identify`) plus a shared per-ID lockout. Contract → **v2**. | done |
| 8 | Existing campaign-type enum values `tuition` joins | **ANSWERED (recon):** enum is `donation \| zakat \| tuition` in BOTH Donations (`server` + `web`) and Kiosk (added v0.9.12). `tuition` ALREADY EXISTS — we mirror it, nothing to add. Type drives the card-fee rule (donation=optional cover, zakat=forced cover, tuition=admin-toggle). | 14 (Fabric provider) |
| 9 | Default madrasa scale + merit categories | Ship the CLAUDE.md defaults (Mumtāz…Rāsib; Ādāb, Sunnah, Hifz milestone, Helping others), admin-editable | 5/6 |
| 10 | Report cards: scale bands + teacher remark | Show scale band by default; keep optional per-student remark | 7 |
| 11 | `/apply` default field set | guardian name+contact, child name+DOB, program interest | 12 (admissions) |
| 12 | Transcripts: terms × classes × final grade | Sufficient for v1 (no credit-hours/GPA) | 8 (transcripts) |

> **Q8 is the one recon must answer.** The real campaign-type enum values in OpenMasjidDonations
> and OpenMasjidKiosk get pasted here once confirmed, so step 14 registers `tuition` alongside them correctly.
