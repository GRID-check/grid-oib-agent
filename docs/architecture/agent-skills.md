# Agent Skills (ADR-0045)

Skills are reusable, versioned instruction packages (the agentskills.io
format) that extend what the model can be told how to do on:
- **Interactive chat turns** (`shallow_researcher`), and
- **Async deep-research jobs** (`deep_research_agent`), including the
  skill-scheduler's scheduled runs.

This doc covers the backend half: where skills come from, how they are
selected per run, and how the model is told about them. The BFF/DB/scheduler
half lives in `docs/architecture/workflows.md` (the skill-scheduler is the
ADR-0023 workflow scheduler's successor), the API surfaces in
`docs/api/python-endpoints.md` and `docs/api/bff-routes.md`.

## Skill model

A skill is a `SKILL.md` with YAML frontmatter (agentskills.io contract),
validated strictly by `src/aiq_agent/skills/models.py`:

| Field | Rule |
|-------|------|
| `name` | 1–64 chars, lowercase `a-z0-9` + hyphens; for filesystem skills it must equal the parent dir name |
| `description` | 1–1024 chars, non-empty; the one-line L1 summary the model sees |
| `body` | The full markdown instructions (L2), loaded only via the `use_skill` tool |
| `metadata` | String-map; reserved GRID keys (`grid-execution` ∈ `chat`\|`deep-research`, `grid-schedulable`, `grid-agents`) are validated |
| `license` / `compatibility` / `allowed_tools` | Optional free-form strings |

Unlike deepagents' warn-and-continue scan, GRID's substrate validates
**strictly**: an invalid builtin SKILL.md is a deployment error
(`builtin.py` raises), an invalid org row is dropped individually with a
warning (`resolver._build_org_skills`), never silently half-loaded.

### Origins

- **Builtin** (`origin="platform"`): SKILL.md files shipped under
  `src/aiq_agent/skills/builtin/<collection>/<name>/SKILL.md`, discovered
  deterministically by `discover_builtin_skills()`.
- **Org** (`origin="org"`): rows served by the BFF internal endpoint
  `GET /api/internal/skills/resolve` (org SKILL.md uploads stored in the
  `skills` table). An org row whose name matches a builtin **shadows** it —
  the tenant's version wins, mirroring BYOK's "explicit org value beats
  deployment default" ordering (ADR-0022).

## Resolution

`SkillResolver(agent)` in `src/aiq_agent/skills/resolver.py` produces the
effective skill set for one run:

1. Builtin set is discovered once per resolver instance (never per turn).
2. Org rows are fetched per organization from the BFF fail-open:
   - Cached in the shared Dragonfly/Redis cache
     (`aiq_agent.common.cache`, ADR-0020) keyed
     `skills:{organization_id}:{agent}` for
     `GRID_SKILLS_CACHE_TTL_SECONDS` (default 60s).
   - Any failure (no `GRID_INTERNAL_API_TOKEN`, timeout, non-2xx, malformed
     payload) degrades to the builtin set — skills are an additive
     capability and must never take chat down.
3. Per-agent filtering:
   - `grid-agents` metadata (comma list) — absent = all agents.
   - `grid-execution` — `chat` skills only on `shallow_researcher`,
     `deep-research` skills only on `deep_research_agent`.
   - The workflow config's `skills_enabled` / `skill_allowlist` (see below).

## Selection & progressive disclosure

Skill selection is **user-request-driven, never model-chosen**:

- Chat turns: `_extract_query_and_sources` / `_extract_query_from_text` in
  `src/aiq_agent/agents/chat_researcher/utils.py` parse `data_sources` and
  `skills` out of the turn input. The JSON envelope mirrors the
  `data_sources` mechanism, so a mention like
  `{"query": "...", "data_sources": ["web_search"], "skills": ["forecast-analysis"]}`
  forces those skills for the turn. Unknown names are dropped by the
  enforcement machinery (they simply don't match a resolved skill).
- Remote submissions: `/v1/internal/skills/submit` carries `force_skills` so
  scheduled/manual skill runs force-activate their declared skill names on
  the chat (`shallow_researcher`) side; agent selection follows the skill's
  `grid-execution` metadata. Deep-research runs get their skills the
  deepagents-native way (see Config).

Progressive disclosure has exactly two levels:

- **L1 — the catalog.** One line per skill (`name: description`) in the
  system prompt's `## Verfügbare Skills` section, plus a `## Aktive Skills
  (vom Nutzer erzwungen)` block listing skills forced for this turn. Both
  blocks are pre-collated by the register layer (`ShallowAgentFlat` /
  `DeepAgentFlat`) and render via the runtime's `prompt_block()` /
  `forced_block()`; `None` renders no section.
- **L2 — the body.** The model must call the `use_skill` tool to load a
  body before following it. A failed lookup returns an error listing the
  available names, so a hallucinated skill name is self-correcting rather
  than a fatal turn.

`SkillRuntime` (`src/aiq_agent/skills/runtime.py`) is **per run**
(ADR-0018 — never cached on a shared agent instance): it owns the forced/
activated name lists, so `skills_activated` on the terminal frame records
exactly which skills were forced vs. invoked this run.

## Config

`configs/config_oib_openrouter.yml`, `shallow_research_agent`:

```yaml
skills_enabled: true        # default true; false disables the use_skill tool + catalog
skill_allowlist: []         # empty = every resolved skill is offered
```

Both are fields on `ShallowResearchAgentConfig`; they only affect **research
turns** (`requires_sources=True`) — meta/conversational turns never load
skills, mirroring the interaction-only tool partition. Forced names and the
allowlist filter to the actual resolved set; unknown names are simply ignored
(fail-open on both sides: a typo in `skills:` never errors a turn).

The deep-research side is different by construction: it does NOT use the
`use_skill` tool or these config keys. Its skills are deepagents-native
(`deep_research_skills`, a `DeepResearchSkillsConfig` function-ref in the
config): per-agent skill *sources* wired through `SkillsMiddleware` with a
`FilesystemBackend` over `src/aiq_agent/skills/builtin/` and read-only
filesystem permission rules (`factory.runtime_skill_filesystem_permissions`).
`force_skills` is never passed to deep research — the chat orchestrator drops
it (`chat_researcher/agent.py`).

## Tests

- `tests/aiq_agent/skills/` — model validation, builtin discovery, resolver
  caching/shadowing/fail-open, runtime prompt/tool wiring.
- `tests/aiq_agent/agents/chat_researcher/` — the envelope parsing
  (`test_utils.py`, `test_register_helpers.py`) and per-turn skill forcing.