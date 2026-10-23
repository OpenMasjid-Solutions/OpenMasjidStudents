-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 OpenMasjid-Solutions
--
-- THE STUDENT RECORD (0.52.0, CLAUDE.md §4a Phase 1).
--
-- A student was a name, a Student ID, an optional date of birth and a status: a billing record, not a
-- student record. This is what a madrasa actually keeps about a child, and what the v0.35.0 pivot had
-- removed.
--
-- Three medical columns are the §14 AMENDMENT — the section read "no SSNs, no medical fields, no
-- photos" for the whole life of the project. SSNs and photos are not amended and stay forbidden. The
-- conditions on the medical three live in `people/fields.ts` and are enforced there, not here: admin
-- only, off until an office turns them on, never parent-facing, never in a log or an alert.
--
-- `student_notes` REPLACES `students.notes`, which was a single anonymous column that `studentAdd` and
-- the importer wrote and **nothing rendered**. Whatever an install had is carried across as one note
-- before the column is dropped — a field an office filled in for months deserves better than being
-- deleted by an upgrade.
--
-- Safe on a live install: every new column is nullable and needs no backfill, the copy touches only
-- rows that actually have notes, and `DROP COLUMN` is the same in-place statement 0025 used to remove
-- the student PINs (no table rebuild, so the FKs from invoices, payments and charges are untouched).
CREATE TABLE `student_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`body` text NOT NULL,
	`author_user_id` text,
	`author_name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `student_notes_student_idx` ON `student_notes` (`student_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `students` ADD `admitted_on` text;--> statement-breakpoint
ALTER TABLE `students` ADD `withdrawn_on` text;--> statement-breakpoint
ALTER TABLE `students` ADD `withdrawal_reason` text;--> statement-breakpoint
ALTER TABLE `students` ADD `address` text;--> statement-breakpoint
ALTER TABLE `students` ADD `prior_school` text;--> statement-breakpoint
ALTER TABLE `students` ADD `prior_hifz` text;--> statement-breakpoint
ALTER TABLE `students` ADD `languages` text;--> statement-breakpoint
ALTER TABLE `students` ADD `nationality` text;--> statement-breakpoint
ALTER TABLE `students` ADD `medical_notes` text;--> statement-breakpoint
ALTER TABLE `students` ADD `allergies` text;--> statement-breakpoint
ALTER TABLE `students` ADD `medical_consent` integer;--> statement-breakpoint
-- Carry the old anonymous notes across as ONE authored note per student, stamped with the row's own
-- `updated_at` so it sits sensibly in the timeline, and attributed to nobody in particular — because
-- nobody in particular is genuinely who wrote it: the old column recorded no author.
INSERT INTO `student_notes` (`id`, `student_id`, `body`, `author_user_id`, `author_name`, `created_at`)
SELECT 'stn_' || lower(hex(randomblob(10))), `id`, trim(`notes`), NULL, 'Imported', `updated_at`
FROM `students`
WHERE `notes` IS NOT NULL AND trim(`notes`) <> '';
--> statement-breakpoint
ALTER TABLE `students` DROP COLUMN `notes`;
