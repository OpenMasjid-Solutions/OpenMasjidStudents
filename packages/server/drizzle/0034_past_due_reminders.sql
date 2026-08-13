-- When a household was last reminded that its balance is past due (0.48.0).
--
-- The only state the past-due reminder keeps, and it exists to stop the reminder becoming a nuisance: a
-- daily job that writes to every overdue family every day is not a reminder, and it is how a madrasah's
-- mail ends up in spam folders — taking the invites and the receipts with it. One row per household says
-- when it was last written to, so "at most once a week" means what it says.
--
-- This is NOT a balance and NOT a debt record. Nothing bills from it; the money lives entirely in the
-- invoices and the payments (§9). Emptying this table would only mean the next run reminds everybody once.
--
-- ON DELETE CASCADE, like carry_ins and unlike every money path: it is a note about a household, and it
-- has nothing to say once that household is gone.
--
-- A pure CREATE TABLE — nothing to backfill. An install upgrading into this has no rows, which reads as
-- "nobody has been reminded yet", and that is true.
CREATE TABLE `past_due_reminders` (
	`family_id` text PRIMARY KEY NOT NULL REFERENCES `families`(`id`) ON DELETE cascade,
	`last_sent_on` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
