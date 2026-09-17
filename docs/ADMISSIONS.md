<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# ADMISSIONS — inquiry → waitlist → offer → admission → re-admission

> **Status: BUILT (0.52.0-dev.7 → -dev.17).** This is Phase 2 of the academic layer (CLAUDE.md §4a). It
> was written before the code deliberately — the same discipline `docs/PAYMENTS.md` and
> `docs/WHATSAPP.md` follow — so the schema and the wire rules were argued once, in one place, rather
> than discovered per screen. It now describes what exists.
>
> **dev.7:** every table in §1 (migration 0044, verified against a live database holding students,
> invoices, payments and charges); the **public inquiry endpoint** of §2 in full, including the
> limiter hardening it depended on, which shipped a build earlier as the security fix it also was;
> the **pipeline** of §3, in `admissions/transition.ts`; the office's desk and its settings; and the
> `admissions-inquiry` alert of §6.
> **dev.8:** §4, **conversion** — `admissions/convert.ts` and `admissions/fees.ts`.
> **dev.9:** §5, **re-admission** — `admissions/readmission.ts`, the family's one-time link through
> the extracted `auth/tokens.ts`, and the office's diff.
> **dev.11:** the pipeline cut from seven states to four, a decline made reversible, and an inquiry
> made deletable (Hasan's review).
> **dev.12:** §3a, the **admission form** a family fills in — `admissions/admissionForm.ts`.
> **dev.13:** §3a.1, **tablet mode** — the device token, the picker, and the LAN-only default.
> **dev.14:** the embeddable widget rebuilt to render INTO the host page (it injected an iframe
> before, which is why it never blended), the CORS allowlist that makes its cross-origin POST
> possible, and per-field required marking on both forms.
> **dev.17:** the two dev.16 regressions — the public form's required list no longer gates the
> office's manual entry, and an inquiry is never born invisible to the person who typed it (the
> adder's own school fills in; a single-school install assigns its only one). The hosted page also
> tells a family which required box they missed, which the widget already did.
> **dev.16:** admissions scoped to `user_schools` (a restricted admin is a school's own person, an
> unrestricted one is the global level that routes); the joining-fee and ask-the-families steps
> folded into the EXISTING rollover rather than a second button; landscape; the attribution line;
> and the tablet's link built from the LAN address it is actually reachable at.
> **dev.15:** opening a year for re-admission moved into Structure's **Start a new year** flow,
> where it sits after naming the year and setting what it costs to join — the order an office does
> it in. The board in Admissions still tracks who has answered; it no longer opens.
>
> Two things this phase changed OUTSIDE admissions, both of which removed a copy rather than adding a
> place: `createStudentRow` moved to **`people/create.ts`** (the one implementation of "create a
> student", and therefore the only place a Student ID is minted), and one-time link tokens moved to
> **`auth/tokens.ts`**, which invites and password resets now share.
>
> Still deferred, by decision rather than omission: an enrollment-fee payment BEFORE a student record
> exists (§4's "charged on enrollment, not pay-to-confirm"), a capacity limit on the waitlist
> (decision 7), and document uploads at admission (decision 8 / §4 ❌).
>
> Owner sections in `CLAUDE.md`: §4a (scope), §5 (roles), §9 (data rules), §12.4 (origin), §14
> (the public endpoint), §16 (one place decides).

---

## 0. What this is, and the one thing it must never become

A funnel a family walks: they ask, the office decides, a form comes back, and a
**student record exists at the end of it**. Everything before that last step is a record of a
conversation, not a child on the roster.

**The single hardest rule in this phase: an inquiry is not a student and not a household.** It has its
own table, it never mints a Student ID, it never appears in the directory, it is never billable, and
nothing in the ledger can see it. The Student ID is minted at **conversion** and nowhere else. Every
shortcut that would be convenient here — "just create the student as pending", "reserve the ID now" —
puts an unconfirmed, publicly-submitted record on the payment path (§11.2, §14), which is the exact
surface this app spent three releases narrowing.

The second hardest rule: **the enrollment fee is raised through the charge machinery that already
exists**. Admissions opens no new path into the ledger, touches no invoice code, and changes nothing
in the Fabric contract (§11). If a design here seems to need its own money path, it is wrong.

---

## 1. The tables

Seven new tables. Names are final; column lists are the spec the migration implements.

### 1.1 `inquiries` — the conversation

| Column | Notes |
| --- | --- |
| `id` | |
| `school_id` | which program they are asking about; scopes nothing else (§9's school rule) |
| `school_year_id` | the year asked about — nullable, because a family may ask before the year exists |
| `child_name` | one field, same reasoning as `students.full_name` |
| `child_dob` | optional ISO day, validated by `isIsoDay` like every other date on a write boundary |
| `asked_about` | free text ("Hifz 1", "the Sunday class") — **not** an FK, because a stranger typing into a public form must not be able to probe which classes exist |
| `parent_name`, `email`, `phone`, `message` | the whole of the public field set (decision 9: fixed, not configurable) |
| `state` | `new \| waitlisted \| admission \| declined \| admitted` |
| `source` | `public \| office` — an office can enter a walk-in inquiry |
| `waitlist_position` | integer, nullable; only meaningful in `waitlisted` |
| `waitlist_reason` | the office's own words, shown on the waitlist screen |
| `submitted_payload` | JSON — what came back from the admission form, held inert until conversion |
| `student_id`, `family_id` | nullable; set **only** at conversion, and are the answer to "when did they first ask?" |
| `created_at`, `updated_at` | |

`state` is **stored truth, never derived** from the presence of other records. A `student_id` that is
set does not make the state `admitted`; the transition does, and the transition is what is audited.
Deriving state from side-effects is how a half-failed conversion becomes a record that reads as
successful.

### 1.2 `inquiry_events` — the trail the office reads

`id`, `inquiry_id`, `from_state`, `to_state`, `reason`, `actor_user_id`, `actor_name`, `created_at`.

**This deliberately duplicates a facet of `audit_log`, and the reason is recorded rather than glossed:**
§5 states plainly that *nothing reads the audit log* — it is forensic, reachable with `sqlite3`, and has
no procedure and no screen. The admissions screen needs "who declined this and why, on what day" as a
product surface. Widening `audit_log` into a read surface is a bigger and separate change (and one worth
making one day). Until then a transition writes **both** rows: the audit row because §14 requires it, and
the event row because the office has to see it. `admissions/transition.ts` is the one place that writes
either, so they cannot disagree.

### 1.3 `admission_links` — the one-time token

`id`, `token_hash` UNIQUE, `kind` (`admission | readmission | kiosk`), `inquiry_id` (nullable),
`readmission_id` (nullable), `created_by_user_id`, `created_at`, `expires_at`, `used_at`.

**Reuses the existing token machinery rather than inventing a second one** — CSPRNG, single-use,
expiring, stored **hashed** exactly as `invites` and `password_resets` are (§14). Do not copy the code;
extract what `auth/invites.ts` already does into something both call, because a second token
implementation is a second place to get expiry, single-use or hashing wrong.

### 1.4 `readmissions` — one row per returning child per year

`id`, `student_id`, `school_year_id`, `state`, `submitted_payload` (JSON), `fee_override_cents`
(nullable), `fee_waived` (0/1), `reminded_at`, `submitted_at`, `approved_at`, `approved_by_user_id`,
`created_at`, `updated_at`. **UNIQUE `(student_id, school_year_id)`** — the whole idempotency story for
a flow whose normal mode of use is "bulk send to 300 families, twice, because the first send half
worked".

States: `pending → submitted → approved → enrolled`, plus `not_returning` and `lapsed`.

### 1.5 `enrollment_fees` — what a year charges

Two integer-cent columns on **`school_years`** rather than a table:
`admission_fee_cents` and `readmission_fee_cents`, both nullable (null = no fee, which is a normal
madrasah). Per-family waive/override lives on the `inquiries` / `readmissions` row as
`fee_override_cents` + `fee_waived`, mirroring `student_fees.override_amount_cents` — the precedent
this app already has for "hardship is real".

### 1.6 `charges.source_key` — the natural key that stops double-charging

Not a new table: a new nullable **UNIQUE** column on `charges`.

Today `charges` has two indexes and neither is unique, and `billing.chargeAdd` inserts with a fresh id
and no existence check — while bulk *fee-plan* assignment three hundred lines away does check first.
Re-approving a re-admission would therefore charge a family twice, silently, and the natural time for
that to happen is the fortnight when the whole school re-enrolls.

So: `source_key TEXT UNIQUE`, null for everything a human raises by hand (SQLite permits many NULLs in
a UNIQUE column — the same property `students.student_code` relies on). Admissions passes a
deterministic key:

```
admission:<inquiryId>
readmission:<studentId>:<schoolYearId>
```

Raising a charge that already has that key is a **no-op returning the existing charge**, not an error —
the caller is a bulk approve button and "already done" is a success. This column belongs to `charges`
and not to admissions, because the next feature that raises money on a schedule will need it too.

---

## 2. The public inquiry endpoint

**This is the only new unauthenticated write surface in the whole academic layer, and it stays that
way.** Everything else in admissions and academics requires a session. Written out as invariants because
each one is load-bearing (§14):

**Transport.** Plain Fastify routes, registered before the SPA fallback alongside `/fabric/*` and the
printable documents, and **excluded from the tRPC role/origin middleware** — which is exactly why each
one below is stated explicitly instead of inherited:

| Route | What it is |
| --- | --- |
| `POST /public/inquiry` | the write. JSON only, its own body cap well under the app's 1 MiB. |
| `GET /public/inquiry` | the standalone hosted page, for a masjid that wants a link rather than an embed |
| `GET /public/inquiry.js` | the one-line embed snippet that injects the iframe |

It is **not** a Fabric capability and must never appear under `/fabric/*` — that prefix is
secret-gated, LAN-only and 404s over the tunnel (§11.1), which is the opposite of what this needs.

**The origin table gains a row** (§12.4): the public inquiry routes are reachable on **LAN and tunnel**,
unauthenticated, and that is the point of them. Nothing else moves. Admin stays LAN-only at login and at
session use; reading an inquiry inside the app is `adminProcedure`.

**Non-disclosure.** The response is byte-identical every time: same acknowledgement, same status, same
shape, whether the submission was stored, deduplicated, rejected by the honeypot, or dropped by the rate
limiter. Submitting must never reveal whether a child, an email, a household or a Student ID already
exists — this is the same "no enumeration oracle" rule `lookup` follows (§11.2), applied to a surface
that has no lockout to fall back on.

**Anti-abuse, in layers, none of which needs the internet** (this app must work on an install with no
outbound connectivity, so no third-party captcha by default):

- A **honeypot** field, and a **minimum time-to-submit** (a form completed in under ~3 seconds is a bot).
- **Rate limits per IP and globally.** **BUILT, 0.52.0-dev.6, ahead of the form.** The per-IP key is
  folded to its /64 in `security/origin.ts` `rateLimitKey`, the one place a request becomes a limiter
  key — `clientIpFrom` returned the full address, so one /64 was 2^64 distinct keys, and there is now
  no exported raw-client-IP helper for a later limiter to key on by mistake. Eviction in
  `security/rateLimit.ts` no longer drops a live block (dead entries first, then unblocked ones), and
  a map that saturates with live blocks stops admitting new keys rather than growing: `SubmitLimiter`
  fails **closed**, `LoginLimiter` stops tracking. The old flood test, which asserted the forgiving
  behavior, is inverted. It was a live defect rather than only a prerequisite: `codeLookupLimiter` is
  keyed on the Student ID the caller supplies, so sweeping the ID space generated the flood for free.
  `DailyCeiling` lands in the same file for the whole-install cap below.
- **Field-length caps server-side**, and a body cap on the route, not just on the app.
- A **global daily ceiling** per install, above which the form answers the same acknowledgement and
  stores nothing. A flooded office is a broken office.

**Embedding.** `frame-ancestors` comes from an **origin allowlist in Settings**, never `*`, and the
hosted page sets `frame-ancestors 'none'`. The office can switch embedding off entirely — the same
shape as the external-payments switch — and can **close inquiries for a year** once intake is done, with
the form then saying so plainly rather than silently discarding.

**Storage and display.** Everything submitted is **inert text**: stored as typed, escaped at every
render, never interpolated into a printable document or an email without escaping, never `dangerouslySet`
anywhere. The printable documents already run under a `default-src 'none'` CSP (§14) and inquiries must
never be printed through a path that relaxes it.

**Logs.** Nothing submitted through this form appears in a log line — not the name, not the email, not
the message, not a truncated preview. The route logs an event and a count. This is §14's "no PII in
logs" with one addition worth saying out loud: **the inquiry body is attacker-controlled**, so logging it
would also make the log a place to inject.

**Alerts.** A new inquiry raises `admissions-inquiry` through the existing `alerts/index.ts` fan-out.
Like every alert it carries two texts, and `publicText` — the masjid webhook and the OpenMasjidOS alert
channel, both third-party sinks — **names nobody**: "1 new admission inquiry". The naming `text` goes
only to the addresses an office typed. The per-event webhook-naming exception (§9) is **not** granted to
this event: consent to being told a payment landed is not consent to publishing the name of a child
whose family only asked a question.

---

## 3. The pipeline

```
new ──┬──▶ waitlisted ──┬──▶ admission ──▶ admitted   (conversion — a student exists)
      │                 │
      └─────────────────┴──▶ declined ──▶ new (reopened)  ·  or deleted for good
```

**FOUR STATES AND A TERMINAL ONE — cut down from seven in 0.52.0-dev.11, on Hasan's instruction**
("there are so many tags, unnecessary tags… all we need is put them on waitlist or decline or move to
admission"). `reviewing` and `offered` described a conversation the app never witnesses — a phone
call, an interview — so they were either forgotten, and the board lied, or maintained as bookkeeping
for their own sake. A pipeline that asks to be groomed stops being used and the office goes back to a
notebook. `withdrawn` and `declined` were two words for one outcome. What is left is only what the app
can act on.

`new` **draws no tag at all**: an inquiry that arrived and has not been touched is the ordinary case,
and labelling the ordinary case is what made the board noisy.

`admission` means the admission form has been issued to the family — the one state that exists because
of something the app itself did.

**`admitted` IS REACHABLE FROM EVERY LIVE STATE, and that is deliberate.** A family who walks into the
office and is admitted the same morning should not be walked through states nobody used. Nothing is
weakened by it: `admitted` still means a student EXISTS, and the only way to apply it is still
`markAdmitted` from inside conversion's own transaction.

**`declined` is terminal but is not a dead end.** It can be **reopened** — a family that said no in
March and rang back in August is ordinary, and without a way back the only remedy was to delete the
record and re-type it from memory, losing the date they first asked. And it can be **deleted for
good** (`admissions.remove`): admin-only, refused on `admitted`, with the audit row written FIRST
carrying the child's and parent's names and *never the message body*. Retaining every refusal forever
was this app's own choice, not a requirement, and an office that cannot clear a test row or a piece of
abuse is an office that stops opening the board. Migration 0045 maps the old states
(`reviewing`→`new`, `offered`→`admission`, `withdrawn`→`declined`) and deliberately does **not**
rewrite `inquiry_events`: the trail records what actually happened, and editing history so it matches
a later vocabulary is how a trail stops being evidence.

Every transition records **who, when, and why**, in `inquiry_events` and in `audit_log`. `declined` is
terminal but the record is retained — an office asked "did we ever hear from them?" needs an answer.
Offering from the waitlist is the **same transition** as offering from review; it closes the gap behind
it by renumbering the positions below in one transaction.

**Waitlist** (decision 7): **manual ordering, no capacity.** Classes carry no capacity today, and adding
one means enforcing it in rollover, bulk class assignment and admission — three paths that currently
cannot fail and would all gain a new failure mode. A visible position and a reason is what an office
actually works from. Reordering is audited. Revisit only if a madrasah asks.

---

## 3a. The admission form — what the family actually fills in

*Added 0.52.0-dev.12, on Hasan's brief: "someone inquires online. And then we call them for like an
interview. And then once it works out… then you would give them the admission form."*

The inquiry is six boxes, deliberately (decision 9: a fixed, minimal public field set, because a
configurable public form is a configurable attack surface). The **admission form is the real one** —
the thing a madrasah actually collects once it has decided to take a child — and it is a different
surface with a different threat model, because **nobody reaches it without being given something**.

### 3a.1 Two doors, two origin policies

| Door | Who opens it | Origin |
| --- | --- | --- |
| **The family's link** | a parent, on their own phone, from a one-time URL | LAN **and** tunnel |
| **Tablet mode** | the office, on a device in the waiting room | **LAN only by default**, opt-in for remote |

Both carry a token, which is what keeps §14's "the public inquiry form is the only unauthenticated
write surface" true. The family's link is `admission_links` of kind `admission`, minted against the
inquiry through `auth/tokens.ts` — one-time, hashed, expiring, exactly like an invite.

**BUILT in 0.52.0-dev.13** — `mintKioskToken` / `kioskByToken` / `kioskInquiries` / `kioskForm` /
`submitAdmissionFromKiosk` in `admissions/admissionForm.ts`, two routes in `publicRoutes.ts`, and
`kioskStart` / `kioskList` / `kioskRevoke` on the router. The origin check is written out at the top
of BOTH handlers rather than inherited, because there are no Fastify hooks in this repo, and it calls
the same `classifyOrigin` the tRPC middleware consults so tablet mode cannot drift from the policy
the rest of the app enforces. Gating only the page and not the POST would leave the write open to
anybody who had once seen the URL; a test asserts both.

**Tablet mode carries a DEVICE token instead**, because the two situations are not the same. A link is
addressed to one family and expires when used; a tablet stands open all morning and is handed to
whoever walks in. So an admin starts tablet mode from inside the app, which mints a revocable device
token listed in Settings, and the device carries that. **Not an admin session** — the obvious
implementation is to leave the app signed in on the tablet, and then the whole student directory is
behind the back button of a device you just handed to a stranger. What the device token buys is the
names of families with a live inquiry, and the right to submit one admission form against one of them.

LAN-only is the default for it on Hasan's instruction, and the reason is that the network is what
replaces the addressing: nobody is holding a per-family token, so being inside the building is the
control. An office whose tablet cannot reach the LAN turns on remote access explicitly.

### 3a.2 It is PRE-FILLED from the inquiry, and that is why you pick the family first

*"There should be an option to select which student the admission form is for because I wanted to
pre-fill the fields from the inquiry form."*

A family that has already typed their child's name, date of birth, their own name, email and phone
into the inquiry must not be asked for all of it again — that is the difference between a form that
gets finished and one that gets abandoned. So opening the form always starts by naming an inquiry:
the family's link carries it in the token, and tablet mode shows a picker of live inquiries. A
**A WALK-IN WITH NO INQUIRY IS NOT HANDLED BY THE TABLET, and that is a narrowing made on the way
in** (0.52.0-dev.13). The picker lists inquiries that already exist; a family nobody has heard of is
typed in by the office first — `officeAdd`, thirty seconds, already audited as an office action.
Letting a tablet MINT records would make it a surface that CREATES rather than one that proposes,
which is a different thing to reason about and not what a clipboard is for.

### 3a.3 The fields are the Phase 1 registry, not a second list

`people/fields.ts` already answers "does this field exist, has the office switched it off, and who
may see it" (§16, CLAUDE.md §9). The admission form asks it, rather than hard-coding a field list that
would drift from the student record the moment either changed. Which fields are **required** is the
office's own answer, set in Settings — per field, for this form and for the inquiry form separately,
because a madrasah that wants a date of birth before it will consider a child is making a different
demand from one that wants it eventually.

**MEDICAL FIELDS APPEAR HERE IF THE OFFICE ENABLED THEM, AND THIS IS THE ONE PLACE A FAMILY EVER MEETS
ONE** (Hasan's explicit sign-off; CLAUDE.md §14 is amended, not excepted). The line that makes it
coherent is **providing is not disclosure**: a parent typing their child's allergy into an intake form
is telling the madrasah something, while a screen showing them what the office has since written about
their child is the thing the rule exists to prevent. So they are **write-only — nothing stored is ever
pre-filled into a medical box** — which is exactly why they are on the admission form, where the child
does not exist yet and there is nothing to show, and **not on the re-admission form**, which is
pre-filled by design and would hand a family the office's own notes.

### 3a.4 What comes back is a PROPOSAL, and nothing else

The submission is stored **inert** in `inquiries.submitted_payload` and changes no record. The office
opens it, reads what the family said, and **approves** — and approving is what runs §4's conversion.
This is the same shape re-admission already uses and for the same reason (§4 of CLAUDE.md: a family's
submission "lands as a proposal the office reviews as a diff before anything is written"), and it is
what keeps a token link from being a way to write onto a roster.

Re-submitting before the office has looked replaces the proposal rather than making a second one — a
family who realizes they mistyped a phone number should not need to ring up about it.

---

## 4. Conversion — the delicate step

`admissions/convert.ts` is the **one place** an inquiry becomes a student (§16). Everything below happens
in **one transaction**:

1. **Duplicate check first, before anything is created.** A younger sibling of an existing student must
   be offered the existing household, not silently given a second one. Reuse `people/siblingSuggest.ts`
   — do not write a second matcher.
2. Create the student through the **existing** `people` write path, which is what mints the Student ID.
   Never mint an ID anywhere else, and never at inquiry.
3. Guardians attach to the **household**, as they already do. Nothing is copied onto the child (§4).
4. Class placement goes through `structure/enrollment.ts` (Phase 3's one mover), so an admission in
   November opens an enrollment row dated November — which is what makes "the roster on that date"
   answerable later.
5. Fee plan assignment uses the **existing** assignment procedures. No new path into the ledger.
6. Raise the enrollment fee via `admissions/fees.ts` → the existing charge procedures, with
   `source_key = admission:<inquiryId>`.
7. Transition the inquiry to `admitted` and set `student_id` / `family_id`.

**Idempotent by construction**, not by a guard bolted on: a double-submitted form, a double-clicked
approve button and a retried request all find `inquiries.state === 'admitted'` (or the UNIQUE
`source_key`) and return the existing student. The test for this fires the conversion twice and asserts
one student, one Student ID, one charge.

**Enrollment fee timing** (decision 1): **charged on enrollment, not paid-to-confirm.** Pay-to-confirm
means accepting money for a child with no student record, which is a new entry path into the ledger —
the one thing this project rules out. If it is ever wanted it needs its own design pass and its own
answer to "what is the money attached to before the child exists".

---

## 5. Re-admission

A different flow, not a second trip through the funnel: the child, the household and the guardians
already exist.

- The office **opens re-admission for a school year** and generates it for a cohort — all active
  students, a class, or a hand-picked set. **Withdrawn students are excluded.** Reuse
  `structure/audience.ts`, which already answers "which students does this bulk action name" for mass
  fee apply and the onboarding send; a third audience resolver is the bug (§16).
- The form is **pre-filled from the current record** — the student's fields, the household, the
  guardians, the contacts — and the family (or the office on their behalf) edits what changed.
- What comes back is a **diff, not a blind overwrite**: the office sees before → after per field and
  **only changed fields are written**. A field the family left exactly as it was must produce no write
  at all, so `updated_at` still means something.
- **On sharing one confirm-and-apply mechanism with the importer** (the brief asks): the *types* do not
  transfer. `RowResult` carries no "before", is per-row atomic (`ok: errors.length === 0`), and commits
  all-or-nothing; a re-admission diff is one entity, field-level, applied selectively. What genuinely
  transfers is the **discipline** — validate twice, preview exactly what commit will do, and prove it
  with a test that runs preview and commit over the same input and asserts they agree.
- Approving rolls the student into the new year: class assignment for the new year (through
  `structure/enrollment.ts`), fee plan for the new year, status stays active. **The Student ID never
  changes and is never re-minted.**
- **Fee plan carry-forward** (decision 10): **the office reconfirms per child, pre-filled from the
  current plan and override, with the diff shown.** Carrying a hardship rate forward silently is how it
  quietly persists a year too long; dropping it silently is how a family gets a bill they cannot pay.
  Pre-fill makes the default cheap and the decision visible.
- **Bulk send, bulk reminder, bulk approve** — this happens to a whole school in one fortnight, and a
  screen showing **who has confirmed and who has not** is the actual job.
- `lapsed` is what a family that never responds becomes, by the office's action or a dated sweep —
  never an inference from silence at read time.

---

## 6. Email

All through the existing template and alert machinery (`mail/notify.ts`, `alerts/index.ts`), honoring
every existing gate: the master parent-mail pause, the WhatsApp pause and its test-student exception,
and per-event switches.

| Moment | Who | Channel |
| --- | --- | --- |
| Inquiry submitted | the family | email acknowledgement — says nothing about whether they are known to us |
| New inquiry | the office | alert `admissions-inquiry` (naming `text` to typed addresses; `publicText` names nobody) |
| Offer | the family | email carrying the admission link |
| Decline | the family | email, the office's own wording |
| Re-admission open / reminder | the family | email + WhatsApp, both off by default like every other event |
| Conversion complete | the family | the existing onboarding message and family sheet already cover this — do not add a fourth "welcome" |

**Nothing auth-critical travels by WhatsApp** (§14): the admission link is a token link and is therefore
**email or print only**, exactly like invites and resets.

---

## 7. Roles

Everything staff-facing here is **admin-only** and gated server-side (§5). **Finance does not reach
admissions records at all** — they are not money, and finance's wall is the one this app already holds.
Parents reach nothing here except by their one-time token link.

**The origin consequence, stated rather than worked around:** admin cannot authenticate over the
Cloudflare uplink, so the whole admissions desk is usable **only on the masjid network**. That is
correct and is not being weakened. What *is* worth building is the thing that turns a confusing 403 into
a sentence: when an admin sign-in is refused over the tunnel, name the LAN address to open instead.
`cf-ray` short-circuits before the IP is examined, so a phone on masjid Wi-Fi is still `tunnel` if it
reached the app by the bookmarked public URL — same device, same network, different door. Nothing in the
app tells anyone that today.

---

## 8. Tests that must exist before this phase is done

- Conversion is **idempotent**: fire it twice → one student, one Student ID, one charge row.
- An inquiry **never** mints a Student ID: assert no `student_code` is written in any state but
  `admitted`.
- The **enrollment fee is raised once**: approve twice → one `charges` row, and the second call returns
  the first one rather than erroring.
- The public endpoint **does not enumerate**: submit a known email and an unknown one → byte-identical
  responses.
- The public endpoint's **rate limiter does not forgive under flood**: the IPv6 /64 folding test, and a
  flood test that asserts a blocked key stays blocked (the inverse of `rateLimit.test.ts:55-63`).
- **Nothing submitted reaches a log**: capture the logger across a submission and assert the body's
  strings appear nowhere.
- The re-admission diff **writes only changed fields**, proven by mutation: unchanged fields keep their
  `updated_at`.
- Preview and commit **agree**, over the same input.
- **Admin gate on every new procedure**, and the role × origin matrix for each (§18): a finance session
  gets `FORBIDDEN`, an admin session over simulated tunnel gets 403.
- `publicText` for `admissions-inquiry` **names nobody** — and watch for the vacuous version of this
  assertion (`test/pastDue.test.ts` has the scar: a helper that named the child after the household made
  "the household name is gone" pass on a substring).
