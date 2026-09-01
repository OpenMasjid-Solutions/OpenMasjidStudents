-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 OpenMasjid-Solutions
--
-- Standing arrangements to record an offline payment automatically (0.51.0-dev.15).
--
-- Autopay for money that never touches Stripe: a family who hands over cash or sends a bank transfer
-- every month. PER STUDENT, because a payment belongs to exactly one student (CLAUDE.md §9) — unlike
-- `autopay_enrollments`, which is per family because it drives one card charge that then fans out.
--
-- No amount column on purpose: the figure is whatever is OWED on the day, so the arrangement can never
-- manufacture credit or drift away from the bills. See billing/standingPayments.ts.
CREATE TABLE `standing_payments` (
	`student_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`channel` text NOT NULL,
	`day_of_month` integer DEFAULT 1 NOT NULL,
	`memo` text,
	`last_period` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `standing_payments_due_idx` ON `standing_payments` (`day_of_month`) WHERE `enabled` = 1;
