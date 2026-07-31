-- Who gets emailed when something happens (0.44.0): an address plus the list of alerts it receives.
--
-- A recipient is an ADDRESS, not an account — the person who needs to know that autopay switched
-- itself off is often not someone who logs in — so this is a new table rather than a column on
-- `users`, and adding a row grants access to nothing.
--
-- A pure CREATE TABLE on a table that does not exist yet: nothing to backfill, no rebuild, and an
-- install that upgrades simply starts with no recipients (alerts then behave exactly as they did).
CREATE TABLE `alert_recipients` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`label` text,
	`events` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_recipients_email_unique` ON `alert_recipients` (`email`);