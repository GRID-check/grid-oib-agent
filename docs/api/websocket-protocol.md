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
   - `x-grid-org-instructions` — the organization's standing instructions for this turn, base64url-encoded like the two above it. Preferences on form, focus and workflow; the backend bounds it at `ORG_INSTRUCTIONS_MAX_CHARS` (1500) on decode and appends a one-line marker when it had to cut, and the prompt renders it as `## Anweisungen des Büros` below the KV-cache boundary — never as a source, and never above the rules it may not override.
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
`/v1/jobs/async/submit`, `/v1/internal/skills/submit`); and no
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

##### Invoking a skill (no wire field)

There is no `skills` field on this payload. A skill is a working method the
model picks out of its L1 catalog with `use_skill`, and nothing a request says
can require one: the array the composer used to send (lifted onto the agent
state as `force_skills`) is **no longer read anywhere in the backend**, and a
client that still sends it is ignored.

The composer's `/name` invocation writes a MENTION into the message text
instead, which is the one channel that reaches the model. Standing instructions
that used to travel as a forced skill are prompt text now: the platform prompt,
and the office's own bounded block (`X-Grid-Org-Instructions`, see the header
list above). See `docs/architecture/agent-skills.md`.

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
| `source_preset` | `"law"` \| `"project"` \| `"office"` | Composer shortcut chip. Used only when no subject shelf is set. |

```typescript
text: JSON.stringify({
  query: "Fass den Inhalt zusammen",
  data_sources: [],
  focus_file_name: "Protokoll.pdf",
  focus_shelf: "session"        // omitted when there is no subject file
  // source_preset: "project"   // omitted when no chip is pressed
})
```

The backend maps that intent via `shelves_for_turn`
(`src/aiq_agent/common/focus_file.py`) and subtracts other shelves at the
knowledge-layer retrieve site. A client-supplied `include_shelves` list is
**ignored** — the mapping owns the expansion so a client cannot ask for
Archiv while claiming a project file. A subject shelf never subtracts the
building-code corpus (`base`): it narrows which *documents* a turn reads, not
whether the law is applied. Absence of both shelf and preset
leaves the signed scope intact (ADR-0024). See
`docs/architecture/backend-deep-dive.md` § Collection scoping.

Absence of every field is the unscoped project turn: the signed header stands
as-is. An old backend ignores the unknown keys and searches the full authorized
scope — the pre-#429 behaviour, never a dropped frame.

`focus_file_name` is not only a retrieval hint. It is lifted onto
`ConversationState` and rendered into the answering prompt (`piloti.j2`),
because a turn that says "fass zusammen" carries its subject in the composer bar
and nowhere in its text: with retrieval scoped correctly but the model told
nothing, the answer was "which document do you mean?" over an open PDF. The
tool that can read the file is bound on every turn regardless (ADR-0052).

`focus_shelf` is optional even when a subject is set: a conversation persists
only the subject's resource id, so a thread reopened after a reload re-reads the
filename and shelf from the document (`GET /api/documents/[id]/status` returns
`filename` and `scope`). Until that lookup returns, the turn carries the file
name without a shelf and retrieval keeps the signed scope.

##### The subject's open version (`focus_document_id` / `focus_version_id` / `focus_version_state`)

Three more fields, additive and omitted whenever there is nothing to say. They
answer a different question from the three above: those say **which chunks to
prefer**, and this says **which version the turn is about** — because for a
version nobody has published there are no chunks to prefer.

| Field | Type | Meaning |
|-------|------|---------|
| `focus_document_id` | `string` | The subject document's id. Sent whenever the composer names a subject; from the SUBJECT only, never from a file that merely happens to be visible beside the chat. |
| `focus_version_id` | `string` | The subject's OPEN version — the one still being worked on. Omitted when the live bytes are the published ones. |
| `focus_version_state` | `"draft"` \| `"in_review"` \| `"changes_requested"` | That version's editorial state. Any other value (including `published`) leaves the turn on the retrieval path unchanged. |

Only a published version reaches the retrieval index (ADR-0054), so a draft has
no chunks, the focus filter matches nothing, and it falls open to the whole
corpus (`sources/knowledge_layer/src/register.py`) — the reader asks about the
Befund Piloti filed a minute ago and gets an answer sourced from everything
except that Befund. Told which version the subject is, the backend reads that
version's own bytes through
`GET /api/internal/document-versions/[versionId]/content` and writes them into
the conversation's working directory as `/entwuerfe/<name>.md`
(`src/aiq_agent/turn/subject_document.py`), stamped with the filing record that
makes a later `file_draft` on that path replace this version rather than file a
second document. The fail-open in the focus filter is unchanged; this is
upstream of it.

The client sends them from the composer subject, which recovers both from
`GET /api/documents/[id]/status` (`openVersion: { id, state } | null`). All
three absent is every ordinary turn, and an old backend ignores unknown keys.

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
  // The run this turn commissioned instead of answering itself (ADR-0062), and
  // the message that run narrates itself in. Present together or not at all;
  // the terminal frame's own content is EMPTY when they are, because the run's
  // block is the narration. They replace `deep_research_job_id`, which carried
  // a job id the client had to hang a panel off.
  run_id?: string,
  run_message_id?: string,
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
    // plus an unnumbered chip row. Absent when unknown (a direct reply, or
    // a backend that predates the numbering).
    number?: number | null
    file_name?: string | null
    page?: number | null
  }>,
  // Retrieved-but-uncited document identities (no prose): document key +
  // lane/kind + page. Renders the collapsed "Gelesen, nicht zitiert"
  // disclosure. Same entry shape as `sources` minus every prose key
  // (no content/snippet/score/punkt/number/binding claims).
  read_sources?: Array<{
    document_id?: string | null
    citation_key?: string | null
    file_name?: string | null
    page?: number | null
    collection?: string | null
    shelf?: string | null
    kind?: string | null
    lane?: string | null
    lane_label?: string | null
    title?: string | null
    url?: string | null
  }>,

  // ── Transparency extras (terminal frame only) ────────────────────────────
  // Lifted onto the terminal system_response content by the gateway, alongside
  // answer_confidence / sources. All optional and additive — absent means
  // "unknown / not applicable". Each parses with per-field tolerance on the
  // client (`.catch(undefined)`), so one malformed extra never drops the
  // response text.
  routing_decision?: "meta" | "shallow" | "deep" | "error",
  escalation_reason?: string,
  answer_confidence_capped_reason?: "ungrounded" | "quote_unverified" | "normative_claim_uncited" | "measurement_only" | "citation_fallback",
  citations_removed?: { count: number, reasons: string[] },
  job_admission_rejected?: true,
  retry_after_seconds?: number,
  skills_activated?: string[],
  retrieval_ledger?: RetrievalLedgerEntry[],

  // ── Also on live frames (ADR-0066) ───────────────────────────────────────
  // The masthead (kind / topic / context / verdict / summary), gated
  // backend-side and sanitized again by `sanitizeAnswerMeta`. On the terminal
  // and on the live frames below.
  answer_meta?: Record<string, unknown>,
  // Only on an `in_progress` snapshot: its content REPLACES the streaming
  // bubble's text instead of appending. Never on the terminal.
  stream_replace?: true,
}

```typescript
/** One announced retrieval round, as the backend recorded it. */
interface RetrievalLedgerEntry {
  index: number
  key: string
  tools: string[]
  corpora: string[]
  query?: string
  /** The round's own words, verbatim — narration, never a verdict. */
  reason?: string
  /**
   * One entry per PASSAGE. `repeat` is the backend's verdict on that passage;
   * it is absent on turns stored before the backend stamped it.
   */
  docs: { name: string; title?: string; detail?: string; shelf?: string; repeat?: boolean }[]
  /**
   * The documents with at least one passage that was not a repeat. Empty
   * means the round re-fetched everything it returned.
   */
  new_docs: string[]
  /** Entries in `docs` (one file at two pages counts twice). */
  hits: number
  /** Distinct documents in `docs` (one file at two pages counts once). */
  documents: number
}
```

**Content formats:**
- **String:** Direct response text.
- **SystemResponseContent** (`{ text: string | null }`): Standard assistant response.
- **GenerateResponse** (`{ output: string }`): Shallow/meta response format.

The client extracts content in priority order: `output` → `text` → raw string. The `isFinal` flag is derived from `status === 'complete'`. Every structured extra is optional and fail-open when absent — `cards`, `run_id`, `run_message_id`, `answer_confidence`, `answer_confidence_reason`, `sources`, `read_sources`, plus the transparency extras tabled below.

**Transparency extras** (terminal frame; all optional, fail-open per-field):

| Field | Type | Meaning |
|-------|------|---------|
| `routing_decision` | `"meta" \| "shallow" \| "deep" \| "error"` | Which path the turn took, OBSERVED after the answer, never decided up front (ADR-0052): `meta` when the agent consulted no data source and gave no self-assessment (a direct reply), `shallow` otherwise, `deep` on a hand-off to deep research, `error` on a failed turn. Kept on the wire for the post-answer stages and transparency; there is no "Warum dieser Weg?" line any more because there is no upfront decision to attribute. |
| `escalation_reason` | `string` | Present only when a shallow→deep escalation happened this turn: the model's own one-clause reason from its answer envelope. Rendered as `Eskaliert zur Tiefenrecherche: <reason>` in the thinking panel and above the deep-research banner. |
| `answer_confidence_reason` | `string` (≤300 chars) | The model's own one-clause justification for its self-assessed confidence, parsed from the `[CONFIDENCE:<level> \| <reason>]` marker. Shown verbatim in the ConfidenceChip tooltip under "Assistant's reason". |
| `answer_confidence_capped_reason` | `"ungrounded" \| "quote_unverified" \| "normative_claim_uncited" \| "measurement_only" \| "citation_fallback"` | Present only when confidence was downgraded by the deterministic overconfidence guard. `ungrounded` — no citation grounding and nothing measured. `quote_unverified` — a quoted span matched no retrieved passage. `normative_claim_uncited` — the answer WAS grounded in an IFC measurement but also asserts something normative with no verified citation, so it is held at "low" rather than riding out on the measurement's evidence. `measurement_only` — measured and purely descriptive, so a self-reported "high" was reduced to "medium" (measurement grounding never reaches "high"). `citation_fallback` — nothing the model cited survived verification and the grounding is the one source the agent attached from the cumulative session registry, which may predate this turn; it lifts the answer no further than a measurement does. Adds a sentence to the ConfidenceChip tooltip. |
| `citations_removed` | `{ count: number, reasons: string[] }` | Present only when citation verification removed ≥1 citation. Renders a muted note under the sources row (reasons in a tooltip). |
| `read_sources` | `Array<{ document_id?, citation_key?, file_name?, page?, collection?, shelf?, kind?, lane?, lane_label?, title?, url? }>` | Retrieved-but-uncited documents this turn: identity + placement, NO prose. Renders the collapsed "Gelesen, nicht zitiert" disclosure inside the answer details (muted document chips, capped at eight with an overflow count). Absent when everything retrieved was cited. |
| `job_admission_rejected` | `true` | Marks the answer text as a queue-rejection notice (NOT a research answer). The client renders a warning banner (error code `research.queue_full`) and leaves the composer unlocked. |
| `retry_after_seconds` | `number` | Only alongside `job_admission_rejected` — retry hint (seconds). |
| `skills_activated` | `string[]` | Agent Skills whose full instructions were LOADED this turn — the ones the model pulled in with `use_skill`, in call order, deduped. Absent/empty on a turn that activated none. Rendered as a quiet "Skills used" disclosure under the answer; the reconnect path persists it into assistant-message metadata. Availability is the constant, activation is the event — see `docs/architecture/agent-skills.md`. |
| `retrieval_ledger` | `RetrievalLedgerEntry[]` | The backend's own account of this turn's retrieval rounds: per announced round what it was asked (query, tools), what it returned, and which documents it did work on (`new_docs`); `hits`/`documents` are tallies over `docs`. Absent when no round was announced. One `docs` entry is one PASSAGE — a document (`name`, `title`, `shelf`) at a page or Punkt (`detail`) — carrying `repeat: boolean`: true when an earlier round already returned that exact (document, `detail`) pair, or when an earlier round OPENED that document with a locator tool (`read_passage`). A search that merely ranked a document does not make the later open of it a repeat. `new_docs` is the document-level derivation of the same marks: a document is listed when at least one of its passages here is not a repeat. `repeat` is absent on turns stored before the backend stamped it, and the renderer then falls back to `new_docs`. The Herleitung spine draws each round's fan from it, one card per document: the pages or Punkte that round reached, listed under the card, „bereits abgerufen" on the passages it fetched a second time, and an „Öffnen" step kind for a round that only opened passages. Persisted into message metadata/provenance so reloads read the same account. Nothing retrieves outside it: the answer repair corrects a quote against a passage already in this turn's registry and retrieves nothing (ADR-0067). |

#### Live frames (ADR-0066)

While the final call writes the answer, `in_progress` frames carry the prose
as it is written. Each is one of four kinds, told apart by what it carries:

| Frame | Fields | Client action |
|-------|--------|---------------|
| Delta | `content` | Append to the streaming bubble. A `[N]` with no source yet renders as a pending citation. |
| Snapshot | `content`, `sources`, `stream_replace: true`, `answer_meta` | Replace the bubble's text with the settled prose: citations verified and renumbered, the pending markers now pointing at `sources`. The citations are replaced too, and an empty `sources` clears them. A snapshot without `answer_meta` removes the masthead: the backend re-gated it against the prose and dropped it. Sent at most once per answering call, when the envelope's `answer` string closes; not at all when the prose has no sources section or the turn retrieved nothing, and the streamed text then stands until `complete`. The exception is an empty snapshot (`content: ""` and no `sources` field, since the backend attaches `sources` only when non-empty): it retracts a streamed call that turned out to be a tool round. It clears the cards that round drew along with its text, citations and masthead. A later call may stream again, and send its own snapshot, but need not. |
| Masthead | empty `content`, `answer_meta` | Set the masthead above the prose. The text is unchanged. |
| Cards | empty `content`, `cards` | Fill the `[[card:N]]` placeholders with the cards written so far. The text is unchanged. Sent only while no tool pushed a card this turn. |

None of them is persisted. The `complete` frame that follows replaces the text
again and is authoritative: what it omits (a card suppressed, a masthead gated
out) the client drops. Its `sources` go with its text, since the `[N]` markers
are numbered against them: a `complete` with text and no `sources` clears the
citations. Only a `complete` with blank text keeps what the live frames
brought, text and citations both. Live deltas need not concatenate to the final text; on
a buffered turn (no live prose) the deltas are the finished text cut into
pieces and do.

Two folds consume these frames: the asker's store (`messages-store.ts`) and the
observer's (`spectator-frames.ts`, via `GET /api/conversations/{id}/live`).
Both must apply the same rules. Design:
[`streaming-chat-answer.md`](../design/streaming-chat-answer.md#live-frames-adr-0066).

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

## No HTTP alternative for a turn

The socket is the only route a turn runs through. NAT's HTTP streaming routes
(`/chat/stream`, `/generate/stream` and the rest) are not served
([`python-endpoints.md`](python-endpoints.md#chat--generation)).

### Run event streams

A run — a deep-research run, a task run — streams its own events from
`job_events` rather than over the socket: `GET /v1/jobs/async/{jobId}/events`
(`aiq_api.routes.jobs.stream_job_events`), replayable from `last_event_id`. That
stream carries the `job.*` lifecycle events (`job.phase`, `job.heartbeat`,
`job.degraded`, `job.error`, `job.cancelled`), the `artifact.update` events the
agent callbacks emit, and one more:

| Event | Payload | Meaning |
|---|---|---|
| `run.ledger` | `{"ledger": RunLedger}` | The run's WHOLE account of itself, as of this moment |

`RunLedger` is the contract in
[`frontends/ui/src/lib/runs/run-ledger-types.ts`](../../frontends/ui/src/lib/runs/run-ledger-types.ts)
(`runId`, `status`, `phases[]`, `steps[]` with the intent the runner stated and
the documents each step reached, `result` or `error`) — the same shape stored on
the run's message as `metadata.run_ledger`, and the same one the JSON Schema
fixture `frontends/ui/tests/fixtures/run-ledger.schema.json` pins.

Two properties a client should rely on:

- **It is a snapshot, not a delta.** Replace what you hold with the payload. The
  ledger is folded in exactly one place (`aiq_api.jobs.run_ledger_fold`), and a
  client that folded its own from the raw events would be a second account of
  one run, differing from the stored one precisely when something went wrong.
- **It is emitted on every flush** — debounced to about a second, and always on
  a phase transition and at the end — so a late subscriber gets the whole
  account with the next one, and a replay from `last_event_id` ends on the
  newest.

`job.phase` keeps its own shape (`{"phase": ..., "batch_index": ...,
"batch_size": ..., "conclusion": ...}`); the ledger is what those events fold
into, and the status pill still reads them directly.

**How the browser consumes it.** The block in the thread
(`frontends/ui/src/features/runs/hooks/use-run-ledger.ts`) does exactly what the
two properties above allow and nothing more. It starts from the ledger stored on
the run's message (`metadata.run_ledger`, read back sanitised by the message
mapper); if that ledger is not terminal it reads
`GET /api/projects/[id]/runs/[runId]` for `backendJobId`, opens the stream
through the same-origin proxy (`/api/jobs/async/job/[jobId]/stream`, the SSE
client in `frontends/ui/src/adapters/api/deep-research-client.ts`) with **no**
`last_event_id`, so the replay runs from the first flush and the newest snapshot
lands last, and wires only `onLedger`. Every snapshot goes through
`sanitizeRunLedger` and **replaces** what is held, unless its `updatedAt` is older
than what is already shown (the stored ledger can be ahead of the replay's first
frames). On a terminal status the client disconnects; on unmount it disconnects.
Each block holds its own subscription, keyed by run id — several live runs in one
thread are the normal case. A refused read or a stream that never opens leaves the
stored ledger on screen; a reload shows the same block either way.
