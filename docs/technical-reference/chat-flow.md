# Chat Flow

The agent conversation runs over one path: a WebSocket via `ws://<host>/websocket`.
A deep-research run is a message in the thread that commissioned it (ADR-0062);
its block follows the run's own stream (`features/runs/hooks/use-run-ledger.ts`),
not this socket.

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
| `system_intermediate` | `onIntermediateStep()` | `addThinkingStep()`, tool call tracking |
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
| `addAgentResponse(content, cards?, answerConfidence?, citations?, transparency?)` | Final agent response |
| `addAgentResponseWithMeta(content, meta, cards?)` | Agent response with custom metadata |

### HITL actions

| Action | Purpose |
|---|---|
| `addAgentPrompt(type, content, options?, ...)` | Add a prompt message requiring user input |
| `respondToPrompt(messageId, response)` | Mark prompt as responded, resume loading |
| `setPendingInteraction(interaction)` | Store pending interaction for session restoration |
| `clearPendingInteraction()` | Clear HITL state |

### Thinking actions

| Action | Purpose |
|---|---|
| `addThinkingStep(step)` | Add intermediate reasoning step |
| `appendToThinkingStep(stepId, content)` | Stream content into a thinking step |
| `completeThinkingStep(stepId)` | Mark step complete |
| `clearThinkingSteps()` | Reset thinking state |

### Session management

| Action | Purpose |
|---|---|
| `selectConversation(id)` | Switch conversation, restore state |
| `createConversation()` | Create new conversation with default data sources |
| `startNewSessionDraft()` | Clear current conversation for a fresh draft |
| `ensureSession()` | Return current conversation ID, creating one if needed |
| `deleteConversation(id)` | Remove conversation, cancel the live runs in it |
| `deleteAllConversations()` | Clear the user's conversations in the current project, cancel their live runs |
| `updateConversationTitle(id, title)` | Rename conversation |
| `saveDataSourcesToConversation(ids)` | Persist enabled data source IDs to conversation |
| `loadServerConversations()` | Fetch and merge server-side conversation metadata |

## Data flow summary

```
User types message
  NATWebSocketClient.connect() → server.js upgrade → Python /websocket
  NAT protocol messages ↔ bidirectional
  HITL via sendInteractionResponse()
```
