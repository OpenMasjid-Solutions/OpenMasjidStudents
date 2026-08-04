<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Remediation — what shipped

**Branch:** `audit/security-2026-08-04` · **Base:** `66b75e9` (`main`, v0.44.0) · **Rollback tag:** `pre-audit-2026-08-04`

**Not merged to `main` by me.** Pushing to `main` triggers `build-image.yml`, which pushes a multi-arch image to GHCR tagged both `:0.44.0` and `:latest` — a published artifact, and it would move the `:0.44.0` tag off the code actually released as v0.44.0. That is the one condition that overrides the instruction to push, so this is a PR.

---

## Read this first — Tier 2 changes (behaviour-visible)

### 1. Changing a password now signs you out on your other devices — `c944290` [OMS-005]

**What a user will notice.** Someone with the portal open on a phone and a laptop who changes their password on one is now signed out on the other. Previously both stayed live for up to 12 hours.

**Why it's right.** `resetConfirm` has always ended every session for the account. `changePassword` is the same gesture reached from inside the app, and it is the *only* revocation a user can perform — there is no session list and no "sign out everywhere" button. A parent who signed in on a borrowed phone and later changed their password from home precisely because they were worried was leaving that cookie working.

**Where to look if something feels off in the next few days:** unexpected sign-outs after a password change, especially for staff who keep the admin UI open on two machines. The caller's own session is deliberately spared, so the tab you change it in keeps working.

### 2. A mismatched `currency` on `record-payment` now logs a warning — `28824ac` [OMS-015]

**What changes:** one `WARN fabric:` line when a Fabric consumer sends a currency that isn't the school's. **No behaviour change on the money path** — the payment is still recorded exactly as before, deliberately (see the finding). If Donations or Kiosk send a currency at all, expect log noise; that noise *is* the finding.

Nothing else in this batch alters an API response, a schema, or user-visible behaviour. **There are no database migrations in this run**, so there is no reverse migration to supply.

---

## Fixed and shipped

| Finding | Severity | Commit | One line |
|---|---|---|---|
| [OMS-001] | Medium | `bf541c8` | Removed unused `nodemailer` (8 HIGH advisories), `@react-pdf/renderer`, `react` from the server |
| [OMS-004] | Medium | `bed8d2e` | `reallocateStudent` no longer scans the whole `payment_allocations` table |
| [OMS-006] | Medium | `a21b766` | Release workflow's 5 Actions pinned to commit SHAs |
| [OMS-016] | Medium | `1e278a5` | Added CI that runs lint + test + build |
| [OMS-011] | Low | `4368e3d` | Logo escaped in the statement HTML |
| [OMS-012] | Low | `4368e3d` | CSP + `nosniff` + `no-referrer` on the statement route |
| [OMS-014] | Low | `fd5d200` | Invite acceptance redirects through `withBase` |
| [OMS-015] | Low | `28824ac` | Currency mismatch surfaced (safe half only) |
| [OMS-022] | Low | `80d5f44` | 5 patch-level transitive dependency bumps |
| [OMS-017] | Info | `3f530cd` | Corrected `cla.yml`'s false branch-protection claim |
| [OMS-008] | Info | `a106291` | **Fix reverted** — disclosure is deliberate; see below |

Plus `5a758e9` (the audit report) and `a106291` (the OMS-008 correction). Eleven commits, each individually revertable.

---

## Per-finding detail

### OMS-001 — unused `nodemailer` in the production image — `bf541c8`

**Changed:** removed `nodemailer`, `@types/nodemailer`, `@react-pdf/renderer`, and `react` from `packages/server/package.json`. Corrected the `vitest.config.ts` comment that justified its timeout by the (removed) PDF renderer.

**Why it works:** the modules were never imported, so nothing can load them. Email has gone through `POST {OS}/api/fabric/email` since SMTP was removed — `mail/notify.ts:62`'s `deliver()` is the only send path. Proven exhaustively before touching anything:

```
$ grep -rni "nodemailer" packages/ --include=*.ts --include=*.tsx --include=*.json
packages/server/package.json:27:    "nodemailer": "^6.10.1",
packages/server/package.json:36:    "@types/nodemailer": "^6.4.24",

$ grep -rn "from 'react'\|require('react')" packages/server/src
(no output)
```

Two declarations, zero imports. `npm ci --omit=dev` was installing all of it into the runtime image.

**Verified:**
```
$ npm run lint      → exit 0 (both workspaces)
$ npm run test      → 45 files / 455 tests passed · 4 files / 44 tests passed
$ npm run build     → exit 0
$ ls node_modules/nodemailer node_modules/@react-pdf/renderer
nodemailer removed
@react-pdf/renderer removed
```
Audit count: **15 → 14**, high **7 → 6**.

---

### OMS-004 — full-table scan on every money write — `bed8d2e`

**Changed:** `billing/ledger.ts` — the allocation-clearing read is now `inArray(paymentAllocations.paymentId, liveIdList)` instead of an unfiltered `.all()` with a JS filter. Empty-set case short-circuited.

**Why it works:** the old code selected every row and dropped all but the target's on the next line, so >99% of the read was waste and the index (`payment_allocations_payment_idx`, already in the schema) could not be used. The predicate names exactly the payments the JS filter kept, so the selected set is identical by construction — and now it's an index seek. This matters because `generatePeriod` calls `reallocateStudent` once *per student*, making the nightly 02:00 run cost *students × all-allocations-ever* on a Raspberry Pi.

**Verified — and I checked the test has teeth.** Added `test/reallocateScope.test.ts` (4 tests). Because the old code was behaviourally *correct* (just slow), this is not a fails-before/passes-after case; instead the test pins the invariant that makes SQL scoping safe. To prove it isn't vacuous I widened the predicate back to the whole table:

```
$ # with the predicate removed (the dangerous mistake this guards against):
 × leaves another student's allocation rows byte-identical
   → expected [] to deeply equal [ { …(4) } ]
 × does not disturb a reversal pair belonging to another student
   → expected [] to deeply equal [ { …(4) }, { …(4) } ]
 Tests  2 failed | 2 passed (4)

$ # with the fix in place:
 ✓ test/reallocateScope.test.ts (4 tests) 577ms
 ✓ test/ledger.test.ts (22 tests) 630ms
 ✓ test/payLines.test.ts (7 tests) 611ms
 ✓ test/allocationInvariants.test.ts (5 tests) 4342ms
 Tests  38 passed (38)
```

The test compares **row ids**, not totals — a delete-and-rebuild would produce equal sums with fresh ids and hide the bug.

---

### OMS-006 — Actions pinned to mutable tags — `a21b766`

**Changed:** all five actions in `build-image.yml` now reference full commit SHAs, with the resolved version in a trailing comment.

**Why it works:** a tag is mutable and every step in that job holds `packages: write` plus a GHCR-scoped `GITHUB_TOKEN`. A SHA is immutable, so a repointed tag can no longer change what runs. Pinned to the SHAs the tags resolved to *today*, so behaviour is byte-for-byte what the last green run used — immutability only, no version change.

```
actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
docker/setup-qemu-action@c7c53464625b32c7a7e944ae62b3e17d2b600130 # v3.7.0
docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f # v3.12.0
docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9 # v3.7.0
docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8 # v6.19.2
```

Each SHA was resolved from the GitHub API (`repos/<a>/git/ref/tags/<t>`, dereferencing annotated tags) and mapped back to an exact release tag — not guessed.

**Verified** — both workflows parse and every action reference matches `/@[0-9a-f]{40}/`:
```
.github/workflows/build-image.yml -> parsed OK (7 steps)
   [SHA]  actions/checkout@11d5960a326750d5838078e36cf38b85af677262
   [SHA]  docker/setup-qemu-action@c7c53464625b32c7a7e944ae62b3e17d2b600130
   [SHA]  docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f
   [SHA]  docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9
   [SHA]  docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8
.github/workflows/cla.yml -> parsed OK (1 steps)
   [SHA]  contributor-assistant/github-action@ca4a40a7d1004f18d9960b404b97e5f30a505a08
```

I did **not** also upgrade to the newer majors available (checkout v7, docker/* v4). That is a behaviour change I cannot verify here, since `build-image.yml` only runs on pushes to `main`.

---

### OMS-016 — no CI ran the tests — `1e278a5`

**Changed:** added `.github/workflows/ci.yml` — `npm ci` → `npm run lint` → `npm run test` → `npm run build`, on pushes to `main` and all pull requests. `permissions: contents: read`, no secrets, `concurrency` cancel-in-progress, Actions SHA-pinned.

**Why it works:** it makes the 499 existing tests load-bearing for the first time. It also retroactively makes two CLAUDE.md claims true: `version.test.ts` really will fail a half-finished version bump, and `test/alerts.test.ts` really will fail an alert id missing from the manifest. §9 records what that cost before — `payment-short` was raisable in code but undeclared for all of 0.43.0, so every such alert was answered `400 Unknown alert` and dropped, and the guard test written afterwards guarded nothing.

`permissions: contents: read` with no secrets is deliberate and load-bearing: the workflow triggers on `pull_request`, so it executes fork code and must never be able to publish.

**Verified by running the exact sequence locally from a clean `npm ci`:**
```
$ npm ci                                    → NPM_CI_EXIT=0
$ npm run lint                              → lint: PASS
$ npm run test                              → 46 files / 459 tests passed · 4 files / 44 tests passed
$ npm run build                             → build: PASS
```
The `npm ci` exit 0 matters twice over: it's what CI runs, and it proves the lockfile is in sync after the OMS-001 removal. YAML parse checked:
```
name: CI
triggers: {"push":{"branches":["main"]},"pull_request":null}
permissions: {"contents":"read"}
job: verify
  step: Install -> npm ci ·  Typecheck -> npm run lint ·  Test -> npm run test ·  Build -> npm run build
```

**Known limitation, stated in the workflow itself:** this does not yet *block* a bad release. GitHub does not order independent workflows, so a red `verify` does not stop `build-image` from publishing. Gating needs a branch-protection rule requiring the `verify` check — admin-only, in `ACTION_REQUIRED.md`.

---

### OMS-011 + OMS-012 — statement escaping and response hardening — `4368e3d`

**Changed:** `esc()` around the logo data URI in `billing/statements.ts`; `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer` on the route in `billing/statementRoutes.ts`.

**Why the escaping works:** `esc()` is a no-op over the logo's permitted alphabet (the validating regex allows no quote or angle bracket), so rendering is byte-identical today. The value is *why* it wasn't exploitable, not why it was safe to skip — correctness rested on a regex two modules away with no local signal, and this removes that coupling.

**Why the CSP works, and its honest limit:** `'unsafe-inline'` is allowed for style and script, so the policy cannot block injected inline script. What it does block is every *external* load — `default-src 'none'` means an injected `<img src="https://attacker/?…">` never fires, so there is no channel to exfiltrate a page full of Student IDs and payment history — plus framing, form posts, and `<base>` hijack. `img-src data:` keeps the inlined logo and the generated QR working. I chose this over a nonce policy because it cannot regress rendering, which mattered: the route had no HTTP-level coverage before this commit. The nonce upgrade is in `ACTION_REQUIRED.md`.

**Verified.** Added `test/statementRoute.test.ts` — 9 tests through a real Fastify instance with `inject`, the first HTTP-level coverage of anything in the boot path. It covers the self-gating access wall no procedure test could reach:

```
$ # with the three headers removed:
 × sets a CSP that blocks external loads, framing and form posts
 × sets nosniff, no-referrer, and no-store
 Tests  2 failed | 7 passed (9)

$ # with them in place:
 ✓ test/statementRoute.test.ts (9 tests) 735ms
 Tests  9 passed (9)
```

Also asserted: admin on LAN and finance from either origin → 200; an admin cookie presented over the tunnel → 403 with no Student ID in the refusal; parent, no session, and a bogus token → 403; unknown family → 404; a hostile student name and a parent-typed kiosk memo both come back escaped.

Full suite after: **48 files / 473 server tests + 4 files / 44 web tests**, lint exit 0.

---

### OMS-014 — invite acceptance left the app — `fd5d200`

**Changed:** `window.location.assign('/')` → `window.location.assign(withBase('/'))` in `web/routes/InviteAccept.tsx`.

**Why it works:** `withBase` prefixes the OS tunnel mount path, which every other navigation in the app already used — this was the only literal navigation path and the only `location.assign` in the codebase. An invite link is opened over the tunnel by definition (`sendInvite` refuses to send without an absolute public URL), where the app lives under a prefix like `/students`. The bare `/` dropped the parent on the OS dashboard root — and since the session cookie's `Path` is scoped to that same prefix, on a page the cookie isn't even sent to. A blank screen immediately after a successful signup, on the primary parent onboarding path.

**Verified.** Added `web/src/lib/base.test.ts` — 8 tests pinning `withBase`/`stripBase`, including `withBase('/') === '/students/'`, the exact call this fix makes, plus that `stripBase` doesn't chop a prefix-*like* segment (`/studentsomething`).

```
$ npx vitest run src/lib/base.test.ts
 ✓ src/lib/base.test.ts (8 tests) 14ms
$ npm run lint  → exit 0
$ npm run test  → 48 files / 473 passed · 5 files / 52 passed
$ npm run build → build: PASS
```

It pins the helper rather than the screen because this workspace has **no component-test infrastructure** (no jsdom, no testing-library) — adding either for a one-line redirect would be a larger change than the fix.

---

### OMS-015 — currency accepted and ignored — `28824ac`

**Changed:** `fabric/provider.ts` logs a warning when a consumer's `currency` differs from the school's. Added the module's first logger. **The payment is still recorded exactly as before.**

**Why only this half:** changing the response would change a wire contract four repos share (Tier 3). It would also be wrong: Stripe has already taken the card by the time this handler runs, so a 422 would strand a real charge and send a consumer outbox into a permanent deterministic retry. Money is never refused over a label. The contract-side resolution is in `ACTION_REQUIRED.md` → Cross-repo.

**Verified.** Two tests in `fabric.test.ts` pin the guarantee that matters — the money still lands:
```
 ✓ records the money even when the currency does not match, and says so in the log
    (200, recorded:true, balance 5000 → 2000, warning matched)
 ✓ says nothing when the currency matches   ('USD' vs usd is not a mismatch)
 Tests  19 passed (19)
```
Full suite: 48 files / 475 server + 5 files / 52 web. Lint exit 0.

---

### OMS-022 — transitive dependency bumps — `80d5f44`

**Changed:** `npm audit fix`, which here is five patch bumps and nothing else — verified by `--dry-run` first (`added: 0, removed: 0, changed: 5`, no majors):

```
postcss         8.5.19 → 8.5.25   moderate  sourceMappingURL arbitrary .map read
find-my-way      9.6.0 → 9.7.0    high      HTTP/2 DoS  (Fastify's router)
fast-uri         3.1.3 → 3.1.5    high      host confusion via backslash authority
fast-uri         4.1.0 → 4.1.2    high      same, under fast-json-stringify
brace-expansion  5.0.7 → 5.0.9    high      unbounded expansion OOM
```

`find-my-way` is the only one touching runtime behaviour, and it is covered — the fabric provider tests and the new statement-route tests both drive real Fastify routing.

**Verified from a clean `npm ci`:** exit 0, lint PASS, 475 + 52 tests passing, build PASS.

---

### OMS-008 — fix shipped, then reverted — `a106291`

I rated this Low and gated `setupRequired` to LAN origin. **I then reverted it**, because [`App.tsx:126`](../../packages/web/src/App.tsx#L126) reads the flag together with the origin to render `SetupOnLanNotice` — a purpose-built component with dedicated i18n copy ("*Set up the admin account from a device on the masjid's own Wi-Fi — for safety, the first admin can't be created over the internet*"). My change would have replaced that with a generic login form on a fresh install: no accounts to sign in with, no explanation.

The disclosed bit is unactionable — `setup` refuses every non-LAN origin at the top of the handler. Trading it for a first-run screen that explains itself is the better call, and it was made deliberately. **Behaviour is identical to v0.44.0.** The commit adds only a comment recording that this was reviewed and kept, so the next reader doesn't repeat my mistake, and downgrades the finding to Info.

---

## Deferred, and why

Each of these is a real finding I chose not to ship. In every case the reason is that I could not verify the fix, or the fix would break something, or the correct behaviour is a judgement call that is yours.

| Finding | Severity | Why deferred |
|---|---|---|
| **OMS-007** container runs as root | Medium | `docker-compose.yml` uses a **named volume**, whose ownership Docker seeds from the image only on first creation. Every deployed masjid has a root-owned volume, so adding `USER node` means the app cannot open `students.db` — **every existing install fails to boot on update.** The correct fix chowns `/data` then drops privileges via `gosu`/`setpriv`, which I could not verify against a real root-owned volume in this run. Already mitigated by `cap_drop: ALL` + `no-new-privileges`. |
| **OMS-002** `@fastify/static` 4 HIGH | Low | Verified **unreachable** in this configuration — three advisories are route-guard bypasses and there is no guard on the static mount; the fourth needs directory listing, which is off. The fix is a **two-major** jump (8.3.0 → 10.1.2) to the layer serving every page, and OMS-018 means that layer has no HTTP-level test coverage. Trading a real risk for a theoretical one. |
| **OMS-003** `drizzle-orm` identifier SQLi | Low | Verified **unreachable** — I enumerated all 11 raw `sql` usages; no user input reaches an identifier position, and the only dynamic column selection filters against a hard-coded allow-list. 0.38.3 → 0.45.2 is a major ORM bump across 31 migrations and every money query; it needs its own branch with a migration replay. |
| **vitest 2.1.9 (1 critical) + vite/esbuild/drizzle-kit** | — | **Dev-only — none of it ships in the image.** vitest 2 → 4 is a major bump with real config/API breaks, risking the entire suite that everything else here was verified against. |
| **OMS-009** base image not digest-pinned | Low | A multi-arch pin must reference the manifest-list digest or the arm64 build breaks, and this run cannot validate a buildx multi-arch build (CI only runs on `main`, which the veto forbids). Pinning wrong breaks the release pipeline for a reproducibility gain. |
| **OMS-010** login throttled per-IP only | Low | **Genuinely ambiguous, so not guessed.** A per-account lockout is a DoS primitive against a named user — anyone knowing the admin's username could lock out the one person who can fix it, and admin login is LAN-only. Options in `ACTION_REQUIRED.md`. |
| **OMS-021** dates rendered in UTC | Low | Needs a masjid-configurable timezone applied to rendering, `todayIso()`, **and** period derivation. That changes which day a cron run attributes work to and which month a bill lands in — real billing consequences, not a sweep-sized change. |
| **OMS-017** CLAUDE.md / `docs/PAYMENTS.md` drift | Info | Fixed the comments in files I touched. Rewriting §5's permission matrix and §13.4's webhook section is authoring a specification, which is yours. |
| **OMS-018** no HTTP-layer tests | Info | Partially addressed — `statementRoute.test.ts` is the first such coverage. Full coverage of `index.ts` is a project, not an audit fix. |
| **OMS-019** RTL/Arabic is plumbing only | Info | Not a defect; the code is deliberately and correctly English-only. Documentation claim only. |
| **OMS-020** `externalRef` unbounded | Info | Tightening an accepted request shape is contract-adjacent; belongs with OMS-015's cross-repo item. |

---

## Before / after

| | Before (`66b75e9`) | After (`3f530cd`) |
|---|---|---|
| `npm run lint` | exit 0 | exit 0 |
| Server tests | 45 files / **455** | 48 files / **475** |
| Web tests | 4 files / **44** | 5 files / **52** |
| **Total tests** | **499** | **527** (+28) |
| `npm run build` | exit 0 | exit 0 |
| `npm ci` | exit 0 | exit 0 |
| `npm audit` | **15** (1 crit, 7 high, 7 mod) | **10** (1 crit, 3 high, 6 mod) |
| Actions on mutable tags | 5 of 6 | **0 of 6** |
| CI running tests | **none** | lint + test + build |

Remaining 10 advisories, all deliberately deferred and documented: `@fastify/static`, `drizzle-orm` (both HIGH, both verified unreachable), and the dev-only `vitest`/`@vitest/mocker`/`vite`/`vite-node`/`esbuild`/`@esbuild-kit/*`/`drizzle-kit` chain, none of which ships in the image.

**Ship gate:** build ✅ · tests ✅ (527, no regressions — strictly above the 499 baseline) · lint/typecheck ✅ · every shipped fix verified ✅. Nothing unverified was shipped.

---

## Rollback

### Revert one fix

Safe in any order; each commit is self-contained. Re-run `npm run test` after any revert that touches `package.json` or `package-lock.json` (add `npm install` first).

```bash
git revert 3f530cd   # OMS-017  cla.yml comment
git revert 80d5f44   # OMS-022  transitive dependency bumps  (then: npm install)
git revert 28824ac   # OMS-015  currency warning
git revert fd5d200   # OMS-014  invite redirect through withBase
git revert 4368e3d   # OMS-011 + OMS-012  statement escaping + CSP headers
git revert a106291   # OMS-008  comment only (no behaviour to restore)
git revert c944290   # OMS-005  ← the Tier 2 one: restores sessions surviving a password change
git revert 1e278a5   # OMS-016  removes the CI workflow
git revert a21b766   # OMS-006  un-pins the Actions
git revert bed8d2e   # OMS-004  restores the full-table scan  (then: npm install)
git revert bf541c8   # OMS-001  restores nodemailer/react-pdf/react  (then: npm install)
```

**Most likely single revert you'd want:** `git revert c944290` — the only change a user can feel.

### Revert the whole run

```bash
# On the audit branch, keeping history (preferred):
git revert --no-commit bf541c8..3f530cd && git commit -m "Revert the 2026-08-04 audit batch"
npm install && npm run test

# Or simply don't merge the PR — nothing has reached main.

# If it HAS been merged and you want main back exactly as it was:
git checkout main
git revert -m 1 <merge-commit-sha>       # never force-push
npm install && npm run test

# Verify you are back at the pre-audit state:
git diff pre-audit-2026-08-04 --stat     # expect: no output
```

`pre-audit-2026-08-04` → `66b75e9ad778c4057424a3d7de7541c99ab54a77`. This tag is local unless pushed; `git push origin pre-audit-2026-08-04` is safe — it does not match the `v*` pattern that triggers an image build.

**No database migrations were added**, so no reverse migration is needed and no rollback can lose data.
