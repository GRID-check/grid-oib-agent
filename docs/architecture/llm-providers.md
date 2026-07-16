# LLM providers — the OpenAI-compatible, agnostic model

> GRID is not tied to any LLM vendor. Any OpenAI-compatible endpoint is a valid
> provider, selected entirely by configuration. See also
> [ADR-0010](../adr/0010-llm-agnostic-openai-compatible.md).

## The principle

No vendor is hard-coded in application logic. The active LLM and embedding
provider is chosen in the **workflow config** (`configs/*.yml`) by setting an
OpenAI-compatible `base_url`, a `model_name`, and an API-key env var. Because the
NeMo Agent Toolkit's LLM/embedder providers speak the OpenAI wire format, this
covers a wide range of backends with **no code change**:

- Managed aggregators (OpenRouter)
- Self-hosted inference (vLLM, Ollama, TGI)
- Cloud vendors' OpenAI-compatible endpoints (Azure OpenAI)
- NVIDIA NIM

## Choosing the active config

`CONFIG_FILE` (env, set in compose) selects the active workflow config. The shipped
**reference config** is `configs/config_oib_openrouter.yml` (DeepSeek + embeddings
via OpenRouter).

```yaml
# configs/config_oib_openrouter.yml (excerpt) — an OpenAI-compatible LLM
llms:
  deepseek_super_llm:
    _type: openai
    base_url: "https://openrouter.ai/api/v1"
    model_name: deepseek/deepseek-v4-flash
    api_key: ${OPENROUTER_API_KEY}
    # max_tokens / max_retries / reasoning_effort tuned per role
```

The config defines several LLM "roles" (intent classification, the main
super-model, the deep-research model, summarization) so different steps can use
different models/parameters. Point them all at your endpoint to switch providers.

## To use a different provider

1. Copy the reference config (or edit it).
2. Set each `llms.*` block's `base_url`, `model_name`, and `api_key` env to your
   endpoint.
3. Set the embedder similarly (embeddings must also be OpenAI-compatible).
4. Set `CONFIG_FILE` to your config and provide the key(s) in `deploy/.env`.

## Runtime per-org model overrides (ADR-0014)

The YAML remains the *default* layer. On top of it, org admins can re-point
each **agent group** (intent, clarifier, shallow research, deep research,
deep-research router, memory reflection) at a different OpenRouter model at
runtime — per tenant, versioned, validated against the OpenRouter catalog,
no restart. The BFF forwards the active configuration as the
`x-grid-model-overrides` header on the WS upgrade; the backend applies it
request-scoped (only the model id changes — `base_url`, keys, `max_tokens`,
`reasoning_effort` still come from the YAML). Absent/invalid overrides fall
back to the YAML defaults. See
[`org-model-configuration.md`](org-model-configuration.md).

Every generation's cost is metered into the `llm_usage_events` ledger and
bounded by per-org/member/project budgets — see
[`usage-budgets.md`](usage-budgets.md) (ADR-0015).

## Caveats

- Prompts are tuned against the reference model; very different models may need
  prompt adjustments.
- A blank or `${VAR}`-literal key (a common `env_file` interpolation mistake) is
  treated as **unset** by the config-validation guard, failing fast rather than
  sending unauthenticated requests.
- The legacy Kimi config (`config_grid_oib.yml`) is **unmaintained/broken** — do
  not use it as a starting point; base new configs on the OpenRouter reference.
- No call site sets provider prompt-caching hints on static prompt prefixes
  (orchestrator/planner/researcher/writer system prompts, tool registry,
  source registry) — every LLM call resends them in full. See
  [`scaling-review-2026-07.md`](scaling-review-2026-07.md) §6.1 for the cost
  impact. On the deep-research graph specifically, even enabling provider
  caching would be undercut by `ToolResultPruningMiddleware`'s
  positional sliding-window truncation, which shifts message bytes on
  nearly every model call — see
  `src/aiq_agent/agents/deep_researcher/README.md` "Known limitations".
- **No LLM request timeout (known limitation, fix pending).** No `llms.*`
  block in any shipped config sets `request_timeout`. NAT's
  `OpenAIModelConfig` (`nat/llm/openai_llm.py`) declares
  `request_timeout: float | None = Field(default=None, ...)`, so an unset
  value leaves the underlying HTTP client's timeout unbounded. The only
  app-level ceilings on an LLM call are the intent classifier's
  `asyncio.wait_for` (`llm_timeout`, default 90 s —
  `chat_researcher/nodes/intent_classifier.py`) and card generation's 30 s
  (`cards/generate.py:_CARD_LLM_TIMEOUT_S`); every other call site —
  deep-research orchestrator/planner/researcher/writer turns, the
  clarifier, memory reflection — has neither an HTTP-level nor an
  app-level timeout. `recursion_limit` (2000 for deep research) bounds
  graph *steps*, not wall-clock time, so a single stalled provider response
  can block a run indefinitely.
- **Retry stacking (known limitation, tuning pending).** Retries compound
  across three independent, uncoordinated layers with no shared budget or
  deadline: the per-role client-level `max_retries` in the YAML (5 for most
  roles, 10 for the deep-research orchestrator/planner — see
  `configs/config_oib_openrouter.yml`), `ModelRetryMiddleware(max_retries=2,
  ...)` (retries on *any* exception), and `SelectiveToolRetryMiddleware(
  max_retries=3, ...)` (retries on anything except `ValueError`) — both
  middleware in the deep-research stack
  (`agents/deep_researcher/factory.py`). Worst case for a single logical
  model turn is on the order of ~33 attempts with independently
  compounding backoff at each layer. See
  [`scaling-review-2026-07.md`](scaling-review-2026-07.md) §6.3 for how
  this multiplies again across concurrent runs.
- `reasoning_effort` is a **native** `ChatOpenAI` field
  (`langchain_openai`'s `BaseChatOpenAI.reasoning_effort`), not something
  routed through `extra_body`: NAT's `OpenAIModelConfig` allows extra YAML
  keys (`model_config = ConfigDict(..., extra="allow")`) and the LangChain
  client picks the field up directly, translating it to the provider's
  native `reasoning` payload shape where needed (e.g. OpenRouter). No app
  code shuttles it manually — worth knowing so it isn't mistaken for one of
  the `extra_body`-routed OpenRouter-specific knobs (see
  `aiq_agent.common.llm_factory`).
