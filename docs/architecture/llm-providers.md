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
**reference config** is `configs/config_oib_openrouter.yml` (OpenAI GPT-5.6 Luna
+ embeddings via OpenRouter). The `model_name` values there are the boot floor
only — the model a served request runs on is an admin decision resolved at
runtime (see `org-model-configuration.md`), except for `summary_llm` and
`rerank_llm`, which have no agent group and always use the config file.

```yaml
# configs/config_oib_openrouter.yml (excerpt) — an OpenAI-compatible LLM
llms:
  shallow_llm:
    _type: openai
    base_url: "https://openrouter.ai/api/v1"
    model_name: openai/gpt-5.6-luna
    api_key: ${OPENROUTER_API_KEY}
    # max_tokens / max_retries / reasoning_effort tuned per role
```

The config defines several LLM "roles" (the main super-model, the clarifier,
the deep-research models, summarization) so different steps can use
different models/parameters. Point them all at your endpoint to switch providers.

## To use a different provider

1. Copy the reference config (or edit it).
2. Set each `llms.*` block's `base_url`, `model_name`, and `api_key` env to your
   endpoint.
3. Set the embedder similarly (embeddings must also be OpenAI-compatible).
4. Set `CONFIG_FILE` to your config and provide the key(s) in `deploy/.env`.

## Runtime per-org model overrides (ADR-0014)

The YAML remains the *default* layer. On top of it, org admins can re-point
each **agent group** (clarifier, shallow research, deep research,
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
  impact. On the deep-research graph specifically, provider caching used to
  be further undercut by `ToolResultPruningMiddleware` shifting message
  bytes on nearly every model call; that truncation is now monotonic
  (2026-07-16, `0b5d29d`), removing that specific defeat — see
  `src/aiq_agent/agents/deep_researcher/README.md` "Known limitations" — but
  no provider caching hints are actually set yet, so this remains an open
  cost lever regardless.
- **LLM request timeouts — fixed 2026-07-16 (`590ba1a`).** Every `llms.*`
  block in `configs/config_oib_openrouter.yml` now sets `request_timeout`
  (60–180 s depending on role) and `max_retries: 2`, so an unresponsive
  upstream call can no longer hang a run indefinitely at the HTTP layer.
  This is in addition to, not a replacement for, card generation's 30 s
  app-level timeout. `DeepResearcherAgent` additionally gained a wall-clock
  `max_run_seconds` budget (config key, default 2400 s; `0` disables) around
  the whole run via `asyncio.wait_for` — `recursion_limit` still bounds graph
  *steps*, not time, but the run as a whole is now bounded either way.
- **Retry stacking — tamed 2026-07-16 (`590ba1a`, `0b5d29d`).** Per-role
  client-level `max_retries` in the YAML dropped from 5–10 to a uniform `2`
  across every role (`configs/config_oib_openrouter.yml`). The deep-research
  middleware retry predicates were also narrowed: `ModelRetryMiddleware`
  (`agents/deep_researcher/factory.py`) now retries only rate limits,
  timeouts, transport errors, and 5xx (`_is_transient_model_error`) instead
  of any exception, and `SelectiveToolRetryMiddleware`
  (`agents/deep_researcher/custom_middleware.py`) retries on anything except
  `ValueError` — the model's own "invalid input" signal, which a retry can
  never fix. Retries across the three layers (client, model middleware, tool
  middleware) are still independent and uncoordinated (no shared budget or
  deadline), but the worst case per logical turn is now on the order of a
  handful of attempts, not ~33. See
  [`scaling-review-2026-07.md`](scaling-review-2026-07.md) §6.3 for the
  cross-run multiplication this still doesn't address (bounded fan-out, not
  a shared retry budget).
- **`api_type: responses` is a per-ROLE opt-in, not a fleet default
  (ADR-0048).** `LLMBaseConfig.api_type` (`chat_completion` | `responses`) is
  already understood by NAT: `nat.plugins.langchain.llm.openai_langchain`
  builds `ChatOpenAI(use_responses_api=True, use_previous_response_id=True)`
  when it is `responses`, so no app-side shim exists or is needed. Only roles
  that require a Responses-only capability set it — today that is
  `shallow_llm` when `shallow_research_agent.deferred_tool_loading` is
  enabled, because OpenRouter's server-side tool search has no Chat
  Completions equivalent. Enabling that feature without this line fails the
  workflow build deliberately (`verify_deferred_tool_loading`) rather than
  sending the tool schemas anyway. Every other role stays on the default;
  `configs/config_grid_oib.yml` (Kimi, Chat Completions) cannot use either.
- **`api_type: responses` is necessary but NOT sufficient — deferral is gated
  per MODEL (ADR-0048).** The endpoint decides whether the *client* can express
  OpenRouter's `tool_search` + `namespace` shape; whether the model on the other
  end accepts it is a separate question, and the per-org override seam
  (ADR-0014, `model_overrides`) changes that model per request — after the
  build-time probe has run. So `bind_tools_deferred` also consults
  `model_supports_deferred_tool_loading`, which requires two independent
  conditions: the model is cleared for the shape (`deferred_tool_loading.models`
  — `deny`, then `allow`, then `provisional`, then a cached probe verdict), and
  it clears `deferred_tool_loading.min_intelligence_index` (default 50, from
  Artificial Analysis's `intelligence_index`; an unscored model fails it).
  Measured facts worth not re-deriving:
  - **Capability tracks neither vendor nor quality.** `anthropic/claude-sonnet-4.5`
    and Claude generally carry the shape; `openai/gpt-4o-mini` 400s. `x-ai/grok-4.6`
    scores 60.9 and cannot defer; `google/gemini-3.5-flash` at 52.0 can. A
    vendor-prefix or "use the best model" rule is wrong in both directions.
  - **`supported_parameters` cannot answer it.** No `tool_search` /
    `defer_loading` / `namespace` token exists in that vocabulary across all 411
    models, and every model measured advertises `tools` — including the ones
    that reject the shape.
  - **Some models have no stable answer.** `meta-llama/llama-3.3-70b-instruct`
    returned 200-and-defers 5 times in 6 and 422 once; OpenRouter spreads it
    over provider endpoints that disagree. Denied for unreliability, not
    incapacity.
  - **A transient error is not a verdict.** Only 400/422 caches "unsupported";
    5xx/408/429/timeouts leave the model re-probable. A 403 account gate
    (`meta/muse-spark-1.1`: "requires 18+ age confirmation") must never be cached
    as a capability answer.
  None of this can fail a request or a build — every "no" means *bind the full
  schemas*, i.e. the pre-ADR-0048 behaviour. The gate is scoped to
  `shallow_research_agent` and lives on its per-agent settings object, never in
  module scope: it is not, and must not become, a fleet-wide model policy.
  Since ADR-0052 the shallow agent binds its full tool set on every turn,
  greetings included, so this gate is what keeps the per-turn schema floor
  from growing with the tool list.
- `reasoning_effort` is a **native** `ChatOpenAI` field
  (`langchain_openai`'s `BaseChatOpenAI.reasoning_effort`), not something
  routed through `extra_body`: NAT's `OpenAIModelConfig` allows extra YAML
  keys (`model_config = ConfigDict(..., extra="allow")`) and the LangChain
  client picks the field up directly, translating it to the provider's
  native `reasoning` payload shape where needed (e.g. OpenRouter). No app
  code shuttles it manually — worth knowing so it isn't mistaken for one of
  the `extra_body`-routed OpenRouter-specific knobs (see
  `aiq_agent.common.llm_factory`).
- **Reasoning-effort contract (2026-07-16, `590ba1a`).** Every shipped
  config's `reasoning_effort` value is now drawn from OpenRouter's *standard*
  vocabulary — `none`/`minimal`/`low`/`medium`/`high`/`xhigh` (the reference config
  currently uses `none` for the cheap/fast roles and `medium` elsewhere) —
  and sent through verbatim, with no per-provider translation layer in app
  code. This is intentional and safe, not a gap: OpenRouter maps that
  standard value to the nearest level the request's *actual* model supports,
  server-side, per model, so the same YAML value is correctly interpreted
  regardless of which model ultimately serves the request (including an
  org's runtime model override — see `org-model-configuration.md`). The
  corollary is a hard constraint on config authoring: **provider-native tiers
  that aren't OpenRouter-standard (e.g. DeepSeek's own `max` tier) are not
  legal values and must never appear in a config** — OpenRouter has no
  mapping for them, so behavior at the provider is undefined.
