-- Let the element list stop reading once it has a page.
--
-- `bim_elements_model_type_idx` was `(model_id, ifc_type)`, and every element
-- page orders by `(ifc_type, express_id)`. The index therefore delivered the
-- first ordering column and not the second, so a page could only be produced
-- by reading a whole `ifc_type` group and sorting it — with a correlated
-- `EXISTS (jsonb_each(properties) …)` in the WHERE, that means unnesting tens
-- of thousands of elements to return twenty-five.
--
-- Adding `express_id` makes the index satisfy the ORDER BY outright, so the
-- scan stops at the twenty-fifth match. Measured on a seeded 200 000-element
-- model, a filter matching a quarter of it:
--
--   (model_id, ifc_type)               1 277 ms   Index Scan + Incremental Sort
--   (model_id, ifc_type, express_id)       3 ms   Index Scan, no sort, early exit
--
-- The two-column prefix still serves everything the old index served — type
-- counts, type filters — so nothing loses an index by this.
--
-- This is one half of a pair. The other is `search_keys` (0038), which is the
-- fast plan for the OPPOSITE case: a filter matching a handful of elements,
-- where an ordered walk would read the whole model before finding them. Which
-- of the two a given query wants is decided in `listBimElements`, because
-- Postgres cannot decide it — jsonb containment has no statistics, so `@>` is
-- costed at a hardcoded 0.5 % selectivity no matter what the model holds.
DROP INDEX IF EXISTS bim_elements_model_type_idx;

CREATE INDEX IF NOT EXISTS bim_elements_model_type_idx
  ON bim_elements (model_id, ifc_type, express_id);
