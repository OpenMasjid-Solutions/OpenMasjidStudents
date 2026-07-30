-- Bills become itemised: money attaches to a LINE of an invoice, not just to the invoice.
--
-- `payment_allocations.invoice_item_id` says which line a payment covered — the tuition or the book
-- fee. NULL means "the invoice as a whole", which is every row written before this migration, and
-- billing/lines.ts reads it exactly that way (spread over the lines in order), so there is nothing to
-- backfill and no window where a balance is wrong.
--
-- `payments.directed` stores the payer's own instruction ("this $50 is the book fee") as JSON, taken
-- once when the payment is recorded and re-honoured by every later reallocation. Without somewhere to
-- keep it, the next recompute would move the money to the oldest bill and the line the parent chose
-- would read as unpaid again.
--
-- Both are plain ADD COLUMNs with no foreign key and no default, so SQLite appends them in place: no
-- table rebuild on a populated money table (see 0029 for what a rebuild costs, and db/index.ts for
-- why the pragma in that file was not what made it survive).
ALTER TABLE `payment_allocations` ADD `invoice_item_id` text;--> statement-breakpoint
ALTER TABLE `payments` ADD `directed` text;
