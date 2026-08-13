<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Action required — only you can do these

From the 2026-08-04 audit. Everything here is outside what I can safely or legitimately do myself: it needs repo-admin rights, a decision that is yours, or a change in a sibling repo.

> **Update, 2026-08-13** (see [`AUDIT-2026-08-13.md`](./AUDIT-2026-08-13.md)). Two items below are now
> **closed**, both of which were waiting on a decision:
>
> - **§5.2 [OMS-010] login throttling** — done as **(b) + a bounded lockout**: a per-account cap of 25
>   failures in 15 minutes *and* the per-account alert this document recommended. The denial-of-service
>   objection is answered by the numbers rather than dismissed, and the reasoning is now in the code where the
>   next person will find it. §14 no longer reads as unmet.
> - **§5.4 [OMS-017] documentation drift** — `CLAUDE.md` §4/§5/§6/§7/§8/§9/§10/§13.4/§17/§18/§20 rewritten
>   against the code, `docs/PAYMENTS.md` rewritten (it led with a webhook that does not exist),
>   `CONTRIBUTING.md` brought up to date.
>
> Everything else here still stands, including §5.3 (timezone) and §5.5 (HTTP-layer coverage, nonce CSP).

---

## 0. First, the thing to do today

**Merge the PR yourself, and watch CI.** I did not push to `main` because doing so publishes a Docker image to GHCR (`:0.44.0` and `:latest`) with no verification — see the pre-flight veto in `REMEDIATION.md`. When you merge:

1. The new `CI` workflow runs (lint + test + build). It should be green — I ran that exact sequence from a clean `npm ci`.
2. `Build image` also runs, because the changes touch `packages/**`. **It will rebuild and re-push `:0.44.0` and `:latest`.** That is expected for any code change to `main`, but it means the `:0.44.0` tag will no longer be the code released as v0.44.0. Existing installs pull by `@sha256` digest, so they are unaffected — but if you care about that tag's meaning, cut **v0.45.0** with these fixes instead of merging onto the released version.

**If CI on `main` goes red:** `git revert -m 1 <merge-sha>` and push the revert. Never force-push.

---

## 1. Credentials to rotate

**Nothing found. Nothing to rotate.**

I searched the working tree and the full git history across all branches for `sk_live`, `sk_test`, `rk_live`, `whsec_`, `AKIA`, `ghp_`, `github_pat_`, and PEM private-key headers. Every hit is a test fixture (`sk_test_x`, `whsec_testsecret`) in files that were later deleted, or a prefix-validation literal (`.startsWith('whsec_')`). No live credential has ever been committed.

This is a genuinely good result and it is architectural, not luck:

- Stripe secret keys are fetched from the OS vault per boot and held **in process memory only** — never written to the database, never logged, and cleared on any reload failure so a failed account switch cannot keep charging the old account.
- The app holds **no mail credentials at all** — the platform owns the provider and the From address.
- `OPENMASJID_APP_SECRET` is read from the environment every process start and never persisted to `/data`.

**One thing to be aware of rather than rotate:** `/data` holds `students.db`, which contains minors' names and dates of birth, guardian contact details, and the complete payment ledger — plus automatic snapshots every 30 minutes. **The file is itself a secret.** Anywhere you copy a backup inherits that. Worth confirming your masjid backup destinations are access-controlled and, ideally, encrypted at rest.

---

## 2. The git-history decision

**No action needed.** History is clean of secrets, so there is nothing to rewrite. Do **not** run `filter-repo` or BFG on this repo — there is no reason to, and it would break every existing clone and every digest-pinned release tag for no benefit.

---

## 3. Cross-repo — changes needed in sibling repos

### 3.1 `students/billing` contract: `currency` on `record-payment` — **decision needed**

**Repos:** this one (provider) · `OpenMasjidDonations` · `OpenMasjidKiosk` · `OpenMasjidOS` (broker/docs)

`POST /fabric/billing/record-payment` has accepted `currency` since contract v1 and this app has never read it. Amounts are stored as integer cents and rendered in the school's own currency, so a consumer sending `"eur"` against a `usd` install has EUR 150.00 recorded as $150.00 — the same integer, different money, with nothing on any screen to indicate it.

**Shipped here (the safe half):** the mismatch is now logged (`WARN fabric: record-payment currency does not match this school`). **The payment is still recorded**, deliberately — Stripe has already captured the card by the time this handler runs, so a 422 would strand a real charge and send a consumer outbox into a permanent deterministic retry.

**Your call, one of:**

- **(a) Confirm the consumers already read `currency` from `/fabric/billing/info` and pass it through unchanged.** Then a mismatch is impossible in practice, the warning is a pure canary, and nothing further is needed. *Check this first — it is probably the answer.*
- **(b) Drop the field in a v3 contract.** Cleanest: it has never meant anything. Needs a coordinated bump across all four repos.
- **(c) Reject a mismatch with `422 invalid_allocation`.** Only safe once both consumers are known to send the right value, or you accept stranded charges from an out-of-date consumer.

Related, same coordination: **`externalRef` is `z.record(z.unknown())`** — unbounded key count, depth, and size, capped only by the 1 MiB body limit, and persisted as JSON on the immutable `payments` row. The contract only ever needs four keys (`stripePaymentIntentId`, `stripeChargeId`, `stripeAccountId`, `via`). Narrowing it is a request-shape change, so it belongs in the same conversation. [OMS-020]

### 3.2 OpenMasjidOS: chown the app's data volume during an update — enables [OMS-007]

Needed only if you take option (a) above. When updating an app whose new image runs as a non-root user, the OS is the only component positioned to fix volume ownership: it has the Docker socket, it knows the volume name, and it already stops and recreates the container. The app itself cannot — `cap_drop: ALL` denies uid 0 `CAP_CHOWN` (proved above).

Roughly: before starting the new container, if the image declares a non-root `Config.User` and the data volume's root is owned by uid 0, run `chown -R <uid>:<gid>` over it once. Verified remedy for this app:

```bash
docker run --rm -v omos-students_data:/data alpine:3 chown -R 1000:1000 /data
```

Without it, `students` would come up with `SQLITE_READONLY` on every existing install. Worth raising in the OS audit as a general platform capability rather than a students-specific patch — every app that ever wants to stop running as root hits this same wall.

### 3.3 Verify consumers call `identify` before `lookup`

Not a change here, a **verification there.** The name-confirmation step is what replaced the PIN in contract v2 — a parent who mistypes an ID is supposed to see a stranger's first name and stop, *before* any balance appears. A consumer that skips straight to `lookup` silently removes that control and turns a mistyped ID into someone else's balance on screen. I could not check this from inside this repo. Confirm both `OpenMasjidDonations` and `OpenMasjidKiosk` call `identify` first and require an explicit confirmation.

### 3.4 Confirm the per-caller lookup rate limit exists in the broker

§14 places throttling at three layers: per-IP in the consumers, **per-caller in the OS broker**, and per-ID here (which I verified — 6 failures/hour, shared across `identify`, `lookup`, and self-registration). Since a Student ID is `ABC1234`, roughly 10k guesses per name prefix, the per-ID lockout is the load-bearing control, but it means a sweep across *many* IDs is only bounded by the broker. Worth confirming that layer is real in `OpenMasjidOS`.

---

## 4. Repo settings — admin only

### 4.1 Protect `main` and require the `verify` check — **highest-value item here**

`main` is currently **unprotected**: `GET /repos/OpenMasjid-Solutions/OpenMasjidStudents/branches/main/protection` returns `404 Branch not protected`. Anyone with write access can push directly, and nothing requires a check to pass first. (A stale comment in `cla.yml` asserted the opposite; I corrected it.)

This matters more here than in a normal repo, because **a push to `main` publishes the artifact masajid install.** The new CI workflow does not fix that on its own — GitHub does not order independent workflows, so a red `verify` does not stop `build-image` from pushing.

```bash
gh api -X PUT repos/OpenMasjid-Solutions/OpenMasjidStudents/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["verify", "cla"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

`enforce_admins: false` keeps your own solo-maintainer workflow unblocked; `required_pull_request_reviews: null` avoids requiring a second reviewer you do not have. The value is the two required checks plus no force-push and no deletion. Note that adding `cla` as a required check is what the `cla.yml` header describes, and is the reason its signatures live on a separate branch.

### 4.2 Confirm the GHCR package is public

Per CLAUDE.md §19 this is a one-time step after the first build. Masjid hosts pull without authentication, so if it is private, installs fail. Worth re-checking since nothing in the repo can verify it.

### 4.3 Bump the pinned Actions to their current majors (small, now safe)

The first CI run emitted one non-blocking annotation:

> Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run on Node.js 24: `actions/checkout@11d5960a…`

I pinned every action to the SHA its **existing** tag resolved to, so this branch changed immutability and nothing else — a major action bump is a behaviour change, and before `ci.yml` existed there was no way to verify one. Now there is. Current majors at audit time: `checkout` v7.0.1, `docker/setup-qemu-action` v4.2.0, `docker/setup-buildx-action` v4.2.0, `docker/login-action` v4.6.0, `docker/build-push-action` v7.3.0. Bump them on a branch, let `verify` run, and for `build-image.yml` confirm the multi-arch push still works before tagging a release.

### 4.4 Consider a `renovate.json` or Dependabot config

Ten advisories remain, all requiring major bumps I deliberately did not ship. Automated PRs would surface these continuously instead of at audit time — and now that CI runs tests, such a PR is actually evaluable.

---

## 5. Deferred findings that need your decision

### 5.1 Container runs as root [OMS-007] — Medium — **now tested; my earlier recommendation was wrong**

The runtime stage never drops privileges. Mitigated by `cap_drop: ALL` + `no-new-privileges:true`, but a code-execution bug still gets uid 0 in-container and unrestricted write to `/data`.

**Correction.** An earlier version of this section recommended installing `gosu` and dropping privileges in an entrypoint that first `chown`s `/data`. **That cannot work with this compose file, and I have now proved it.** `cap_drop: ALL` removes `CAP_CHOWN` and `CAP_SETUID` from uid 0 as well, so both halves of that pattern fail outright:

```
as shipped (root + cap_drop ALL):
  chown /data to node   -> chown: changing ownership of '/data': Operation not permitted
  setpriv --reuid=node  -> setpriv: setresuid failed: Operation not permitted

without cap_drop:
  chown /data to node   -> OK
  setpriv --reuid=node  -> 1000
```

Making that entrypoint work would need `cap_add: [CHOWN, SETUID, SETGID, DAC_OVERRIDE, FOWNER]` — handing back the capabilities that most ease privilege escalation, in order to achieve a privilege drop. That is a worse container than the one we have.

**What actually works** is setting the user at build time: the kernel applies it at exec, so it needs no capability at all (`--user 1000:1000` under `cap_drop: ALL` → `uid=1000`). `setpriv` is already in the image, so **no new package is needed either** — the `gosu` install was unnecessary.

The tested change is:

```dockerfile
EXPOSE 8080

# /data is handed to `node` BEFORE the VOLUME declaration on purpose: Docker seeds a fresh named
# volume's ownership from the image's directory, but DISCARDS changes made to a VOLUME path in any
# later layer — a chown after this line silently does nothing.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node
```

**Verified in WSL2 (Ubuntu 26.04, Docker 29.6.2), built from this repo:**

| Case | Result |
|---|---|
| Fresh volume (new install) | Boots as `uid=1000(node)`, `/data` is `node:node 755`, writes `students.db` **and** the WAL, reports `0.45.1`. Bonus: `/app` becomes read-only to the app. |
| **Existing root-owned volume** | **Fails to boot** — `SqliteError: attempt to write a readonly database`, `code: 'SQLITE_READONLY'` |
| Same volume after a one-time chown | Boots as 1000, and the pre-existing database is preserved |

**So it is safe to ship only alongside a migration.** The one-time command, verified to fix the failing case:

```bash
docker run --rm -v <the app's data volume>:/data alpine:3 chown -R 1000:1000 /data
```

**Your decision, and it is genuinely yours:**

- **(a) Ship it with OpenMasjidOS running that chown during the app update.** The right home for it — masajid never see it. Cross-repo, so it needs the OS side first; noted in §3 below.
- **(b) Ship it and document the manual step.** Every masjid must run one command or their tuition app stops booting. I would not do this to a volunteer treasurer.
- **(c) Ship a startup check first, then the user change later.** Right now an unwritable `/data` surfaces as a raw `SQLITE_READONLY` stack trace. A boot-time check that says *"/data is not writable by this container — run: docker run --rm -v …"* is worth having regardless, and it turns (b) from a mystery outage into a two-minute fix.
- **(d) Leave it as root.** Defensible: `cap_drop: ALL` + `no-new-privileges` + no `docker.sock` already removes most of what root buys an attacker.

My recommendation: **(c) then (a)**. The startup check is small, breaks nothing, and is useful on its own; the user change then lands cleanly once the OS can chown.

Bundle [OMS-009] (digest-pin `node:22-slim` to its **manifest-list** digest, or the arm64 build breaks) into whichever change ships.

### 5.2 Login throttling: per-account or not? [OMS-010] — **CLOSED 2026-08-13** (was: Low, genuinely ambiguous)

§14 asks for "per-IP and per-account". Only per-IP exists (8 failures / 15 min), so a distributed attacker can grind one known username unthrottled.

**I did not guess, because the obvious fix has a real downside:** a per-account lockout is a denial-of-service primitive against a named user. Anyone who learns the admin's username could lock them out at will — and admin login is LAN-only, so the lockout hits the one person able to fix it. Practical risk today is low: argon2id at 19 MiB with a 12-character minimum makes online guessing hopeless.

Pick one:
- **(a) Do nothing.** Defensible. argon2id + 12 chars is the real control. Add a code comment recording the decision so §14 stops reading as unmet.
- **(b) Per-account *alerting*, no lockout.** Raise a staff alert after N failures against one username. Catches the attack, creates no DoS. **My recommendation** — it fits the existing `alertStaff` machinery and the app already alerts on Student-ID lockout.
- **(c) Per-account exponential delay, no hard lock.** Slows guessing without a lockable state.
- **(d) Per-account lockout with a LAN-only bypass.** Strongest, most complexity.

**Chosen (2026-08-13): (b) + a bounded version of (d), without the LAN bypass.** Both halves, because they
answer different halves of the problem — the cap is what actually stops the spray, the alert is what makes it
visible. The lockout is deliberately loose (25 failures / 15 min, blocked 15 min) precisely because of the DoS
concern above, and the numbers are what answer it: a parent can still reset by email, an admin can reset a
staff password, and admin login is LAN-only so locking an admin means already being on the Wi-Fi. The alert
fires once per name per window and only for names that are real accounts, so it cannot be turned into a mail
flood. No LAN bypass: it would mean the one origin an attacker on the masjid Wi-Fi already has.

### 5.3 Timezone: dates are UTC everywhere [OMS-021] — Low

No `TZ` is set anywhere, so the container runs UTC and `toISOString().slice(0,10)` renders UTC dates. Internally consistent, so no money bug — but for a masjid west of UTC, **a payment recorded in the evening displays as the next day.** Cash entered at 21:00 on 4 Aug US Central prints `2026-08-05` on the statement handed to the parent and in the CSV the treasurer reconciles against.

Not fixed because a correct fix must apply one timezone consistently to rendering, `todayIso()`, **and** period derivation (`periodOf()` currently uses local time while everything else uses UTC — harmless at UTC, latent otherwise). That changes which day a cron run attributes work to and which month a bill lands in.

Decide: (a) accept UTC and document it; (b) add a `TZ` env var to `docker-compose.yml` — one line, but `periodOf()`'s local/UTC split must be reconciled first or bills could land in the wrong month; (c) a proper in-app timezone setting. **(b) is the pragmatic middle, but only after auditing every date path.**

### 5.4 Documentation drift [OMS-017] — **CLOSED 2026-08-13** (was: Info, but it misleads contributors)

CLAUDE.md is declared "the single source of truth… read it fully before writing any code", and it currently describes a system that does not exist. Verified stale:

- **§13.4 and `docs/PAYMENTS.md`** describe `POST /api/stripe/webhook`, signature verification, and a `stripe_events` dedupe table. **There is no webhook route** — `index.ts:40-42` says so outright. Payments record via Fabric calls, portal confirm-on-return, autopay's synchronous confirm, and daily reconciliation.
- **§4/§7/§9** describe SMTP settings and nodemailer. Email is platform-only; there is deliberately no `smtp` key.
- **§4/§6/§8** and `docker-compose.yml`'s header describe a public `/apply` admissions form. Removed in v0.35.0.
- **§5's permission matrix** still has 30+ rows for teacher, attendance, gradebook, report cards, transcripts — all removed in v0.35.0.
- **§19 and §9** claim CI enforces version and alert-id consistency. Now true as of this branch; it was not before.

I fixed only the comments inside files I was already touching. The rest is authoring a specification, which is yours. Highest value: §5's matrix (it's the security contract people will read) and §13.4 (someone will look for a webhook handler that isn't there).

**Done, 2026-08-13.** All five bullets above are now correct in the file: §5's matrix is the real three-role
one, §13.4 says outright that there is no webhook and lists the four pull paths that replace it, the SMTP and
`/apply` references are gone, and the CI claims are true. `docs/PAYMENTS.md` was rewritten for the same reason
(it opened with webhook signature verification). Section numbers were kept, because code comments cite them.

### 5.5 Two follow-ups worth scheduling

- **HTTP-layer test coverage [OMS-018].** `test/harness.ts` builds tRPC callers and never boots Fastify, so `@fastify/static`, the SPA fallback, `rewriteUrl` base-path stripping, `/api/logo`, and `/api/public/appearance` have **no** HTTP-level tests. My `statementRoute.test.ts` is the first. This gap is the direct reason [OMS-002] and [OMS-009] are deferred — closing it unblocks both.
- **Nonce-based CSP on the statement route.** The policy I shipped allows `'unsafe-inline'` for the one authored `<style>` block and the Print button's `onclick`. Moving to a per-response nonce would let you drop `'unsafe-inline'` entirely. I chose the weaker-but-zero-risk version because the route had no test coverage at the time; it does now, so this is safe to tighten.

---

## 6. Assumptions I made

State these back to me if any is wrong — a couple change my conclusions.

1. **The `:0.44.0` and `:latest` GHCR tags are not consumed by anything that would be harmed by a rebuild.** Basis for treating the push veto as "open a PR" rather than a hard stop. If a beta masjid pulls by tag rather than digest, tell me — it makes §0 more urgent.
2. **`docker-compose.yml` is the deployment used everywhere**, so `/data` is always a named volume. This is the whole basis for deferring [OMS-007]. If any install bind-mounts a host path, the non-root migration is *easier* than I assumed (host ownership is under your control) — but if any install uses a *different* compose, my reasoning needs revisiting.
3. **The four supported currencies are the only ones that matter.** `formatMoney` divides by 100, correct for `usd`/`cad`/`gbp`/`eur`. The settings enum is what prevents a 0-decimal (JPY) or 3-decimal (KWD, BHD) currency from silently producing wrong amounts. If a Gulf masjid ever needs KWD, `formatMoney` must change first.
4. **Donations and Kiosk are the only Fabric consumers**, and both are same-org and trusted-ish. I treated a valid app secret as a trusted caller, which is why [OMS-020] and the `lines` duplicate-id edge are rated Info/low rather than higher.
5. **The masjid LAN is semi-trusted.** Admin is LAN-only *by design*, so anyone on the Wi-Fi is in the admin threat surface. Your compose comments already flag firewalling the published port on an internet-facing host; I assumed that is understood and did not raise it as a finding.
6. **English-only is intentional for v1.** I treated the forced `language: 'en'` as correct (it is — it guards against a stale `ar`/`ur` setting `dir="rtl"` on an English UI) and reported only that CLAUDE.md claims shipped RTL support. If Arabic is on the near roadmap, [OMS-019] is a planning item rather than a docs fix.
7. **No runtime verification was possible.** I did not run the container, drive a browser, or touch Stripe test mode. Everything shipped is verified by the test suite, the typechecker, and the build — which is why anything needing observed runtime behaviour was deferred rather than guessed.
