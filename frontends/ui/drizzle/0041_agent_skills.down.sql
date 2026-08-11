-- Reverse 0034: drop the Agent Skills tables.
--
-- NOT destructive beyond the feature's own data: skills, schedules and their
-- run history are the sole contents of these tables, and the feature is
-- dark-launched (GRID_SKILLS_ENABLED), so no other surface depends on them.

-- The RLS policy goes away before the table does. RLS itself stays enabled
-- on the table until then; dropping the policy first and then the table keeps
-- every step explicit.
DROP POLICY IF EXISTS grid_tenant_isolation ON skill_runs;
DROP POLICY IF EXISTS grid_tenant_isolation ON skill_schedules;
DROP POLICY IF EXISTS grid_tenant_isolation ON skills;

ALTER TABLE skill_runs DISABLE ROW LEVEL SECURITY;
ALTER TABLE skill_schedules DISABLE ROW LEVEL SECURITY;
ALTER TABLE skills DISABLE ROW LEVEL SECURITY;

-- CASCADE is deliberate: dropping the parent schedule table must take its run
-- history with it (ON DELETE CASCADE in the schema), and the plain DROP of
-- skill_runs first is only for the policy ordering above.
DROP TABLE IF EXISTS skill_schedules;
DROP TABLE IF EXISTS skills;
DROP TABLE IF EXISTS skill_runs;
