-- 0073: find a run by the backend job id.
--
-- A worker that reports how a run ended holds the backend async-job id and
-- nothing else (`job_runs.job_id`, which is NOT the parent `schedule_id`). That
-- lookup used to have no index: the table was only ever read by schedule, in
-- creation order, and the outcome path did not exist. Partial, because a run
-- that was skipped or errored at submission never got a backend id and is not
-- something a worker can report on.
CREATE INDEX IF NOT EXISTS "idx_job_runs_backend_job_id" ON "job_runs" ("job_id") WHERE "job_id" IS NOT NULL;
