-- Drops the old first_name/last_name pair now that 0028 has joined them into `full_name`, and
-- makes the replacement NOT NULL. Depends on 0028 having populated every row — migrations run in
-- order on boot, so by the time this executes there is nothing left to copy.
--
-- Also drops `users.phone`: the app never contacts staff by phone, so the column was personal data
-- held for no purpose. Guardian and emergency-contact numbers are untouched — those are the ones
-- the office actually rings.
-- NOTE: the `PRAGMA foreign_keys=OFF` below does NOT work — the migrator wraps this file in a
-- transaction and SQLite ignores that pragma inside one. Rebuilding `students` means dropping a
-- table five others reference, so this migration only survives because db/index.ts turns foreign
-- keys off around the whole migration run, outside any transaction. See the comment there before
-- changing either place.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_students` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`full_name` text NOT NULL,
	`dob` text,
	`status` text DEFAULT 'active' NOT NULL,
	`notes` text,
	`class_id` text,
	`student_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`class_id`) REFERENCES `classes`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_students`("id", "family_id", "full_name", "dob", "status", "notes", "class_id", "student_code", "created_at", "updated_at") SELECT "id", "family_id", "full_name", "dob", "status", "notes", "class_id", "student_code", "created_at", "updated_at" FROM `students`;--> statement-breakpoint
DROP TABLE `students`;--> statement-breakpoint
ALTER TABLE `__new_students` RENAME TO `students`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `students_family_idx` ON `students` (`family_id`);--> statement-breakpoint
CREATE INDEX `students_class_idx` ON `students` (`class_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `students_code_uq` ON `students` (`student_code`);--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `phone`;