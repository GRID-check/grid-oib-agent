-- Down for 0073. An index only; dropping it slows the outcome lookup and loses nothing.
DROP INDEX IF EXISTS "idx_job_runs_backend_job_id";
