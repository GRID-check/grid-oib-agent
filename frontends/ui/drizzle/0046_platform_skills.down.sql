-- Reverse 0046: drop the platform-curated skill catalogue.
--
-- Destructive to the curated skills themselves — their bodies live only here.
-- Organizations lose the offers; their own skills (`skills`) and their
-- activation decisions (`curated_skill_activations`) are untouched, and jobs
-- that attached a curated skill keep running from the snapshot they pinned.

-- The RLS policy goes away before the table does; RLS stays enabled on the
-- table until then, so every step is explicit.
DROP POLICY IF EXISTS grid_tenant_isolation ON platform_skills;

ALTER TABLE platform_skills DISABLE ROW LEVEL SECURITY;

DROP TABLE IF EXISTS platform_skills;
