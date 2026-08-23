# Compliance Checker Agent (OIB Soll-Ist-Abgleich, v1)

Backlog **T4-3**: a purpose-built, deterministic staged pipeline for OIB
compliance checks -- the structured alternative to running a Soll-Ist-Abgleich
through the generic deep-research harness (300 turns / 20+ minutes). This
agent is **not** an open agent/tool-calling loop: every LLM call is a single
structured request/response, and the total call count for a full 6-Richtlinie
check is bounded and predictable (~10-25 calls, see budget math below).

**Status: callable from chat.** Registered as `aiq_compliance_checker`,
configured as `compliance_check`, and on `shallow_research_agent`'s tool list.
A turn that asks for a full Soll-Ist should call the tool. Live shakedown
against a real model is still pending.

## Pipeline stages

```
ComplianceCheckAgentState / ComplianceCheckRequest
            │
            ▼
┌─────────────────────────────────────────────────────────────────┐
│ STAGE 1 -- Requirement profile (per Richtlinie in scope)         │
│                                                                   │
│  For each Richtlinie (1-6, bounded concurrency, asyncio.Semaphore│
│  via max_concurrency):                                           │
│    1. Direct (tool-free) knowledge_search.ainvoke() retrieval of │
│       the base OIB collection (overview + Anwendungsbereich      │
│       queries -- 2 retrieval calls, not LLM calls).               │
│    2. ONE structured LLM call -> RequirementProfile               │
│       (requirements: list[RequirementItem], each with an          │
│       applicability of anwendbar / nicht_anwendbar / zu_pruefen). │
└─────────────────────────────────────────────────────────────────┘
            │  flatten "anwendbar" + "zu_pruefen" items
            ▼
┌─────────────────────────────────────────────────────────────────┐
│ STAGE 2 -- Evidence check (per batch of ~8-10 requirements)       │
│                                                                   │
│  Requirements are grouped into batches of                        │
│  requirement_batch_size (default 9). For each batch (bounded      │
│  concurrency):                                                    │
│    1. Direct (tool-free) knowledge_search.ainvoke() retrieval     │
│       scoped to the project document collection (one combined     │
│       query + one query per distinct Richtlinie in the batch).    │
│    2. ONE structured LLM call -> EvidenceBatchResult              │
│       (one EvidenceFinding per requirement in the batch:          │
│       erfuellt / teilweise / nicht_erfuellt / kein_nachweis).     │
└─────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────┐
│ STAGE 3 -- Matrix assembly + report rendering (NO LLM CALLS)      │
│                                                                   │
│  Pure Python (agent.py:_assemble_matrix, report.py):              │
│    - Join RequirementItem + EvidenceFinding into                  │
│      ComplianceMatrixRow (the matrix table).                      │
│    - Compute a deterministic risk_score per non-"erfuellt"        │
│      finding (status base score +/- confidence adjustment),       │
│      rank into GapItem, sort desc -> risikogewichtete Lueckenliste│
│    - Dedupe EvidenceFinding.open_question into open_questions.    │
│    - Render everything as a German Markdown report.               │
└─────────────────────────────────────────────────────────────────┘
            │
            ▼
      ComplianceCheckResult (matrix, report_markdown, call counts)
```

## Call-budget math

For a full 6-Richtlinien check:

- **Stage 1:** exactly `len(richtlinien)` LLM calls -- at most **6**.
- **Stage 2:** `ceil(applicable_requirements / requirement_batch_size)` LLM
  calls. With ~5 requirements/Richtlinie (typical) and the default batch size
  of 9, that's `ceil(~30 / 9)` = **~4** calls; worst case with a large,
  heavily-applicable requirement set stays in the **~4-10** range.
- **Stage 3:** **0** LLM calls (pure Python).

**Total: ~10-16 calls typical, comfortably under the ~10-25 design budget**,
vs. 300+ turns / 20+ minutes for the same check run through the generic
deep-research harness. `knowledge_search` retrieval calls (Stage 1: 2 per
Richtlinie; Stage 2: 1 combined + 1 per distinct Richtlinie per batch) are
**not** LLM calls and do not count against this budget -- they're direct,
code-determined `.ainvoke()` calls on the injected tool, not something an LLM
decides to make.

`ComplianceCheckResult.stage1_llm_calls` / `.stage2_llm_calls` /
`.total_llm_calls` report the exact counts for a given run (attempted calls,
including any that failed) -- see `tests/aiq_agent/agents/compliance_checker/test_agent.py`
for the call-budget assertions.

## Package layout

```
compliance_checker/
├── __init__.py          # exports compliance_check_agent (register.py)
├── agent.py              # ComplianceCheckAgent: the 3-stage pipeline
├── report.py              # Stage 3 Markdown rendering (no LLM)
├── register.py             # NAT @register_function wiring
├── models/
│   ├── request.py           # ComplianceCheckRequest, ComplianceCheckAgentState, RICHTLINIE_NAMES
│   ├── requirements.py        # RequirementItem, RequirementProfile (Stage 1 LLM schema)
│   ├── evidence.py             # EvidenceFinding, EvidenceBatchResult (Stage 2 LLM schema)
│   └── matrix.py                 # ComplianceMatrixRow, GapItem, ComplianceMatrix, ComplianceCheckResult
└── prompts/
    ├── requirement_profile.j2    # Stage 1 system prompt
    └── evidence_batch.j2          # Stage 2 system prompt
```

### Strict-mode-safe schemas

`RequirementItem`, `RequirementProfile`, `EvidenceFinding`, and
`EvidenceBatchResult` are the only schemas ever sent to an LLM as structured
output (via `aiq_agent.common.strict_json_response_format`, native strict
`json_schema` mode). None of them use `Field(ge=..., le=..., min_length=...,
max_length=..., pattern=...)` -- those compile to JSON-Schema keywords strict
mode rejects. Range/shape enforcement instead uses `field_validator` (see
`models/requirements.py::_validate_richtlinie_number`), matching the fix
already applied to `aiq_agent.agents.deep_researcher.models.subagent_contracts`
(`EvidenceJudgment.relevance_score`, `ResearchQuery.preferred_tools`).

`GapItem.risk_score` (in `models/matrix.py`) DOES use `Field(ge=0, le=100)` --
that's fine, because it's a Stage 3 pure-Python computation that never reaches
an LLM structured-response call.

`tests/aiq_agent/agents/compliance_checker/models/test_schemas.py` has a
schema-walk test (mirroring
`tests/aiq_agent/agents/deep_researcher/models/test_subagent_contracts.py`)
that asserts `RequirementProfile.model_json_schema()` and
`EvidenceBatchResult.model_json_schema()` contain none of
`minimum`/`maximum`/`exclusiveMinimum`/`exclusiveMaximum`/`minLength`/
`maxLength`/`pattern` anywhere in their tree.

## Registration

Plugin entry point and the function block in
`configs/config_oib_openrouter.yml`, reproduced below for reference:

```toml
[project.entry-points."nat.plugins"]
aiq_compliance_checker = "aiq_agent.agents.compliance_checker.register"
```

```yaml
functions:
  compliance_check:
    _type: compliance_check_agent
    llm: compliance_llm
    knowledge_search_tool: knowledge_search
    max_concurrency: 3
    richtlinien: [1, 2, 3, 4, 5, 6]
    requirement_batch_size: 9
    verbose: false
```

The doorbell is the chat tool: `compliance_check` is on
`shallow_research_agent`'s tool list. A turn that asks for a full
Soll-Ist / Konformitaetspruefung should call it rather than walking the six
Richtlinien by hand. The tool reads project context and the project collection
from the request; `focus` and `richtlinien` narrow the run.

## Agent group

`AgentGroup.COMPLIANCE_CHECK` (`compliance_check`) is the override point for
`compliance_llm`. Independent of `deep_research`, so unsetting that group's
model does not silence a check.
