DROP INDEX `students_pin_uq`;--> statement-breakpoint
ALTER TABLE `students` DROP COLUMN `pin`;--> statement-breakpoint
ALTER TABLE `students` DROP COLUMN `pin_updated_at`;