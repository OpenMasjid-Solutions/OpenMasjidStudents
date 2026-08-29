<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# A deliberate exception to the no-names-on-a-third-party-sink rule

**Date:** 2026-08-29 · **Release:** 0.51.0-dev.17 · **Requested by:** Hasan (repo owner) ·
**Status:** shipped, off by default

This is not an audit finding. It is the record of a **§14 invariant being deliberately relaxed**, written
here because the earlier audits assert the invariant unconditionally
([`SECURITY_AUDIT.md`](./SECURITY_AUDIT.md) §528, [`AUDIT-2026-08-13.md`](./AUDIT-2026-08-13.md) §248) and
those are dated findings that must not be edited to match a later decision. If you are reading either of
those and wondering whether they still hold: they hold as of their date, and this narrows them.

## What was asked for

> "Can you include name of student on the webhook for tuition payment received?"

## What the rule was

Every alert carries two texts (`alerts/index.ts`):

- `text` — may name the child and the amount. Goes to addresses an admin typed, to staff WhatsApp
  numbers an admin entered, and to a WhatsApp group an admin ticked `detail` for.
- `publicText` — names nobody. Goes to the masjid webhook (`notifyPlatform`) and to the OpenMasjidOS
  alert channel (`raiseAlert`).

The reason for the split was never that a webhook is untrustworthy. It is that **this app cannot see
where it ends up**: `notifyPlatform` posts to the platform, which forwards to whatever URL the masjid
configured in OpenMasjidOS — usually a Slack or Discord channel with a membership we know nothing about.

## Why the request is reasonable

The audience is the masjid's own staff channel, chosen by the masjid. Telling an office they may put an
address on the alert list — a standing grant of information about every family — but may not put the same
sentence in the channel those same people already read is a distinction without a difference in
substance, and it was costing them the feature's whole point: a payment notice that cannot say whose
payment it was makes the reader go and look it up.

So the answer is not "no". It is "yes, and the grant has to be narrow enough that nobody can widen it by
accident later".

## What shipped

`webhookNamesStudent` — one boolean, and **three** conditions before a name goes anywhere:

```
SPEC[event].webhook && SPEC[event].webhookMayName && getWebhookNamesStudent()
```

| Control | Choice | Why |
| --- | --- | --- |
| Default | **Off** on every install | Nothing changes for a masjid that never opens Settings. |
| Coercion | `=== '1'` | A hand-edited or truncated row cannot turn it on. Same strict opt-in as the WhatsApp group `detail` switch. |
| Role | **Admin only** | Same wall as the alert recipient list (§5): finance runs the billing and does not decide who is told about families. |
| Audit | Both directions | `settings.webhookNames`, so "when did this start?" is answerable. |
| Eligibility | **Per event**, `payment-received` only | See below — this is the part that matters. |
| Scope | The masjid webhook only | `raiseAlert` keeps `publicText` unconditionally. |
| Disclosure | Two-state sentence beside the switch, plus two standing caveats | Names what will be sent, in the words that will be sent. |

### Eligibility is per event, and a global flag would have been the bug

`payment-received` is the only event with `webhook: true` today, so a single global flag would have
behaved identically — until somebody set `webhook: true` on a second event, which would then inherit an
office's consent to see a payment notice. The two likeliest candidates are the two worst texts in the
table:

- **`past-due`** — a roster of every child behind on fees, with amounts and oldest due dates.
- **`payment-refunded`** — names children, the staff member who refunded, *and* the invoice line labels
  the money had paid for.

Neither is a payment notice. `webhookMayName` is declared per event in `SPEC` so neither can inherit
anything, and `test/alerts.test.ts` pins the eligibility list at exactly `['payment-received']` — it goes
red the moment a second event is added, which is the intended friction: that decision needs somebody to
read what the event's text actually contains.

## What still never travels, exception or not

- **A Student ID.** It is a live payment credential (§14) and is absent from every alert text by
  construction — `studentName`, `studentAmounts` and `childrenOf` never select `student_code`.
- **Card details**, guardian contact details, dates of birth. None appear in any alert text.
- **The OpenMasjidOS alert channel.** Unconditional.
- **Message bodies in logs.** `notifyPlatform` now logs a rejected *status*; never the body.

### One residual worth stating rather than hand-waving

`codePrefix` (`billing/studentCodes.ts`) derives a Student ID's first three letters deterministically
from the child's name — the file says so itself: "a third of it is public by design". So publishing
"Yusuf Ismail" publishes `YUS`, leaving the 4-digit suffix: 10,000 candidates against a per-ID lockout of
6 failures/hour (~69 days of sustained probing per ID). **Bounded, not broken** — and the office's own
inbox has always carried this. A chat channel is a different audience for the same fact, and that
difference is the argument for the default staying off, not an argument against the feature.

## Two disclosures that ride along

Both are in the panel's own wording, because neither was part of what was asked for:

1. **A payment recorded by hand also names who recorded it.** `trpc/billing.ts`'s `text` ends
   "recorded by …", which falls back to the staff member's username — and a username has no format
   constraint, so an account created as `treasurer@masjid.org` with no display name would put a live
   address in the channel.
2. **One notice per payment.** `payment-received` has no digest and no storm gate, so a busy Sunday is a
   busy channel — and unlike email, there is no in-app way to unsubscribe the webhook from it.

## Adjacent fix

`notifyPlatform` ignored its response entirely: no status check, no log line. A masjid with a
misconfigured or removed webhook got silence in the one place that could have told them — the same
invisible-failure shape the WhatsApp `blockers` list was invented to kill (§9). It now logs a rejected
status. This matters more once an office deliberately routes naming text here and reasonably expects to
see it arrive.

## Known gap, NOT closed here

**Standing payments notify nobody.** `billing/standingPayments.ts` (0.51.0-dev.15) records cash and
transfer arrangements and calls neither `alertStaff` nor `sendReceipt`, so those payments reach neither
the webhook nor the office's inbox nor the family. Anyone whose mental model is "the webhook gets every
payment" is already wrong, and this switch does not change that.

Left open deliberately: the fix is a design decision, not a line of code. One alert per child would fire
~60 messages at 05:00 on the 1st of the month into a channel with no storm gate, so it likely wants to be
a single digest — and whether a family gets a *receipt* for money nobody has confirmed arrived is a
policy question for the office, not a default to pick quietly.
