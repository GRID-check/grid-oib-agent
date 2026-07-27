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
- No call site sets *explicit* provider prompt-caching hints on static prompt
  prefixes (orchestrator/planner/researcher/writer system prompts, tool
  registry, source registry) — every LLM call resends them in full. See
  [`scaling-review-2026-07.md`](scaling-review-2026-07.md) §6.1 for the cost
  impact. What the fleet *does* set (build-time, in `llm_factory`) is a
  first-party routing pin for `deepseek/*` models on OpenRouter —
  `provider: {"order": ["deepseek"], "allow_fallbacks": true}` — because live
  OpenRouter endpoints data shows only the first-party `deepseek` host supports
  *implicit* prompt caching (all third-party hosts report
  `supports_implicit_caching=false`), so default load-balancing would scatter
  requests across uncached hosts and destroy the prefix-cache hit rate. This
  makes implicit caching reachable but sets no explicit cache_control breakpoints.
  On the deep-research graph specifically, provider caching used to
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
  This is in addition to, not a replacement for, the intent classifier's
  `asyncio.wait_for` (`llm_timeout`, default 90 s) and card generation's 30 s
  app-level timeouts. `DeepResearcherAgent` additionally gained a wall-clock
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
