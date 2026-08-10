-- Make the storey index serve the storey filter.
--
-- `bim_elements_model_storey_idx` was `(model_id, storey_name)`, a plain btree
-- over the raw column. Every storey filter the query layer emits is
-- `lower(storey_name) IN (…)` — set and value names come from whichever tool
-- exported the model, so the comparison has to be case-insensitive — and a
-- btree on `storey_name` cannot serve a predicate on `lower(storey_name)`.
-- The index was therefore never used by the only query written against it
-- (`idx_scan = 0`), while still being maintained on every insert.
--
-- The expression index below matches the predicate. The GlobalId half of the
-- filter is handled in `buildBimPredicate` by emitting that arm only for
-- tokens actually shaped like a GlobalId: an unconditional `OR` across two
-- columns is unindexable whatever indexes exist, so adding this one without
-- that change would have left it exactly as dead as its predecessor.
--
-- Grouping (`groupBy: 'storey'`) reads the raw column and loses an index it
-- was not using either: a `GROUP BY` over a whole model is planned as a
-- parallel sequential scan with a hash aggregate regardless (measured at
-- 113 ms for the equivalent `ifc_type` grouping on 200 000 elements).
DROP INDEX IF EXISTS bim_elements_model_storey_idx;

CREATE INDEX IF NOT EXISTS bim_elements_model_storey_idx
  ON bim_elements (model_id, lower(storey_name));
