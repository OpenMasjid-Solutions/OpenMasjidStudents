-- Per-student ledger, part 1 of 2: clear the money tables, then add the student-scoped columns.
--
-- WHY THIS DELETES DATA. Invoices and payments are moving from family scope to student scope, and a
-- family invoice covering three children cannot be mechanically split into three student invoices —
-- its payments would have to be re-attributed, and payments are immutable (CLAUDE.md §9), so
-- rewriting them is not an option. The family discount is dropped in the same release, so historical
-- totals would change regardless. Confirmed with Hasan (2026-07-26) that no masjid has real billing
-- data yet, only his own test install. Invoices regenerate from fee plans in one click.
--
-- Order matters — every money FK is ON DELETE RESTRICT:
--   charges.invoice_item_id -> invoice_items, so invoiced charges are reset to pending FIRST, which
--   also makes them billable again by the next generation (nothing about them is lost);
--   then allocations -> payments -> invoice_items -> invoices.
UPDATE `charges` SET `status` = 'pending', `invoice_item_id` = NULL WHERE `status` = 'invoiced';--> statement-breakpoint
DELETE FROM `payment_allocations`;--> statement-breakpoint
DELETE FROM `payments`;--> statement-breakpoint
DELETE FROM `invoice_items`;--> statement-breakpoint
DELETE FROM `invoices`;--> statement-breakpoint
-- Autopay run history recorded charges that no longer have payment rows, and the retry ladder it
-- feeds would otherwise reason about debt that no longer exists.
DELETE FROM `autopay_runs`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text,
	`student_id` text,
	`label` text NOT NULL,
	`period_key` text NOT NULL,
	`due_date` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
-- (no rows to copy: the money tables were emptied above)
DROP TABLE `invoices`;--> statement-breakpoint
ALTER TABLE `__new_invoices` RENAME TO `invoices`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `invoices_family_idx` ON `invoices` (`family_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_family_period_uq` ON `invoices` (`family_id`,`period_key`);--> statement-breakpoint
CREATE TABLE `__new_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text,
	`student_id` text,
	`amount_cents` integer NOT NULL,
	`channel` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`memo` text,
	`idempotency_key` text NOT NULL,
	`external_ref` text,
	`reversal_of` text,
	`recorded_by_user_id` text,
	`recorded_by_name` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
-- (no rows to copy: the money tables were emptied above)
DROP TABLE `payments`;--> statement-breakpoint
ALTER TABLE `__new_payments` RENAME TO `payments`;--> statement-breakpoint
CREATE INDEX `payments_family_idx` ON `payments` (`family_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payments_idempotency_uq` ON `payments` (`idempotency_key`);