<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Changelog

All notable changes to **OpenMasjid Students** are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/), and the project uses
[Semantic Versioning](https://semver.org/). `1.0.0` is reserved for launch.

## [Unreleased]

## [0.43.0]

### Added

- **Recording a payment is now the first thing on the Billing tab.** It used to be two clicks down —
  find the household in a grid of cards, open its window, then pick the child — which is a strange
  place to bury the thing an office does twenty times a morning. There is now a search box at the top:
  type a few letters of a name or paste a Student ID, and the amount, method and date are right there.
  The same control is also a dropdown, so you can browse the roster when you don't know how a name is
  spelled.
- **Bills are itemised, and a single line can be paid.** A February bill that is $200 of tuition plus a
  $50 book fee showed up everywhere as one $250 lump, so a parent who came in to pay for the trip could
  not, and the office had to explain why. Tuition and one-off charges are now listed separately — on the
  parent portal, at the kiosk, on the donation site and on the office's own screens — and ticking a line
  records the money **against that line**. It stays that way: the choice is kept with the payment and
  re-applied whenever bills change, so the book fee somebody settled last month does not quietly reappear
  as unpaid when the next month is generated.
- **Starting mid-year.** A madrasa that adopts this in February of a September–June year had no honest
  way in: bill the autumn and you charge families who already paid in cash, skip it and you forgive money
  that is owed. There is now a one-time **Starting mid-year** step. Pick the month you start billing, then
  for each child pick the last month they are square for — one dropdown, settable for the whole roster at
  once — and the app works out what each one carries in from their own rate, editable where the office
  book disagrees. **You see every parent's resulting balance before anything is written.** Committing
  records one dated line per child ("Balance carried forward", or a dated payment for a family already
  paid ahead) and never invents the months themselves.
- **Parents are told plainly that their username is their email address.** There is no separate username
  for a parent — the account is created with both set to the same address — but the sign-in form asks for
  a "username", which is exactly where that catches people out. The login page now says so, the invite
  email names the address, and the page where a parent sets their password repeats it.

### Changed

- **Pressing a child's name in the Year view opens their billing** — balance, bills line by line, and the
  box to record a payment, with that child already selected. The grid of household cards at the bottom of
  the Billing tab is gone: it was a wall of names with one number each, while the year view shows the same
  name alongside their course, class and which months they have paid.
- **A monthly bill always carries a due date now** — the day you configured, or the 1st of that month.
  A bill with no date was not "no opinion": autopay only ever looks for bills that are due, so an undated
  one was never charged, and money skipped past it to newer months. A February bill nobody had dated was
  therefore never chased and never ticked off in the year grid.

### Fixed

- **A month typed without its leading zero would bill that month twice.** `2027-2` is a different period
  from `2027-02` as far as the "don't bill a month twice" check is concerned, so it quietly raised a second
  February invoice for every child, and nothing on screen suggested anything was wrong — the year's total
  just grew. The Generate box now refuses it and says how to write it.
- **A kiosk or donation-site payment aimed at a specific bill was silently ignored.** The Fabric contract
  has accepted an invoice-level instruction since v1; this app parsed it and then allocated
  oldest-due-first anyway, with nothing to say so. It is now honoured — and, like the new per-line
  instruction, it survives later recalculations.
- **Autopay could charge a card money the app itself said was not owed.** It added up the bills that were
  due and counted only the positive ones, so a family holding a credit larger than one month's bill — a
  scholarship, or a correction for a month that was over-billed — could be charged every month while
  their own screen said they owed nothing and were in credit. The charge is now capped at the household's
  actual balance, so a family who owes nothing can never be charged.
- **A bill covered entirely by a scholarship stayed "Open" forever.** With the full amount credited off
  there was nothing left to pay, and no payment can be made against a bill that costs nothing — so it sat
  on the statement and in the year grid indefinitely. It now reads as settled.
- **Part of a payment could be dropped without anything saying so.** When a card payment covering several
  children was described one bill at a time rather than one child at a time, the second amount for the
  same child was mistaken for a repeat of the first and discarded, while the response reported the whole
  amount as recorded. The amounts are now added together. Separately, if a payment ever ends up only
  partly recorded (a container restarting mid-way), the office is now told, instead of it going quiet.
- **Two smaller ones in the new mid-year step:** running it a second time no longer moves the start month
  forward and start refusing months you have already billed, and a child who left part-way through the
  year is now included — they can still owe for the months they attended.

## [0.42.1]

### Fixed

- **The app was reporting the wrong version.** An install updated to 0.42.0 still said 0.40.0 in the
  account menu and at the top of What's new, even with all the newer features plainly working. The
  number was typed into the server by hand and the release checklist never listed that file, so it
  stopped being updated after 0.40.0 — which made the one thing you'd use to confirm an update had
  landed the one thing that couldn't be trusted. The server now reads its version from the package it
  was built from, so it cannot drift again, and a test checks that every place a release states its
  version agrees — including the changelog entry, since What's new is built from it.

## [0.42.0]

### Added

- **After a CSV import, the app now offers you the siblings to link.** An import deliberately gives
  every row its own household — guessing a family from a spreadsheet and getting it wrong would merge
  two families' money — but that left 120 children in 120 households and a parent with four separate
  balances. The step after importing now shows the likely families and links each one on a click, and
  it distinguishes the two kinds of guess honestly: children whose guardians **share a phone number or
  email** are almost certainly siblings and come pre-ticked, while children who only **share a surname**
  start unticked, because three unrelated Ismail families in one roster is completely normal. It is also
  reachable any time from the Students tab, so a roster imported months ago can be tidied up now.
- **Linking siblings folds duplicate guardian records into one.** A father with three children arrived
  from a CSV as three separate people; linking the children stacked all three copies on the record.
  They now merge into a single guardian, and blanks are filled rather than overwritten — if one copy had
  the phone and another the email, the survivor keeps both. A guardian who has a parent portal login is
  never removed silently.
- **Mass enrolment.** Pick a class under Courses & classes and tick everyone who belongs in it, instead
  of setting the class one student at a time from the roster. The per-student way still works.
- **Guardians and emergency contacts can be deleted**, not only edited. Deleting tells you what will
  actually happen first: a guardian on two households is only removed from this one, and one with a
  parent portal account loses that login — which is worth a sentence, not a surprise.
- **What's new** — this changelog, in the app, under the account menu.
- **The year view has a labelled, tappable column per number**: Father's, Mother's, Other and
  Emergency, plus father's and mother's email. Tap a number to call it or an address to email it, which
  turns the page into the office's call list on a phone. "Other" covers guardians with no relation
  recorded, including everyone a CSV import created, so no number disappears. Installs that had the old
  combined "Phone" column keep the same numbers, in the new columns, with nothing to reconfigure.

### Changed

- **Fee plans are admin-only now.** Finance still reads them — no invoice screen means anything without
  the plan names — but creating, archiving and deleting them is the office's decision. Archiving a plan
  silently unassigns every student on it, and deleting is permanent.
- **Getting rid of a fee plan says which is possible.** The × used to archive silently; it now deletes a
  plan that has never been billed and archives one that has, explaining why and how many students stop
  being billed for it either way.
- **The sibling picker lets you type.** Both the "add a sibling" control and the one in the add-student
  form are now search boxes that are still dropdowns: click for the whole list, type to narrow it. Rows
  show the Student ID and household, because a madrasa really does enrol two children with the same name.
- **The "emergency contact" tick is gone from the add-guardian form** — there is a whole Emergency
  contacts section right below it, and two ways to say the same thing meant ticking the box and then
  wondering why nobody appeared in that list. Guardians flagged before this release keep their badge.
- **Phones are tappable on a household record too**, and formatted consistently everywhere.
- **The mobile view drops what a phone cannot do and fixes what it can.** CSV export and CSV import are
  hidden on a phone — a downloaded spreadsheet has nothing to open it, and there is no file to pick.
  Records open as full-screen sheets rather than as a small draggable box with the desktop showing
  around it, and the sheet clears the browser's own toolbar so the last row of a list is reachable.

### Fixed

- **Deleting a student who had paid in advance failed with a database error.** The check that decides
  whether a student can be deleted counted invoices but not payments, so a child with an advance payment
  and nothing billed looked deletable and then wasn't. Money that has arrived is part of your records:
  those students are withdrawn instead — which stops all future billing — and the refusal now says so,
  including what to do if the payment really belonged to another child.

## [0.41.0]

### Added

- **The kiosk and the donation site can now take a payment when nothing is due, and can show a
  credit.** Paying a term up front, or handing over a lump sum at the start of Ramadan, has always
  been recorded correctly here — the money sits as that child's credit and their next invoice absorbs
  it. What was missing was any way for the other two apps to *know* that: a balance is worked out as
  billed-minus-paid, so a family who has paid the year ahead and a family who is exactly square both
  looked like "nothing to pay". Tuition lookups now report a **credit** alongside the balance (for the
  household, the child whose ID was typed, and each sibling), and the campaign info says outright that
  paying ahead is allowed, with the minimum amount to accept. Donations and Kiosk pick these up on
  their side; nothing about the money path changed, so an un-updated build keeps working.
- **Age on the student list.** Birthdays were being collected and never shown anywhere. Worked out in
  the browser from today's date, so it is never a day out.

### Changed

- **Adding a sibling is one choice now.** It used to ask which child on the record the new one was a
  sibling *of* — a question with no useful answer, since everyone on a record already shares one
  household. Open a student, pick the child to bring in, done: they inherit the guardians and emergency
  contacts on that record. It also fixes a real fault in the old flow, which merged the *other* way and
  left the window you were looking at pointing at a household it had just deleted.
- **"Relation" for a guardian is a dropdown** — Father, Mother, Relative, Other — instead of an open
  box that collected "Dad", "father" and "Father" as three different answers. Anything typed before is
  kept and still shown as it was written. Emergency contacts keep the open box on purpose: "neighbour,
  two doors down" is the useful answer there.
- **Phone numbers format themselves** as `(555) 123-4567`, as you type and everywhere they are shown —
  including numbers entered years ago, with no data migration. A number that isn't a ten-digit US one
  (an overseas grandparent, an extension) is left exactly as it was entered rather than mangled.
- **The Family column is gone from the student list**, replaced by Age. The household is still what
  opens when you click a student, and searching a surname still finds every sibling.

### Fixed

- **The school logo no longer appears squashed** in Settings after uploading it. The preview was being
  stretched to the width of its column while its height was held down.
- **The test email carries the logo**, like every real email the app sends. It was the one message built
  outside the shared email path, so it skipped the letterhead — which looked like a broken upload.
  Settings now also explains the one case where a logo genuinely cannot appear in email: it has to load
  from a web address, so Remote access must be on. Statements always show it.

## [0.40.0]

### Fixed

- **A lump sum now marks every month it pays for.** Paying $1,400 against a $350/month fee settles
  four months, not some of them. The balance was always right; the *months* were not, and the year
  view reads the months — so an office could see "nothing owed" on the account and unpaid squares in
  the grid at the same time.
  - The cause: a bill's paid/unpaid state comes from which payments are attached to it, and money
    handed over **before** a bill existed was never attached to it afterwards. So the month that was
    already invoiced got ticked and everything paid for in advance did not.
  - Attaching is now re-derived, oldest bill first, whenever an invoice or a charge changes. Money
    paid ahead lands on each month as it is generated, with no second entry from the office.
- **Light mode was unreadable, and now isn't.** Every wallpaper was a dark one, including in light
  mode, so light mode painted its pale panels over a near-black background and wrote dark text on the
  muddy grey that produced — on every tab at once. Each wallpaper now has a light counterpart that
  keeps its colour (ocean is still blue, forest still green), and the text on the desktop follows the
  theme. The parent portal had a related bug of its own: thirteen places asked for a colour that was
  never defined and silently fell back to near-white, which was invisible on a light background.
- **"School Years", "Courses" and "Classes" no longer wrap their icon onto its own line.** The
  underlying cause was a global rule making every icon a block; the headings now lay their icon and
  text out as one row, so it cannot come back.
- **A migration that would have failed on a real install.** Rebuilding a table means dropping it, and
  the safety switch the generated migration relies on does nothing where it sits — so this upgrade
  worked on an empty database and would have refused to start on any install with a single student
  on file. The switch is now thrown where it actually applies, with a check afterwards that reports
  anything a migration orphaned. Verified against a populated database, not just a fresh one.

### Added

- **Pay ahead.** Parents can now add money to their account when nothing is due — the portal offers
  it rather than hiding the button until a bill exists, and the kiosk and donation site could always
  take it. It is held as credit and comes off the next invoices automatically.
- **A one-off charge comes out of an advance balance first.** Add a book fee to a family who has paid
  the term up front and it is taken from what they have already paid, oldest bill first. If that
  leaves a month short, the month goes back to unpaid so it is chased normally, and the family is
  billed for the difference — nothing is quietly written off or double-charged.
- **Permanent delete, alongside archive** — for the mistakes an office actually makes: a course
  added twice, a fee plan with a typo, a school year entered wrong. The line is the same one the app
  draws everywhere: configuration can be deleted, money history cannot. A fee plan that has appeared
  on an invoice archives instead, and says why. Deleting a course or class unplaces its students
  rather than deleting them, and tells you how many before you click.
- **Link siblings**, on the student's own record — replacing "move to family". You pick the other
  *student*, which is how an office thinks about it, and the two households merge, so the guardians
  and emergency contacts on either side apply to both. **Move out** undoes it. Nobody names a family
  at any point.
- **Finance can open the Students tab, read-only** — profiles, contact details, Student IDs and
  balances, with no way to add a student, place them in a class, link siblings or edit a record.
- **A school logo**, uploaded in Settings and used on printed statements and every email the app
  sends. PNG/JPEG/WebP up to 512 KB, checked by content rather than by what the file claims to be.

### Changed

- **Students have ONE name field.** "First name" and "Last name" are gone, replaced by **Full name**.
  Plenty of the names a madrasa enrols do not split into two western halves — a compound given name,
  a nasab, a mononym — and the form was quietly mangling them. Existing names are joined together on
  upgrade, so nothing is lost and nothing needs re-typing.
  - The Student ID still reads the way it always did (`YUS1234`), and now handles a compound name
    better: "Al Amin" gives `ALA` rather than a padded `ALX`.
  - The kiosk and donation site are **unaffected** — the tuition contract still sends a given name
    and a last initial, still never a full surname, both now derived from the one field.
  - CSV import takes a single **Name** column.
- **CSV import no longer tries to work out siblings**, and says so before and after you commit. Every
  row becomes one student in a household of their own; you link brothers and sisters afterwards on
  either child's record. Guessing from the file was the wrong trade in both directions — matching on
  a surname marries unrelated children who happen to share one, and a typed "family" column means
  the office maintains a name for something it never names anywhere else. Either way the mistake
  ends up buried in a 200-row spreadsheet instead of visible on a record, and linking two children
  is one click.
- **The student directory and the year view are organised Course → Class → Student**, with course
  buttons across the top and **All** selected by default.
- **Staff accounts no longer have a phone number.** The app never rings staff, so holding one was
  personal data collected for no reason. Guardian and emergency-contact numbers are untouched.
- **A new school year no longer assumes April–March.** Both months start unset and must be chosen —
  the old default silently decided the billing calendar for anyone who did not notice the dropdowns,
  and a wrong start month generates a whole year of wrong invoice periods.

## [0.39.0]

### Removed

- **Student PINs are gone.** Paying tuition on the donation site or at the kiosk now takes only the
  child's **Student ID** — type it, check the name the screen shows back, then pay for any of your
  children from there. No keypad, no second number to remember, nothing to reissue when a parent
  forgets it.
  - Why it's safe: the only thing anyone can do with someone else's Student ID is *pay their tuition*.
    There is no route from an ID to changing a record, reading a phone number, or taking money out. A
    secret that buys nothing and costs every parent friction at a kiosk was the wrong trade.
  - What protects it instead: the **name-confirmation step** (which catches the realistic mistake — a
    mistyped ID — in a way a PIN never did), and a **hard per-ID lockout**: 6 failed attempts on one ID
    per hour locks it for an hour and raises an admin alert. The kiosk name check, the balance lookup
    and parent sign-up all share one lockout, so failures can't be laundered by switching screens.
  - Parent self-sign-up now asks for the **Student ID plus an email the office already has on file**.
    The email half is deliberate: an ID alone may pay, but creating an *account* needs an address the
    school chose, so an invite can only ever land in an inbox already on the record.
  - Gone with it: the PIN column on the student record and the statement, the "New PIN" button, the
    year-view PIN column, and the `students.pin` / `pin_updated_at` columns (migration `0025`).

### Changed

- **Adding people starts with the student.** The Students tab's button is now **Add student**, not "Add
  family" — you fill in the child, pick their fee plan and class, and if they have a **brother or sister
  already enrolled you pick them from a list**. That link is what puts them in one household, so the
  guardian and emergency-contact details already on file apply to the new child with nothing to re-type.
- **Nobody names a family any more.** The household label is worked out from the children in it —
  "Ismail family", or "Farooqi / Ismail" for step-siblings, because picking one child's surname to stand
  for the household would be wrong in exactly the case where it matters. It updates itself when children
  are added, so it is one less field to keep current. Two unrelated children who happen to share a
  surname stay separate households, as they should.
- **One bill per child.** Invoices and payments used to belong to a household; now they belong to a
  student. What this fixes, in the office's words: *"Yusuf paid April, Sara hasn't"* is finally
  something the app can say. The year view shows each child's own months, the balance column is that
  child's, and a statement lists what each child owes.
  - **Recording an in-person payment now asks which child** — "Yusuf brought cash for April". It lands
    in his balance, pays down his oldest unpaid bill first, and anything left over stays as **his**
    credit that his next invoice absorbs automatically. Nothing is stored, so it cannot go stale.
  - Parents still see **one combined balance and pay once.** A single card charge covering three
    children is recorded as three ledger rows, one per child, so each child's balance moves by their
    own share — and the payment history says which child each row was for.
  - Moving a child between households now takes their billing with them. An unpaid bill stranded on a
    household the child has left is a debt nobody is looking at.
- **Family discounts are gone.** A household-level discount had nowhere honest to sit once each child
  gets their own bill. A reduced rate is the **per-student amount** on their fee assignment, which is
  where a parent sees it on the invoice anyway. Any family currently on a discount needs that amount
  entered per child.
- **Fabric contract `students/billing` → `v: 2`** (breaking, `lookup` only). `lookup` takes
  `studentCode` and nothing else; `name` and `pin` are gone, and a v1-shaped body now gets a `400`
  rather than half-working. It also returns **each child's own balance** alongside the household total,
  and `record-payment` accepts an optional per-child `students[]` breakdown (omit it and this app
  derives the split). `info`, `record-payment` and `check` still accept `"v": 1`, so a Donations or
  Kiosk build that hasn't shipped its update keeps its **money path** working — only its lookup screen
  needs the change. See [`docs/FABRIC_BILLING_CONTRACT.md`](docs/FABRIC_BILLING_CONTRACT.md) §11.0.
  - **Action required in the consumer apps.** At this release both **OpenMasjid Donations** and
    **OpenMasjid Kiosk** still ask for a student name and PIN, so **their tuition lookup screens stop
    working on this version** until each ships its v2 update (the campaign tile and every other campaign
    type are unaffected, as is any tuition payment already in flight). This deliberately isn't papered
    over: PINs no longer exist anywhere in this app, so a compatibility shim would leave those screens
    asking parents for a number that was never issued and accepting anything typed into it. A loud `400`
    while the consumers are updated is the honest failure. Masajid using tuition at the kiosk or the
    donation site should update all three apps together.

### Fixed

- **`check` would have missed every multi-child payment.** It matched the idempotency key exactly, but a
  charge covering N children is stored as N rows keyed `<key>:<studentId>` — so a consumer's outbox
  would have retried forever. (The first attempt at the fix used SQL `LIKE`, which was worse: `_` is a
  LIKE wildcard and Stripe ids are full of them.)
- **A replayed `record-payment` could have recorded the money twice.** Deriving a per-child split reads
  the invoices the first attempt already paid down, so re-deriving produced a *different* split under
  fresh keys, which the per-key idempotency check couldn't catch. Every path that derives a split now
  checks whether the charge was already recorded first.
- **Reconciliation could have dropped a payment** for a family whose students hadn't been imported yet.
  It now holds its cursor and retries rather than skipping past real money (§11.4).
- The `pin-lockout` admin alert is now **`lookup-lockout`** ("Tuition Student ID lookup locked"). The
  id changes in the manifest, so the alert starts working again once the catalog entry updates.
- CSV student export and the year view now carry the Student ID where they used to offer a PIN column.

## [0.38.0]

### Added

- **A Student ID for every child** — `YUS1234`: the first three letters of their first name plus four
  digits. At the kiosk a parent types the ID, the screen shows the name back and asks whether it's the
  right child, then they enter the PIN — and can pay for **any of their children from that one
  screen**, without typing a second ID. The ID is printed on the statement, shown on the student
  record, offered as a year-view column, and visible in the parent portal.
  - Generated here, always: never chosen by a caller and never importable from a spreadsheet, since an
    imported ID could collide with a real one or be picked to impersonate another child.
  - Awkward names are handled deliberately: diacritics stripped (*Yūsuf* → `YUS`), a one- or
    two-letter name padded (*Bo* → `BOX`), and a name with no Latin letters falls back to `STU`
    rather than guessing a transliteration. Unique in the database, so a clash is an error, not two
    children sharing a payment code.
  - Existing students get one automatically on the next start-up.
- **Staff roles** — create a user as **admin or finance** (it was hardcoded to finance), see admins in
  the list at all, and **change someone's role**, which takes effect immediately without them signing
  out. Password reset is reachable from the same screen.
- **Delete a student**, not only withdraw them — for a duplicate, a typo, or a child who never
  enrolled. A student who has ever been billed can't be deleted, because they appear on invoices you've
  already raised; the app checks first and says so, pointing at withdrawal instead.
- **Automatic monthly invoices** — switch it on, pick the day, and optionally a due day. It runs
  overnight, bills only months inside your current school year, only once per month, and **catches up
  if the app was switched off on the day** rather than skipping the month. "Run now" uses the identical
  code path, and says plainly why it did nothing when it did nothing. Off by default.
- **CSV export** (admin + finance) — payments, invoices, family balances, and students with their fees
  and guardian contacts. The app had no export at all before this.
- **Bank transfer / ACH** as a way to record an offline payment, alongside cash, check and Zelle.

### Fixed

- **A negative charge couldn't be entered.** The amount field used the owed-amount parser, which
  rejects negatives, so the credit / scholarship / correction path documented in 0.36.0 silently never
  submitted. Charges and charge items now use a signed parser; payments, fee-plan prices, overrides and
  discounts still refuse a minus sign, where it is a typo.

### Security

- The CSV export escapes **spreadsheet formula injection** (§14). Guardian names, family names and
  payment memos are free text a parent can influence, and a cell beginning `=`, `+`, `-`, `@`, tab or
  CR is executed by a spreadsheet — so opening an export could otherwise run whatever was typed. Every
  cell is defused before the structural quoting. Tested with a family literally named `=cmd|/c calc`.
- **A student ID is not a secret, and is not treated as one.** Its letters come from the child's first
  name and it is printed on statements, so it establishes *who* while the PIN still establishes *may
  you*. The new `identify` Fabric method returns a first name and last initial and **nothing else** —
  no balance, no invoices, no sibling list, not even the family id — and a test fails if that ever
  widens. Because a code is much more guessable than a PIN it is locked harder: 6 failed attempts per
  code per hour against the PIN's 10, with an admin alert on lockout.
- The CSV student sheet includes the Student ID but **never PINs**: a spreadsheet of every child's
  payment PIN is a far wider exposure than the per-family statement it belongs on.
- Staff role changes refuse the two lockout paths: removing the **last active admin** (by demotion or
  by disabling — admin is the only role that reaches settings, and admin sign-in is LAN-only, so there
  would be no way back in) and acting on **your own** account. A parent's portal account is out of
  reach from the staff screen entirely, guarded by role *and* by a guardian link.

### Contract

- `students/billing` stays at **`v: 1`** — both additions are additive, so Donations and Kiosk keep
  working untouched. New method **`identify`**; `lookup` now accepts `studentCode` + PIN as well as
  `name` + PIN; and `lookup`'s sibling list gained `studentId` + `studentCode` per child, which is what
  lets a kiosk pay for a sibling without a second ID. Documented in
  `docs/FABRIC_BILLING_CONTRACT.md`, including the not-a-secret rule.

## [0.37.0]

The office can now reach everything v0.36.0 built. That release shipped the school year, terms,
courses, classes, mass apply, the charge catalogue and per-student fee overrides **on the server
only** — around 28 procedures with no screen behind them — so on a real install none of it could be
used, and the v0.36.0 notes below have been corrected to say what actually shipped.

### Added

- **Structure tab** (admin) — the configuration surface those features were missing:
  - **School years**: create one, **edit an existing one** (name, starting calendar year, from/to
    months), make another current, or archive it. Previously a year could only be created, and a
    year saved before `start_year` existed could not be repaired at all.
  - **Terms**: create, edit and delete the terms inside a year — what `per-term` tuition needs.
  - **Courses → classes**: create, rename, reorder and archive both. **This is the one that
    unblocked the rest**: with no class in existence, `courseTree` was empty, so the Students tab's
    class dropdown had no options, every student stayed unplaced, and the course→class grouping in
    both the roster and the year view had nothing to group by. Archiving a class unplaces its
    students first and says how many moved.
- **Mass apply** (admin + finance) — a fee plan or a one-off charge, applied to **explicit
  students, a whole class, or a whole course**, with the resolved head-count shown before you
  commit. Assigning a fee plan is repeat-safe (a student who already has it is skipped); a charge is
  not, so it confirms first and says so.
- **Charge items + charges** in Billing — the catalogue (add, rename, re-price, archive) and the
  charges raised from it, with void for anything not yet invoiced. Re-pricing an item never rewrites
  a charge already applied.
- **Per-student fee override** in a family's billing — charge one student a different amount for the
  same plan, with a note, and clear it back to the plan's price. The overridden amount is shown with
  the plan's price struck through, and it flows into the year view's *Paying* column.
- **Per-student one-off charges** in a family's billing, from the catalogue or free-typed.
- **Edit a guardian** (name, phone, email). Without this there was no way to add an email to a
  guardian, which silently blocked the password-reset feature added below.
- **Bank transfer / ACH** as a way to record an offline payment, alongside cash, check and Zelle.
  Text column, no CHECK constraint, so no migration and existing rows are untouched. This is money
  the masjid received directly — not the Stripe ACH debit that stays out of scope (§4 ❌).
- **Year view** (admin + finance) — every student as a row, every billing month as a column, so a
  year of tuition reads at a glance and prints. A cell is the family's invoice for that month, so
  siblings share it. Admin chooses the extra columns (guardian phone, email, names, DOB, balance,
  PIN); the choice is enforced server-side, so a column that is off is never sent to the browser.
  **PIN is off by default** — a whole-school grid of payment PINs is a far wider exposure than the
  per-family statement it belongs on (§14).
- **Guardian portal accounts are visible to the office** — whether each guardian has signed up and
  whether that account is active — and staff can **send a password reset** to one who has. That
  distinguishes "never accepted the invite" from "signed up and forgot", which decides whether to
  re-invite or reset.
- **Transactional email through OpenMasjidOS** (`email: true` → `POST /api/fabric/email`), so local
  SMTP is genuinely optional: the OS owns the credentials and the From address. Local SMTP is still
  tried first, keeping a standalone install fully working.
- **The app learns its own public URL from the platform** (`domain: true` → `GET /api/fabric/site`,
  refreshed every 15 minutes). `OPENMASJID_PUBLIC_URL` is only a mirror written at install and is
  empty until an admin turns on Remote access — so without this, invite and reset links had no
  absolute base and could not be emailed at all.
- **Admin alerts** (`alerts:` → `POST /api/fabric/alert`) for the three events where a dropped
  notification costs money or hides an attack: autopay switched off after repeated failures, a PIN
  lookup locked, and a payment recovered by reconciliation. Unlike the webhook-only notifications
  these can reach the admin's email, and the admin gets a per-alert on/off in OpenMasjidOS.
- **A "reaching parents" panel** in Settings, shown first: whether there is a public web address, a
  mail transport, and a working self-registration door — because every "the invite never arrived"
  report comes down to one of those three, and all three used to fail silently.
- **A suppressed email now says why** — no public URL yet, or no mail set up — in the UI next to the
  copy/print link, and in the audit log. A reset or invite that could not be sent is no longer
  invisible.
- **Database snapshot for backups** — a `VACUUM INTO` copy on the data volume every 30 minutes,
  verified with `integrity_check` before it is published. The platform tars the volume while the
  container is running, and SQLite in WAL mode has three files at rest, so a naive capture can be
  torn in a way nothing downstream can detect. The archive now always contains one restorable copy.

### Fixed

- **Autopay could stop for a family, silently and permanently.** With no webhook, a run whose
  PaymentIntent ended in a terminal failure was never resolved, stayed `pending` forever, and the
  pending-run guard then blocked that family from ever being charged again. Reconciliation now asks
  Stripe what happened to every stuck run and resolves it. A run whose PaymentIntent never existed
  is closed **without** a retry strike — nothing was presented to the card, so our own network error
  must not count against the family.
- **Every admin alert would have failed.** The platform reads the alert id from `alert`; we sent
  `id`, so all three alerts 400'd — and because they replaced working webhook notifications, this
  would have made those events *less* reachable than v0.36.0. Alerts now also carry a severity
  (a recovered payment is `info`, not a warning).
- **A suppressed platform email was reported as sent.** `POST /api/fabric/email` answers **HTTP 200**
  with `{ sent: false, reason }` when the masjid has no mail provider configured, so trusting the
  status code marked an unsent invite as emailed and audited it as delivered. The response body is
  now the signal, and the reason is logged.
- A disabled *Send password reset* button explained itself only through a `title` tooltip, which
  browsers do not show on disabled controls and which never reaches touch or keyboard users. It is
  real text now, and actionable, since a guardian's email can finally be edited.
- **A negative charge could not be entered.** The amount field used the owed-amount parser, which
  rejects negatives, so the credit / scholarship / correction path documented in 0.36.0 silently
  never submitted. Charges and charge items now use a signed parser; payments, fee-plan prices,
  overrides and discounts still refuse a minus sign, where it is a typo.

### Notes

- `payment_channels` gains `ach`. The column is plain text with no CHECK constraint, so there is no
  migration and existing rows are untouched. This deviates from the list in CLAUDE.md §9 by one
  value, deliberately.
- `packages/server/src/config.ts`'s `version` is bumped with the release. §19 does not list it, but
  it feeds the version shown to every user and the `appVersion` stamped into each DB snapshot
  manifest — worth adding to that runbook.

## [0.36.0]

> **Corrected after release.** The entries below originally described the school year, terms,
> courses, classes, mass apply, the charge catalogue and the fee-override note as delivered
> features. They were built on the server but had **no user interface**, so none of them could be
> reached on a real install. The wording now says what shipped; the screens arrived in 0.37.0.

### Added

- **School year + terms — data model and API only (no UI until 0.37.0).** A year carries the
  from/to months the billing periods derive from; terms exist so `per-term` tuition means something.
- **Courses → classes — data model and API only (no UI until 0.37.0).** An organisational grouping
  (e.g. Hifz → Hifz 1): no teachers, attendance, grades or capacity — that scope stays out (§4 ❌).
  Because nothing could create a course or class, every student remained unplaced in practice.
- **Students tab**, replacing the family-first Directory: every student grouped by course and
  class, search, a withdrawn filter, and inline class placement. (The grouping only became usable in
  0.37.0, once classes could be created; the *No class* bucket is forced last in the roster view.)
- **CSV student import** — pick a file, confirm the auto-matched column mapping, review every
  resolved row and its problems, then commit. The commit is all-or-nothing: a file with any bad
  row imports nothing. A blank template is downloadable. Student IDs and PINs are never imported;
  they are always generated here.
- **One-off charges** (books, uniform, registration, late fees) with a configurable item
  catalogue — **API only (no UI until 0.37.0)**. A charge lands on the period's invoice immediately
  when one is open, otherwise it waits for the next generation. A negative charge is how a credit or
  scholarship is issued.
- **Mass apply** for both fee plans and charges, targeting explicit students, a class, or a whole
  course — **API only (no UI until 0.37.0)**.
- **Per-student fee override + note** — charge one student a different amount without minting a
  parallel plan. **API only (no UI until 0.37.0);** the note renders beside the amount from 0.37.0.
- **Move a student to another family**, which is how siblings are linked. Guardians hang off the
  family, so nothing is copied per student. Invoices already raised stay with the family that was
  billed; only future billing redirects.
- First **frontend test suite** (`packages/web`), covering CSV parsing and column auto-matching.

### Changed

- **Adding a student now requires a fee plan.** A student on no plan is skipped silently by invoice
  generation, which is how a child stops being billed without anyone noticing. Enforced
  server-side, not just in the form.
- **English only.** The Arabic and Urdu locales and the language picker were removed by decision.
  Strings still go through i18next so copy stays in one reviewable file.

### Fixed

- **`fee_plans.cadence` is now honoured.** It was stored and never read, so a **`one_time` plan
  re-billed every single period** — a live over-billing bug. Monthly plans now bill only on month
  periods, per-term plans only on term periods, and a one-time plan exactly once. **Behaviour
  change on existing data:** any one-time plan that has been re-billing will stop.
- The bundled Arabic Naskh face was referenced with a root-absolute URL and so **404'd behind the
  Cloudflare tunnel prefix**; the stylesheet went with the locales.

## [0.35.0]

### Changed — major scope pivot: tuition & fee management only
- **OpenMasjid Students is now a tuition/fee app, not a full SIS.** Everything academic was
  **removed**: classes, weekly timetable/scheduling, attendance, gradebook, grading scales,
  merit points, the comment bank, exams, report cards, transcripts, term finals, the
  admissions pipeline (including the public enquiry form), the Report Creator, custom student
  fields, documents-on-file, and student notes/incidents. The **teacher role** is gone too.
- **What remains** is the whole money side: families & students (name + PIN), **per-student
  fee plans**, family invoices, the derived ledger, manual (cash/Zelle/check) and card
  payments (parent-portal Stripe + autopay + saved cards), printable statements, and the
  `students/billing` Fabric provider that powers tuition on the **OpenMasjid Donations** site
  and **Kiosk**. Three roles: admin (LAN-only), finance, and parent.
- **Fees are now assigned per student** (`student_fees`) instead of per class enrollment. The
  invoice engine, ledger, payments, statements, portal, and the entire Fabric contract are
  unchanged — the money never moved, only where a fee hangs. **Upgrades preserve every existing
  fee assignment**: migration `0020` creates `student_fees` and **backfills it from the old
  per-enrollment assignments** before `0021` tears down the SIS tables.
- **Repo + image renamed** `OpenMasjidStudentManager` → `OpenMasjidStudents`
  (`ghcr.io/openmasjid-solutions/openmasjidstudents`). App id stays `students`.
- Migration `0021` drops all SIS tables (children-before-parents so it's safe on a populated
  DB) and **disables any leftover `teacher` accounts + kills their sessions** (the role was
  removed). **Academic data is dropped** — intended; families, students, invoices, payments and
  fee assignments are preserved.

## [0.34.0]

### Added
- **Turn tuition payments on your donation site & kiosk on or off** — a new switch in
  **Settings → Payments**. When it's on (the default), families can pay their balance with their
  child's name + PIN through the masjid's OpenMasjid **Donations** site and **Kiosk**; turn it off to
  hide tuition there without touching the parent portal. This is the admin control behind the
  `students/billing` Fabric capability's `info.enabled` — the first consumer, **OpenMasjid Donations,
  is now wired up to it** (its `tuition` campaign type looks up the balance and records the payment
  through this app over the OpenMasjidOS Fabric).

## [0.33.0]

### Added
- **Parents can sign themselves up** (§12) — a **"New here? Create your account"** link on sign-in.
  A parent enters their **child's name + PIN + an email the office already has on file** (all must
  match the same family — a PIN alone is never enough), and the app emails that guardian a setup link.
  Admins can turn this off in **Settings** (default on); it needs email set up, and falls back to
  office invites when off. The response is always the same generic "check your inbox", so it never
  reveals whether a child, PIN, or email is on file.

### Security
- The PIN is protected by a **per-PIN lockout** (shared with the donation/kiosk lookup) **and** a
  per-IP throttle, and — hardened in review — the setup email is sent **fire-and-forget** so a correct
  guess can't be told from a wrong one by timing (no PIN-discovery oracle, §14). The setup link only
  ever goes to the on-file email, so only its owner can complete signup. PINs are never logged.

## [0.32.0]

### Changed
- **Payments settings are now a Stripe-account picker, not a webhook form.** The admin chooses which
  of the masjid's **OpenMasjidOS Stripe accounts** tuition is collected into (a dropdown), and that one
  account is used everywhere — parent-portal pay-now, autopay, and the **`tuition` campaign type on the
  donation site and kiosk** (which this app fully drives over the Fabric). Only the account id + label
  ever leave the platform; keys stay in server memory.
- **Removed all Stripe-webhook machinery** (no endpoint, no auto-registration, no signing secret to
  manage). Payments are recorded by: the Fabric record-payment calls (donations/kiosk), the portal's
  **confirm-on-return** (the app retrieves the PaymentIntent after the parent pays and records it), and
  autopay's synchronous confirm — with the **daily reconciliation** as the catch-all. Nothing to
  configure.

### Security / correctness (hardening from the step review)
- A **failed account switch never leaves the old account's keys live** — `loadStripeKeys` clears its
  cached client on any error, so charges can't silently route to the wrong Stripe account.
- **Switching the tuition account resets stale per-family Stripe state** — saved cards + Customers live
  on the old account, so they're cleared and autopay is turned off (parents re-add a card on the new
  account); the ledger and payment history are untouched.
- **Reconciliation holds its cursor below any still-pending PI**, so a payment that settles after a
  later one can never be skipped — important now that reconcile is the sole backstop.

## [0.31.0]

### Fixed
- **Accessibility / RTL polish pass** over the newest screens (email settings, password reset,
  payment sync, saved cards + autopay, payments). The autopay toggle now honors
  `prefers-reduced-motion` (it still switches, just without the sliding animation). The sweep
  confirmed the new UI already uses logical (RTL-safe) layout properties, theme tokens (no hardcoded
  colours), and light/dark throughout.

## [0.30.0]

### Added
- **Stripe webhook auto-setup** (§13.4) — when the masjid is online (has a public URL) and Stripe is
  configured, the app now **registers its own Stripe webhook endpoint on boot** and stores the signing
  secret, so card-payment confirmations arrive instantly with no manual Stripe configuration. It's
  idempotent (an endpoint already at our URL is reclaimed, never duplicated) and best-effort (a failure
  never blocks startup — the daily reconcile still recovers any missed payment).
- **Settings → Payments** — shows whether the webhook is set up (automatically, via OpenMasjidOS, or
  not yet), the webhook URL for manual setup, and a field to **paste a signing secret by hand** as a
  fallback. Inbound webhooks verify against the stored secret first, then the platform's.

### Security
- The webhook signing secret is stored in the app DB (already a secret, §9) and is **never logged or
  returned to the client**; the manual-paste field validates the `whsec_` prefix and is admin-only.

## [0.29.0]

### Added
- **Password reset** (§12) — a **"Forgot password?"** link on the sign-in page. A parent (or staff)
  enters their email and, when email is set up, gets a one-time link (1-hour expiry) to set a new
  password at `/family/reset`; completing it signs them out everywhere and they sign in fresh. The
  request response is always generic — it never reveals whether an email is registered. Without email
  configured, resets go through the office (an admin sets a temporary password), exactly as before.

### Security / correctness
- No account-enumeration oracle: the reset request looks the same whether or not the email exists, and
  no un-deliverable token is minted when email isn't set up.
- The reset target is resolved **deterministically** — the unique username first (case-insensitive,
  matching login), then the email address only when it identifies exactly one active account — so a
  username⇄email collision can never reset the wrong account. Tokens are single-use, hashed at rest,
  short-lived, and rate-limited on both request and confirm.

## [0.28.0]

### Added
- **Email (SMTP)** (§4) — an admin **Settings → Email** page (host/port/from/username/password/TLS +
  a "Send test" button; the password is write-only and never shown again). With email set up, the app
  now sends, automatically and best-effort:
  - **Parent-portal invites** — the invite link is emailed to the guardian; the office still gets the
    copy/print link too (so a failed send never blocks anything). **Admissions one-click enroll now
    auto-invites** the guardian.
  - **Payment receipts** — after a portal or autopay card payment, the family's guardians get a receipt
    (worded "payment", never "donation", §13.2.5). Exactly one receipt per payment.
  - **Autopay-failure notices** — parents are emailed when a charge fails (with a "pay now / update
    card" note) and again if autopay is turned off after the third failure.
- **Graceful degradation** — with no SMTP configured (or no public URL for invite links), everything
  still works: invites fall back to copy/print links and nothing errors. Email is optional.

### Security / correctness
- The SMTP password is stored in the app DB (the DB is already a secret, §9) but is **never logged,
  never returned to the client, and never written to the audit log**; saving other fields without
  re-typing the password keeps the stored one.
- Invites are only emailed when an absolute (tunnel) URL exists, so a parent never receives a dead
  relative link; the office copy/print link (absolute-ized in the browser) is the LAN fallback.

## [0.27.0]

### Added
- **Runs behind the OpenMasjidOS Cloudflare tunnel at `/students`** (§12/§15). Teachers, the finance
  manager, and parents can now sign in and work over the tunnel (admin stays LAN-only via the
  `omos_session` SSO cookie — enforced server-side, unchanged). One build serves at the root on the
  LAN and under the admin-chosen tunnel prefix: the server strips the forwarded prefix before routing
  and injects a `<base href>` + `window.__OMOS_BASE__`; the client (Vite `base: './'` + a small
  `base.ts`) keeps the prefix on tRPC, the public `/apply` form, report/transcript/statement links,
  and the Stripe webhook URL. Mirrors the shipped OpenMasjidDonations pattern.
- **Inherits the OS dashboard's appearance** (§15) — the parent portal and staff surfaces now pick up
  the masjid's **wallpaper** and **light/dark** theme from OpenMasjidOS: a one-shot `#omos=` hand-off
  when opened from the dashboard, plus live sync via a same-origin `/api/public/appearance` relay
  (polled every 45s). Preset wallpapers are local CSS gradients, so they render over the tunnel with
  no OS-hosted assets. A manual theme change in-app stops the app from following the OS.

### Security / correctness (hardening from the step review)
- **The session cookie is scoped to the app's mount path** (e.g. `/students`) instead of `/`, so the
  token is never sent to sibling apps sharing the tunnel domain (defense-in-depth, §14).
- **The appearance relay's 4-second timeout now bounds the whole exchange** (the abort is cleared only
  after the body is read), and a 10s cache keeps many polling tabs from piling up outbound requests.

## [0.26.0]

### Added
- **Stripe reconciliation — the payments safety net** (§11.4). A daily job (07:00) plus an on-demand
  **"Reconcile now"** button on the finance Billing page list every succeeded tuition PaymentIntent
  (`metadata.purpose == "students-billing"`) since a stored cursor and record any the ledger is
  missing — flagged `via: reconciliation`. This recovers **both** a missed Donations/Kiosk broker call
  **and** a missed webhook for our own portal/autopay intents, so **money is never lost, only delayed**.
  Recording goes through the one idempotent ledger path (keyed on the PaymentIntent id), so a
  reconcile that overlaps a late webhook, or a re-run over the same window, is a harmless no-op.
  Recovering an autopay charge also resolves its stuck-`pending` run and resets the retry ladder.

### Security / correctness (hardening from the step-17 adversarial review)
- **The cursor never advances past a PI that failed to record.** A transient write error on one PI
  (e.g. a family row not yet present) now holds the cursor strictly below that PaymentIntent so the
  next run retries it — a payment collected in Stripe can never be silently skipped. Truly
  unattributable PIs (missing family / unknown origin) are logged for manual handling and don't wedge
  the scan.
- **A stuck-`pending` autopay run is healed even when its payment was already recorded** — reconcile
  now mirrors the webhook and resolves the run unconditionally, so a crash between the ledger write
  and the run update can't leave a family's autopay silently blocked forever.

## [0.25.0]

### Added
- **Saved cards + autopay in the parent portal** (§13.3) — a parent can save a card with a Stripe
  **SetupIntent** (off-session capable; card data never touches our server — only brand/last4/expiry
  references are stored, never a PAN) and toggle **autopay** for their family, with clear consent
  copy. A daily in-process scheduler (croner) charges every autopay-on family the sum of its invoices
  **due by today**, off-session, against the default card. `autopay_runs` is UNIQUE per (family, day)
  and the Stripe idempotency key is derived from the run id — one attempt per family per day.
- **Retry ladder** — a failed autopay charge retries on **day +2** then **day +5**; after the **third**
  failure autopay auto-disables and finance is notified. A successful charge — through **any** channel —
  resets the ladder. All autopay changes are audited.

### Security / correctness (hardening from the step-16 adversarial review)
- **No cross-day double-charge on an unrecorded success.** An off-session confirm returns the outcome
  synchronously, so a successful charge is now recorded to the ledger **immediately** (idempotent on the
  PaymentIntent id — the webhook re-delivery is a harmless no-op). The balance clears before the next
  daily tick, so a delayed/lost webhook can no longer leave the family "due" and get charged again. A
  belt-and-suspenders **pending-run guard** additionally blocks a re-charge while a prior charge's
  outcome is still unknown.
- **Indeterminate failures no longer corrupt the ladder.** A definite card decline advances the ladder;
  an ambiguous network/timeout error (where the charge may have gone through) leaves the run pending for
  the webhook/reconciliation and does **not** advance the ladder — preventing a false early auto-disable.
- **Robust run linkage.** Webhook success/failure now resolve the autopay run by our own run id (carried
  in the PaymentIntent metadata) with a PaymentIntent-id fallback, and backfill the id — so a run whose
  create() timed out before persisting the id is still reconciled correctly.
- **Ladder resets on any balance-clearing payment.** Paying the balance via portal, cash, or the
  Donations/Kiosk Fabric now resets a stale autopay failure count, so a fresh billing cycle starts clean.

## [0.24.0]

### Added
- **Pay tuition by card in the parent portal** (§13.1/§13.2) — Stripe pay-now. A parent with a
  balance sees **Pay now**, enters an amount (default their full balance), and pays with **Stripe
  Elements** — card data never touches our server. Stripe keys are fetched from the OS over the
  Fabric (`GET /api/fabric/stripe`); the publishable key goes to the browser, the secret key stays
  in server memory only. The **ledger truth lands on the signature-verified webhook**
  (`POST /api/stripe/webhook`): it verifies the Stripe signature over the raw body, dedupes events,
  records the payment on the `portal` (or `autopay`) channel with the PaymentIntent id as the
  idempotency key, and only ever touches OUR intents (`metadata.omos_app = students-portal`).
  Success is worded honestly ("it'll show on your account in a moment"), since the webhook confirms
  it. Card payments degrade gracefully ("temporarily unavailable") when keys aren't configured.
  9 payment tests (184 total) covering the webhook→ledger core; the live Elements flow needs a
  Stripe test account wired through the OS.

### Fixed (from an adversarial review of the slice)
- The webhook only **notifies finance on a genuinely-new payment** — a re-delivery or a
  reconciliation overlap (payment already recorded via the PI-id key) no longer re-alerts.
- A live Stripe/DB error during pay-now now returns a **warm one-line message** instead of a raw
  technical string (§18: no raw error reaches the user).

## [0.23.0]

### Added
- **Fabric provider — `students/billing` capability** (§11, the shared cross-repo contract). The
  `/fabric/billing/*` methods the OpenMasjidOS core brokers from Donations and Kiosk so a parent can
  pay tuition with their **child's name + PIN**: `info` (school + currency + enabled), `lookup`
  (name + PIN → family + balance + open invoices), `record-payment` (idempotent, through the one
  ledger write path), and `check` (outbox retry helper). Every response carries `"v": 1`.
  Security (§11.1/§14): constant-time app-secret check (401 first; a standalone install with no
  secret accepts nothing), tunnel-origin refused, strict zod, and idempotency at the DB. The lookup
  gives a **uniform `found:false`** for every mismatch (no enumeration oracle), never returns full
  last names / DOB / contact (first name + last initial only), and enforces a **per-PIN lockout**
  (10 failed matches/hour → the PIN is locked and finance is notified) to compensate for the PIN's
  low entropy. External payments fire a best-effort Fabric notification. An admin toggle can turn
  external payments off (`info.enabled=false` → consumers hide the tuition campaign). 8 contract
  tests (179 total). Consumers reach this only through the OS broker; it's never exposed over the tunnel.

## [0.22.0]

### Added
- **Report Creator** (§4/§5/§14) — the office's own saved-report builder over **code-defined
  datasets, never raw SQL**. Pick a dataset (Student directory, Invoices, Payments, Admissions),
  choose columns, add filters and a sort, and **Run** → an on-screen table, **CSV export**
  (formula-injection-escaped), and print. Datasets are **role-scoped at the registry**: admin sees
  all; **finance sees billing + directory datasets only**; teachers/parents get no Report Creator.
  Every run re-checks the dataset's minimum role, and user picks (columns/filters/sort) are validated
  against the registry and applied in memory — unknown keys are dropped, never interpolated into SQL.
  Available to admin and finance in their docks. i18n en/ar/ur. 6 tests (170 total) incl. the
  no-injection guarantee and role walls; browser-verified build → run → table → CSV.

### Fixed (from an adversarial review of the slice)
- Report **filters are now type-aware**: a money column (stored in cents, shown as dollars) filtered
  with "50" / "50.00" now matches the $50.00 rows (equals parses dollars; contains matches the
  formatted value), instead of comparing against raw cents. 1 more test (171 total).

## [0.21.0]

### Added
- **Public admissions form** (§4/§14) — a families' **enquiry form served over the tunnel with no
  login** at `/apply`: guardian name + contact, child name + DOB, and program interest. It's the
  app's most hostile surface, so it's locked down: strict zod with hard length caps (oversized input
  rejected generically — no field or data leak), a **honeypot** field (bots that fill it get a
  success response but nothing is stored), **per-IP burst + daily rate limits** keyed on the real
  client IP, no file uploads, and submissions stored as **inert** data that can only ever create one
  `enquiry` row (never pre-enrolled). New public submissions land in the staff pipeline flagged
  "from website." i18n en/ar/ur. 5 hostile-input tests (162 total); browser-verified end to end.

### Fixed (from an adversarial review of the slice)
- The in-process rate-limiter maps are now **hard-bounded** (evict oldest-first) instead of only
  pruning expired entries above a soft threshold — so a distributed flood (or IPv6-prefix rotation)
  of distinct IPs can't grow the map unbounded or force an O(n) scan on every request. Removes the
  per-request full-scan hot path entirely; applied to both the login and submission limiters. 2 more
  tests (164 total).

## [0.20.0]

### Added
- **Admissions pipeline + one-click enroll** (§4/§5), staff-facing. Admin and finance run the
  pipeline — **enquiry → application → accepted / waitlisted / declined → enrolled** — add applicants,
  move stages, and keep per-applicant notes. **One-click enroll** creates the family + student (with
  an auto PIN) + guardian (linked) + class enrollment, optionally assigns a fee plan and generates
  the first invoice, and flips the applicant to *enrolled* — all in one atomic transaction. Admin
  gets an **Admissions** dock section; finance's app now has Billing **and** Admissions. `enrolled`
  is reachable only via enroll (never a manual stage move); applicant data is stored inert and
  rendered as text only (the anonymous public /apply form lands next). i18n en/ar/ur. 5 new tests
  (157 total); browser-verified the pipeline and enroll.

### Fixed (from an adversarial review of the slice)
- One-click enroll now **audits the enrollment before** the (post-transaction) first-invoice step,
  and treats an invoice failure as **non-fatal** — the enroll always succeeds and is recorded, and
  the UI says "generate the first invoice in Billing" instead of erroring and wedging a retry.
- Enroll **refuses an archived fee plan** up front (it would otherwise create an enrollment fee that
  silently never invoices).

## [0.19.0]

### Added
- **Each child's weekly schedule in the parent portal** (§4/§15) — the child page now opens with a
  week-at-a-glance timetable (day cards with time, class, type, and room) built from the class
  sessions across all the child's enrolled classes. New parent-scoped `portal.childSchedule` (gated
  by `assertStudentAccess` — own kids only), rendering through the shared `WeekGrid` so it matches
  the staff timetable and collapses cleanly to one column on a phone. i18n en/ar/ur. 1 new test
  (152 total); browser-verified. This completes the parent portal's read surface (schedule, grades,
  attendance, merit, report cards & transcripts, balance & payments). A clean adversarial review
  found nothing.

## [0.18.0]

### Added
- **Per-child academics in the parent portal** (§4/§5/§15) — tapping a child on the family home opens
  a phone-first page with their **grades** (gradebook items + the child's score, by class), an
  **attendance** summary (present / late / excused / absent tallies + recent records) and **merit
  points** (running total + award history). New parent-scoped `portal.childGrades` / `childAttendance`
  / `childMerit`, each gated by `assertStudentAccess` — a parent can read only their own kids, never
  another family's (enforced in the query, not the UI). i18n en/ar/ur. 1 new test (151 total) plus the
  scoping wall; browser-verified end to end.

### Fixed (from an adversarial review of the slice)
- The child page now distinguishes **loading and errors from a genuinely empty record** — a transient
  failure no longer tells a parent their child has "No grades yet." (mirrors the family-home guard).

## [0.17.0]

### Added
- **Report cards & transcripts in the parent portal** (§4/§5/§14) — the documents families keep,
  now in the portal. Parents see and **download their own kids' PUBLISHED report cards** (the latest
  published version per class) **and transcripts**, right on the My-Family home. The PDFs are served
  only through the authed route, which now also honors the **parent** role: a parent may fetch an
  artifact **only when it is published AND belongs to one of their kids** — never another family's,
  never an unpublished draft (admin/assigned-teacher access and the finance/staff walls are
  unchanged). New `portal.myReports` (published-only, own-kids-only, scoped in the query). i18n
  en/ar/ur. 2 new tests (150 total); browser-verified own published card → 200, unpublished → 403.

### Fixed (from an adversarial review of the slice)
- The report-card, transcript, and combined-class PDF responses now send **`Cache-Control:
  no-store`**, matching the family-statement route — so a minor's academic PDF opened over the
  tunnel on a shared device isn't left in the browser cache after the session ends.

## [0.16.0]

### Added
- **Parent portal — the door + My-Family home** (§4/§5/§12/§14), the read-only first slice of the
  headline feature. Finance/admin **invite a guardian to the portal** (one-time CSPRNG link, stored
  SHA-256-hashed, single-use, 7-day expiry — emailed once SMTP lands; for now the office copies the
  link). The guardian **accepts the invite** on an anonymous page (reachable over the Cloudflare
  tunnel), sets a password → a `parent` account + `guardian_users` link are created and they're
  signed in. The **phone-first portal** shows their **own family only** — kids (with PINs), the
  family balance, open invoices, and the unified payment history. Parents work LAN **and** tunnel;
  scoping is enforced in every query (via `guardian_users`), never the UI — a parent can't reach
  another family or any staff data. `parent`-role wall, per-IP rate-limit on invite acceptance, and
  an in-transaction single-use guard. i18n en/ar/ur. Grades / schedule / merit / attendance /
  report cards, and self-registration (needs SMTP), arrive in later slices. 11 new tests (148 total).

### Fixed (from an adversarial review of the slice)
- **Parent login is now case-insensitive.** Accounts store the guardian email lowercased, but the
  login lookup matched case-sensitively — so a parent whose email had any capital (or whose phone
  keyboard auto-capitalized) was locked out. Lookup now compares on `lower()`, existing mixed-case
  admin/staff logins still work, and the login field disables auto-capitalize/correct.
- **Long emails no longer break login** — the login username cap now fits a full email address.
- **The portal home distinguishes a load error from “no family”** — a transient failure no longer
  tells a parent to call the office.

## [0.15.0]

### Added
- **Printable family statements** (§4/§14) — a self-contained, print-CSS HTML sheet finance/admin
  hand to a family. It shows the family balance, open invoices (oldest-due-first), recent payments,
  **each child's PIN**, the "pay with your child's name + PIN at the donation site or kiosk" line,
  and a **QR code to the parent-portal signup** (points at the tunnel public URL when set, else the
  LAN address the request came in on). A "Print statement" button opens it from the family billing
  window; a Print button in the sheet is hidden in the print stylesheet, and the layout is neutral
  ink so it photocopies cleanly in black-and-white. Served by an authed route that re-checks the
  role × origin matrix on every fetch — **admin (LAN only) and finance (LAN + tunnel) only; teacher
  and parent never** — with `Cache-Control: no-store` and never on a public static mount (it embeds
  minors' PINs, §14). Every embedded value (school/family/student names, memos, labels) is
  HTML-escaped. Student PIN generate/regenerate/view already shipped (people router + Family detail);
  per-PIN lookup lockout lands with the Fabric lookup endpoint it protects. 6 new tests (137 total).

### Fixed (from an adversarial review of the slice)
- Open invoices on the statement now sort **oldest-due-first with undated invoices last**, matching
  the ledger's allocation order (SQLite sorts NULL first under a bare `ASC`, which would otherwise
  float an undated invoice to the top of the printed sheet).

## [0.14.0]

### Added
- **Billing core** (§4/§5/§9/§16) — the money side, ours end to end. **Fee plans** (amount in
  integer cents, cadence monthly/per-term/one-time) assignable per enrollment; a per-family
  **discount** (fixed or percent). **Invoice generation** — per family or per period, idempotent on
  family+period, one negative line for the discount, skips families with no fees. The **ledger** is
  the single money-write path (`billing/ledger.ts`): derived balances (never stored), payments are
  immutable (corrections are reversal rows), allocation is oldest-due-first with surplus → family
  credit, and every write is idempotent on its key. **Manual payments** (cash/Zelle/check/other)
  with reverse; **void** an unpaid invoice. Admin + finance only — finance works LAN **and** over
  the tunnel; admin stays LAN-only (origin policy). New **finance role app** (Billing-only shell), a
  **Billing** section in admin (fee plans, period generation, families-with-balances overview), and
  a per-family billing window (balance, fee assignment, invoices, payment entry, ledger, discount).
  i18n en/ar/ur. 10 new tests (131 total).

### Fixed (from an adversarial review of the money layer)
- **Oldest-due-first no longer skips dated invoices.** SQLite sorts `NULL` before any value, so an
  undated invoice would jump ahead of a genuinely-due one and absorb a payment first — leaving the
  real bill open. Undated invoices now sort **last** in auto-allocation.
- **Explicit allocations can't overpay a bill.** The Fabric/webhook allocation path now rejects an
  allocation that exceeds an invoice's remaining balance, one whose total exceeds the payment
  amount, or one against a voided invoice — no more negative credit or `paid > total`.
- **Voiding a paid invoice is refused server-side.** Voiding dropped the invoice from the invoiced
  total while its payment stayed counted, understating the family balance; the server now returns a
  friendly conflict and asks you to reverse the payment first (the UI already discouraged it).
- **The family-discount form now shows the current discount** instead of silently defaulting to
  "None" (which could overwrite a saved discount on an unrelated save).

## [0.13.0]

### Added
- **Comment bank** (§4/§5) — reusable remark snippets to speed up term-end writing. A **shared**
  bank the office manages (admin) plus each teacher's **personal** bank; both are **inserted into
  the term-remark field** from an "Insert snippet…" picker in the exam panel. Teachers read shared
  + their own and manage only their own; admin manages the shared bank in **Settings → Comment
  bank**; finance/parent never see it. 4 new tests (113 total).

### Fixed (from an adversarial review of the slice)
- The term-remark field now only saves on blur when it was actually **edited**, so blurring an
  untouched field can't overwrite a co-teacher's meanwhile-saved remark (a last-write-wins
  regression the controlled-draft change would otherwise have introduced).

## [0.12.0]

### Added
- **Term close → finals → transcripts** (§4/§9/§16) — the term-end machine. Closing a term
  **freezes** each active enrollment's final grade into `term_finals` (recomputed on every close,
  UNIQUE per student+class); reopening lets the office fix something and re-close. The final-grade
  math now lives in ONE place (`grades/final.ts` `computeFinal`) shared by term close **and** the
  report card's overall, so they can never diverge. **Transcripts** — a student's cumulative,
  multi-year record built ONLY from the frozen finals (every term, every class with type, the
  final % + scale band) — render on the same @react-pdf pipeline as report cards: immutable,
  versioned, with a frozen data snapshot, served through the authed route (admin-LAN-only for now).
  Admin UI: **Close/Reopen term** in Classes and a **Transcript** panel (generate/download/publish)
  on the student record. 7 new tests (109 total).

### Fixed (from an adversarial review of the slice)
- **A closed term now locks its exam marks** — edits are refused until the term is reopened, so a
  frozen final can never silently diverge from the marks.
- **Re-closing a term reconciles its finals** — a since-withdrawn or mistaken enrollment's stale
  final is dropped (no orphan rows on the transcript), and classes archived after they finished
  still get their finals.
- **Transcripts order terms by start date** (then creation), so backfilled historical terms sit in
  the right place. Closed terms are now marked in the term list.

## [0.11.0]

### Added
- **Report cards** (§4/§9/§14) — the artifact families keep. The admin generates a dignified
  **PDF report card** per student (or the whole class), rendered server-side with @react-pdf
  (Pi-friendly, no headless browser) using a bundled Amiri font so Arabic names/subjects shape
  correctly. Each card carries the school name, term, class + type, a **per-subject marks matrix
  across the term's exams**, totals + percentage + the class's **scale band**, an attendance
  summary, an optional **merit total** (admin toggle), and the teacher's remark. Cards are
  **immutable, versioned artifacts** filed on the record — regenerating after a fix creates
  version N+1; a **combined class PDF** (a page per student) prints the filed versions.
  A **publish** flag (per class) is set now for the parent portal that follows. PDFs are served
  ONLY through an **authed route** that re-checks the role × origin matrix on every fetch (admin
  LAN-only, the assigned teacher for their class; finance never; parents with the portal) — never
  a guessable URL, never a public mount. New admin **School** settings (name, currency, merit
  toggle). 7 new tests (103 total).

### Fixed (from an adversarial review of the slice)
- **Concurrent regeneration can no longer collide on a version** — the next version is reserved
  in a synchronous transaction, backed by a UNIQUE(student, class, version) constraint.
- The **combined class PDF now reproduces the filed versions exactly** (a frozen data snapshot on
  each card) instead of re-aggregating live data, and skips students with no generated card.
- The **scale band is computed from the exact ratio**, so a score just under a cutoff isn't
  promoted a band by display rounding.
- Duplicate subject names in a class are rejected (they would collide on the report card);
  generating for a non-enrolled student returns a friendly error; the School settings form no
  longer risks saving stale defaults before it loads.

## [0.10.0]

### Added
- **Exams** (§4/§5/§9) — the first half of the term-end machine. The admin defines a term's
  exams (e.g. Mid-Term, Final) and **assigns each to classes**; assigning **snapshots** the
  class's subjects into the exam with an editable per-subject **max mark** (default 100), so
  later edits to the class's subjects never corrupt a past exam. Teachers (and admin) fill a
  students × subjects **score grid** — a mark, or an explicit **absent** / **exempt** (a blank
  means "not entered", which blocks completion) — plus an optional per-student **term remark**,
  with a live **progress bar**. The admin gets a **completion dashboard** (scored-vs-enrolled
  per class). Definitions/assignment are admin-only; score entry is admin or the assigned
  teacher (scoped via `classAccess`); finance/parent are refused; admin stays LAN-only. Lowering
  a subject's max below an already-entered mark is rejected; score writes are audited without
  per-student PII. New **Exams** admin section + an **Exams** panel in every class window.
  5 new tests (96 total).

### Notes
- Report-card PDFs, term close/finals, transcripts and the comment bank build on this in the
  next slices. Reviewed solo this release (the shared session limit was active); the access
  walls reuse the pattern already hardened by the 0.7.0/0.8.0 adversarial reviews.

## [0.9.0]

### Added
- **Merit points** (§4/§5) — very madrasa: teachers (and admin) **award or deduct** points to
  students in their own classes against **admin-defined categories with default point values**.
  Ships four editable defaults — **Ādāb, Sunnah practice, Hifz milestone, Helping others** —
  seeded on first boot. A `MeritPanel` in the class window has the award form (category picks a
  default, adjustable, negative allowed), a staff-side **leaderboard** of term totals, and the
  recent awards with a one-tap **undo**; admin manages categories in **Settings → Merit categories**.
  Teacher access is scoped to their own classes (via `classAccess`); finance never sees merit;
  parents see their own kids in the portal (later). Awards are audited with no per-student PII.
  5 new tests (91 total).

## [0.8.0]

### Added
- **Gradebook** (§4/§5/§9): assignments (grade items — title, out-of, optional category) and
  student scores per class, from the class window. A spreadsheet-style grid (assignments ×
  students) with per-cell save, a per-student **overall %** (total-points weighted) and its
  **scale band**, plus a per-assignment class average. Only enrolled students can be scored;
  scores are stored as integer hundredths of a point (no float drift). Admin **or** the assigned
  teacher can grade (scoped via `classAccess`); finance/parent are refused; admin stays LAN-only.
  Sensitive writes are audited with no per-student PII.
- **Grading scales** (§4): admin-defined scales (band label + min %). Ships three editable
  defaults — **Percentage**, **A–F**, and a madrasa scale **Mumtāz / Jayyid Jiddan / Jayyid /
  Maqbūl / Rāsib** — seeded on first boot. Each class picks its scale (admin sets it; teachers
  see it read-only). 8 new tests (86 total).

### Fixed (from an adversarial review of the slice)
- **`itemUpdate` can no longer lower an assignment's maximum below an already-entered score**
  (which would push a student over 100% and skew the band) — it's rejected with a friendly message.
- **Score-save errors are surfaced** to the teacher (over-max, etc.) instead of being silently
  swallowed, with an instant client-side over-max hint.
- **`scaleArchive`** now returns a clean *not found* (and writes no phantom audit entry) for a
  missing scale, matching its sibling mutations.
- A failed gradebook load now shows a friendly error with **Try again** instead of a stuck
  "Loading…"; deleting an assignment (which removes its scores) now **asks for confirmation**.

## [0.7.0]

### Added
- **Attendance** (§4/§5/§9): a teacher (or admin) marks a class's roster for a day —
  **present / late / absent / excused** with a bulk **All present** — from the class window.
  One row per (student, class, date), UNIQUE, so a save is an upsert. Only actively-enrolled
  students can be marked. **Same-day marking is routine; later edits and past-date (backfill)
  marks are audited** (who last marked is always stored), with **no PII in the audit detail**
  (counts + date only). Teacher access is scoped to their own classes (the wall is in the
  `classAccess` guard, not the UI); finance/parent are refused; admin stays LAN-only. A shared
  `AttendancePanel` (phone-friendly, semantic status colours, RTL-safe) serves both the teacher
  and admin class windows. 9 new tests (78 total).

### Fixed (from an adversarial review of the slice)
- **Timezone-safe backfill detection**: the client sends its local day so a routine evening
  mark isn't mislabelled a backfill across a UTC-container midnight (previously the audit could
  wrongly log `lateMark`, or miss a genuine backfill).
- **Duplicate student in one submission** is now rejected at the input boundary with a friendly
  error instead of surfacing a raw SQLite UNIQUE-constraint error.
- **AttendancePanel**: the "Saved" confirmation no longer gets wiped by the post-save refetch,
  and changing the date with unsaved marks now asks before discarding them.

## [0.6.0]

### Added
- **Weekly timetable** (§4): recurring class sessions (day + start/end + room), edited per class
  from the class window. **Soft double-booking warnings** — a shared teacher or a shared room at
  an overlapping time (same term + weekday) — that surface inline but **never block** (a madrasa
  reality is one ustādh covering two rooms). A new **Timetable** section views the week **by class,
  by teacher, or by student**, with a print-clean handout (black-on-white for a masjid photocopier).
- **Teacher app** (§5/§15): teachers now sign in to their own desktop shell (same dock + windows
  as admin) with **My week** (their scheduled sessions) and **My classes** (open a class read-only:
  schedule, subjects, co-teachers, roster). **Teacher scoping is enforced server-side** — a teacher
  sees only their assigned classes/students and cannot open another teacher's class (403), tested;
  teachers never see PINs, notes, incidents or money. Teachers work on the LAN **and** over the
  Cloudflare tunnel; admin stays LAN-only.
- 9 new tests (69 total): session CRUD + end-before-start guard, conflict detection (teacher/room,
  cross-term isolation), by-teacher/by-student views, and the teacher wall (mine/mineGet scoping,
  `mySchedule` isolation over the tunnel, non-admin/tunnel-admin refusals).

### Fixed
- **Light-theme legibility on the shell**: the desktop wallpaper is dark in *both* themes, so
  on-scene chrome (brand, clock, page titles, empty states) now uses a dedicated light on-scene
  token in both themes instead of the theme's ink — glass panels re-assert adaptive ink so their
  content stays readable in light mode. (Dark theme is visually unchanged.)

## [0.5.1]

### Fixed
- Top-bar chrome now matches the sibling **apps** (Kiosk / Donations / Display), not the
  OpenMasjidOS platform dashboard: a plain `.topclock` (time over a muted date, no glass
  box) and a subtle cyan-ring profile button, replacing the OS's boxed `.clock-widget` +
  filled avatar (§15 — copy the apps, not the platform). Added on-scene text legibility.

## [0.5.0]

### Changed
- **UI now uses the OpenMasjid family shell** (§15 — continuity with Kiosk / OpenMasjidOS /
  Display): the admin app has a top bar (brand + glass clock + profile menu), a **bottom
  dock** for navigation, and records (a family, a student, a class) open as **draggable
  macOS-style windows** — traffic-light controls, minimize-to-dock, stacking. Ported the
  shell from OpenMasjidOS (AppShell / Dock / WindowManager / Windows / Clock / ErrorBoundary;
  ProfileMenu adapted). Replaces the earlier bespoke topbar-nav so a masjid admin can't tell
  they left the platform.

### Added
- **Classes & scheduling groundwork** (§4): academic **terms** (one marked current),
  **classes** with a type (maktab / hifz / nazrah / ʿālim / custom) + an ordered, free-text
  **subject** list, **teacher assignment**, and **student enrollments** per class
  (withdraw / re-enroll). A **Dashboard** with live counts. Admin-only; teacher views +
  scoping + the weekly timetable come next.
- **Staff accounts** (§12): admin creates teacher/finance users with a temporary password;
  a **forced password change** on first sign-in; enable/disable (a disabled account's live
  sessions are revoked on the next request, via the session user re-check). 8 new tests
  (60 total): terms/classes/enrollments, teacher assignment (finance rejected), staff
  role walls, and the change-password flow.

## [0.4.0]

### Added
- **Student record extras** (§4/§5/§9/§14):
  - **Custom fields** — admin defines typed fields once (text / number / date / choose-one)
    in Settings; values live on each student and are validated against the field type on
    every write. Defs are soft-deleted so old values keep their meaning.
  - **Staff notes** — a running, append-only, staff-eyes-only activity log per student.
  - **Incidents** — date, category, description, action taken, recorded-by, with a
    per-incident **"visible to parents" toggle that defaults OFF** (§4). Finance never sees them.
- Admin UI: a **Settings** page (custom-field definitions) and a per-student record view
  (custom fields, notes, incidents) reached from the family record. i18n en/ar/ur, RTL.
- Walls tested (52 tests total): finance may read custom-field values but never notes/incidents;
  teacher/parent are denied for now (scoped reads land with classes/portal); the PIN and
  note/incident bodies never enter the audit trail.

### Fixed
- **`414 URI Too Long`** on the student record: tRPC batches multiple queries into one GET
  whose path exceeded Fastify's default `maxParamLength` (100), silently failing the batch
  (notes/incidents rendered empty). Raised `maxParamLength`. Caught by driving the real
  browser — the `createCaller` tests bypass HTTP and never hit it.

## [0.3.0]

### Added
- **People & SIS — the record of record** (§4/§5/§9/§14): families, students, guardians,
  the guardian↔family and guardian↔user links, and emergency contacts.
  - **Student PINs**: a 6-digit, CSPRNG, install-unique PIN is generated automatically at
    registration (the name+PIN lookup index for payments + portal). Retrievable by admin/
    finance, regenerable (audited) — never logged, never in the audit trail.
  - **Audit log** (append-only): every family/student/guardian create, update, withdraw and
    PIN regeneration records who/when/what — with PIN values and secrets excluded.
  - **Admin directory UI**: families as cards → family record with a students table (PIN,
    New-PIN, withdraw/reinstate), guardians (with emergency flag), and emergency contacts —
    the first admin dashboard, over the family scene. i18n en/ar/ur, RTL, dark/light.
- **Role walls enforced + tested** (§5): writes are admin-only; the directory + student
  records are admin **or** finance; teachers and parents have no access yet (their scoped
  reads land with classes/portal); admin remains LAN-only. 8 new tests (46 total) cover PIN
  uniqueness/regeneration, the create/withdraw/link flows, the role×origin walls, and that
  the PIN never reaches the audit detail.

## [0.2.0]

### Added
- **Authentication + access-origin policy** (the security foundation — §5, §12, §12.4, §14):
  - Local accounts with **argon2id** password hashing (`@node-rs/argon2`), server-side
    sessions (opaque token; only its SHA-256 is stored), first-run admin setup, login,
    logout. Login is brute-force rate-limited on the real TCP peer with generic errors.
  - **Origin policy: `admin` is LAN-only** — admin login AND existing admin sessions are
    refused over the Cloudflare tunnel; teacher/finance/parent work from both origins.
    Enforced in one tRPC middleware consulted by every procedure. Admin-over-tunnel is
    refused *before* password verification, so the tunnel is never a password oracle.
  - **SSO fast-path** (LAN only, env-gated): a valid OpenMasjidOS dashboard session mints
    a short-lived (1 h) local admin session; `username` treated as untrusted display text.
  - 32 tests: argon2id, origin classification + the full role × origin matrix, rate
    limiting, first-run, login, admin@tunnel → 403 at login and session-use, role walls, SSO.
- Auth UI: first-run **Setup**, **Login** (with the friendly admin-only-on-LAN note),
  signed-in **Home** placeholder + sign out; all strings in i18n (en/ar/ur), RTL-correct.

### Changed
- **One-click install** — removed the manifest `settings:` block; school name, currency and
  the Stripe account are configured inside the app (matches OpenMasjid Donations).

### Note
- Origin classification keys on `cf-ray` only (not `x-forwarded-proto`) — a deliberate,
  documented deviation from §12.4's literal wording, required because this `https: true`
  app's LAN TLS proxy also sets `x-forwarded-proto: https`. See `docs/DATA_MODEL.md`.

## [0.1.0]
Initial scaffolding, published to the OpenMasjidAPPS catalog: monorepo skeleton (npm
workspaces), Fastify + tRPC + SQLite (WAL) via Drizzle with migrations-on-boot, the
OpenMasjidOS "liquid glass" design system ported verbatim (i18n/RTL, dark/light, Amiri
Naskh), the `students/billing` contract + docs, and the multi-arch → GHCR CI.
