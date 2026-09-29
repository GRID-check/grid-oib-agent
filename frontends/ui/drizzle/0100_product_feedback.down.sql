-- Reverse 0100: drop product feedback.
--
-- Lossy, and the loss is the whole table: every report every tenant sent goes
-- with it. Export first if the reports should survive the rollback:
--
--   COPY (SELECT * FROM product_feedback) TO '/tmp/product_feedback.csv' CSV HEADER;
--
-- The inbox rows that announced the reports (`feedback.submitted`) stay behind
-- and render redacted, because their target no longer resolves; the retention
-- prune removes them.

DROP TABLE IF EXISTS "product_feedback";
