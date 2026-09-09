# Agent tier overhaul

Audit of everything under `src/aiq_agent/agents/` (19,100 lines of source,
~22,000 of tests), the restructure it argues for, and the decisions it leaves to
the owner. Seven per-module audits back this; their file:line detail is in the
session scratchpad and was folded into the refactor briefs.

## The one-paragraph verdict

There are **two agents** in the tier, not seven. `shallow_researcher` is the
general-purpose chat agent and `deep_researcher` is the long-form one. Of the
other five directories, `chat_researcher` is a workflow wrapper with no model
call of its own that re-derives the researcher's escalation decision three
times, `clarifier` is a fixed stage inside it wearing an agent's registration,
and `compliance_checker`, `bim` and `project_memory` are tools. The directory
name is what produced the "zoo of specialised agents" impression; the
architecture underneath already is "one researcher plus one deep researcher".

## What is true today

| Directory | Really is | Lines | Tests | Worst function |
|---|---|---|---|---|
| `shallow_researcher` | AGENT (chat) | 4,191 | 279 | `run()` 533 lines, nesting 7 |
| `deep_researcher` | AGENT (async job) | 4,902 | 258 | `_finalize()` 306 lines |
| `chat_researcher` | workflow wrapper, no LLM call | 2,893 | 315 | `register._run` 514 lines, the whole per-turn harness in one closure |
| `clarifier` | SUB-STEP of chat | 1,410 | 142 | `_build_graph` 233 lines; ~340 lines of JSON recovery + keyword classification that stricter output and a literal match replace |
| `compliance_checker` | TOOL (staged pipeline) | 1,149 | 33 | never run against a real model |
| `bim` | two TOOLs (`ifc_query`, `ifc_measure`) | 3,936 | 311 | `_render` 224 lines, nesting 10; three stacked validation layers |
| `project_memory` | TOOL + a stage body | 608 | 46 | three write paths for one memory |

Nesting violations at the two-level bar: 130 in this tier (deep 37, shallow 37,
chat 31, bim 22, compliance 3), 690 repo-wide.

## Bugs the audit found

Each is being fixed in round 1 with a pinning test. None was known before.

1. **Every chat turn rebuilds the whole researcher.** `shallow_researcher/register.py:227-251` reconstructs `ShallowResearcherAgent` on every skills-enabled turn (always, in production): re-reads the 43 KB prompt synchronously inside async code, recompiles the LangGraph, re-binds every tool schema. The construction-time caching the comments describe never fires. On the per-turn critical path.
2. **A synchronous HTTP call on the event loop inside a Dask worker.** `deep_researcher/agent.py` → `_build_skill_runtime` → `resolve_served_skills` → `httpx.get`. `docs/contributing/gotchas.md` names exactly this as the cause of ghost-reaper job failures.
3. **The compliance check judges a project against the Richtlinie text itself.** Stage 1 (regulation) and Stage 2 (project evidence) call `knowledge_search` with no scope, so both hit the same collection set. `request.collection_name` is dead.
4. **The compliance risk score ranks a confirmed violation below a guessed one.** `nicht_erfuellt` at high confidence scores 85; at low confidence, 100. Replaced by an explicit `(status, confidence)` sort key; the number goes.
5. **A failed focus-set leaks the previous turn's focus into the next turn.** `chat_researcher/utils.py:187-201` swallows the exception.
6. **Memory reflection caps at five findings before filtering PII and duplicates**, so a dropped finding still consumes a slot, contradicting the docstring that justifies the second PII pass. The prompt also omits the `importance` field the schema requires.
7. **Up to five sequential HTTP writes inside a 45-second stage** (`project_memory/reflection.py:367-389`); one gather.
8. **The per-turn context loads run sequentially on the time-to-first-byte path** (`chat_researcher/register.py:898,927,954`) and the request envelope is HMAC-parsed twice per turn.
9. **The deep researcher re-reads five prompt files from disk per request** for any org with a model override, and walks the skills tree twice per run.

Adjacent, not a bug but wrong: the compliance tool's `focus` parameter is dead,
the `remember` tool's project→org escalation is always refused by the default
deployment (every org-scope call is a wasted round trip plus a card), and the
`memory_proposal` card writes memories without provenance, supersedes or
salience.

## Round 1 (in progress): refactor in place

Seven subagents, one per module, behaviour-preserving except where a bug is
named above. Rules: ≤60-line functions, ≤2 nesting levels, early exits, no
swallowed exceptions, no mutable module state, independent awaits gathered.
Nothing imported across modules is renamed. Every NAT `_type`, every YAML key,
every persisted identifier stays. Tests are the oracle; `PLR1702` at
`max-nested-blocks = 2` must report zero for the module.

What round 1 deliberately does NOT do: move anything, rename anything, delete
any feature. Those are rounds 2 and 3.

## Round 2: the moves

Python paths only. Persisted strings do not move:
`shallow_researcher`/`deep_researcher` in `jobs.agent_type` and in every skill's
`grid-agents` metadata, `SKILL_AGENT`, `KNOWN_AGENTS`, every NAT `_type`. The
UI matches step names by string; those strings stay.

```
src/aiq_agent/
  agents/
    researcher/        ← shallow_researcher  (alias _type shallow_research_agent for one release)
    deep_research/     ← deep_researcher
    chat/register.py   ← chat_researcher's thin entry; clarify.py folded in
  turn/                ← the per-turn harness extracted from chat_researcher/register.py
                          context.py inventory.py registries.py response.py streaming.py dispatch.py
  tools/
    bim/               ← agents/bim   (capability_gaps.py → observability/)
    ask_user.py        ← shallow_researcher/ask_user.py
  memory/              ← agents/project_memory (reflection body → stages/memory_reflection.py)
  pipelines/compliance_check/  ← agents/compliance_checker
  common/confidence/   ← shallow_researcher/{markers,grounding}.py (imported by chat and deep)
```

Then `ruff`'s `PLR1702` is turned on for `src/aiq_agent/agents/**`,
`src/aiq_agent/turn/**`, `tools/**`, `memory/**`, `pipelines/**` with
`explicit-preview-rules`, and per-file-ignored elsewhere until those areas are
brought under. That is the ratchet.

### The rename `shallow_researcher` → `researcher`

Owner has asked for it. It is a migration, not a rename:

- ~110 files of mechanical replace (Python, 9 YAMLs' `_type`, aiq_api registry,
  `KNOWN_AGENTS`, UI `AGENT_FOR_OUTPUT`/`agent-scope`/step-name maps, 10 builtin
  `SKILL.md` + regenerated `platform-skills.ts`, 25 docs).
- **One true data migration**: `platform_skills.metadata->>'grid-agents'` stores
  `shallow_researcher[,deep_researcher]` in three seed migrations (0053, 0054,
  0055) and in every org-authored skill since. The resolver rejects unknown
  names, so without an `UPDATE` plus a dual-name window every scoped skill
  silently drops off chat.
- Stored intermediate-step `functionName: 'shallow_research_agent'` in message
  metadata needs a read-side alias in the UI parser.
- Adjacent labels NOT forced by the rename and best left: `citation_events.agent
  = 'shallow'`, `platform_model_defaults.agent_group = 'shallow_research'`.

Recommendation: do it as its own PR after round 2, with the migration, the
alias, and `KNOWN_AGENTS` accepting both names for one release.

## Round 3: decisions only the owner can make

Each is a feature or a design, not dead code. Recommendation first.

**Answered 2026-09-09.** The owner's calls, and what they change:

| # | Decision | Answer |
|---|---|---|
| 1 | Dissolve `chat_researcher` into the researcher | **Yes** |
| 2 | Collapse `clarifier` into the researcher | **Yes** |
| 3 | Compliance check: job, skill, or delete | **Defer.** Stays registered and unreachable; not moved in round 2, because moving a directory whose fate is undecided is churn |
| 4 | Deep research: the fixed-graph rewrite | Not asked; still open, still its own project |
| 5 | Delete the sandbox, source router, domain catalog | Largely moot — develop deleted the demo config that carried them |
| 6 | Memory: one write path | Not asked; still open, still touches the frontend |

Plus: the `shallow_researcher` → `researcher` rename is **in**, folded into this
branch rather than deferred to its own PR, and kept as its own commit so it can
be reverted alone.

**Order.** The dissolve comes before the rename, against the instinct to make
names right first. Dissolving decides which registrations survive; renaming
afterwards names only the survivors, so the ~70 files carrying a `shallow_*`
identifier are touched once and there is one data migration rather than two.

**The rename's real cost, measured.** Three identifier families, not one:
the Python package (`shallow_researcher`, free), the NAT `_type`
(`shallow_research_agent`, a config change plus a dual-name window), and the
`AgentGroup` (`shallow_research`, a `platform_models.agent_group` value). Plus
the skill agent name in `platform_skills.metadata->>'grid-agents'`, seeded by
ten past migrations and live in current rows. **`jobs.agent_type` is not
affected** — it defaults to `deep_researcher` and the researcher never runs as a
job. So: two migrated columns, one dual-name window, and every past migration
keeps its old string because migrations are history.

### 1. Dissolve `chat_researcher` into the researcher — recommended

After ADR-0052 the researcher makes the escalation decision itself; this module
re-derives it three times and spends 90 lines defensively re-reading fields the
researcher's typed state already has. Everything it adds is a pure function of
the researcher's result. The graph reduces to: call researcher; if escalate and
not declined, clarifier then deep. About 40 lines, not 976. The checkpointer it
exists to hold (`messages`, `deep_research_declined`) moves onto the
researcher's own graph. The harness leaves for `turn/` in round 2 regardless.

### 2. Collapse `clarifier` into `chat/clarify.py` — recommended

One caller, caller-built state, caller-interpreted result. Registration as a NAT
function buys a YAML block and an `AgentGroup`. ~150 lines with two
structured-output models replaces 1,000. Config fields move onto
`chat_deepresearcher_agent`; five YAMLs and the `AgentPrompt.tsx` literals
change. Round 1 already strips the JSON-recovery and keyword machinery in
place, so this is mostly deletion afterwards.

### 3. Compliance check: job, skill, or delete — recommend job

What it buys over the researcher: a bounded call count and a report in which
every Richtlinie in scope gets a row. What it costs: no citation chips, no
grounding pass, no cards, an LLM re-summarising the "deterministic" table, and a
blocking chat turn with no timeout that fans out to ~9 LLM calls. Nobody can
invoke it deliberately and nothing shows whether it fired.

- For a focused check (one Richtlinie, one question) the eight OIB **skills**
  already win: real retrieval, citations, `requirement_checklist` cards, no
  code.
- For the full six-Richtlinie matrix it should be a **job / task kind** next to
  `deep-research`: a deadline, a filed artifact, review, the report pipeline.
  The roadmap (`agentic-workspace-architecture.md`, ADR-0051) already says so;
  `aiq_api/registry.py` registers agent types for the async runner by
  `config_name`, so this is wiring, not a new agent. The chat doorbell comes
  off the researcher's tool list.
- Delete it only if a Konformitätsprüfung is off the roadmap. Round 1 fixes
  the two correctness defects either way, so whatever survives is sound.

### 4. Deep research: what deepagents is costing — recommend the fixed graph, as its own project

The orchestrator's job is a fixed four-step sequence that never branches, and
the module spends ~1,100 lines fighting the framework that runs it: five
custom middlewares (deferred structured output, tool-name sanitisation, result
pruning racing deepagents' own summariser, selective retry, empty-content fix),
a write-once filesystem the prompts have to explain to the model, and a
162-line orchestrator prompt of "do step 2 before step 3, never in the same
turn". A plain LangGraph `StateGraph` (route → plan → gather researchers →
write) needs no orchestrator LLM, no `task()`, no sequencing prose, and drops
one LLM role plus the recursion-limit machinery. The one thing lost —
resubmitting failed queries — is a ten-line loop with `MAX_QUERY_SUBMISSIONS`
already in hand.

This is a rewrite of the product's longest answers with no live test suite.
Recommend it as its own project with the live turn-shape harness extended
first. Not part of this overhaul.

### 5. Delete the sandbox, the source router, and the domain catalog — recommended

All three are dead in the deployed product:

- **Sandbox** (`deepagents_runtime.py`, ~250 lines + the `langchain-modal`
  dependency): the production config says "needs a sandbox this config does
  not run". Only the demo config enables it. It exists to run
  `matplotlib`/`pandas` for the upstream blueprint's data-table skills.
- **Source-router subagent** (an LLM role, an `AgentGroup`, a model-config row,
  `source_router.j2`, `tools/source_routing.py`): in production it picks among
  **one** domain — every deployed config gets the built-in default catalog —
  and its output is advisory text the planner may ignore while the planner
  prompt already says "prefer RIS for Austrian statutes". ADR-0052 removed the
  chat intent router on the same reasoning: a pre-label can only withhold.
- **Domain catalog** (`configs/domain_catalogs/`): its only consumer is the
  router in the demo config. Note: earlier this session that demo config and
  catalog were re-pointed at RIS to keep the routing demo alive after the
  news/market/scholar sources were removed. The deep audit argues the router
  itself is not earning its place; if it goes, the catalog and the parity test
  go with it, and the demo config narrows to skills + sandbox — which is
  decision 5 again. Recommend deleting all three and the demo config.

Also in this bucket, deletable regardless: the `think` no-op tool, the two
config-only NAT functions (`deep_research_skills`, `deep_research_sandbox` —
NAT accepts the nested model inline), `deep_research_workflow` and
`shallow_research_workflow` (eval wrappers used only by benchmark configs, no
tests), `tool_search.py` (430 lines of hand-rolled BM25, off in every shipped
config), and the never-read state fields `tools_info`, `subagents`, `rubric`.

### 6. Memory: one write path — recommend it, scope for later

Three ways to write a memory today: the `remember` tool (agent provenance, may
request org scope), the reflection stage (distillation, project-only,
salience), and the `memory_proposal` card (browser → BFF, skips provenance,
supersedes and salience). The escalation policy in the tool is "deferred"
by its own comment and always refused by the default deployment. Decide the
policy, delete the escalation and the `scope` parameter, and route the card
through the same BFF path the other two use so a memory has one shape.
Touches the frontend; not part of this overhaul.

## What "done" looks like for this overhaul

- Round 1: every module under `agents/` at the bar, nine bugs fixed with tests,
  every existing test green, no public name changed.
- Round 2: the layout above, `PLR1702` on for the refactored paths, docs and
  entry points updated, `task verify` green.
- Round 3: the six decisions above answered; each yes becomes its own commit.
  Four are answered; 4 and 6 stay open and 3 is deferred by choice.
