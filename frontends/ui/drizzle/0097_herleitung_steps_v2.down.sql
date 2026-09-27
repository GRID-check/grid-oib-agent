-- Reverse 0097: stored Herleitung steps go back to the pre-v2 shape.
--
-- ORDER: roll the frontend back to the previous image BEFORE running this. The
-- v2 build's `sanitizeProvenance` accepts only the v2 shape and would drop
-- every step this writes.
--
-- What comes back is what the old readers need to render a step: the
-- `functionName` they parsed, rebuilt from `kind` (`status:retrieval:<n>`,
-- `status:<slot>`, `skill:<name>`, `clarifier_agent`, or the tool's name),
-- a `category` as `mapFunctionToCategory` assigned it, an empty
-- `displayName` (the old UI labelled from `functionName` and the dictionary),
-- `isDeepResearch` from `scope`, and `turnEvent`/`traceLanes` verbatim.
--
-- What 0097 dropped (skill_selection, workflow and agent names, model ids) is
-- not restored: nothing recorded it. Steps written by the v2 build are
-- converted too, and lose what the old shape has no field for (`detail`).
-- Steps without `kind` are already in the old shape and are left alone.

CREATE OR REPLACE FUNCTION grid_0097_step_v1(step jsonb) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  kind text := step->>'kind';
  function_name text;
  category text;
  out jsonb;
BEGIN
  IF jsonb_typeof(step) IS DISTINCT FROM 'object' OR kind IS NULL THEN RETURN step; END IF;

  CASE kind
    WHEN 'retrieval' THEN function_name := 'status:retrieval:' || coalesce(step->>'round', '0'); category := 'tasks';
    WHEN 'status' THEN function_name := 'status:' || coalesce(step->>'slot', ''); category := 'tasks';
    WHEN 'skill' THEN function_name := 'skill:' || coalesce(step->>'skill', ''); category := 'tools';
    WHEN 'clarification' THEN function_name := 'clarifier_agent'; category := 'agents';
    ELSE function_name := coalesce(step->>'tool', kind); category := 'agents';
  END CASE;

  out := jsonb_build_object(
    'id', step->'id',
    'userMessageId', step->'userMessageId',
    'functionName', function_name,
    'displayName', '',
    'category', category,
    'timestamp', step->'timestamp',
    'isComplete', coalesce(step->'isComplete', 'false'::jsonb)
  );
  IF step ? 'turnEvent' THEN out := out || jsonb_build_object('turnEvent', step->'turnEvent'); END IF;
  IF step ? 'traceLanes' THEN out := out || jsonb_build_object('traceLanes', step->'traceLanes'); END IF;
  IF step->>'scope' = 'deep' THEN out := out || '{"isDeepResearch": true}'::jsonb; END IF;
  RETURN out;
END
$$;

--> statement-breakpoint
UPDATE "messages"
   SET metadata = jsonb_set(
         metadata,
         '{provenance,thinkingSteps}',
         (SELECT coalesce(jsonb_agg(grid_0097_step_v1(step) ORDER BY position), '[]'::jsonb)
            FROM jsonb_array_elements(metadata->'provenance'->'thinkingSteps')
                 WITH ORDINALITY AS input(step, position)))
 WHERE jsonb_typeof(metadata->'provenance'->'thinkingSteps') = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(metadata->'provenance'->'thinkingSteps') AS s(step)
                WHERE jsonb_typeof(s.step) = 'object' AND s.step ? 'kind');

--> statement-breakpoint
DROP FUNCTION grid_0097_step_v1(jsonb);
