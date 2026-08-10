-- Same create-then-drop ordering as the up migration, and for the same reason:
-- inside the one transaction `drizzle-kit migrate` wraps this in, a leading
-- `DROP INDEX` would hold ACCESS EXCLUSIVE on `bim_elements` until COMMIT and
-- so for the whole rebuild behind it. Built first, the two-column index costs
-- only SHARE — reads keep working, writes do not — and the exclusive lock is
-- confined to the drop at the end.
CREATE INDEX IF NOT EXISTS bim_elements_model_type_idx
  ON bim_elements (model_id, ifc_type);

DROP INDEX IF EXISTS bim_elements_model_type_express_idx;
