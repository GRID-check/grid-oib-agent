-- Precomputed rule inputs, so the Prüfbuch does not re-read the building.
--
-- `compliance` loaded every column of up to 50 000 element rows — the full
-- `properties` and `quantities` jsonb, ~1 199 bytes each, ~60 MB of JSON text.
-- Postgres found the rows in ~450 ms; the remaining ~900 ms of a 1.5 s request
-- was the driver parsing that JSON on the single-threaded event loop, during
-- which the pod served nobody. The catalogue then read thirteen keys and threw
-- the rest away.
--
-- This column holds those thirteen keys per element, pruned at extraction
-- time: ~120 bytes per element instead of ~1 199, arriving as one column of
-- one row. See `lib/bim/rule-inputs.ts` for the shape and the version field
-- that makes a stale projection a miss rather than a wrong verdict.
--
-- Nullable on purpose: models extracted before this migration have none, and
-- the query layer falls back to the full load and writes the projection on the
-- way past. No backfill job — the first reader of each model pays once.
ALTER TABLE bim_models ADD COLUMN IF NOT EXISTS rule_inputs jsonb;

COMMENT ON COLUMN bim_models.rule_inputs IS
  'Pruned per-element inputs for the OIB rule catalogue (lib/bim/rule-inputs.ts). NULL means not yet computed; the compliance query falls back to reading bim_elements and fills it in.';
