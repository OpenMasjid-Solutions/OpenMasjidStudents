-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 OpenMasjid-Solutions
--
-- ADMISSIONS — the whole of CLAUDE.md §4a Phase 2's schema, in one migration (0.52.0-dev.7).
--
-- Four tables and two columns, landing together rather than one per dev build. That is deliberate:
-- §9 calls a hand-typed `_journal.json` `when` the highest-consequence footgun in this repo — a
-- value that is not strictly greater applies perfectly on a fresh database and is skipped FOREVER on
-- a live one, with the app booting, reporting success and failing at runtime on a missing table. Four
-- chances to make that mistake is worse than one, and a table that arrives a build before its writer
-- is inert rather than dangerous.
--
-- ALL OF IT IS ADDITIVE. Nothing is dropped, nothing is rewritten, no existing row is touched, and
-- nothing here is on the money path: the enrollment fee is raised through `billing/charges.ts`
-- `raiseChargeOnce` against the `charges` table that already exists, using the `source_key` added in
-- 0041 for exactly this (§4a Phase 0). Admissions opens no second path into the ledger (§11).
--
-- THE RULE THE SHAPE ENFORCES: an inquiry is not a student and not a household. It never mints a
-- Student ID and is never billable. `inquiries.student_id` is the only link and it is null until
-- conversion — pointing forward, so nothing on the payment path can reach back into an unconfirmed,
-- publicly submitted record (§11.2, §14).
CREATE TABLE `inquiries` (
	`id` text PRIMARY KEY NOT NULL,
	`school_id` text,
	`school_year_id` text,
	`child_name` text NOT NULL,
	`child_dob` text,
	`asked_about` text,
	`parent_name` text NOT NULL,
	`email` text,
	`phone` text,
	`message` text,
	`state` text DEFAULT 'new' NOT NULL,
	`source` text DEFAULT 'public' NOT NULL,
	`waitlist_position` integer,
	`waitlist_reason` text,
	`submitted_payload` text,
	`student_id` text,
	`family_id` text,
	`dedupe_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`school_year_id`) REFERENCES `school_years`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `inquiries_state_idx` ON `inquiries` (`state`);--> statement-breakpoint
CREATE INDEX `inquiries_year_idx` ON `inquiries` (`school_year_id`);--> statement-breakpoint
-- The dedupe probe is always "this digest, recently", so the index carries both columns.
CREATE INDEX `inquiries_dedupe_idx` ON `inquiries` (`dedupe_key`,`created_at`);--> statement-breakpoint
CREATE TABLE `inquiry_events` (
	`id` text PRIMARY KEY NOT NULL,
	`inquiry_id` text NOT NULL,
	`from_state` text,
	`to_state` text NOT NULL,
	`reason` text,
	`actor_user_id` text,
	`actor_name` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`inquiry_id`) REFERENCES `inquiries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `inquiry_events_inquiry_idx` ON `inquiry_events` (`inquiry_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `readmissions` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`school_year_id` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`submitted_payload` text,
	`fee_override_cents` integer,
	`fee_waived` integer DEFAULT false NOT NULL,
	`reminded_at` integer,
	`submitted_at` integer,
	`approved_at` integer,
	`approved_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`school_year_id`) REFERENCES `school_years`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
-- The whole idempotency story for a flow whose normal mode of use is "send to 300 families, twice".
CREATE UNIQUE INDEX `readmissions_student_year_uq` ON `readmissions` (`student_id`,`school_year_id`);--> statement-breakpoint
CREATE INDEX `readmissions_year_state_idx` ON `readmissions` (`school_year_id`,`state`);--> statement-breakpoint
CREATE TABLE `admission_links` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`kind` text NOT NULL,
	`inquiry_id` text,
	`readmission_id` text,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`inquiry_id`) REFERENCES `inquiries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`readmission_id`) REFERENCES `readmissions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Only the SHA-256 hash is ever stored, exactly as `invites` and `password_resets` do it (§14), so a
-- stolen row cannot be replayed as a link. UNIQUE because redemption looks the token up by its hash.
CREATE UNIQUE INDEX `admission_links_token_hash_unique` ON `admission_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `admission_links_inquiry_idx` ON `admission_links` (`inquiry_id`);--> statement-breakpoint
CREATE INDEX `admission_links_readmission_idx` ON `admission_links` (`readmission_id`);--> statement-breakpoint
-- What a year charges to join and to come back. NULL means no fee, which is an ordinary madrasah
-- rather than an unconfigured one — so every existing year on every live install reads correctly
-- with no backfill, and nothing starts charging anybody because this migration ran.
ALTER TABLE `school_years` ADD `admission_fee_cents` integer;--> statement-breakpoint
ALTER TABLE `school_years` ADD `readmission_fee_cents` integer;
