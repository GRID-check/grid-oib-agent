# Reusing AI-Q machinery for server-side conversation persistence

What already exists in AI-Q that we can reuse, and what we must build new, to get
server-side conversation persistence.

- **Scope:** conversation persistence subsystem.
- **Status:** as-is research summary; used as input for the implementation spec.

---

## 1. Reuse: WebSocket transport

**Key file:** `frontends/aiq_api/src/aiq_api/websocket_reconnect.py`

`ReconnectableWebSocketMessageHandler` extends NAT's `WebSocketMessageHandler` and adds:

- `WebSocketSessionRegistry` keyed by `conversation_id`:
  - `_sockets` — active socket per conversation.
  - `_pending_interactions` — HITL futures.
  - `_workflow_tasks` — running workflow tasks.
- Reconnection support: if a socket drops, a new socket with the same `conversation_id`
  can re-attach and resume.

Inbound message types:

- `WebSocketUserMessage` → starts a workflow turn.
- `WebSocketUserInteractionResponseMessage` → resumes HITL.

Outbound message types created by `create_websocket_message`:

- `WebSocketSystemResponseTokenMessage` — assistant token / final response.
- `WebSocketSystemIntermediateStepMessage` — tool / thinking steps.
- `WebSocketSystemInteractionMessage` — HITL prompt.
- `WebSocketObservabilityTraceMessage` — observability payload.
- Error messages.

`conversation_id` is already threaded through every message via the registry and handler.

**How to reuse:** add a history-load call in `run()` after auth succeeds and before the
message loop. Emit prior messages as:

- `WebSocketSystemResponseTokenMessage(status='complete')` for user/assistant turns.
- `WebSocketSystemIntermediateStepMessage(status='complete')` for tool/thinking steps.

The frontend already understands these message shapes.

An alternative is a separate REST endpoint the UI calls before opening the WebSocket.
The handler hook is the cleaner path because it requires no frontend protocol change.

---

## 2. Reuse: NAT WebSocket message schema

**Models:** `nat.data_models.api_server` (AI-Q transitive dependency).

Confirmed fields:

- `WebSocketMessageType` enum:
  `USER_MESSAGE`, `RESPONSE_MESSAGE`, `INTERMEDIATE_STEP_MESSAGE`,
  `SYSTEM_INTERACTION_MESSAGE`, `USER_INTERACTION_MESSAGE`, `AUTH_MESSAGE`,
  `AUTH_RESPONSE`, `OBSERVABILITY_TRACE_MESSAGE`, `ERROR_MESSAGE`.
- `WebSocketSystemResponseTokenMessage`: `type`, `id`, `thread_id`, `parent_id`,
  `conversation_id`, `content`, `status`, `timestamp`.
- `WebSocketSystemIntermediateStepMessage`: adds `intermediate_parent_id`,
  `update_message_id`.
- `WebSocketUserMessage`: `type`, `schema_type`, `id`, `conversation_id`, `content`,
  `user`, `error`, `schema_version`, `timestamp`.
- `WebSocketUserInteractionResponseMessage`: adds `parent_id`, `thread_id`.
- All WebSocket models use `model_config = {'extra': 'allow'}`.
- `ChatResponse`: `id`, `object`, `model`, `created`, `choices`, `usage`,
  `system_fingerprint`, `service_tier`, also `extra='allow'`.

**How to reuse:** `conversation_id`, message `id`, `parent_id`, `status`, `timestamp`
already exist. `cards` are already attached via extra fields:

- `websocket_reconnect.py` lines 395-399 set `message.cards = cards` on the final
  `RESPONSE_MESSAGE`.
- `register.py` line 478 sets `response.cards = cards` on `ChatResponse`.

For history load, emit `WebSocketSystemResponseTokenMessage(status='complete')` with the
original `id`, `parent_id`, `conversation_id`, and a `cards` extra field. The frontend
schema in `frontends/ui/src/adapters/api/schemas.ts` already accepts
`cards: z.array(z.unknown()).optional()` on `NATSystemResponseMessage`.

No schema change is needed for basic persistence.

---

## 3. Adapt: frontend Zustand chat store

**Key files:**

- `frontends/ui/src/features/chat/store.ts`
- `frontends/ui/src/features/chat/types.ts`

Current behavior:

- `createNewConversation(userId)` mints a local id: `s_${uuidv4().replace(/-/g, '_')}`.
- Persistence is browser-only via `zustand/middleware` `persist` backed by `localStorage`
  under key `aiq-chat-store`.
- `setCurrentUser` filters `conversations` by `userId` from the already-loaded
  `localStorage` state.
- `selectConversation`, `ensureSession`, `createConversation` operate against local state
  only.
- `ChatMessage` and `Conversation` already model the full UI surface: `cards`,
  `thinkingSteps`, `deepResearchJobId`, `planMessages`, etc.

**How to adapt:** add a `loadServerConversations()` store action called after auth
resolves. It should:

1. Call a new backend endpoint (e.g. `GET /v1/conversations`).
2. Merge server conversations into `conversations`.
3. Reconstruct `currentConversation` from the server list.
4. Let `persist` keep writing back to `localStorage` as a cache.

The store already treats `currentConversation` as a reference resolved from
`conversations` on rehydration, so replacing `conversations` with server data is a small
change.

---

## 4. Reuse (for graph state only): LangGraph checkpoints

**Key files:**

- `src/aiq_agent/common/__init__.py` — `get_checkpointer`
- `src/aiq_agent/agents/chat_researcher/agent.py`
- `src/aiq_agent/agents/chat_researcher/register.py`

Existing machinery:

- `get_checkpointer(checkpoint_db)` supports SQLite (`AsyncSqliteSaver`) and Postgres
  (`AsyncPostgresSaver`) and caches checkpointer instances.
- `ChatResearcherAgent._build_graph()` compiles the graph with
  `checkpointer=self.checkpointer`.
- `chat_deepresearcher_agent` in `register.py` calls `get_checkpointer(config.checkpoint_db)`
  and passes it to the agent.
- `thread_id` passed to `agent.run()` is the NAT `conversation_id`.

What is stored:

- `ChatResearcherState`: LangChain `BaseMessage` list, data sources, clarifier result,
  shallow result, user info, cards.
- This is graph-internal state, not the frontend `ChatMessage` model.

**Can checkpoints serve as server-side message history?**

Partially, but not as the canonical history. They are good for:

- Reconstructing the LLM message list for the next graph invocation.
- Storing cards generated by the agent.

They are **not** suitable as the UI-visible conversation history because they do not
capture:

- User message display metadata (`enabledDataSources`, `messageFiles`).
- Frontend-only message types (`status`, `prompt`, `file_upload_status`,
  `deep_research_banner`, `error`).
- Deep-research SSE artifacts (`deepResearchTodos`, `deepResearchLLMSteps`, etc.).
- Title, creation/update timestamps, per-user ownership.

**Recommendation:** use LangGraph checkpoints for graph state / LLM turn memory only;
build a separate conversation persistence layer for the UI-visible history.

---

## 5. Reuse: FastAPI extension plugin pattern

**Key files:**

- `src/aiq_agent/fastapi_extensions/register.py`
- `src/aiq_agent/fastapi_extensions/routes/collections.py`
- `src/aiq_agent/fastapi_extensions/routes/documents.py`
- `src/aiq_agent/fastapi_extensions/models/requests.py`

Existing pattern:

- `KnowledgeAPIConfig` extends `FastApiFrontEndConfig`.
- `KnowledgeAPIWorker` extends `FastApiFrontEndPluginWorker` and overrides
  `add_routes(app, builder)`.
- `KnowledgeAPIPlugin` extends `FastApiFrontEndPlugin`.
- Registered via `@register_front_end(config_type=KnowledgeAPIConfig)`.
- Routes use standard FastAPI `APIRouter` with dependency injection
  (`Depends(_require_ingestor)`).

**How to reuse:** create:

- `ConversationAPIConfig`
- `ConversationAPIWorker`
- `ConversationAPIPlugin`
- `conversation_routes.py` with endpoints:
  - `GET /v1/conversations`
  - `GET /v1/conversations/{id}`
  - `POST /v1/conversations`
  - `DELETE /v1/conversations/{id}`
  - `POST /v1/conversations/{id}/messages`

Reuse the existing auth middleware (`aiq_api.auth.middleware`) for route security.

---

## 6. Build new: conversation/message persistence layer

No server-side conversation or message store exists. We must build:

- `grid_app.conversations` table.
- `grid_app.messages` table.
- A CRUD service callable from both REST routes and the WebSocket handler.
- Wiring to save the final assistant message + cards after a workflow turn completes.

---

## Verdict table

| Component | Action |
|---|---|
| WebSocket handler + registry | Reuse |
| NAT WebSocket message schema | Reuse |
| Frontend Zustand chat store | Adapt |
| LangGraph checkpoints | Reuse for graph state only |
| FastAPI extension plugin pattern | Reuse |
| Auth middleware | Reuse |
| Conversation/message DB + CRUD | Build new |
| Legacy SSE `/generate/stream` path | Do not use |

---

## Short version

AI-Q already provides the transport layer (`websocket_reconnect.py`), the message
envelope (`nat.data_models.api_server`), the graph state persistence
(`get_checkpointer`), and the FastAPI plugin pattern needed to add conversation CRUD.

The missing piece is a dedicated conversation/message database schema and the
service/routes to read and write it. Build that new layer, then wire it into the
WebSocket handshake and the Zustand store initialization.

---

## Relevant files

- `frontends/aiq_api/src/aiq_api/websocket_reconnect.py`
- `frontends/ui/src/features/chat/store.ts`
- `frontends/ui/src/features/chat/types.ts`
- `frontends/ui/src/adapters/api/schemas.ts`
- `src/aiq_agent/common/__init__.py`
- `src/aiq_agent/agents/chat_researcher/agent.py`
- `src/aiq_agent/agents/chat_researcher/register.py`
- `src/aiq_agent/fastapi_extensions/register.py`
- `src/aiq_agent/fastapi_extensions/routes/documents.py`
- `src/aiq_agent/fastapi_extensions/models/requests.py`
