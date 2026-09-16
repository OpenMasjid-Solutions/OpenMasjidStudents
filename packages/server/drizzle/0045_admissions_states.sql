-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 OpenMasjid-Solutions

-- THE PIPELINE LOSES THREE STATES (0.52.0-dev.11, CLAUDE.md §4a Phase 2).
--
-- `reviewing` and `offered` described a conversation this app never witnesses — a phone call, an
-- interview — so they were bookkeeping an office had to maintain for its own sake, and a pipeline
-- that asks to be groomed stops being used. `withdrawn` and `declined` were two words for the same
-- outcome. What is left is what the office actually does: waitlist, decline, start an admission.
--
-- The mapping is chosen so nothing an office recorded is lost:
--   reviewing → new        (it means "arrived, not yet decided", which is what `new` means)
--   offered   → admission  (an offer WAS the start of an admission; this is the closest true thing)
--   withdrawn → declined   (both mean "not joining"; the office's own reason text survives on the row)
--
-- `inquiry_events` IS DELIBERATELY NOT REWRITTEN. The trail records what actually happened, and
-- editing history so it matches a later vocabulary is how a trail stops being evidence. Those rows
-- keep saying `reviewing` and `offered`; `LegacyInquiryState` in db/schema.ts is what still reads
-- them, and the screen has labels for them.

UPDATE inquiries SET state = 'new' WHERE state = 'reviewing';
--> statement-breakpoint
UPDATE inquiries SET state = 'admission' WHERE state = 'offered';
--> statement-breakpoint
UPDATE inquiries SET state = 'declined' WHERE state = 'withdrawn';
