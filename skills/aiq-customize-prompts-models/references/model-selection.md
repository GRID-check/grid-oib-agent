# Model selection

Authoritative sources: `docs/architecture/llm-providers.md`,
`docs/architecture/org-model-configuration.md` and the `llms:` section of
`configs/config_oib_openrouter.yml`.

## Define models once, reference them by name

Declare each model in the config `llms:` section, then reference it by name from
an agent. Do not hard-code model names in Python.

```yaml
llms:
  capable_llm:
    _type: openai       # every model is an OpenAI-compatible endpoint on OpenRouter
    model_name: <a capable model>
    base_url: "https://openrouter.ai/api/v1"
    api_key: ${OPENROUTER_API_KEY}
  cheap_llm:
    _type: openai
    model_name: <a cheaper model>
    base_url: "https://openrouter.ai/api/v1"
    api_key: ${OPENROUTER_API_KEY}
```

## Assign a model to an agent role

Agents expose per-role LLM fields, but the two agents wire them differently — so
check the agent you are editing.

**Deep research agent** (`src/aiq_agent/agents/deep_researcher/register.py`)
defines `orchestrator_llm` (required) plus `source_router_llm`, `researcher_llm`,
`planner_llm`, and `writer_llm` (`LLMRef | None`). It seeds the provider default
from `orchestrator_llm` (`LLMProvider.set_default(...)`) and binds each set role
with `LLMProvider.configure(LLMRole.<ROLE>, llm)`
(`src/aiq_agent/common/llm_provider.py`). Field → role:

| Config field | `LLMRole` |
| :-- | :-- |
| `orchestrator_llm` (required) | `ORCHESTRATOR` — also the provider default |
| `source_router_llm` | `ROUTER` |
| `researcher_llm` | `RESEARCHER` |
| `planner_llm` | `PLANNER` |
| `writer_llm` | `REPORT_WRITER` |

An unset role falls back to the provider default (the `orchestrator_llm` model).
There is **no** generic `llm` field on the deep research agent.

**Clarifier** (`src/aiq_agent/agents/shallow_researcher/clarify.py`,
`ClarifierSettings`, configured as the `clarifier:` block on
`chat_deepresearcher_agent`) defines `llm` (its
default) and `planner_llm`. It does **not** use `LLMProvider.configure` for the
role — it passes `planner_llm` straight into the step's resolved dependencies,
and `planner_llm` falls back to `llm` when unset.

```yaml
functions:
  deep_research_agent:
    _type: deep_research_agent
    orchestrator_llm: deep_orchestrator_llm   # required; also the default for unset roles
    source_router_llm: deep_router_llm
    researcher_llm: deep_researcher_llm
    planner_llm: deep_planner_llm             # cheaper model for planning
    writer_llm: deep_orchestrator_llm
```

This mirrors the real config (`configs/config_oib_openrouter.yml`); copy field
names from there rather than guessing.

## Swapping the provider

Every `llms:` entry is an OpenAI-compatible endpoint, and the shipped config
routes all of them through OpenRouter. To use another OpenAI-compatible host,
change `base_url` and `api_key` on the entry; `docs/architecture/llm-providers.md`
lists what the endpoint must support. Remember the YAML model name is only the
boot floor: the live default is admin-set (ADR-0014).

## Validation

```bash
./scripts/start_cli.sh --config_file <the config where you set the role LLMs>   # agent starts with the assigned models
uv run pytest tests/aiq_agent/agents/deep_researcher
```

Expected: the agent starts with the configured models and its tests pass. A bare
`start_cli.sh` runs the fixed default config, so pass the config you edited. Every
role ref must resolve to an entry in `llms:`.
