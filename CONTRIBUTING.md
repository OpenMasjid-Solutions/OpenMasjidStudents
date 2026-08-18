<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Contributing to OpenMasjid Students

Thank you for helping build free software for masājid. This document covers how
to contribute **and the licensing terms your contribution is made under** —
please read the licensing section before opening a pull request.

## What this app is

Tuition and fee management for a madrasa, running as a self-hosted
[OpenMasjidOS](https://github.com/OpenMasjid-Solutions/OpenMasjidOS) app: students and households, fee
plans per child, one invoice per child, a derived ledger, and payments by cash or card (parent portal,
autopay, the masjid's donation site and kiosk). **Not** a school-information system — attendance,
gradebooks, report cards, transcripts, timetables and the admissions pipeline were deliberately removed
in v0.35.0 and stay out (`CLAUDE.md` §4). Courses and classes exist only as labels for grouping children.
A pull request that adds academics will be declined however good it is; please open an issue first if you
think that should change.

## Getting it running

```bash
npm install     # all workspaces
npm run dev     # server on :8080, Vite on :5173 proxying /trpc, /api, /fabric, /statements
npm run lint    # tsc --noEmit across both workspaces — there is no eslint here
npm run test    # vitest, both workspaces (~1,070 tests)
npm run build   # typecheck + build both
```

No platform, no tunnel, no Stripe and no mail is a **supported** mode: the app runs standalone on a LAN
with every integration degrading gracefully. You do not need an OpenMasjidOS instance to work on most of
it. For the payment paths, Stripe **test mode** is enough — there is no webhook to forward (`CLAUDE.md`
§13.4). To exercise the origin policy locally, send a `cf-ray: dev` header, which the app classifies as
arriving over the tunnel.

**Test on Linux.** The app ships as a Linux container and CI runs on Ubuntu; a Windows run exercises
win32 native binaries (better-sqlite3, argon2) that never ship. If you develop on Windows, run the tests
in a WSL2 clone on ext4 — never `npm ci` against `/mnt/c`, which overwrites the Windows `node_modules`
and leaves the two thrashing each other.

## How to contribute

1. Open an issue describing the change (bug or feature) before large work, so we
   can agree on the approach. This app handles **children's records, moves money,
   and is internet-facing** — read `CLAUDE.md` §14 (security invariants) and §5
   (roles + origin policy) before touching anything sensitive.
2. Fork, branch, and keep commits small with [Conventional Commit](https://www.conventionalcommits.org/)
   messages (`feat:`, `fix:`, `docs:`, `chore:` …). **No AI co-author trailers.**
3. Before pushing: `npm run build` and `npm run test` must pass, `tsc` must be clean, and the change
   must work in **both** light/dark themes and **both** LTR/RTL, honour `prefers-reduced-motion`, look
   right at phone width, and keep the role × origin matrix intact (an admin session over the tunnel must
   still get 403; a parent must not be able to fetch another household). New user-facing strings go
   through i18next. See `CLAUDE.md` §18 for the full Definition of Done.
4. Open a pull request. Every source file carries an SPDX header
   (`// SPDX-License-Identifier: AGPL-3.0-only`) — keep it on new files, never
   strip an existing one.

## House rules worth knowing before you write code

These are the conventions that come up in review most often. `CLAUDE.md` is the long version and is the
authority; this is the short list.

- **Money is integer cents, and all of it goes through `billing/ledger.ts`.** Balances are *derived*
  (`invoiced − paid`), never stored. Payments are immutable — a correction is a reversal row, never an
  edit. If you find yourself doing arithmetic on money outside the ledger, that is the review comment.
- **One place decides a rule.** What a bill is made of (`billing/lines.ts`), who hears about an event
  (`alerts/index.ts`), what a date is (`settings/dates.ts`), how a username matches
  (`auth/usernames.ts`), which school a request may see (`schools/index.ts`), what a saved payment method
  is (`payments/methods.ts`), and the only file that may import the Stripe SDK (`payments/stripe.ts`).
  Two places implementing the same rule is the recurring shape of this codebase's real bugs, so a fix
  goes where the rule lives — not where the symptom appeared.
- **Validate at the boundary.** zod on every tRPC input and every Fabric request. Dates especially: a
  date column is compared as text, so a non-ISO value is a silent permanent fault rather than an error.
- **Never log PII.** Ids, codes, counts and event names only — never a name beside an amount, never a
  Student ID, never a request body.
- **Comment the *why*.** The code here explains its reasoning, sometimes at length, because most of these
  decisions have a specific failure behind them. A comment that restates the code adds nothing; one that
  says what went wrong before saves the next person the same afternoon.
- **A non-obvious fix ships with a test that fails without it.** Delete your fix, watch the test go red,
  put it back. A guard that passes vacuously is worse than no guard.
- **Migrations are forward-only** and committed, with `--> statement-breakpoint` between statements and an
  entry in `drizzle/meta/_journal.json`.

## Where things live

| Area | Start here |
| --- | --- |
| Roles, sessions, the LAN-only admin rule | `packages/server/src/trpc/trpc.ts`, `security/origin.ts` |
| Money: invoices, allocation, balances | `packages/server/src/billing/` |
| Stripe: pay-now, autopay, refunds, reconciliation | `packages/server/src/payments/` |
| The Fabric capability other apps consume | `packages/server/src/fabric/provider.ts` + `docs/FABRIC_BILLING_CONTRACT.md` |
| Students, households, guardians, import | `packages/server/src/people/` |
| Schools, years, terms, courses, classes | `packages/server/src/structure/`, `schools/` |
| Printed statements, sheets, invoices | `packages/server/src/billing/statements.ts`, `people/onboardingSheet.ts` |
| The three UIs | `packages/web/src/routes/{admin,billing,family}/` |
| Security history: what was audited and what is open | `docs/audit/` |

## Reporting a security issue

Please **do not** open a public issue for a vulnerability. This app holds records about children and
payment history for real families. Email the maintainer (see the repo's profile) with what you found and
how to reproduce it, and give us a chance to ship a fix before disclosure. Past audits and their
remediation live in `docs/audit/`, so you can see how findings have been handled.

## Licensing of your contributions (please read)

OpenMasjid Students is published under the **GNU Affero General Public License
v3.0 (AGPL-3.0-only)** — see [`LICENSE`](./LICENSE) — and contributions are
governed by the **OpenMasjid Contributor License Agreement** — see
[`CLA.md`](./CLA.md), the canonical legal text. The summary below is for
convenience; the CLA controls.

**1. Inbound license + Developer Certificate of Origin.** You contribute under
the same AGPL-3.0-only as the project, and by submitting a contribution you
certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/)
(you wrote it, or have the right to submit it). Sign off each commit:

    git commit -s -m "feat: ..."

which adds a `Signed-off-by: Your Name <you@example.com>` trailer.

**2. Copyright-license grant for relicensing.** So that the project can be
sustained — including by offering **commercial / proprietary licenses** to
organisations that cannot accept AGPL terms — you additionally grant
**OpenMasjid-Solutions** a **perpetual, worldwide, non-exclusive, royalty-free,
irrevocable** license to use, reproduce, modify, prepare derivative works of,
publicly display and perform, sublicense, and **distribute your contribution and
derivative works under any license terms, including terms different from
AGPL-3.0 (e.g. a commercial/proprietary license)**.

You retain copyright in your contribution; this grant is a license, not an
assignment, and does **not** restrict your own use of your contribution.

The public tree stays AGPL-3.0 — this grant only lets the maintainer offer
**additional** commercial licenses (dual licensing). It does not let anyone take
the public AGPL code proprietary.

**3. Patents.** You grant the project and its users a license to any patents you
hold that are necessarily infringed by your contribution, on the same terms as
above.

### Signing the CLA

You sign the CLA **once**, automatically, on your first pull request: the CLA
bot comments with a link to [`CLA.md`](./CLA.md) and asks you to reply with the
exact sentence

> I have read the CLA Document and I hereby sign the CLA

Your signature is recorded under `signatures/` and future PRs are recognised
automatically.

If you cannot agree to the relicensing grant in §2 of the CLA, you may still
contribute **under AGPL-3.0 only** — say so explicitly in your PR, and we will
either accept it AGPL-only or discuss an alternative. Contributions without a
clear statement, once the CLA is signed, are taken to be under the terms above.
