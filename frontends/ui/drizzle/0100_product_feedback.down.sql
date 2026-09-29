-- Reverse 0100: drop product feedback.
--
-- Lossy, and the loss is the whole table: every report every tenant sent goes
-- with it. Export first if the reports should survive the rollback:
--
--   COPY (SELECT * FROM product_feedback) TO '/tmp/product_feedback.csv' CSV HEADER;
--
-- The inbox rows that announced the reports (`feedback.submitted`) go too.
-- They quote the report (reporter, organization, an excerpt of the message),
-- and a newer BFF still running against this schema would keep showing those
-- quotes to platform staff for a report that no longer exists.

DELETE FROM "inbox_items" WHERE "type" = 'feedback.submitted';
--> statement-breakpoint
DROP TABLE IF EXISTS "product_feedback";
