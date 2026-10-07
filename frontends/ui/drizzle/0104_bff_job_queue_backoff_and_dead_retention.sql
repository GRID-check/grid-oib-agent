-- 0104: bff_job_queue gets a retry backoff and a retention for dead rows (ADR-0078).
--
-- ## Why
--
-- A failed attempt was queued again at once, so three attempts could burn in
-- the seconds one transient fault lasted. `not_before` is when a failed job may
-- be claimed again (the claim skips a row until then); `fail` doubles it per
-- attempt.
--
-- A dead row kept its whole payload for ever: a research report, the
-- requester's email and permissions, storage keys. The Python queues blank a
-- dead row's payload and delete it after a retention; this does the same.
-- `dead_at` is when the row went dead, which the retention counts from, and the
-- payload of a dead row is reduced to the identifiers a sweep still matches a
-- job by (`runId`, `projectId`, `documentId`, `taskRunId`) -- the same list
-- as `KEPT_PAYLOAD_KEYS` in `workers/job-queue.js`.
--
-- ## Existing dead rows
--
-- Stamped dead now (their real time was never kept, so the retention starts
-- here) and scrubbed in place. Runs as the table owner, which row-level
-- security does not bind.
--
-- ## The ratchet
--
-- A CHECK says a dead row has a `dead_at`, so a path that marks a row dead
-- without stamping it (and so without ever letting the retention reach it) is
-- refused by the database, not found by a reviewer.

ALTER TABLE "bff_job_queue" ADD COLUMN IF NOT EXISTS "not_before" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "bff_job_queue" ADD COLUMN IF NOT EXISTS "dead_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "bff_job_queue"
   SET "dead_at" = now(),
       "payload" = (
         SELECT COALESCE(jsonb_object_agg(kept.key, kept.value), '{}'::jsonb)
           FROM jsonb_each(CASE WHEN jsonb_typeof("payload") = 'object' THEN "payload" ELSE '{}'::jsonb END) AS kept
          WHERE kept.key IN ('runId', 'projectId', 'documentId', 'taskRunId')
       )
 WHERE "status" = 'dead';
--> statement-breakpoint
ALTER TABLE "bff_job_queue" DROP CONSTRAINT IF EXISTS "bff_job_queue_dead_stamped";
--> statement-breakpoint
ALTER TABLE "bff_job_queue"
  ADD CONSTRAINT "bff_job_queue_dead_stamped" CHECK ("status" <> 'dead' OR "dead_at" IS NOT NULL);
--> statement-breakpoint
-- The retention purge's read: the dead rows, oldest first. Partial, so it is as
-- small as the dead set and costs nothing while there are none.
CREATE INDEX IF NOT EXISTS "ix_bff_job_queue_dead_at"
  ON "bff_job_queue" ("dead_at") WHERE "status" = 'dead';
