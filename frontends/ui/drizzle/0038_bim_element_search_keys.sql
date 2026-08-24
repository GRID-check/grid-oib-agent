-- An indexable shadow of `properties` and `quantities`.
--
-- Every property predicate is a correlated
-- `EXISTS (jsonb_each(properties) … jsonb_each(set_value) …)` with `lower()`
-- on both sides, because set and property NAMES come from whichever tool
-- exported the model and have to match case-insensitively. Nothing can index
-- that, so a filtered element query unnests every row of the model. Measured
-- on a seeded 400 000-element model at the production `work_mem` of 4 MB:
-- 7 406 ms for a 25-row page, and 15 767 ms (warm) / 21 904 ms (cold) for the
-- COUNT half beside it, which cannot stop early. Two of ten pool slots held
-- for ~16-22 s; five such queries saturate a pod.
--
-- `search_keys` is a FLAT, lowercased map of what those predicates look up:
--
--   {"p:firerating": ["rei 90"],
--    "p:pset_wallcommon.firerating": ["rei 90"],
--    "q:width": ["0.9"]}
--
-- `p:` and `q:` separate properties from quantities (a filter names one or the
-- other); the bare key answers "any set", the dotted key answers a
-- set-qualified filter. Values are arrays because two sets can carry the same
-- property name.
--
-- The default `jsonb_ops` operator class, NOT `jsonb_path_ops`: this index has
-- to serve key-existence (`?`) as well as containment (`@>`), and
-- `jsonb_path_ops` supports only the latter. That is the mistake `0034` made
-- and `0036` cleaned up.
--
-- It is used as a NECESSARY pre-filter, never as the answer: the exact unnest
-- predicate still decides, so an `search_keys` carrying a key it should not
-- can only cost speed, never correctness. See `buildBimPredicate` in
-- `lib/bim/query.ts`.
--
-- The other direction — a MISSING key — is not survivable, because the
-- pre-filter is AND-ed in and would drop rows the exact predicate matches.
-- `bim_models.search_keys_indexed` below is what makes that impossible rather
-- than unlikely.
ALTER TABLE bim_elements ADD COLUMN IF NOT EXISTS search_keys jsonb;

-- Whether every element of THIS model has its `search_keys` written.
--
-- The obvious way to be safe about a half-populated column is to write the
-- pre-filter as `search_keys IS NULL OR search_keys @> …`, so an unindexed row
-- falls through. Measured, that is the worst of both: `IS NULL` is not GIN-
-- indexable, so the disjunction cannot use the index AT ALL and every query
-- keeps the old plan. On a seeded 200 000-element model, a filter matching one
-- element took 2 934 ms with the OR and 4 ms without it.
--
-- So the fallback moves up a level: the flag says whether the pre-filter may
-- be used for this model, and `lib/bim/query.ts` omits it entirely when the
-- flag is false. DEFAULT false matters during a rolling deploy — a pod running
-- the previous image inserts elements without `search_keys` and, having never
-- heard of this column, leaves the flag false. That model is answered by the
-- unnest alone: slow, and right.
ALTER TABLE bim_models ADD COLUMN IF NOT EXISTS search_keys_indexed boolean NOT NULL DEFAULT false;

-- Backfill from the jsonb already stored, set-based. `bim_elements` is capped
-- at 200 000 rows per model by `BIM_ELEMENT_LIMIT`, so this is bounded work.
--
-- `#>> '{}'` over a jsonb null yields SQL NULL, and the value list drops it
-- (`FILTER … IS NOT NULL`, defaulting to `[]`) while the KEY is still emitted.
-- Both halves matter and they pull in opposite directions: a null-valued
-- property still EXISTS, so `{operator: 'exists'}` matches it and the key has
-- to be present or the pre-filter deletes a row the exact predicate matched;
-- but no `eq` can ever match it, so putting a literal `"null"` in the value
-- list would make containment claim a match that the predicate refuses.
-- `buildSearchKeys` in `lib/bim/rule-inputs.ts` does exactly the same, and
-- `query.integration.spec.ts` runs the two against each other.
WITH flattened AS (
  SELECT
    e.id,
    jsonb_object_agg(f.key, f.values) AS keys
  FROM bim_elements e
  CROSS JOIN LATERAL (
    SELECT
      f.key,
      coalesce(
        jsonb_agg(DISTINCT to_jsonb(f.value)) FILTER (WHERE f.value IS NOT NULL),
        '[]'::jsonb
      ) AS values
    FROM (
      SELECT 'p:' || lower(p.prop_name) AS key, lower(p.prop_value #>> '{}') AS value
      FROM jsonb_each(e.properties) AS s(set_name, set_value),
           jsonb_each(s.set_value) AS p(prop_name, prop_value)
      UNION ALL
      SELECT 'p:' || lower(s.set_name) || '.' || lower(p.prop_name), lower(p.prop_value #>> '{}')
      FROM jsonb_each(e.properties) AS s(set_name, set_value),
           jsonb_each(s.set_value) AS p(prop_name, prop_value)
      UNION ALL
      SELECT 'q:' || lower(p.prop_name), lower(p.prop_value #>> '{}')
      FROM jsonb_each(e.quantities) AS s(set_name, set_value),
           jsonb_each(s.set_value) AS p(prop_name, prop_value)
      UNION ALL
      SELECT 'q:' || lower(s.set_name) || '.' || lower(p.prop_name), lower(p.prop_value #>> '{}')
      FROM jsonb_each(e.quantities) AS s(set_name, set_value),
           jsonb_each(s.set_value) AS p(prop_name, prop_value)
    ) f
    GROUP BY f.key
  ) f
  WHERE e.search_keys IS NULL
  GROUP BY e.id
)
UPDATE bim_elements e
SET search_keys = flattened.keys
FROM flattened
WHERE e.id = flattened.id;

-- Elements that carry no properties at all get `{}` rather than NULL, so the
-- pre-filter can tell "indexed and has nothing" from "not indexed yet".
UPDATE bim_elements SET search_keys = '{}'::jsonb WHERE search_keys IS NULL;

CREATE INDEX IF NOT EXISTS bim_elements_search_keys_idx
  ON bim_elements USING gin (search_keys jsonb_ops);

-- Every model that existed before this migration is now fully indexed by the
-- two statements above, so the pre-filter is safe on all of them. Written after
-- the backfill, never before: a crash between the two leaves the flag false,
-- which is the slow-but-correct state.
UPDATE bim_models SET search_keys_indexed = true WHERE search_keys_indexed = false;

COMMENT ON COLUMN bim_elements.search_keys IS
  'Flat lowercased map of property/quantity lookups (p:name, p:set.name, q:name, q:set.name) for the GIN pre-filter in lib/bim/query.ts. Trustworthy only when bim_models.search_keys_indexed is true.';

COMMENT ON COLUMN bim_models.search_keys_indexed IS
  'True when every element of this model has bim_elements.search_keys written. lib/bim/query.ts adds the GIN pre-filter only for these models; false falls back to the unnest alone.';
