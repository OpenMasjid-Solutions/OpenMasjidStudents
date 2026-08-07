-- Multiple schools in one masjid (0.47.0): a maktab on a Sep-Jun calendar beside a hifz programme
-- that runs year-round, each with its own school year and its own course tree.
--
-- THIS IS NOT MULTI-TENANCY (CLAUDE.md §4 keeps that out). Schools share every setting, every staff
-- account, every fee plan, the Stripe account — and the HOUSEHOLD, which is the load-bearing part: a
-- family with a child in each school stays ONE family with one balance, one portal login and one
-- printed sheet. So `families`, `invoices`, `payments` and everything else on the money path are
-- deliberately untouched here. What gets scoped is only the calendar and the grouping.
--
-- NO TABLE REBUILDS, and no data is deleted or moved. Every new column is added nullable and
-- backfilled to the one default school below, which is exactly how `students.student_code` and
-- `school_years.start_year` were introduced. A rebuild of `students` is what 0026 warned about — the
-- money tables reference it with RESTRICT — so it is avoided rather than attempted carefully.
CREATE TABLE `schools` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schools_name_uq` ON `schools` (`name`);--> statement-breakpoint
-- No rows: a restriction table, where EMPTY MEANS UNRESTRICTED. An install that upgrades therefore
-- keeps every staff account seeing every school, which is the only safe default — the alternative
-- would silently lock people out of a school the morning after an update.
CREATE TABLE `user_schools` (
	`user_id` text NOT NULL,
	`school_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `school_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_schools_school_idx` ON `user_schools` (`school_id`);--> statement-breakpoint
ALTER TABLE `school_years` ADD `school_id` text REFERENCES `schools`(`id`);--> statement-breakpoint
ALTER TABLE `courses` ADD `school_id` text REFERENCES `schools`(`id`);--> statement-breakpoint
ALTER TABLE `students` ADD `school_id` text REFERENCES `schools`(`id`);--> statement-breakpoint
CREATE INDEX `school_years_school_idx` ON `school_years` (`school_id`);--> statement-breakpoint
CREATE INDEX `courses_school_idx` ON `courses` (`school_id`);--> statement-breakpoint
CREATE INDEX `students_school_idx` ON `students` (`school_id`);--> statement-breakpoint
-- A course name is unique WITHIN a school now, not across the install. "Level 1" is an ordinary name
-- for a course in the maktab and another in the hifz programme, and the old index made the second one
-- impossible to create. Dropping and recreating an index needs no table rebuild.
DROP INDEX IF EXISTS `courses_name_uq`;--> statement-breakpoint
CREATE UNIQUE INDEX `courses_school_name_uq` ON `courses` (`school_id`,`name`);--> statement-breakpoint
-- The default school. Created HERE, in SQL, rather than left to application code, so the backfill
-- below happens in the same transaction as the columns and no row is ever left unscoped.
--
-- The id is a literal, not generated: it has to be referenced by the three UPDATEs that follow, and a
-- fixed well-known id also lets `ensureDefaultSchool()` recognise it later. The name comes from the
-- school name the masjid already set in Settings, so an upgraded install opens with its own name on
-- the tab rather than the word "Default" — and falls back only when that setting was never filled in.
INSERT INTO `schools` (`id`, `name`, `sort_order`, `status`, `created_at`, `updated_at`)
SELECT
  'sch_default',
  COALESCE((SELECT NULLIF(TRIM(`value`), '') FROM `settings` WHERE `key` = 'school_name'), 'Main school'),
  0,
  'active',
  CAST(strftime('%s', 'now') AS integer) * 1000,
  CAST(strftime('%s', 'now') AS integer) * 1000
WHERE NOT EXISTS (SELECT 1 FROM `schools`);--> statement-breakpoint
UPDATE `school_years` SET `school_id` = 'sch_default' WHERE `school_id` IS NULL;--> statement-breakpoint
UPDATE `courses` SET `school_id` = 'sch_default' WHERE `school_id` IS NULL;--> statement-breakpoint
UPDATE `students` SET `school_id` = 'sch_default' WHERE `school_id` IS NULL;
