---
status: accepted
date: 2026-09-27
decision-makers: Grid engineering, product owner
consulted:
informed: everyone working in this repo
---

# Use the NeMo Agent Toolkit as designed: NAT runs the workflow, LangGraph streams natively, and the chat wire is ours

## Context and Problem Statement

The repo started from NVIDIA's AI-Q Blueprint and runs on the NeMo Agent
Toolkit (NAT, `nvidia-nat*==1.7.0`, Apache-2.0, self-hosted like everything
else; 1.9.0 shipped 2026-09-10). The agents are LangGraph graphs (Piloti, the
deep researcher) with LangGraph's Postgres checkpointer, on OpenRouter. NAT
owns what surrounds them: tool and agent registry, YAML config, the FastAPI
front end and its WebSocket protocol, HITL, the intermediate-step stream,
OTel export, the async job store, `nat run` and `nat eval`.

55 non-test files import `nat` (96 with tests), 34 `@register_function`
decorators in 21 files. Most of that is NAT used as designed and works. The
pain sits in one place, the chat wire, where we fight NAT instead of using it:

- **Three module assignments into NAT** (`websocket_reconnect.py:1852-1915`,
  `install_reconnectable_handler`, `# TODO: upstream to NAT`) swap
  `WebSocketMessageHandler` in two modules and replace
  `routes.websocket.websocket_endpoint`, to get auth, conversation binding and
  our handler in. NAT has no hook for the handler class, in 1.7 or 1.9.
- **The stock StepAdaptor is the UI wire.** We run its unconfigured `DEFAULT`
  mode, which forwards every LLM/TOOL/FUNCTION step. On each
  `LLM_NEW_TOKEN` it stringifies the whole prompt (`str(start_step.data.input)`)
  and re-joins every earlier chunk by scanning an unbounded `_history`: one
  ~25 KB frame per token chunk, O(n²) on the event loop. `CUSTOM` steps are
  rendered as an HTML-escaped markdown code block of `str(payload)`, so
  `turn_status.py` disguises status lines as balanced FUNCTION steps and the
  UI regex-parses NAT function names (`intermediate-step-parser.ts`, 350 lines).
  Checked in the 1.9.0 source: both behaviours are unchanged.
- `workflow_stream.py` (184) replaces `generate_streaming_response`, whose
  producer task is not cancelled when the consumer stops (err2issue #334,
  #337, #338, #759). Unchanged in 1.9.0.
- `nat_step_repair.py` (187) adds the `on_llm_error`/`on_tool_error` that
  NAT's LangChain profiler handler lacks. Still missing in 1.9.0.
- `deploy/start_web.py` (302) bypasses `nat serve`'s nested event loop.

The product owner's position: NAT is not the problem, how we use it is, and
this is not an either/or.

## Decision Drivers

* The reader's wire (answer deltas, cards, Herleitung, HITL) must be a typed
  contract we own, because ADR-0066's settle/verify, ADR-0065's A2UI and
  ADR-0039's spectators are all shaped around it.
* No assignment into a third-party module. Extension goes through a
  documented seam or through code we own.
* Keep what NAT does well and we have no reason to rebuild: registry and
  config, telemetry export, eval and profiler, the job store, MCP.
* Self-hosted, licence-clean: nothing that needs a licence key or phones home.
* One cut, not a migration: the backend and the UI ship together from this
  monorepo, so the new wire replaces the old in one change with no dual-read
  period (the product owner's call, 2026-09-27, once the trace had shown what
  the old wire costs). The answer suite shows no regression.

## Considered Options

* **A. Use NAT as designed.** NAT keeps registry, config, runtime, telemetry,
  eval and job store. Inside the workflow function, the graph streams with
  `graph.astream(stream_mode=["messages","updates","custom"])` and
  `get_stream_writer()` emits cards, status and Herleitung steps as typed
  events. The chat WebSocket is ours, registered through NAT's supported
  worker seam. NAT's intermediate steps go to telemetry only.
* **B. Leave NAT: LangGraph OSS as a library in our own FastAPI** (MIT).
  Everything in A, plus replacing registry, config, job store, exporters and
  `nat run`/`nat eval`.
* **C. LangGraph Server** (`langgraph-api`) with `@langchain/langgraph-sdk`
  `useStream`.
* **D. Stay as we are, upgrade to 1.9, keep the patches.**

## Decision Outcome

Chosen option: **A**, because the evidence puts the cost in the chat wire and
not in NAT's core. Of the 13 NAT-related rows in
`docs/contributing/gotchas.md`, 3 are the streaming/WS path; the others are
discovery, config, `nat run`, telemetry and tool binding, and those do not go
away by owning the wire. A removes every assignment into NAT and the
StepAdaptor-shaped wire, and keeps the parts that work. It is also the first
phase of B, so B stays open and costs no rework if we choose it later.

What A means concretely:

1. **The WebSocket route is ours, registered the supported way.** Set the
   workflow endpoint's `websocket_path: null` in the `aiq_api` front-end
   config so NAT registers no WS route, and add ours in
   `AIQAPIWorker.add_routes` (the `runner_class` worker subclass we already
   ship), with its own session manager. `install_reconnectable_handler` and the
   three assignments are deleted. The handler may keep subclassing NAT's
   public `WebSocketMessageHandler` for its run loop, or compose it.
2. **The step adaptor is off for the wire.** `step_adaptor: {mode: off}`.
   Intermediate steps still reach the OTel/Langfuse exporters, which subscribe
   to the step manager, not to the adaptor. What the reader sees comes from the
   graph: the workflow function consumes
   `astream(stream_mode=["messages","updates","custom"])` and yields typed
   items on its own stream, which our handler writes as `v: 2` frames (the
   only version; `v: 1` is deleted in the same change) with
   AG-UI event names (`TEXT_MESSAGE_CONTENT`, `STEP_STARTED/FINISHED`,
   `CUSTOM`, `RUN_FINISHED`, `RUN_ERROR`). `turn_status.push_custom_step`
   becomes a `get_stream_writer()` call.
3. **HITL keeps NAT's designed path now:** `Context.user_interaction_manager
   .prompt_user_input`, answered by our handler's `human_interaction_callback`
   and the conversation bus, on our own `interaction_request`/`_response`
   frames. LangGraph `interrupt()` + `Command(resume=...)` is a separate,
   later decision (see Consequences).
4. **Upgrade to 1.9** for its public plugin API (runtime context and HITL
   models exported, so we stop importing internals), WebSocket identity
   validators and reconnection bound to user identity (we patched the same
   hole in 2e3ea1ea), and `HITLMiddleware` as a candidate for approving write
   tools.
5. **Upstream the three fixes we carry** (producer task cancellation,
   profiler `on_*_error`, bounded StepAdaptor) as NVIDIA PRs, and delete our
   copy when a release takes them.

### Consequences

* Good, because these disappear: the monkeypatch (~70 lines) and the NAT
  wire-model plumbing in `websocket_reconnect.py` (1 916 lines; the NAT
  adaptation, frame conversion and HITL pairing are an estimated 800-1 000 of
  them), the FUNCTION-step disguise in `turn_status.py` (1 740), `human_prompt.py`'s
  prompt/response pairing (117) once HITL frames are ours, `nat_converters.py`
  (80), and on the UI the NAT-name regex in `intermediate-step-parser.ts` (350)
  and the NAT half of `step-event-schemas.ts` (364) and `schemas.ts` (743).
* Good, because frame size stops scaling with prompt size, and a status line,
  a card or a Herleitung step is one typed `writer({...})`.
* Good, because a NAT upgrade no longer re-validates a patch of its WS
  internals; the seam we depend on (`runner_class`, `add_routes`,
  `websocket_path`, `step_adaptor`) is configuration.
* Neutral, because what is product stays and moves unchanged: auth and the
  signed context envelope, conversation binding, admission, BFF persistence,
  heartbeat, stage frames, ADR-0066 settle/verify, A2UI, the spectator relay,
  cost tracking and the profiler (already LangChain callbacks), the job queue.
* Neutral, because checkpoint-based resume would not replace the Dragonfly
  frame replay: a checkpoint is a superstep snapshot, not the token and step
  stream a reconnecting reader or a spectator needs. It would remove the HITL
  future, the bus's `HITL_ANSWER`/`RECONNECT` messages and HITL's reason for
  affinity (ADR-0028). It needs a checkpointer on the Piloti graph (it has
  none; per-turn state arrives in headers, ADR-0003), and an interrupted node
  re-runs from its top on resume, which the per-turn ContextVar registries
  (cards, citations, the `ask_user` slot) do not survive. Hence its own ADR.
* Bad, because the WS wire contract changes in one cut: every
  `frontends/ui/src/adapters/api/*-wire.spec.ts` is rewritten, and a browser
  tab still on the old bundle gets a reload prompt instead of a working turn
  until it refreshes (a deploy restarts every socket anyway).
* Bad, because `workflow_stream.py` and `nat_step_repair.py` stay until NVIDIA
  merges the fixes, and registry/config gotchas (plugin discovery, unbound
  tools, `nat run` not exiting) stay with NAT.

### Confirmation

A test that imports the NAT front-end modules after app startup and asserts
their `WebSocketMessageHandler` and `websocket_endpoint` are NAT's own objects,
so a new assignment fails CI. A ruff banned-api entry for
`nat.data_models.api_server` and `nat.data_models.interactive` outside the
handler module. The answer suite's baseline delta and the wire specs gate each
step. A UI spec asserts that no file under `adapters/api` or `features/chat`
imports a NAT step-name parser, since there is none left to import.

## Pros and Cons of the Options

### B. Leave NAT (LangGraph as a library)

* Good, because one framework instead of two, and LangGraph's upgrade cost is
  paid either way.
* Bad, because after A, B's remaining work (registry and config for 7
  `sources/` packages and 21 register files, job store, exporters, `nat run`
  in census and suite, 4 `nat eval` benchmarks, the `aiq-add-tool` /
  `aiq-add-data-source` skills and 18 docs) is another 4-6 engineer-weeks
  that fixes nothing a reader sees.
* Neutral, because A is its first phase: take it when the registry or
  config side starts costing us, not before.

### C. LangGraph Server + `useStream`

* Good, because threads, runs, `joinStream` and resumable streams would cover
  reconnect and most of `use-websocket-chat.ts` (2 759 lines).
* Bad, because `langgraph-api` is Elastic License 2.0, and production
  self-hosting needs a LangSmith API key or a licence key: "nothing phones
  home" fails. (Terms to be re-read by whoever revisits this.)
* Bad, because its thread store would sit beside the server-owned messages of
  ADR-0033, and tenancy, the context envelope and spectators would be rebuilt
  as its auth handlers and webhooks.

### D. Upgrade to 1.9, keep the patches

* Good, because it is about a week.
* Bad, because 1.9 has no handler-class hook, still stringifies the prompt per
  token chunk, still leaves the producer task running, and still lacks the
  profiler's error handlers: every patch stays and is re-checked on every
  minor.

## More Information

### Steps

Decided 2026-09-27 as one cut rather than the four phased steps first
drafted: steps 1-3 below land together, and there is no `v: 1` period.
Later the same day the product owner moved step 4 into the cut as well. The
upgrade lands **first**, as its own slice with its own exit (the backend suite
green on 1.9.0), and the wire slices build on it. So all four steps ship in one
PR, and the upgrade's slice keeps a regression bisectable on the integration
branch. The design of record, with the slices and what 1.9 does and does not
replace: [`docs/design/chat-wire-v2.md`](../design/chat-wire-v2.md).

1. **Own the WS route.** `websocket_path: null`, route added in
   `AIQAPIWorker.add_routes`, monkeypatch deleted.
2. **Own the wire.** Step adaptor `off`; graph streams via
   `astream(stream_mode=[...])` and `get_stream_writer()`; `v: 2` frames with
   AG-UI names. Exit: no UI code parses a NAT function name; frame size
   independent of prompt size; answer suite shows no first-prose or terminal
   regression.
3. **Own the HITL frames.** Our interaction frames over NAT's
   `prompt_user_input`. Exit: no `nat.data_models.interactive` import outside
   the handler.
4. **Upgrade to 1.9**, the cut's first slice: pin `nvidia-nat*==1.9.0`, move
   imports onto the public plugin API (`nat.plugin_api`), and fix what breaks.
   Exit: the backend suite green on 1.9.0 before the wire slices build on it.
   (First drafted as a separate step afterwards; moved into the cut
   2026-09-27.)

`interrupt()`-based HITL and leaving NAT (B) are separate decisions, each
reached from here without rework.

### Inventory: each NAT area, and what would replace it under B

| NAT area | What it does for Piloti | Under A | Replacement under B | Effort | Risk |
|---|---|---|---|---|---|
| `nat.front_ends.fastapi` (+`start_web.py`) | App, WS route, handler, CORS | Kept; WS route ours via `add_routes` | Own FastAPI app | M | Low |
| `nat.data_models.api_server` (32 prod imports) | Frame and `ChatResponse(Chunk)` models | Our `v: 2` frames on the wire | Own models | M | Medium: wire specs |
| StepAdaptor + `intermediate_step` (19) | Herleitung, status, tokens | Adaptor `off`; steps are telemetry | LangGraph `stream_mode` + writer | M | Medium |
| `nat.data_models.interactive` + WS HITL (12) | `ask_user`, plan approval | Kept API, our frames | `interrupt()` + checkpointer | S / M | Medium |
| `@register_function`, `FunctionBaseConfig`, `builder` | Discovery, config validation, LLM and tool wiring | Kept | Plain registry + entry point, pydantic, `llm_factory` | M | Medium |
| `Context` (15 files) | Conversation id, headers, run id, HITL manager | Kept | Own ContextVar context | S | Low |
| OTel exporter, redaction, logs | Spans to collector and Langfuse | Kept | OTel SDK + OpenInference LangChain | S-M | Low |
| Usage billing | None: `cost_tracking.py`, `profiler.py` are LangChain callbacks | Unchanged | Unchanged | - | - |
| Async jobs (`JobStore`, `job_info`) | Deep-research job status | Kept | Own model over the same table | M | Low-Medium |
| `nat run` / `nat eval` | Census, answer suite, 4 benchmarks | Kept | Own CLI; port or retire benchmarks | S-M | Low |
| MCP extra | Installed, not configured | Kept | `langchain-mcp-adapters` if needed | S | Low |

Revisit if NAT ships a handler-class hook or a typed custom-event channel on
the wire (then step 1 or 2 shrinks), or if registry and config gotchas keep
arriving after step 4 (then take B).
