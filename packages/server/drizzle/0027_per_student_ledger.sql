PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`label` text NOT NULL,
	`period_key` text NOT NULL,
	`due_date` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_invoices`("id", "student_id", "label", "period_key", "due_date", "status", "created_at", "updated_at") SELECT "id", "student_id", "label", "period_key", "due_date", "status", "created_at", "updated_at" FROM `invoices`;--> statement-breakpoint
DROP TABLE `invoices`;--> statement-breakpoint
ALTER TABLE `__new_invoices` RENAME TO `invoices`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `invoices_student_idx` ON `invoices` (`student_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_student_period_uq` ON `invoices` (`student_id`,`period_key`);--> statement-breakpoint
CREATE TABLE `__new_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
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
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_payments`("id", "student_id", "amount_cents", "channel", "occurred_at", "memo", "idempotency_key", "external_ref", "reversal_of", "recorded_by_user_id", "recorded_by_name", "created_at") SELECT "id", "student_id", "amount_cents", "channel", "occurred_at", "memo", "idempotency_key", "external_ref", "reversal_of", "recorded_by_user_id", "recorded_by_name", "created_at" FROM `payments`;--> statement-breakpoint
DROP TABLE `payments`;--> statement-breakpoint
ALTER TABLE `__new_payments` RENAME TO `payments`;--> statement-breakpoint
CREATE INDEX `payments_student_idx` ON `payments` (`student_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payments_idempotency_uq` ON `payments` (`idempotency_key`);--> statement-breakpoint
ALTER TABLE `families` DROP COLUMN `discount_kind`;--> statement-breakpoint
ALTER TABLE `families` DROP COLUMN `discount_value`;