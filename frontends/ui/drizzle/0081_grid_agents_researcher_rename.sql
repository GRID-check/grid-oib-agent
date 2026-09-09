-- 0081: `grid-agents: shallow_researcher` becomes `grid-agents: researcher`.
--
-- ## What changed above this
--
-- The chat agent was renamed: it is no longer "the shallow one", it is the
-- researcher, with `deep_researcher` as the only other agent. `grid-agents` is
-- the one gate deciding which agents a skill is offered to, and it is spelled
-- in that same vocabulary — the `AGENT_REGISTRY` identifiers. So the stored
-- value has to move with the code.
--
-- ## Why this needs a migration and not just a rename
--
-- Both resolvers (`lib/skills/service.ts::skillTargetsAgent` and
-- `src/aiq_agent/skills/resolver.py::_agent_allows`) IGNORE a name they do not
-- know, and an allowlist of only unknown names is treated as absent — that is
-- deliberate, so one typo cannot delete a skill from every agent at once. It
-- also means a rename without this UPDATE is silent and wrong in the widest
-- possible direction: every `grid-agents: shallow_researcher` row would read as
-- "no restriction", and the eight chat-scoped skills would start being served
-- to deep research as well. Nothing would log, and nothing would look broken.
--
-- The code carries a read-side alias for the same value (`AGENT_ALIASES` in the
-- Python resolver, `SKILL_AGENT_ALIASES` in `lib/skills/types.ts`,
-- `AGENT_ALIASES` in `features/skills/lib/agent-scope.ts`). The alias and this
-- migration are not redundant: the alias covers what this cannot see — a row an
-- older BFF writes during a rolling deploy, a restored backup, a skill imported
-- from an export taken before today — while this migration is what lets the
-- alias be removed one day instead of becoming permanent.
--
-- ## Why a new migration and not an edit to 0053-0062 and 0071
--
-- Ten past migrations seeded this key. They are history: a database that has
-- already applied them would not notice an edit, and `platform_skills` rows are
-- guarded by `ON CONFLICT` clauses precisely so a re-run cannot overwrite a
-- platform owner's edits. So they keep their old string, exactly as written,
-- and this migration moves the live rows forward.
--
-- ## Scope: two tables, and deliberately not the snapshots
--
--   * `platform_skills` — the platform's own rows, seeded by those migrations.
--   * `skills`          — org-authored and cloned rows, where a member picked a
--                         scope in the editor's agent checkboxes.
--
-- `jobs.skill_snapshot` and `job_runs.skill_snapshot` also contain a copy of
-- `metadata`, and are left alone on purpose. A snapshot is the deterministic
-- WYSIWYG copy a run pinned, and nothing reads `grid-agents` out of one —
-- availability is resolved from the live row, and which agent a job runs on
-- comes from the job's `output` column, never from the snapshot. Rewriting a
-- snapshot would edit a record of what was, to no effect.
--
-- ## The match is anchored, not a substring replace
--
-- `\m` and `\M` are Postgres word boundaries and `_` counts as a word
-- character, so `\mshallow_researcher\M` matches the whole token and nothing
-- else: it does not fire inside `deep_researcher`, and it leaves a genuine typo
-- like `xshallow_researcher` alone rather than silently half-correcting it into
-- a name that still is not an agent.
UPDATE "platform_skills"
   SET "metadata" = jsonb_set(
         "metadata",
         '{grid-agents}',
         to_jsonb(regexp_replace("metadata" ->> 'grid-agents', '\mshallow_researcher\M', 'researcher', 'g'))
       ),
       "updated_at" = now()
 WHERE "metadata" ->> 'grid-agents' ~ '\mshallow_researcher\M';
--> statement-breakpoint
UPDATE "skills"
   SET "metadata" = jsonb_set(
         "metadata",
         '{grid-agents}',
         to_jsonb(regexp_replace("metadata" ->> 'grid-agents', '\mshallow_researcher\M', 'researcher', 'g'))
       ),
       "updated_at" = now()
 WHERE "metadata" ->> 'grid-agents' ~ '\mshallow_researcher\M';
