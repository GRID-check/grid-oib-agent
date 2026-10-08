-- Reverse 0116: no period and no people on a project.
--
-- Lossy, and deliberately so: the people of every project are deleted with the
-- table. They are personal data with no other copy to keep in sync, and an
-- older build has no screen that shows or erases them.
DROP TRIGGER IF EXISTS "project_people_closed_project_guard" ON "project_people";
--> statement-breakpoint
DROP TABLE IF EXISTS "project_people";
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_period_check";
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN IF EXISTS "ended_on";
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN IF EXISTS "started_on";
