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
  daily caps, quiet hours. That single queue is the entire defence for the masjid's number, and it
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

`reason` is one of exactly four words, and each needs different copy from us — which is why the
settings screen keys its sentence off the word rather than off `available`:

| `reason` | What Settings says |
| --- | --- |
| `ready` | WhatsApp is set up and a phone is linked. |
| `not-configured` | WhatsApp isn't set up on this server yet. An admin can add it in OpenMasjidOS → Settings → WhatsApp. |
| `not-linked` | WhatsApp is set up, but no phone is linked yet. |
| `unreachable` | The WhatsApp gateway isn't responding. |

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

**`queued` is not `sent`.** Delivery is seconds to minutes away, and hours if it lands in the masjid's
quiet hours. Nothing blocks on a send, no screen says "sent", and no flow waits for one to arrive. The
settings screen says *handed to the queue*, and the log column reads **Queued**.

**One recipient per call**, by the API's design. We loop where we must and the queue paces it — but
the shape of every feature here is "one parent at a time", never a broadcast.

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
| the three parent messages | `mail/notify.ts` — same fan-out as the email, on purpose |

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
3. **This event is switched on** — each of the three starts off.
4. **The parent pause** — which **narrows** the recipients to the test student's household rather than
   stopping the send. See below.
5. **This person has not opted out.** Never overridden, by anything.
6. **Their number can be read as E.164.**

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
is honoured in **two** places on the email side — at each sender, and again in
`guardianEmailsForFamily`, which is the deliberate second line of the mail pause and would otherwise
quietly cancel the exception the first one granted.

It is resolved from the *student* on every send rather than stored as a family id, so a child moved
between households takes the setting with them; a withdrawn or deleted student resolves to null, which
fails closed, and the settings screen says so rather than leaving it looking configured.

### The gateway status is resolved live

`whatsapp.get` awaits `currentWhatsAppStatus()`, which answers from the five-minute cache and only
crosses the network when that is cold or stale. It read the cache *alone* at first, and nothing primed
the cache except a 15-minute cron — so for the first quarter of an hour after a container start the
panel said "Not ready" and greyed out the Send-a-test button on an install that was working perfectly.
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

## 6. The two things an office presses

**Send a test** — goes to the test student's household, which is the one household that gets through
the pause. With no test student set it refuses and says exactly that, rather than offering to message
somebody at random.

**Ask for a missing email address** — the outreach. A household with no address on file silently
receives no receipts, no invoices, no statements and no reminders; until now the only fix was a list of
phone numbers to ring. The message names the children it is about, says why an email is needed (this
channel can only carry a short note), and is **editable** by the office with `[school]`, `[family]` and
`[children]` tags. One message per household, to the **first** adult we can reach — messaging both
parents to ask for one email address doubles the cost to the masjid's number for nothing.

Capped at **50 households per press**, and the screen reports how many are left. That cap is stated out
loud rather than hidden: handing the queue two hundred messages in one go is precisely the behaviour
that gets a number restricted.

It respects the pause, and says so with the way out — set a test student and try it on one household
first.

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
fan-out, beside the office's email addresses, the OpenMasjidOS alert channel and the masjid webhook.
Staff subscribe **per account** (`users.phone` + `users.wa_events`), entirely opt-in, and clearing the
number is the off switch. The editor is offered on **every** staff row whether or not WhatsApp is
switched on — it was hidden behind the master switch at first, which made it unfindable in the one
order an admin naturally works in (set the staff up, then turn the channel on) and looked exactly like
the feature not existing. It says when the ticks will not fire yet instead.

`users.phone` was deliberately dropped once, with the schema comment saying why: "the app never
contacts staff by phone, so holding one would be personal data collected for no purpose". That reason
no longer holds — a declined card at nine on a Sunday evening reaches a treasurer's phone and does not
reach their inbox — so the column is back **with** a purpose. A number with one is minimisation
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

The test message and the staff alert are **not** editable: the first exists to be recognisable as a
test, and the second is our own operational wording rather than the madrasah's voice to a parent.

| Event | WhatsApp | Email |
| --- | --- | --- |
| `receipt` | "…has received your payment of $250. JazakumAllahu khayran." | the receipt itself, letterhead, portal link |
| `autopay-failed` | what failed, whether autopay is now off, a pay-now link | the same plus the household's detail |
| `past-due` | the amount, since when, "if you've already paid, please ignore this" | the full statement position |

`past-due` counts per channel (`emailed` / `messaged` in `PastDueRunResult`), and a household reached
by **either** starts its cooldown — a WhatsApp that was queued is a household that was written to, even
with no address on file. The run also walks the overdue list when *either* channel wants to chase;
gated on the email switch alone, a madrasah that wanted reminders by WhatsApp only had a job that
quietly never ran.
