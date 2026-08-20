<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->
<p align="center">
  <strong>OpenMasjid Students</strong><br/>
  Tuition &amp; fee management for your madrasa — pay online, at the kiosk, or on the donation site.
</p>

<p align="center">
  <em>A self-hosted tuition/fee app that runs as an <a href="https://github.com/OpenMasjid-Solutions/OpenMasjidOS">OpenMasjidOS</a> app — one Docker container, all data on the masjid's own hardware.</em>
</p>

---

**OpenMasjid Students** is the madrasa's tuition desk. The office keeps its **students and
households**, assigns **fee plans per child**, and generates **one invoice per child** each
month or term. The **office or finance manager** records cash / Zelle / check payments against
the child they were paid for and sees the whole ledger; **parents** get a phone-first portal
showing what each child owes, one combined household balance, and one payment history — and
they can **pay by card in the app (Stripe)**, with **saved cards** and **autopay**.

Every student gets an auto-generated **Student ID** (`YUS1234`), unique per install. It is how a
parent pays without an account: type the ID on the masjid's **OpenMasjid Donations** site or
**OpenMasjid Kiosk**, confirm the name it shows back, and pay for any of their children from that
one screen. Those payments land in the same ledger over the OpenMasjidOS **Fabric** — this app
*provides* the `students/billing` capability those apps consume
(see [`docs/FABRIC_BILLING_CONTRACT.md`](docs/FABRIC_BILLING_CONTRACT.md)).

> **Tuition, not academics.** This app was deliberately narrowed to fees and money in v0.35.0.
> There is no attendance, gradebook, report cards, transcripts, timetable or admissions pipeline,
> and no teacher or student login — those were removed and stay out. Courses and classes exist
> only as **labels** for grouping students on the roster and applying fees in bulk.

---

## What it does

The complete feature set, by area.

### Students

- **One name field per student** — many madrasa names do not split into two western halves, so
  the app stores one authoritative `fullName` and *derives* everything it needs from it.
- **Auto-generated Student ID** at registration (first three letters of the name + 4 digits, e.g.
  `YUS1234`), **unique per install**, retrievable by design because it is printed on statements.
  Never chosen, never imported, no PINs.
- **Optional date of birth**, with age shown where it helps.
- **Status** — active or withdrawn; a withdrawn child stops appearing on payment paths.
- **Directory** with search, and a student picker used wherever a child must be chosen.
- **Backfill** for Student IDs, so an install that predates them fills every gap once and is a
  no-op forever after.
- **Deletion is pre-checked, not attempted-and-refused.** The app tells you exactly what a child
  is attached to *before* anything happens, and money-referencing records make it refuse.

### Households, guardians &amp; contacts

- **Households form by linking siblings — nobody is ever asked to name a family.** Add a child, or
  link an existing one to a sibling, and the two households **merge**; unlinking splits them again.
- **The household label is derived** from the children's surnames ("Ismail family", or
  "Farooqi / Ismail" when they differ), sorted so it never depends on who was added first.
- **Sibling suggestions** surface likely matches instead of making you hunt, and a whole sibling
  group can be linked at once.
- **Guardians attach to the household, not the child** — which is exactly why linking a sibling is
  what makes the parents' details apply to them. Nothing is copied per student.
- One guardian can span **several households** (blended families), and each household can carry
  several guardians. Link, unlink, update, and remove — with a removability pre-check.
- **Emergency contacts** per household: flag a guardian, or add extra contacts.
- **Spreadsheet import** — the office's own **.xlsx or CSV**, with the columns mapped on screen
  rather than forced into a template, guardians and siblings merged from continuation rows, dates
  read in the format you configured, and a **preview that names every row it would refuse** before
  anything is written. Committing is a separate step. (The .xlsx is read without a spreadsheet
  library — it is a ZIP of XML and the browser has both halves.)

### School structure (grouping only)

- **Schools**, for a masjid running more than one program on different calendars — a weekend
  maktab beside a full-time hifz school. A school scopes the **calendar and the class tree, and
  never the household or the money**: a family with a child in each is still one household, one
  balance, one portal login and one printed sheet. A staff account can optionally be limited to some
  schools, which narrows what they see and never widens what they may do.
- **School years** with a start and end month, so a year running Apr → Mar wraps into the next
  calendar year correctly. Set the current year, archive an old one, or delete an unused one.
- **A real year rollover** — promote classes and carry children forward into the new year, rather
  than a flag flip that leaves last year's roster in place.
- **Optional terms** within a year, so a `per-term` fee cadence means something concrete.
- **Courses → classes** as a two-level grouping, with archive, delete and a deletability check.
- **Assign a student to a class**, individually or in bulk, and list students by class.
- Deliberately **organizational only**: no teachers, no attendance, no grades, no capacity. These
  labels drive the roster, the year view, and applying fees to many children at once.

### Fee plans &amp; assignment

- **Fee plans** — a name, an amount in whole cents, and a cadence: `monthly`, `per-term`, or
  `one-time`. Archive a plan that is no longer offered; delete one nothing has used yet.
- **Assigned per student** (never per class enrollment), so each child's bill is their own.
- **Per-child amount override** — which is also how a **bursary, hardship rate or sibling
  discount** is expressed, since with one bill per child a household-level discount has nowhere
  honest to sit.
- **Bulk assign** a plan across a class or a whole year, and unassign just as easily.
- Fee plans are **admin-only to define**; finance can see them and assign them.

### One-off charges

- A **reusable catalog of charge items** — a book fee, a trip, an exam fee — created once and
  applied when needed, rather than retyped each time. Update, archive, or delete an unused one.
- **Add a charge to one child or to many at once**, list what has been charged, and **void** one
  that was a mistake.
- Charges appear as their own **lines** on the invoice, so a parent can see and pay them
  separately from tuition.

### Invoicing

- **One invoice per child per period** — the household still sees one combined balance and pays
  once, but the money always lands on the right child's record.
- **Generate** for a whole period (a month or a term) or for a single household on demand.
- **Automatic nightly generation** on a day of the month you choose, with a configurable due day.
  The job decides for itself whether today is the day, whether the month falls inside the current
  school year, and whether it has already run for this period — so **a missed night is caught up
  rather than skipped**, and a period is never billed twice. "Run now" is there too.
- **Statuses** — open, partly paid, paid, void — all *derived* from what has actually been paid.
- **Void** an invoice raised in error.
- **Itemised lines** with one canonical order (tuition → charges → credits), used by both the
  display and the allocator, so a balance never appears against the wrong line.
- **Year view** — a grid of every child against every month of the year, showing at a glance who
  has been billed and who has paid, with **configurable columns**.
- **Mid-year go-live.** A madrasa adopting this in February records what each child brings with
  them **exactly once**: a past-dated "balance carried forward" invoice if they owe, or a dated
  credit if they are ahead. You approve a **preview computed by the same code that then writes
  it**, the months before go-live are never generated, and the app afterwards refuses to generate
  them — because recording the autumn as one figure *and* generating September would bill the same
  arrears twice. Clearable if you get it wrong.

### The ledger

- **Every balance is derived** (`invoiced − paid`), never stored, so it cannot drift out of step.
- **Payments are immutable.** A correction is a **reversal row**, never an edit or a delete.
- **A payment belongs to one child** and auto-allocates to *their* invoices, **oldest due first**.
  Overpayment becomes **that child's credit** and comes off their next invoice automatically.
- **A household balance is simply the sum of its children's**, because one adult pays for all of
  them — and **one card charge covering several children is recorded as one row per child**, keyed
  so that a replay is a no-op per child.
- **Allocation is per line, and a payer's instruction survives.** When a parent chose lines — "this
  $50 is the book fee" — that choice is **stored on the payment** and re-honored every time the
  mapping is recomputed. Without that, the next invoice would silently undo it and the line they
  deliberately settled would read as outstanding again.
- **Re-allocation is a recompute, not an increment**, so money paid before a bill existed attaches
  itself the moment that bill appears.
- **Idempotent everywhere** — the same payment reference can arrive twice from any channel and the
  second one changes nothing.

### Recording payments

- **Recording a payment is the first thing on the billing screen**: type a few letters of a name or
  paste a Student ID, and the amount, method and date are right there. It doubles as a dropdown for
  browsing the roster when you are not sure how a name is spelled.
- **Manual channels** — cash, Zelle, check, or other — with the date it actually arrived and a memo.
- **Choose which lines a payment settles**, or let it allocate oldest-due-first.
- **"Recorded by"** names the staff member on every manual payment. Cash is the one payment nobody
  else can verify — no card, no Stripe record, nothing to reconcile against — so the office can
  answer "who took this?". Card payments say "Automatic". It shows on reversals and in the CSV too.
- **Reverse a payment** — a new row, fully audited, never a rewrite of history.
- **Refund a transaction**, grouped the way the parent actually paid. A card payment is refunded at
  Stripe *and* reversed on the ledger, in that order; cash is reversed on the ledger with the screen
  saying plainly that a person still has to hand the money over. Full refunds only — a partial goes
  back as a credit on the next bill — and a carried-forward balance is refused outright.
- **Past due, chased on a policy you set** — a grace period, a minimum worth chasing, and a cadence.
  A reminder goes to the parent naming which of their children is behind and for how much, and a
  digest goes to the office listing the students and their amounts. Reminders never restart a
  cooldown for a family nobody could actually reach.
- **Every channel goes through one ledger function**: cash, Zelle, check, other, the parent portal,
  autopay, the donation site, the kiosk, and a mid-year carry-in. The office *sees* the channel and
  the Stripe reference without doing anything to get them.

### Card payments, saved cards &amp; autopay

- **Pay by card in the parent portal** via Stripe Elements — the full balance, a chosen amount, or
  specific lines. **Paying ahead is allowed** even with nothing due (a term or a year up front),
  floored at a $1 minimum, and the surplus shows as credit.
- **Card details never touch this app's server.** Elements handles them in the browser; the server
  only ever sees Stripe ids. Saved cards store brand, last four and expiry — never a card number.
- **Saved cards** — add, remove, and **put them in order**: first choice, second, third. That order
  is the ladder autopay walks down on a decline, so a retry tries the *next* card rather than
  presenting the same declining one three times.
- **Autopay** per household: switch it on and the default card is charged when tuition comes due.
  Clear consent copy, and the consent timestamp is stored.
- **Decline handling** — a retry ladder rather than one attempt, an email to the parent on each
  failure with a "pay now / update card" link, and after the third failure autopay **switches
  itself off**, tells the parent, and **alerts the office**. A disabled enrollment is never charged.
- **A charge that never resolves is chased.** A run left pending — a lost confirmation, a browser
  closed mid-payment — is resolved against Stripe rather than being silently re-charged or dropped.
- **Autopay is its own tab**, with an offer on the portal's front page, and once it is on the same
  card tells the parent which card will be charged.
- **Daily reconciliation against Stripe** (plus a "Reconcile now" button) records any succeeded
  tuition payment that never reached the ledger — a browser closed at the wrong moment, a dropped
  call from the kiosk — with the date the money actually arrived, flagged as recovered and alerted
  to the office. **Money is never lost, only delayed.**
- Finance sees autopay status; an admin can force it off; a parent can cancel any time.

### Parent portal (phone-first)

- **My family** — every child with their Student ID and their own balance, each open **itemised**
  bill, and **one unified payment history** whatever channel it came from.
- A child with nothing due **says so**, rather than vanishing from a page that only lists debts.
- **Bills read as a statement until you choose to pay part of one** — tick boxes appear only after
  "choose what to pay", each bill is its own card with its lines indented beneath it, and the
  running total sits on the pay button. Everything starts ticked, so paying a whole bill is one tap.
- Lines already paid say so; a bursary shows as the deduction it is — both for information, neither
  payable.
- **Credit is shown** instead of a bare zero, so "paid ahead" never looks like "square".
- **The year at a glance** — the same grid of months the office sees, for their own children.
- **Turn WhatsApp messages off** for anyone on the household, and back on again.
- **Receipts by email**, worded as a *payment* rather than a donation — tuition is generally not
  tax-deductible.
- Own profile basics, and a password change that **signs out your other devices**.

### Paying without an account — kiosk &amp; donation site

- This app **provides** the `students/billing` capability that OpenMasjid Donations and OpenMasjid
  Kiosk consume, surfaced there as a **tuition campaign**: the tile lives in those apps, everything
  inside it is served from here.
- The flow is **Student ID → confirm the name shown back → see the balance → pay**, for any of that
  household's children from one screen. The name-confirmation step is what replaced the PIN.
- **Itemised bills reach those apps too**, so a parent at the kiosk can pay one line.
- **Pay-ahead** works there as well, with the same minimum as the portal.
- The office can **switch external payments off** entirely, and the campaign disappears.
- Everything crosses through the platform's broker — this app never talks to those apps directly.

### Statements, exports &amp; records

- **Four printable documents**, all HTML with a print stylesheet — no PDF renderer and no headless
  Chromium, so they stay Pi-friendly and print from the browser dialog an office already knows, and
  all of them read legibly in black and white on a masjid photocopier:
  - the **household statement** — balance, open bills, recent payments, **each child's Student ID**,
    a **QR code to the portal sign-up**, and a line telling parents they can pay with a Student ID at
    the kiosk or on the donation site;
  - the **household information sheet**, whose wording the office can rewrite in Settings;
  - the **per-child invoice**;
  - the **Student ID sheet by class**, for handing out at the start of a year.
  All carry the school's logo and color, and all are served locked down, since they contain Student
  IDs and payment history.
- **CSV export** of billing data, with spreadsheet **formula-injection escaping**.
- **An append-only audit trail** on every sensitive write — fee assignment, invoices, payments,
  reversals, autopay changes, role and account changes, settings, structure — recording who, when,
  and before → after. `recorded_by` is the *person* for money; the audit actor is the *account*.

### Accounts &amp; access

- **First-run setup** creates the first admin, on the masjid network by definition.
- **Staff accounts** — create, change role, disable, and reset a password. A forced password set on
  first login.
- **Two doors for parents**, both landing on the same guardian link:
  - **Invite** — staff pick a guardian and the app emails a one-time link (or prints it, if there
    is no mail); the parent sets their own password. Resendable.
  - **Self sign-up** — a child's Student ID **plus a guardian email already on file for that
    child**, then an emailed verification. The on-file address is the load-bearing half: an ID
    alone can only *pay*, so minting an account from one would be an escalation. Admin-toggleable.
- **Password reset** by emailed link, or an office re-invite when there is no mail. Staff can send
  a guardian a reset directly.
- **Single sign-on** from the OpenMasjidOS dashboard on the masjid network, treated strictly as an
  identity signal.
- Sessions are server-side with signed, HTTP-only cookies; login is rate-limited with generic
  errors; **changing a password signs out every other device but the one you changed it on**.

### Settings

- **School name**, **contact details**, an **accent color**, and a **logo** that appears on
  statements, on every email, and as the app's icon when it is installed on a phone.
- **Currency** per install (USD / CAD / GBP / EUR), and the **date format** the whole app displays
  and reads spreadsheet columns in.
- **The wording on a family's printed sheet**, so the office can say it their own way.
- **Which OpenMasjidOS Stripe account** to charge through, picked from the accounts the platform
  offers.
- **External payments** on or off — whether the kiosk and donation site may take tuition at all.
- **Parent self-registration** on or off.
- **Nightly invoicing** — on/off, the day of the month, and the due day.
- **Mid-year billing floor** — the period before which nothing may be generated.
- **Past-due policy** — the grace period, the smallest amount worth chasing, and how often.
- **WhatsApp** — on/off, the pause, which messages, country codes, the test student, the message
  wording, staff numbers, approved groups, and a log of what was queued.
- **Year-view columns**.
- **Send a test email** and **send a test alert**, so you can prove the plumbing works before you
  need it.
- A **platform link status** panel showing what the app can currently reach.

### Email &amp; alerts

- **Transactional email through the masjid's OpenMasjidOS mail provider.** This app has **no SMTP of
  its own and holds no mail credentials** — the platform owns the provider and the From address. A
  standalone install therefore sends nothing and degrades to links you can copy or print, which is a
  supported mode rather than a fault. Templates for invites, receipts, bills, autopay notices, card
  expiry, refunds, past-due reminders, password resets, alerts, and tests.
- **What parents are emailed** is a setting, per message: a receipt every time they pay — *however*
  the money arrived, including cash, a check or Zelle recorded by the office, and payments made at
  the kiosk or on the donation site — a bill when it is ready, a heads-up three days before an
  autopay charge, a warning when a saved card is about to expire, a refund notice, a past-due
  reminder, and a notice when a card is declined. Invites and password resets are not switchable and
  always send: they are the only way a parent can reach their account.
- **A master pause for all parent mail**, for an install being set up or a mistake about to become
  200 emails.
- **Who at the masjid gets told.** Add any address — the treasurer, the imām, a trustee — and tick
  which events it receives: autopay switching itself off, a declined card, a Student ID locked after
  repeated failed lookups, a payment recovered by reconciliation, a payment only partly recorded, a
  refund, the past-due digest, an account being ground by login attempts, the nightly invoice run, or
  every single payment. **An address is not an account and grants no access.** New addresses start on
  the events that cost money or hide a problem, because one email per payment is how somebody ends up
  muting the lot.
- **An alert can reach a person without the platform's help.** Alerts fan out five ways — the
  addresses the office listed (the app's own email), the OpenMasjidOS alert channel, the masjid
  webhook for routine events, a staff member's own WhatsApp number, and a staff WhatsApp group —
  because any one of them can be silently dead.
- Alerts **name the child and the amount** in the office's own copy, because a bill belongs to a
  child and a household total makes you go and look it up — and deliberately name **nobody** in
  anything sent to a third-party sink.

### WhatsApp (0.50.0)

- **Message parents on WhatsApp**, through the masjid's own self-hosted gateway in OpenMasjidOS —
  nothing passes through an outside company. The platform owns the connection and one paced queue
  shared by every app; this app never touches a gateway.
- **Seven parent messages**, each with its own switch on **both** channels: a bill is ready, a
  receipt, a past-due reminder, an autopay charge coming up, an autopay failure, a card about to
  expire, and a refund. Everything with detail in it still goes by email; a WhatsApp is the short
  note that says to look.
- **It starts switched off, paused, with nothing selected.** Set a **test student** whose household
  receives messages — by email as well as WhatsApp — while everyone else stays quiet, watch a real
  one arrive, then lift the pause.
- **Rewrite what every message says**, with the family, the children, the amount, the balance and a
  payment link available as tags, and a preview of exactly what a real family will read.
- **Staff alerts on a phone**, per account, and to a **WhatsApp group** an admin approved for this
  app — a finance group that gets every payment. A group is a staff channel: no parent message can
  reach one, and by default a group's alerts name nobody.
- **Parents opt out themselves** from the portal, for either parent on the household, and nobody in
  the office can override it.
- **One button asks the families with no email address for one**, naming their children and
  explaining why, with the wording editable and a preview.
- **Nothing about signing in ever goes this way** — invites, resets and verification links stay on
  email, which always works.
- **Ask the app for the numbers by WhatsApp**: an authorized admin messages `!students` and gets this
  month's takings, what is outstanding and how many students are behind. It answers with **counts and
  totals, never names** — a chat keeps its copy forever — and it cannot change anything.

### Running &amp; upkeep

- **A database snapshot every 30 minutes and at boot**, written to the data volume — including on a
  standalone install, which is the one nobody else is looking after.
- **Nightly invoicing at 02:00, autopay at 06:00, reconciliation at 07:00**, and a public-address
  refresh every 15 minutes so an invite link is never minted against a stale address. A failed tick
  logs and the next one recovers; a standalone install schedules only what makes sense without a
  platform.
- **`/healthz`** for the platform's health checks.
- **Appearance inheritance** — the app follows the OpenMasjidOS dashboard's light/dark theme,
  wallpaper and accent, relayed same-origin so a browser never has to reach the platform directly.
- **What's new** in the account menu after an update, built from the shipped changelog, so it works
  with no internet.
- **Installable on a phone** — a web manifest carrying the masjid's own name and logo, an iOS
  touch icon, and an install prompt on every signed-in surface. Parents get a home-screen icon;
  the office gets one too.
- Light and dark, RTL-aware layouts, reduced-motion honored, every string through i18next.

---

## Roles &amp; access

Three roles. Checks are enforced server-side on every procedure, not in the UI.

| | On the masjid network | Over the internet uplink |
| --- | :-: | :-: |
| **admin** — students, households, fee plans, structure, staff, settings | ✅ | ❌ **blocked** |
| **finance** — billing, the ledger, payments, statements | ✅ | ✅ |
| **parent** — own household only | ✅ | ✅ |

**Admin is network-only by design, at both login *and* session use** — a cookie minted on the
LAN is refused if it is later presented from the internet. Clean walls elsewhere: finance never
sees settings or staff management; parents can only ever reach their own household.

---

## Running it

Install from the **OpenMasjidOS App Store** — one click, nothing to configure first. The app
serves its web interface on host port **8360** by default (the platform picks another free port if
that one is taken) and keeps everything in one Docker volume at `/data` — the SQLite database and
its snapshots, which is the whole of the app's state.

School name, currency and the Stripe account are all set up **inside** the app, on first run and
in Settings — the manifest asks for no install-time answers.

> **Standalone-first.** With no platform, no internet uplink, no Donations/Kiosk and no mail, the
> app still fully works on the masjid network: students, households, fee plans, invoices, charges,
> the ledger, statements, manual payments, nightly invoicing and the database snapshots all
> function. Every integration degrades gracefully rather than blocking.

Card payments need Stripe keys, which the app fetches from OpenMasjidOS server-to-server; the
publishable key reaches the browser and the secret key stays in memory. **Card details never
touch this app's server** — Stripe Elements handles them in the browser and we only ever see
Stripe ids.

### Update channels

| Channel | Branch | Version | Image |
| --- | --- | --- | --- |
| **Stable** | `main` | `X.Y.Z` | `…/openmasjidstudents:X.Y.Z`, **digest-pinned** in the compose |
| **Development** | `dev` | `X.Y.Z-dev.N` | `…/openmasjidstudents:X.Y.Z-dev.N` — the exact build |

Pick the channel in OpenMasjidOS. Stable installs resolve an immutable `@sha256` digest, so a moved
tag can never reach them.

**Every dev build gets its own version and its own immutable tag**, which is what makes the
development channel a channel at all: the platform detects an update by comparing versions, so an
entry that declared the same version as stable and pointed at a floating `:dev` tag left nothing to
detect and nothing to update to. One caveat worth knowing if you run the dev channel: a prerelease
sorts *above* its own final release, so `0.50.0-dev.3 → 0.50.0` is not detected as an update and a
host coming off the dev channel stays put until the next patch.

---

## Security

The most sensitive app in the org: records about children, reachable from the internet, moving
money. The invariants that hold it together —

- **Admin cannot authenticate over the internet uplink**, by policy, at login and at session use.
- **Card data never reaches our server**; Stripe secret keys live in memory only, never on disk.
- **A Student ID is a payment credential, and it is guessable** — so the limiter is the control,
  not secrecy: six failed lookups in an hour lock that ID and alert the office, and `identify`,
  `lookup` and parent sign-up **share one lockout bucket** so failures cannot be laundered across
  them. Every mismatch answers identically, so nothing can be enumerated. IDs never appear in
  logs or in Stripe metadata.
- **The Fabric provider routes are secret-gated** with a constant-time compare, validate before
  they do anything, and are **never served to internet-origin requests**.
- **No PII in logs** — ids and event names only, never a name beside an amount.
- **Alerts carry two texts**: the office's own copy names the child and the amount, because without
  that it is unactionable; anything going to a third-party sink (a webhook, the platform alert
  channel) names nobody.
- **WhatsApp is treated as the weakest channel it is.** Nothing auth-critical is ever sent on it —
  no invite, no reset, no one-time code — because the number can be banned overnight and that day
  must not be the day nobody can sign in. No Student ID, no card details, and **no message body is
  ever logged or stored**, on any path including failures. A WhatsApp **command** reply answers with
  counts and totals and never a name, because a chat keeps its copy forever and the phone holding it
  can change hands.
- **Money is append-only**: payments immutable, balances derived, reversals instead of edits, and
  foreign keys that refuse to delete anything money references.
- Invite / reset / verification tokens are CSPRNG, single-use, expiring, and **stored hashed**.
- `/data` holds minors' PII and every payment record — treat backups of it accordingly.

Findings and remediation from the August 2026 audit are in [`docs/audit/`](docs/audit/).

---

## Develop

> **All work happens on the `dev` branch.** `main` changes only at a release. Confirm with
> `git branch --show-current` before making changes — see the branching policy in `CLAUDE.md`.

```bash
npm install          # all workspaces
npm run dev          # server on :8080, web (Vite) on :5173 proxying /trpc /api /fabric
npm run build        # typecheck + build web and server
npm run lint         # tsc --noEmit across workspaces
npm run test         # vitest — the ledger and allocation invariants, the access walls,
                     #   the Fabric contract, autopay, reconciliation, the origin policy, …
npm run image        # build the container locally as :local
```

Open http://localhost:5173 in dev. Simulate an internet-origin request — and so exercise the
origin policy — by sending a `cf-ray:` header.

TypeScript everywhere in strict mode; Fastify + tRPC over SQLite (WAL) via Drizzle; React 18 +
Vite with Tailwind v4. **All money is integer cents**, and all of it flows through one ledger
module. The design system is ported verbatim from OpenMasjidOS for visual parity — see
[`packages/web/PORTED_FROM_OPENMASJIDOS.md`](packages/web/PORTED_FROM_OPENMASJIDOS.md). Strings go
through i18next with RTL-aware layouts; English ships today.

**Docs:** [`CLAUDE.md`](CLAUDE.md) is the specification and the source of truth ·
[`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) ·
[`docs/PAYMENTS.md`](docs/PAYMENTS.md) ·
[`docs/FABRIC_BILLING_CONTRACT.md`](docs/FABRIC_BILLING_CONTRACT.md) — the cross-repo contract ·
[`CHANGELOG.md`](CHANGELOG.md)

---

## Acknowledgments

Created by **Hasan Ismail**, with immense help from **Qari Ijaz** and **Osman Sayed**.

<div align="center">
  <table>
    <tr>
      <td align="center">
        <a href="https://github.com/hasan-ismail">
          <img src="https://github.com/hasan-ismail.png?size=100" width="100px;" alt="Hasan Ismail"/><br />
          <sub><b>Hasan Ismail</b></sub>
        </a>
      </td>
      <td align="center">
        <a href="https://github.com/ijazshare">
          <img src="https://github.com/ijazshare.png?size=100" width="100px;" alt="Qari Ijaz"/><br />
          <sub><b>Qari Ijaz</b></sub>
        </a>
      </td>
      <td align="center">
        <a href="https://github.com/osayed0001">
          <img src="https://github.com/osayed0001.png?size=100" width="100px;" alt="Osman Sayed"/><br />
          <sub><b>Osman Sayed</b></sub>
        </a>
      </td>
    </tr>
  </table>
</div>

Resources for this project were generously sponsored by **[An-Noor Institute](https://www.annoorusa.org/)**, **[Rihlatul Ilm Foundation](https://rifusa.org/)**, and **[AsmaTec Inc.](https://asmatec.com/)**.

<div align="center">
  <table>
    <tr>
      <td align="center">
        <a href="https://www.annoorusa.org/">
          <img src="https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidOS/master/assets/An-noor2.png" width="120px;" alt="An-Noor Institute"/><br />
          <sub><b>An-Noor Institute</b></sub>
        </a>
      </td>
      <td align="center">
        <a href="https://rifusa.org/">
          <img src="https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidOS/master/assets/RIFbetter.png" width="120px;" alt="Rihlatul Ilm Foundation"/><br />
          <sub><b>Rihlatul Ilm Foundation</b></sub>
        </a>
      </td>
      <td align="center">
        <a href="https://asmatec.com/">
          <img src="https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidOS/master/assets/Asmatec.png" width="120px;" alt="AsmaTec Inc."/><br />
          <sub><b>AsmaTec Inc.</b></sub>
        </a>
      </td>
    </tr>
  </table>
</div>

May Allah reward everyone who made it possible.

---

## Status

Active development. See [`CHANGELOG.md`](CHANGELOG.md) for what has landed.

## License

[AGPL-3.0-only](LICENSE). Contributions are governed by the
[CLA](CLA.md) — see [CONTRIBUTING.md](CONTRIBUTING.md).
