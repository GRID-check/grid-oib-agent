-- Back to one confirmation per (organization, project, rule).
--
-- The narrower constraint cannot be restored while rows violate it, and after
-- 0045 they legitimately can: two buildings in one project, or two revisions of
-- one building, each holding their own verdict on the same rule. So the older
-- rows have to go first, and "older" is the honest choice — the most recent
-- confirmation per (organization, project, rule) is the one the pre-0045 schema
-- would have been holding, because its upsert overwrote in place.
--
-- This DISCARDS signatures. That is what rolling this back means, and it is
-- stated here rather than discovered.

DELETE FROM "bim_check_confirmations" a
USING "bim_check_confirmations" b
WHERE a.organization_id = b.organization_id
  AND a.project_id = b.project_id
  AND a.rule_id = b.rule_id
  AND (a.updated_at, a.id) < (b.updated_at, b.id);
--> statement-breakpoint
ALTER TABLE "bim_check_confirmations"
  DROP CONSTRAINT IF EXISTS "bim_check_confirmations_unique";
--> statement-breakpoint
ALTER TABLE "bim_check_confirmations"
  ADD CONSTRAINT "bim_check_confirmations_unique"
  UNIQUE ("organization_id", "project_id", "rule_id");
