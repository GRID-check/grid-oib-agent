# GRID Backend Deep Dive — Chat, Cards, Project Knowledge, Files & Research

> Authoritative end-to-end map of how GRID's core flows work, why several were
> broken, and how they were fixed. Written 2026-07-04 from a full source trace
> (7 parallel explorations + NAT-internals verification). File references are
> `path:line` at time of writing.

## 1. System topology

Docker Compose (`deploy/compose/docker-compose.yaml`):

- **postgres** — 3 logical DBs: `aiq_jobs`, `aiq_checkpoints`, `grid_app`.
- **seaweedfs** — object storage, bucket `grid-documents`. Published to the host at
  `localhost:8333`; internal DNS name `seaweedfs:8333`.
- **aiq-agent** — FastAPI + NeMo Agent Toolkit (NAT) + embedded Dask
  scheduler/worker + in-process ChromaDB. Runs the LangGraph workflow and the
  async deep-research jobs.
- **frontend** — Next.js 16 BFF + a Node WebSocket proxy (`frontends/ui/server.js`).
- **dragonfly** — Redis-protocol shared cache (ADR-0020): read-through caches
  (membership, flags, prompt view, model overrides, budget limits, model
  catalog), the gateway's WS-upgrade rate limiter, and per-conversation
  citation-registry snapshots. Cache-only semantics; both tiers fail open to
  in-process fallbacks when it is down or `REDIS_URL` is unset.

The **real** backend front-end plugin is `frontends/aiq_api` (`_type: aiq_api`).
(The old `src/aiq_agent/fastapi_extensions/` duplicate was deleted 2026-07-03,
commit `2570b1b`; its one live route, `/v1/ingest`, was ported into `aiq_api`.)

The working config is `configs/config_oib_openrouter.yml` (OpenRouter DeepSeek +
OpenRouter embeddings). `config_grid_oib.yml` (Kimi) is not currently working.

## 2. Chat request lifecycle (WebSocket-only)

Chat is **WebSocket only**. The old SSE `/api/generate` chat path is dead; SSE
now serves **only** the deep-research job stream (§7).

```
Browser WebSocket
  → frontends/ui/server.js  (WS upgrade proxy)
      • calls internal /api/websocket-scope?projectId=…  to fetch:
          - projectContext  → sets header  x-grid-project-context
          - collection scope → sets header  x-grid-collection-scope
      • ALSO sets the signed X-Grid-Request-Context envelope (below)
      • proxies the upgrade to the aiq-agent backend
  → NAT workflow  chat_deepresearcher_agent
      LangGraph:  shallow_research  (entry on EVERY turn, full tool set bound)
                    ├─ envelope.escalate_to_deep → clarifier → deep_research → END
                    └─ otherwise                 → END

    There is no classifier in front of the answering agent (ADR-0052). The
    model decides per turn, in the answer envelope, what the turn is: a
    direct reply (greeting, shelf listing, off-topic decline, "what can you
    do" — `answer` only, no `confidence`), a researched answer (`confidence`
    + citations), or a hand-off (`escalate_to_deep` + `escalation_reason`,
    the model's own clause). A commissioned report escalates immediately,
    without a retrieval first.

    Note: the shallow node doubles as the conversational assistant, so the UI
    presents it neutrally as "Assistant" (getDisplayName in
    intermediate-step-parser.ts), not "Shallow Research Agent" — a greeting is
    not a research run.
  → response streamed back through the MONKEYPATCHED WS handler
      frontends/aiq_api/src/aiq_api/websocket_reconnect.py
  → frontends/ui/src/adapters/api/websocket-client.ts  (parse system_response)
  → frontends/ui/src/features/chat/hooks/use-websocket-chat.ts  (onResponse)
  → frontends/ui/src/features/layout/components/ChatArea.tsx → AgentResponse.tsx
```

Key files:
- Graph build: `src/aiq_agent/agents/chat_researcher/agent.py` (`_build_graph`, nodes).
- Workflow registration + response creation: `src/aiq_agent/agents/chat_researcher/register.py`.
- WS wire types (NAT, vendored): `.venv/Lib/site-packages/nat/data_models/api_server.py`
  — `ChatResponse` and the WS message models are `extra="allow"`, so extra
  fields (cards, deep_research_job_id) survive serialization.

### The monkeypatch (critical seam)

`websocket_reconnect.py:create_websocket_message` takes the workflow's
`ChatResponse` (`data_model`) and builds the top-level `system_response` WS
message. It **lifts extra fields off the response onto the top-level message**
so the frontend can read them at `message.<field>` (not nested under
`message.content`):

- `cards`  → `message.cards`  (rendered as Grid cards)
- `deep_research_job_id` → `message.deep_research_job_id` (opens the research panel)
- `answer_confidence` → `message.answer_confidence` (honest self-assessment chip)
- `answer_confidence_reason` → `message.answer_confidence_reason` (the model's
  own one-clause justification, shown verbatim in the chip tooltip)
- `sources` → `message.sources` (verified citation sources)

**Transparency extras (WP-A).** The same lift carries a family of optional,
additive "why did the turn behave this way?" signals. Each rides
`register._STREAM_EXTRA_FIELDS` onto the terminal `ChatResponseChunk`
(`_response_to_chunks`), then `websocket_reconnect.py` lifts it onto the terminal
`system_response` message via `_TRANSPARENCY_EXTRA_FIELDS` / `_pull_response_extra`.
All are **absent unless applicable** (never null-spammed) and reset at the turn
boundary in `ChatResearcherAgent.run()`:

- `routing_decision` (`meta`/`shallow`/`deep`/`error`) — which path the turn
  took, OBSERVED after the answer (`chat_researcher.agent.observed_routing`):
  `meta` when the agent consulted no data source and gave no self-assessment,
  `shallow` otherwise, `deep` set by the clarifier hand-off, `error` on a
  failed turn. Nothing decides it up front (ADR-0052), so there is no
  `routing_reason`.
- `escalation_reason` — set by the clarifier node only on a shallow→deep
  escalation, and only from the structured `ShallowResult.escalation_reason`
  carried by the shallow agent's envelope (`escalate_to_deep` plus the model's
  own one-clause `escalation_reason`). There is no keyword/prose fallback: a substring match on the answer tail ("nicht
  finden", "weitere Recherche erforderlich") false-positived on successful
  German legal answers and surprise-escalated them to deep research. Likewise
  an empty/missing shallow answer is a generation failure — the node answers
  with the standard retry-able error (`escalate_to_deep=False`) instead of
  deep-escalating on a bug.
- `answer_confidence_reason` (≤300 chars) — the model's own one-clause
  justification. The shallow researcher may append `| <reason>` to its terminal
  `[CONFIDENCE:<level>]` marker (`researcher.j2`); `markers.py` parses it
  (fail-open: an invalid level discards level AND reason, the reason is trimmed
  and capped), and `_finalize_shallow_answer` carries it as
  `answer_confidence_reason` alongside the level. Escalated turns drop it.
- `answer_confidence_capped_reason` (`"ungrounded" | "quote_unverified" |
  "normative_claim_uncited" | "measurement_only" | "citation_fallback"`) — set when
  `surface_answer_confidence` downgraded the self-report. Gives the confidence
  chip a machine-readable reason the UI can explain.
  - `"ungrounded"` — citation verification left the answer without grounding and
    nothing was measured.
  - `"quote_unverified"` — a quoted span failed the deterministic
    quote-vs-source check (a grounded answer is held at "medium", an ungrounded
    one at "low"; the span itself is marked inline) (`verify_quoted_spans`, difflib coverage over the
    registry's captured `chunk_text`, fail-open; the offending span is annotated
    inline with `[nicht wörtlich in der Quelle belegt]` and the answer is never
    otherwise altered).
  - `"normative_claim_uncited"` / `"measurement_only"` — the two reasons about
    the SECOND kind of grounding, below.
  - `"citation_fallback"` — the answer's only citation is the single registry
    source the shallow agent appended when nothing the model wrote survived
    verification (`_append_minimal_citation`). The registry is cumulative across
    the conversation, so that source may have been retrieved on an earlier turn
    for a different question: it is treated exactly like a measurement (ceiling
    `"medium"`, and the normative brake still applies), never as the verified
    citation that "high" is reserved for.

  **Two kinds of grounding.** The guard was written against one form of
  evidence: a citation the verifier can resolve to a retrieved passage. An IFC
  measurement has no passage to quote — it carries a `provenance`, a `tolerance`,
  a readable `method` and the GlobalIds it was derived from
  (`ifc_spatial.envelope.Answer`) — so a correctly measured number was capped to
  `"low"` for lacking evidence it structurally cannot have. Two extra signals
  travel from the shallow researcher alongside `answer_citation_grounded`:
  - `answer_measurement_grounded` — this turn produced at least one
    `declared`/`computed` `ifc_measure` answer. Written by the shallow agent's
    tools node (a sticky OR across the tool loop; `shallow_researcher/grounding.py`
    decides what counts — a refusal, an outage, an `inferred` guess and a
    `decidable: false` finding all do not). Lifts the surfaced confidence off the
    `"low"` floor to at most `"medium"`; `"high"` still requires a verified
    citation.
  - `answer_normative_claim_uncited` — the anti-laundering brake. A single answer
    routinely mixes „Der Keller ist 2,70 m hoch" (reproducible) with „…und
    erfüllt damit OIB 4 Punkt 2.1" (a legal claim needing a quote). If the
    measurement satisfied the gate for the whole answer, the legal claim would
    ride out confidently on evidence that says nothing about it — worse than the
    over-hedging it replaces. So when a non-citation-grounded answer mentions
    regulatory material or passes a verdict at all, the measurement grounding is
    withheld and the answer keeps its `"low"`, reported as
    `"normative_claim_uncited"` rather than resolved silently. The `"medium"`
    ceiling is the structural half of the same defence and does not depend on
    that text heuristic. The vocabulary is two-tier: named instruments and
    deontic modals („muss", „darf", `must`, `shall`) fire wherever they appear,
    while the handful of stems `ifc_measure`'s own renderers use about the
    APPARATUS („für eine Messung geeignet", „für die Ermittlung … erforderlich",
    „die Datei ist zu groß") fire only in a sentence that does not name the
    apparatus — a false fire re-floors exactly the measured answers the signal
    above exists to un-hedge. The brake reads the answer's PROSE — a trailing
    reference list is stripped first (`_prose_without_references`), because a
    source title is a pointer, not a claim the answer makes. Only a GENUINELY
    trailing list is cut: every line after the heading must be a link, a list
    entry or blank, or the „**Quellen:**" line is just something the model wrote
    in the middle of an answer and the verdict after it would be dropped before
    the brake ever read it.
  - `answer_citation_fallback_used` — which citation did the grounding. A
    fallback citation does not disarm the normative brake and does not reach
    `"high"`: one stale session source used to do both, and „Der Keller ist
    2,70 m hoch und erfüllt damit OIB 4 Punkt 2.1" surfaced at the model's own
    self-report with an unrelated Bauordnung link attached to the verdict.

  **What counts as a measurement.** `ifc_measure`'s renderer states it: a result
  from an operation that could measure something ends with a line reporting how
  many QUANTITIES in it carry a `declared`/`computed` provenance
  (`agents/bim/measurement_evidence.py`), and the gate reads that count. It used
  to search the result for „gemessen" / „deklariert" instead, which three
  renderers write into prose explaining why NOTHING could be measured
  („gemessen: raumhoehe an 0 von 3 Bauteilen") — so a refusal granted
  measurement grounding, and a model that invented a number on top of one
  surfaced at `"medium"`.

  A provenance alone does not make a Messwert. `relations` answers a topology
  question with a list of GlobalIds in a decidable `Answer` marked
  `declared`, and it counted as one measurement until the count was gated on a
  `unit` or a `tolerance` — the fields that make a value a quantity. Not on
  scalar-ness: `storey_heights` measures every storey and answers with a list
  carrying `unit: "m"`. The operations that answer with something other than a
  quantity at all (`NON_MEASURING_OPERATIONS` — briefing, find_elements,
  element, draw, view, shopping_list) carry no trailer, because „Messwerte in
  diesem Ergebnis: 0" on a `draw` reads to the model as a measurement that
  failed and invites a retry that costs one of five tool iterations. Suppression
  is safe in the same direction as everything else here: no trailer reads as no
  measurement, so an operation nobody thought to list still grants nothing.
- `citations_removed` (`{count, reasons[]}`, deduped, max 5) — from the research
  result's `verify_citations` summary when ≥1 citation was removed.
- `job_admission_rejected` + `retry_after_seconds` — set in the deep-research
  node's `JobAdmissionError` catch; marks the text as a queue-rejection notice,
  not a research answer.

If you add another structured signal to the chat response, this is where it must
be lifted, and the frontend Zod schema (`schemas.ts`) must declare it.

### 2b. Signed context envelope (backlog T3-9, 2026-07-16)

Every submission path used to hand-roll its own subset of the `x-grid-*`
context headers (org/user/project id, collection scope, project
context/memory, model overrides, budget, disabled sources) — one audited case
(async-job submit, §8b) simply forgot one. `frontends/ui/src/lib/request-context.ts`
is now the single builder: `buildGridRequestContextWireHeaders` returns every
individual header PLUS one consolidated, signed `X-Grid-Request-Context`
header (base64url JSON of the same fields, plus the structured `bundesland`
fact — §6b) and `X-Grid-Request-Context-Sig` (hex HMAC-SHA256 of the raw
JSON, keyed on `GRID_INTERNAL_API_TOKEN`). This is a **dual-write
transition**: the individual headers are still sent unchanged; the envelope
rides alongside them, and removing the legacy headers is a later cleanup.
`server.js` duplicates the same builder logic (with a pinning comment) since
it is plain CommonJS and cannot import the TS module.

On the backend, `aiq_agent.project_context.GridRequestContext.from_context()`
/`from_envelope()` verifies the signature with `hmac.compare_digest` and
prefers a present-and-valid envelope over the individual headers; an
invalid/missing signature is treated as an ABSENT envelope (logged as a
WARNING tamper signal), falling back to the individual headers exactly as
before the envelope existed.

`frontends/aiq_api/src/aiq_api/context_envelope.py`'s
`GridContextEnvelopeMiddleware` (raw ASGI, same pattern as `AuthMiddleware` —
never buffers the response body, so SSE routes are unaffected) fail-closed
rejects (403 / WS policy-violation close) a workflow-invoking request when
ALL of: `REQUIRE_AUTH=true`; the caller is a WorkOS-authenticated JWT user;
the path is on the conservative enforced allowlist (`/websocket`,
`/v1/jobs/async/submit`, `/v1/internal/workflows/submit`, `/generate`); and no
valid envelope is present. Exempt regardless of path: anonymous mode,
internal-token-authenticated service calls, and every non-enumerated path —
the enforced-path list is an allowlist, not a denylist. Dev fail-open note:
when `GRID_INTERNAL_API_TOKEN` is unset, signature verification is skipped
but envelope *presence* is still required for authenticated requests.

### 2b-bis. Ingest-only turns: how a message reaches the graph WITHOUT a turn

Not every `user_message` opens a turn. The chat graph's conversation history **is**
its LangGraph checkpoint (`thread_id == conversation_id`, `chat_deepresearcher_agent
.checkpoint_db`), so only what passes through the agent is ever in its memory. That
made collaboration's hand-off (ADR-0034) lose the thread: a message addressed to a
*person* was suppressed by not invoking the agent, so Piloti never saw the question
asked of Anna, nor Anna's answer, and a follow-up `@Piloti given that, recheck` had
nothing to refer to.

The rule is **"always send, never always judge"**: every human message is delivered
to the agent, tagged with whether it is addressed to it. Routing stays deterministic
and server-decided (the BFF's `addressees`, computed at persist time); only *delivery*
changed.

```
client  user_message  content.text = {"query": …, "data_sources": […],
                                      "context_only": true, "author_name": "Anna Weber"}
  → websocket_reconnect.run()
      1. per-message re-auth gate (unchanged; an expired token buys no write either)
      2. context_only_directive(msg)  →  parse_context_only_payload()
      3. _ingest_context_only_message()
           • author = VERIFIED principal name, falling back to author_name
           • format_context_turn()  → "Anna Weber: <text>", capped at 4000 chars
           • append_conversation_context()  → the registered appender
      4. continue  ← no process_workflow_request, no socket registration
  → ChatResearcherAgent.append_context_message()
      graph.aupdate_state({thread_id}, {"messages": [HumanMessage(...)]})
```

What makes it genuinely free: `aupdate_state` writes a checkpoint through the
`messages` reducer (`add_messages` appends) and **executes no node**, so no LLM call,
no `system_response_message`, no intermediate/status frame, and nothing to stream. The
next real turn's `ainvoke` then reads the ingested turns as ordinary history.

Key pieces:
- Wire parse, char caps, appender registry: `src/aiq_agent/conversation_context.py`.
- The appender is *published*, not imported: `aiq_api` owns the socket and
  `aiq_agent` owns the graph, so `chat_researcher/register.py` calls
  `register_context_appender(agent.append_context_message)` where the compiled graph
  (and its checkpointer) exists.
- Fail-soft throughout. A missing appender, a dead checkpointer or a raising append is
  logged and swallowed: the human's message is already persisted in `grid_app.messages`,
  so the worst case is a gap in the agent's memory, never a lost message or a closed
  socket.
- Wire contract + compatibility in both directions: `docs/api/websocket-protocol.md`.

### 2c. Reconnect & resume semantics (socket drop mid-turn)

A turn can outlive its socket: the browser tab sleeps, the network blips, or a
token rotation forces a reconnect while a long deep-research answer is still
generating. Four cooperating mechanisms make sure the finished answer is never
lost. All backend pieces live in `websocket_reconnect.py`; the frontend pieces
in `use-websocket-chat.ts` + the chat store.

- **Live reattach.** NAT's base `WebSocketMessageHandler._restore_execution_state`
  (vendored, run from `__aenter__` on every new socket) swaps a reconnected
  socket into the still-running handler for the same conversation. It reads the
  `conversation_id` query param; the frontend sends both `conversationId` (Grid
  collection scoping) **and** `conversation_id` (so NAT's lookup matches).
  `ReconnectableWebSocketMessageHandler._restore_execution_state` overrides the
  base to (a) tolerate either key and (b) re-register the reconnected socket in
  the registry (NAT's base only swaps the handler's `_socket` attribute). Without
  the re-register, the dual-write guard below would still read "client gone".
- **Registry.** `WebSocketSessionRegistry` (module-global `_registry`) maps
  `conversation_id → socket` and holds pending HITL futures + the running
  workflow task. `set_socket` on send/reconnect, `clear_socket` on disconnect.
  `has_socket` is the **dual-write guard**: it decides whether the client is
  present (client owns the write) or gone (persist server-side).
- **Persist-on-drop.** When a terminal `RESPONSE_MESSAGE` cannot be sent (no live
  socket), `_persist_terminal_message_if_client_gone` → `persist_assistant_message`
  POSTs the finished answer (text + cards/sources/confidence) to the BFF so it
  survives a reload. Only the **terminal** frame persists (streamed deltas pass
  `persist_on_drop=False`); a transient job-admission "queue full" notice is
  dropped, never persisted. The id is deterministic per turn
  (`deterministic_assistant_message_id`) so a double-write no-ops on the messages
  primary key (`onConflictDoNothing`). This POST targets the **internal
  token-guarded** route `POST /api/internal/conversations/{id}/messages` with
  `X-Grid-Internal-Token` (org scoped via the `x-grid-organization-id` the WS
  upgrade forwarded) — not the browser session cookie, which expires on long
  turns and used to make the fail-soft POST silently 401 and drop the answer.
- **Rehydrate.** The client re-surfaces a persisted answer two ways: on a fresh
  mount, `sessions-store.restoreSessionState` refetches server history and, for a
  turn that looks interrupted, calls `_recoverInterruptedAssistantMessage`; on a
  same-mount reconnect, `use-websocket-chat.ts` `onConnectionChange('connected')`
  re-runs the same recovery (skipping the first connect, debounced against
  rotation storms). While that fetch is in flight the store's `isRecoveryPending`
  flag renders a calm "reconnecting — checking for a finished answer" line
  instead of racing straight to the "answer lost" notice; the lost/interrupted UI
  and the `agent.response_interrupted` card only appear once recovery returns
  with nothing found.

## 3. The card pipeline

**Cards are the rich-UI presentation layer**, not a citations feature. The agent
answers in plain markdown by default and emits a typed *card* whenever a
structured/rich format serves the user better. `LegalBasisCard` is one instance;
the set is meant to grow (summaries, profile patches, and later e.g. requirement
checklists, comparison tables, action prompts, standard-applicability panels).
Because cards are model-*chosen* rich UI, generation is inherently LLM-driven —
the design goal is to make card emission a **first-class, robust output channel**
(visible failures, one shared typed schema front+back, and a frontend renderer
registry so a new card type = define model + add renderer, no pipeline surgery),
NOT to bolt on a silently-failing second LLM call.

Cards (`SummaryCard`, `LegalBasisCard`, `ProjectProfilePatchCard`) are defined in
`src/aiq_agent/cards/models.py` (discriminated union, `validate_cards`); the
frontend renders them in `frontends/ui/src/features/grid-cards/`.

### How generation works

On the sync chat path the answering agent emits cards itself, mid-turn,
through the `emit_card` tool (`aiq_agent.cards.register`): each card is
validated against the shared schema and pushed into the conversation-scoped
`CardRegistry`, which the chat entrypoint reads after the turn. There is no
separate card-generation LLM call on that path, and no `card_generator_llm`
config key any more. The result rides `ChatResponse.cards` → `message.cards`
→ the frontend `validateGridCards` → `GridCards.tsx`.

### Deep-research cards (async path: closed; sync inline path: open)

With `use_async_deep_research: true` (the working config), any query routed to
deep research returns the stub `"Deep research job submitted. Job ID: …"`. The
**real** answer is produced later by `frontends/aiq_api/src/aiq_api/jobs/runner.py`
(`run_agent_job`), which now generates cards post-hoc from the final report
(`_generate_grid_cards` → `aiq_agent.cards.generate_cards`), re-emits the
report artifact with cards attached over the job SSE stream, and stores
`{"report", "cards"}` as the job output. Deep research cannot use the
`emit_card` tool directly: the conversation-scoped `CardRegistry` is bound
only in the chat request path, not inside a Dask worker. The remaining gap is
the **synchronous inline** deep-research path (no Dask scheduler configured):
those answers carry no cards, since the deep agent has no `emit_card` tool
and no post-hoc generation runs in `deep_research_node`.

### Removed dead mechanism

`deep_researcher/prompts/writer.j2` previously instructed the writer to emit a
`<grid_cards>…</grid_cards>` block, but the same prompt tells it to write the
report to `/shared/output.md` and return only a marker — and nothing ever parsed
the block. It could only leak raw JSON into reports. **Removed.**

## 4. Project knowledge — the intake-wizard context

> "Project knowledge" here = the intake-wizard profile injected as agent context.
> This is distinct from RAG/file scoping (§6), which works independently.

Pipeline (all correctly wired):

```
Intake wizard answers
  → PUT /api/projects/{id}/profile
      buildProfileUpdate → buildProjectPromptView(profile)
      → stored in projects.profile_prompt_view  (a compact "PROJECT_CONTEXT v1" block)
  → /api/websocket-scope reads profile_prompt_view → returns projectContext
  → server.js sets header  x-grid-project-context  on the WS upgrade
  → src/aiq_agent/project_context.py reads the header (truncated to 4000 chars)
  → chat_researcher/register.py sets state.project_context
  → injected into every prompt: all *.j2 have {% if project_context %}{{ project_context }}
```

### The bug that was fixed (WebSocket projectId race)

The header only carries when the WS handshake includes the correct `projectId`
query param. The client used to **snapshot `projectId` once** via
`useChatStore.getState().projectId` at socket-creation time, with the connect
effect **not keyed on `projectId`** and **no way to update it**. Because React
fires child effects before parent effects, on first navigation into a project
(the wizard's landing) the socket connected with `projectId: undefined` → the
header was never sent → the agent had no project knowledge for that session.

**Fix** (`use-websocket-chat.ts`, `websocket-client.ts`):
- Subscribe to `projectId` reactively and add it to the connect-effect deps, so
  the socket is (re)established once the project store resolves.
- Added `NATWebSocketClient.updateProjectId()` which rotates the socket (same
  atomic swap used for auth rotation) only when the value actually changes, so
  the handshake re-sends the project scope.

Note: the profile is intentionally **not** embedded into the `proj_*` RAG
collection — project knowledge reaches the agent only via header text-injection:
this profile header plus the project-memory digest header (`x-grid-project-memory`,
see §8).

## 5. Project summary / fact-sheet

The Project Overview "Project Brief" panel (`project-brief.tsx`, mounted by
`project-overview.tsx`) renders the AI `summary` from `projects.profile_display`
plus a fact sheet derived **at render time from the raw `projects.profile`** via
`buildProjectBriefView` (`lib/project-profile/brief-view.ts`): facts grouped in
intake-stage order with question/option labels ("Main use: Residential", not
"hauptnutzung: wohnen"), goal focus areas, unanswered questions as links back
into the wizard, a completeness count, and agent-suggested `assumptions` with
confirm/dismiss actions (confirm graduates the value into a `user_confirmed`
fact through the same patches endpoint the agent's `project_profile_patch`
cards use). `buildProjectProfileDisplay` (the stored `profile_display`
projection) uses the same labels.

### Agent-driven brief updates (project_profile_patch)

The agent keeps the brief current by emitting a `project_profile_patch` card
(via `emit_card`) whenever the conversation establishes a durable hard fact —
the shallow-researcher prompt has an explicit "Keeping the Project Brief
current" policy, and the card model carries the canonical fact-key vocabulary
(`PROFILE_FACT_VOCABULARY` in `cards/models.py`, mirroring the intake
definition). The card only proposes: the user's Accept posts the JSON-Patch to
`POST /api/projects/{id}/profile/patches`, which normalizes bare values into
full fact objects (`source: 'user_confirmed'` — accepting IS the confirmation),
applies them through the shared patch engine, and prunes unknowns the patch
just answered. `GridCards` receives the chat store's `projectId` in both the
chat bubble (`AgentResponse.tsx`) and the research report (`ReportTab.tsx`), so
Accept is live wherever the card renders.

Summary generation: the intake wizard fires
`POST /api/projects/{id}/generate-summary` → backend `/v1/generate-summary`
(`frontends/aiq_api/.../routes/generate_summary.py`, registered in `plugin.py`)
→ result stored into `profile_display.summary`.

### The bug that was fixed (summary wiped on every save)

`buildProjectProfileDisplay` used to hardcode `summary: ''`, so every profile
save/patch blanked the AI summary; only the intake wizard regenerated it, so any
chat-driven profile edit permanently lost the prose. **Fix**: the function now
takes a `previousSummary` and both callers (`profile/route.ts`,
`profile/patches/route.ts`) pass the current `profile_display.summary` through,
preserving it across rebuilds.

Operational note: `/v1/generate-summary` fails silently (swallowed try/catch on
both ends) if the `aiq_api` process has no LLM key. Ensure `OPENROUTER_API_KEY`
(or `SUMMARY_LLM_API_KEY`) is set, else the summary stays empty even though the
fact-sheet renders.

## 6. Files, documents & RAG

- **Upload**: `POST /api/documents/upload` streams the file to SeaweedFS **server-side**
  via `s3Client` (internal endpoint), records a `documents` row, then presigns a
  GET URL and hands it to backend `/v1/ingest` as `file_ref`. Because the backend
  consumes that URL from **inside** the Docker network, it correctly uses the
  **internal** endpoint.
- **Preview / download**: `/api/documents/{id}/preview` and `/download` presign a
  GET URL for the **browser** to fetch.

### The bug that was fixed (PDF preview/download broken)

Preview/download presigned with the internal `SEAWEED_ENDPOINT=http://seaweedfs:8333`,
which the browser cannot resolve — so both silently failed. **Fix**:
`src/lib/s3.ts` now exposes a second `signingS3Client` bound to
`SEAWEED_PUBLIC_ENDPOINT` (browser-reachable; defaults to `http://localhost:8333`
in dev), and the preview/download routes sign with it. The upload route keeps the
internal client (its URL is backend-consumed). Compose sets `SEAWEED_PUBLIC_ENDPOINT`.

### Folders

Nested folders are fully supported (self-referential `project_folders.parent_id`,
`folder-service.ts` builds the nested path, the API accepts `parentId`, and the
tree renders recursively). The prior "can't nest" symptom was **UX only** — there
was no per-folder affordance. **Fix**: `folder-tree-pane.tsx` now shows an "add
subfolder" `+` on each folder row and makes root creation explicit.

`folder-service.ts` carries the full set: `createProjectFolder`,
`updateProjectFolder` (rename and/or move) and `deleteProjectFolder`, behind
`POST`/`PATCH`/`DELETE` on `/api/projects/{id}/folders[/{folderId}]`. Two
invariants are load-bearing:

- **`path` is materialised**, so a rename or a move has to rewrite every
  descendant row. `rewriteDescendantPaths` does it as one prefix-replace
  statement per subtree inside the caller's transaction (the descendants share
  the old prefix by construction), with `LIKE` metacharacters escaped so a
  folder called `100 % Plans` cannot match half the project. A move into the
  folder's own subtree is rejected up front — with a materialised path a cycle
  is invisible until something walks it.
- **`documents.folder_id` is `ON DELETE CASCADE`** (see the deletion pipeline),
  so deleting a folder row would take its documents with it. `deleteProjectFolder`
  re-files the documents *and* re-parents the child folders into the deleted
  folder's own parent **inside the transaction, before the delete**, and returns
  `{ documentsMoved, foldersMoved }` so the surface can say where the files
  went. `folder-service.mutations.spec.ts` pins that ordering — deleting a label
  must never delete the work filed under it.

#### Folders on the Python side (ADR-0049)

Folders used to exist ONLY in the BFF/UI: ingestion, retrieval and the
document-surfacing tools had no idea they were there, so the agent could not say
"die drei Dokumente in Brandschutz" and a search could not be scoped to a folder.

The folder now crosses as the **materialised PATH** (`Brandschutz/Fluchtwege`),
denormalised onto **`document_metadata.folder_path`** — one nullable column added
through the same `_OPTIONAL_COLUMNS` backfill that added `tags`, `doc_class` and
`display_title`. It is deliberately NOT a `folder_id` (the backend has no
`project_folders` table to join) and deliberately NOT stamped into chunk
metadata: a path moves, and a value baked into every chunk of every document in a
subtree either has to be rewritten chunk by chunk or goes confidently stale. The
row is the authority, exactly as it already is for `doc_class` and
`display_title`, which is what makes a folder rename apply with **nothing
re-ingested**.

Three crossings:

| When | Where | What travels |
|---|---|---|
| Upload / re-ingest / re-index | `POST /v1/ingest` body → job config → `set_document_folder_path` | `folder_path` (null at the project root) |
| Folder rename / move / delete | `PATCH /v1/collections/{c}/folder-paths` | `{ from_path, to_path }` — one prefix rewrite for the whole subtree |
| Reads | `AvailableDocument.folder_path`, `FileInfo.folder_path` | the path |

`mirrorFolderPathRewrite` (`folder-service.ts`) makes the second call after the
folder transaction commits, best-effort, following the display-title mirror's
precedent: the BFF's rows are the durable truth, a backend that is down must not
fail a rename, and the bounded consequence is that the agent keeps the old path
until the next rewrite or re-ingest. One call rather than one per document — a
per-document PATCH would make a rename O(subtree) independently-failing requests,
i.e. a half-renamed folder. A delete is the same primitive: re-filing
`Brandschutz/Alt`'s contents at `Brandschutz` is the prefix rewrite
`Brandschutz/Alt` → `Brandschutz`. The match boundary is `/` on both sides, so
`Brandschutz` never carries `Brandschutzkonzepte`, and LIKE metacharacters are
escaped (`escapeLikePattern` / `_escape_like`) so `100 % Plans` cannot match half
the project.

**Surfacing.** `render_inventory_block` prints `(Ordner: Pfad/Unterpfad)` on each
filed file and explains the convention only when some file in the turn actually
has a folder; `surface_documents` states it in the briefing the agent writes
prose from ("Opened … (Projekt, Ordner Brandschutz/Fluchtwege)"). A file at the
root gets no `Ordner` at all — absence must read as absence, not as a folder the
user never made.

**Retrieval.** `knowledge_search` takes `folder=`, applied post-merge alongside
`doc_class` / `title_contains` / `file_name` so it works uniformly across the
base, session and project layers, and it covers the **subtree**: `Brandschutz`
also reads `Brandschutz/Fluchtwege`. `_format_results` emits an `Ordner:` line
per hit so a cited passage can say where its document lives. The store read
(`_resolve_folder_paths`) is one batched query per in-scope collection and fails
open to an empty map — which means "at the root", so a `folder=`-scoped search
whose store is unreachable returns nothing and tells the model to retry, rather
than shelf-wide results labelled as the folder's.

Not carried: the `document_grid` card schema has no folder field, so the card the
user sees still shows file + shelf + snippet. The agent's prose around it carries
the folder.

### Collection scoping (multitenancy)

Every backend call carries a base64url `X-Grid-Collection-Scope` header =
`[oib_knowledge, archiv_<org>, proj_<id>, s_<conversation>]`, built in
`src/lib/collection-scope-request.ts` and validated backend-side. This is the core
RAG multi-tenant boundary. Note `resolveProjectCollectionName` short-circuits to
no project scope when `session.organizationId` is falsy (anonymous /
`REQUIRE_AUTH=false`).

The signed header is the **authorization ceiling**, not the turn's search set.
The client states **intent** on the user message — `focus_file_name`,
`focus_shelf` (the composer subject's shelf), `source_preset` (the shortcut
chip) — never an expanded collection list. `shelves_for_turn`
(`src/aiq_agent/common/focus_file.py`) is the one mapping from that intent
to the shelves retrieval may keep; the knowledge layer **subtracts** other
shelves from the ceiling at the retrieve site and, when the focused file has
hits, does not pad the merge with Archiv/project leftovers (#429, #436).
A subject shelf wins over a preset. Absence of both leaves the signed scope
intact (ADR-0024: Archiv stays in every unscoped project turn). The TS twin
is `includeShelvesForTurn` in `frontends/ui/src/features/layout/lib/retrieval-scope.ts`.

**A subject file never subtracts `base`.** A subject narrows which *documents*
a turn reads, which is what #429 and #436 asked for; neither was about the
building-code corpus. Dropping it made the product unable to answer its own
central question — bind a plan, ask whether it meets the escape-route
requirement, and retrieval held the plan and no OIB. The asymmetry that exposed
it: the `project` PRESET kept `base` and the `project` SHELF did not, although a
reader reaches for either to say the same thing. `law` is the one branch that
still subtracts everything else, because there the reader asked for the law
alone.

**The subject is also a prompt fact, not only a retrieval hint.** Scoping
retrieval to the right file answers "where do I look"; it does not answer "what
is *this document*". `register.py` lifts the turn ContextVars onto
`ChatResearcherState.focus_file_name` / `.focus_shelf`, the graph carries them
into `ShallowResearchAgentState`, and the answering prompt (`researcher.j2`
§"This turn's subject") names the file — so a bare "fass zusammen" has an
antecedent. Without that the model asked which document the user meant while
the composer bar on screen said exactly which one, and retrieval's correct
scoping was never reached. The tool that can read the file is bound on every
turn, subject or not: there is no routing prompt and no narrowed tool binding
in front of the answering agent (ADR-0052).

### Document summaries & `available_documents` (SQL side-table, distinct from the vector index)

Two separate stores back "documents" and are **architecturally distinct**:
the **ChromaDB vector index** that `knowledge_search`/`knowledge_retrieval`
queries (what's actually retrievable), and a **SQL `document_metadata`
side-table** (`DocumentMetadataStore`,
`src/aiq_agent/knowledge/document_metadata_store.py` + `factory.py
get_available_documents_async`; formerly the `document_metadata` table / `SummaryStore`,
renamed because it now holds summary + tags + `doc_class` + `display_title` +
`folder_path`) that
is the **sole source** of the `available_documents` list (file name + summary,
optionally tags, doc_class, the user-facing `display_title`, the ADR-0049
`folder_path`, plus the
`collection` and ADR-0047 `shelf` stamped at aggregation) rendered into
agent prompts and shown in the Data Sources panel. A document could
previously end up fully ingested and retrievable via `knowledge_search` yet
**absent** from `available_documents` — see "Silent summary-row loss on
double LLM failure" below for the fix that closed the practical case of
this.

`available_documents` is fetched **once per turn**, in
`chat_researcher/register.py`, aggregated across the collections in the
request's header-based scope (or the base + session collection fallback when
no scope header is present). Identity is `(collection, file_name)` — the same
filename on the Büroarchiv and in a project is two documents (ADR-0047). The
cap (`GRID_AVAILABLE_DOCUMENTS_MAX`) keeps user-shelf files (archiv / project
/ session) first so the OIB corpus cannot evict them; a previous
sort-then-slice let ~40 OIB filenames eat the window and made "welche Dateien
hast du im Büroarchiv" answer from Basiswissen. The prompt block is grouped
by shelf (`aiq_agent.knowledge.inventory.render_inventory_block`) and empty
in-scope shelves render as empty rather than being omitted. The same list is
then shared by the shallow, clarifier, and deep-research paths for that turn
— it is not re-fetched per node.

**Prompt gating asymmetry — fixed 2026-07-16 (`77a4d7a`)**: the deep-research
prompts (`agents/deep_researcher/prompts/planner.j2`,
`agents/deep_researcher/prompts/orchestrator.j2`,
`agents/deep_researcher/prompts/researcher.j2`, and
`agents/deep_researcher/prompts/source_router.j2`) used to gate document
*awareness* purely on `available_documents` being non-empty, unlike the
shallow researcher's unconditional "use `knowledge_search` first" instruction
(`agents/shallow_researcher/prompts/researcher.j2:31`). The document
*listing* block is still wrapped in `{% if available_documents %}` (nothing
to list when the document_metadata table has no row), but `planner.j2` and
`researcher.j2` now separately instruct the agent to probe `knowledge_search`
unconditionally whenever the query concerns project/user content — "do this
regardless of whether the ... list below is empty or missing" — explaining
that the list "comes from a summaries index that can lag ingestion and
silently omit fully-ingested documents", so an empty/missing list is never
treated as proof no project documents exist. Combined with the reconciliation
backfill below, the list itself should now rarely be wrong in practice, but
the prompt-level distrust remains as defense in depth.

**The inventory is an index, not evidence — the list must never be cited**:
because the base OIB corpus is one of the collections aggregated above, every
research turn renders ~40 real corpus filenames plus their summaries into the
system prompt. Those filenames are *exactly* the citation keys
`verify_citations` matches against, and the registry it matches them against
holds only sources captured from actual tool results
(`common/citation_verification.py`). A model that cites a filename it read off
the inventory rather than out of a `knowledge_search` result therefore gets
every such citation dropped with `citation_key_not_in_registry`, and the answer
ships with the visible "Ohne Quellenangabe" note — while the document sits
indexed and healthy in the corpus. On the citation-health dashboard this
presents as "sources the platform HAS are not reaching answers", which points
at indexing and is the wrong place to look.

The prompts therefore label the block "Knowledge-base inventory (index — NOT
sources)" and state that a filename is not citable until a retrieval result has
returned a passage from it (`shallow_researcher/prompts/researcher.j2`,
`deep_researcher/prompts/{researcher,orchestrator}.j2`); the anti-memory rule in
`<citation_format>` covers document citation keys and not only URLs, and the
prompt no longer tells the model that verification will sort the references out
for it — verification only ever REMOVES. Pinned by
`TestKnowledgeInventoryIsNotCitable`. `planner.j2` / `source_router.j2` keep
their own listing block: those agents route and plan, they never emit
citations.

**Silent summary-row loss on double LLM failure — fixed 2026-07-16**:
ingestion (`sources/knowledge_layer/src/llamaindex/adapter.py`, ~lines
1795–1965) runs summary generation and tag classification as two concurrent
calls to the same `summary_llm`; both independently swallow
exceptions/timeouts and return `None` on failure. Previously the
deterministic, text-derived fallback summary only kicked in when `not
summary and tags and text_documents` — i.e. only when tag classification
succeeded but summarization did not — so when **both** calls failed, no
`document_metadata` row was ever written even though the file's chunks were embedded
successfully and the file was already `FileStatus.SUCCESS`. Two fixes landed
together:

1. **Fallback ungated (`7bc5cc7`)**: `register_summary()`'s fallback now
   fires whenever the LLM summary is missing and `text_documents` exist,
   independent of tag success, and reads a wider source sample (first + last
   chunk) so a sparse first chunk can't starve it.
2. **Reconciliation backfill (`42a4fa3`)**: `reconcile_collection_summaries()`
   (knowledge-layer factory) runs at the end of every `LlamaIndexIngestor`
   ingestion job — the Knowledge API, `scripts/ingest_oib.py`'s `oib_sync`,
   and any future caller get it for free. It diffs a collection's indexed,
   successfully-ingested files (`BaseIngestor.list_files`) against the
   `document_metadata` table and registers a deterministic fallback summary for any
   gap, logging a WARNING per backfilled document (a gap still means the
   primary summary path failed silently — this is a backstop, not a silent
   fix). Backends may optionally expose `get_document_text_sample()` to give
   the fallback a real text sample; `LlamaIndexIngestor` does, reading chunk
   text back out of Chroma. The per-job call is **scoped** to the job's own
   successful files (`file_names=[...]`), so the caller's known-indexed set is
   diffed directly and the full `list_files` metadata scan — O(collection
   size) on every single-file upload, painful on the large `oib_knowledge`
   corpus — is skipped; the unscoped full-collection diff remains available
   for manual/out-of-band reconciliation.

Together these implement backlog T3-10's cure (reconciliation pass +
ungating `fallback_summary_from_text` from tag success) and make "ingested ⇒
visible in `available_documents`" hold for every ingestion path — a document
that finishes ingestion always gets a `document_metadata` row, either from the
primary LLM path or, on backfill, from the reconciliation pass. The two
stores remain architecturally distinct (SQL side-table vs. ChromaDB vector
index), so this is a structural backstop rather than a merge of the two
sources — see backlog T3-10 for the closed status and rationale.

### Multimodal & visual/vector-drawing ingestion

`_run_ingestion` (`adapter.py`) extracts content from a PDF in a **two-phase
pipeline**, then indexes every resulting `Document` chunk and derives the
document summary:

**Phase 1 — extraction (no VLM):**

1. **Text** — `_extract_text_from_pdf` (pdfplumber), per page. Licence/watermark
   boilerplate lines (e.g. `VECTORWORKS EDUCATIONAL VERSION`) are removed by
   `_strip_watermark_lines` **before** indexing and before the visual-page
   heuristic, so a drawing that is pure linework plus a stamped watermark does
   not read as "has text".
2. **Tables** — `_extract_tables_from_pdf` (pdfplumber), gated on
   `extract_tables`.
3. **Embedded raster images** — `_extract_images_from_pdf` (pypdfium2 image
   XObjects), gated on `extract_images`/`extract_charts`. Returns raw image
   bytes — **no VLM call yet**. Identical rasters (a logo re-embedded on every
   page, a reused plan) are content-hash deduped (SHA-256 of the re-encoded
   JPEG) so each unique image is captioned and indexed exactly once.
4. **Rendered visual/vector pages** — `processing.render_visual_pages_no_vlm`,
   gated on `AIQ_RENDER_VISUAL_PAGES` (default on) **and** a resolvable VLM key.
   This is the track that captures **vector CAD/architectural drawings** (plans,
   sections, elevations, perspectives): they are thousands of vector *path*
   objects with almost no text and **no embedded raster image**, so tracks 1
   and 3 both miss them entirely. The whole page is composited into one bitmap
   (`page.render`, scaled so the long edge ≈ `AIQ_PAGE_RENDER_MAX_DIM` px,
   default 2048) — **no VLM call yet**. A page is routed here only when its
   watermark-stripped text is below `AIQ_VISUAL_PAGE_MIN_TEXT_CHARS` (200)
   **or** it has ≥ `AIQ_VISUAL_PAGE_MIN_PATHS` (300) vector paths — so ordinary
   text PDFs (the bulk OIB corpus) skip rendering at near-zero cost — and at
   most `AIQ_MAX_RENDERED_PAGES` (20) pages are rendered per document. The
   renderer receives track 1's already watermark-stripped page texts
   (`page_texts=…`), so the PDF's text layer is read once per library and the
   "watermark-stripped" threshold actually holds (it previously measured the
   raw pdfium text, letting a stamped watermark make a drawing look textful).

**Phase 2 — concurrent VLM enrichment:**

All image bytes (from track 3) and rendered page bitmaps (from track 4) are
passed to `processing.enrich_vlm_batch`, which runs every VLM caption call in a
single `ThreadPoolExecutor` (`AIQ_VLM_BATCH_WORKERS`, default 4) per file, with
**content-hash caching** via the shared Dragonfly/Redis store (ADR-0020). The
cache key is `vlm:caption:{model}:{prompt_type}:{sha256(image_bytes)}` with a
30-day TTL — the model is part of the identity, so a model switch (deployment-
wide or per-org `ingest_vlm` override) never serves stale captions and two orgs
on different models never share output. Re-ingesting a changed PDF only
re-captions its new/modified pages. **Failure placeholders are never cached** —
a failed analysis (`processing.is_failed_caption`) is returned to the caller but
not stored, so the re-ingest that recovers the file actually reaches the VLM
again instead of replaying a transient provider error for the 30-day TTL. Both VLM call sites construct their OpenAI
client with an explicit timeout (`AIQ_VLM_TIMEOUT_SECONDS`, default 180s) and a
single retry — previously SDK defaults (≈600s × 2 retries) let one hung
provider park an ingest worker for ~20 minutes. A response clipped at
`max_tokens` (`finish_reason == "length"`) is retried **once** with a doubled
budget (a clipped drawing reply is truncated mid-JSON, forfeiting the whole
structured analysis to the fallback parser); a still-truncated response is
stored with a warning rather than silently treated as complete. That truncation retry runs with SDK retries disabled and swallows its
own failures, returning the truncated first caption: it is a quality improvement
on a response that already succeeded, so it must neither double the per-caption
latency ceiling (~9 minutes worst case, vs ~6 for a request that simply hangs)
nor turn a partial success into a dropped chunk. Items whose VLM analysis fails — an exception **or** the fail-open
placeholder caption the call sites return on error (`"[Image|Drawing -
analysis failed…]"`, detected by `processing.is_failed_caption`) — are
**skipped and never indexed**: a placeholder used to be embedded as a real,
content-free chunk that polluted retrieval.

- **Embedded raster images** → `_analyze_image_with_vlm` with the generic English
  caption prompt (classifies chart vs. image, describes content, instructs the
  model to **exclude** licence/watermark/tool-stamp text). Returned captions are
  also run through `_scrub_watermark_phrases` as a belt-and-braces substring
  filter. **Standalone uploaded PNG/JPG/WebP images** go through
  `_build_image_documents`, which tries the v2 drawing analysis FIRST — a plan
  exported as an image gets the same per-segment structured chunks as the same
  sheet inside a PDF — and falls back to the generic caption
  (`_build_image_caption_document`) for photos/charts or an unparseable
  analysis. Both routes share the content-hash cache, and — since the analysis
  is the file's only content — the file **fails** on a failure placeholder
  instead of indexing a content-free chunk (retryable via re-ingest).
- **Rendered visual/vector pages** → `_analyze_drawing_page_with_vlm` with the
  drawing-analysis German prompt (schema v2, `drawing_analysis` module): the
  VLM first collects exhaustively, then emits ONE JSON object — one **segment
  per drawing on the sheet** (a sheet with Grundriss + Schnitt + Detail yields
  three), each with its **own scale**, split categories (rooms, circulation,
  structure, envelope, services, building physics), assemblies as ordered
  layers, existing-vs-new per element, quantities as
  object+property+value+unit, relation triples, and provenance + confidence.
  Parsed by `drawing_analysis.parse_drawing_analysis`; a reply that is not
  valid v2 JSON falls back to the v1 `KEY: value` parser
  (`_parse_drawing_fields`), so a weaker model degrades instead of failing.
  The requirement doc for this pipeline's shape:
  [`visual-ingestion.md`](visual-ingestion.md).

Each segment becomes its **own chunk**: the rendered structured German text
(`drawing_analysis.render_segment_text`) is the chunk body, so it is
**embedded and retrievable/citable by `knowledge_search`** — a query about
"Wärmepumpe" or "Stützenraster" hits the segment that shows it, at that
segment's scale. The full structured analysis rides on the chunk as
`drawing_data` (JSON string, embed-excluded), so re-chunking or the detail
view never needs the VLM again. The same descriptions
are browsable by the user, second to the one-line summary: `get_document_visual_details`
reads the visual chunks back from Chroma — each item now carrying `segment`
and the parsed `structured` payload — and the file-preview pane's collapsible
**"Detailed information"** section lazy-loads them (`GET /api/documents/{id}/visual-details`
→ `GET /v1/collections/{c}/documents/{f}/visual-details`). Drawing chunks carry
`content_type: "drawing"` in metadata (mapped to `ContentType.DRAWING` at
retrieval by `normalize`), giving them their own citation format
`"file, p.N, drawing_type"` in the agent context.

**Summary sourcing (why the summary no longer describes the watermark).** The
document summary + tag LLM calls are started **after** visual extraction. For a
text-sparse drawing PDF the near-empty page text is replaced by the aggregated
rendered-page descriptions as the summary/tag input, and if the summary LLM
fails, `_summary_from_drawing_fields` synthesises a deterministic, watermark-free
summary from the parsed drawing fields. The result: an image-only architectural
PDF is summarised as e.g. *"Perspektivischer Schnitt durch einen
fünfgeschossigen Bildungsbau …"* instead of *"VectorWorks Educational Version is
a version of VectorWorks software …"*. The shared summary prompt
(`document_classification.summarize_document_text`) is also domain-aware and
explicitly instructed to ignore watermark/software boilerplate. For a
**standalone image** (or any file where LLM summarisation is off/failed) the
summary falls back to the VLM caption verbatim; that caption is
watermark-scrubbed via `_scrub_watermark_phrases` first, and if scrubbing empties
it the summary stays `None` rather than becoming an empty string — so a
Bebauungsplan JPG is never summarised by its CAD licence stamp.

**Org BYOK + runtime model override for the VLM.** The vision model used across
all VLM call sites (Phase 2 enrichment) is resolved the SAME way the NAT chat
models resolve theirs. `/v1/ingest` forwards `x-grid-organization-id` (the BFF's
`dispatchIngest` sets it) into the job config; because `_run_ingestion` runs in a
detached thread pool with no request context, the org id must be captured at the
request boundary and carried in the config. From it the ingestor resolves, per
job: `resolve_vlm_credential(org_id)` (org BYOK key + base URL, else the
deployment env chain) and `_resolve_vlm_model_override(org_id)` (the org's
`ingest_vlm` model override, `AgentGroup.INGEST_VLM`). The resolved
`(model, base_url, api_key)` is threaded into `processing.enrich_vlm_batch`.
Org-agnostic base-corpus sync
(`oib_sync`) carries no org id and gets the deployment default, unchanged. Org
admins select the model in the model-config picker (`ingest_vlm` group, gated to
vision-capable models); see `docs/architecture/org-model-configuration.md`.

**Embedding throughput.** Chunks are embedded by `NVIDIAEmbedding` in batches of
`AIQ_EMBED_BATCH_SIZE` (default 64) per HTTP call instead of the llama-index
default of 10 — a 500-chunk document went from ~50 serialized embedding
round-trips on the ingest worker to ~8. The knob applies to both the ingestor
and the retriever's embedding client. (Embedding calls remain synchronous on
the worker thread; the standalone ingest-worker tier, not in-process
parallelism, is the scaling answer — see the scope note below.)

> Scope note: this lives in the **LlamaIndex** ingestor. The `foundational_rag`
> backend shares the summary prompt (`summarize_document_text`) but not yet the
> page-render track — a known follow-up if that backend is used for drawing PDFs.
> Embeddings BYOK is likewise still a follow-up (needs an embeddings-capable BYOK
> endpoint).

### Document thumbnails

The file-explorer card grid shows a 200px-wide JPEG thumbnail when available,
falling back to the content-aware SVG sketch (`DocumentKindThumbnail`).

**Generation flow:**
1. The BFF upload route (`dispatchIngest` in `service.ts`) derives a thumbnail
   SeaweedFS key from the original file's key (replaces the filename with
   `_thumb.jpg`) and generates a presigned **PUT** URL for it.
2. The PUT URL is passed to the backend's `/v1/ingest` as
   `thumbnail_upload_url`.
3. The `/v1/ingest` route handler (`ingest.py`) generates the thumbnail
   **pre-ingest**, before `submit_job`, so the BFF polling job status sees a
   thumbnail almost immediately — before the file even enters the worker pool:
   - **PDFs**: page 0 via `pypdfium2` → PIL → 200px JPEG quality 80.
   - **Images**: PIL open → RGB → 200px JPEG quality 80.
   On a successful upload the route sets `config["thumbnail_pregenerated"] = True`.
4. The JPEG bytes are PUT to SeaweedFS via the presigned URL (pypdfium2
   render is quick — ~50 ms per page — so it does not delay the request
   noticeably).
5. `_run_ingestion` in `adapter.py` keeps a **fallback** thumbnail render
   (400px) for callers that submit jobs without going through the route, or
   whose pre-ingest render failed. It is skipped when
   `config["thumbnail_pregenerated"]` is set, so the file is never rendered
   and PUT twice.

**Serving:**
- `GET /api/documents/{id}/thumbnail` → `getDocumentThumbnail()` presigns a
  browser-facing GET URL for `_thumb.jpg`. Returns `{ url: string | null }`;
  `null` means no thumbnail exists (non-PDF/image, or generation failed).

**Frontend:**
- `ThumbnailWithFallback` (file-browser-pane.tsx) and
  `ArchivThumbnailWithFallback` (archiv-library-pane.tsx) lazily
  `GET /api/documents/{id}/thumbnail` on mount, render the real image when
  a URL comes back, and fall back to the SVG sketch on error or missing
  thumbnail.

Thumbnails are ephemeral: there is no separate DB column — the key is derived
deterministically from `storageKey`, and a missing/expired SeaweedFS object falls
back gracefully to the SVG sketch. Re-ingesting a document overwrites the
thumbnail at the same key.

### Agentic retrieval quality package (ADR-0039)

Five retrieval-quality improvements sit in the knowledge layer's `register.py`
(`knowledge_search` / `knowledge_retrieval`) and `llamaindex` package, all
**fail-open** (any error degrades to the previous plain behavior, never raises):

1. **Agentic filters** — `knowledge_search` is the evidence tool (read/cite).
   It accepts optional `file_name` (indexed name — a FILTER, not a preference),
   `doc_class` (`oib_richtlinie` / `oib_leitfaden` / `norm` / `gesetz` /
   `sonstiges`) and `title_contains` (case-insensitive substring of file name
   or display title). `_apply_agent_filters` applies them post-merge with an
   over-fetch factor of 3 (`_AGENT_FILTER_OVERFETCH`): retrieval asks for 3×
   `top_k` candidates so the filters still leave ≥ `top_k` results. `doc_class`
   and titles are **store-authoritative**: `_resolve_doc_classes` /
   `_resolve_display_titles` build `(collection, file_name) → value` maps via
   `aiq_agent.knowledge.factory` (`get_document_doc_classes` /
   `get_document_display_titles`), so an admin reclassification in the
   base-knowledge panel takes effect immediately with no re-ingest; chunk
   metadata is only the fallback. An invalid `doc_class` value returns the
   allowed vocabulary instead of an empty result. A miss names the filters
   that produced it and tells the agent how to retry — it is not permission
   to invent a citation. Showing a file is `surface_documents` (one
   `document_grid` card: FileCard preview + human summary, one file peeks, several is a short grid); after
   a citation the UI peeks the cited project/Büro file itself
   (`useCitationPeek`) so the two tools are not a pair.

2. **Hybrid lexical + vector retrieval (RRF)** — gated on `AIQ_HYBRID_RETRIEVAL`
   (default on, config key `hybrid_search` in the knowledge layer YAML block).
   When enabled, `LlamaIndexRetriever` issues an additional exact-term lexical
   query per collection: `extract_exact_terms` (token-based, shared utility in
   `src/aiq_agent/common/legal_terms.py` — deliberately **no regex**) pulls up to
   three technical tokens from the query, matched via Chroma's
   `where_document: {"$contains": term}`. The lexical channel is fused with the
   vector channel using **reciprocal rank fusion** (`reciprocal_rank_fusion` in
   `llamaindex/hybrid.py`, Cormack `k=60`, vector channel wins ties). This fixes
   exact-keyword misses (e.g. a norm number or a precise term that the embedding
   model did not weight) without an embedding re-index.

3. **LLM-judge reranker** — optional config keys `rerank_llm` (an LLM alias from
   the config's `llms:` block; `config_oib_openrouter.yml` points it at
   `summary_llm`) and `rerank_candidates` (default 15; must exceed `top_k` — the
   judge call trims to `rerank_candidates`, so the reference config pairs
   `top_k: 16` with `rerank_candidates: 20`). When `rerank_llm` is set,
   the merged+filtered candidates are rescored once by an LLM judge
   (`rerank_chunks` in `llamaindex/rerank.py`, 30s timeout, fail-open to the
   original order) before trimming to `top_k`. No separate reranker API exists on
   OpenRouter/OpenAI-compatible endpoints, so the judge is a cheap single LLM
   call scoring 1–10 with an excerpt-windowed prompt (`_CHUNK_EXCERPT_CHARS=400`).

3a. **The retrieval loop** — optional `requery_llm` (the reference config points
   it at the same `rerank_llm`) and `requery_max_queries` (default 2). The
   judge (`knowledge_layer/requery.py`) reads the head of the fused pool beside
   the reranker and says whether it contains the governing statement the
   question needs; a sufficient pool costs no extra latency. An insufficient
   one gets the judge's alternative formulations, each retrieved from every
   collection in scope and fused into the same RRF as new channels (the
   original query keeps the tie-break seat), then reranked once more. The
   live line says `status.retrieval.requery`; the Langfuse retrieval span
   records `requery_queries`. Fail-open at every step.

4. **Retrieval-precision feedback** — a new `retrieval_precision` event kind in
   the citation-health pipeline (`src/aiq_agent/common/citation_events.py`):
   `build_turn_events` now compares the *retrieved* source labels against the
   *cited* ones per turn and emits an info-severity event when retrieval
   surfaced documents the answer did not use (`retrieved` / `cited` / `uncited`
   counts + the first 10 uncited labels). This closes the retrieval-quality loop
   on the existing `GRID_CITATION_EVENTS_ENABLED` dashboard surface (frontend:
   `CITATION_PRECISION_KIND` in `lib/db/schema/citation-events.ts`; the defect
   queries and glossary in `lib/citations/{service,repository}.ts` exclude the
   new kind so "precision" is shown as its own diagnostic, not a citation
   defect).

5. **Multimodal answer-time page/image viewing** — a new NAT tool
   `view_knowledge_image` (`llamaindex/view_image.py`, gated on
   `AIQ_VIEW_IMAGES_ENABLED`, default on, plus a resolvable VLM key) hands a
   knowledge image to the VLM **as an image block during a research turn** —
   not just at ingestion. Three source shapes: **PDF pages** are re-rendered on
   demand with pypdfium2 (long edge `AIQ_PAGE_RENDER_MAX_DIM`, default 2048) —
   base-corpus PDFs from disk (`OIB_UPLOADS_DIR` / repo corpus), project/Archiv
   PDFs from SeaweedFS bytes; **standalone image uploads** (PNG/JPG
   project/Archiv documents) are fetched from SeaweedFS and re-encoded to JPEG
   directly; and **stored embedded rasters** — the images
   `_extract_images_from_pdf` cuts out of a PDF are no longer discarded after
   captioning. For a document the BFF dispatched (one with a `document_id` in
   the ingest body), `llamaindex/image_store.py` asks the BFF for one presigned
   PUT per raster (`POST /api/internal/document-image-upload-url`; the backend
   holds a read-only object-store credential, so it writes the way the
   thumbnail is written) and stores it as `<doc dir>/_img/<index>.jpg`, at most
   `MAX_STORED_IMAGES_PER_DOCUMENT` (64, `frontends/ui/src/lib/s3.ts`, enforced
   by the presign route; the backend stops at the first refusal). The caption
   chunk records `image_key` and `stored_image_index`; `_format_results` shows
   an `Image: stored (view_knowledge_image image_index=N)` line only for such a
   chunk, and the tool's `image_index` argument fetches that raster through
   `GET /api/internal/document-file?imageIndex=N` — the BFF derives the key
   from the document's own row, so the backend never names an object key. Fail
   open at every step: a presign or upload failure keeps the caption and stops
   storing for that file; an unknown index points the model back at the page
   render. The `_img/` prefix is swept with the document by
   `deleteDerivedObjects` (`lib/documents/object-cleanup.ts`). One turn may
   call the tool at most `MAX_IMAGE_VIEWS_PER_TURN` times (6,
   `common/image_view_budget.py`, a per-turn ContextVar bound beside the card
   registry in `chat_researcher/register.py`); past that it answers with a
   text block. Because the SeaweedFS `storage_key` lives only in the frontend's
   `documents` table, the tool resolves `(collection, filename)` through a new
   token-guarded BFF route `GET /api/internal/document-file`
   (`lib/documents/{service,repository}.ts`, ADR-0017 layering) and fetches the
   bytes itself via boto3 (S3, path-style, read-only `get_object`) — which is
   why the aiq-agent tier now carries the `SEAWEED_*` credential set
   (deliberate override of the previous presign-only separation; ADR-0039).
   Every failure path (missing file, lookup/fetch/render error, invalid page
   number, disabled flag, no VLM key) degrades to a text-only explanation
   block.

All five changes are covered by tests under `tests/knowledge_layer_tests/`
(`test_agent_filters.py`, `test_hybrid.py`, `test_rerank.py`,
`test_view_image.py`, `test_image_store.py`),
`tests/aiq_agent/common/test_image_view_budget.py`, and in the BFF
`src/app/api/internal/document-file/route.spec.ts`,
`src/app/api/internal/document-image-upload-url/route.spec.ts`,
`src/lib/documents/image-derivatives.spec.ts` and
`src/lib/documents/object-cleanup.spec.ts`.
Design rationale and rejected alternatives (native reranker API, embedding
re-index, regex term extraction, presign-based reads): **ADR-0039**.

## 6b. Norm catalog (Normenregister — flat curated pointers + prose legal notes)

The live `ris_search` tool is keyword-blind: an LLM planner guesses one of ~40
OGD-RIS application silos plus German statutory terms, and a wrong guess yields
"No documents found". The norm catalog (ADR-0025 v2) removes the guesswork for
the core building-law corpus. It is deliberately **flat** — the typed-graph
variant (ranks/roles/editions/relations, Punkt chunking, applicability DSL) was
built, adversarially reviewed, and reduced; ADR-0025's Context records why.

**The three data planes** (how the Baurecht-Wien source diagram maps onto the
system — each plane has its own storage, admin surface, and priority):

| Plane | Holds | Lives | Managed via | Priority rule |
|---|---|---|---|---|
| **Catalog** | verified RIS pointers, prose legal facts (`binding_note`), open TODOs (`review_note`), non-RIS stubs (MA 37, ÖNORM) | norm store (DB) seeded from `configs/norms/<cc>/registry.yml` | `/app/platform` norms editor + verify-and-pick | tells the agent *where law lives* and *what binds what* |
| **Corpus** | full norm texts inside the RAG (OIB PDFs today) | per-country base collection — `NormsFile.corpus_collection` (AT: `oib_knowledge`) | `/app/platform` Base-Knowledge upload/sync | requirements are cited from here (normative documents only) |
| **Project/parcel** | uploads incl. Flächenwidmungs-/Bebauungsplan (tag-classified at ingestion) | project collections in the RAG | project Files UI | **per-parcel source of truth**: `parcel_note` renders tagged plans into the researcher prompt as the governing source for Widmung/Bauklasse/Höhe — above OIB and Bauordnung |

Country expansion touches data, not architecture: a new
`configs/norms/<cc>/registry.yml` (catalog) + its `corpus_collection` (corpus)
+ a fetch adapter for that country's legal database (the RIS adapter is
Austria's). The org-Archiv stratum (ADR-0024) sits beside these unchanged.

- **Data** — `configs/norms/<country>/registry.yml` (env override
  `GRID_NORMS_DIR`; `at` ships 23 entries): per entry `id`, `title`, `short`,
  `rank` (bundesgesetz | landesgesetz | verordnung — RIS-backed law lanes —
  plus behoerdliche_info for non-RIS practice guidance with a plain
  `source_url`, e.g. the MA-37 Merkblätter, and norm_extern for
  ÖNORM/TRVB stubs without accessible full text),
  `bundesland` (canonical name, empty = federal), `topics`, `relevance`, the
  **verified** RIS pointer (application, document number, citation URL,
  entire-consolidated-law URL), optional `aliases`, `binding_note` (curated
  prose legal fact rendered into researcher prompts — e.g. how the WBTV makes
  the OIB-Richtlinien binding in Vienna, the KlGG lex-specialis rule),
  `review_note` (open verification TODO, surfaced only in the platform admin
  UI), and a `verify` seed (title query + disambiguation guards) for live
  re-verification. Austria: the nine state building codes, Wiener
  Garagengesetz, WBTV, Kleingartengesetz, and the federal acts (ASchG, AStV,
  BKAG, ZTG, WGG, DMSG, UVP-G, WRG, ForstG, GewO). Pointer index only: full
  texts still go through `ris_fetch_document`.
- **The OIB corpus is not in the catalog.** `data/oib/` → `oib_knowledge` is
  its own source of truth; what a corpus file *is* (Richtlinie / Leitfaden /
  Erläuterung / Begriffsbestimmungen / Zitierte Normen / Änderungsdokument)
  derives from the filename (`norm_registry.oib_doc_class`). The 15
  `aenderungen_*` diff files and the superseded `zitierte_normen` revision are
  excluded from retrieval via the knowledge tool's `exclude_file_names`
  config (a `file_name NOT IN [...]` filter on the base collection only —
  session/project collections are never filtered).
- **Storage & admin surface** — runtime source precedence: the admin-managed
  store, then the YAML seed, fail-open. `knowledge/norm_store.py` keeps one
  JSON row per country (same DB URL as the summary store), seeds itself from
  the YAML on first boot, and registers itself via
  `norm_registry.set_db_loader`. Backend API: `GET/PUT /v1/admin/norms`
  (optimistic versioning; validation errors returned explicitly) and
  `POST /v1/admin/norms/verify` (live OGD-RIS candidate search), guarded by
  `X-Admin-Token` like the OIB admin routes. Platform-owner UI on
  `/app/platform` (lane-grouped list, entry editor, verify-and-pick,
  `review_note` TODO queue); every write audited
  (`platform.norm_registry.updated`). `scripts/build_ris_catalog.py` re-verifies
  the YAML seed's pointers in place (merge-only; curated fields never
  clobbered).
- **Prompt rendering** — `render_block_for_prompt(project_context)` renders
  the doctrine-adjacent catalog block: Bundesrecht lane, the project's own
  Bundesland lane (other states' law is dropped — `focus_entries` semantics),
  the curated `binding_note` lines, a static OIB-corpus citation note, and the
  project applicability section (`applicability.render_project_block`). The
  Normenhierarchie doctrine itself is one constant (`NORM_DOCTRINE`) injected
   into the shallow-researcher, deep-researcher, planner, and writer templates
   as `{{ norm_doctrine }}`.
- **Jurisdiction** — `resolve_country(project_context)` regexes the structured
   `country=<cc>` fact from the prompt text (`at`/`de`/`ch`/`other`, authored
   by the intake wizard's new A2_country question); absent → `"at"`. Every
   prompt now carries a **Jurisdiction & Country Handling** block that instructs
   the agent: for `at` → full OIB/RIS pipeline, binding precision; for non-AT →
   Austrian corpus only, comparative guidance, recommend local verification.
- **Bundesland** — `resolve_bundesland`: the validated envelope token wins
   (`ausserhalb_oesterreichs` → None is final), then the structured
   `bundesland=<token>` prompt fact, then free-text state-name probing.
   `focus_entries` drops other states' law and sorts the project's state first;
   the same rule filters `ris_search`'s catalog short-circuit and
   `ris_catalog_lookup` before truncation. When the country is non-AT, the
   profile save derives `bundesland=ausserhalb_oesterreichs`, so the downstream
   pipeline consistently treats non-Austrian projects as jurisdiction-neutral.
- **Hard limits** — Every research-facing prompt now includes a **Project Hard
   Limits & Grounding** block that instructs agents to treat confirmed wizard
   facts (fluchtniveau, BG Fläche, Anzahl Geschoße, Bauweise, Nutzung,
   Brandschutzanlagen, …) as binding constraints, derive building classes from
   them, flag contradictions, and surface gaps. The compliance-checker pair
   (`requirement_profile.j2`, `evidence_batch.j2`) gained a
   **Projekt-Hartgrenzen** section that maps each wizard fact to its OIB
   significance.
- **Applicability** — `common/applicability.py` is a small hand-written module
  (no DSL): OIB verdicts from project facts (mirrors the UI's
  `applicable-standards.ts`), German trigger hints for the four boolean intake
  facts (Kleingarten, Denkmalschutz, Betriebsanlage, Stellplatz), and the
  prompt section. The compliance checker scopes Stage 1 with it (verdicts
  `required`/`likely`/`check` all stay in scope; an explicit user scope is
  never narrowed).
- **Display tagging** — `lane_for_hit` / `citation_verification.source_lane`
  map a retrieval or citation hit to a stratum + lane label (Bundesrecht /
  Landesrecht / Verordnung via catalog rank; OIB lanes via filename class;
  Projektwissen / Büroarchiv / Web via collection origin) for the research
  fan-out UI. Deterministic tagging only — no chunk-metadata dependency.

## 6c. IFC/BIM models — the building as queryable data (ADR-0045, 2026-08-08)

An uploaded `.ifc` does **not** go down the ingest path. A STEP physical file is
tens of megabytes of `#412=IFCCARTESIANPOINT((1.2,0.,3.));`; embedding it
produces chunks that match nothing and bury everything. It is parsed instead,
in the BFF's Node process, with `@ifc-lite/parser`.

```
Upload .ifc → SeaweedFS  →  extractIfcModel()  ─┬─→ bim_models + bim_elements   (structured index)
   (documents row,           lib/bim/extract     ├─→ _bim/index.json            (full index, object storage)
    status=processing)                           └─→ _bim/<name>.ifc (markdown) ─→ /v1/ingest → RAG
```

The digest object keeps the ORIGINAL filename as its last path segment and
carries `Content-Type: text/markdown`, so the backend reads it as text while
`file_name` still resolves to the real `documents` row — citations open the
model and deleting the document removes its chunks.

A fourth derived object, `_bim/source.ifc.gz`, is the VIEWER's input: the same
model, gzipped, because the browser triangulates it and a presigned URL is
never cached. It holds the **unwrapped** model — a `.ifczip` is opened once, on
the way in (`lib/bim/ifc-archive.ts`), and everything downstream sees STEP.
That module also enforces the extraction ceiling on the archive's DECLARED
uncompressed size, read from the zip directory before a byte is inflated: the
limit exists to keep a 1 GiB pod alive, and measuring it on the compressed
object let a 40 MB upload become a 300 MB allocation. Extraction is detached from
the request (a 60 MB model takes tens of seconds) and every terminal outcome
writes the document row: success → the digest dispatch sets `pending` + a job
id, failure → `failed` with the reason, plus a `bim_models` row recording the
same thing.

### Two question shapes, two mechanisms

| Question | Mechanism |
|---|---|
| "What is this model of?" | Retrieval over the ingested digest — a document-shaped question. |
| "How many external walls on the ground floor?" | `lib/bim/query.ts` → SQL over `bim_elements`. A `COUNT(*)` with a `WHERE`; an LLM summing forty thousand elements from retrieved prose is a fact turned into a guess. |

The agent reaches the second through the `ifc_query` tool
(`src/aiq_agent/agents/bim/register.py`), which posts to
`POST /api/internal/bim/query` with the shared service token — the same
single-writer separation the `remember` tool uses. Models are addressed by
project and file name; no UUID travels through a conversation.

### What a large model costs, and where that cost was removed

A 400 000-element model is an ordinary Austrian submission, and every number
below was measured against a seeded one (`work_mem 4MB`, `statement_timeout
30s` — the deployed values, on the 1 CPU / 1 GiB pod budget). The pattern in
all four is the same: the query layer was reading the WHOLE model to answer a
question about a small part of it.

| Path | Was | Is | How |
|---|---|---|---|
| `compliance` (first request) | ~1.5 s, ~60 MB of JSON parsed on the event loop | ~0.3 s | `bim_models.rule_inputs` — the thirteen keys the catalogue reads, pruned at extraction time (`lib/bim/rule-inputs.ts`). 1 409 → 219 bytes per element. |
| `compliance` (repeat) | ~1.5 s again | ~0 | A 64-entry, 1 h memo keyed by model id + Gebäudeklasse + Hauptnutzung (`lib/bim/compliance-cache.ts`). A `ready` model is immutable, so the key is the whole input. |
| a filtered element page, 1 match | 6 474 ms | **9 ms** | `bim_elements.search_keys` + its GIN index, AND-ed in as a pre-filter (0038). |
| a filtered element page, 50 000 matches | 1 277 ms | **315 ms** | The pre-filter DROPPED, and `(model_id, ifc_type, express_id)` walked in order until the page is full (0039). |
| `properties` | past the 30 s timeout → **HTTP 500** | ~0.6 s | A scan bounded at ~5 000 elements, stratified by IFC type, reported as a sample. |

#### Two plans, and why the application picks

Those two element-page rows are the same query, and their plans are each
catastrophic in the other's regime:

| | matches 1 | matches 50 000 |
|---|---|---|
| GIN pre-filter, bitmap plan | 5 ms | 1 692 ms |
| ordered walk, no pre-filter | 5 877 ms | 3 ms |

A thousandfold either way, and **Postgres picks the bitmap in both cases**:
jsonb containment has no statistics, so `@>` is costed at a hardcoded 0.5 %
selectivity — it estimated 1 988 rows where 50 000 matched. No amount of
`ANALYZE` fixes that.

So `listBimElements` measures instead of guessing. One statement returns two
bounded counts — how many elements match (needed for `total` anyway) and how
many the pre-filter would hand to the bitmap plan, capped at
`PLAN_ROW_BUDGET` — and the page query is planned from them. Both plans cost
about the same per row they examine (33 µs and 29 µs measured), so the choice
is only "which reads fewer rows".

The rule is deliberately asymmetric: the walk is taken **only when it is
provably cheap and the pre-filter is provably not narrow.** The bitmap plan's
worst case is bounded by how many candidates exist; the walk's worst case is
the whole model. So everything uncertain lands on the bitmap — in particular a
filter with many candidates and few matches (`FireRating > 900` where 50 000
elements carry a FireRating and none exceed it), which stays expensive in both
plans because proving a negative means examining every candidate.

The choice can only ever be wrong about SPEED. The pre-filter is a necessary
condition, never part of the answer, so `assisted` and `unassisted` are the
same question — and the integration suite runs both against a live Postgres and
asserts they return the same elements.

Two of those carry a correctness obligation, and the obligation is what most of
the code is:

- **The pre-filter is a necessary condition, never the answer.** The exact
  `jsonb_each` predicate still decides, so a `search_keys` map carrying a key it
  should not costs a wasted heap fetch. The other direction — a key MISSING
  where the property exists — would delete matching elements from the answer,
  so it is prevented structurally: `bim_models.search_keys_indexed` gates the
  pre-filter per model and defaults to false, and the integration suite pins
  the TypeScript writer against the migration's SQL backfill on a live Postgres.
  Writing the fallback into the predicate instead (`search_keys IS NULL OR …`)
  is the trap that looks safest and is worst: `IS NULL` is not GIN-indexable, so
  the disjunction disables the index entirely and every query keeps the old plan
  (2 934 ms rather than 4 ms, measured).
- **A bounded answer says it is bounded.** A capped count reports `total` as a
  lower bound with `totalIsLowerBound`, and the rendered German reads
  "Mindestens 10000 Bauteile" — never a bare figure an agent would quote. A
  sampled property catalog reports `propertyScan { scanned, total, complete }`
  and its summary states that the NAMES are authoritative while the COUNTS are
  the sample's. The sample is stratified by IFC type rather than taken off the
  top precisely because property vocabulary is a function of type: a flat
  `LIMIT` returns rows in index order and would report the first types'
  vocabulary as though it were the building's.

### The BFF is not a trace producer, so the tool speaks for it

`ifc_query` is the one expensive thing in a turn that Langfuse (ADR-0044)
cannot see into: the work happens in the BFF, which exports OTel logs and no
traces, so the span is a duration and a rendered string. The tool therefore
records the shape of the call — operation, outcome, model, size, and whether
the answer covered the whole building — through
`observability/langfuse_trace_attributes.py`'s contribution channel, and tags
the trace `feature:ifc`. Contents stay out: they are already in `output.value`
under its own redaction policy. See ADR-0045 § Observability.

### Validation qualifies the answer

`lib/bim/validate.ts` runs five stages over the extraction (schema, identity,
spatial structure, property sets, completeness) and stores the findings in the
model summary. The point is not a report card: every query whose numbers those
defects distort comes back with a `caveat` string, and the tool description
tells the agent to report it verbatim. A storey breakdown over a model with 43
unplaced elements is a subset presented as a total, and this is the only place
that can be fixed.

### Work products, not just views

Three ops turn the index into the tables an office already keeps by hand:
`schedule` (Raumbuch, `lib/bim/schedule.ts`), `takeoff` (Massenermittlung, same
module) and `profile` (project-brief facts the model implies,
`lib/bim/profile.ts`). All three are computed **server-side over the full
element set**: the browser holds a capped page of elements with no quantities,
so summing there would produce a Flächenaufstellung short by however many rows
did not fit — silently, and only for large models. The page and the agent
therefore read identical numbers from one code path.

Each carries its own blind spot in the payload rather than in a footnote:
`roomsWithoutArea` per storey and per building, `missing` per take-off row, and
an `evidence` string plus a confidence on every derived fact. `profile` is
deliberately advisory — `geschosse_oberirdisch` picks a Gebäudeklasse, so the
suggestions travel to the user through the existing `project_profile_patch`
confirm-the-patch card (ADR-0030), never as a direct write.

### Revision comparison

`lib/bim/compare.ts` diffs two models by IFC **GlobalId**, which survives
re-export where express ids do not. Added / removed / changed with per-property
deltas — the question ("what changed since the last submission") that no pair of
PDFs can answer.

Above it, `features/bim/lib/revisions.ts` groups a project's models into
**series** by reading the revision markers offices actually type (`_V2`,
`-rev3`, `(2)`, a trailing date stamp) out of the file name, and computes each
step's deltas from the stored summaries — so a six-revision timeline costs zero
queries. The grouping is deliberately conservative: a bare trailing number is
not a revision marker, because merging `Bauteil 2` and `Bauteil 3` would report
one building as a wholesale deletion of the other. The element-level diff stays
on demand, one step at a time.

### Every model view is addressable

`features/bim/lib/model-link.ts` puts the whole view — model, tab, storey,
element, highlight groups, x-ray — in the query string, and the model page reads
its state from there. That one decision is what makes the rest possible: a
validation finding becomes a shareable link, a card opens the model already
focused, the `ifc_query` tool emits a `Link:` per element row so an answer can
name a wall as a chip that opens it (`features/bim/components/ifc-element-chip.tsx`,
supplied to the markdown renderer through `InternalLinkProvider`), and the
property panel turns the current selection into a chat question carrying its
GlobalId. Both halves of that contract are pure string ↔ object and tested on
both sides — `_element_link` in the Python tool mirrors `buildModelHref`, and a
drifted parameter name would otherwise fail silently as a link that opens a
model with nothing selected.

A compliance answer carries one more path: `_bcf_link` appends a
`/api/projects/{id}/bim/checks/export?model=…` URL, so the chat turn that lists
the open requirements can also hand over the BCF file that puts them back in
ArchiCAD or Revit. It is addressed by file NAME for the same reason the tool
itself is — a UUID carried through a conversation is a reliable source of
hallucinated identifiers — and it carries the same `gebaeudeklasse` /
`hauptnutzung` the run used, so the archive can never be built against
thresholds the answer did not apply.

### Geometry stays in the browser

Two fixtures, because they feed two different halves. `sample-building.ifc` is
metadata-only — every product has `$` for ObjectPlacement and Representation —
which is exactly right for the extraction, query and rule tests and means the
viewport has NOTHING to draw from it. `sample-building-geometry.ifc` carries a
swept solid per element, and `features/bim/lib/viewer-input.spec.ts` runs the
real WASM kernel over both: meshes and triangles from the first, zero from the
second, and every mesh's expressId matched back against what the server-side
extractor found in the same file (the map click-to-select and
highlight-by-GlobalId both depend on). The renderer itself is not covered and
cannot be — WebGPU needs a browser with a GPU adapter — so what the spec pins
is everything up to the renderer's door. Note the kernel emits **Y-up** meshes,
the glTF convention, not IFC's Z-up.

The viewport is not just orbit. `features/bim/lib/viewer-camera.ts` holds the
named views (plan and four elevations, plus the free view), the projection
mode, and the horizontal cut; `ifc-viewer-toolbar.tsx` renders the controls and
owns no canvas, which is why it can be unit-tested and screenshotted where
WebGPU does not exist. Two rules are encoded rather than left to whoever wires
a button: a cardinal view implies **parallel projection**, because a plan in
perspective is a picture and nothing on it measures; and a new cut lands a
metre above the storey's floor, which is where an Austrian Grundriss is cut and
not where the plane would slice the slab. All of it round-trips through
`buildModelQuery` / `parseModelView`, so "Schnitt bei +2,60 m, Blick nach
Norden, diese drei Wände markiert" is a link rather than a description.

The camera is controlled by the model page (so the view reaches the URL) and
falls back to local state anywhere else, so a viewport mounted without those
props still works instead of rendering a toolbar whose buttons do nothing.
"Fit" calls `fitToView` through an imperative handle; it used to be expressed
by remounting the canvas, which re-downloaded the presigned URL and re-ran the
whole WASM triangulation to move a camera.

There is no server-side render and no cached mesh format. The viewport streams
the source through a short-lived presigned URL and triangulates locally with
ifc-lite's WASM kernel + WebGPU renderer. A browser without WebGPU loses only
the picture: the structure, elements, properties, quantities and every agent
answer are unaffected, and the fallback says so.

## 7. Deep research (async jobs)

- The `deep_research` graph node submits a Dask job and returns the stub message
  **plus** a structured `deep_research_job_id` (added in this pass), threaded
  through `ChatResearcherState` → `ChatResponse.deep_research_job_id` → monkeypatch
  → `message.deep_research_job_id`.
- The frontend (`use-websocket-chat.ts`) opens the research panel from the
  **structured field** (`deepResearchJobId`), falling back to the old prose regex
  only for older backends. This fixes the fragile-regex failure where any wording
  drift silently hid the entire research panel.
- Job data (progress, thinking, citations, report) streams via SSE from backend
  `/v1/jobs/async/*` through the BFF proxy `/api/jobs/async/[...path]` into the
  `ResearchPanel` (Tasks / Thinking / Report tabs).

**Open items**: synchronous inline deep-research answers (no Dask) do not
carry Grid cards (§3; the async job path generates them post-hoc in the
runner). And the research tab can 403 — see §9.

**Collection-scope re-injection gap — now diagnosable (fixed 2026-07-16,
`f8093a0`)**: the `X-Grid-Collection-Scope` header is captured once at submit
time (`chat_researcher/register.py`) and threaded into the async job payload
as `collection_scope`. The Dask worker only re-injects it into its own
request context conditionally — `frontends/aiq_api/src/aiq_api/jobs/runner.py:641`
does `if collection_scope is not None:` before base64url-encoding it back
onto the header. When the scope is absent, `knowledge_retrieval` inside the
worker falls back to legacy config-based resolution (base collection +
session collection only — see `docs/technical-reference/collection-scoping.md`).
Because `project_collections` is `[]` in the shipped configs, project
collections are **never** searched in that fallback path for the affected
job. The fallback behavior is unchanged, but it is no longer silent: the
`elif` branch for `deep_research_agent` jobs now logs a one-time WARNING
(job id, whether the request looked authenticated/project-scoped) at exactly
the point the re-injection would otherwise be skipped.

**Durable checkpointing (backlog T3-8, 2026-07-16, `5bea711`)**: optional
LangGraph checkpointing for the deep-research graph, configured via
`deep_research_agent.checkpoint_db` (env `AIQ_DEEP_CHECKPOINT_DB`; unset by
default) — see §9's "Async deep-research jobs are not restart-safe" bullet
for the full mechanism and its manual-resubmit resume contract.

**Agent Skills and Jobs (ADR-0046)**: project-level **jobs** — a prompt on a
timer, with a skill optionally attached — can fire this same async pipeline on
a cron schedule. A dedicated `skill-scheduler` container claims due `jobs` rows
in `grid_app` (`FOR UPDATE SKIP LOCKED`) and fires through the BFF's internal
endpoint into `POST /v1/internal/skills/submit` (internal-token-guarded wrapper
around `submit_agent_job`, so admission control and cost tracking apply
unchanged). The agent follows the job's `output` (`chat` →
`shallow_researcher`, `deep-research` → `deep_researcher`), and the submitted
job carries `force_skills` — the attached skill's name, or an empty list when
the prompt runs alone. A `chat` job additionally carries a `conversation_id`,
and the worker writes the question and answer into that thread at completion
(`aiq_api/jobs/conversation_output.py`, best-effort — it can never fail a run).
This replaces the ADR-0023 Workflows scheduler, which was removed. See
`docs/architecture/agent-skills.md`.

**Deep-research agent graph internals**: the orchestrator/planner/researcher/
writer middleware stack, structured-output contracts, and graph invariants
(concurrency, recursion limit, skill filesystem permissions) live in
`src/aiq_agent/agents/deep_researcher/README.md`. Its "Known limitations"
section covers the remaining open defects found by a source audit against the
installed `deepagents`/`langchain`/`langgraph` versions, several of which are
now fixed — summarized in §9 below.

**Compliance pipeline (backlog T4-3, 2026-07-16)**: `src/aiq_agent/agents/compliance_checker/README.md`
documents a separate, purpose-built alternative to running an OIB
Soll-Ist-Abgleich through this open-ended deep-research harness — see §8c.

## 8. Backend agent architecture & DRY debt

Registered agents (via NAT `@register_function` + `FunctionBaseConfig`):
`chat_deepresearcher_agent` (entrypoint), `clarifier_agent`,
`shallow_research_agent`, `deep_research_agent` (+ eval/placeholder wrappers).

No shared base-agent class exists; four agent classes each repeat: tool
resolution/exclusion, `LLMProvider` construction, verbose/trace callback setup,
per-request data-source-filtered rebuild, tool-availability validation, and
prompt-loading fallbacks. Good shared primitives already live in
`src/aiq_agent/common/` (`llm_provider`, `data_source_registry`, `tool_validation`,
`prompt_utils`, `citation_verification`).

**Recommended (not yet implemented):** a `src/aiq_agent/common/agent_base.py`
providing `resolve_tools()`, `build_llm_provider()`, `with_tool_guard()`, a
prompt-loading mixin, and an eval-wrapper factory — collapsing the duplication
without touching the genuinely agent-specific LangGraph node logic. This is a
refactor that should be verified against a running stack before merge.

### Project memory (implemented)

The agent can now persist curated findings across turns. Full design:
`docs/architecture/project-memory-design.md`. Key facts:

- **Single-writer**: the `grid_app` DB has exactly one writer, the Next.js BFF.
  The backend `remember` tool never touches the DB — it POSTs to the internal
  BFF endpoint `POST /api/internal/memory`
  (`frontends/ui/src/app/api/internal/memory/route.ts`), authenticated by the
  shared service token `GRID_INTERNAL_API_TOKEN` (`x-grid-internal-token`
  header; the route fails closed with 503 when the token is unconfigured).
  Backend client: `src/aiq_agent/knowledge/project_memory.py` (base URL from
  `FRONTEND_INTERNAL_URL`, default `http://frontend:3000`).
- **Two scopes**: the `project_memory` table has a `scope` column —
  `project` (requires `projectId`) or `organization` (org-wide, requires
  `organizationId`, `projectId` null).
- **Read path**: `buildProjectMemoryDigest()`
  (`frontends/ui/src/lib/projects/memory-service.ts`) merges org-wide +
  project items (active only; pinned first, then most recently updated,
  bounded), tags each line with scope/kind/confidence/verification, and the
  digest rides the WS upgrade as the `x-grid-project-memory` header
  (`server.js` → `src/aiq_agent/project_context.py`), injected into prompts
  alongside `x-grid-project-context`.

## 8b. Runtime model overrides & usage metering (2026-07-07)

Two org-level runtime systems sit on top of the static workflow config —
full specs in `org-model-configuration.md` (ADR-0014) and
`usage-budgets.md` (ADR-0015); summary of the backend seams:

- **Model overrides**: `x-grid-model-overrides` (base64url JSON
  `{agentGroup: openrouterModelId}`) is parsed by
  `src/aiq_agent/common/model_overrides.py` and applied request-scoped:
  `LLMProvider.with_model_overrides()` (group-tagged roles; identity when
  nothing applies) in the shallow/deep/clarifier `_run` closures, plus
  `apply_model_override()` at the clarifier planner and the reflection
  scheduling site. Async jobs carry
  the map through `submit_agent_job` → `jobs/runner.py` (provider + header
  re-injection). Only the model id changes; params/keys stay from YAML. When
  no header/envelope carries the map (e.g. the generic async-job proxy before
  2026-07-16, or any future endpoint the BFF doesn't front),
  `get_model_overrides_from_context()` falls back to a just-in-time org-side
  resolution against the BFF's internal `GET /api/internal/model-overrides`
  — see `docs/architecture/org-model-configuration.md`'s submission-paths
  table. The **ingestion VLM** (`ingest_vlm` group) rides the same machinery
  from a detached thread: `/v1/ingest` captures the org id into the job config
  and the ingestor resolves the override (and BYOK credential) by org id — see
  §6 "Multimodal & visual/vector-drawing ingestion".
- **Retrieval settings** (2026-07-31): the fleet-wide retrieval counts —
  `knowledge_search` `top_k`/`max_chunks_per_document`, `surface_documents`
  `chunk_top_k`/`max_files`, web/advanced-web `max_results`, `ris_search`
  `max_results`/`page_size`, `ris_catalog_lookup` `max_matches` — are no
  longer only build-time YAML. The BFF's Platform → Retrieval surface
  (`/api/platform/retrieval-settings`, catalog + bounds in
  `frontends/ui/src/lib/retrieval-settings/catalog.ts`) pins keys; the backend
  resolves them through `src/aiq_agent/common/retrieval_settings.py`
  (`get_retrieval_setting(key, fallback)`), which pulls the pinned set from
  the token-guarded `GET /api/internal/retrieval-settings` just like
  `model_overrides` does, TTL-cached in-process (60s positive / 30s negative)
  and **fail-open**: any fetch error, or a key absent from the pinned set,
  falls back to the YAML/build-time value the tool was configured with. The
  resolver never raises, so a BFF outage cannot break retrieval. Platform-only
  by design: there is no org layer (ADR-0016) — every tenant's queries share
  the fleet counts.
- **Cost capture (DRY)**: `src/aiq_agent/common/cost_tracking.py` installs
  `GridCostTracker` through LangChain's `register_configure_hook` ContextVar
  seam — every callback manager configured inside the request picks it up,
  so agents contain no metering code. Activated in exactly three places:
  the chat workflow `_run`, the Dask job runner, and the reflection task.
  Events (model, tokens, OpenRouter `usage.cost`, generation id) POST to
  the token-guarded `POST /api/internal/usage` (single-writer rule).
- **Budgets**: `x-grid-budget` carries remaining USD per scope
  (org/member/project); the tracker raises `BudgetExceededError` before the
  next LLM call once exhausted (sync path returns a friendly chat response);
  the BFF refuses the WS upgrade outright when already over. A separate,
  per-run **completion-token** ceiling (backlog T4-4, 2026-07-16) —
  `GRID_MAX_RUN_COMPLETION_TOKENS`, default `0` = disabled — bounds one job's
  total output tokens across every LLM call including concurrent researcher
  workers (`BudgetGuardCallback`, `src/aiq_agent/common/budget_guard.py`),
  independent of the USD budget ledger.
- **Phase progress events** (backlog T4-4, 2026-07-16): `PhaseProgressCallback`
  (`aiq_api.jobs.phase_events`) observes the deep-research orchestrator's
  existing task-dispatch and `run_research_batch` callback events to detect
  planning/research/writing/citation-verification/done transitions, without
  any change to the `deep_researcher` package itself, and persists each as a
  `job.phase` `job_events` row on the existing SSE stream. The UI status pill
  consumes these to show live progress instead of staying silent for the
  first minutes of a run.

## 8c. Compliance-check pipeline (backlog T4-3, 2026-07-16)

`src/aiq_agent/agents/compliance_checker/` is a separate, **deterministic**
3-stage pipeline for the OIB Soll-Ist-Abgleich (requirements-vs-evidence
compliance check) — the structured alternative to running the same check
through the open-ended `deep_research_agent` (which the audit that opened
T4-3 measured at ~300 LLM turns / 20+ minutes for the same job). Stage 1
derives applicable requirements per Richtlinie (one structured LLM call each,
grounded by tool-free `knowledge_search` retrieval against the base OIB
collection); Stage 2 checks project-document evidence per batch of ~8-10
requirements (one structured LLM call each); Stage 3 assembles the compliance
matrix, ranks gaps by risk, and renders a German Markdown report — pure
Python, no LLM calls. A full 6-Richtlinien check is ~10-25 LLM calls total,
bounded and predictable.

Registered as the `compliance_check` function (`_type: compliance_check_agent`)
in `configs/config_oib_openrouter.yml`, backed by a dedicated `compliance_llm`
role and the `aiq_compliance_checker` `nat.plugins` entry point
(`pyproject.toml`). **Not yet invoked by any chat/workflow entry point** — the
function is registered and directly callable, but no orchestrator node, slash
command, or UI action calls it yet, so it needs a live shakedown before
user-facing use. See `src/aiq_agent/agents/compliance_checker/README.md` for
the full stage design, budget math, and its own still-open known limitation
(`AgentGroup` has no dedicated member for this pipeline's model overrides
yet).

## 8d. Agent skills (ADR-0046)

Reusable instruction packages (`SKILL.md`, agentskills.io contract) that
extend a research turn's procedure. A user can force a skill (`/name`, a
job, `force_skills` on submit). The model may also pick from the L1 catalog
unless the skill sets `grid-auto-invoke: false`. Delivery is **progressive
disclosure**: L1 is a one-line-per-skill catalog in the
system prompt (`## Available skills` + a forced-skills block), L2 is the
full body, loaded only when the model calls the `use_skill` tool. Per-run
`SkillRuntime` (ADR-0018 — never cached on the shared agent) tracks forced
vs. invoked names for `skills_activated` on the terminal frame.

The set per run = builtin (`src/aiq_agent/skills/builtin/`, discovered
deterministically, validated strictly) + org rows from the BFF internal
`GET /api/internal/skills/resolve` (org shadows builtin by name), resolved
fail-open and cached in the shared cache
(`GRID_SKILLS_CACHE_TTL_SECONDS`, default 60). `shallow_research_agent`
config gate: `skills_enabled` (default true) + `skill_allowlist` (empty =
all). `use_skill` is bound on every turn like every other tool; whether a
greeting loads a skill is the model's call (ADR-0052). Deep research loads
machinery from the filesystem (`DeepResearchSkillsConfig` mounts `oib`/`bim`
on the researcher and `synthesis` on the writer; curated dirs 404) and
loads house voice, offers and org skills through `use_skill`
(`resolve_served_skills`). Full design and tests:
`docs/architecture/agent-skills.md`.

## 9. Known issues / open items

- **Research tab 403** — origin is `requireAuthorizedSession()` throwing
  `Unauthorized` in the BFF proxy (`/api/jobs/async/[...path]`), mapped to 403 by
  `backend-proxy.ts` when there is no WorkOS session at request time (auth
  required + missing/expired cookie). A secondary candidate is the backend
  `require_verified_principal()` under `REQUIRE_AUTH=true`. Distinguish by the
  error code: `FORBIDDEN` (frontend) vs `BACKEND_ERROR` (backend). Note
  `requireAuthorizedSession()` also `redirect()`s no-org users, which is invalid
  inside an API route — a latent bug for users without an organization. **Needs
  runtime evidence to fix safely; do not guess-patch auth.**
- **Deep-research cards** — not delivered on the async path (§3/§7).
- **Silent LLM failures** — card generation and summary generation both swallow
  exceptions; consider surfacing a degraded signal to the UI. Document-ingestion
  summary/tag generation used to be the sharpest instance of this (a double LLM
  failure left a document permanently invisible) — that specific consequence is
  fixed (§6, "Silent summary-row loss on double LLM failure"); the LLM calls
  themselves can still fail silently, just without the visibility consequence
  anymore.
- **`available_documents` vs. ChromaDB divergence — mitigated 2026-07-16** —
  the SQL summaries side-table that feeds `available_documents` can still, in
  principle, diverge from what's indexed in ChromaDB (they remain
  architecturally distinct stores), but the reconciliation backfill (§6) now
  closes every gap the double-LLM-failure case could produce, and the
  deep-research prompts no longer gate document *awareness* on the list being
  non-empty (§6) — only the *listing* still is, which is cosmetic once the
  list itself is reliable.
- **Async job collection-scope fallback — fixed 2026-07-16 (`f8093a0`)** —
  `collection_scope` is still only re-injected into the Dask worker context
  when present (behavior unchanged: absent scope still drops
  project-collection search for that job, §7), but the degradation is no
  longer silent: `runner.py` logs a one-time WARNING (job id, whether the
  request looked authenticated/project-scoped) at the point it would
  otherwise skip re-injection, so the gap is diagnosable from logs instead of
  invisible.
- **Deep-research tool-result pruning defeats prompt-prefix caching — fixed
  2026-07-16 (`0b5d29d`)** — `ToolResultPruningMiddleware` now records
  truncation per message id and freezes it once applied (monotonic), instead
  of recomputing a positional keep-last-N window from scratch on every model
  call — message bytes at a given offset no longer shift turn over turn, so
  the ~80k-token contexts a deep run accumulates stop invalidating
  OpenRouter/DeepSeek prompt-prefix caching on that axis. Trivial results
  (`think`, `ls`) no longer occupy window slots — only oversized results do.
  It still runs uncoordinated with deepagents' own (stable-cutoff)
  summarization middleware, and no call site sets provider prompt-caching
  hints yet (that's a separate, still-open lever — see
  `docs/architecture/llm-providers.md` and `scaling-review-2026-07.md` §6.1).
  Model-call retries were narrowed in the same change: `ModelRetryMiddleware`
  now retries only rate limits, timeouts, transport errors, and 5xx (was any
  exception). See `src/aiq_agent/agents/deep_researcher/README.md`
  "Known limitations" for details.
- **Researcher-worker step cap — fixed 2026-07-27 (`tools/research.py`)** —
  each single-query researcher runnable now receives an explicit
  `recursion_limit=100` in its invoke config (was: relying on LangGraph's
  default of 25, which triggered `GraphRecursionError` early and fed the
  plan→batch→resubmit burn loop). The caught `GraphRecursionError` now
  becomes a terminal `ResearcherExhaustedError` (listed in the batch error
  as an exhausted query, not wrapped in a resubmittable `RuntimeError`).
- **Orchestrator recursion limit lowered — fixed 2026-07-27
  (`factory.py:569`)** — `_ORCHESTRATOR_RECURSION_LIMIT` changed from 2000
  to 150 so the step-count ceiling can actually fire as a hard stop before
  the 40-minute wall-clock killer surfaces as a generic internal error.
- **Code-level query resubmission cap (`tools/research.py`) — fixed
  2026-07-27** — the batch tool now tracks submitted query digests per run
  instance. After `MAX_QUERY_SUBMISSIONS=3` submissions of the same digest
  (was: prompt prose only that the model could ignore), the query is returned
  as a terminal unresearchable gap with a German-language "nicht recherchierbar"
  note instead of being re-run and burning more budget.
- **Wall-clock timeout re-raised as `TimeoutError` — fixed 2026-07-27
  (`agent.py:372-378`)** — `asyncio.wait_for`'s `TimeoutError` is no longer
  wrapped into `RuntimeError`. The runner's `sanitize_job_error` already
  special-cases `TimeoutError` (matching "wall-clock" in the message to
  produce a German UI string), so users now see "Die Recherche hat ihr
  Zeitlimit erreicht" instead of a generic internal error.
- **Research-note size cap (`tools/research.py`) — fixed 2026-07-27** —
  `_research_note_files` now truncates serialised payloads exceeding
  `RESEARCH_NOTE_MAX_CHARS=40_000` with a suffix marker, preventing a single
  oversized note from blowing the writer's context late in a run.
- **Writer total-char budget (`ToolResultPruningMiddleware`) — fixed
  2026-07-27** — the writer's middleware stack now enforces
  `total_char_budget=200_000`: when the sum of all oversized tool results
  exceeds this ceiling, the oldest oversized results are monotonically
  truncated (same per-message-id freeze as the existing keep-last-N logic)
  so the writer's context cannot grow unbounded across many research notes.
- **`RunBudgetExceededError` no longer erased by worker wrapping (`F6`) —
  fixed 2026-07-27** — `_run_research_query` now re-raises
  `RunBudgetExceededError` (was: caught by `except Exception` and wrapped
  into a resubmittable `RuntimeError`). The error also propagates past
  `asyncio.gather(return_exceptions=True)` in `_run_research_queries`
  so the budget guard can halt a budget-exhausted job immediately rather
  than being silently converted to a batch-level `RuntimeError`.
- **Deep-research strict structured-output schema bounds — fixed 2026-07-16
  (`2db0f7d`)** — `EvidenceJudgment.relevance_score` (`ge=0`/`le=100`) and
  `ResearchQuery.preferred_tools` (`min_length`) used to compile to
  JSON-Schema `minimum`/`maximum`/`minLength`, unsupported in strict
  `json_schema` mode on some providers. Both are now
  `field_validator(mode="after")` checks instead of declarative bounds:
  `relevance_score` clamps out-of-range values (a worker returning 105
  degrades to 100 instead of failing) while `preferred_tools` still raises on
  empty (no tool name to invent). `ResearchNotes`/`ResearchPlan.model_json_schema()`
  no longer emit `minimum`/`maximum`/`minLength`/`maxLength`/`pattern`
  anywhere in the nested tree. `tools/research.py`'s fenced-JSON fallback
  parser remains as a second line of defense for non-conformant completions
  in general. See the same README section.
- **Deep-research planner ceremony overhead** — deepagents' `StateBackend`
  is write-once (a second `write_file` to an existing path errors; recovery
  is via `edit_file`); the planner prompt mandates `write_todos` before
  decomposing. As of the 2026-07-16 prompt pass (`77a4d7a`) the todo-list
  ceremony is optional rather than mandatory, the planner's after-every-search
  `think` call is consolidated into a single pre-finalize `think`, and
  orchestrator `write_todos` updates are phase-level instead of per-step —
  reducing but not eliminating pure-ceremony LLM turns per planning run.
- **NAT step-tree/span corruption after a retried call — root cause fixed
  2026-07-16 (`6e57c08`)** — the log warnings `Step id ... not the last step
  in the stack` / `span ID stack is not equal` had two causes. (1) NAT's
  `LangchainProfilerHandler` (`nat/plugins/langchain/callback_handler.py`,
  `nvidia-nat==1.7.0`) implements `on_llm_start`/`on_tool_start` etc. but no
  `on_llm_error`/`on_tool_error`, so an errored (then retried) model or tool
  attempt never closed its intermediate-step span, corrupting the stack for
  every later step — this is now fixed by
  `SpanClosingProfilerHandler` (`src/aiq_agent/common/nat_step_repair.py`), a
  local subclass adding `on_llm_error`/`on_tool_error` overrides that push
  the matching `END` event, mirroring the installed handler's
  `on_llm_end`/`on_tool_end` construction field-for-field. (2) The remaining
  cause is NOT a bug: the deep-research pipeline legitimately runs sibling
  steps concurrently (parallel researcher workers, batched source-tool
  fan-out), which NAT's single-chain step model cannot represent — those
  residual warnings are deliberately suppressed (raised to `ERROR` level,
  `src/aiq_agent/common/logging_utils.py`) rather than fixed, since the steps
  themselves are still recorded correctly. `run_id`-keyed token/cost
  accounting (§8b) was never corrupted by either cause.
- **Shared trace-callback state across concurrent researcher workers — fixed
  2026-07-16 (`de67efd`)** — `VerboseTraceCallback` mutates per-run state
  (`current_input`, `active_chains`, `depth` — `common/callbacks.py`);
  `for_new_run()` already gave each deep-research *run* a fresh instance
  (`DeepResearcherAgent._prepare_run()`, ADR-0018), but that one instance was
  then shared as a single `callbacks` entry across every concurrent
  researcher *worker* inside the run (up to `max_research_concurrency`,
  default 6). `_run_research_query` (`tools/research.py`) now builds a
  per-worker callbacks list via `cb.for_new_run()` (falling back to the same
  instance for callbacks without it) before each `researcher_runnable.ainvoke()`
  call — the outer/batch-level callbacks list itself is untouched. This
  applies uniformly to both the sync chat path and the async job runner
  (both go through the same `_run_research_query`), so `runner.py` building
  one `VerboseTraceCallback()`/`LangchainProfilerHandler()` per job (not per
  worker) no longer means those workers race on shared state.
- **Async deep-research jobs are not restart-safe — mitigated 2026-07-16
  (`5bea711`, backlog T3-8)** — the deepagents graph's `store=InMemoryStore()`
  (longterm memory) is unchanged, but `build_deep_research_graph` now accepts
  an optional `checkpointer` (per-thread execution state, an independent axis
  from `store`) passed through to `create_deep_agent`. When
  `deep_research_agent.checkpoint_db` is configured (env
  `AIQ_DEEP_CHECKPOINT_DB`; unset by default, opt-in since jobs run in
  ephemeral Dask worker processes — the reference config sets it to
  `./deep_research_checkpoints.db`), `DeepResearcherAgent.run()` wires
  `configurable.thread_id = job_id` and `durability="async"` (LangGraph's
  canonical durable-execution mode for long batch-style runs), so a worker
  crash no longer silently loses all execution state — the checkpointed
  thread survives. **Resume is manual-resubmit-based, not automatic**:
  `submit_agent_job` still rejects a duplicate `job_id`
  (`DuplicateJobIdError`), and `run()` always passes the full initial state
  rather than `None`, so a resubmitted call layers new input onto the
  checkpointed thread via the state schema's reducers rather than continuing
  exactly from the interrupted step — there is no automatic queueing/resume
  entry point yet, and the ghost-job reaper (ADR-0021,
  `scaling-review-2026-07.md` §2.4) still flips an orphaned `RUNNING` row to
  `FAILURE` after its timeout. A future DB-claimed-worker migration
  (ADR-0021) fixes replica pinning/cross-node cancel but is orthogonal to
  this checkpointing layer.
- Infra: live secrets in `deploy/.env`; backend DBs have no migration mechanism
  (init only); config drift between the two config files.

## 10. Verification workflow

`task verify` is the local gate: host-native, defined once in the root
`Taskfile.yml`. CI calls the same definitions but schedules them differently, so
a local pass is strong evidence rather than a guarantee. `task verify:fast`
skips two production builds, `fe:build` and `web:build`. Full command list, the
checks that sit outside `verify`, and the traps `task --list` does not carry:
`docs/contributing/testing-and-verification.md`.

Runtime-behavioural changes (deep-research cards, agent refactor, research 403)
still need a running stack before merge: the `.devcontainer` (VS Code,
`deploy/Dockerfile` target `dev-builder`) or `docker compose … up -d --build`.
