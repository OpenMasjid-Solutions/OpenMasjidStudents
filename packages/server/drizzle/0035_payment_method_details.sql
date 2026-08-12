-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 OpenMasjid-Solutions
--
-- What a saved payment method actually IS (0.48.0).
--
-- `payment_methods` only ever had card columns, and `saveCard` filled them from `pm.card` — which is
-- undefined for everything that is not a card. The parent portal's Payment Element offers whatever the
-- masjid's Stripe account has switched on, so a household that saved a BANK ACCOUNT got a row of NULLs
-- and a portal reading "CARD ···· / Expires /". Nothing was broken about the payment; the app simply had
-- no column in which to write what it was looking at.
--
-- `type` is Stripe's own `PaymentMethod.type` (card, us_bank_account, link, cashapp, …) and is what the
-- portal now switches its wording on. `wallet` is `card.wallet.type` for a card added through Apple Pay
-- or Google Pay, where "Visa ···· 4242" alone would not match what the parent thinks they saved.
--
-- Deliberately NOT stored: a routing number, an account holder's name, a Link email. A parent looking at
-- their own row gains nothing from them that the last four digits do not already give, and this table is
-- read on a screen the household reaches over the internet (§14 data minimisation).
--
-- Existing rows: a row with a brand is a card, so it is labelled one. A row WITHOUT a brand cannot be
-- classified from here — the fact was never captured — so it stays NULL and the portal repairs it from
-- Stripe on the next read, the id being the Stripe PaymentMethod id.

ALTER TABLE `payment_methods` ADD `type` text;--> statement-breakpoint
ALTER TABLE `payment_methods` ADD `wallet` text;--> statement-breakpoint
ALTER TABLE `payment_methods` ADD `bank_name` text;--> statement-breakpoint
ALTER TABLE `payment_methods` ADD `account_type` text;--> statement-breakpoint
UPDATE `payment_methods` SET `type` = 'card' WHERE `type` IS NULL AND `brand` IS NOT NULL;
