-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 OpenMasjid-Solutions
--
-- The ORDER a household's saved payment methods are tried in (0.48.0).
--
-- There was one `is_default` boolean, so a family with two cards could say which one autopay used and
-- nothing more. A parent who wants "the joint account first, my card if that bounces" had no way to say
-- it, and the retry ladder simply presented the same declining card again two days later.
--
-- `sort_order` is now the authority: position 0 is what autopay charges, and the retry ladder walks down
-- the list. `is_default` is KEPT and mirrors position 0 rather than being dropped, because it is what the
-- portal, the autopay enrolment and the office screens already read — removing a column that several
-- readers depend on, in the same change that introduces the ordering, is two risks where one will do.
--
-- Backfill: the existing default keeps its place at the front; everything else follows. Ties are broken by
-- `created_at` in every query that reads this, so "1" for all the others is not an arbitrary order — it is
-- oldest-first, which is the order they were added and the only order anybody has seen so far.

ALTER TABLE `payment_methods` ADD `sort_order` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `payment_methods` SET `sort_order` = CASE WHEN `is_default` = 1 THEN 0 ELSE 1 END;
