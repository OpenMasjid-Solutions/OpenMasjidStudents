-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 OpenMasjid-Solutions
--
-- ADDRESS, LANGUAGES AND NATIONALITY MOVE TO THE HOUSEHOLD (0.52.0-dev.4).
--
-- They shipped on the STUDENT in 0.52.0-dev.3 and that was wrong, corrected by Hasan a release later.
-- A family shares all three: holding them per child means three copies of one address that drift apart,
-- and an office correcting it has to remember how many children are on the record. It is the same rule
-- guardians, phone numbers and emergency contacts have always followed (CLAUDE.md §9) — nothing is
-- copied per student, which is exactly why linking a sibling is what makes a household's details apply
-- to them. A child who genuinely lives elsewhere is a note on their record, not a fourth copy.
--
-- WHAT HAPPENS TO DATA ALREADY TYPED: carried across, one value per household, taking the first
-- non-empty one among its children (ordered by row id, so it is deterministic rather than whatever
-- SQLite felt like returning). Two children of one household with DIFFERENT addresses would lose one
-- — which is precisely the drift this move exists to prevent, and is why it is being done now, on the
-- development channel, one release after the columns appeared and before any stable release carries
-- them. No stable install has ever had these columns.
ALTER TABLE `families` ADD `address` text;--> statement-breakpoint
ALTER TABLE `families` ADD `languages` text;--> statement-breakpoint
ALTER TABLE `families` ADD `nationality` text;--> statement-breakpoint
UPDATE `families` SET `address` = (
  SELECT trim(s.`address`) FROM `students` s
  WHERE s.`family_id` = `families`.`id` AND s.`address` IS NOT NULL AND trim(s.`address`) <> ''
  ORDER BY s.`id` LIMIT 1
);
--> statement-breakpoint
UPDATE `families` SET `languages` = (
  SELECT trim(s.`languages`) FROM `students` s
  WHERE s.`family_id` = `families`.`id` AND s.`languages` IS NOT NULL AND trim(s.`languages`) <> ''
  ORDER BY s.`id` LIMIT 1
);
--> statement-breakpoint
UPDATE `families` SET `nationality` = (
  SELECT trim(s.`nationality`) FROM `students` s
  WHERE s.`family_id` = `families`.`id` AND s.`nationality` IS NOT NULL AND trim(s.`nationality`) <> ''
  ORDER BY s.`id` LIMIT 1
);
--> statement-breakpoint
ALTER TABLE `students` DROP COLUMN `address`;--> statement-breakpoint
ALTER TABLE `students` DROP COLUMN `languages`;--> statement-breakpoint
ALTER TABLE `students` DROP COLUMN `nationality`;
