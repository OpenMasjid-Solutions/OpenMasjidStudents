<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# PAYMENTS — Stripe flows, webhook events, autopay ladder

> **Status: stub.** This document is filled in as steps 15–17 (§20) land. It is the working
> reference for everything money-side that is *ours* (the parent-portal card payments and
> autopay) — the Fabric external-payment contract lives in
> [`FABRIC_BILLING_CONTRACT.md`](./FABRIC_BILLING_CONTRACT.md).
>
> Canonical spec: `CLAUDE.md` §13 (payments) and §11.3/§11.4 (Stripe metadata + reconciliation).
> One rule above all: **card data never touches our server** — Stripe Elements in the browser,
> our backend only ever sees Stripe ids.

## Contents (to be written as the slices land)

- **13.1 Stripe client & keys** — fetch account keys over the Fabric
  (`GET ${OPENMASJID_BASE_URL}/api/fabric/stripe?account=<STRIPE_ACCOUNT>`); publishable → browser,
  secret → server memory only (never DB, never logs). Per-family Stripe Customer id on `families`.
- **13.2 Pay now (parent, Elements)** — PI creation, metadata (§11.3, `omos_app=students-portal`),
  ledger truth lands on the webhook (channel `portal`, idempotency key = PI id), optimistic UI wording.
- **13.3 Autopay** — saved card (SetupIntent, `off_session`) + **our** scheduler (croner), NOT Stripe
  subscriptions. `autopay_runs` UNIQUE (family, run_date) → Stripe idempotency key derived from run id.
- **13.3 Decline / SCA ladder** — retry on day +2 and +5; email each failure; after 3rd failure
  auto-disable + email parent + Fabric-notify finance. Never exceed the ladder.
- **13.4 Webhooks** — `POST /api/stripe/webhook` at `OPENMASJID_PUBLIC_URL`, raw-body signature verify,
  `stripe_events` dedupe. Handle: `payment_intent.succeeded`, `payment_intent.payment_failed`,
  `setup_intent.succeeded`, `charge.refunded`. Endpoint auto-registration on boot; manual signing-secret fallback.
- **13.5 Failure doctrine** — no tunnel/webhook → reconciliation (§11.4) within a day; Stripe down →
  pay-now + autopay pause visibly, everything else unaffected.

## Paying ahead (every channel)

A parent may pay **any amount at any time, including when nothing is due** — a term up front, cash at
the start of Ramadan, the whole year in one go. There is no stored-credit table: `balance =
invoiced − paid`, so money beyond the open invoices simply reads as that child's credit, and
`ledger.reallocateStudent` hands it to the next invoice the moment one exists.

The floor is `MIN_PAYMENT_CENTS` in `db/money.ts` — **one** constant, enforced on portal pay-now and
advertised to the kiosk and donation site as `info.minAmountCents`, so the three cannot drift apart. It
is deliberately NOT enforced on `record-payment`, which writes down money a consumer has *already*
taken; refusing a 50¢ charge somebody really made would lose it, not prevent it.

Consumer-side note: a kiosk or donation site must offer its amount field even at a zero balance. The
`info.allowAdvance` flag exists to tell it so — see
[`FABRIC_BILLING_CONTRACT.md`](./FABRIC_BILLING_CONTRACT.md) §11.2.

## Ledger invariants (see `billing/ledger.ts`)

- All money in **integer cents**. Balances **derived, never stored**. Payments **immutable** (corrections = reversal rows).
- **One** `ledger.record` path used by: the Fabric provider, the Stripe webhook handler, autopay, and the manual-payment UI.
- Idempotency at the DB: `payments.idempotency_key` UNIQUE (the Stripe PI id, whatever the channel).
- Channels: `donations-web | kiosk | portal | autopay | cash | zelle | check | other`.
