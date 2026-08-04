<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Security & code-health audit — OpenMasjidStudents

**Date:** 2026-08-04
**Audited commit:** `66b75e9ad778c4057424a3d7de7541c99ab54a77` (`main`, v0.44.0)
**Rollback tag:** `pre-audit-2026-08-04` (→ the audited commit)
**Fix branch rebased onto:** `3a06857` (a README-only change that landed on `main` mid-audit)
**Scope:** whole repository — server, web, database, container, CI, docs, and git history.

---

## 1. Executive summary

**Posture: strong.** This is, candidly, one of the more carefully-built codebases of its kind. The security-critical invariants that CLAUDE.md declares are not aspirational — they are implemented, and in several places implemented *better* than the spec asks for. Specifically verified as genuinely done, not merely claimed:

- **No SQL injection anywhere.** Every one of the 11 raw `sql` templates uses Drizzle parameter binding. The `substr()`-instead-of-`LIKE` choice in [ledger.ts:425](../../packages/server/src/billing/ledger.ts#L425) is a correct and subtle catch (`_` is a LIKE wildcard and Stripe ids are full of them).
- **No XSS.** Zero occurrences of `innerHTML`, `dangerouslySetInnerHTML`, `eval`, or `new Function` in the entire codebase. The one server-rendered HTML page escapes every dynamic value, *including* the parent-typed kiosk payment memo.
- **The origin policy is stricter than §12.4 specifies** and fails closed. It grants `lan` only on a positive private-IP signal rather than on absence of `cf-ray`, correctly reasoning that a request arriving from an unfirewalled port-forward also lacks `cf-ray`. Spoofing only ever *removes* admin privilege.
- **Object-level authorization is complete.** All 9 parent-facing procedures that accept an id call `assertFamilyAccess`; I checked each one. Parent scoping is enforced in the query, never the UI.
- **No secrets in the tree or in git history.** Every `sk_test` / `whsec_` hit across all branches is a test fixture or a prefix-validation literal.
- **Money handling is rigorous:** integer cents throughout, derived-never-stored balances, immutable payments, DB-level idempotency, and property-based invariant tests that assert money is never invented or lost.

**The single most important issue is not a vulnerability — it is that nothing verifies this work.** There is **no CI that runs tests, lint, or typecheck** ([OMS-016](#oms-016)). The only workflow builds a Docker image and pushes it to GHCR on every push to `main`, tagged both `:<version>` and `:latest`, with **zero** verification first. 499 tests exist and pass; not one of them has ever run in CI. CLAUDE.md §19 twice asserts that drift "fails CI" — it cannot, because no CI reads it. For a repo whose push-to-main *publishes the artifact masajid install*, that is the gap most likely to cause real harm.

The highest-impact *security* item is [OMS-001](#oms-001): the production image installs `nodemailer`, which carries eight HIGH advisories including SMTP command injection and TLS-certificate-validation bypass — and the app never imports it. Email moved to the platform's `/api/fabric/email`; the dependency was left behind. Deleting it is free.

Nothing found is remotely exploitable by an unauthenticated internet attacker. No Critical findings.

---

## 2. Phase 0 — What this is, and who would attack it

**What it is.** Self-hosted tuition & fee management for a madrasa, shipped as a single Docker container installed from the OpenMasjidOS App Store. ~18,500 lines of TypeScript across an npm-workspaces monorepo: a Fastify + tRPC server with SQLite (WAL, better-sqlite3 + Drizzle) and a React 18 + Vite SPA. Deploy target is explicitly low-power — a Raspberry Pi in a masjid closet. One install = one masjid; there is no multi-tenancy to breach.

**Roles (3).** `admin` (LAN-only, by hard policy), `finance` (LAN + internet), `parent` (LAN + internet). The `teacher` and `student` roles and all academics were removed in the v0.35.0 descope.

**Entry points — the complete list.**

| Surface | Auth | Origin | Notes |
|---|---|---|---|
| `POST /trpc/*` (128 procedures) | session cookie | per-role | 14 deliberately public (login, setup, invite/reset/register, session, health) |
| `GET /statements/family/:id` | session, re-checked | admin=LAN, finance=both | server-rendered HTML; contains Student IDs |
| `POST /fabric/billing/{info,identify,lookup,record-payment,check}` | app-secret, constant-time | **LAN only**, tunnel→404 | the 4-repo contract; the money-in path |
| `GET /api/logo` | **none, by design** | both | re-validates magic bytes on the way out |
| `GET /api/public/appearance` | **none, by design** | both | server-side relay to the OS; `redirect: 'error'`, 4 s timeout, 10 s cache |
| `GET /healthz` | none | both | `{ok:true}` |
| SPA fallback + static assets | none | both | built UI only |
| 5 cron jobs (croner, in-process) | n/a | n/a | snapshot/30 min, auto-invoice 02:00, autopay 06:00, reconcile 07:00, public-URL 15 min |

There is **no** Stripe webhook route, **no** `/apply` admissions form, and **no** file-upload/multipart surface — all three are described in CLAUDE.md but were removed. The docs are stale, not the code ([OMS-017](#oms-017)).

**Trust boundaries.** Untrusted → trusted crossings: (1) the internet via the OS Cloudflare tunnel, reaching finance and parent surfaces; (2) the OS Fabric broker relaying Donations/Kiosk calls, authenticated by this app's own secret; (3) Stripe API responses; (4) the masjid LAN, treated as semi-trusted (admin lives here). Outbound: Stripe and the OS core only — both from fixed env-configured URLs, so there is no SSRF primitive.

**Sensitive data.** Minors' names and dates of birth; guardian names, phones, emails; the complete payment ledger; Stripe customer and payment-method references (brand/last4/exp only — never PANs); argon2id password hashes; session-token SHA-256 hashes. Student IDs are a special case: a guessable `ABC1234` that is the *entire* credential on the payment path, deliberately, with a per-ID lockout as the compensating control rather than a secret.

**Threat model — who realistically attacks this.**

1. **A parent with a portal account, poking at another family's data.** The most likely real attacker: motivated, authenticated, and already inside. Defeated — `assertFamilyAccess` on every id-bearing procedure, verified individually.
2. **Someone on the masjid Wi-Fi.** Guest networks are common. Gets no admin without credentials; the LAN is where admin *may* live, so this is the policy's soft edge, acknowledged in compose comments.
3. **An internet scanner hitting the tunnel URL.** Finds login, the parent-portal doors, and rate limits on all of them. Admin login is refused outright and a LAN-minted admin cookie is 403'd at use time. Best available prize is install-state reconnaissance ([OMS-008](#oms-008)).
4. **Someone sweeping Student IDs** at the kiosk or donation site to read balances or pay a stranger's tuition. ~10k guesses per name prefix; countered by a 6-failure/hour per-ID lockout shared across `identify`, `lookup`, and self-registration so failures cannot be laundered between endpoints, plus a staff alert on lockout.
5. **Supply chain — the highest-leverage attack by a wide margin.** Push to `main` publishes `:latest` and `:<version>` to GHCR with no verification, using five GitHub Actions pinned to *mutable tags* with `packages: write` in scope ([OMS-006](#oms-006), [OMS-016](#oms-016)). Compromising one action tag reaches every masjid that installs or rebuilds.
6. **Insider (staff account).** Finance sees the whole ledger and can export bulk PII by design; every such read is audited.

Every finding below ties to one of these six.

---

## 3. Findings

| ID | Title | Severity | Confidence | Location | Status |
|---|---|---|---|---|---|
| [OMS-001](#oms-001) | Unused `nodemailer` ships in the production image with 8 HIGH advisories | Medium | Confirmed | `packages/server/package.json:27` | **Fixed** |
| [OMS-004](#oms-004) | `reallocateStudent` scans the entire `payment_allocations` table on every money write | Medium | Confirmed | `billing/ledger.ts:259` | **Fixed** |
| [OMS-005](#oms-005) | Changing a password does not invalidate the user's other sessions | Medium | Confirmed | `trpc/auth.ts:160` | **Fixed** (Tier 2) |
| [OMS-006](#oms-006) | Release workflow's Actions pinned to mutable tags, with `packages: write` | Medium | Confirmed | `.github/workflows/build-image.yml:41` | **Fixed** |
| [OMS-016](#oms-016) | No CI runs tests, lint, or typecheck; images publish unverified | Medium | Confirmed | `.github/workflows/` | **Fixed** |
| [OMS-007](#oms-007) | Container runs as root | Medium | Confirmed | `Dockerfile:25` | **Deferred** |
| [OMS-002](#oms-002) | `@fastify/static` 8.3.0 — 4 HIGH advisories, unreachable in this config | Low | Confirmed | `packages/server/package.json:19` | **Deferred** |
| [OMS-003](#oms-003) | `drizzle-orm` 0.38.3 — identifier-escaping SQLi, unreachable | Low | Confirmed | `packages/server/package.json:24` | **Deferred** |
| [OMS-008](#oms-008) | `auth.session` reports install state over the tunnel | ~~Low~~ **Info** | Confirmed | `trpc/auth.ts:79` | **Accepted by design** |
| [OMS-011](#oms-011) | School logo interpolated into an HTML attribute unescaped | Low | Confirmed | `billing/statements.ts:185` | **Fixed** |
| [OMS-012](#oms-012) | Statement HTML served with no CSP or hardening headers | Low | Confirmed | `billing/statementRoutes.ts:34` | **Fixed** |
| [OMS-014](#oms-014) | Invite acceptance navigates outside the app under the tunnel prefix | Low | Confirmed | `web/routes/InviteAccept.tsx:31` | **Fixed** |
| [OMS-015](#oms-015) | `record-payment` accepts a `currency` and silently ignores it | Low | Confirmed | `fabric/provider.ts:364` | **Partial** |
| [OMS-010](#oms-010) | Login throttled per-IP only, not per-account | Low | Confirmed | `trpc/auth.ts:123` | **Deferred** |
| [OMS-009](#oms-009) | Base image `node:22-slim` not digest-pinned | Low | Confirmed | `Dockerfile:13,25` | **Deferred** |
| [OMS-021](#oms-021) | All dates rendered in UTC with no timezone config | Low | Confirmed | `billing/statements.ts:42` | **Deferred** |
| [OMS-017](#oms-017) | Documentation describes removed subsystems as present | Info | Confirmed | `CLAUDE.md`, `docs/`, `cla.yml` | **Partial** |
| [OMS-018](#oms-018) | No HTTP-layer tests for the boot path | Info | Confirmed | `packages/server/test/` | **Reported** |
| [OMS-019](#oms-019) | "Full RTL / Arabic-ready" is plumbing only | Info | Confirmed | `web/src/lib/i18n/` | **Reported** |
| [OMS-020](#oms-020) | `externalRef` accepts an unbounded object shape | Info | Confirmed | `fabric/provider.ts:367` | **Reported** |
| [OMS-022](#oms-022) | Vulnerable transitive dependencies at patch-fixable versions | Low | Confirmed | `package-lock.json` | **Fixed** |
| [OMS-023](#oms-023) | Fastify `maxParamLength` option deprecated, removed in fastify@6 | Info | Confirmed at runtime | `src/index.ts:66` | **Reported** |

**Counts:** 0 Critical · 0 High · 6 Medium · 10 Low · 6 Info · **22 total**.

One finding moved during remediation: **OMS-008 was downgraded from Low to Info and its fix reverted** after I found the disclosure is deliberate and load-bearing for the first-run UX. Recorded in full at [OMS-008](#oms-008) rather than quietly dropped, because "I was wrong about this one" is part of the result.

---

### <a id="oms-001"></a>OMS-001 — Unused `nodemailer` ships in the production image with 8 HIGH advisories
**Medium · Confirmed · `packages/server/package.json:27`**

`nodemailer@^6.10.1` is a production dependency, so `npm ci --omit=dev` installs it into the runtime image. It carries eight HIGH advisories: SMTP command injection via `envelope.size` (GHSA-c7w3-x93f-qmm8), CRLF injection in transport name (GHSA-vvjj-xcjg-gr5g) and in `List-*` headers (GHSA-268h-hp4c-crq3), improper TLS certificate validation in OAuth2 token fetch (GHSA-r7g4-qg5f-qqm2), arbitrary file read / full-response SSRF via the message-level `raw` option (GHSA-p6gq-j5cr-w38f), `jsonTransport` bypassing `disableFileAccess` (GHSA-wqvq-jvpq-h66f), delivery to an unintended domain (GHSA-mm7p-fcc7-pg87), and addressparser DoS (GHSA-rcmh-qjqh-p98v).

**Reachability: none.** The app has no SMTP transport of its own. Email goes through the platform:

```ts
// mail/notify.ts:62
async function deliver(to: string, subject: string, text: string, html?: string): Promise<boolean> {
  return sendPlatformEmail(to, subject, text, html);   // → POST {OS}/api/fabric/email
}
```

and `settings/index.ts:18` states the intent outright: *"there is deliberately no `smtp` key. Email is OpenMasjidOS's job."* An exhaustive search confirms it:

```
$ grep -rni "nodemailer" packages/ --include=*.ts --include=*.tsx --include=*.json
packages/server/package.json:27:    "nodemailer": "^6.10.1",
packages/server/package.json:36:    "@types/nodemailer": "^6.4.24",
```

Two declarations, zero imports. `@react-pdf/renderer` (the report-card PDF renderer, removed in the v0.35.0 descope) and `react` are dead in the same way — `grep -rn "from 'react'" packages/server/src` returns nothing.

**Impact.** No live attack path today. It matters for three concrete reasons: shipping a mail library with SMTP-injection and TLS-bypass flaws inside a payments container is a liability if anything ever `require`s it; it accounts for 7 of the 15 `npm audit` findings, which trains maintainers to ignore the tool; and `@react-pdf/renderer` drags fontkit/yoga-layout into an image destined for a Raspberry Pi.

**Fix.** Removed `nodemailer`, `@types/nodemailer`, `@react-pdf/renderer`, and `react` from the server workspace. Zero code change; the modules were never loaded.

---

### <a id="oms-004"></a>OMS-004 — `reallocateStudent` scans the entire `payment_allocations` table on every money write
**Medium · Confirmed · `billing/ledger.ts:259`**

```ts
// Clear the mapping for live payments only, remembering which invoices that affects [...]
for (const a of tx.select({ id: paymentAllocations.id, paymentId: paymentAllocations.paymentId,
                            invoiceId: paymentAllocations.invoiceId })
                  .from(paymentAllocations).all()) {     // ← no WHERE: every row, every install
  if (!liveIds.has(a.paymentId)) continue;               // ← filtered in JS instead
  ...
}
```

The query reads **all** allocation rows for **all** students, then discards all but the one student's in JavaScript. `payment_allocations_payment_idx` exists and would serve this perfectly, but an unfiltered scan cannot use it.

**Reachable from every money path**, five call sites: `recordPayment` ([ledger.ts:190](../../packages/server/src/billing/ledger.ts#L190)) on every payment from every channel; `reversePayment` ([:478](../../packages/server/src/billing/ledger.ts#L478)); invoice generation ([invoices.ts:155](../../packages/server/src/billing/invoices.ts#L155)); charge posting ([invoices.ts:213](../../packages/server/src/billing/invoices.ts#L213)); mid-year carry-in ([carryIn.ts:211](../../packages/server/src/billing/carryIn.ts#L211)).

**Failure scenario.** `generatePeriod` loops every active student ([invoices.ts:180](../../packages/server/src/billing/invoices.ts#L180): `for (const k of kids) generateForStudent(...)`), so cost is *students × total allocation rows*. A 200-student madrasa three years in holds roughly 15,000 allocation rows, making the nightly 02:00 auto-invoice run ≈ 3,000,000 row reads inside one transaction — on a Pi, and growing quadratically with roster × history. The work is wasted: >99% of rows read are discarded by the very next line.

**Fix.** Added `.where(inArray(paymentAllocations.paymentId, [...liveIds]))`, with the empty-set case short-circuited (SQLite renders an empty `IN ()` as a false predicate, but relying on that is fragile). Behaviour is identical by construction — the JS filter kept exactly the rows the WHERE clause now selects.

---

### <a id="oms-005"></a>OMS-005 — Changing a password does not invalidate the user's other sessions
**Medium · Confirmed · `trpc/auth.ts:160` · Tier 2 (behaviour change)**

```ts
changePassword: protectedProcedure...
  db.update(users).set({ passwordHash: await hashPassword(input.newPassword),
                         mustChangePassword: false, updatedAt: new Date() })
    .where(eq(users.id, userId)).run();
  return { ok: true as const };          // ← existing sessions elsewhere stay live
```

`resetConfirm` in the same file does the opposite, deliberately: `tx.delete(sessions).where(eq(sessions.userId, r.userId)).run(); // sign out everywhere (§14)`. So the intended rule is not ambiguous — it is simply missing from the other half of the pair.

**Failure scenario.** A parent uses the portal on a shared or borrowed phone and forgets to sign out. Later, from home, they change their password precisely because they are worried. The stolen session cookie keeps working for the remainder of its 12-hour TTL, and the app gave them no way to end it: there is no session-list UI and no "sign out everywhere" button. Changing a password is the universal user expectation for revocation, and the app quietly does not honour it.

**Fix.** `changePassword` now deletes the user's other sessions, keeping the caller's current token so they are not logged out of the tab they are using. Behaviour-changing (a user with the app open on a phone and a laptop will be signed out of the other device), hence Tier 2 and flagged. Regression test added covering both halves: other sessions die, the current one survives.

---

### <a id="oms-006"></a>OMS-006 — Release workflow's Actions pinned to mutable tags, with `packages: write`
**Medium · Confirmed · `.github/workflows/build-image.yml:41`**

```yaml
permissions:
  contents: read
  packages: write        # ← can publish to GHCR
...
      - uses: actions/checkout@v4              # mutable tag
      - uses: docker/setup-qemu-action@v3      # mutable tag
      - uses: docker/setup-buildx-action@v3    # mutable tag
      - uses: docker/login-action@v3           # mutable tag
      - uses: docker/build-push-action@v6      # mutable tag
```

A git tag is mutable: whoever controls the action's repository can repoint `v4` at any commit. All five run in a job holding `packages: write` and a GHCR-scoped `GITHUB_TOKEN`. `cla.yml:46` already pins its third-party action to a full SHA (`contributor-assistant/github-action@ca4a40a…`), so the house standard is established — `build-image.yml` just doesn't follow it.

**Why this is the highest-leverage finding in the repo.** This workflow is the *only* thing that publishes the artifact masajid install. A compromised tag here does not leak data; it ships a backdoored container image, tagged as a released version, to every masjid that installs or rebuilds. That is worse than any individual data-access bug below.

**Fix.** All five pinned to full commit SHAs with the version in a trailing comment, matching the `cla.yml` pattern. Resolved SHAs are listed in `REMEDIATION.md`.

---

### <a id="oms-016"></a>OMS-016 — No CI runs tests, lint, or typecheck; images publish unverified
**Medium · Confirmed · `.github/workflows/`**

The repo contains exactly two workflows: `build-image.yml` (build + push to GHCR) and `cla.yml` (CLA signature check). Neither runs `npm test`, `npm run lint`, or `npm run build` as a gate. The last eight CI runs are all "Build image".

The consequences are concrete:

- **499 tests across 49 files have never run in CI.** They pass locally; nothing enforces that they keep passing.
- **CLAUDE.md §19 is factually wrong twice.** It says `version.test.ts` "asserts all of these agree, so a half-finished bump fails CI instead of shipping" and §9 says `test/alerts.test.ts` "fails the build when the code can raise an id the manifest does not declare." Neither can fire. Both tests exist and are well written; nothing executes them.
- **The `payment-short` incident is the proof.** CLAUDE.md §9 records that `payment-short` was raisable in code but undeclared in the manifest for the whole of 0.43.0, so every such alert was answered `400 Unknown alert` and dropped, fail-soft and invisible. A guard test was then written — but with no CI, that guard protects nothing.
- **A push that breaks typecheck still publishes an image**, because the Docker build and the typecheck are different code paths (`vite build` does not typecheck).

**Fix.** Added `.github/workflows/ci.yml` running `npm ci`, `npm run lint`, `npm run test`, `npm run build` on pushes to `main` and on all pull requests, with `permissions: contents: read` and no secrets. Additive and cannot affect existing behaviour.

---

### <a id="oms-007"></a>OMS-007 — Container runs as root — **DEFERRED**
**Medium · Confirmed · `Dockerfile:25`**

The runtime stage never drops privileges:

```dockerfile
FROM node:22-slim AS runtime
ENV NODE_ENV=production
...
CMD ["node", "packages/server/dist/index.js"]     # uid 0
```

The `node:22-slim` base provides an unused `node` user (uid 1000). Partially mitigated in [docker-compose.yml](../../docker-compose.yml): `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `tmpfs: /tmp`, no `docker.sock`, no `privileged`, no host networking. Residual risk: a code-execution bug gets uid 0 inside the container and unrestricted write to `/data`, which holds minors' PII and the entire payment ledger.

**Why I did not ship this.** `docker-compose.yml` mounts a **named volume** (`data:/data`). Docker seeds a named volume's ownership from the image only when the volume is *first created*. Every already-deployed masjid has a volume whose files are root-owned, so adding `USER node` would leave the app unable to open `students.db` — **every existing install would fail to boot on update.**

**Since verified in WSL2** (Ubuntu 26.04, Docker 29.6.2), which changed two conclusions:

1. **The `gosu`-entrypoint fix this report originally recommended cannot work.** `cap_drop: ALL` strips `CAP_CHOWN` and `CAP_SETUID` from uid 0 too, so a chown-then-drop entrypoint fails at both steps (`chown: Operation not permitted`, `setpriv: setresuid failed`). It would need those capabilities added back — weakening the container to achieve a privilege drop. A build-time `USER` needs no capability (the kernel applies it at exec) and `setpriv` is already in the image, so **no extra package was ever needed**.
2. **The predicted breakage is real and now has an exact signature.** Built from this repo with `RUN mkdir -p /data && chown node:node /data` before `VOLUME` plus `USER node`:

| Case | Result |
|---|---|
| Fresh volume | Boots as `uid=1000(node)`, `/data` `node:node 755`, writes `students.db` + WAL, reports `0.45.1`; `/app` also becomes read-only to the app |
| Existing root-owned volume | **Fails** — `SqliteError: attempt to write a readonly database` (`SQLITE_READONLY`) |
| Same volume after `chown -R 1000:1000 /data` | Boots as 1000, pre-existing database preserved |

So the change is correct and ready, and still **must not ship without a migration** — which belongs in OpenMasjidOS's update path, since only the platform can chown the volume. Options and the exact commands are in `ACTION_REQUIRED.md` §5.1/§3.2.

---

### <a id="oms-002"></a>OMS-002 — `@fastify/static` 8.3.0 — 4 HIGH advisories, unreachable in this configuration — **DEFERRED**
**Low (rated by actual impact) · Confirmed · `packages/server/package.json:19`**

`npm audit` reports four HIGH advisories against the installed 8.3.0: path traversal in directory listing (GHSA-pr96-94w5-mx2h), route-guard bypass via encoded path separators (GHSA-x428-ghpx-8j92), authorization bypass via non-canonical URL paths (GHSA-8pvw-jcv7-9cmj), and route-guard bypass via path traversal (GHSA-83w8-p2f5-377r).

**Why Low rather than High.** All four require a precondition this app does not create. Three are *guard-bypass* classes — they matter when an application attaches an auth hook to a static route and an attacker slips past it with encoded separators. The fourth needs directory listing enabled. Here:

```ts
// index.ts:160
await app.register(fastifyStatic, { root: config.publicDir, index: false });
```

No `list: true`, no `preHandler`/`onRequest` guard, and `root` is the built web bundle — public JS, CSS, and fonts. There is no guard to bypass and nothing under `root` that is not already world-readable. The genuinely sensitive routes are separate and gate themselves: `/statements/*` re-checks the session and role per request, `/fabric/*` requires a constant-time secret match and refuses tunnel origin.

**Why deferred.** The advisory-clearing version is 10.1.2 — a **two-major** jump from 8.3.0, and [OMS-018](#oms-018) means the static/SPA-fallback layer has **no HTTP-level test coverage at all**. The test harness builds tRPC callers with fake contexts and never boots the real Fastify app, so nothing would catch a regression in `rewriteUrl`, `setNotFoundHandler`, or asset serving. Shipping a blind two-major bump to the layer that serves every page, when the flaws it fixes are unreachable, trades a real risk for a theoretical one.

---

### <a id="oms-003"></a>OMS-003 — `drizzle-orm` 0.38.3 identifier-escaping SQL injection, unreachable — **DEFERRED**
**Low (rated by actual impact) · Confirmed · `packages/server/package.json:24`**

GHSA-gpj5-g38j-94v9 (HIGH): SQL injection via improperly escaped SQL *identifiers*. Exploiting it requires user-controlled input reaching an identifier position — a table name, a column name, an alias.

**Reachability: none.** I enumerated all 11 raw `sql` template usages. Every one interpolates either a Drizzle column reference (a compile-time schema object) or a bound parameter. No identifier anywhere derives from request data. The closest thing to dynamic column selection is `getYearViewColumns()`, which filters against a hard-coded `YEAR_VIEW_COLUMNS` allow-list ([settings/index.ts:169](../../packages/server/src/settings/index.ts#L169)) before use.

**Why deferred.** 0.38.3 → 0.45.2 is a major ORM upgrade on the layer that owns 31 committed migrations and every money query, to fix a class of bug the code cannot reach. That deserves its own branch with a migration replay against a real database, not a blind bump inside a security sweep.

---

### <a id="oms-008"></a>OMS-008 — `auth.session` reports install state over the tunnel — **ACCEPTED BY DESIGN**
**Info (downgraded from Low) · `trpc/auth.ts:79`**

```ts
return { authenticated: false as const, origin: ctx.origin, setupRequired: !hasAnyUser() };
```

Unauthenticated, reachable over the tunnel, and it answers "has this install created its admin account yet?" — while the very next procedure appears to forbid exactly that:

```ts
// setup, auth.ts:86-87
// Origin FIRST — over the tunnel this always returns the same message whether or
// not the app is set up yet (no install-state oracle to the internet, §14).
```

**I initially rated this Low and shipped a fix gating `setupRequired` to `lan`. I then reverted it, because the disclosure is deliberate and my fix was a regression.** [App.tsx:126](../../packages/web/src/App.tsx#L126) reads the flag *together with the origin*:

```tsx
screen = s.origin === 'tunnel' ? <SetupOnLanNotice /> : <Setup />;
```

`SetupOnLanNotice` is a purpose-built component with two dedicated i18n strings — *"Almost there / Set up the admin account from a device on the masjid's own Wi-Fi — for safety, the first admin can't be created over the internet."* Gating the flag would have replaced that with a generic login form on a fresh install, so an admin who exposed the tunnel before doing first-run would see a sign-in box, no accounts to sign in with, and no explanation.

**Why accepting it is right.** The single bit disclosed is "first-run has not happened", and there is nothing an attacker can do with it: `setup` refuses every non-LAN origin at the top of the handler, so the first admin can only ever be created from the masjid network. §14's "no install-state oracle" constrains the setup mutation's *error text*, which does stay uniform. Trading one unactionable bit for a first-run experience that explains itself is the better engineering call, and it was made on purpose.

**Action taken.** No behaviour change. Added a comment at the call site recording that this was reviewed and kept, and why — so the next person auditing does not read it as the oversight I first took it for.

---

### <a id="oms-011"></a>OMS-011 — School logo interpolated into an HTML attribute unescaped
**Low · Confirmed · `billing/statements.ts:185`**

```ts
${logo ? `<img class="logo" src="${logo}" alt="" />` : ''}
```

The file's own header promises otherwise: *"every dynamic value (names, memos, labels) is HTML-escaped."* This is the one dynamic value that skips `esc()`.

**Not exploitable, and I want to be precise about why** rather than inflate it. The value is validated on write *and* re-validated on read against an anchored, character-restricted regex:

```ts
// settings/index.ts:59
const m = /^data:([a-z\/+-]+);base64,([A-Za-z0-9+\/=]+)$/.exec(value.trim());
```

The permitted alphabet contains no `"`, `'`, `<`, or `>`, so there is no way to close the attribute. Magic bytes must then match the declared MIME, and SVG is excluded by design ("script-capable and would be served back to browsers"). Writing is admin-only. So this is a genuine defence-in-depth gap, not a vulnerability: correctness rests entirely on a regex two modules away, and the next person to relax that regex has no local signal that HTML safety depends on it.

**Fix.** Wrapped in `esc()`. `esc()` is idempotent over the permitted alphabet, so rendering is byte-identical today.

---

### <a id="oms-012"></a>OMS-012 — Statement HTML served with no CSP or hardening headers
**Low · Confirmed · `billing/statementRoutes.ts:34`**

```ts
return reply.header('Content-Type', 'text/html; charset=utf-8')
            .header('Cache-Control', 'no-store').send(html);
```

A page assembled by string concatenation, containing Student IDs and a family's full payment history, served same-origin with no `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`, or framing protection. Compare `/api/logo` in [index.ts:120](../../packages/server/src/index.ts#L120), which does set `default-src 'none'; sandbox` and `nosniff` — the pattern exists in the codebase and was not applied here.

**Fix.** Added `Content-Security-Policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`, plus `nosniff` and `Referrer-Policy: no-referrer`.

`'unsafe-inline'` is a deliberate, documented compromise: the page carries an authored `<style>` block and one `onclick="window.print()"`. Keeping it means the directive cannot block injected inline script — but it *does* cut every exfiltration channel (`default-src 'none'` blocks all external loads, so an injected `<img src=https://evil/?…>` never fires), blocks framing, and blocks form submission. Zero rendering-regression risk, which matters because [OMS-018](#oms-018) leaves this route untested at the HTTP level. A nonce-based policy is the stronger follow-up, noted in `ACTION_REQUIRED.md`.

---

### <a id="oms-014"></a>OMS-014 — Invite acceptance navigates outside the app under the tunnel prefix
**Low (security) / real functional defect · Confirmed · `web/routes/InviteAccept.tsx:31`**

```ts
window.location.assign('/');
```

Every other navigation in the web app routes through `withBase()` from [lib/base.ts:29](../../packages/web/src/lib/base.ts#L29), which prefixes the OS tunnel mount path. This is the only `location.assign` in the codebase and the only literal navigation path:

```
$ grep -rn "location.assign\|location.replace\|pushState" packages/web/src
packages/web/src/routes/InviteAccept.tsx:31:      window.location.assign('/');
```

**Failure scenario.** OpenMasjidOS serves the app under a prefix (default `/students`). A parent opens their emailed invite, sets a password — the account is created and the session cookie is set correctly — and is then redirected to `https://masjid.example/`, the OS dashboard root, instead of `/students/family`. They land on an unrelated page and reasonably conclude signup failed. This is the *primary* parent onboarding path and it runs over the tunnel by definition, since invite links require an absolute public URL.

The session cookie's `Path` is scoped to the same prefix ([sessions.ts:97](../../packages/server/src/auth/sessions.ts#L97)), so the redirect also lands somewhere the cookie is not sent — reinforcing the "it didn't work" impression.

**Fix.** `window.location.assign(withBase('/'))`.

---

### <a id="oms-015"></a>OMS-015 — `record-payment` accepts a `currency` and silently ignores it — **PARTIAL**
**Low · Confirmed · `fabric/provider.ts:364`**

```ts
currency: z.string().max(10).optional(),      // parsed, validated for length… then never read
```

The field is in the contract, accepted, and dropped. `recordSplit` stores an integer-cents amount; the school's own currency is applied at display time via `getCurrency()`. A consumer that sent `currency: "eur"` against a `usd` install would have €150.00 recorded as $150.00 — same integer, different money.

Requires a consumer bug to trigger (both consumers read `currency` from `/fabric/billing/info`), and both are same-org repos. But it is silent, and a silently-wrong ledger entry is the kind of thing found at year-end.

**Fix — the safe half only.** Per the Tier 3 rule I must not change a cross-repo wire contract, and turning a currently-accepted request into a 422 is exactly that. So this now logs a warning naming the mismatch and records the payment as before — money is never refused. The counterpart change (either drop the field or have the provider reject a mismatch, coordinated across four repos) is written up under **Cross-repo** in `ACTION_REQUIRED.md`.

---

### <a id="oms-010"></a>OMS-010 — Login throttled per-IP only, not per-account — **DEFERRED**
**Low · Confirmed · `trpc/auth.ts:123`**

```ts
const key = clientIp(ctx.req);
const wait = loginLimiter.retryAfterMs(key);      // 8 failures / 15 min, per IP
```

CLAUDE.md §14 requires internet-facing limits "per-IP and per-account". Only the per-IP half exists, so an attacker with a botnet or a rotating IPv6 prefix can grind one known username without ever tripping the limiter.

**Why deferred rather than fixed.** Practical exploitability is low: argon2id at 19 MiB / 2 iterations with a 12-character minimum ([passwords.ts:12](../../packages/server/src/auth/passwords.ts#L12)) makes online guessing hopeless, and the limiter already resists the single-source case. Meanwhile a per-account lockout is a **denial-of-service primitive against a named user**: anyone who knows the admin's username could lock them out at will, and admin sign-in is LAN-only, so the lockout would hit the one person who can fix it. Which way to resolve that is a real product judgement (fail counter without lockout? exponential delay? alert instead of block?), not a mechanical fix — so per the brief I am not guessing. Options in `ACTION_REQUIRED.md`.

---

### <a id="oms-009"></a>OMS-009 — Base image `node:22-slim` not digest-pinned — **DEFERRED**
**Low · Confirmed · `Dockerfile:13,25`**

Both stages use the mutable tag `node:22-slim`, so two builds of the same commit can produce different images. Digest pinning would make builds reproducible and remove one supply-chain hop.

**Deferred** and bundled with [OMS-007](#oms-007): a multi-arch digest pin must reference the *manifest-list* digest or the arm64 build breaks, and this run cannot validate a multi-arch buildx build (CI only runs on pushes to `main`, which the pre-flight veto forbids). Pinning the wrong digest breaks the release pipeline for a reproducibility gain — the wrong trade to make unverified.

---

### <a id="oms-021"></a>OMS-021 — All dates rendered in UTC with no timezone config — **DEFERRED**
**Low · Confirmed · `billing/statements.ts:42`, `billing/csv.ts:60`**

```ts
return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);   // always UTC
```

No `TZ` is set in the `Dockerfile`, `docker-compose.yml`, or `manifest.yaml`, so the container runs UTC, and `toISOString()` renders UTC dates. The system is *internally* consistent (`todayIso()`, `addDays()`, `csvDate()`, `asDate()` all UTC), which is why no money bug follows.

**User-visible consequence.** For a masjid west of UTC, a payment recorded in the evening displays as the next day. Entering cash at 21:00 on 4 Aug in US Central (02:00 UTC on 5 Aug) prints "2026-08-05" on the statement handed to the parent and in the CSV the treasurer reconciles against. `periodOf()` ([period.ts:57](../../packages/server/src/billing/period.ts#L57)) additionally uses *local* time while everything else uses UTC — harmless while the container is UTC, latent if anyone ever sets `TZ`.

**Deferred:** a correct fix needs a masjid-configurable timezone applied consistently to rendering, `todayIso()`, and period derivation. That changes which day a cron run attributes work to and which month a bill lands in — a Tier 2 change with real billing consequences that should not be guessed at inside a security sweep.

---

### <a id="oms-022"></a>OMS-022 — Vulnerable transitive dependencies at patch-fixable versions
**Low · Confirmed · `package-lock.json`**

Five transitive packages had non-breaking fixes available. Recorded as its own finding because it was remediated as a distinct commit rather than folded into [OMS-001](#oms-001):

| Package | From → To | Severity | Advisory |
|---|---|---|---|
| `find-my-way` | 9.6.0 → 9.7.0 | high | GHSA-c96f-x56v-gq3h — HTTP/2 DoS. **This is Fastify's router**, so it is the one on a live request path. |
| `fast-uri` | 3.1.3 → 3.1.5 | high | GHSA-v2hh-gcrm-f6hx / GHSA-7p8r-x3mc-p8w7 — host confusion via backslash authority delimiter |
| `fast-uri` | 4.1.0 → 4.1.2 | high | same pair, under `fast-json-stringify` |
| `brace-expansion` | 5.0.7 → 5.0.9 | high | GHSA-mh99-v99m-4gvg / GHSA-rgw5-rvv9-x895 — unbounded expansion OOM |
| `postcss` | 8.5.19 → 8.5.25 | moderate | GHSA-fxqj-rqcc-2cmp — attacker-controlled `sourceMappingURL` reads arbitrary `.map` files |

**Fix.** `npm audit fix`, after confirming by `--dry-run` that it touched exactly these five and did nothing else (`added: 0, removed: 0, changed: 5`, no major versions). `find-my-way` is covered by the Fabric provider tests and the new statement-route tests, both of which drive real Fastify routing through `inject`.

---

### <a id="oms-023"></a>OMS-023 — Fastify option deprecated, removed in the next major — **REPORTED**
**Info · Confirmed at runtime · `packages/server/src/index.ts:66`**

Found only by booting the released image; no test surfaces it, because the test harness never constructs a Fastify instance for the main app ([OMS-018](#oms-018)). Every container start logs:

```
(node:7) [FSTDEP022] FastifyWarning: The router options for maxParamLength property access is
deprecated. Please use "options.routerOptions" instead for accessing router options. The router
options will be removed in `fastify@6`.
```

The option itself is load-bearing and well justified — [index.ts:61-66](../../packages/server/src/index.ts#L61-L66) raises `maxParamLength` to 5000 because tRPC's `httpBatchLink` packs a comma-joined procedure list into one GET path, and Fastify's default of 100 truncates the batch to a 414. The comment notes this was caught by driving a browser, since `createCaller` tests bypass HTTP entirely.

**Impact today: none** — it is a warning, the behaviour is correct, and it costs one noisy line per boot. It matters on the next Fastify major, where the top-level form is removed and the batch endpoint would silently start 414-ing again. Worth moving to `routerOptions: { maxParamLength: 5000 }` when Fastify 6 is on the horizon; **not** worth a change to the HTTP boot layer of a just-released version on my own initiative. Now that a container can be booted and probed, this is also cheap to verify when someone does it.

---

### <a id="oms-017"></a>OMS-017 — Documentation describes removed subsystems as present — **PARTIAL**
**Info · Confirmed**

The code is authoritative and correct; the docs describe a system that no longer exists. Verified drift:

| Claim | Reality |
|---|---|
| CLAUDE.md §13.4, `docs/PAYMENTS.md`: `POST /api/stripe/webhook`, signature verification, `stripe_events` dedupe | **No webhook route exists.** [index.ts:40-42](../../packages/server/src/index.ts#L40-L42): "There is NO Stripe webhook" |
| CLAUDE.md §4/§7/§9: SMTP settings, nodemailer, `smtp_config` | Email is platform-only; [settings/index.ts:18](../../packages/server/src/settings/index.ts#L18) says the key deliberately does not exist |
| CLAUDE.md §4/§6/§8, `docker-compose.yml:6`: public `/apply` admissions form | Removed in v0.35.0; no route, no `admissions/` module |
| CLAUDE.md §5 permission matrix: 30+ rows for teacher/attendance/gradebook/reports | Roles and features removed in v0.35.0 |
| CLAUDE.md §19: "a half-finished bump fails CI"; §9: alerts test "fails the build" | No CI runs any test — see [OMS-016](#oms-016) |
| `cla.yml:11-14`: "the default branch is protected with a required `cla` status check" | `GET /branches/main/protection` → `404 Branch not protected` |
| `vitest.config.ts:5`: timeout justified by `@react-pdf/renderer` | Dependency unused; removed by [OMS-001](#oms-001) |

Docs drift is not cosmetic here: CLAUDE.md is declared "the single source of truth… read it fully before writing any code," so a future contributor may look for a webhook handler that does not exist, or trust a CI gate that never runs.

**Fix (partial).** Corrected the two comments inside files this audit already modifies (`cla.yml`, `vitest.config.ts`). Rewriting CLAUDE.md §5/§13.4 and `docs/PAYMENTS.md` is an owner-authored change — it is a specification, not code — and is listed in `ACTION_REQUIRED.md`.

---

### <a id="oms-018"></a>OMS-018 — No HTTP-layer tests for the boot path — **REPORTED**
**Info · Confirmed · `packages/server/test/harness.ts`**

`freshApp()` returns `appRouter` and builds fake contexts; it never constructs a Fastify instance. Only three test files stand up real HTTP (`fabric.test.ts`, `fabricIdentify.test.ts` via `Fastify()` + `inject`, and `origin.test.ts`), and all three cover the Fabric provider.

Untested at the HTTP level, therefore: `@fastify/static` serving, the SPA `setNotFoundHandler`, `rewriteUrl` base-path stripping, the JSON content-type parser's empty-body path, `/api/logo`, `/api/public/appearance`, and `/statements/family/:id` — i.e. most of `index.ts` and every route that gates itself outside tRPC.

This is why [OMS-002](#oms-002) and [OMS-009](#oms-009) are deferred: the layer with no coverage is exactly the layer those changes touch. Closing this gap is the prerequisite for both.

---

### <a id="oms-019"></a>OMS-019 — "Full RTL / Arabic-ready" is plumbing only — **REPORTED**
**Info · Confirmed · `packages/web/src/lib/i18n/`**

CLAUDE.md §4 promises "i18n (i18next) + full RTL", §15 "every label goes through i18n (Arabic/Urdu-ready)" and a "bundled Naskh face for RTL". Actual state:

- Exactly one locale file, `en.json`. No `ar.json`, no `ur.json`.
- `lng: 'en'` hard-coded ([i18n/index.ts:21](../../packages/web/src/lib/i18n/index.ts#L21)).
- Language forced to English at boot, overriding any stored preference ([main.tsx:29](../../packages/web/src/main.tsx#L29)).
- No `dir` attribute set anywhere; `index.html` is `<html lang="en">` with no direction handling.
- Fonts bundled are Inter and Space Grotesk. No Arabic-capable face.

**This is not a defect.** The strings *are* all routed through `t()`, so the plumbing is genuinely ready, and the forced `patch({ language: 'en' })` is a correct, well-commented guard against a stale `ar`/`ur` in a returning browser's `localStorage` setting `dir="rtl"` on an English UI. English-only is a legitimate v1. The finding is that the documentation claims shipped capability where only groundwork exists — which matters when the deliverable is a madrasa product and someone plans a rollout around it.

---

### <a id="oms-020"></a>OMS-020 — `externalRef` accepts an unbounded object shape — **REPORTED**
**Info · Confirmed · `fabric/provider.ts:367`**

```ts
externalRef: z.record(z.unknown()).optional(),
```

Persisted as JSON on the immutable `payments` row. No key count, depth, or size limit; the only bound is Fastify's 1 MiB `bodyLimit`. A buggy or hostile consumer holding a valid app secret could store ~1 MiB per payment row, bloating the SQLite file and the 30-minute snapshots on a Pi.

Low practical concern — callers are secret-gated sibling apps — but the contract only ever needs four known keys (`stripePaymentIntentId`, `stripeChargeId`, `stripeAccountId`, `via`). Narrowing the schema to those, or capping serialized length, would be strictly better. Not fixed here: tightening an accepted request shape is a contract-adjacent change and belongs with the [OMS-015](#oms-015) cross-repo item.

---

## 4. Checked and found clean

Stating these explicitly, because "no finding" is a result:

- **SQL injection** — all 11 raw `sql` templates parameter-bound; no dynamic identifiers. Clean.
- **XSS** — no `innerHTML` / `dangerouslySetInnerHTML` / `eval` / `new Function` / `document.write` in 117 source files. The markdown changelog renderer produces React elements, never HTML. Every dynamic value in the one server-rendered page is escaped, including the parent-typed kiosk memo. Only [OMS-011](#oms-011) (unexploitable) found.
- **Secrets** — nothing in the tree; nothing in history across all branches for `sk_live`, `sk_test`, `rk_live`, `whsec_`, `AKIA`, `ghp_`, `github_pat_`, or PEM headers. Every hit is a test fixture or a prefix check. `.gitignore` and `.dockerignore` both exclude `.env*` and `data/`; `git ls-files data` is empty. Stripe secret keys live in process memory only and are cleared on any reload failure ([stripe.ts:68-75](../../packages/server/src/payments/stripe.ts#L68-L75)).
- **Object-level authorization** — all 9 parent procedures taking an id call `assertFamilyAccess`; checked individually. `familyIdsForUser` resolves scope from `guardian_users` → `guardian_families` in the query. Admin/finance see everything by design (single-tenant).
- **Privilege escalation** — `getSession` re-reads the backing user on every request and uses the **live** role, so disabling an account or demoting a role takes effect immediately rather than at session expiry ([sessions.ts:68-75](../../packages/server/src/auth/sessions.ts#L68-L75)). SSO sessions are LAN-only, capped at 1 h, and the platform-supplied username is treated as untrusted display text.
- **Password storage** — argon2id, 19 MiB / t=2 / p=1, 12-char minimum, constant-time verify, and a cached decoy hash so an unknown username costs the same time as a known one.
- **Enumeration oracles** — `login`, `resetRequest`, `register`, `identify`, and `lookup` all return uniform responses. `resetRequest` and `register` deliberately do not `await` the mail send so a match does not take observably longer. `resetRequest` resolves ambiguous email matches to *no* account rather than guessing.
- **CSRF** — SameSite=Lax + HttpOnly + tRPC's `application/json` requirement (the sole registered body parser, so a cross-site form POST 415s). No state-changing plain route accepts a form content-type.
- **Idempotency / money correctness** — `payments.idempotency_key` UNIQUE; every derive-a-split caller checks `recordedSplit()` *before* deriving (the comments explain precisely why re-deriving would double-record); reversals are mirrored per line so pairs net to zero; property-based tests assert money is never invented or lost, one child's money never lands on a sibling's bill, and re-running allocation is a no-op. Directed-line over-allocation is prevented by the `slot.need` cap even when a caller sends duplicate item ids.
- **CSV injection** — `csvCell` prefixes `=`, `+`, `-`, `@`, tab, and CR with `'`, then quotes structurally, **in that order** so the guard lands inside the quotes. Correct, and correct for the right reasons.
- **SSRF** — all four outbound helpers target `config.omosBaseUrl` (env-set) or `api.stripe.com`. Every one uses `redirect: 'error'` with an `AbortController` timeout. No user-controlled URL reaches a fetch.
- **File upload / path traversal** — no multipart handler and no upload route exist. The only user-supplied binary is the logo data URI: bounded to 512 KB, magic-byte checked, SVG excluded, re-validated on read.
- **Rate limiting** — six distinct limiters on login, invite-accept, reset-request, reset-confirm, self-register, and the per-Student-ID lockout. All keyed on the unspoofable peer or the supplied code, all bounded at 50,000 keys with oldest-first eviction so a distributed flood cannot exhaust memory on a Pi, and eviction only ever *forgives* a counter.
- **PII in logs** — the logger is 23 lines and every call site passes ids, counts, and event names. Fabric bodies, mail bodies, tokens, and key material are never logged. Alert texts carry two variants so the household name reaches only admin-typed addresses and never the webhook or platform channel.
- **Prototype pollution / unsafe deserialization** — no `Object.assign` onto prototypes, no `merge` helpers, no `JSON.parse` into a spread over user keys. All `JSON.parse` of stored settings is wrapped in try/catch with an allow-listed fallback.
- **Numeric validation** — every money input is `z.number().int()` with explicit min and max; `amountCents` is bounded at 100,000,000. `recordPayment` throws on a non-positive amount. No float arithmetic in the ledger.
- **ReDoS** — all regexes are anchored and linear; no nested quantifiers. `PERIOD_RE`, the logo data-URI regex, and `FORMULA_LEAD` are all safe.
- **Domain correctness** — no prayer times, Hijri dates, Qibla, or Zakat in this repo. The equivalent domain risk is money and period math: verified. `formatMoney` divides by 100, which is correct for all four currencies the enum permits (`usd`/`cad`/`gbp`/`eur`); a 0- or 3-decimal currency would need it changed, and the enum is what prevents that today. Period keys are format-locked to `YYYY-MM` with an explicit guard against `2027-2` double-billing February, and `carry-in` is reserved. Autopay is capped at the family's derived balance so a credit can never be charged to a card. The retry ladder's `addDays(runDate, failureCount === 1 ? 2 : 3)` looks off by a day but is right — it compounds from the previous attempt's date to give +2 then +5 overall.
- **Hygiene** — 117/117 source files carry SPDX headers; AGPL-3.0 `LICENSE` present with CLA; **zero** TODO/FIXME/HACK markers.
- **Container hardening (compose)** — `cap_drop: ALL`, `no-new-privileges:true`, `tmpfs: /tmp`, named volume, no `docker.sock`, no `privileged`, no host networking, digest-pinned image reference.
- **CI secret exposure** — no secrets echoed. `cla.yml` uses `pull_request_target` but runs only a SHA-pinned action and never checks out or executes PR code; the elevated permissions are documented and justified in the file.

---

## 5. Coverage and gaps

**Fully reviewed:** every file in `packages/server/src` (55 files) and the security-relevant parts of `packages/web/src`; all 31 migrations for FK actions and indexes; `Dockerfile`, `docker-compose.yml`, `manifest.yaml`, both workflows, `.gitignore`, `.dockerignore`; both lockfile audits; git history across all branches for secret patterns.

**Runtime access arrived after the audit** (WSL2 Ubuntu 26.04 + Docker 29.6.2, 2026-08-04), which closed gaps 1 and 2 below in part. What that added:

- **The released v0.45.1 artifact is verified end-to-end.** Pulled by digest (`sha256:a0332756…`, 131 MB, linux/amd64), booted on a fresh volume with `cap_drop: ALL` + `no-new-privileges`: `/healthz` → `{"ok":true}`, migrations applied, `students.db` + WAL + snapshot on the volume, SPA served, standalone mode correct, no `ERROR` lines. Critically it **reports `"version":"0.45.1"`** — the §19 drift bug (0.41.0 and 0.42.0 both claiming 0.40.0) is genuinely closed, not just asserted by a test.
- **[OMS-007](#oms-007) is now fully characterised** — including that this report's original fix recommendation was wrong. See that finding.
- **The test suite runs on Ubuntu with a Linux `better_sqlite3.node`** (ELF x86-64, SQLite 3.53.2, Node v22.23.2), matching CI and the container rather than approximating on Windows. 527 tests green there.
- **[OMS-023](#oms-023)** was found only by booting the image — a Fastify deprecation that no test surfaces.

**What remains unassessed:**

1. **No browser, no Stripe test mode.** The UI was never driven, and no card was charged. Anything needing a real payment round-trip — Elements, SCA, the autopay ladder against live Stripe — is still unverified either way.
2. **The multi-arch build was not reproduced locally.** The published index carries `linux/amd64` + `linux/arm64` and I verified both are present, but only amd64 was executed; nothing here ran on arm64 hardware, which is the actual Raspberry Pi target. [OMS-009](#oms-009) stays deferred for that reason.
3. **`@fastify/static` traversal was not attempted.** Its advisories were assessed as unreachable by configuration, not by exploitation; that reasoning is unchanged and untested.
3. **The OS platform is a black box.** `/api/fabric/{session,email,alert,notify,site,stripe}` behaviour is taken from this repo's comments. Notably, [OMS-016](#oms-016)-style silent failure already bit this app once via the platform's alert allow-list.
4. **Consumer repos not read.** Donations and Kiosk are being audited in parallel; whether they actually send a correct `currency` ([OMS-015](#oms-015)) or call `identify` before `lookup` is unverified here.
5. **The Stripe account is untouched.** No API calls, no webhook config inspection, no key validity check — Tier 3 by instruction.
6. **Dependency advisories are as reported by `npm audit` on 2026-08-04.** I did not independently confirm each GHSA's technical details; where reachability mattered I reasoned from the advisory *class* and this codebase's configuration, and said so. No CVE or GHSA identifier in this report is invented — every one is quoted verbatim from `npm audit` output reproduced in `REMEDIATION.md`.
