-- Reverses 0030_seed_platform_model_defaults.sql.
--
-- Deletes ONLY the rows this migration wrote, identified by the sentinel actor.
-- A group the platform owner has saved over since carries their user id and
-- survives the rollback — the table is shared state, and a `DELETE FROM` here
-- would silently discard a real fleet-wide decision. Groups that do get removed
-- fall back to the workflow YAML `model_name` again for organizations without
-- an override of their own; per-org overrides are untouched and still win.
DELETE FROM "platform_model_defaults" WHERE "updated_by" = 'system:migration-0030';
