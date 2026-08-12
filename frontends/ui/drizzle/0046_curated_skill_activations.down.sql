-- Reverse 0045: drop the platform-curated skill activation decisions.
--
-- Destructive only to this table's own contents. Every row records whether an
-- organization switched a curated platform skill on; losing them returns every
-- curated skill to its default, which is OFF. No org skill, job or run depends
-- on this table — jobs pin their own skill snapshot at save time.

-- The RLS policy goes away before the table does; RLS stays enabled on the
-- table until then, so every step is explicit.
DROP POLICY IF EXISTS grid_tenant_isolation ON curated_skill_activations;

ALTER TABLE curated_skill_activations DISABLE ROW LEVEL SECURITY;

DROP TABLE IF EXISTS curated_skill_activations;
