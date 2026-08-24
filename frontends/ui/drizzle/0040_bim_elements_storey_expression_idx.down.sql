-- Create-then-drop, as in the up migration: this runs inside one transaction,
-- so a leading `DROP INDEX` would keep ACCESS EXCLUSIVE on `bim_elements` from
-- the drop right through the rebuild until COMMIT. Building first costs only
-- SHARE — reads keep working, writes are still blocked for the build — and
-- leaves the exclusive lock to the final drop.
CREATE INDEX IF NOT EXISTS bim_elements_model_storey_idx
  ON bim_elements (model_id, storey_name);

DROP INDEX IF EXISTS bim_elements_model_storey_lower_idx;
