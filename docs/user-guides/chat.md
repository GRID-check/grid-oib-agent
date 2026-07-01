# Chat

The chat interface supports two communication modes: SSE (Server-Sent Events) streaming for simple conversations, and WebSocket for real-time interaction with full HITL (human-in-the-loop) support.

## Starting a conversation

Click **New Session** in the sessions panel (left sidebar) to start a fresh conversation. Type your message in the input area at the bottom of the screen and press Enter. The first user message sets the conversation title (truncated to 50 characters).

## Sessions panel

The left sidebar lists all conversations grouped by date (Today, Yesterday, or date). Each session shows a status icon:

- **Spinner**: Active deep research job running for this session
- **Document checkmark**: Session has a completed research report
- **Ellipse**: Session has an expired research report
- **Chat bubble**: Plain chat session with no deep research

Use the search field to filter sessions by title. Rename and delete controls appear on hover. The **Delete All** button clears all sessions for the current user. Navigation is blocked during shallow thinking (WebSocket stream) or HITL prompts; deep research does not block navigation.

## Communication modes

### SSE streaming (/api/chat)

POST `/api/chat` proxies to the backend's `/chat/stream` endpoint. The response is an SSE stream of text chunks. The frontend appends chunks to the last assistant message until the stream completes.

### SSE streaming (/api/generate)

POST `/api/generate` proxies to `/generate/stream`. This endpoint emits richer typed SSE events:

| Event type | Purpose |
|---|---|
| `thinking` | Intermediate thoughts displayed in the Thinking tab |
| `complete` | End of stream marker |
| `error` | Error during generation |
| `prompt` | Agent asking for user input (HITL) |
| `intermediate` | Partial content for the Details Panel |

### WebSocket

A persistent WebSocket connection to `ws://<host>/websocket` enables real-time bidirectional communication. The `NATWebSocketClient` connects automatically when the user sends a message. Messages follow the NAT protocol:

| NAT type | Purpose |
|---|---|
| `system_response` | Final or streaming response content |
| `system_intermediate` | Thinking steps and tool calls |
| `system_interaction` | Human prompt requiring user response |
| `error` | Error with auth or processing |

The WebSocket supports auto-reconnection with exponential backoff (3 attempts, 1s delay) and an `onBeforeReconnect` callback to refresh auth cookies before the upgrade handshake.

## Deep research vs simple chat

Simple chat sends a single message through the SSE or WebSocket path and streams the assistant response back.  

Deep research submits a job to the backend and receives progress via SSE events through the `/generate/stream` endpoint. The `DeepResearchBanner` component shows submission, success, failure, cancellation, and expiry states. Users can navigate away and reconnect to an active job on return. The Research Panel displays:

- **Report tab**: Final report content
- **Sources tab**: Citations collected during research
- **Thought Traces tab**: LLM reasoning steps
- **Agents tab**: Sub-agent execution traces
- **Tool Calls tab**: Tool invocations with inputs/outputs
- **Files tab**: Generated files
- **Tasks tab**: Progress checklist

## Human-in-the-loop (HITL)

When the agent needs input — clarification, approval, or a choice — it sends a prompt message. The chat switches to a waiting state with input controls matching the prompt type:

| Input type | UI control |
|---|---|
| `text` | Text input |
| `multiple_choice` | Option selector |
| `binary_choice` | Yes/No buttons |
| `approval` | Approve/Reject buttons |
| `notification` | Acknowledge button |

The user responds through the chat UI; the response is sent back via the WebSocket's `sendInteractionResponse()` method. Pending interactions survive page refreshes through localStorage persistence and `pendingInteraction` state restoration.

## Data source toggles

Open the **Data Sources** panel (right sidebar) to enable or disable knowledge connections. The panel has two tabs:

- **Connections**: Toggle individual data sources (web search, knowledge base, etc.) on/off. A master "Disable / Enable All" switch controls all available sources. Some sources require authentication.
- **Files**: Uploaded files attached to the current session.

Enabled data source IDs are tracked per conversation in `enabledDataSourceIds` and sent with every chat message as `enabledDataSources` metadata.

## Project-scoped chat

Set a `projectId` on the store to scope the conversation context to a specific project's documents. The `buildCollectionScopeFromRequest()` function builds an ordered scope header from the session's organization, project, and conversation IDs. Project access is enforced by `requireProjectAccess()` before requests reach the backend.

## File upload

Drag and drop or select files to attach them to the current session. Uploaded files are ingested into a session-scoped Milvus collection (`s_<sessionId>`) and become part of the conversation context. File upload status is shown via `file_upload_status` system messages. File uploads trigger a `maybeDiscardAbandonedUploadOnlySession` check: sessions with only uploaded files and no user chat messages are cleaned up on navigation.

## Session persistence

Conversations persist to `localStorage` via the Zustand `persist` middleware with the key `aiq-chat-store`. The storage layer:

- Prunes message content to stay within quota limits
- Strips connection error messages on hydration (transient errors should not survive reloads)
- Reconstructs the current conversation from its ID to avoid double-serialization
- Falls back to clearing all sessions if `QuotaExceededError` is hit

On page load, `loadServerConversations()` fetches conversations from the BFF and merges server metadata (title, dates) with local messages. Deep research job statuses are refreshed via `refreshDeepResearchSessionStatuses()` after rehydration.
