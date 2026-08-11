-- Drop the Workflows tables. Agent Skills (ADR-0046, migration 0041) replaces
-- the feature outright: `skills` / `skill_schedules` / `skill_runs` carry the
-- same responsibilities, and no application code references these three tables
-- any more.
--
-- Dropping is safe rather than merely tidy. Workflows never shipped enabled:
-- it sat behind a dark-launch gate (`GRID_WORKFLOWS_ENABLED`, default off) that
-- no deployment turned on, so these tables are empty everywhere. Leaving them
-- would leave three tables inside the RLS boundary (0031 secured them) with
-- nothing owning them — policies to maintain, a schema to explain, and a
-- standing invitation to write to a table the product no longer reads.
--
-- Order matters: `workflow_runs` has an FK to `workflows`. CASCADE would do it
-- in one statement, but naming the dependent table first keeps the drop honest
-- about what it removes — a CASCADE that silently took an unexpected dependent
-- with it is exactly what a review would not catch.
--
-- The policies and indexes go with their tables; Postgres drops both.
DROP TABLE IF EXISTS "workflow_runs";
--> statement-breakpoint
DROP TABLE IF EXISTS "workflows";
--> statement-breakpoint
-- Global (non-tenant) table from ADR-0027: the platform-published workflow
-- template catalogue, secured by 0031 via grid_secure_platform_table.
DROP TABLE IF EXISTS "platform_workflow_templates";
