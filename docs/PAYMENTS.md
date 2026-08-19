<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# PAYMENTS — how money reaches the ledger

> The working reference for everything money-side that is *ours* (parent-portal card payments, autopay,
> refunds). The Fabric external-payment contract lives in
> [`FABRIC_BILLING_CONTRACT.md`](./FABRIC_BILLING_CONTRACT.md). Canonical spec: `CLAUDE.md` §13 (payments)
> and §11.3/§11.4 (Stripe metadata + reconciliation).
>
> One rule above all: **card data never touches our server** — Stripe Elements in the browser, our backend
> only ever sees Stripe ids.
>
> Rewritten 2026-08-13 (0.48.0). This file used to describe a Stripe **webhook** — signature verification,
> a `stripe_events` dedupe table, endpoint auto-registration on boot. **None of that exists**, and the
> 2026-08-04 audit flagged the drift as OMS-017. See "There is no webhook" below for what replaced it.

## There is no webhook

Every payment reaches the ledger by a **pull** path. There is no `/api/stripe/webhook` route, no signature
verification, no endpoint registration; `stripe_events` was DROPPED in 0.48.0 (migration 0037) — a money schema carrying a table nobody writes is an invitation to wire the next thing to it.

| Path | Who triggers it | Channel recorded | Backstop if it doesn't happen |
| --- | --- | --- | --- |
| `POST /fabric/billing/record-payment` | Donations / Kiosk, through the OS broker | `donations-web` \| `kiosk` | reconciliation |
| `portal.confirmPayment` (confirm-on-return) | the parent's browser, after Elements confirms | `portal` | reconciliation |
| autopay's synchronous confirm | our own scheduler | `autopay` | reconciliation |
| `billing.recordManualPayment` | the office | `cash` \| `check` \| `ach` \| `zelle` \| `other` | — (a person is standing there) |
| the mid-year go-live | the office, once | `carry_in` | — |
| **reconciliation** (§11.4) | the daily job, or the Reconcile now button | whatever the PI's metadata says | it *is* the backstop |

**Why no webhook.** A webhook is an internet-facing route that must be exposed, signature-verified, deduped
and kept in step with Stripe's event catalogue — and it can tell us nothing reconciliation will not find
within a day. The pull paths are the optimisation; reconciliation is the guarantee. Money is never lost, only
delayed. The one place this shows is the wording after a parent pays: the UI may say "received" from the
client's own confirmation, softly, because the ledger write happens on the same round trip.

**The one Stripe call that changes the ledger immediately** is a refund (`payments/refunds.ts`): Stripe first,
then the mirror rows, in that order — a refused refund must leave the ledger saying the money is still here,
because it is.

## 13.1 Stripe client & keys

Keys are fetched over the Fabric (`GET ${OPENMASJID_BASE_URL}/api/fabric/stripe?account=<account>`) on boot
and whenever the admin changes the chosen account: publishable → the browser, secret → **server memory only**
(never the DB, never a log). A failed reload **clears** the previous client rather than leaving it live, so a
failed account switch cannot keep charging the old account. Each household that saves a method or enables
autopay gets a Stripe Customer, its id on `families`.

Only `payments/stripe.ts` imports the SDK. Everything else asks it for a client and copes with `null`.

## 13.2 Pay now (parent, Elements)

1. The parent picks an amount — the full balance pre-filled, or specific lines ticked — floored at
   `MIN_PAYMENT_CENTS`.
2. The server creates a PaymentIntent with §11.3's metadata (`omos_app=students-portal`,
   `students_channel=portal`, `students_family_id`), the description `School balance — <family label>`, and
   `automatic_payment_methods` enabled so the household is offered whatever the masjid's Stripe account has
   switched on (cards, and a US bank account where it is enabled).
3. The browser confirms with Elements. Card details never reach us.
4. `portal.confirmPayment` retrieves the PI, checks it is **ours** and **this household's** (metadata, not
   trust), and records it — idempotency key = the PI id, so a double-submit or a race with reconciliation is
   a no-op. Ticked lines become the payment's stored instruction (§9), so the line the parent chose stays
   settled through every later recompute.
5. A receipt to the household's guardians ("payment", never "donation"), and an alert to whoever the office
   listed.

## 13.3 Autopay (saved method + our scheduler — NOT Stripe subscriptions)

- **Enrol**: a SetupIntent with `usage: off_session`, then the household toggles autopay on. The consent
  timestamp is stored.
- **What is charged**: the sum of open invoice balances with `due_date <= today`, **capped at what the
  household's derived balance says it owes**. That cap is not belt-and-braces: a credit line larger than its
  invoice, or money paid ahead against a bill not yet due, would otherwise be charged as if owed.
- **Idempotency, twice over**: `autopay_runs` is UNIQUE on (family, run_date), and the Stripe idempotency key
  is derived from the run id.
- **The ladder**: retry on day +2 and day +5, and each attempt presents the **next saved method in the
  household's own order** (0.48.0) rather than the same declining card three times. After the third failure
  autopay is switched off, the parent is emailed and the office is alerted.
- **Indeterminate is not failure**: a network error leaves the run `pending` and does **not** advance the
  ladder (a phantom failure could auto-disable a family early), and a pending run blocks any further charge
  for that household until reconciliation resolves it. Guessing "no charge happened" is how you double-bill.

## 13.4 Refunds (0.48.0)

The unit is a **transaction**, not a payment row: one card charge covering three children is three rows
(§9), so refunds group by PaymentIntent and reverse the group while asking Stripe once. Stripe first, ledger
second. Idempotent at both ends — pressing twice refunds once.

Full refunds only, on purpose: every mirror row is derived from the original's own allocations, line for line,
and a partial has no such derivation. The office's tool for giving part of it back is a credit (a negative
charge) on the next bill, which already exists and is already tested.

**A `carry_in` row can never be refunded** — it is not money this app took, and reversing it would re-open
arrears the family does not owe. Refused in the engine, not merely hidden from the list.

## 13.5 Failure doctrine

- A browser that never came back, or a broker call that never arrived → reconciliation records it within a day.
- Stripe unreachable → pay-now, autopay and **card refunds** pause **visibly** and say why; cash reversals,
  the ledger, the year view and every printed document are unaffected.
- Skipped autopay runs are picked up by the next day's, because the due-date query is stateless.

## Paying ahead (every channel)

A parent may pay **any amount at any time, including when nothing is due** — a term up front, cash at the
start of Ramadan, the whole year in one go. There is no stored-credit table: `balance = invoiced − paid`, so
money beyond the open invoices simply reads as that child's credit, and `ledger.reallocateStudent` hands it to
the next invoice the moment one exists.

The floor is `MIN_PAYMENT_CENTS` in `db/money.ts` — **one** constant, enforced on portal pay-now and
advertised to the kiosk and donation site as `info.minAmountCents`, so the three cannot drift apart. It is
deliberately NOT enforced on `record-payment`, which writes down money a consumer has *already* taken;
refusing a 50¢ charge somebody really made would lose it, not prevent it.

Consumer-side note: a kiosk or donation site must offer its amount field even at a zero balance. The
`info.allowAdvance` flag exists to tell it so — see
[`FABRIC_BILLING_CONTRACT.md`](./FABRIC_BILLING_CONTRACT.md) §11.2.

## 6. Processing fees — who pays Stripe's cut (0.51.0, `payments/fees.ts`)

Off by default. A madrasah pays roughly **2.9% + 30¢** to accept a card, so a $100 invoice brings in
$96.80; switch this on and the payer covers it instead — the card is charged **$103.30** and the school
receives the full $100. Cash, cheque and Zelle are never touched, because there is no processing fee to
pass on and inventing one would be a charge for nothing.

**A fee is not tuition and never enters the ledger.** That is the whole invariant. Every balance in this
app is `invoiced − paid` (§9), so crediting $103.30 against a $100 bill leaves a $3.30 credit that
absorbs part of next month — and it is not an error anybody sees, it is a slow drift that compounds for
as long as the setting is on. The dangerous direction is therefore *reading a Stripe amount back*, and
three paths do it: the portal's confirm-on-return, autopay's synchronous confirm, and the daily
reconciliation. All three go through `netOfIntent`, and nothing else may do that subtraction.

**The fee travels on the PaymentIntent** (`students_fee_cents`, §11.3), not in a setting. Reconciliation
runs a day later, on a job that never saw the request, and by then the rate may have changed or the
feature been switched off — so the figure that was true when the payer agreed to it is carried with the
charge. It is also what lets Donations and Kiosk mint their own intents and still be read correctly here.

**Two rates, because they are not the same cost.** A card is 2.9% + 30¢ with no ceiling; ACH is 0.8%
**capped at $5**. On a $2,000 term payment that is $59.79 against $5.00, so the bank rate has its own
switch (an office may reasonably pass on the card cost and absorb the bank one) and the cap is honoured
— grossing up past it would charge a percentage of a fee that had stopped growing, which is money taken
for nothing. Because a PaymentIntent's amount is fixed before Stripe asks the payer anything, an install
that passes on both asks the parent which they are using *first*.

**The arithmetic, and why the obvious version is wrong.** Stripe takes its percentage of the GROSS, so
`gross = (tuition + fixed) / (1 − rate)`, rounded **up**. A naive markup on the tuition gives $103.20 and
leaves the school a dime short on every $100 — an invoice that settles at $99.99 and stays open forever,
showing a family as unpaid over a penny. Rounding up means the school is occasionally a cent over, which
is a rounding; a cent under is a support call.

**A refund returns the whole charge**, fee included, because that is what the payer handed over —
`stripe.refunds.create` with no amount refunds the PaymentIntent in full, and the ledger reverses the
tuition. Stripe does not return its own cut on a refund, so the madrasah absorbs it. That is the honest
outcome and the refund screen says so.

**Compliance is the masjid's, and we say so out loud.** Passing a card fee to the payer is regulated:
US federal law forbids it on **debit** cards, a few states forbid it outright, and the card networks cap
it at what acceptance actually costs. This app cannot know a masjid's jurisdiction or its Stripe
agreement, so the rate is clamped to something that could not exceed a real cost of acceptance (10%),
the default is off, and the Settings panel carries the warning above the switch rather than in a
footnote.

## Ledger invariants (see `billing/ledger.ts`)

- All money in **integer cents**. Balances **derived, never stored**. Payments **immutable** (corrections =
  reversal rows; a refund is a Stripe refund plus those same rows).
- **One** `recordPayment`/`recordSplit` path, used by the Fabric provider, the portal, autopay,
  reconciliation, the manual-payment UI and the mid-year go-live.
- Allocation is **per line** and **re-derived** whenever a bill changes, with a payer's stored instruction
  honoured before the oldest-due-first sweep.
- Idempotency at the DB: `payments.idempotency_key` UNIQUE (the Stripe PI id, whatever the channel), suffixed
  `:studentId` when one charge fans out across siblings. Prefix-match it with `substr`, never `LIKE` — `_` is
  a LIKE wildcard and Stripe ids are full of them.
- Channels: `donations-web | kiosk | portal | autopay | cash | check | ach | zelle | other | carry_in`.
