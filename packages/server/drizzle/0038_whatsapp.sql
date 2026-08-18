-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 OpenMasjid-Solutions
--
-- WhatsApp (0.50.0). OpenMasjidOS can now send WhatsApp messages through a self-hosted OpenWA
-- gateway, so this app can reach a parent on the channel they actually read. Three parts:
--
--  1. Staff numbers. `users.phone` was deliberately dropped once ("the app never contacts staff by
--     phone"). That reason no longer holds — a staff alert that finds the treasurer away from their
--     inbox is the whole point — so it comes back WITH a purpose, plus the country it belongs to and
--     which alerts that person wants.
--  2. Guardian country + opt-out. The country because a madrasa's families are not all in one place;
--     the opt-out because a person may say no, and that answer belongs on the person.
--  3. The queue log. Event, recipient, time, outcome — never the message body.
ALTER TABLE `users` ADD `phone` text;--> statement-breakpoint
ALTER TABLE `users` ADD `phone_country` text;--> statement-breakpoint
ALTER TABLE `users` ADD `wa_events` text;--> statement-breakpoint
ALTER TABLE `guardians` ADD `phone_country` text;--> statement-breakpoint
ALTER TABLE `guardians` ADD `wa_opt_out` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE `whatsapp_log` (
	`id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`recipient_kind` text NOT NULL,
	`recipient_id` text NOT NULL,
	`family_id` text,
	`status` text NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `whatsapp_log_at_idx` ON `whatsapp_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `whatsapp_log_recipient_idx` ON `whatsapp_log` (`recipient_kind`,`recipient_id`);
