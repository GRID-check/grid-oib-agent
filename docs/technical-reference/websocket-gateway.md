# WebSocket Gateway

The gateway server (`server.js`) is a Node.js HTTP server on port 3000 that acts as the single entry point for all traffic. It proxies HTTP requests to Next.js and handles WebSocket upgrade requests.

## server.js architecture

`frontends/ui/server.js`

**Development mode** (`NODE_ENV !== 'production'`):
- Gateway runs on port 3000
- HTTP requests proxied to Next.js dev server on port 3001 via `httpProxy`
- WebSocket upgrade requests for non-`/websocket` paths proxied to Next.js HMR

**Production mode**:
- Next.js is embedded in the same process (`nextApp.prepare()`)
- HTTP requests handled by `nextHandle(req, res, parsedUrl)`
- WebSocket upgrade handled by `nextApp.getUpgradeHandler()`

Key configuration:

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Gateway listen port |
| `BACKEND_URL` | `http://localhost:8000` | Python backend HTTP URL |
| `NEXT_INTERNAL_URL` | `http://localhost:3001` | Next.js dev server URL |

## WebSocket upgrade flow

`server.js:199`

```
Client WS connect → server.on('upgrade')
  → pathname === '/websocket' ?
    → fetchCollectionScopeHeader(req, projectId, conversationId)
      → internal GET /api/auth/websocket-scope?projectId=&conversationId=
    → if 401/403 → reject socket
    → set headers: x-grid-collection-scope, x-grid-organization-id,
                    x-grid-user-id, authorization
    → backendProxy.ws(req, socket, head, { target: BACKEND_WS_URL })
  → else → dev? proxy to Next.js HMR : nextApp.getUpgradeHandler()
```

The `BACKEND_WS_URL` is derived from `BACKEND_URL` by replacing `http` with `ws` (e.g., `ws://localhost:8000`).

## Scope resolution

`frontends/ui/src/app/api/auth/websocket-scope/route.ts`

Called internally (no external route) by `server.js` during WebSocket upgrade. Resolves the collection scope for the backend:

1. Reads `projectId` and `conversationId` from query params
2. Calls `getGridSession()` to resolve the WorkOS session (or null in anonymous mode)
3. If `REQUIRE_AUTH=true` and no session: returns `401`
4. If project access required: calls `requireProjectAccess()` → returns `403` on failure
5. Calls `buildCollectionScopeFromRequest(session, { projectId, conversationId })` to build the ordered scope
6. Returns JSON:
   - `scope`: The resolved scope array
   - `header`: Base64url-encoded `X-Grid-Collection-Scope` header value
   - `organizationId`: Session org ID (if authenticated)
   - `userId`: Session user ID (if authenticated)
   - `accessToken`: Raw WorkOS JWT (if authenticated)

## Headers forwarded to Python

| Header | Source | Purpose |
|---|---|---|
| `X-Grid-Collection-Scope` | Base64 JSON array from scope resolution | Tells Python which collections to query |
| `X-Grid-Organization-Id` | Session `organizationId` | Tenant identification |
| `X-Grid-User-Id` | Session `userId` | Caller identity |
| `Authorization` | `Bearer <accessToken>` | JWT for backend validation |

## NAT protocol

The `NATWebSocketClient` (`frontends/ui/src/adapters/api/websocket-client.ts`) sends and receives JSON messages typed by a `"type"` field.

### Outgoing messages

**user_message**: Standard chat query

```json
{
  "type": "user_message",
  "schema_type": "chat_stream",
  "id": "msg_<timestamp>_<counter>",
  "conversation_id": "s_<uuid>",
  "content": {
    "messages": [{ "role": "user", "content": [{ "type": "text", "text": "{\"query\":\"...\",\"data_sources\":[...]}" }] }]
  },
  "timestamp": "2026-06-30T..."
}
```

**user_interaction**: Response to a human prompt

```json
{
  "type": "user_interaction",
  "id": "msg_<timestamp>_<counter>",
  "parent_id": "<prompt_message_id>",
  "conversation_id": "s_<uuid>",
  "content": {
    "messages": [{ "role": "user", "content": [{ "type": "text", "text": "<response>" }] }]
  },
  "timestamp": "2026-06-30T..."
}
```

### Incoming messages

**system_response**: Streaming or final response

```json
{ "type": "system_response", "content": "...", "status": "streaming|complete", "parent_id": "...", "cards": [...] }
```

**system_intermediate**: Thinking steps, tool calls, citations

```json
{ "type": "system_intermediate", "content": { ... }, "status": "...", "parent_id": "..." }
```

**system_interaction**: Human prompt (HITL)

```json
{ "type": "system_interaction", "id": "...", "parent_id": "...", "content": { "type": "clarification|approval", "title": "...", "message": "...", "options": [...] } }
```

**error**: Processing or auth error

```json
{ "type": "error", "content": { "code": "CONNECTION_FAILED|token_expired|auth_expired", "message": "...", "details": "..." } }
```

Auth errors with codes `auth_error`, `token_expired`, `token_invalid`, or `auth_expired` are tracked via `trackAuthEvent()` for RUM monitoring. `auth_expired` triggers a socket rotation with `refreshAuthBeforeReconnect`.

**grid_turn_heartbeat**: the running turn is still running

```json
{ "type": "grid_turn_heartbeat", "v": 1, "conversation_id": "s_<uuid>", "parent_id": "<user_message_id>", "every_ms": 20000, "timestamp": "2026-09-05T..." }
```

Emitted every `TURN_HEARTBEAT_SECONDS` by a task that lives exactly as long as
`_run_workflow` does, so it covers what the answer stream cannot: context
loading before the graph starts, a ten-minute tool call, and the whole of a
deep-research turn that runs on this socket because no job dispatcher is
configured. It sleeps before its first beat, so a turn that answers in two
seconds sends none.

It renders nothing. Its only job is to let the client tell a turn that is quiet
because it is thinking from one that is quiet because its backend is gone — a
question the client used to answer by keeping a copy of the backend's own
`DEFAULT_MAX_RUN_SECONDS` and waiting it out, which meant forty minutes of a
locked composer for a turn that had died in the first minute.

`every_ms` is the server's stated cadence and the client's deadline is a
multiple of it (`MISSED_HEARTBEATS_BEFORE_GONE`), so the interval is retuned on
the backend alone. A turn that has never beaten — an older replica during a
rolling deploy — keeps the old generous budget; one beat is enough to switch it
over, and the switch is per turn.

Grid-owned and `grid_`-prefixed like `grid_stage_message`, and for the same
reason: NAT resolves a frame's schema through a vendored `StrEnum` that cannot
gain a member without patching the dependency.

## Reconnection

The `NATWebSocketClient` implements automatic reconnection with these characteristics:

- **Max attempts**: 3 (configurable via `reconnectAttempts`)
- **Base delay**: 1000ms between attempts (configurable via `reconnectDelay`)
- **Backoff**: Fixed delay (not exponential in the current implementation)
- **Auth refresh**: The `onBeforeReconnect` callback fires before each connect attempt, allowing the caller to refresh httpOnly auth cookies. Failures are swallowed — the connect proceeds with whatever cookies the browser has.
- **Socket rotation**: `rotate()` atomically replaces the underlying WebSocket. It detaches all event handlers from the old socket before closing it, uses a per-handler `this.ws === socket` guard against stale events, and coalesces concurrent rotation calls into a single in-flight promise.

### Connection lifecyle

```
disconnected → connect() → connecting → onopen → connected
                                                 → onclose (intentional) → disconnected
                                                 → onclose (unintentional) → handleReconnect()
                                                                             → retry < max? → connect()
                                                                             → retry >= max? → disconnected (final) + error
```
