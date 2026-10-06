-- 0102: bff_job_queue — durable, fair background work for the BFF (ADR-0078).
--
-- ## Why
--
-- A project reindex and "rescan failed ingestions" walked up to ten thousand
-- documents inside one HTTP request. A request that died half way left no
-- record of which half. Each now becomes a job: one row here, claimed by the
-- `bff-jobs` pool, resumable from the progress it keeps in `payload`.
--
-- The claim is ADR-0076's, in the same order the Python queues use: the lane
-- (an organization) with the fewest live claims, then the lane served longest
-- ago (`bff_job_lane_turns`), then inside a lane priority (0 interactive, 1
-- bulk), then oldest. `workers/job-queue.js` holds the SQL.
--
-- ## Dead rows, not deleted rows
--
-- A claim that died `max_attempts` times becomes status = 'dead' with its
-- reason in `last_error`; nothing DELETEs it. A finished job is the only row
-- that is deleted. KEDA counts every row that is not dead.
--
-- ## kind
--
-- Shape-checked only. The kinds a worker knows live in code
-- (`lib/jobs-queue/types.ts`), so a new kind is a code change, not a migration.
--
-- ## RLS
--
-- The lane IS the organization id, so both tables are tenant tables with the
-- predicate on `lane`: a request enqueues and reads only its own organization's
-- jobs. The `bff-jobs` runner is cross-tenant by nature and steps up to the
-- platform role per transaction (`workers/platform-scope.js`), exactly as the
-- purger and the scheduler do. Listed in `rls-coverage.spec.ts`
-- BOUNDARY_MIGRATIONS.

CREATE TABLE IF NOT EXISTS "bff_job_queue" (
  "job_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "lane" text NOT NULL,
  "priority" smallint DEFAULT 0 NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "claimed_by" text,
  "claimed_at" timestamp with time zone,
  "heartbeat_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_error" text,
  CONSTRAINT "bff_job_queue_status" CHECK ("status" IN ('queued', 'claimed', 'dead')),
  CONSTRAINT "bff_job_queue_priority" CHECK ("priority" IN (0, 1)),
  CONSTRAINT "bff_job_queue_kind_shape" CHECK ("kind" ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- A claimed row always says who holds it and since when; the heartbeat is
  -- what the stale test reads, so a claim without one could never be reclaimed.
  CONSTRAINT "bff_job_queue_claim_attributed"
    CHECK ("status" <> 'claimed' OR ("claimed_by" IS NOT NULL AND "heartbeat_at" IS NOT NULL))
);
--> statement-breakpoint
-- The claim's second step: the best runnable job of one lane, in order.
CREATE INDEX IF NOT EXISTS "ix_bff_job_queue_lane_order"
  ON "bff_job_queue" ("lane", "priority", "created_at") WHERE "status" <> 'dead';
--> statement-breakpoint
-- The reaper and the stale-claim test read claimed rows by heartbeat.
CREATE INDEX IF NOT EXISTS "ix_bff_job_queue_claimed_heartbeat"
  ON "bff_job_queue" ("heartbeat_at") WHERE "status" = 'claimed';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bff_job_lane_turns" (
  "lane" text PRIMARY KEY NOT NULL,
  "last_claimed_at" timestamp with time zone
);
--> statement-breakpoint
SELECT grid_secure_table('bff_job_queue',      'lane = grid_current_org()');
--> statement-breakpoint
SELECT grid_secure_table('bff_job_lane_turns', 'lane = grid_current_org()');
