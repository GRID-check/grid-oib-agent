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

```
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
