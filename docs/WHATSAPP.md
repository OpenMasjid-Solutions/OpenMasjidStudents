<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# WhatsApp — how this app uses it (0.50.0)

> The platform's contract is `docs/WHATSAPP.md` and `docs/APP_MANIFEST_SPEC.md` in **OpenMasjidOS**.
> This document is **our side**: what we send, what we refuse to send, every gate a message passes
> through, and why each of them exists. If the platform contract changes, that one wins.

---

## 1. What it is, and the constraint everything else follows from

A masjid installs **OpenWA** (MIT, self-hosted) from the OpenMasjidOS App Store and links a phone to
it. OpenMasjidOS then sends WhatsApp messages through it. Nothing goes to a third-party sending
service; it all stays on the masjid's own server.

**WhatsApp does not officially permit this.** OpenWA is a reverse-engineered client, and the linked
number can be restricted or banned. There is no way to make that risk zero.

Everything below follows from that sentence. It is not boilerplate and it is not a caveat — it is the
reason this app is built the way it is:

- **We never touch the gateway.** OpenMasjidOS owns the connection and runs **one paced queue shared
  by every app** — randomised gaps, typing indicators, per-recipient cooldowns, rolling hourly and
  daily caps, quiet hours. That single queue is the entire defense for the masjid's number, and it
  only works because no app goes around it.
- **The caps belong to the NUMBER, not to us.** Every other installed app draws on the same allowance.
  Nothing here is designed as a broadcast, and the one bulk action we do have (§6) is capped per press
  and says so on screen.
- **Email remains the channel that always works.** A number can be banned overnight. Nothing
  auth-critical is ever sent this way (§4).

## 2. The wire

Declared in `manifest.yaml` as `whatsapp: true` — that is what makes the platform issue the secret and
allow the calls. Both endpoints are server-to-server from our backend, with
`X-OpenMasjid-App-Secret: ${OPENMASJID_APP_SECRET}`. All of it lives in `fabric/platform.ts`; nothing
else in the codebase calls them.

**Can this masjid send?**

```
GET {OPENMASJID_BASE_URL}/api/fabric/whatsapp
→ { "available": true, "reason": "ready" }
```

`reason` is one of four words on a 200, and each needs different copy from us — which is why the
settings screen keys its sentence off the word rather than off `available`:

| `reason` | Source | What Settings says |
| --- | --- | --- |
| `ready` | platform | WhatsApp is set up and a phone is linked. |
| `not-configured` | platform | WhatsApp isn't set up on this server yet. An admin can add it in OpenMasjidOS → Settings → WhatsApp. |
| `not-linked` | platform | WhatsApp is set up, but no phone is linked yet. |
| `unreachable` | platform / local | The WhatsApp gateway isn't responding. |
| `not-permitted` | **ours**, from a 403 | The gateway is fine; **this app** hasn't been granted WhatsApp yet. |
| `unsupported` | **ours**, from a 404/405 | This version of OpenMasjidOS doesn't have the endpoint. |

**The last two are not cosmetic.** They were collapsed into `not-configured` at first, under a comment
claiming both "mean the same thing to an admin standing in front of the screen". They do not: a masjid
with a working, linked gateway was told their server had no WhatsApp set up, and went and checked a
setting that was already correct. A 403 means the capability grant is missing — the platform checks it
against the **catalog entry the masjid installed from**, exactly the trap that swallowed `payment-short`
for a whole release (§9) — and nothing in OpenMasjidOS → Settings can fix that.

### The 403 was real, and the bug is in a third repo

The first install hit exactly that case, and it is worth recording because two of the three repos
involved are innocent:

1. this app declares `whatsapp: true` in `manifest.yaml` — **correct**;
2. OpenMasjidOS gates `/api/fabric/whatsapp` on `app.whatsapp`, read from the installed catalog entry
   (`packages/core/src/apps/manager.ts`) — **correct**, and its own docs say "the admin can turn you
   off; WhatsApp being configured does not mean it is enabled for your messages";
3. `OpenMasjidAPPS/scripts/build-catalog.mjs` copied capabilities into `catalog.json` through a
   hand-maintained **allow-list** — `sso`, `notifications`, `stripe`, `domain`, `https`, `tunnel`,
   `email`, `alerts`, `fabric` — with **no `whatsapp` line**. The key was dropped in the middle.

So `catalog.json` carried `students` at `0.50.0-dev.6` with `email: true`, `stripe: true`,
`domain: true` and **no `whatsapp` key at all** — not even `false` — the platform stored
`whatsapp: false`, and every call was refused. `email` surviving while `whatsapp` vanished was the
whole diagnosis. The worst shape a bug can take: manifest right, build green, failure surfacing as a
403 in a different repository from the mistake.

**Fixed in the catalog repo (`364f91b`), and fixed as a class rather than an instance.**
`scripts/capabilities.mjs` is now the one list the builder both type-checks and copies from, so
"validated here but forgotten in the entry" cannot be expressed; a test scrapes the documented manifest
template in `docs/BUILDING_AN_APP.md` and asserts every capability it offers survives into a built
entry, and the reverse, so one cannot be wired without being documented. The built entry now reads
`whatsapp: true` for `students`, with no other app losing a key.

**Check the built entry, not the manifest.** `git show origin/dev:catalog.json` in the catalog repo is
the only place that answers "did the capability actually ship?" — and an install only picks the change
up when the app is next updated, since the platform reads capabilities from the entry at install and
update time.

`WhatsAppStatus` therefore also carries **`source`** (`platform` = the OS said this in a 200,
`http` = we inferred it from a status code, `local` = we never got as far as asking) and the raw
**`httpStatus`**. Both are printed under the status chip when the gateway is not ready, because a
screen that says "not set up" while the gateway is plainly working cannot be argued with in prose —
only with the actual signal.

The answer is cached for five minutes (`whatsapp/index.ts`) so a send never pays for a status hop, and
refreshed every 15 minutes by the scheduler — the gateway is a linked *phone*, so it goes offline when
the handset does and nothing tells us. A cold cache is **not** treated as available.

**Send one message:**

```
POST {OPENMASJID_BASE_URL}/api/fabric/whatsapp
{ "to": "+15550101234", "text": "…" }
→ 202 { "queued": true }
```

Also possible: `400` (bad number, empty text, WhatsApp not set up, queue full), `403` (we didn't
declare `whatsapp: true`), `429` (slow down). None is retried here — all four are the platform
protecting the masjid's number, and a retry loop is the opposite of what they are asking for.

**`queued` is not `sent`**, and the gap is bigger than "a moment". The platform serializes every
sender — OS alerts and every app — behind one queue and applies:

| | Default |
| --- | --- |
| Warm-up ramp on a freshly linked number | 7 days, in thirds: ×0.25 to day 2.33, ×0.5 to 4.67, ×0.75 to 7, then full |
| Rate caps — individuals | 12/hour, 60/day |
| Rate caps — groups | 4/hour, 10/day, tracked separately and global across apps |
| Per-recipient cooldown | 60s |
| Per-group cooldown | 1800s (30 min) |
| Gap between messages | 6–20s randomized (6 + up to 14 jitter, 3s floor) |

The caps are a **range an admin can move in either direction**, not a ratchet: they can be raised as
well as lowered, to a hard ceiling of 60/hour and 500/day. Plus a typing indicator scaled to the
message length, presence set online while working, and a contacts check before a first contact.

**THERE ARE NO QUIET HOURS** (platform 0.51.1). There were — 21:00–07:00 — and they were removed for
two reasons, one of them a real outage on a live install.

The design reason: the window applied to every message on the shared queue, **including staff
alerts**, and there is no per-message urgency flag in the contract (`{to, text}` is the whole of it).
So a declined card at nine on a Sunday evening was held until seven the next morning — the exact
scenario §9 of CLAUDE.md gives as the *reason* staff carry a number at all ("it reaches a treasurer's
phone and does not reach their inbox"). Our doctrine and the platform's default contradicted each
other, and the platform was the one holding the message.

The outage: the window was evaluated in **UTC** while the masjid was not (the container's `TZ` was
unset), so for a US-Eastern masjid it landed at 16:00–02:00 local and held every afternoon and evening
message. And the queue was **memory-only**, so each container restart destroyed whatever was waiting.
Either alone is survivable; together they produced messages accepted, logged as `queued`, and never
delivered — for over a day, with no error anywhere. One test message that happened to dodge a restart
arrived at 03:00 local, which is 07:00 UTC: the end of the window, and the signature of the whole bug.

What the platform changed in 0.51.1: the window is gone entirely (no setting, no held state), the
queue is **persisted** and restored at boot, the pacing history is persisted too (it is the ban-risk
budget, and a restart loop that forgot its own sends did not really have caps), and the pacer is
clock-agnostic beyond `now`. Held messages older than 24 hours are dropped as `expired` rather than
sent stale. **The backlog from before the fix is gone** — it was never durable — so anything a masjid
was waiting on has to be re-triggered.

A COMMAND REPLY BYPASSES THE QUEUE and always did (`replyTo` → `sendImmediate`), skipping the
cooldown and, formerly, quiet hours — though it still spends the hour's and the day's budget. Worth
knowing because it is a diagnostic: "`!stats` replies but nothing else arrives" localises a fault to
the queue rather than the gateway, which is exactly how the outage above was narrowed down.

**A send to the gateway's own linked number is refused** at the door now (0.51.1). It used to be
accepted and delivered nowhere, because WhatsApp treats it as the phone's own notes — so an admin
testing against the masjid's own number got silence that looked identical to a broken feature.

**There is no "send this one immediately" flag, and asking for one is settled** (0.51.0-dev.6). We
asked; the answer was no, and it was the right answer. With all pacing gone the only delay left is a
typing indicator sized to the message, which is already a few seconds — and the flag could only either
skip that (the last thing making the traffic look human) or jump a queue every app shares, which every
app would then set. If urgency ever needs expressing it belongs on the shared queue where the total
traffic is visible, never as a per-caller privilege.

## 2a. VOLUME IS OURS NOW (0.51.0-dev.5)

**The platform stopped pacing anything in 0.51.1.** Gone: quiet hours, the hourly and daily caps, the
per-recipient cooldown, the 30-minute group cooldown, the group caps, the warm-up ramp, and the random
6–20s gap. A typing indicator sized to the message is the only pause left. Anything handed over goes
out within seconds.

That was right for the platform — its own pacing was causing head-of-line blocking across every app,
which is what made one group image able to stall every masjid notification for half an hour — and it
moves the entire responsibility here. **This app is the shape that gets a number banned if nobody is
holding it:** `billing/invoices.ts` loops every household on an invoice run, and `billing/pastDue.ts`
loops the whole chase list. Two hundred messages to two hundred numbers in one burst, from a client
WhatsApp does not permit, is how a masjid loses the number their families reach them on — permanently.

So `whatsapp/index.ts` holds its own budget:

| | Default | Where |
| --- | --- | --- |
| Parent messages per hour | 12 | `WA_CAP_DEFAULTS`, overridable per install |
| Parent messages per day | 60 | same |

**The defaults are the platform’s own former figures, deliberately.** They were its considered
judgment about what a linked number tolerates, so inheriting them means the platform removing its cap
changed nothing about what this app actually sends until an office decides otherwise.

**The ledger is `whatsapp_log`**, not a counter. Every send is already a row with a timestamp, so
counting them is the rate limit and there is no second place for the two to disagree — and it survives
a restart for free, which is not incidental: half of the platform’s own outage was pacing state that a
container restart discarded.

**What a capped message costs is small, and it is why a hard cap is affordable here.** Every parent
event exists on EMAIL too and defaults there (§9). A refused WhatsApp is a notice that arrived on one
channel instead of two — a degraded nicety, not a lost notification.

**What is NOT capped, and why:**

- **Staff and group alerts.** A handful of recipients. A declined card must never be dropped because
  an invoice run spent the budget first; starving the alert channel to protect the bulk one is exactly
  the wrong way round. Tested.
- **A test send and the missing-email outreach.** Both are a person pressing a button, and the outreach
  is already bounded at 50 per press with the screen saying so. They COUNT toward the budget — real
  traffic on the number — but are never refused, because a control whose purpose is to prove the
  channel works must not be silently disabled by a quota. Tested.

A spent budget appears in the settings screen’s "why is nothing sending?" list (`cap_hour` /
`cap_day`) and writes a log row per household. A cap that silently truncates an invoice run is the
same invisible-failure shape this release spent its time removing.

**A STORM-PRONE ALERT SPEAKS ONCE PER HALF HOUR, AND SAYS HOW MANY IT HELD** (0.51.0-dev.6,
`alerts/index.ts` `STORM_WINDOW_MS`). The platform removed the 60-second per-recipient cooldown that
had been absorbing per-external-failure alerts — Kiosk found out what that had been hiding when an
expired key meant one message per person who tried to give, all through jummah. Three of ours are the
same shape:

| Alert | Why it can storm |
| --- | --- |
| `lookup-lockout` | One per Student ID locked. The per-ID guard is no bound against the very thing it detects — a sweep locks a new ID every few minutes, so fifty locked IDs was fifty alerts. |
| `payment-recovered` | Raised **per PaymentIntent** inside the reconcile loop, and a first reconcile looks back 35 days. A masjid whose broker path had been broken gets one per recovered payment. |
| `login-blocked` | One per account name. Bounded by the number of real staff accounts, so small — same class, cheap to include. |

Not a blanket cooldown: two refunds in an afternoon are two things an office needs to see, so only
events that can fire faster than a person can cause them are listed. The gate is applied before ANY
fan-out — email, platform channel, webhook, staff WhatsApp and groups — because all five have the same
problem with fifty copies of one sentence, and gating one channel would leave an inbox filling while
the phone stayed quiet.

**The held count is the point, not a consolation.** For a sweep the number IS the signal — "one ID was
locked" and "forty-seven were" call for different reactions — so a suppressed alert increments a
counter and the next one through reports it, on the public text as well as the private one (a count
names nobody). The state lives in the settings table rather than memory, because holding pacing state
in memory across restarts is precisely the mistake that cost the platform a week.

**A refusal keeps the platform’s own sentence.** A 400 or 403 carries a plain-language `error` — "That
phone number needs a country code", "That is the number WhatsApp is linked to", "That group has not
been approved" — and each names something an admin can fix in a minute. This used to reduce all of
them to `http_400`; the sentence now goes in the log row, because recording the code and discarding
the reason is how a diagnosable refusal becomes indistinguishable from a lost message.

**One recipient per call**, by the API's design. We loop where we must and the queue paces it — but
the shape of every feature here is "one parent at a time", never a broadcast.

**What became of it** (0.51.0 here, needs platform **0.51.1+**):

```
POST /api/fabric/whatsapp        → 202 { "queued": true, "id": "wam_…" }   ← `id` is new
GET  /api/fabric/whatsapp/status/<id>
                                 → 200 { id, state, reason?, at, target }
                                        state = queued | sent | failed | expired
                                 → 404   past the end of the platform's 200-message buffer, or not ours
```

This is what finally lets the queue log finish its sentences, and it exists because the outage above
was undiagnosable from this side: our records said we handed the message over and there was nothing
anywhere able to contradict them. `whatsapp_log.platform_id` stores the id and
`refreshWhatsappOutcomes` polls every **15 minutes**. It was five, to beat a 200-record ring shared
across every app that a single invoice run could fill on its own — our own reports are what surfaced
that, and platform 0.51.1-dev.8 made it **500 per app, kept 24 hours**, with **reads on their own
600/minute budget** so a polling burst can no longer refuse a send. A day of this app's traffic is
capped at 60 parent messages, so it fits several times over and the race is gone.

Three rules in that poller, each one earned:

- **Oldest first, bounded per pass.** The rows about to fall off the end of the buffer are the old
  ones, and a cap stops a backlog turning one tick into hundreds of requests at a platform that may
  already be unwell.
- **A 404 settles the row** (as `failed`/`outcome_unknown`) rather than being retried. It is a
  permanent answer to the question asked; left alone it would be re-asked every five minutes forever.
- **Anything else leaves the row alone.** An unreachable platform must never be written down as a
  delivery failure.

Support is advertised as `outcomes: true` on the capability GET, and **an absent field means false** —
the platform's own convention, and the same one `media` uses. On an older platform every row stops at
`queued` and the settings screen says why, because a missing outcome otherwise reads as a message that
never went.

## 3. Where the code lives

| Question | File |
| --- | --- |
| the two HTTP calls | `fabric/platform.ts` (`whatsappStatus`, `sendPlatformWhatsApp`) |
| **whether a message goes out at all, and to whom** | `whatsapp/index.ts` — the one place |
| a stored number → E.164 | `whatsapp/numbers.ts` — the one place |
| what a message says, and what an office may change | `whatsapp/templates.ts` |
| **which household a pause does not apply to** (both channels) | `settings/testStudent.ts` — the one place |
| the masjid's policy (settings, log, outreach) | `trpc/whatsapp.ts` |
| the parent's own opt-out | `trpc/portal.ts` (`messagingGet` / `messagingSet`) |
| a staff member's number + subscriptions | `trpc/staff.ts` (`setContact`) |
| who hears about a staff alert | `alerts/index.ts` — WhatsApp is its **fourth** fan-out |
| the seven parent messages | `mail/notify.ts` — same fan-out as the email, on purpose |

`mail/notify.ts` firing WhatsApp is deliberate and is the same argument that put the parent-email
switches there: a receipt is triggered from **five** places, so a check per caller is a check somebody
forgets — and a second *channel* per caller is a channel somebody forgets entirely. The two channels
still gate independently: the email switches say nothing about WhatsApp and vice versa.

## 4. What never travels this way

- **Nothing auth-critical.** No invite links, no password resets, no verification links, no one-time
  codes. Those go by email, which has a real provider behind it. There is a test that fails if an
  invite or a reset ever reaches this channel.
- **No Student ID.** It is a payment credential (§14) and this is not a channel we control end to end.
- **No card details**, of any kind.
- **No message body in any log or database row.** A tuition message routinely names a child and their
  family's fees. `whatsapp_log` stores the event, a recipient id, a timestamp and an outcome — never
  the text. There is a test for that too.

A child's **first name** *is* allowed in a message to that child's own parent, and is most of the
value: "we've received your payment for Yusuf" is worth sending; "a payment was received" is not.

## 5. The gates, in order

The first three are global and are checked **once per event**, before any recipient is looked at —
otherwise a switch that is off would write two hundred "skipped" rows every time an invoice run
finishes.

1. **The master switch** — `enabled`, off on every install until an admin turns it on.
2. **The gateway says `ready`.**
3. **This event is switched on** — each of the seven starts off. (Two ship ON by EMAIL — `receipt` and `autopayFailure` — only because an upgraded install was already sending them; on WhatsApp every one starts off.)
4. **The parent pause** — which **narrows** the recipients to the test student's household rather than
   stopping the send. See below.
5. **This person has not opted out.** Never overridden, by anything.
6. **Their number can be read as E.164.**

### …and the screen says which gate stopped it

The first three write **no log row**, by design: a switch that is off would otherwise put a "skipped"
row in the trail for every household every time an invoice run finished. The cost of that decision was
invisibility — a masjid turned the feature on, took a real tuition payment for the test student, and
got no message *and* no log entry, with nothing anywhere saying why.

So `whatsapp.get` returns a **`blockers`** list computed from the gates in the order they are applied
(`no_platform`, `off`, `gateway_<reason>`, `no_events`, `paused_no_test`), and the settings screen
prints it as the first thing under the status chip. Anything in that list means nothing reaches a
parent, whatever else the screen shows. `pausedWithTest` is the companion: not a blocker, but the
screen says plainly that only one household will hear anything.

The single most common entry is `no_events` — every message type ships switched off, so turning the
feature on and stopping there is a working install that sends nothing.

### The pause starts ON

Unlike the parent-email pause, which defaults off. The asymmetry is the point: parent email is a
channel every install has been using for releases, so pausing it by default would break working
installs. WhatsApp has never sent anything, so the safe starting state is *configured but silent* —
set it up, look at it, send a test, and only then let it reach two hundred families.

### The test student

A real student, chosen in Settings, whose **household receives notifications even while paused**. For
notification purposes only: it changes nothing about billing, invoices or the ledger, and the child is
an ordinary student in every other respect. It overrides **a pause and nothing else** — not the master
switch, not an event that is off, and never an opt-out.

**It covers BOTH channels** (`settings/testStudent.ts`), and that is a correction rather than a
design. It shipped inside the WhatsApp config and lifted only the WhatsApp pause, so an office that
set a test student, took a payment and waited got nothing at all — the parent-EMAIL pause is a
separate switch, defaults on for a fresh install, and held the receipt back silently. "That student's
household will actually receive notifications even if paused" has to mean notifications, not one kind
of them.

That is why it lives in `settings/` rather than in `whatsapp/`: `mail/notify.ts` and
`whatsapp/index.ts` both ask the same module, and neither has to know about the other. The exception
is honored in **two** places on the email side — at each sender, and again in
`guardianEmailsForFamily`, which is the deliberate second line of the mail pause and would otherwise
quietly cancel the exception the first one granted.

It is resolved from the *student* on every send rather than stored as a family id, so a child moved
between households takes the setting with them; a withdrawn or deleted student resolves to null, which
fails closed, and the settings screen says so rather than leaving it looking configured.

### The gateway status is resolved live

`whatsapp.get` awaits `currentWhatsAppStatus()`, which answers from the five-minute cache and only
crosses the network when that is cold or stale. It read the cache *alone* at first, and nothing primed
the cache except a 15-minute cron — so for the first quarter of an hour after a container start the
panel said "Not ready" and grayed out the Send-a-test button on an install that was working perfectly.
The scheduler now also primes it once at boot.

### The opt-out

Stored on the **guardian** (`guardians.wa_opt_out`), set by a parent in the portal. The VALUE is per
person, because it is a decision about a phone and a household has two of them: a mother opting out
must not silence her husband's number. Nothing in the app overrides it — not the pause exception, not
the office's outreach button, not an admin screen.

**Any adult on the household can set it, for anyone on that household.** The parent portal is a
HOUSEHOLD, not a personal account: a father activates it, a mother activates it with her own email,
and the two of them are looking at the same balance, the same bills and the same saved cards. There is
no "my half" of a household here, so a parent setting messages up for the family should not have to
ring the office to get their spouse's number switched on. The wall is the usual one —
`parentFamilyIds`, checked in the query (§14) — so a guardian id from another household simply is not
in the set and is refused; a parent still cannot name anybody they could not already see.

## 5a. Groups — a STAFF channel, and the wall around it

OpenMasjidOS lets an admin approve specific WhatsApp groups for an app:

```
GET  /api/fabric/whatsapp/groups   → { "groups": [{ "id": "…@g.us", "label": "Parents — Hifz" }] }
POST /api/fabric/whatsapp          → { "group": "…@g.us", "text": "…" }   (`group` in place of `to`)
```

The list **is** the authorization: an id we did not get from it is refused `403`, approval can be
withdrawn at any moment, and a *confirmed* empty list means the feature is hidden rather than shown
broken.

**"You have none" and "I could not ask" are different answers, and the wire makes them easy to
confuse.** A 403 answers `{ groups: [], error }`; a 429 — from a per-IP limiter of 120/min that
*every* Fabric call shares, Stripe keys and `record-payment` included — answers `{ groups: [] }` with
no error field at all. `whatsappGroups()` therefore returns `{ ok: true, groups } | { ok: false,
reason }` and never collapses the two, because collapsing them broke three things at once, all
silently: the Groups section vanished on a hiccup exactly as if nothing were approved; `groupSet` told
an admin their group was not approved in OpenMasjidOS when OpenMasjidOS simply had not answered,
sending them to fix something that was fine; and no screen could ever say "you are still subscribed to
a group that is no longer approved". A 200 whose body is not the documented shape counts as a failure
too — reading a malformed answer as "none approved" is the same mistake wearing a different hat.

**Withdrawn approval keeps the setting and shows it.** Deleting a subscription when the platform stops
listing a group would mean a five-minute outage wiped what an admin configured. But the row used to be
invisible while it lived on — the screen iterated the *approved* list — so re-approving that group
later silently resumed its old events **and its old `detail` flag**, naming households to a group
nobody had re-ticked. Both halves are now wrong to do: the row is shown, marked no longer approved,
with everything it would resume with spelled out and a **Forget** button. We only ever call a row stale
on a positive answer, so an unreachable platform never accuses a live group.

**The send path does not re-check, deliberately.** `notifyGroups` posts to its stored ids and lets the
platform's 403 be the authority — it checks before it queues anything, so nothing can leak, and a
per-alert round trip would draw on that same shared 120/min budget. A refusal lands in the queue log as
`failed` with the status. `groupIsApproved()` is the one place the question is answered for the paths
that *do* ask (`groupSet`, and the per-group test, which used to skip it).

**What a group post costs.** Groups have their own budget — **4 an hour and 10 a day**, one post to the
same group every **30 minutes**, shared with every other app on the masjid's number — and the platform
**delays** rather than drops. So the failure to warn an office about is not "the alert vanished" but
"Monday's alert arrived Wednesday, behind Sunday's receipts", which looks like nothing at all. The
screen says so next to the matrix, and names `payment-received` as the one event that will fill a day's
budget by itself.

**A group is a STAFF channel in this app** — a masjid's finance group getting every payment alert. It
is the fifth fan-out of `alertStaff` (alerts/index.ts), beside the office's email addresses, the
platform alert channel, the webhook and a staff member's own number, and it subscribes to exactly the
same `ALERT_EVENTS` a staff account can. It is **not** a way to reach parents, and the platform's own
rule is why: *never use a group to tell a family about their own fees — their business is not the
other 199 members'.*

- **No parent event can reach a group, and nothing free-typed can either.** There is no composer. The
  seven parent events are each about one household, so none of them is offered here; a group's
  subscription list is the staff alert catalog and nothing else.
- **Its own path, all the way down.** Per-family messages call `sendPlatformWhatsApp`, which has no
  parameter that can name a group; group alerts call `sendPlatformWhatsAppGroup`, which has no
  parameter that can name a person. A receipt cannot reach a group by mistake because there is no
  expressible way to ask for it. That is the enforcement — the prose is only the explanation.
- **`detail` decides which of the alert's two texts a group gets, and defaults to the careful one.**
  An alert carries `text` (may name a household and an amount — what makes it actionable) and
  `publicText` (names nobody). An admin approving a group and ticking events is doing the same
  deliberate thing as typing an address into the alert list, but this app cannot see who is IN a
  group and the wrong group is one mis-click away. So a group gets `publicText` until somebody turns
  `detail` on in front of a sentence saying what that means: the cost of that default being wrong is
  a vaguer message; the cost of the opposite is two hundred parents reading a family's balance.
- **The parent pause does not apply**, exactly as it does not for a staff member's own number: it is a
  switch about writing to families, and an office that paused it while importing a roster still wants
  to know when a card fails.
- **No greeting on an operational notice.** A staff alert — to a number or a group — is the title then
  what happened, with no salam and no school name: it arrives on the masjid's own number for somebody
  who has to act on it, and a line of ceremony ahead of "a card was declined" is a line to scroll past.
  Parent messages are the opposite and still greet, because that is the madrasah speaking to a family.
- The per-group **test** sends a fixed message, never anything typed — a box that posts arbitrary text
  to a group is precisely the misuse the design rules out.
- The queue log records the group and the outcome, never the text, like every other row.

### Two parts of the platform's contract this app deliberately does not use

**Images.** `POST /api/fabric/whatsapp` takes an optional `media` (base64 PNG/JPEG/WebP, 2 MB, the
`text` becoming a ≤1024-character caption), and `GET /api/fabric/whatsapp` advertises it as
`media: true` with `maxMediaBytes`. We send none, and the reason is not squeamishness — there is
nothing honest to send:

- §14 forbids photos outright, so no child's face.
- The academics went in the 0.35.0 pivot, so there is no timetable and no permission slip.
- §7 forbids a PDF renderer and headless Chromium (this runs on a Pi), so the statements, invoices and
  ID sheets — the only documents we have — **cannot be rasterised**. They are print-CSS HTML by design.
- What is left is a bill, and a bill as an image is worse than a bill as a sentence: it names a child
  and their fees inside a 2 MB blob that sits in the platform's memory through quiet hours, on a queue
  capped at four images **platform-wide**, and **a failed image is never downgraded to its caption** —
  so the notice simply does not arrive, and we were told `202` and cannot know.

The link in an invoice-ready message goes to the portal, which is authenticated, always legible, and
already the place the bill lives.

## 5b. Admin commands — one command, and it only reads (0.50.0-dev.15)

An authorized admin messages the masjid's own number with `!students` and OpenMasjidOS runs a command we
declared. **The platform owns everything except the doing**: who may run what, the numbered menu, the
confirmation step, the formatting. We are handed a command id and asked to answer in plain text.

```
!students          →  Tuition numbers
!students 1        →  runs it
```

We declare exactly one, `stats`, served at `POST /fabric/commands/run` (`fabric/commands.ts`), answered
from `billing/stats.ts`:

```
An-Noor Weekend School — tuition, 17 Aug 2026

In this month: $4,320.00 from 18 payments
Billed for August: $6,500.00

Outstanding: $2,140.00
Past due: 4 students, $860.00

Students: 132 active in 71 households
Autopay: 21 households
Checked with Stripe: 17 Aug 2026

Open the app to see who is behind.
```

**EVERY LINE IS A COUNT OR A TOTAL, and that is the invariant rather than a style choice.** Alerts name
children now (§5a, §9) because they go to addresses and numbers an admin configured, one event at a
time. A command reply is a different animal: it lands in a WhatsApp thread that keeps a copy forever, on
whichever phone is authorized *today*. That is the platform's own stated reason for refusing to expose
app logs, and it applies just as well to a roster of families who are behind — so the reply says how
many and how much, and points at a screen behind a login for who. `test/commands.test.ts` asserts a
child's name never appears in it, however overdue they are.

**Nothing here writes.** A command that moved money would need `confirm: true` and would still be the
wrong shape for this channel: a number can be banned overnight (§14), so nothing important may depend on
one.

Two things about the arithmetic, since a wrong total here is worse than no total:

- **Owed and credit are summed per student, never netted install-wide.** One child $100 behind while
  another sits on $100 of credit is a madrasah with $100 outstanding, not a square one — the cheap
  install-wide subtraction reports the second thing and hides real arrears.
- **A withdrawn child's unpaid bill still counts.** Scoping the money to active students would write real
  debt off silently; the roster line drops, the outstanding line does not.

Gated exactly like the billing provider (§11.1) — tunnel refused first, our own secret compared in
constant time — **plus** a check the provider does not need: `X-OpenMasjid-Caller-App` must be exactly
`omos:platform`. Without it, any other app holding a broker path could reach an admin-only handler; that
is also why the platform makes `commands` a RESERVED capability that cannot appear in `fabric.provides`.
`not_ready` (503) before an admin account exists, because "0 students, $0.00" reads as a broken install
rather than an unfinished one.

The floor is OpenMasjidOS **0.51.0**, not the 0.50.4 the catalog's author docs claim — stable has none of
the code and drops the key silently, so declaring it is safe on both channels and simply does nothing
until a masjid is on a platform that knows about it.

### The contract, and the one thing that will bite

Recorded here so the design starts from it rather than discovering it. Verify against OpenMasjidOS
`docs/APP_MANIFEST_SPEC.md` at the time — this is a summary, not the source of truth.

- **Declaring**: ≤12 commands; `id` kebab-case, not all digits, not `help|yes|no|cancel|stop`; `label`
  required; `argument` must be an **object with a `label`** (`argument: true` is rejected, not coerced);
  `confirm: true` for anything that changes something, which also puts it in the admin's audit alert.
  `commands` is a RESERVED capability — putting it in `fabric.provides` fails the build, because that
  would expose the same handler to other apps through the broker.
- **Serving**: `POST /fabric/commands/run`, verifying **both** headers — our own `OPENMASJID_APP_SECRET`
  and `X-OpenMasjid-Caller-App: omos:platform` (a value no app id can hold, since the colon is outside
  the app-id charset). LAN-only like every other `/fabric/*` route. **10 second timeout, 16 KB cap**:
  anything real gets kicked off with "started it", never awaited.
- **Follow-up questions** (platform 0.51.0-dev.11): return `followUp: { token }` beside `text` and the
  sender's next message comes back as `{ command, text, followUpToken, … }` — so a multi-step flow does
  not make an admin prefix every answer with `!`. The token is ours (`A-Za-z0-9._:-`, ≤128); put a row
  id or a step name in it. Omit `followUp` to finish. One question per turn — these are WhatsApp
  messages, not a form — and any `ok: false` ends the exchange.
- **THE THING THAT WILL BITE, and it lands hardest on an app that moves money.** The exchange can end
  **without us and with no notification**: three minutes idle, fifteen minutes total, twelve turns, the
  sender typing exit/cancel/done, or starting any new `!` command. The answers simply stop arriving. So
  **nothing half-applied may ever wait on a reply** — apply on the last answer, or keep our own draft
  with our own expiry. For this app that is not a nicety: a flow like "record a payment → which student?
  → how much?" that wrote a row at step two and then went silent would leave money attributed to
  nobody, and the ledger's whole design is that a payment is immutable once written (§9). The sender is
  also re-authorized every turn, so a permission removed mid-conversation takes effect at once.

## 6. The three things an office presses

**Send a test** — goes to the test student's household, which is the one household that gets through
the pause, and sends on **both channels**: an email, and a WhatsApp when the gateway is ready. It
succeeds if either worked and reports each separately.

It used to refuse outright unless WhatsApp was ready, which made it useless in the exact situation an
office is in when they press it — setting the app up, before OpenWA is installed on the server — and
meant the one thing an admin most wants to prove, that the pause exception works, could not be tested
at all. With no test student set it still refuses and says exactly that, rather than offering to
message somebody at random.

**Ask for a missing email address** — the outreach. A household with no address on file silently
receives no receipts, no invoices, no statements and no reminders; until now the only fix was a list of
phone numbers to ring. The message names the children it is about, says why an email is needed (this
channel can only carry a short note), and is **editable** by the office with `[school]`, `[family]` and
`[children]` tags. One message per household, to the **first** adult we can reach — messaging both
parents to ask for one email address doubles the cost to the masjid's number for nothing.

Capped at **50 households per press**, and the screen reports how many are left. That cap is stated out
loud rather than hidden: handing the queue two hundred messages in one go is precisely the behavior
that gets a number restricted.

It respects the pause, and says so with the way out — set a test student and try it on one household
first.

**Send the onboarding message** (0.51.0, `people/onboarding.ts`) — the explain-what-this-is note, from
the Students tab to everyone / a course / a class / picked students, or from one household's record.
Both channels, one message per household, **every adult with a number** on it.

That last part is the one place it deliberately differs from the outreach above, which picks a single
adult. The outreach asks a question and wants one answer. This is a notice, and on WhatsApp part of the
notice is **which number the madrasah writes from** — a mother whose handset never got that message
still has an unknown number texting her about her children's fees, which is what a cautious person
blocks. That sentence is its own editable box and is appended on WhatsApp only; in an email it would be
describing a channel the reader is not on.

**What it must not say, and why the design is the enforcement.** It carries no Student ID, no balance
and no card — not by convention but because the tag list has no tag for any of them (§9's rule), so an
office cannot put one in even by accident. What it does instead is point at the **family sheet**, which
carries all of it and is handed over in person. A message that helpfully included the ID would be
putting the whole payment credential (§14) on the channel this document opens by calling the weakest.

**Bounded at 50 households per press, with the remainder reported** — the same trade and the same
number as the outreach, for the same reason. No per-event switch, because it is a button and not an
event (like the test send). It respects **both** pauses independently, and the screen names whichever
one is on: they are separate switches and either alone means a family hears nothing.

## 7. Numbers

`whatsapp/numbers.ts` is the only place a stored number becomes `+…`. The rules, in order, each
existing because of a real way an office writes a number:

1. Contains a **letter** → refuse. `555-1234 x22` reduces to nine digits, which is a plausible length
   once a country code goes on, so it would be dialled — as somebody else's number.
2. Starts with **`+`** → the person told us the country; take the digits and trust them.
3. Starts with **`00`** → the international prefix; becomes `+`.
4. Starts with a single **`0`** → a national trunk prefix (`07911…`, `0300…`). Dropped *before* the
   country code goes on. Without this every UK, Pakistani, Egyptian and German number is dead.
5. **Already carries the country code?** Decided by length: a national number, trunk zero gone, is at
   most ten digits in every plan a masjid realistically dials, so a *longer* string beginning with the
   code already carries it. Ten is load-bearing — it is what makes `1234567890` come out as a ten-digit
   US number getting a `+1` rather than a nine-digit one truncated to `+1234567890`.
6. Otherwise the country code goes on the front.

Then a total-length check (8–15 digits). Anything else returns **null**, and the settings screen lists
every number in that state with a country dropdown to fix it — a number nobody can read is a fixable
problem; a number silently mangled into somebody else's is not.

The country comes from the guardian's or staff member's own `phone_country` when set, and the
install-wide default otherwise. The office configures the default plus any others it needs, and can
then set a different one per person.

## 8. Staff alerts

`alerts/index.ts` stays the one place that decides who hears about an event; WhatsApp is its fourth
and fifth fan-outs — staff numbers and approved groups (§5a) — beside the office's email addresses,
the OpenMasjidOS alert channel and the masjid webhook.
Staff subscribe **per account** (`users.phone` + `users.wa_events`), entirely opt-in, and clearing the
number is the off switch. The editor is offered on **every** staff row whether or not WhatsApp is
switched on — it was hidden behind the master switch at first, which made it unfindable in the one
order an admin naturally works in (set the staff up, then turn the channel on) and looked exactly like
the feature not existing. It says when the ticks will not fire yet instead.

`users.phone` was deliberately dropped once, with the schema comment saying why: "the app never
contacts staff by phone, so holding one would be personal data collected for no purpose". That reason
no longer holds — a declined card at nine on a Sunday evening reaches a treasurer's phone and does not
reach their inbox — so the column is back **with** a purpose. A number with one is minimization
satisfied; a number without one is what the old rule forbade, and still is.

A staff WhatsApp carries the alert's `text` — the wording that may name a household and an amount —
and **not** the de-identified `publicText`. §14's line is around *third-party sinks*: a masjid webhook
is usually a Slack channel, and the platform's alert delivery is not ours to reason about. A number an
admin typed, on a gateway the masjid runs itself, is the same audience and the same actionability
requirement as their inbox. A Student ID and card details are still forbidden, exactly as in the email.

The parent pause does **not** apply to staff alerts: it is a switch about writing to families.

## 9. What goes in a WhatsApp vs what goes in the email

**WhatsApp carries the fact and the figure; email carries the breakdown, the receipt and the links.**

A WhatsApp message is read on a lock screen between other conversations. It cannot be printed, it has
no letterhead, and it cannot be trusted to arrive at all. So it says the one thing a parent needs to
know and — **only when that person has an address on file** — adds "we've emailed you the full
details". A household routinely has one parent who does and one who doesn't, so the line is decided per
recipient rather than per household.

### The office can rewrite any of it

That rule is a good default, not a law about somebody else's madrasah: one school wants the balance in
every message, another wants three words and a name, and a school writing in Urdu wants its own
sentences entirely. So every parent message is a **template with tags**, edited in Settings and
previewed against a real household (the test student's, when one is set) both with and without the
"check your email" line.

Two things make that safe to hand over. The tags are a **fixed list per message** — there is no tag
for a Student ID or a card, which is the enforcement rather than a rule in a document — and a tag that
could not resolve is not offered at all, since one that renders empty leaves a hole in a sentence.

| Tag | Fills in |
| --- | --- |
| `[school]` | the madrasah's name |
| `[family]` | the derived household label, e.g. "Ismail family" |
| `[children]` | the household's active children, by first name, as a sentence |
| `[amount]` | the figure this message is about |
| `[due]` | the date it was due |
| `[balance]` | what the household owes right now — **derived**, computed at send time (§9) |
| `[portal]` | a pay-here line, or nothing when there is no public address yet |
| `[email]` | the "we've emailed you the full details" line — only for a recipient who has one |

`autopay-failed` and `autopay-stopped` are two texts behind one event switch. They are genuinely
different messages, and an office rewriting one almost always wants to rewrite the other differently;
merging them behind a tag would have made both worse.

The test message and the staff alert are **not** editable: the first exists to be recognizable as a
test, and the second is our own operational wording rather than the madrasah's voice to a parent.

### The seven parent events

Every one exists on **both** channels, with its own switch on each. That is deliberate: email is the
reliable channel and the one a household with no phone number still has, so a notification type that
existed only on WhatsApp would be one those families could never receive.

All seven default OFF on WhatsApp. On email, `receipt` and `autopayFailure` default ON because an
upgraded install was already sending them; the four added in 0.50.0 default OFF, because a madrasah
that updates on a Tuesday must not start writing to two hundred families on the Wednesday.

| Event | When | Volume |
| --- | --- | --- |
| `invoice-ready` | this period's bill has been generated | monthly, **one per household** |
| `receipt` | money has landed, however it arrived | per payment |
| `past-due` | a balance is past its due date, after the grace period | on the office's cadence |
| `autopay-upcoming` | 3 days before a saved card is charged | monthly |
| `autopay-failed` | a decline, and again on the third strike (two texts, one switch) | rare |
| `card-expiring` | the month before a saved card expires, and the month of | ~once a year per card |
| `payment-refunded` | money has gone back | rare |

Volume decided what is *not* here. The allowance belongs to the masjid's number and is shared with
every other installed app, so each of these had to earn its place — a "your balance changed" message
would have earned none of it.

Three of them close real gaps rather than adding noise. **`invoice-ready`** is the biggest: without
it a parent heard nothing between one receipt and the past-due reminder that followed a bill they were
never told about. **`autopay-upcoming`** is what stops a card charge being a surprise, which is what
makes a parent ring their bank instead of the office. **`card-expiring`** removes an entire failure
sequence: card expires → charge declines → retry ladder runs → autopay switches itself off → the
family finds out three months later that they are behind.

`invoice-ready` is notified from the two run-level functions in `billing/invoices.ts`, never from
`generateForStudent` — bills are per child and the message is to a parent, so a household with three
children would otherwise get three messages for one billing run. Only invoices CREATED in that run
count, so re-running a period (idempotent by design) messages nobody twice.

`autopay-upcoming` and `card-expiring` are **stateless**, and the rules that make them so are the
whole of their idempotency. A household qualifies for the charge notice only when a bill falls due
*exactly* on `today + 3` — selecting on "something is due soon" would message a family with an older
overdue bill every single day until they paid. The card notice runs on the **1st of the month** and
fires while the card expires this month or next, so a card gets at most two notices, ever.

| Event | WhatsApp | Email |
| --- | --- | --- |
| `receipt` | "…has received your payment of $250. JazakumAllahu khayran." | the receipt itself, letterhead, portal link |
| `autopay-failed` | what failed, whether autopay is now off, a pay-now link | the same plus the household's detail |
| `past-due` | the amount, since when, "if you've already paid, please ignore this" | the full statement position |
| `invoice-ready` | the total, the children it covers, when it is due | the same plus "tell us if it looks wrong" |
| `autopay-upcoming` | the card, the amount, the date | the same plus how to pay another way |
| `card-expiring` | which card, and that autopay will stop | the same plus a link to add one |
| `payment-refunded` | the amount, and that a card takes days | the same plus the timing caveat spelled out |

`past-due` counts per channel (`emailed` / `messaged` in `PastDueRunResult`), and a household reached
by **either** starts its cooldown — a WhatsApp that was queued is a household that was written to, even
with no address on file. The run also walks the overdue list when *either* channel wants to chase;
gated on the email switch alone, a madrasah that wanted reminders by WhatsApp only had a job that
quietly never ran.
