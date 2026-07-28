-- Students get ONE name field. A madrasa's families do not all split into a western
-- first/last pair — many names carry a nasab or a compound given name that the office was
-- forced to chop in half to fit the form. `full_name` is what the office actually types.
--
-- Nothing is thrown away: the existing two columns are joined back together here, so an
-- install that upgrades keeps every name exactly as it reads today. The next migration drops
-- the old columns once this one has populated their replacement.
ALTER TABLE `students` ADD `full_name` text;--> statement-breakpoint
UPDATE `students`
   SET `full_name` = trim(coalesce(`first_name`, '') || ' ' || coalesce(`last_name`, ''))
 WHERE `full_name` IS NULL;
