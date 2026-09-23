-- 0092: the research plan is a row of its own (ADR-0065).
--
-- The gap this closes. A deep research is about a plan — sections, genre,
-- depth, the Unterlagen to read in full and the ones never to use, the
-- Rahmen — and until now that plan lived nowhere: it was prose in an agent
-- message (a fenced JSON block the client stripped) and a chat reply the
-- reader owed before any run could start. It could not be reopened, shown on
-- the task card, listed, or handed to the worker as data; and a reader who
-- wanted a plan of their own had no door to write one.
--
-- What this migration does. One table, project-scoped: the plan as every
-- client reads it, with the lifecycle the run waits on. `status` walks
-- proposed → held → approved → started (or superseded); `starts_at` is the
-- instant a proposed plan may start on its own, NULL when it waits for a
-- person. The run row points back through `run_id` once the plan has been
-- commissioned into one; the run's message carries `plan_id` in its metadata
-- so the block can fetch the plan by id.
--
-- Why jsonb for the lists and not child tables. Sections, the two document
-- lists and the inventory are read and written as one unit by one editor at
-- a time, bounded (12 / 20 / 20 / 200 rows) by the zod contract that is the
-- one definition (`lib/plans/plan-types.ts`); a normalised table per list
-- would be four joins for a card that renders one object. The same choice
-- `task_runs.plan` made.
--
-- Why no FK to task_runs. The plan is created BEFORE the run and outlives it
-- (a carried-forward run supersedes it); a deleted run must not cascade away
-- the record of what was asked. `text` and no constraint, the way
-- `messages.run_id` is.
--
-- RLS. Project-scoped tenant data, secured exactly like task_runs: the
-- organization AND the project's organization.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "research_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" text NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "conversation_id" text,
  "run_id" text,
  "author" text NOT NULL,
  "status" text NOT NULL DEFAULT 'proposed',
  "question" text NOT NULL,
  "title" text NOT NULL,
  "sections" jsonb NOT NULL,
  "genre" text NOT NULL DEFAULT 'bericht',
  "depth" text NOT NULL DEFAULT 'gutachten',
  "grundlage" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "ausgeschlossen" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "data_sources" jsonb,
  "unterlagen" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "starts_at" timestamptz,
  "held_at" timestamptz,
  "approved_at" timestamptz,
  "started_at" timestamptz,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "research_plans_status_known"
    CHECK ("status" IN ('proposed', 'held', 'approved', 'started', 'superseded')),
  CONSTRAINT "research_plans_author_known" CHECK ("author" IN ('agent', 'user')),
  CONSTRAINT "research_plans_genre_known"
    CHECK ("genre" IN ('pruefbericht', 'aktenvermerk', 'vergleich', 'checkliste', 'bericht')),
  CONSTRAINT "research_plans_depth_known" CHECK ("depth" IN ('kurzpruefung', 'gutachten')),
  -- A held plan never has a clock; a proposed one may. The rule the block
  -- relies on when it says „startet gleich" versus „wartet auf Sie".
  CONSTRAINT "research_plans_held_has_no_clock" CHECK ("status" <> 'held' OR "starts_at" IS NULL)
);

--> statement-breakpoint
COMMENT ON TABLE "research_plans" IS
  'A deep research''s plan (ADR-0065): sections, genre, depth, Unterlagen and Rahmen, proposed by the clarifier or written by a person, edited on the run block until the worker starts the run. The run waits on this row''s status.';

--> statement-breakpoint
COMMENT ON COLUMN "research_plans"."run_id" IS
  'The task_runs row this plan was commissioned into. text and no FK on purpose: the plan is created before the run and outlives it.';

--> statement-breakpoint
COMMENT ON COLUMN "research_plans"."starts_at" IS
  'When a proposed plan may start on its own (created + the clarifier''s grace). NULL while it waits for a person: a held plan, or a deployment that asks first.';

--> statement-breakpoint
COMMENT ON COLUMN "research_plans"."unterlagen" IS
  'The inventory the plan was drafted against, so the picker can only name a document this project could find. Bounded to 200 rows by the contract.';

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_research_plans_project_created"
  ON "research_plans" ("project_id", "created_at");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_research_plans_organization_id"
  ON "research_plans" ("organization_id");

--> statement-breakpoint
-- Partial: the worker looks a plan up by the run it belongs to, and only a
-- minority of plans have been commissioned when the index is consulted.
-- Drizzle's index builder cannot express a partial index, so it lives only here.
CREATE INDEX IF NOT EXISTS "idx_research_plans_run_id"
  ON "research_plans" ("run_id")
  WHERE "run_id" IS NOT NULL;

--> statement-breakpoint
SELECT grid_secure_table('research_plans',
  'organization_id = grid_current_org() AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.organization_id = grid_current_org())');
