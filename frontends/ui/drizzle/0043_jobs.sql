-- Jobs — "skill schedules" become first-class jobs.
--
-- ## What changes conceptually
--
-- A job is a PROMPT on a timer. It fires into a fresh run the way a person
-- opening a new chat and typing would. A skill MAY be attached on top, exactly
-- as typing `/name` before the message would attach it — that is the whole
-- relationship, and a skill knows nothing about time.
--
-- 0041 had it the other way round: a schedule existed only to fire one named
-- skill, so the skill was mandatory and the prompt was derived from it. That
-- made "I want this question asked every Monday" unexpressible without first
-- inventing a skill for it, and it put a scheduling concern (`grid-schedulable`)
-- and an output concern (`grid-execution`) into skill metadata, where neither
-- belongs. Both keys leave the skill; the output choice lands here as
-- `jobs.output`.
--
-- ## Rename, do not recreate
--
-- Every row already scheduled keeps running with the same id, the same cron and
-- the same attached skill: existing jobs are the sub-case "prompt + skill", and
-- `prompt` is synthesised from the pinned snapshot so behaviour is unchanged.
-- A CREATE/COPY/DROP would have thrown away the ids that `skill_runs` and the
-- scheduler's claim already reference for no gain.
--
-- ## Renaming a table renames almost nothing else
--
-- `ALTER TABLE ... RENAME TO` moves the table and takes its data, policies,
-- grants and indexes with it — but it does NOT rename those indexes, its
-- primary key, or its foreign keys. Left alone they keep the 0041 names
-- forever, which means the drizzle schema (which declares index names) and the
-- database disagree, and the next person reading `\d jobs` sees a table that
-- still calls itself skill_schedules in every constraint. So every dependent
-- object is renamed explicitly below.
--
-- ## Locks
--
-- Renames are catalog-only and instant. The two scans are `SET NOT NULL` on the
-- freshly backfilled `jobs.prompt` and the FK validation on
-- `job_runs.conversation_id`; both tables are small (one row per schedule, one
-- row per fire) so this runs in well under a second. One transaction, so it
-- cannot half-apply.

-- ---------------------------------------------------------------------------
-- 1. The tables
-- ---------------------------------------------------------------------------
ALTER TABLE "skill_schedules" RENAME TO "jobs";
--> statement-breakpoint
ALTER TABLE "skill_runs" RENAME TO "job_runs";

-- ---------------------------------------------------------------------------
-- 2. Their indexes and constraints, which the rename above left behind
-- ---------------------------------------------------------------------------
--> statement-breakpoint
ALTER INDEX "idx_skill_schedules_project_id" RENAME TO "idx_jobs_project_id";
--> statement-breakpoint
ALTER INDEX "idx_skill_schedules_organization_id" RENAME TO "idx_jobs_organization_id";
--> statement-breakpoint
-- The partial due-scan index (WHERE schedule_cron IS NOT NULL AND enabled) that
-- backs the scheduler's FOR UPDATE SKIP LOCKED claim. Partial, so drizzle's
-- builder cannot express it and it lives only in migrations — see the NOTE in
-- schema/jobs.ts.
ALTER INDEX "idx_skill_schedules_due" RENAME TO "idx_jobs_due";
--> statement-breakpoint
ALTER INDEX "idx_skill_runs_schedule_created" RENAME TO "idx_job_runs_job_created";
--> statement-breakpoint
ALTER INDEX "idx_skill_runs_project_id" RENAME TO "idx_job_runs_project_id";
--> statement-breakpoint
ALTER INDEX "idx_skill_runs_organization_id" RENAME TO "idx_job_runs_organization_id";
--> statement-breakpoint
ALTER INDEX "idx_skill_runs_created_at" RENAME TO "idx_job_runs_created_at";
--> statement-breakpoint
ALTER TABLE "jobs" RENAME CONSTRAINT "skill_schedules_pkey" TO "jobs_pkey";
--> statement-breakpoint
ALTER TABLE "jobs" RENAME CONSTRAINT "skill_schedules_project_id_fkey" TO "jobs_project_id_fkey";
--> statement-breakpoint
ALTER TABLE "job_runs" RENAME CONSTRAINT "skill_runs_pkey" TO "job_runs_pkey";
--> statement-breakpoint
-- Named after the COLUMN it is on (`schedule_id`), which is the Postgres
-- default and the only name that does not mislead: `job_runs.job_id` is the
-- unrelated backend async-job id, so a constraint called `job_runs_job_id_fkey`
-- would read as a foreign key on that column. See the column comments in
-- section 8.
ALTER TABLE "job_runs" RENAME CONSTRAINT "skill_runs_schedule_id_fkey" TO "job_runs_schedule_id_fkey";

-- ---------------------------------------------------------------------------
-- 3. execution -> output
-- ---------------------------------------------------------------------------
-- Same 'chat' | 'deep-research' domain and the same job at fire time (it picks
-- the agent). Only the source of the value changes: it is now the user's
-- choice on the job rather than a denormalised copy of the skill's
-- `grid-execution` metadata key, which no longer exists. "Output" is what the
-- user is actually choosing — a conversation they can continue, or a report.
--> statement-breakpoint
ALTER TABLE "jobs" RENAME COLUMN "execution" TO "output";

-- ---------------------------------------------------------------------------
-- 4. prompt — the thing a job now IS
-- ---------------------------------------------------------------------------
-- Added nullable, backfilled, then made NOT NULL: a NOT NULL column cannot be
-- added to a populated table without a default, and a default here would be a
-- lie that survives into every future row.
--
-- The backfill synthesises the prompt from the pinned snapshot, which is
-- exactly what the fire path used to send, so nothing already scheduled changes
-- behaviour. The snapshot stays attached as well — an existing row becomes the
-- "prompt + skill" sub-case rather than losing its skill.
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "prompt" text;
--> statement-breakpoint
-- COALESCE, not a bare `->> 'body'`: `skill_snapshot` is jsonb and nothing in
-- the database guarantees the key is present or non-empty (0041 only required
-- the snapshot object itself). One malformed row would otherwise fail the
-- SET NOT NULL below and abort the whole migration. Falling back to the job's
-- own name keeps such a row runnable and obviously in need of an edit.
UPDATE "jobs"
   SET "prompt" = COALESCE(
         NULLIF(btrim("skill_snapshot" ->> 'body'), ''),
         NULLIF(btrim("skill_name"), ''),
         NULLIF(btrim("name"), ''),
         'Run the attached skill.'
       )
 WHERE "prompt" IS NULL;
--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "prompt" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. The skill becomes optional
-- ---------------------------------------------------------------------------
-- This is the whole point of the change: a job with no skill is a plain
-- scheduled prompt, which is the common case the old shape could not express.
--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "skill_name" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "skill_snapshot" DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 6. ...but it is optional as a PAIR
-- ---------------------------------------------------------------------------
-- The snapshot is the deterministic WYSIWYG copy the run actually uses; the
-- name is what the UI shows. A row with one and not the other is unrunnable
-- (a name with no body) or unattributable (a body from nowhere), and there is
-- no code path that should produce it. Enforced here rather than in the BFF
-- because the invariant is about the row, not about one writer of it.
--> statement-breakpoint
ALTER TABLE "jobs"
  ADD CONSTRAINT "jobs_skill_pair_check"
  CHECK (("skill_name" IS NULL) = ("skill_snapshot" IS NULL));

-- ---------------------------------------------------------------------------
-- 7. job_runs.conversation_id — where a finished chat-output run landed
-- ---------------------------------------------------------------------------
-- output='chat' materialises the finished run into a real conversation the user
-- can open and continue; this is the link to it. NULL for deep-research runs
-- (they produce a report, not a conversation), for skipped/error runs, and for
-- every row that predates this column.
--
-- text, not uuid: `conversations.id` is text (the backend mints the id).
--
-- Composite FK following the house pattern from 0032_messages_organization_id:
-- referencing `conversations (id, organization_id)` rather than `id` alone makes
-- Postgres refuse a run pointing at another tenant's conversation, so the
-- denormalised organization_id on this table cannot disagree with the
-- conversation it names. Verified the prerequisite before writing it: 0032
-- added `conversations_id_organization_id_key UNIQUE (id, organization_id)`,
-- which is the unique constraint a composite FK needs as its target.
--
-- ON DELETE SET NULL scoped to the one column (Postgres 15+ syntax; we run 16
-- locally and 17 in production): deleting a conversation must not delete run
-- history, and an unscoped SET NULL would try to null `organization_id` too and
-- fail its NOT NULL. The run survives, having forgotten where it landed.
--
-- The FK is MATCH SIMPLE (the default), so a NULL conversation_id switches the
-- check off entirely — which is what makes the nullable column workable.
--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "conversation_id" text;
--> statement-breakpoint
ALTER TABLE "job_runs"
  ADD CONSTRAINT "job_runs_conversation_id_organization_id_fkey"
  FOREIGN KEY ("conversation_id", "organization_id")
  REFERENCES "conversations" ("id", "organization_id")
  ON DELETE SET NULL ("conversation_id");

-- ---------------------------------------------------------------------------
-- 8. Why schedule_id is NOT renamed to job_id
-- ---------------------------------------------------------------------------
-- Everywhere else in this migration "schedule" became "job", and the obvious
-- next step would be `job_runs.schedule_id` -> `job_runs.job_id`. It is not
-- available: `job_runs` ALREADY has a `job_id`, and it means something else
-- entirely — the backend async-job id returned when the run was submitted.
-- Two unrelated ids, one name, and the parent FK would silently look like it
-- pointed at the backend job. So the parent link keeps the 0041 name.
--
-- Recorded in the catalog, not just in this file, because the next reader is
-- far more likely to be looking at `\d+ job_runs` than at migration history.
--> statement-breakpoint
COMMENT ON COLUMN "job_runs"."schedule_id" IS
  'FK to jobs.id — the job this run belongs to. NOT renamed to job_id in 0043 because job_id on this table is the unrelated backend async-job id.';
--> statement-breakpoint
COMMENT ON COLUMN "job_runs"."job_id" IS
  'Backend async-job id for the submitted run (NULL when skipped/error). NOT a reference to jobs.id — that is schedule_id.';
--> statement-breakpoint
COMMENT ON COLUMN "job_runs"."conversation_id" IS
  'Conversation a finished output=chat run was materialised into; NULL for deep-research, skipped/error, and pre-0043 runs.';
--> statement-breakpoint
COMMENT ON COLUMN "jobs"."prompt" IS
  'The scheduled prompt. Fires as if typed into a new chat; the attached skill body, when there is one, is appended by the shared prompt builder.';

-- ---------------------------------------------------------------------------
-- 9. Re-join the tenant boundary under the new names (ADR-0041)
-- ---------------------------------------------------------------------------
-- A rename carries the policy object along, so the tables are never
-- unprotected for an instant. Re-emitting the rules anyway is not belt-and-
-- braces:
--
--   * `job_runs`' predicate names its parent table in an EXISTS subquery. The
--     stored form of that policy was written against `skill_schedules`, and
--     nothing about a table rename is a good reason to trust that the recorded
--     predicate and this migration history still say the same thing. Stating it
--     once, here, is what makes them provably identical.
--   * `rls-coverage.spec.ts` reads these calls as the definition of "inside the
--     boundary". Without them `jobs` and `job_runs` are tables the drizzle
--     schema declares and no migration secures, which is precisely the failure
--     that spec exists to catch.
--
-- `grid_secure_table` drops the old policy before creating the new one, so this
-- replaces rather than adds — two permissive policies would OR together.
--> statement-breakpoint
SELECT grid_secure_table('jobs',
  'organization_id = grid_current_org() AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.organization_id = grid_current_org())');
--> statement-breakpoint
SELECT grid_secure_table('job_runs',
  'organization_id = grid_current_org() AND EXISTS (SELECT 1 FROM jobs j WHERE j.id = schedule_id AND j.organization_id = grid_current_org())');
