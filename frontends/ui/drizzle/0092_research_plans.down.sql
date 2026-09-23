-- Reverse 0092: drop the research plans.
--
-- The plan is the record of what a run was asked; the run's own row and its
-- ledger survive this, so dropping the table loses the editable brief, never
-- the work. The run message's `plan_id` metadata then names nothing, which
-- the block reads as „kein Plan".

DROP INDEX IF EXISTS "idx_research_plans_run_id";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_research_plans_organization_id";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_research_plans_project_created";
--> statement-breakpoint
DROP TABLE IF EXISTS "research_plans";
