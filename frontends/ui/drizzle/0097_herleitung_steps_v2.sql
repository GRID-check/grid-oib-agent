-- 0097: every stored Herleitung step, rewritten once into the chat wire v2 shape.
--
-- ## Why a data migration, and why only this one
--
-- Chat wire v2 (docs/design/chat-wire-v2.md §e.4) replaces the NAT step stream
-- with typed steps, one discriminated union on `kind`. The browser persists what
-- its fold writes, so `messages.metadata->'provenance'->'thinkingSteps'` becomes
-- `{id, userMessageId, timestamp, isComplete, kind, scope?, turnEvent?,
-- traceLanes?, round?, tool?, skill?, slot?, detail?}`. `sanitizeProvenance`
-- accepts only that shape, and no reader branches on an old one. The rows
-- already stored were written under the old shape (`functionName`,
-- `displayName`, `category`, `isTopLevel`, `isDeepResearch`), and the readers
-- that interpreted it by regexing `functionName` are deleted in the same cut.
-- This migration is the one compatibility the cut allows: the old readers'
-- rules, applied once, here, instead of forever at read time.
--
-- ## The rules, in order (first match wins)
--
-- The name is `functionName`, trimmed, with a leading `Tool:` removed, and
-- compared case-insensitively, exactly as the old readers normalised it
-- (`turn-events.ts`, `skill-activity.ts`).
--
--   status:retrieval:<n>             -> retrieval, round n
--   status:<slot>                    -> status, slot
--   skill:<name>                     -> skill, skill = name (no name: dropped)
--   clarifier_agent | clarification -> clarification (`clarifier_agent` is the
--                                       name `clarify.TRACE_STEP_NAME` emitted)
--   a non-empty traceLanes           -> sources, tool = the name
--   skill_selection, <workflow>, chat_deepresearcher_agent,
--   shallow_research_agent, deep_research_agent, unknown (the placeholder
--   the old socket hook synthesised for string content, drawn as
--   "Processing"), any name with '/' (a model id), an empty name
--                                    -> dropped: v2 never produces them, and
--                                       the old UI drew them as nothing or as a
--                                       legacy phrase
--   anything else                    -> tool, tool = the name
--
-- `isDeepResearch: true` becomes `scope: 'deep'`. `turnEvent` and
-- `traceLanes` are kept verbatim; the stored lane shape does not change.
-- `displayName`, `category`, `isTopLevel`, `content` and `rawPayload` go.
--
-- ## Re-runnable, and read-only for everything else
--
-- A step that already has `kind` is v2 and is left untouched, so a re-run (or a
-- row the new build wrote before this ran) changes nothing, and a row whose
-- metadata would not change is not written at all. Only rows whose
-- `thinkingSteps` is an array are touched; every other metadata key, and every
-- other column, stays as it was. A provenance
-- left empty by the drops loses its `thinkingSteps` key rather than keeping `[]`,
-- and an emptied provenance loses the key itself, matching what
-- `sanitizeProvenance` would have written.
--
-- ## RLS
--
-- Untouched, and not in `BOUNDARY_MIGRATIONS`: no table is created, dropped or
-- renamed. It runs as the owner, which row-level security does not restrict
-- (the tables are not FORCEd), so every tenant's rows are rewritten.
--
-- The two helper functions exist only for the length of this migration and are
-- dropped at its end. Verified by `scripts/rls-test-db.sh` against captured
-- rows (`src/lib/conversations/herleitung-steps-v2.migration.spec.ts`).

CREATE OR REPLACE FUNCTION grid_0097_step_v2(step jsonb) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  name text;
  lowered text;
  lanes jsonb;
  out jsonb;
BEGIN
  IF jsonb_typeof(step) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
  IF step ? 'kind' THEN RETURN step; END IF;

  name := regexp_replace(btrim(coalesce(step->>'functionName', '')), '^tool:\s*', '', 'i');
  lowered := lower(name);
  lanes := CASE WHEN jsonb_typeof(step->'traceLanes') = 'array'
                     AND jsonb_array_length(step->'traceLanes') > 0
                THEN step->'traceLanes' END;

  out := jsonb_build_object(
    'id', step->'id',
    'userMessageId', step->'userMessageId',
    'timestamp', coalesce(step->'timestamp', to_jsonb(''::text)),
    'isComplete', to_jsonb(coalesce(step->'isComplete' = 'true'::jsonb, false))
  );

  IF lowered ~ '^status:retrieval:[0-9]+$' THEN
    out := out || jsonb_build_object(
      'kind', 'retrieval',
      'round', substring(lowered FROM '^status:retrieval:([0-9]+)$')::int);
  ELSIF lowered LIKE 'status:_%' THEN
    out := out || jsonb_build_object('kind', 'status', 'slot', substr(name, 8));
  ELSIF lowered LIKE 'skill:%' THEN
    IF btrim(substr(name, 7)) = '' THEN RETURN NULL; END IF;
    out := out || jsonb_build_object('kind', 'skill', 'skill', btrim(substr(name, 7)));
  ELSIF lowered IN ('clarifier_agent', 'clarification') THEN
    out := out || jsonb_build_object('kind', 'clarification');
  ELSIF lanes IS NOT NULL AND name <> '' THEN
    out := out || jsonb_build_object('kind', 'sources', 'tool', name, 'traceLanes', lanes);
  ELSIF name = ''
     OR name LIKE '%/%'
     OR lowered IN ('skill_selection', '<workflow>', 'chat_deepresearcher_agent',
                    'shallow_research_agent', 'deep_research_agent', 'unknown') THEN
    RETURN NULL;
  ELSE
    out := out || jsonb_build_object('kind', 'tool', 'tool', name);
  END IF;

  IF jsonb_typeof(step->'turnEvent') = 'object' THEN
    out := out || jsonb_build_object('turnEvent', step->'turnEvent');
  END IF;
  IF step->'isDeepResearch' = 'true'::jsonb THEN
    out := out || jsonb_build_object('scope', 'deep');
  END IF;
  RETURN out;
END
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_0097_steps_v2(steps jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_agg(converted ORDER BY position), '[]'::jsonb)
    FROM jsonb_array_elements(steps) WITH ORDINALITY AS input(step, position)
    CROSS JOIN LATERAL (SELECT grid_0097_step_v2(input.step) AS converted) AS c
   WHERE converted IS NOT NULL
$$;

--> statement-breakpoint
WITH rewritten AS (
  SELECT id, grid_0097_steps_v2(metadata->'provenance'->'thinkingSteps') AS steps
    FROM "messages"
   WHERE jsonb_typeof(metadata->'provenance'->'thinkingSteps') = 'array'
), placed AS (
  SELECT r.id,
         CASE WHEN jsonb_array_length(r.steps) > 0
              THEN jsonb_set(m.metadata, '{provenance,thinkingSteps}', r.steps)
              ELSE m.metadata #- '{provenance,thinkingSteps}'
         END AS metadata
    FROM rewritten r JOIN "messages" m ON m.id = r.id
)
UPDATE "messages" AS m
   SET metadata = CASE WHEN p.metadata->'provenance' = '{}'::jsonb
                       THEN p.metadata - 'provenance'
                       ELSE p.metadata END
  FROM placed p
 WHERE m.id = p.id
   AND m.metadata IS DISTINCT FROM p.metadata;

--> statement-breakpoint
DROP FUNCTION grid_0097_steps_v2(jsonb);

--> statement-breakpoint
DROP FUNCTION grid_0097_step_v2(jsonb);
