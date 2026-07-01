# Chat Flow

The chat system supports three communication paths: SSE via `/api/chat`, SSE via `/api/generate`, and WebSocket via `ws://<host>/websocket`.

## SSE path: /api/chat

`frontends/ui/src/app/api/chat/route.ts`

1. Client sends `POST /api/chat` with JSON body containing `{ messages, conversationId, projectId }`
2. BFF resolves the session via `requireAuthorizedSession()` (if `REQUIRE_AUTH=true`)
3. `buildCollectionScopeFromRequest()` constructs the `X-Grid-Collection-Scope` header from session, project, and conversation
4. BFF proxies to `POST <BACKEND_URL>/chat/stream` with `Authorization` + `X-Grid-Collection-Scope` headers
5. Backend returns an SSE stream; BFF forwards it through as-is with `Content-Type: text/event-stream`
6. Frontend receives `response.body` (ReadableStream) and reads text chunks
7. Each chunk is appended to the current assistant message via `appendToAssistantMessage()`
8. On stream end, `completeAssistantMessage()` finalizes the message and persists it to the server

## SSE path: /api/generate

`frontends/ui/src/app/api/generate/route.ts`

1. Client sends `POST /api/generate` with `{ messages, conversationId, projectId, session_id }`
2. Same auth and scope resolution as `/api/chat`
3. Proxies to `POST <BACKEND_URL>/generate/stream`
4. Returns a richer SSE stream with typed events:

| SSE event data type | Purpose | Store action |
|---|---|---|
| `thinking` | Intermediate LLM reasoning | `addThinkingStep()`, `appendToThinkingStep()` |
| `complete` | Stream complete marker | `completeAssistantMessage()` |
| `error` | Generation error | `addErrorCard()` |
| `prompt` | Agent requires user input | `addAgentPrompt()`, sets `pendingInteraction` |
| `intermediate` | Partial content for Details Panel | `appendToAssistantMessage()` |
| `report` | Final report content | `setReportContent()` |

## WebSocket path

`frontends/ui/src/adapters/api/websocket-client.ts`

1. `NATWebSocketClient.connect()` opens `ws://<host>/websocket?conversationId=<id>&projectId=<id>`
2. `server.js` upgrade handler resolves auth and scope (see [WebSocket Gateway](websocket-gateway.md))
3. Client sends NAT protocol messages:

```typescript
interface NATUserMessage {
  type: 'user_message',
  schema_type: 'chat_stream',
  id: string,
  conversation_id: string,
  content: { messages: [{ role: 'user', content: [{ type: 'text', text }] }] },
  timestamp: string,
}
```

4. Backend responds with NAT protocol messages:

| NAT type | Handler | Store actions |
|---|---|---|
| `system_response` | `onResponse()` | `startAssistantMessage()`, `appendToAssistantMessage()`, `completeAssistantMessage()` |
| `system_intermediate` | `onIntermediateStep()` | `addThinkingStep()`, `addDeepResearchCitation()`, tool call tracking |
| `system_interaction` | `onHumanPrompt()` | `addAgentPrompt()`, `setPendingInteraction()` |
| `error` | `onError()` | `addErrorCard()`, `setLoading(false)` |

5. HITL responses are sent via `sendInteractionResponse(promptId, parentId, responseText)`

## Chat store

`frontends/ui/src/features/chat/store.ts`

The `useChatStore` Zustand store manages all chat state:

### Core message actions

| Action | Purpose |
|---|---|
| `addUserMessage(content, metadata?)` | Append user message, create conversation if needed, auto-generate title |
| `startAssistantMessage()` | Create empty assistant message with `isStreaming: true` |
| `appendToAssistantMessage(content)` | Append text chunks during streaming |
| `completeAssistantMessage()` | Mark message as complete, persist to server |
| `addAgentResponse(content, showViewReport?, cards?)` | Final agent response with research panel data |
| `addAgentResponseWithMeta(content, showViewReport, meta, cards?)` | Agent response with custom metadata |

### Deep research actions

| Action | Purpose |
|---|---|
| `startDeepResearch(jobId, messageId?)` | Initialize deep research state |
| `updateDeepResearchStatus(status)` | Update job status (submitted/running/success/failure) |
| `completeDeepResearch()` | Clear session storage, mark streaming as done |
| `addDeepResearchCitation(url, content, isCited?)` | Add or update a citation source |
| `setDeepResearchTodos(todos)` | Update progress checklist (debounced persist) |
| `reconnectToActiveJob()` | Reconnect SSE for an in-progress job on page return |
| `saveDeepResearchProgress()` | Snapshot current research state to conversation messages |
| `persistDeepResearchToSession()` | Save job metadata to sessionStorage for cross-tab survival |

### HITL actions

| Action | Purpose |
|---|---|
| `addAgentPrompt(type, content, options?, ...)` | Add a prompt message requiring user input |
| `respondToPrompt(messageId, response)` | Mark prompt as responded, resume loading |
| `setPendingInteraction(interaction)` | Store pending interaction for session restoration |
| `clearPendingInteraction()` | Clear HITL state |

### Thinking/report actions

| Action | Purpose |
|---|---|
| `addThinkingStep(step)` | Add intermediate reasoning step |
| `appendToThinkingStep(stepId, content)` | Stream content into a thinking step |
| `completeThinkingStep(stepId)` | Mark step complete |
| `setReportContent(content, category?)` | Set deep research report content |
| `addStatusCard(type, message?)` | Add a status system message |
| `clearThinkingSteps()` / `clearReportContent()` | Reset panel state |

### Session management

| Action | Purpose |
|---|---|
| `selectConversation(id)` | Switch conversation, restore state, clean up deep research |
| `createConversation()` | Create new conversation with default data sources |
| `startNewSessionDraft()` | Clear current conversation for a fresh draft |
| `ensureSession()` | Return current conversation ID, creating one if needed |
| `deleteConversation(id)` | Remove conversation, cancel active deep research jobs |
| `deleteAllConversations()` | Clear all user conversations, cancel all active jobs |
| `updateConversationTitle(id, title)` | Rename conversation |
| `saveDataSourcesToConversation(ids)` | Persist enabled data source IDs to conversation |
| `loadServerConversations()` | Fetch and merge server-side conversation metadata |

## Data flow summary

```
User types message
  ├─ SSE mode
  │   POST /api/chat → BFF → Python /chat/stream → SSE stream → frontend
  │   or
  │   POST /api/generate → BFF → Python /generate/stream → typed SSE → frontend
  │
  └─ WebSocket mode
      NATWebSocketClient.connect() → server.js upgrade → Python /websocket
      NAT protocol messages ↔ bidirectional
      HITL via sendInteractionResponse()
```
