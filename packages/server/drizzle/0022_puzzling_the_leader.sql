CREATE TABLE `charge_items` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`default_amount_cents` integer NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `charge_items_name_uq` ON `charge_items` (`name`);--> statement-breakpoint
CREATE TABLE `charges` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`charge_item_id` text,
	`label` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`note` text,
	`period_key` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`invoice_item_id` text,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`charge_item_id`) REFERENCES `charge_items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`invoice_item_id`) REFERENCES `invoice_items`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `charges_student_status_idx` ON `charges` (`student_id`,`status`);--> statement-breakpoint
CREATE INDEX `charges_period_idx` ON `charges` (`period_key`);--> statement-breakpoint
CREATE TABLE `classes` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `classes_course_idx` ON `classes` (`course_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `classes_course_name_uq` ON `classes` (`course_id`,`name`);--> statement-breakpoint
CREATE TABLE `courses` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `courses_name_uq` ON `courses` (`name`);--> statement-breakpoint
CREATE TABLE `school_years` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`start_month` integer NOT NULL,
	`end_month` integer NOT NULL,
	`is_current` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `school_years_current_idx` ON `school_years` (`is_current`);--> statement-breakpoint
CREATE TABLE `terms` (
	`id` text PRIMARY KEY NOT NULL,
	`school_year_id` text NOT NULL,
	`name` text NOT NULL,
	`start_date` text,
	`end_date` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`school_year_id`) REFERENCES `school_years`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `terms_year_idx` ON `terms` (`school_year_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `terms_year_name_uq` ON `terms` (`school_year_id`,`name`);--> statement-breakpoint
ALTER TABLE `invoice_items` ADD `fee_plan_id` text REFERENCES fee_plans(id);--> statement-breakpoint
CREATE INDEX `invoice_items_plan_idx` ON `invoice_items` (`fee_plan_id`);--> statement-breakpoint
ALTER TABLE `student_fees` ADD `override_amount_cents` integer;--> statement-breakpoint
ALTER TABLE `student_fees` ADD `note` text;--> statement-breakpoint
ALTER TABLE `student_fees` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `students` ADD `class_id` text REFERENCES classes(id);--> statement-breakpoint
CREATE INDEX `students_class_idx` ON `students` (`class_id`);