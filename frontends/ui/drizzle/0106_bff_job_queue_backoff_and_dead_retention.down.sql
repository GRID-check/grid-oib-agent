-- Reverse 0106: bff_job_queue loses its retry backoff and dead-row retention.
--
-- ORDER: roll the bff-jobs pool and the frontend back first; the newer build
-- writes and reads both columns.
--
-- Lossy in one way: a dead row's payload was reduced to identifiers when it went
-- dead and is not restored (nothing runs a dead row, so nothing needs it). A
-- failed job waiting out its backoff is claimable at once.
DROP INDEX IF EXISTS "ix_bff_job_queue_dead_at";
--> statement-breakpoint
ALTER TABLE "bff_job_queue" DROP CONSTRAINT IF EXISTS "bff_job_queue_dead_stamped";
--> statement-breakpoint
ALTER TABLE "bff_job_queue" DROP COLUMN IF EXISTS "dead_at";
--> statement-breakpoint
ALTER TABLE "bff_job_queue" DROP COLUMN IF EXISTS "not_before";
