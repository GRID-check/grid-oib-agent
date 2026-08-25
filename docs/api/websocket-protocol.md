# NAT WebSocket Protocol

The UI communicates with the AI-Q Python backend via the **NAT WebSocket protocol** (NeMo Agent Toolkit compatible). This provides full human-in-the-loop (HITL) support including streaming responses, intermediate steps, clarification prompts, and approval flows.

---

## Connection

### URL

```
ws://<host>/websocket?projectId=<uuid>&conversationId=<session_id>&conversation_id=<session_id>
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
| `conversationId` | No | Session ID for conversation continuity (Grid collection scoping) |
| `conversation_id` | No | Same session ID, snake_case duplicate of `conversationId`. Read by NAT's base `_restore_execution_state` to swap a reconnected socket into a still-running handler (live reattach). The client sends both keys; the backend override tolerates either. See backend-deep-dive §2c. |

---

## Gateway Handling

**File:** `frontends/ui/server.js`

The `server.js` gateway handles WebSocket upgrade requests:

1. **Upgrade interception:** The `server.on('upgrade', ...)` handler checks if `req.url` starts with `/websocket`.
2. **Scope resolution:** Calls `/api/auth/websocket-scope?projectId=xxx&conversationId=yyy` (internal HTTP request to the same server) to resolve:
   - `x-grid-collection-scope` header — passes collection scope to backend.
   - `x-grid-organization-id` / `x-grid-user-id` — forwards user context.
   - `x-grid-project-id` / `x-grid-project-context` / `x-grid-project-memory` — project id + injected profile/memory (the latter two base64url-encoded).
   - `x-grid-feature-memory-reflection` (`true`/`false`) — whether the async memory-reflection stage is enabled for the caller (per-org `memory-reflection` WorkOS flag; no env-var fallback). Fail-closed: absent → off.
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
every submission path (WS upgrade, the async-jobs REST proxy, the skill-run
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
`/v1/jobs/async/submit`, `/v1/internal/skills/submit`, `/generate`); and no
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

##### Invoking a skill (`skills`)

One further additive field inside that JSON payload names the Agent Skills
(ADR-0046) this turn invokes:

| Field | Type | Meaning |
|-------|------|---------|
| `skills` | `string[]` | Skill names to force-activate for this turn. The backend lifts the array onto the agent state as `force_skills`, so the named skills' instructions are loaded whether or not the model would have chosen them. Names that match no resolved skill are dropped silently — a typo never errors a turn. |

```typescript
text: JSON.stringify({
  query: "Prüfe die Einreichunterlagen",
  data_sources: [],
  skills: ["oib-vorpruefung"]   // omitted entirely when no skill is invoked
})
```

The field is set by the composer's `/name` invocation: typing `/` at the start
of a message opens a picker of invocable skills (`GET /api/skills/invocable`),
and the chosen name goes on the wire here — resolved from the text being sent,
so editing the token out removes the invocation. Selection is a *request*
decision, exactly like `data_sources`. See
`docs/architecture/agent-skills.md`.

##### Ingest-only messages (`context_only`)

Two **additive** fields inside that JSON payload deliver a human message to the agent
*as context* rather than as a question (ADR-0034 addendum). The agent's history is its
LangGraph checkpoint, so a message that never reaches it can never be referred back to
— a hand-off (`@Anna Weber …`, or a colleague's reply while a wait is open) has to be
in the agent's memory even though the agent must not answer it.

| Field | Type | Meaning |
|-------|------|---------|
| `context_only` | `true` | Append this turn to the conversation's state and **generate nothing**: no LLM call, no `system_response_message`, no `system_intermediate_message`, no status frame. Only the literal `true` counts. |
| `author_name` | `string` | Display name of the human who wrote it, so the agent can attribute the turn in its own history. Advisory: the backend prefers the **verified** principal's name from the handshake JWT, so a client cannot attribute text to a colleague. |

```typescript
text: JSON.stringify({
  query: "Ja, das Atrium ist ein eigener Brandabschnitt.",
  data_sources: [],
  context_only: true,          // omitted entirely for an ordinary message
  author_name: "Anna Weber"    // omitted when the display name is unknown
})
```

The frame is an ordinary `user_message` in every other respect — same `type`, same
`schema_type`, same envelope, same per-message re-auth gate. Who a message is
addressed to is decided by the **server** at persist time (`addressees`, ADR-0034 §4);
this flag only carries that ruling to the agent tier, so routing never becomes a
model's judgement.

**Client-side:** `contextOnly` / `authorName` on
`NATWebSocketClient.sendMessage(content, dataSources, options)`. An ingest-only frame
deliberately does **not** become `activeParentId` (nothing will ever be answered
against it) and is not tracked by the delivery-ack timeout — a frame that is answered
by design would otherwise trip the "no response received" banner. Delivery is
best-effort: the message is already persisted by the BFF, so a dropped context frame
costs the agent a line of memory and the thread nothing.

**Backend-side:** `websocket_reconnect.py` (`context_only_directive` →
`_ingest_context_only_message`) and `aiq_agent/conversation_context.py`. The stored
text is capped at 4000 chars (the same bound `normalize_project_context` uses) so a
pathological paste cannot bloat the checkpoint every later turn reads.

**Compatibility, both directions:**

- **New backend, old client (no field).** `context_only` is absent, which is falsy, so
  the message runs the workflow exactly as it always did. Nothing about the default
  path changed — the flag is spread into the payload only when set, never emitted as
  `context_only: false`.
- **New client, old backend (unknown field).** The frame stays a valid `user_message`,
  so nothing throws, no validation error is raised, and the socket is not closed. The
  old query parser (`_extract_query_and_sources` → `_extract_query_from_text`) reads
  only `query` / `text` / `data_sources` and ignores unknown keys, so the backend
  simply answers the message — i.e. it degrades to the behaviour that existed *before*
  this field, not to anything worse, and the human's message is persisted by the BFF
  either way. The observable cost of a version skew is one unwanted answer in a thread
  the sender can already read; the cost is never a dropped frame or a lost message.

##### Turn retrieval intent (`focus_file_name` / `focus_shelf` / `source_preset`)

The signed `X-Grid-Collection-Scope` header is the **authorization ceiling**
(which corpora this caller may read). What a *turn* actually searches is a
subtractive subset of that ceiling. The client states **intent**, never an
expanded collection list:

| Field | Type | Meaning |
|-------|------|---------|
| `focus_file_name` | `string` | Filename of the file this send is about (the composer "Asking about …" subject). Retrieval prefers it, AND it is named in the prompts. |
| `focus_shelf` | `"session"` \| `"project"` \| `"archiv"` | Shelf that file sits on. Wins over `source_preset`. |
| `source_preset` | `"law"` \| `"project"` \| `"office"` | Derived from the composer's Datenbasis switches (Baurecht is always in, so the three shelf categories collapse onto these values plus "no preset" for all-on). Used only when no subject shelf is set. |

```typescript
text: JSON.stringify({
  query: "Fass den Inhalt zusammen",
  data_sources: [],
  focus_file_name: "Protokoll.pdf",
  focus_shelf: "session"        // omitted when there is no subject file
  // source_preset: "project"   // omitted when every category is on
})
```

The backend maps that intent via `shelves_for_turn`
(`src/aiq_agent/common/focus_file.py`) and subtracts other shelves at the
knowledge-layer retrieve site. A client-supplied `include_shelves` list is
**ignored** — the mapping owns the expansion so a client cannot ask for
Archiv while claiming a project file. Absence of both shelf and preset
leaves the signed scope intact (ADR-0024). See
`docs/architecture/backend-deep-dive.md` § Collection scoping.

Absence of every field is the unscoped project turn: the signed header stands
as-is. An old backend ignores the unknown keys and searches the full authorized
scope — the pre-#429 behaviour, never a dropped frame.

`focus_file_name` is not only a retrieval hint. It is lifted onto
`ChatResearcherState` and rendered into both the routing prompt
(`intent_classification.j2`) and the answering prompt (`researcher.j2`), because
a turn that says "fass zusammen" carries its subject in the composer bar and
nowhere in its text: with retrieval scoped correctly but the model told nothing,
the answer was "which document do you mean?" over an open PDF. A bound subject
also keeps the search tools on a turn the classifier called conversational —
otherwise the one tool that can read that file is not offered. The grounding
contract still follows the classified intent, not the subject.

`focus_shelf` is optional even when a subject is set: a conversation persists
only the subject's resource id, so a thread reopened after a reload re-reads the
filename and shelf from the document (`GET /api/documents/[id]/status` returns
`filename` and `scope`). Until that lookup returns, the turn carries the file
name without a shelf and retrieval keeps the signed scope.

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
  // Optional one-clause justification the model appended to its confidence
  // marker (`[CONFIDENCE:high | <reason>]`), ≤300 chars, shown verbatim in the
  // ConfidenceChip tooltip. Absent when the model gave no reason.
  answer_confidence_reason?: string,
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
    // The [N] marker this source carries in the answer prose, resolved by
    // verify_citations (the only place that binding exists). Lets the UI render
    // ONE numbered provenance block instead of the written "## Quellen" list
    // plus an unnumbered chip row. Absent when unknown (legacy/meta turns).
    number?: number | null
    file_name?: string | null
    page?: number | null
  }>,

  // ── Transparency extras (terminal frame only) ────────────────────────────
  // Lifted onto the terminal system_response content by the gateway, alongside
  // answer_confidence / sources. All optional and additive — absent means
  // "unknown / not applicable". Each parses with per-field tolerance on the
  // client (`.catch(undefined)`), so one malformed extra never drops the
  // response text.
  routing_decision?: "meta" | "shallow" | "deep" | "error",
  routing_reason?: string,
  escalation_reason?: string,
  answer_confidence_capped_reason?: "ungrounded" | "quote_unverified" | "normative_claim_uncited" | "measurement_only" | "citation_fallback",
  citations_removed?: { count: number, reasons: string[] },
  job_admission_rejected?: true,
  retry_after_seconds?: number,
  skills_activated?: string[]
}
```

**Content formats:**
- **String:** Direct response text.
- **SystemResponseContent** (`{ text: string | null }`): Standard assistant response.
- **GenerateResponse** (`{ output: string }`): Shallow/meta response format.

The client extracts content in priority order: `output` → `text` → raw string. The `isFinal` flag is derived from `status === 'complete'`. Every structured extra is optional and fail-open when absent — `cards`, `deep_research_job_id`, `answer_confidence`, `answer_confidence_reason`, `sources`, plus the transparency extras tabled below.

**Transparency extras** (terminal frame; all optional, fail-open per-field):

| Field | Type | Meaning |
|-------|------|---------|
| `routing_decision` | `"meta" \| "shallow" \| "deep" \| "error"` | Which path the turn took after intent classification. Rendered as a "Warum dieser Weg?" line in the expanded Herleitung. |
| `routing_reason` | `string` | Human-readable "why" for the routing decision, rendered verbatim from the classifier. |
| `escalation_reason` | `string` | Present only when a shallow→deep escalation happened this turn. Rendered as `Eskaliert zur Tiefenrecherche: <reason>` in the thinking panel and above the deep-research banner. |
| `answer_confidence_reason` | `string` (≤300 chars) | The model's own one-clause justification for its self-assessed confidence, parsed from the `[CONFIDENCE:<level> \| <reason>]` marker. Shown verbatim in the ConfidenceChip tooltip under "Assistant's reason". |
| `answer_confidence_capped_reason` | `"ungrounded" \| "quote_unverified" \| "normative_claim_uncited" \| "measurement_only" \| "citation_fallback"` | Present only when confidence was downgraded by the deterministic overconfidence guard. `ungrounded` — no citation grounding and nothing measured. `quote_unverified` — a quoted span matched no retrieved passage. `normative_claim_uncited` — the answer WAS grounded in an IFC measurement but also asserts something normative with no verified citation, so it is held at "low" rather than riding out on the measurement's evidence. `measurement_only` — measured and purely descriptive, so a self-reported "high" was reduced to "medium" (measurement grounding never reaches "high"). `citation_fallback` — nothing the model cited survived verification and the grounding is the one source the agent attached from the cumulative session registry, which may predate this turn; it lifts the answer no further than a measurement does. Adds a sentence to the ConfidenceChip tooltip. |
| `citations_removed` | `{ count: number, reasons: string[] }` | Present only when citation verification removed ≥1 citation. Renders a muted note under the sources row (reasons in a tooltip). |
| `job_admission_rejected` | `true` | Marks the answer text as a queue-rejection notice (NOT a research answer). The client renders a warning banner (error code `research.queue_full`) and leaves the composer unlocked. |
| `retry_after_seconds` | `number` | Only alongside `job_admission_rejected` — retry hint (seconds). |
| `skills_activated` | `string[]` | Agent Skills whose full instructions were LOADED this turn (forced first, then those the model pulled in with `use_skill`, deduped). Absent/empty on a turn that activated none. Rendered as a quiet "Skills used" disclosure under the answer; the reconnect path persists it into assistant-message metadata. Availability is the constant, activation is the event — see `docs/architecture/agent-skills.md`. |

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

#### observability_trace_message

Diagnostic / tracing frame emitted by NAT. The frontend does **not** render
these — the variant exists so the frame is tolerated (parsed and ignored)
instead of tripping the unknown-type fallback. The payload is treated as opaque.

```typescript
{
  type: "observability_trace_message",
  id?: string,
  thread_id?: string,
  parent_id?: string,
  conversation_id?: "s_<session_id>",
  content?: unknown,   // opaque; kept passthrough, never rendered
  status?: string,
  timestamp?: "<ISO 8601>"
}
```

> **Unknown message types:** any `type` value the client does not recognize is
> logged **once per distinct type** and the frame is dropped — the parse
> pipeline never throws and subsequent frames keep flowing.

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
    input_type: "text" | "notification" | "binary_choice" | "radio"
               | "checkbox" | "dropdown" | "oauth_consent"
               // Legacy, still accepted for back-compat:
               | "multiple_choice" | "approval",
    text: "prompt text",
    options?: ["option1", "option2", ...],
    default_value?: "default text"
  },
  status: "in_progress" | "complete" | "error",
  timestamp: "<ISO 8601>"
}
```

**Input types** (aligned with NAT's real HITL enum):

| Type | Description | Client rendering |
|------|-------------|------------------|
| `text` | Free-text input | text input |
| `notification` | Informational, no response needed | — |
| `binary_choice` | Yes/no or two-option choice | approval |
| `radio` | Single choice from options | choice (OptionsList) |
| `checkbox` | Multi-select from options | choice (OptionsList) |
| `dropdown` | Select from options | choice (OptionsList) |
| `oauth_consent` | OAuth authorization consent | — |
| `multiple_choice` | **Legacy** alias — select from options | choice (OptionsList) |
| `approval` | **Legacy** — action approval (confirm/cancel) | approval |

The legacy `multiple_choice` / `approval` values remain accepted for older
backends and persisted sessions. `radio` / `checkbox` / `dropdown` all map to
the existing choice rendering (`OptionsList`).

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
    sources?: unknown[],
    /** Transparency extras lifted onto the terminal frame (routing/escalation/
     *  capped-confidence/citations-removed/queue-rejection). All optional. */
    transparency?: NATResponseTransparency
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
