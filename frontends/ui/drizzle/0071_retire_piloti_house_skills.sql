-- The two house skills retire: their craft moved into the system prompts.
--
-- `piloti-voice` and `piloti-cards` were `delivery: 'standard'` platform rows —
-- forced on every research turn — because a database row is editable without a
-- deploy. What that bought was outweighed by what it cost, and the cost was
-- measured, not guessed:
--
--   * A forced skill contributes only its NAME to the prompt; the body travels
--     through exactly one path, the `use_skill` tool closure, and a model that
--     never calls it never reads a word (`skills/runtime.py`, module header).
--     The fleet forced two skills and reserved two tool iterations per research
--     turn for them, and on the heaviest turns the reserved calls pushed real
--     research into forced synthesis. Answers the disclosure said were shaped
--     by the house voice were, on those turns, shaped by nothing.
--   * ~7,800 tokens of skill prose plus ~1,900 of inlined card shapes rode
--     every research turn that DID load them, in front of the question and the
--     evidence.
--
-- The replacement, in the same change that ships this migration:
--
--   * The voice is the `<stimme>` section of
--     `src/aiq_agent/agents/shallow_researcher/prompts/researcher.j2`, condensed,
--     and a report-sized subset in the deep writer's `writer.j2` — in the system
--     prompt, so it reaches EVERY answer unconditionally, at zero tool calls.
--   * The card craft is the `<cards>` section of the same prompt.
--   * The rhetorical cards the `piloti-cards` `grid-cards` list inlined
--     (`verdict_header`, `key_takeaways`, `callout`) are no longer emitted by
--     the model at all: they are fields of the structured `answer_meta` trailer,
--     validated and materialized platform-side
--     (`agents/shallow_researcher/answer_meta.py`).
--
-- Guarded on the md5 of the body each seed last wrote (0057 for the voice,
-- 0062 for the cards), NOT on `created_by` — the dashboard's update path
-- patches `body` and never touches `created_by`, so a hand-edited row still
-- reads `system`. A row whose prose the platform owner has rewritten is theirs
-- and is left standing (it keeps being resolved and forced like any other
-- standard skill); retiring it is then their call, in the dashboard. A second
-- run is a true no-op: the rows are gone or not ours.
--
-- The reversal is `0071_retire_piloti_house_skills.down.sql`, which re-seeds
-- both rows exactly as 0057 and 0062 left them — and, because the craft now
-- also lives in the prompts, that rollback alone would double-teach: reverting
-- this migration only makes sense together with the prompt-side revert.

DELETE FROM "platform_skills"
  WHERE "name" = 'piloti-voice'
    AND md5("body") = 'baa8d00230a9e7c1ba83c3344b2f2d91';  -- pragma: allowlist secret

DELETE FROM "platform_skills"
  WHERE "name" = 'piloti-cards'
    AND md5("body") = '1619c379e0e07eac5d0bbd24aa078e7c';  -- pragma: allowlist secret
