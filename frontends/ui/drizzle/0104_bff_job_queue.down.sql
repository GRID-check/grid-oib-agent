-- Reverse 0104: drop the BFF job queue.
--
-- Lossy, and the loss is every job still waiting: a reindex or a rescan that
-- had not finished stops where it is. Nothing else refers to these tables, and
-- a document a half-finished job did not reach keeps its old chunks, so the
-- cost of the rollback is a reindex to run again by hand.
DROP TABLE IF EXISTS "bff_job_lane_turns";
--> statement-breakpoint
DROP TABLE IF EXISTS "bff_job_queue";
