ALTER TABLE `students` ADD `student_code` text;--> statement-breakpoint
CREATE UNIQUE INDEX `students_code_uq` ON `students` (`student_code`);