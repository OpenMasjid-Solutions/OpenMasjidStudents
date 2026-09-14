<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# ATTENDANCE — the calendar, the roster on a date, and the daily register

> **Status: SPECIFIED, NOT BUILT.** Phase 3 of the academic layer (CLAUDE.md §4a). Nothing here
> exists in the code yet.
>
> Owner sections in `CLAUDE.md`: §4a (scope), §5 (roles), §9 (data rules, incl. the enrollment-history
> reversal), §16 (one place decides), §18 (done).

---

## 0. The two things that make this harder than it looks

**A daily register, not a timetable.** There is no timetable and none is being built. A madrasa day is
one or more named *sessions*, not a grid of periods with subjects and teachers in it.

Two problems sit underneath, and both are schema problems rather than screens:

1. **An absence rate is meaningless without a calendar.** "Every day between two dates" counts Eid,
   Ramadan changes, weather closures and the week the madrasah simply did not run. The calendar comes
   first and it is not optional.
2. **"Who was on the register that day" is not "who is on the roster now."** A child admitted in
   November was not absent in October. This app has **one current class pointer** and no history, and
   the history **cannot be recovered** from the audit log. That is the single largest hidden cost in
   the whole academic layer, and it is §1 below.

---

## 1. Enrollment history — the reversal that gates this phase

```
schema.ts  "A student belongs to at most one class, held as a single `students.class_id` —
            grouping only, so there is no per-year class history."
```

Nine paths overwrite that pointer. `structure/rollover.ts` rewrites **every child's class in place**
inside one transaction, and its own comment says there is no undo. So the first rollover after
attendance ships would silently reattribute a year of registers to the wrong classes.

**And the past cannot be reconstructed.** Every class-change audit row records the *new* value or a
count, never the old one — `structure.ts` logs `{ classId, schoolId }` on a single placement and
`{ classId, schoolId, placed: n }` on a bulk one ("one audit entry with the count, not thirty rows"),
and `people.ts` logs field *names* only. There is nothing to backfill from.

### 1.1 The `enrollments` table

`docs/DATA_MODEL.md` records `enrollments` as **deliberately not re-created** in the v0.35.0 pivot,
because fees attach to the student and not to a class enrollment. That reasoning is still correct
about *money* and is now wrong about *time*. Re-creating it is one of the reversals the §4 amendment
carries.

| Column | Notes |
| --- | --- |
| `id` | |
| `student_id` | RESTRICT |
| `class_id` | nullable — a child can be enrolled in a year while unplaced |
| `school_year_id` | |
| `from_date`, `to_date` | ISO days; `to_date` null = current. Validated by `isIsoDay` (§9). |
| `reason` | `admission \| rollover \| transfer \| withdrawal \| manual` |
| `created_at`, `updated_at` | |

Indexes on `(student_id, from_date)` and `(class_id, from_date)`. Rows for one student must not
overlap in time, which is an invariant the one writer below enforces and a test proves.

### 1.2 `students.class_id` stays — and stops being written directly

Nine read paths use it and it is genuinely the right shape for "which class is this child in *now*".
Deleting it would be a large, risky refactor for no gain. So it stays as a **denormalized current
pointer**, and the fix is that **nothing writes it directly any more**:

> **`structure/enrollment.ts` is the ONE place a child moves between classes** (§16). It closes the open
> enrollment row, opens a new one, and updates `students.class_id` — in one transaction, always
> together. Placement, bulk placement, rollover, admission conversion and re-admission approval all call
> it. A second writer is the bug, and it is the exact shape of bug §20 names as this codebase's
> recurring one.

`rollover.ts` is rewritten to call it rather than `UPDATE students SET class_id`.

### 1.3 History starts the day this ships — say so out loud

Any install already running has no recoverable past. Registers taken before the table exists cannot be
attributed retroactively, and the attendance screens must not imply otherwise: a term that predates the
first enrollment row reports **"no roster history"**, not a rate computed against today's classes.
This is the honest version and it is cheap; the dishonest version is a number that looks right.

---

## 2. The calendar

### 2.1 Teaching days

Which weekdays a school year runs, as a small integer set stored on `school_years`
(`teaching_days`, e.g. `"0,6"` for Sunday and Saturday). Per school year, because a madrasah that adds
a weekday class changes it mid-life and last year's rates must not move.

### 2.2 `closure_days`

`id`, `school_year_id`, `date` (ISO day), `label`, `created_at`, `updated_at`, **UNIQUE
`(school_year_id, date)`**.

Two facts about this madrasah's calendar that a western-school-year assumption gets wrong, and both
have consequences in code:

- The academic year is structured around **Ramadan**, not September-to-June. `school_years` already
  supports a year that wraps the calendar (an Apr → Mar year), so nothing new is needed — but nothing
  may assume a September start either.
- Closures land on the **lunar** calendar. They move year to year and are often confirmed days ahead.
  So **the closure list is editable at short notice, and editing it recomputes** — which it does for
  free, because nothing derived is stored (§3).

### 2.3 `sessions`

`id`, `school_id`, `name`, `sort_order`, `status`. A small per-install set of **named daily sessions** —
a morning hifz sitting and an evening one. One is the default and **one must always remain**, so a
single-session madrasah never sees the concept.

Sessions have a name and an order. **They do not have times, subjects or teachers.** That is the line
between this and a timetable, and it is the line that keeps Phase 3 small.

### 2.4 One place decides

> **`structure/calendar.ts` is the ONE place that answers "does the madrasah teach on this day?"** —
> teaching weekdays, closures, the year's bounds and the term's bounds, in one function. Every rate,
> every "missing register" list and every report-card summary asks it. Two places answering that
> question differently is how a denominator quietly changes between two screens.

---

## 3. The register

### 3.1 `attendance_marks`

| Column | Notes |
| --- | --- |
| `id` | |
| `student_id`, `class_id` | class is stored on the mark, not looked up later — it is a fact about that day |
| `date` | ISO day |
| `session_id` | |
| `mark` | `present \| absent \| late \| excused` |
| `reason` | optional short text |
| `arrived_at` | optional `HH:MM`, only meaningful with `late` |
| `taken_by_user_id`, `taken_by_name` | see §3.4 |
| `corrected_at`, `corrected_by_name` | null until a mark is changed after the fact |
| `created_at`, `updated_at` | |

**UNIQUE `(student_id, date, session_id)`** — a child is marked once per session per day. Index
`(class_id, date, session_id)` for the register screen.

**`excused` is a distinct state, not a flag on `absent`.** The two answer different questions and
average differently: a chronic-absence chase wants unexcused absence; a "how much teaching did this
child receive" question wants both. Storing excused as `absent + flag` guarantees that one of the two
reports is eventually computed wrong.

### 3.2 `registers` — because the absence of marks is not "everyone present"

`id`, `class_id`, `date`, `session_id`, `taken_by_user_id`, `taken_by_name`, `taken_at`,
`created_at`, `updated_at`, **UNIQUE `(class_id, date, session_id)`**.

This row is the assertion **"this register was taken"**. Without it, a class nobody marked and a class
where everybody was present are indistinguishable in the database, and **register completion — which is
the operational job — becomes unanswerable.** An attendance system that cannot tell you what is missing
is just a table.

So: saving a register writes the register row *and* a mark per student on the roster at that moment,
including the `present` ones. A present mark is a real assertion by a real person, not an absence of
data.

### 3.3 Who is on the register — the rule with its own tests

> **The roster is derived from `enrollments` as of that date, never from today's `students.class_id`.**

A child admitted in November is not on October's register. A child withdrawn in February is not absent
in March. This is exactly where attendance rates go wrong, and it gets its own test file:

- admitted mid-term → absent from earlier registers entirely, and the term rate divides by the days
  they were actually enrolled;
- withdrawn mid-term → the same, from the other end;
- moved between classes mid-term → appears in each class for its own window, and in neither for the
  other's.

### 3.4 Keyed by the class, not by the person who typed it

Three things done now that cost nothing and are expensive later (decision 12):

1. **The register is keyed `(class_id, date, session_id)`** — it is a fact about a class on a day. Who
   recorded it is metadata.
2. **`taken_by_user_id` is stored from day one**, while only admins can write. A teacher role later is
   then an **auth change, not a data migration**.
3. `taken_by_name` alongside it, mirroring `payments.recorded_by_name` vs `audit_log.actor_name` (§9):
   the office reads back "who took this register?" and wants a person's name; the forensic trail wants
   the account.

**The minimum teacher-facing register, when it comes** (not now, and not designed now beyond this
paragraph): LAN-only like every other staff surface — the origin policy does not bend for convenience —
scoped to their assigned classes through the Phase 4 teaching-assignment table, and exactly two
procedures: read today's roster for my class, write marks for my class. Nothing else. That is small
*provided* teaching assignments exist, which is why it lands naturally after Phase 4.

### 3.5 The screen

The single most-used screen in the app once it ships, used standing in a classroom on a phone or tablet
on the masjid network. §15's phone-first bar applies at its strictest:

- **Whole class on one screen, everyone defaulting to present, one tap to change, saving as you go.**
- Keyboard-navigable on a desktop, thumb-reachable on a phone.
- Bulk actions: whole class absent (a closure declared late), one student absent across a date range
  (illness, travel), and "mark the rest present" once the exceptions are in.
- **Register completion is a first-class view**: which classes have no register today, and which days
  this term are missing one.

### 3.6 Corrections

Registers are genuinely taken wrong, so correction is allowed — and never silent.

A correction writes an `audit_log` row carrying **before → after** and who changed it, and stamps
`corrected_at` / `corrected_by_name` on the mark. The stamp exists because `audit_log` has no reader
(§5): without it the screen cannot show that a mark was changed, and "audited" would mean "invisible".

---

## 4. Everything else is derived

> **Store the raw marks and nothing else.** Attendance rate, present/absent/late counts,
> consecutive-absence streaks, per-term and per-year summaries — all computed on read, against the
> calendar in force, in **`attendance/derive.ts`, the one place** (§16).

Same rule as balances (§9) and for the same reason: a stored percentage drifts the moment a mark is
corrected or a closure day is added, and it drifts silently. A closure added in April must change
March's rate — that is the feature, not a bug to work around with cached totals.

Rates are computed and reported in **integer basis points**, not floats, and rounded in exactly one
place. Two rounding sites is the same class of defect as two money formatters.

The denominator is: teaching days in the window, minus closures, restricted to the days this student
was enrolled, times the sessions that had a register taken. An install with no register for a day
counts that day in **neither** numerator nor denominator — a day nobody marked is missing data, not a
day everyone attended.

---

## 5. Follow-ups

- **Per-student and per-class term summaries**, printable alongside the existing documents.
- **A chronic-absence threshold** (consecutive unexcused absences, or a rate floor over a window) that
  raises an office alert through the existing `alerts/index.ts` fan-out. Both texts required: the
  naming `text` to the addresses an office typed; `publicText` names nobody — "3 students are at the
  chronic-absence threshold". The per-event webhook-naming exception (§9) is **not** granted here.
- **Optionally an email to a guardian on an unexplained absence** — a setting, **off by default**,
  because a school that emails on every late mark is muted within a fortnight. It honors every existing
  gate: the master parent-mail pause, the per-event switch, the test-student exception, and the
  WhatsApp opt-out.

---

## 6. Parents see none of this yet

Decision 13: **not in the portal at all for now**, and then only as the **term attendance summary on a
finalized report card** (Phase 5). Live attendance in the portal is a parent-facing academic read
surface, and building one before the freeze machinery exists in Phase 5 is how a corrected mark becomes
an argument at the door.

---

## 7. Roles

Admin-only, server-side (§5). **Finance does not reach attendance records** — they are not money.
Parents reach nothing until Phase 5's report card. The whole register is therefore **LAN-only**, because
admin is (§12.4), and that is not being weakened to make mark entry more convenient.

---

## 8. Tests that must exist before this phase is done

- **Rates against a calendar with closures**: adding a closure day changes the rate, retroactively,
  with no cache to invalidate.
- **Roster-on-that-date** for admitted, withdrawn and class-moved students (§3.3's three cases).
- **Excused is not absent**: the unexcused rate and the attended rate differ on the same data.
- **A day with no register** is in neither numerator nor denominator.
- **Enrollment rows for one student never overlap**, proven by driving rollover, placement and
  admission through the one writer.
- **Rollover closes and opens rather than overwriting**, and a register taken before it still resolves
  to the old class.
- **Corrections are audited before → after**, and the correction stamp lands on the row.
- A **term predating the first enrollment row reports "no roster history"** rather than a number.
- Admin gate + role × origin matrix on every new procedure (§18).
