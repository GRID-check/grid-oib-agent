# NAT WebSocket Protocol

The UI communicates with the AI-Q Python backend via the **NAT WebSocket protocol** (NeMo Agent Toolkit compatible). This provides full human-in-the-loop (HITL) support including streaming responses, intermediate steps, clarification prompts, and approval flows.

---

## Connection

### URL

```
ws://<host>/websocket?projectId=<uuid>&conversationId=<session_id>
```

- **Client-side (browser):** Connects to the same origin; the UI gateway server proxies to the backend.
- **Server-side (SSR/Node):** Connects directly to `ws://<BACKEND_URL>/websocket`.

The URL is built by `getWebSocketUrl()` in `frontends/ui/src/adapters/api/config.ts`:

```typescript
// Browser: same-origin, proxied through UI server
ws://window.location.host/websocket

// Server: direct to backend
ws://BACKEND_URL/websocket
```

### Query Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `projectId` | No | UUID scoping the backend Milvus collection |
| `conversationId` | No | Session ID for conversation continuity |

---

## Gateway Handling

**File:** `frontends/ui/server.js`

The `server.js` gateway handles WebSocket upgrade requests:

1. **Upgrade interception:** The `server.on('upgrade', ...)` handler checks if `req.url` starts with `/websocket`.
2. **Scope resolution:** Calls `/api/auth/websocket-scope?projectId=xxx&conversationId=yyy` (internal HTTP request to the same server) to resolve:
   - `x-grid-collection-scope` header — passes collection scope to backend.
   - `x-grid-organization-id` / `x-grid-user-id` — forwards user context.
   - `x-grid-project-id` / `x-grid-project-context` / `x-grid-project-memory` — project id + injected profile/memory (the latter two base64url-encoded).
   - `x-grid-feature-memory-reflection` (`true`/`false`) — whether the async memory-reflection stage is enabled for the caller (per-org `memory-reflection` WorkOS flag, or the `MEMORY_REFLECTION_ENABLED` env fallback). Fail-closed: absent → off.
   - `authorization: Bearer <accessToken>` — forwards backend access token.
3. **Backend proxy:** Forwards the upgraded socket to `BACKEND_WS_URL + '/websocket'`.
4. **Auth rejection:** If scope resolution returns 401/403, the gateway writes the HTTP error response and destroys the socket without proxying.
5. **Cookie forwarding:** Cookies from the original request are forwarded to the backend for AuthKit session validation.

### Signed context envelope (backlog T3-9, 2026-07-16)

Alongside every individual `x-grid-*` header above, `server.js` now also sends
`X-Grid-Request-Context` (base64url JSON consolidating all of them into one
object, plus `bundesland` — a structured jurisdiction field with no
individual-header equivalent) and `X-Grid-Request-Context-Sig` (hex
HMAC-SHA256 of the envelope's raw JSON, keyed on `GRID_INTERNAL_API_TOKEN`).
This is a **dual-write transition**: the individual headers are unchanged and
still sent; the envelope rides alongside them. The same envelope is minted by
every submission path (WS upgrade, the async-jobs REST proxy, the workflows
internal-submit path) via the shared builder
(`frontends/ui/src/lib/request-context.ts`'s `buildGridRequestContextWireHeaders`,
duplicated with a pinning comment in `server.js` since it is plain CommonJS).

Backend-side, `aiq_agent.project_context.GridRequestContext.from_context()`
prefers a present-and-valid envelope over the individual headers; an
invalid/missing signature is treated as an ABSENT envelope (logged as a
WARNING tamper signal), falling back to parsing the individual headers
exactly as before the envelope existed.

**Enforcement matrix** (`aiq_api.context_envelope.GridContextEnvelopeMiddleware`,
403 / WS policy-violation close): applies only when ALL of — `REQUIRE_AUTH=true`;
the caller is a WorkOS-authenticated JWT user (not internal-token, not
anonymous); the path is on the conservative enforced allowlist (`/websocket`,
`/v1/jobs/async/submit`, `/v1/internal/workflows/submit`, `/generate`); and no
valid envelope is present. Exempt regardless of path: anonymous mode
(`REQUIRE_AUTH=false`), internal-token-authenticated service calls, and every
non-enumerated path — the enforced-path list is an allowlist, not a denylist.
See `docs/architecture/backend-deep-dive.md` and
`frontends/aiq_api/src/aiq_api/context_envelope.py`'s module docstring for the
full design.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKEND_URL` | `http://localhost:8000` | Backend HTTP URL |
| `NEXT_PUBLIC_BACKEND_URL` | Falls back to `BACKEND_URL` | Browser-accessible backend URL |

The WebSocket URL is derived by replacing `http` → `ws` in `BACKEND_URL`. Keep-alive is set to 15 seconds on upstream sockets.

---

## Message Types

All WebSocket messages are JSON. Outgoing (client → server) and incoming (server → client) messages follow typed schemas validated with Zod at the adapter boundary.

### Outgoing Messages (Client → Server)

#### user_message

Sent when the user submits a chat message.

```typescript
{
  type: "user_message",
  schema_type: "chat_stream",  // or "generate", "generate_stream", "chat"
  id: "msg_<timestamp>_<counter>",
  conversation_id: "s_<session_id>",
  content: {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              query: "user message text",
              data_sources: ["source_id_1", "source_id_2"]
            })
          }
        ]
      }
    ]
  },
  timestamp: "<ISO 8601>"
}
```

The `content.text` field is a JSON-encoded string containing both the query text and the list of enabled data source IDs.

#### user_interaction_message

Sent when the user responds to a human prompt (clarification, approval, choice).

```typescript
{
  type: "user_interaction_message",
  id: "msg_<timestamp>_<counter>",
  parent_id: "<prompt_message_id>",
  conversation_id: "s_<session_id>",
  content: {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "response text" }
        ]
      }
    ]
  },
  timestamp: "<ISO 8601>"
}
```

### Incoming Messages (Server → Client)

#### system_response_message

Delivers final or streaming response text.

```typescript
{
  type: "system_response_message",
  id: "<message_id>",
  thread_id: "<thread_id>",
  parent_id: "<parent_message_id>",
  conversation_id: "s_<session_id>",
  content: "<string>" | { role?: "assistant", text?: string | null }
            | { output: string, value?: string, intermediate_steps?: [...] | null },
  status: "in_progress" | "complete" | "error",
  timestamp: "<ISO 8601>",
  cards?: [...],
  deep_research_job_id?: string,
  answer_confidence?: "low" | "medium" | "high",
  // Structured sources from the research registry (shallow path). Enables
  // Belegt-durch chips to open OIB/project PDFs via file_name + page.
  sources?: Array<{
    content?: string
    url?: string | null
    title?: string | null
    citation_key?: string | null
    collection?: string | null
    source_type?: string | null
    tool?: string | null
    origin?: "kb" | "ris" | "web" | string | null
    file_name?: string | null
    page?: number | null
  }>
}
```

**Content formats:**
- **String:** Direct response text.
- **SystemResponseContent** (`{ text: string | null }`): Standard assistant response.
- **GenerateResponse** (`{ output: string }`): Shallow/meta response format.

The client extracts content in priority order: `output` → `text` → raw string. The `isFinal` flag is derived from `status === 'complete'`. Structured extras (`cards`, `deep_research_job_id`, `answer_confidence`, `sources`) are optional and fail-open when absent.

#### system_intermediate_message

Streaming thinking steps, tool calls, and intermediate agent output.

```typescript
{
  type: "system_intermediate_message",
  id: "<message_id>",
  thread_id: "<thread_id>",
  parent_id: "<parent_message_id>",
  conversation_id: "s_<session_id>",
  content: { name: string, payload: string } | string,
  status: "in_progress" | "complete" | "error",
  timestamp: "<ISO 8601>"
}
```

#### system_interaction_message

Human-in-the-loop prompt — the agent is waiting for user input.

```typescript
{
  type: "system_interaction_message",
  id: "<message_id>",
  thread_id: "<thread_id>",
  parent_id: "<parent_message_id>",
  conversation_id: "s_<session_id>",
  content: {
    input_type: "text" | "multiple_choice" | "binary_choice"
               | "approval" | "notification" | "oauth_consent",
    text: "prompt text",
    options?: ["option1", "option2", ...],
    default_value?: "default text"
  },
  status: "in_progress" | "complete" | "error",
  timestamp: "<ISO 8601>"
}
```

**Input types:**

| Type | Description |
|------|-------------|
| `text` | Free-text input |
| `multiple_choice` | Select from options array |
| `binary_choice` | Yes/no or two-option choice |
| `approval` | Action approval (confirm/cancel) |
| `notification` | Informational, no response needed |
| `oauth_consent` | OAuth authorization consent |

#### error_message

Protocol-level errors.

```typescript
{
  type: "error_message",
  id: "<message_id>",
  conversation_id: "s_<session_id>",
  content: {
    code: "CONNECTION_FAILED" | "auth_error" | "token_expired"
        | "token_invalid" | "auth_expired" | "...",
    message: "Human-readable error description",
    details?: "optional detail string"
  },
  status: "error",
  timestamp: "<ISO 8601>"
}
```

**Auth error codes** trigger RUM tracking (`trackAuthEvent`) and (for `auth_expired`) an automatic socket rotation with auth refresh.

---

## NATWebSocketClient

**File:** `frontends/ui/src/adapters/api/websocket-client.ts`

### Constructor Options

```typescript
interface NATWebSocketClientOptions {
  conversationId: string
  projectId?: string
  callbacks: NATWebSocketClientCallbacks
  reconnectAttempts?: number       // default: 3
  reconnectDelay?: number          // default: 1000ms
  websocketUrl?: string            // override (uses same-origin by default)
  onBeforeReconnect?: () => Promise<void>  // auth refresh hook
}
```

### Callbacks

```typescript
interface NATWebSocketClientCallbacks {
  onResponse?: (
    content: string,
    status: string,
    isFinal: boolean,
    parentId?: string,
    cards?: unknown[],
    deepResearchJobId?: string,
    answerConfidence?: 'low' | 'medium' | 'high',
    /** Structured registry sources (file_name/page/collection/origin/url) for Belegt-durch chips */
    sources?: unknown[]
  ) => void
  onIntermediateStep?: (
    content: NATIntermediateStepContent | string,
    status: string,
    parentId?: string
  ) => void
  onHumanPrompt?: (
    promptId: string,
    parentId: string,
    prompt: NATHumanPrompt
  ) => void
  onError?: (error: NATErrorContent) => void
  onConnectionChange?: (
    status: ConnectionStatus,
    context?: ConnectionChangeContext
  ) => void
}
```

### Connection States

```typescript
type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'
```

A `ConnectionChangeContext` with `{ intentional?: boolean }` distinguishes user-initiated disconnects from unexpected drops.

### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `connect` | `() => Promise<void>` | Opens WebSocket, runs `onBeforeReconnect` if set |
| `disconnect` | `() => void` | Closes socket cleanly, marks as intentional |
| `rotate` | `() => Promise<void>` | Atomically swaps socket (detach handlers → close old → connect new). Coalesces concurrent calls via a single in-flight promise. |
| `sendMessage` | `(content: string, enabledDataSources?: string[]) => string \| null` | Sends a user message, returns message ID |
| `sendInteractionResponse` | `(promptId: string, parentId: string, responseText: string) => string \| null` | Sends response to a human prompt |
| `isConnected` | `() => boolean` | Checks `WebSocket.OPEN` |
| `updateConversationId` | `(id: string) => void` | Switches conversation scope |

### Auto-Reconnect

When a WebSocket closes unintentionally:

1. The client notifies `onConnectionChange('disconnected')` or `onConnectionChange('error')` (depending on whether an `onerror` preceded the close).
2. After a **fixed delay** (`reconnectDelay`, default 1000ms), it attempts to reconnect.
3. On each attempt, `reconnectCount` increments.
4. If all `reconnectAttempts` (default 3) are exhausted, the client calls `onError` with `{ code: 'CONNECTION_FAILED', message: '...' }` and notifies `onConnectionChange('disconnected')`.

The `onBeforeReconnect` hook is called before each connect attempt to refresh auth credentials (the WebSocket handshake is the only point where the backend reads auth).

### Socket Rotation

The `rotate()` method provides an atomic socket swap to avoid race conditions between `disconnect()` and `connect()`:

1. Detaches all event handlers (`onopen`, `onclose`, `onerror`, `onmessage`) from the old socket.
2. Closes the old socket.
3. Resets `isIntentionallyClosed`, `reconnectCount`, and `errorBeforeClose`.
4. Calls `connect()` to open a fresh socket.

Each handler also captures the source socket in its closure and checks `this.ws === socket` at the top, providing defense-in-depth against stale events.

---

## SSE Alternative

For environments where WebSocket is unavailable, the backend also supports streaming via HTTP SSE:

```
POST /chat/stream
```

Configured via `apiConfig.chatStreamUrl` pointing to the backend URL. The SSE endpoint provides equivalent functionality for non-streaming or restricted-network scenarios.
