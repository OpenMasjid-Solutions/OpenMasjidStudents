<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# ACADEMICS — subjects, teachers, assessments, marks, hifz, and report cards

> **Status: SPECIFIED, NOT BUILT.** Phases 4 and 5 of the academic layer (CLAUDE.md §4a). Nothing
> here exists in the code yet.
>
> Owner sections in `CLAUDE.md`: §4a (scope), §5 (roles), §9 (data rules), §14 (report cards are
> minors' records), §16 (one place decides), §18 (done).

---

## 0. The discipline this borrows

The gradebook is the ledger with different nouns, and the ledger's rules are the right ones:

| Money | Academics |
| --- | --- |
| all money in **integer cents**, never floats | all marks in **integer points** with a stored maximum, never floats |
| **balances derived, never stored** | **percentages, averages and grades derived, never stored** |
| payments **immutable**; corrections are reversal rows | marks **correctable**, and every correction audited before → after |
| one `billing/ledger.ts` does the math | one `academics/derive.ts` does the math |
| one `billing/lines.ts` decides what a bill is made of and in what order | one place decides what a report card is made of and in what order |

A stored average drifts the moment a mark is corrected, exactly as a stored balance does — and it drifts
silently, which is the part that costs.

---

## 1. Phase 4 — the tables

### 1.1 `subjects`

`id`, `school_id`, `name`, `kind`, `sort_order`, `status` (`active | archived`), timestamps.
UNIQUE `(school_id, name)` — "Level 1 Qur'an" can exist in the maktab and in the hifz program, exactly
as courses are unique per school and not per install (§9).

`kind` is `graded | pass_fail | narrative`. This is decision 4's other half: **one grading scheme per
install, plus a per-subject type**, which covers hifz and adab without a second scheme. A `narrative`
subject carries a comment and no number; a `pass_fail` subject carries one of two states; only a
`graded` subject reaches the bands.

Per-install configurable, never hard-coded — Qur'an/hifz, tajweed, fiqh, seerah, Arabic, akhlaq ship as
**defaults an install can change**, and every one of them is an i18n string (§16).

### 1.2 `teachers` — a record, not a login

`id`, `school_id`, `full_name`, `phone` (nullable), `email` (nullable), `status`, timestamps.

**This is the first time the app has a teacher concept at all, and the amendment it needs is narrow and
precise** (§4a): the teacher **record** is in scope; the teacher **login** is not. A teacher is
somebody the office names and assigns, the way it names a class. Nobody signs in as one.

**There is no `user_id` column, deliberately.** A nullable FK nothing sets is an invitation to wire the
next thing to it — the same argument that dropped `stripe_events` in 0.48.0 (§9) and dropped
`users.phone` before WhatsApp gave it a purpose. It comes back when there is a login to hang on it, and
adding it then is a one-column migration, not a redesign, because §1.3 below is what a teacher login
would actually need.

`phone` and `email` are optional and exist for the office's own contact list, not for sending: **nothing
in this app messages a teacher**. If that changes, it changes with a purpose and a switch, like every
other channel (§9's minimization rule).

### 1.3 `teaching_assignments`

`id`, `teacher_id`, `subject_id`, `class_id`, `school_year_id`, timestamps.
UNIQUE `(teacher_id, subject_id, class_id, school_year_id)`.

Scoped to a **year**, because who teaches what changes at rollover and last year's report card must
still name last year's teacher. This is also the table a teacher-facing register or gradebook would
scope against later, which is why it is worth getting right now even though nothing authenticates
against it yet.

### 1.4 `assessments`

`id`, `class_id`, `subject_id`, `term_id`, `name`, `kind` (`test | oral | homework | participation |
other`), `date` (ISO day), `max_points` (integer), `weight_bps` (integer basis points), `status`
(`open | locked`), timestamps.

**Weights are integer basis points**, mirroring money: `2500` is 25%. A float weight is the same defect
as a float amount, arriving by the same route. The weights within one (subject, term) need not sum to
10000 — the derivation normalizes by the sum of the weights actually present, so a term with two of its
three planned tests entered still reports a sensible average rather than one silently scaled to 66%.

`locked` exists so a term can be closed without deleting anything.

### 1.5 `marks`

`id`, `assessment_id`, `student_id`, `points` (integer, **nullable**), `state`, `comment` (nullable),
`recorded_by_user_id`, `recorded_by_name`, `corrected_at`, `corrected_by_name`, timestamps.
UNIQUE `(assessment_id, student_id)`.

`state` is `scored | absent | excused`, and **none of the three is a zero**:

- `scored` carries `points`;
- `absent` and `excused` carry `points = null` and are **excluded from the denominator**, not counted
  as nought. A child who missed a test has no result for it; averaging a missed test as zero is a
  different claim, and a wrong one.
- The distinction between `absent` and `excused` matters for the same reason it does in attendance:
  they are reported separately even though they average identically.

Corrections are allowed and audited **before → after**, with the stamp on the row as well as the audit
entry — because `audit_log` has no reader (§5), so without the stamp the screen cannot show that a mark
was changed at all.

### 1.6 `hifz_records` — not an assessment, on purpose

`id`, `student_id`, `date` (ISO day), `kind` (`sabaq | sabqi | manzil | milestone`), `surah` (1–114),
`ayah_from`, `ayah_to`, `juz_completed` (nullable integer), `quality` (nullable short text), `note`
(nullable), `recorded_by_user_id`, `recorded_by_name`, timestamps.

A child's position in the Qur'an is a **running record over time**, not a score out of ten, and forcing
it into the assessment model would mean inventing a maximum for something that has none. The report
card draws on it — "completed juz 7; sabaq at al-Anfāl 40–52" — rather than grading it.

Validate `surah` as 1–114 and `ayah_from <= ayah_to` at the boundary (zod, §7), because a typo here is
a record that reads as fact.

### 1.7 Bulk entry

A **class × assessment grid, keyboard-navigable, saving as you go**, and the same phone-first bar the
register gets (§15). Mark entry is admin-only for now, which means one person typing a whole class from
what teachers reported on paper — so the grid has to be comfortable for exactly that, not merely
possible.

---

## 2. Deriving — the one place

> **`academics/derive.ts` is the ONE place** that turns points into percentages, percentages into
> weighted averages, and averages into bands (§16). Nothing else computes an academic number — not a
> router, not a screen, not the report-card renderer.

Rules:

- Percentages are **integer basis points**: `round(points * 10000 / max_points)`. Rounded in one place,
  once, so two screens cannot disagree about 84.5%.
- A subject average for a term weights each assessment by `weight_bps`, over **the assessments that have
  a `scored` mark for that student** — `absent` and `excused` leave the denominator, they do not zero
  the numerator.
- A term average across subjects covers `graded` subjects only. `pass_fail` and `narrative` subjects
  appear on the card and do not enter a number.
- A band is looked up in the **active grading scheme version** (§3.1), by basis points.
- **Nothing derived is ever written to a table.** If a screen is slow, the answer is an index, not a
  cached column.

---

## 3. Phase 5 — report cards

### 3.1 `grading_schemes` + `grading_bands`

`grading_schemes`: `id`, `name`, `version` (integer), `status` (`draft | active | retired`), timestamps.
`grading_bands`: `id`, `scheme_id`, `min_bps` (integer), `label`, `sort_order`.

One **active** scheme per install (decision 4), with bands the madrasah writes: A/B/C, 90+/80+, or
Mumtāz / Jayyid jiddan / Jayyid. Editing an active scheme **mints a new version and retires the old
one** rather than mutating it — because a report card records the scheme version it was graded under,
and reprinting last year's card must apply last year's bands. Versioning is the cheap half of the
freeze; §3.3 is the other half.

### 3.2 `report_cards`

`id`, `student_id`, `term_id`, `school_year_id`, `state` (`draft | finalized`), `scheme_id`,
`head_comment` (nullable), `snapshot` (JSON, null while draft), `finalized_at`,
`finalized_by_user_id`, `finalized_by_name`, timestamps. UNIQUE `(student_id, term_id)`.

`report_card_comments`: `id`, `report_card_id`, `subject_id`, `comment`, `author_name`, timestamps —
the per-subject teacher comment while the card is a draft. On finalization the comments are copied into
the snapshot and the rows remain as the working copy.

### 3.3 The freeze — a structured snapshot, not frozen HTML

Decision 5, and the reasoning matters more than the answer:

> **Freeze the facts, re-render with current templates.**

Freezing rendered HTML would pin the design system into a database row forever: §15's ported
`glass.css` / `app.css` re-sync from OpenMasjidOS, the theme flips light/dark at read time, layouts are
RTL-aware, and the print stylesheet is tuned against real photocopiers. A card frozen as markup stops
receiving all of that, and the first theme fix makes every old card look wrong in a different way from
every new one.

The house precedent is `snapshotCharge` (§4): copy the **fact**, keep the id as provenance. So the
snapshot holds, per card: each subject row (name, kind, the marks that fed it, the derived percentage
in bps, the band label), the hifz record for the term, the attendance summary for the term, every
comment, the scheme id **and version**, the school name, the term and the date. The page is rendered
fresh from that every time it is opened or printed.

**A mark corrected in March does not rewrite a card issued in January** — the card reads its snapshot,
not the live tables. That is the same instinct as immutable payments, and it is the entire reason
finalization exists as a state.

### 3.4 Printing, and the route it must not reuse

**Printable HTML with a print stylesheet**, exactly like household statements — same precedent, same
design system, RTL-aware, legible in black and white on a masjid photocopier. **No PDF toolchain**
(§7: no headless Chromium, and `@react-pdf/renderer` was dropped in 0.45.0).

**A parent report card needs its own route and its own predicate.** `canServeStatement` is the single
predicate behind all four existing printable routes — the household statement, the per-child invoice,
the family sheet **and the class Student ID sheet**. Widening it to let a parent fetch a report card
widens it for all four, and `statementRoute.test.ts` says what that costs in as many words: the ID
sheet is "every child's ID … a leak there is the whole install, not one household."

So: a new route, a new predicate, parent-scoped through `familyAccess.ts`, serving **finalized cards
only**, carrying the same headers every printable document carries — `no-store`, `nosniff`,
`no-referrer`, `default-src 'none'` — and re-validating the logo and accent color on the way out, since
they land inside a `<style>` block and an `<img>` on a page a browser renders (§14).

### 3.5 What a parent sees

Decision 2: **finalized report cards only.** Live marks would need a parent-facing academic read
surface built in Phase 4, before the freeze machinery that makes it safe exists in Phase 5 — and a
parent watching a gradebook mid-term is a support conversation about every provisional number in it.

### 3.6 The annual view

A cumulative view across the year's terms, built from the finalized snapshots, as the foundation for
transcripts **later**. Transcripts are not in scope and are not being built (§4).

---

## 4. Roles

Admin-only, server-side (§5). **Finance reaches no academic record** — marks, cards and hifz are not
money, and finance's wall is one this app already holds cleanly. Parents reach **finalized report cards
for their own children only**, scoped in the query through `familyAccess.ts` and never by a UI filter.

Admin being LAN-only (§12.4) means mark entry and finalization happen on the masjid network. That is
accepted, not worked around.

---

## 5. Tests that must exist before these phases are done

- **Weighted average** over mixed weights, including weights that do not sum to 10000.
- **Absent and excused are not zero**: a student with one missed test out of three has the average of
  the two they sat.
- **Rounding happens once**: the same percentage from the router, the screen and the printed card.
- **Band lookup uses the card's scheme version**, proven by editing the scheme after finalization and
  asserting the old card is unchanged.
- **The finalization snapshot holds**: correct a mark after finalizing and assert the card's numbers,
  band and comments are identical, while the live gradebook has moved.
- **A draft card reads live data**; a finalized one reads only its snapshot.
- **The parent report-card route does not widen `canServeStatement`** — assert the ID-sheet route is
  unreachable for a parent, in the same test file, so the two can never drift.
- **A parent cannot fetch another household's card**, tested per procedure and per route, not assumed.
- **Hifz bounds** are validated: sūrah 0, sūrah 115 and `ayah_from > ayah_to` are all refused.
- Admin gate + role × origin matrix on every new procedure (§18).
