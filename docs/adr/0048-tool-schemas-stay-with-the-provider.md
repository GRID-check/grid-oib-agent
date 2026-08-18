# ADR-0048: Tool schemas stay with the provider, and a namespace is what makes that true

- **Status:** Proposed
- **Date:** 2026-08-14
- **Deciders:** Grid engineering
- **Related:** ADR-0045 (IFC models as a queryable building), ADR-0046 (agent skills), ADR-0014 (org model overrides), ADR-0022 (BYOK / org-disabled sources)

## Context

The shallow researcher binds eleven tools and force-synthesizes after five tool
iterations. Two of those eleven — `ifc_query` and `ifc_measure` — carry the
descriptions that make them usable at all: twelve documented operations, a
provenance vocabulary, the refusal cases. Measured through the real builder,
`ifc_query` + `ifc_measure` + `emit_card` are **59 805 characters of JSON
schema, ≈14 000 input tokens**, and they ride on every request the agent makes,
including the ones that never touch the building.

The repo already answered the "which tools" half of this in
`shallow_researcher/tool_search.py`: a local BM25 ranking narrows the bound set
*outside* the tool loop, because this agent cannot afford to spend one of five
iterations on a discovery call. That module's own docstring states the
constraint this ADR inherits — **turns are the scarce resource, not tokens** —
and it is switched off in production because on eleven tools the recall it risks
is worth more than the schemas it saves.

OpenRouter's Responses API offers the other half. Tools can be declared
*deferred*: their schemas stay server-side, a `tool_search` tool is sent
alongside, and the model searches, loads and calls the one it needs **inside a
single response**. Verified live against `openai/gpt-5.6-luna` — one HTTP
request, output items `[reasoning, reasoning, reasoning, function_call]`, the
`function_call` naming `ifc_measure` and carrying `"namespace": "piloti"`. No
extra round trip, no extra turn, nothing new for the graph to route.

### The failure this is really about

`defer_loading: true` on a top-level function tool is **silently dropped**.
OpenRouter's `FunctionTool` schema has no such field, so the flag never leaves
the client and the request arrives with a `tool_search` tool and nothing to
search. There is no warning. The observable symptom is a 400 from the upstream
provider:

```text
Invalid Value: 'tools.tool_search'.
tools.tool_search requires at least one deferred tool.
```

Only `NamespaceFunctionTool` carries `defer_loading`, so the functions must be
wrapped in a single `namespace` tool. Reproduced both ways at the raw HTTP
level: flat + `defer_loading` → 400; namespaced + `defer_loading` → 200 and a
correct tool call.

That the *loud* failure is a 400 is luck, not design. A provider that accepted
the request and ignored the flag would produce a system that looks configured,
answers correctly, and quietly pays full price forever — which is the actual
risk this ADR is written against.

### langchain-openai already has a version of this, and it is the broken one

`langchain-openai` 1.2.2's `bind_tools` copies `tool.extras["defer_loading"]`
onto the formatted tool — producing a **top-level** function with
`defer_loading`, exactly the shape OpenRouter drops. Using the library's own
support would be the silent-failure path.

## Decision

**Reshape the tool payload at the binding seam, not in a middleware, and prove
it defers three times over.**

### Where the reshaping lives

`src/aiq_agent/common/deferred_tool_loading.py`, behind one function —
`bind_tools_deferred(llm, tools, settings=…)` — which every research-turn
binding goes through (`ShallowResearcherAgent._bind_research_tools`).

The in-house precedent for rewriting a model request is
`ToolVisibilityMiddleware` in `deep_researcher/custom_middleware.py`, which
overrides `request.tools` in `wrap_model_call`. It was **not** the right shape
here, for a structural reason: `AgentMiddleware` only runs under
`create_agent`, and the agent this feature exists for does not use it. The
shallow researcher builds a raw `StateGraph` and calls `llm.bind_tools(...)`
directly at three sites (construction, tool-search-narrowed, meta). A
middleware would have applied to `deep_researcher` — which is not
turn-budgeted, is not the surface carrying the BIM schemas, and whose
orchestrator is the one place a wrong tool set is most expensive — and missed
the agent named in the problem entirely.

What *is* reused from that precedent is its tool-name traversal. There is now
one `tool_payload_name`, in this module, and `custom_middleware._request_tool_name`
delegates to it: the payload builder has to read identity out of the same three
shapes (`BaseTool`, chat-shaped dict, flat Responses dict), and a second
traversal would have drifted from the first.

Meta turns are deliberately excluded. They bind only `remember` and `emit_card`,
whose schemas are a few hundred characters, and the tool-search apparatus costs
~620 input tokens of its own — deferring there spends more than it withholds.

### NAT needed no shim

`OpenAIModelConfig` inherits `api_type` from `LLMBaseConfig`, and
`nat.plugins.langchain.llm.openai_langchain` already builds
`ChatOpenAI(use_responses_api=True, use_previous_response_id=True)` when it is
`responses`. One line of YAML on `shallow_llm` — `api_type: responses` — is the
whole enablement. This is worth recording because the repo's previous two
encounters with this class of problem (`DeferredStructuredOutputMiddleware`,
`enforce_chat_request_contract`) both needed workarounds, and the reflex to
write a third would have been wrong.

### Three checks, because a silent strip must be impossible

1. **The payload we build** — `build_deferred_tool_payload` asserts its own
   output before returning it: a `tool_search` tool is present, there is exactly
   one namespace, every nested function carries `defer_loading`, and no function
   tool sits at the top level where the flag is dropped.
2. **The payload that goes over the wire** — `assert_request_defers_tools` runs
   `langchain-openai`'s own `_get_request_payload` and asserts the same rules on
   the result. Between (1) and (2) sit every rewrite this module does not
   control: the chat-shape flattening, a future version's own `defer_loading`
   handling, and the Chat-Completions path, which drops the namespace entirely.
3. **What the provider accepted** — `verify_deferred_tool_loading` issues one
   canary request at **workflow build time** and reads the `tools` OpenRouter
   echoes back. If the namespace returns without `defer_loading`, the build
   **raises**.

Build time is the only place raising is free: no user turn exists yet, and an
operator who wrote `enabled: true` under a Chat-Completions LLM finds out at
startup rather than from the token bill.

### A fourth check, per MODEL, because the endpoint is not the capability

Checks 1–3 establish that *we* built the shape and that *the endpoint* accepted
it. None of them asks whether **this model** accepts it — and the per-org
override seam (ADR-0014) changes the model per request, after the build-time
probe has run. An override to a non-supporting model passed both the OpenRouter
check and the Responses check, sent the deferred payload, and got a 400.

So `bind_tools_deferred` consults `model_supports_deferred_tool_loading`, which
requires **two independent conditions** to hold:

1. **The model can carry the shape.** Config first — `deferred_tool_loading.models.deny`,
   then `.allow`, then `.provisional` (exact ids or explicit globs, operator-controlled,
   no network) — then a cached probe verdict, then "no".
2. **The model clears `deferred_tool_loading.min_intelligence_index`** (default
   50), read from Artificial Analysis's `intelligence_index`. An *unscored*
   model fails the floor rather than slipping under it.

Neither condition implies the other, which is the whole reason both exist:
`x-ai/grok-4.6` scores 60.9 — higher than all but two allowlisted models — and
cannot defer at all; `anthropic/claude-sonnet-4.6` defers (it was one of six
models observed emitting a real `function_call`) and is excluded on score alone.

**A vendor prefix is the wrong key, and this was measured.** Anthropic ships its
own tool search, so Claude carries the shape while `openai/gpt-4o-mini` does
not — an `openai/gpt-5.*` allowlist would wrongly exclude working models and a
"not Anthropic" rule would wrongly exclude others. Model *metadata* cannot
answer it either: `GET /api/v1/models` exposes `supported_parameters`, and
across all 411 models that vocabulary contains no `tool_search`, no
`defer_loading` and no `namespace` token — every model measured advertises
`tools`, including the ones that 400. **Empirical, per model id, or nothing.**

Verification means the provider **echoed `defer_loading` back on every
function**, not merely that it returned HTTP 200. A provider that accepts the
request and normalizes the deferral away is precisely the silent failure this
ADR exists to prevent, so a bare 200 must never seed the allowlist.

**Some models have no stable per-model answer at all.** `meta-llama/llama-3.3-70b-instruct`
returned 200-and-defers on 5 of 6 identical requests and 422 on the sixth;
`deepseek/deepseek-v4-flash-0731` disagreed between two sweeps. OpenRouter
spreads those models across provider endpoints that do not agree, so the
capability is decided *per request*, after any gate has run. Both are denied for
being **unreliable rather than incapable** — a distinction worth keeping,
because the fix if it ever matters is pinned provider routing, not a re-test.

For a model in none of the lists, one probe runs **off the request path** and
its verdict is cached per model id (bounded, oldest-first eviction). Until it
lands the model is treated as unsupported, so an unknown model gets full schemas
instead of the wasted round trip. Probing inline was rejected: it would put a
live HTTP round trip in front of a user turn to decide whether a *different*
round trip is worth making — the same latency, merely relocated.

**A transient error is never a capability verdict.** Only a 400/422 — the
statuses a provider uses to reject the request *shape* — writes a durable
"unsupported". A 5xx, 408, 429, timeout or dropped connection leaves the model
unclassified and re-probable, capped at three attempts. The 401/403 case is
load-bearing rather than theoretical: `meta/muse-spark-1.1` answers 403
"requires 18+ age confirmation", an **account** gate that fires before the
payload is read. Caching that as "unsupported" would leave the model
permanently degraded even after the account is cleared.

`meta/muse-spark-1.1` is therefore listed as **provisional**: permitted on the
operator's instruction with its capability still unverified. Unlike an `allow`
entry (an assertion that outranks observation), a provisional entry *yields* to
whatever the probe or a real request learns. Being wrong costs one wasted round
trip per distinct tool subset and then latches — bounded and self-correcting,
which is what the fallback is for. It is a deliberate, informed exception, not a
precedent for listing unverified models generally.

**Nothing here can fail a request or a build.** Every "no" above means *bind the
full schemas*, which is what the agent did before any of this existed. The floor
answers "is deferring worth it for this model", never "may this model be used" —
a sub-floor model runs exactly as it always has and simply pays today's token
cost. The one contradiction that still raises at build time is denying the
workflow's *own* model while enabling the feature, because that configuration is
dead on arrival; a *floor* miss only warns.

**This is not a fleet model policy, and must not become one.** The lists, the
scores and the floor all live on the per-agent `DeferredToolLoadingSettings`,
never in module scope, so two agents could hold different policies at once.
`deferred_tool_loading` sits under `shallow_research_agent`, `api_type: responses`
is on `shallow_llm` alone, and the module is imported only by that agent — so
`intent_classifier`, `clarifier_llm`, `summary_llm` and the `deep_*` roles never
enter this path. Deferral pays only where a large tool surface meets a tight
turn budget (~60 KB of BIM schemas on a 5-iteration budget); an intent
classifier has nothing worth deferring, and a cheap sub-50 model is the *right*
choice for classification, so a floor applied there would be actively wrong.

The one deliberately process-wide piece is the probe verdict cache: "does this
model accept the shape" is an observed fact about the provider, not a policy,
and it is the same answer for whoever asks.

### At request time it degrades, it never fails

`DeferredToolBinding` holds both bindings. Any error from the deferred path logs
at ERROR, falls through to the ordinary full-schema binding, and **latches** —
the remaining four iterations do not each re-pay for the same failing round
trip. A failure costs tokens; it never costs a turn or an answer.

### Off by default, per deployment

`deferred_tool_loading.enabled` defaults to `false`. `config_grid_oib.yml` runs
`kimi-for-coding` against `api.kimi.com/coding/v1` on Chat Completions, where
none of this exists; the client-side BM25 narrowing stays exactly as it is and
remains that deployment's only lever. Even with the flag forced on, a
non-OpenRouter or non-Responses model falls back to the full binding, because
the per-org override seam (ADR-0014) can hand a single turn a model the workflow
was never built against.

## Consequences

### The trade is not the one it looks like

Measured live, same model, same real schemas:

| | control | deferred | delta |
|---|---:|---:|---:|
| turn 1, model loads a tool | 14 032 | 14 650 | **+618** |
| turn 1, no tool needed at all | 14 023 | 437 | **−13 586** |
| turn 2, answering from a tool result | 14 163 | 591 | **−13 572** |

Deferral saves **nothing** on the turn where the model loads a schema — the
schema enters the context anyway and the tool-search apparatus is charged on
top. What it saves is every *other* turn, and on a five-iteration agent that
calls one or two tools those are the majority: the synthesis turn, the meta
turns, and every turn answered from a tool already loaded.

Stated the way it should be read: this does not make the expensive turn cheaper,
it makes the cheap turns cheap. A deployment whose questions all hit
`ifc_measure` on turn 1 and stop should not enable it.

### What we accept

- **A second search surface.** The namespace `description` is now the only tool
  text sent up front, so it is what the server-side search matches the user's
  turn against. It is German, because the questions are. A tool the description
  does not evoke is a tool the model may not find — the same recall risk
  `tool_search.py` documents, moved server-side and no longer inspectable from
  our logs.
- **Behaviour can shift.** In the measured run the deferred arm called
  `emit_card` on a question where the control arm called nothing. Deferral
  changes what the model sees when it decides, so it changes decisions.
- **One extra request at startup**, per workflow build, for the capability
  probe. A transport failure there is explicitly *not* treated as evidence: it
  is logged and the feature is left enabled to be judged at request time, where
  it degrades.
- **A model list that ages.** The allowlist and the pinned `intelligence_index`
  scores are static, so a newly released model defers only once the probe has
  classified it (one off-path request), and a rescore needs a config edit —
  `models.intelligence_index` overrides any pinned entry without a release.
  Fetching scores live at build time was rejected: it is this table *plus* a
  network dependency, because a fetch that can fail must fall back to hardcoded
  scores anyway, so the live path cannot remove the table — only add a startup
  failure mode. Worse, it would let the set of deferring models change under a
  running deployment with no config change, which is the same class of surprise
  (the model moved and nobody said so) that the gate exists to eliminate.
- **The allowlist criterion is "the provider accepted and echoed the deferred
  shape", not "the model was watched calling a tool through it".** Acceptance is
  the condition that decides whether the request succeeds, so it is the right
  gate; but only `openai/gpt-5.6-{luna,sol,terra}`, `anthropic/claude-opus-4.8`,
  `anthropic/claude-sonnet-4.6` and `anthropic/claude-fable-5` were additionally
  seen emitting a `function_call` end to end. Stated precisely so nobody reads
  the list as stronger evidence than it is.

## Alternatives considered

- **A `search_tools` tool the model calls first.** Rejected for the reason
  `tool_search.py` already gives: it costs one of five iterations, i.e. 20 % of
  everything the agent will ever do about the question, before it can look at
  the building. OpenRouter's version costs zero turns, which is the only reason
  this ADR exists at all.
- **`bind_tools(tool.extras["defer_loading"])`, langchain-openai's own path.**
  It emits the top-level flat function OpenRouter silently drops. It is the bug,
  not the feature.
- **An `AgentMiddleware`.** Only runs under `create_agent`; the shallow
  researcher does not use it. See *Where the reshaping lives*.
- **A contract subclass in `llm_factory`**, like `enforce_chat_request_contract`.
  It would apply fleet-wide from one place, but the payload has to know *which*
  tools are the agent's, and it would defer for every role — including the
  routers and the card generator, which bind nothing worth deferring.
- **Replacing the client-side BM25 with this.** Rejected: they answer different
  questions (which tools are bound vs. whether their schemas travel), they
  compose, and the BM25 path is the only one `config_grid_oib.yml` can use.
- **Gating on a vendor prefix** (`openai/gpt-5.*`, "Anthropic supports it").
  Rejected on measurement, twice over: Claude defers and `gpt-4o-mini` does not,
  so a prefix is wrong in both directions; and `x-ai/grok-4.6` at 60.9 cannot
  defer while `google/gemini-3.5-flash` at 52.0 can, so capability tracks
  neither vendor nor quality nor recency.
- **Gating on OpenRouter's `supported_parameters` metadata.** Rejected: the
  vocabulary across all 411 models has no token for this capability, and every
  model measured — supporting and non-supporting alike — advertises `tools`. It
  separates none of the observed cases.
- **Probing inline before the binding.** Rejected: a live round trip in front of
  a user turn, to decide whether another round trip is worth making. The probe
  runs off the request path instead and the discovering turn simply gets full
  schemas.
- **Fetching `intelligence_index` live at build time.** Rejected — see
  *Consequences*: it cannot replace the static table, only add a failure mode.
