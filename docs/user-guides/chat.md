# Chat

The chat interface supports two communication modes: SSE (Server-Sent Events) streaming for simple conversations, and WebSocket for real-time interaction with full HITL (human-in-the-loop) support.

On small screens (below the `md` breakpoint) the chat is mobile-first: the sessions and data-sources panels open as full-width overlays capped at their desktop width, the research panel takes over the whole viewport while open, and the project sidebar is replaced by a top bar with a navigation drawer.

## Starting a conversation

Click **New Session** in the sessions panel (left sidebar) or the quiet **New chat** button in the thread header to start a fresh conversation. On an empty thread the chat shows a time-of-day greeting (with your first name when available). Type your message in the composer at the bottom of the screen and press Enter. The first user message sets the conversation title (truncated to 50 characters).

## Thread header

The header shows a breadcrumb **{project} / {session title}**. Click the session title to rename it inline — Enter or clicking away commits, Escape cancels. This uses the same rename action as the sessions panel. The header also hosts the sessions-panel toggle and the Research/Sources panel buttons.

## The composer

The composer is a white card with the message field on top and a control row below, separated by a hairline:

- **Datengrundlage chip**: shows how many data sources are currently enabled and opens the existing Data Sources panel.
- **Scope chip**: shows the current project with a lock icon. Retrieval is always scoped to this project; the popover lists a disabled "All projects" option — cross-project search is not available yet.
- **Deep Research pill**: an on/off *preference*. Piloti escalates to deep research automatically when a question calls for it; the pill records your intent and shows an honest hint — it does not force a deep-research run.
- **Attach / file counter / send**: unchanged file-upload and send affordances.

Under the composer, on an empty thread, a **Shortcuts** row offers three source presets — *Baurecht & Richtlinien* (law sources such as RIS), *Projektunterlagen* (project documents; external sources off), and *Büroarchiv* (office archive). A preset maps onto the data sources the backend actually exposes; selecting one shows a colored provenance chip inside the composer, and any manual change in the Data Sources panel takes you off the preset again.

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

## Answer source chips ("Belegt durch")

Answers that already carry source data show a provenance chip row: structured citations from shallow/deep research (`origin` plus optional `file_name`/`page`, with `[KB]`/`[RIS]`/`[Web]` tokens and URL heuristics as fallback) and the laws named by `legal_basis` cards. Chips are tinted by origin (law / project / web) and always pair icon + label with the color; web and RIS chips link out. Answers without source data show no row — chips are never fabricated.

### Source preview (clicking a chip)

Clicking a source chip opens a preview of the source instead of doing nothing:

- **Web / RIS chips** keep linking out to the real source (RIS citations always hit the official Rechtsinformationssystem).
- **Knowledge chips (`[KB]`)** whose citation names a document that exists for the current project — a project upload (PDF or image) or a base-corpus PDF (OIB Richtlinien) — open an in-app viewer dialog: a provenance-tinted document-type chip plus the title in the header, the document itself in the body (deep-linked to the cited page when the citation carries one, e.g. `file.pdf, p.3`), and the cited passage in a tinted "Fundstelle" box when the citation carries passage text. Shallow and deep research attach structured `file_name` / `page` / `collection` on the wire so chips open real documents without inventing filenames in the browser.
- **Anything unresolvable** (unknown document, non-previewable file type) shows a light popover with the source's origin, title, and passage instead — never a broken viewer. Chips with nothing beyond their label stay plain.

The same affordance appears in the deep-research report's sources list: `[KB]` entries that resolve to an openable document get a small **View / Ansehen** button next to the entry.

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
