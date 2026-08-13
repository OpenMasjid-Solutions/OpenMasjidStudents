-- What the office told us at go-live, per child (0.48.0).
--
-- The mid-year wizard asks one question per child — "paid through which month?" — derives a carried
-- forward bill or a prepayment from it, and until now THREW THE ANSWER AWAY. So the year view could
-- say the months before go-live were never billed here, but not which of them a family had actually
-- settled and which they were behind on, which is the thing an office wants to see.
--
-- This is a RECORD OF AN ANSWER, not a setting and not a balance. Nothing reads it to decide what to
-- bill: the money still lives entirely in the carry-in invoice and the carry-in payment, exactly as
-- CLAUDE.md §9 requires ("a mid-year start is a ledger artifact, never a setting"). One row per child,
-- written once alongside the artifact, so it cannot drift from it.
--
-- ON DELETE CASCADE, unlike the money paths: this is a note about a child, so it goes when they do.
-- A pure CREATE TABLE — nothing to backfill. An install that already ran the wizard has no rows, and
-- its year view keeps showing those months as simply "before you started billing here", which is all
-- anybody ever knew about them.
CREATE TABLE `carry_ins` (
	`student_id` text PRIMARY KEY NOT NULL REFERENCES `students`(`id`) ON DELETE cascade,
	`go_live_period` text NOT NULL,
	`paid_through` text,
	`kind` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`created_at` integer NOT NULL
);
