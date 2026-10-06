# Chat WebSocket protocol (wire v2)

The UI talks to the agent tier over one WebSocket per conversation. Every
message on it is a typed JSON object of **chat wire v2**: the server sends
events (`RUN_STARTED` … `RUN_FINISHED`, AG-UI's names), the client sends four
messages. The design, and why it replaced NAT's step stream, is
[`design/chat-wire-v2.md`](../design/chat-wire-v2.md) (ADR-0068).

**The contract is code, not this page.** `src/aiq_agent/common/wire_v2.py`
(Pydantic) is the source. `shared/wire/v2.schema.json` is its JSON Schema,
`frontends/ui/src/adapters/api/wire-v2.generated.ts` the Zod module generated
from that (`npm run generate:wire`; the `wire-schemas` pre-commit hook fails a
commit that leaves either stale), and `shared/wire/v2/*.jsonl` the recorded
turns both sides test against, byte for byte. When this page and the models
disagree, the models are right and this page is a bug.

There is one version. No `v: 1` reader, no NAT frame, no fallback that
interprets a shape the contract does not describe. A frame that does not parse
is never dropped and waited past: before the `hello` it means the server does
not speak this wire, after it that the server speaks a newer v2 than the page
(see [The client](#the-client)).

---

## Connection

```
ws://<host>/websocket?v=2&projectId=<uuid>&conversationId=<session_id>
```

- **Browser:** same origin; `server.js` proxies to the agent tier.
- **`v=2` is required.** The server closes any other version with **`4426`**
  (`CLOSE_CLIENT_OUTDATED`); the client turns that into "Piloti was updated,
  reload". An older bundle gets its ordinary connection-failed banner: nothing
  is said to it in its own dialect.
- **The server speaks first: `hello`.** Once the version and the caller have
  passed, the first frame on every socket is
  `{"v":2,"type":"CUSTOM","name":"hello","ts":…,"value":{"build":"<sha>"}}`
  (`build` is `GRID_GIT_SHA`, or `unknown`, as `/health` has it). It is the
  other half of the version gate: `4426` tells an old page it is old, `hello`
  tells a current page the server is current. A server that predates this wire
  (NAT's stock socket) accepts the upgrade, ignores `?v=2` and never closes
  with `4426`, so without a hello the page cannot tell it from a server that is
  thinking. The client sends nothing until the hello arrives (see
  [The client](#the-client)). It is a connection frame, not a turn's: no
  `conversation_id`, `turn_id` or `seq`, never on the stream, never replayed.
- **A socket serves one conversation**, the one the scope route authorized and
  signed into the context envelope. A client message naming another
  conversation is refused with `rejected{conversation_mismatch}`; the socket
  stays open. To talk in another conversation, open a socket for it.
- **A restricted scope is narrowed per turn, not per socket (ADR-0081).** When
  the signed scope carries a restricted folder's collection, the agent asks
  the BFF at the start of every turn which of them the asker and everyone the
  conversation is shared with may read now
  (`POST /api/internal/conversations/[id]/restricted-use`), and searches only
  those. A thread shared since the upgrade keeps its socket; the server no
  longer closes it (the `4412` close of ADR-0080 is retired).
- **Auth** is read at the handshake and every client message re-checks the
  token's `exp`; an expired one is refused with `rejected{auth_expired}`, and
  the client reconnects with a fresh token.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `v` | Yes | The wire version, `2`. |
| `projectId` | No | UUID scoping the project's collections. |
| `conversationId` | No | The conversation this socket serves. |

---

## Gateway Handling

**File:** `frontends/ui/server.js`

The `server.js` gateway handles WebSocket upgrade requests:

1. **Upgrade interception:** The `server.on('upgrade', ...)` handler checks if `req.url` starts with `/websocket`, then removes every inbound `x-grid-*`, `authorization` and `x-internal-token` header (`src/lib/proxy/ws-upgrade-headers.js`). Only the proxy sets those; before 2026-09 a client's own header survived whenever the scope below had no value to overwrite it with.
2. **Scope resolution:** Calls `/api/auth/websocket-scope?projectId=xxx&conversationId=yyy` (internal HTTP request to the same server) to resolve:
   - `x-grid-collection-scope` header — passes collection scope to backend.
   - `x-grid-organization-id` / `x-grid-user-id` — forwards user context.
   - `x-grid-project-id` — the authorized project. Authenticated handshakes do
     not carry the project brief, memory or office instructions: those are
     loaded over HTTP at turn setup (ADR-0077).
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
Legacy HTTP/job callers keep the **dual-write transition**: individual headers
and the envelope are still sent together. Authenticated WebSocket handshakes
instead omit `projectContext`, `projectMemory` and `orgInstructions` from both
carriers and sign `contextTransport: "bff"`. Remaining context headers have an
encoded-byte budget so an oversized capsule is refused explicitly. The envelope is minted by
every submission path (WS upgrade, the async-jobs REST proxy, the skill-run
internal-submit path) via the shared builder
(`frontends/ui/src/lib/request-context.ts`'s `buildGridRequestContextWireHeaders`,
duplicated with a pinning comment in `server.js` since it is plain CommonJS).

For compact WebSocket mode, the agent calls `POST /api/internal/turn-context`
at the beginning of every turn, echoing the signed requester capsule and
service authentication. Its optional JSON `query` is bounded to 2,000
characters; user, organization, project and conversation are derived only from
the verified capsule. The BFF resolves the current requester membership and
checks project/conversation access, then returns the three prompt blocks in
the JSON response body. An authenticated context read failure ends the turn
with an explicit error instead of answering without its project context.
Legacy and anonymous callers retain their previous inline-context behavior.
Deploy backend support before the frontend starts emitting compact mode.

Backend-side, `aiq_agent.project_context.GridRequestContext.from_context()`
prefers a present-and-valid envelope over the individual headers; an
invalid/missing signature is treated as an ABSENT envelope (logged as a
WARNING tamper signal), falling back to parsing the individual headers
exactly as before the envelope existed.

**Enforcement matrix** (`aiq_api.context_envelope.GridContextEnvelopeMiddleware`,
403 / WS policy-violation close): applies only when ALL of — `REQUIRE_AUTH=true`;
the caller is a WorkOS-authenticated JWT user (not internal-token, not
anonymous); the path is NOT on the short exempt list; and no valid envelope is
present. **Deny by default**: every path needs the envelope, `/websocket` and
all of NAT's workflow routes (`/chat`, `/v1/chat`, `/v1/chat/completions`,
`/v1/workflow`, `/generate`, … and their `/stream` forms) included, except
`ENVELOPE_EXEMPT_HTTP_PATH_PREFIXES` — `/health`, `/v1/collections`,
`/v1/documents`, `/v1/data_sources`, `/v1/jobs/async/jobs`,
`/v1/jobs/async/job`, `/v1/jobs/async/agents`, `/v1/drafts` — which run no
workflow and which a BFF proxy forwards with the member's bearer alone. The
list used to be the other way round (an allowlist of enforced paths), and the
unlisted NAT routes ran full agent turns with no organization, budget or
source policy. Always exempt: anonymous mode (`REQUIRE_AUTH=false`) and
internal-token-authenticated service calls.
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

## Events (server → client)

Every event carries the envelope:

| Field | Meaning |
|---|---|
| `v` | `2` |
| `type` | The event (below). `CUSTOM` events also carry `name` and `value`. |
| `conversation_id` | The conversation. |
| `turn_id` | The client's `message_id` of the question this turn answers. |
| `seq` | 1 at `RUN_STARTED`, then +1 per event of the turn, the stage events after `RUN_FINISHED` included. `0` only on an out-of-band `rejected`. |
| `ts` | Server clock, epoch ms. |

A frame omits every field at its default, and always carries its
discriminators (`v`, `type`, `name`, `kind`); the reader's schema restores the
defaults. No field is ever `null`.

```json
{"v":2,"type":"TEXT_MESSAGE_CONTENT","conversation_id":"s_1","turn_id":"msg_1759000000000_3","seq":12,"ts":1759000003120,"message_id":"8f0c…","delta":"Für Gebäudeklasse 4 "}
```

| Event | Payload | Client action |
|---|---|---|
| `RUN_STARTED` | `message_id`: the answer's deterministic id | The delivery ack, sent before any setup I/O. Key the answer bubble by `message_id` from now on. |
| `TEXT_MESSAGE_START` | `message_id` | The first prose of a streamed call; streaming starts. |
| `TEXT_MESSAGE_CONTENT` | `message_id`, `delta` (≥ 1 char) | Append. Coalesced by the producer to at most one per 50 ms. A `[N]` with no source yet renders as a pending citation. |
| `TEXT_MESSAGE_END` | `message_id` | The envelope's `answer` string closed. A snapshot may follow; the terminal will. |
| `STATE_SNAPSHOT` | `snapshot: {text, sources[], answer_meta?}` | ADR-0066's settle: **replace** text, citations and masthead with the verified, renumbered prose. An absent `answer_meta` removes the masthead. Cards are untouched. |
| `STEP_STARTED` / `STEP_FINISHED` | `step`: a typed step (below) | One Herleitung row. A step with a duration sends STARTED, then FINISHED with the same `id`; an instant step sends only FINISHED. The same `id` again **replaces** the row. |
| `RUN_FINISHED` | `outcome: answered \| refused \| handed_off \| cancelled`, `result: TurnResult` | The terminal. Replace text, cards (by key), sources and masthead with `result`; streaming ends. Authoritative: what it omits (a card suppressed, a masthead gated out) is dropped. It is what the server persists. |
| `RUN_ERROR` | `code: workflow_error \| auth_error \| interaction_expired`, `message`, `details?` | The turn failed. Nothing was persisted: ask the server for a finished answer before showing the banner. A turn its deadline ended is a `workflow_error` whose `details` start with `turn_deadline_exceeded` (see [Every turn ends](#every-turn-ends)). |
| `CUSTOM` `masthead` | `{answer_meta}` | Set the masthead above the prose; text unchanged. |
| `CUSTOM` `card` | `{index, key, card}` | One card, the moment its JSON closed, at `cards[index]` (`[[card:N]]` is index N−1). It may arrive before its marker. `key` is stable into the terminal. |
| `CUSTOM` `card_refused` | `{index}` | The validator refused that card; its place stays empty. |
| `CUSTOM` `answer_retracted` | `{}` | The streamed call was a tool round: clear its text, citations, masthead and cards. A later call may stream again. |
| `CUSTOM` `heartbeat` | `{every_ms}` | The turn is alive while silent. The client declares the socket dead after 3 × `every_ms` of silence during a running turn. Never after the terminal. |
| `CUSTOM` `stage` | `{stage, status: ready \| empty \| failed, payload?}` | A post-answer stage ([`post-answer-stages.md`](../architecture/post-answer-stages.md) §4). The only events after `RUN_FINISHED`, on the same `seq`. |
| `CUSTOM` `interaction_request` | `{interaction_id, input: text \| choice, text, options[{id,label}], placeholder?, expires_at}` | The turn waits for its asker. Only the asker is offered the controls. |
| `CUSTOM` `interaction_resolved` | `{interaction_id, outcome: answered \| expired \| cancelled}` | Close the prompt, in every tab and for spectators. |
| `CUSTOM` `rejected` | `{of, code, message?}`, `seq: 0` | A client message was refused (`auth_expired`, `conversation_mismatch`, `duplicate_turn`, `not_asker`, `no_pending_interaction`, `turn_not_found`, `invalid_message`). Out of band: never replayed, never ends a turn. `turn_not_found` is also the answer when the turn runs on another replica and the bus cannot reach it (an `attach` whose replay cannot be read, a Stop or answer that cannot be handed over): the socket stays open, and the client asks for the persisted answer. `of` is the refused message's `type`, or `unknown` for a frame that is not JSON or names a type this wire does not have: every client message gets an answer, never silence. |

**Not events, on purpose:** there is no status event (a status line is a
`status` step, persisted as one), no run hand-off event
(`RUN_FINISHED.result.run` carries it), and no observability trace (traces go
to telemetry only).

### Steps

`step` is a discriminated union on `kind`. Every step has `id` (stable within
the turn; the producer's choice, e.g. `status:retrieval:2`, `tool:call_abc`)
and `scope: chat | deep` (`deep` for in-process deep research). **No step
carries a tool's input or output.**

| `kind` | Fields |
|---|---|
| `status` | `slot`, `key?` (i18n id), `values{}` (interpolation only), `channel: live \| technical`, `detail{}` (scalars and string lists) |
| `retrieval` | `round`, `key`, `values{}`, `tools[]` (basenames), `reason?` (the model's conclusion, ≤ 160 chars) |
| `sources` | `round?`, `tool`, `lanes[]`: `{key, label, kind, hit_count, sources[{name, title?, detail?, shelf?, round?, provenance?}]}` |
| `tool` | `tool` (basename), `status: running \| ok \| error` |
| `skill` | `phase: offered \| activated \| loaded`, `skill?`, `title?`, `hidden`, `count?`, `channel` |
| `clarification` | `max_turns` |

The UI stores a folded step in a compact form, `StoredThinkingStep`
(`frontends/ui/src/lib/conversations/message-provenance.ts`): `id`,
`userMessageId`, `timestamp`, `isComplete`, `kind`, `scope?`, and per kind
`turnEvent?`, `traceLanes?`, `round?`, `tool?`, `skill?`, `slot?`, `detail?`.
That is what a message row keeps in `metadata.provenance.thinkingSteps`, and the
only shape `sanitizeProvenance` accepts. Rows written before the cut were
rewritten by migration `0097_herleitung_steps_v2`.

### `TurnResult`

`RUN_FINISHED.result`: everything the finished turn delivers. `message_id`,
`text`, `cards[{key, card}]`, `sources[]`, `read_sources[]`, `answer_meta?`,
`answer_confidence?`, `answer_confidence_reason?`, and the transparency fields
below; a field at its default is omitted from the frame. `run: {run_id, run_message_id}` is present when the turn commissioned a
run instead of answering itself (ADR-0062, `outcome: handed_off`); both ids or
neither, structurally. The text is then empty, because the run's block is the
narration.

| Field | Type | Meaning |
|-------|------|---------|
| `routing_decision` | `"meta" \| "shallow" \| "deep" \| "error"` | Which path the turn took, OBSERVED after the answer, never decided up front (ADR-0052): `meta` when the agent consulted no data source and gave no self-assessment (a direct reply), `shallow` otherwise, `deep` on a hand-off to deep research, `error` on a failed turn. Kept on the wire for the post-answer stages and transparency; there is no "Warum dieser Weg?" line any more because there is no upfront decision to attribute. |
| `escalation_reason` | `string` | Present only when a shallow→deep escalation happened this turn: the model's own one-clause reason from its answer envelope. Rendered as `Eskaliert zur Tiefenrecherche: <reason>` in the thinking panel and above the deep-research banner. |
| `answer_confidence_reason` | `string` (≤300 chars) | The model's own one-clause justification for its self-assessed confidence, parsed from the `[CONFIDENCE:<level> \| <reason>]` marker. Shown verbatim in the ConfidenceChip tooltip under "Assistant's reason". |
| `answer_confidence_capped_reason` | `"ungrounded" \| "quote_unverified" \| "normative_claim_uncited" \| "measurement_only" \| "citation_fallback"` | Present only when confidence was downgraded by the deterministic overconfidence guard. `ungrounded` — no citation grounding and nothing measured. `quote_unverified` — a quoted span matched no retrieved passage. `normative_claim_uncited` — the answer WAS grounded in an IFC measurement but also asserts something normative with no verified citation, so it is held at "low" rather than riding out on the measurement's evidence. `measurement_only` — measured and purely descriptive, so a self-reported "high" was reduced to "medium" (measurement grounding never reaches "high"). `citation_fallback` — nothing the model cited survived verification and the grounding is the one source the agent attached from the cumulative session registry, which may predate this turn; it lifts the answer no further than a measurement does. Adds a sentence to the ConfidenceChip tooltip. |
| `citations_removed` | `{ count: number, reasons: string[] }` | Present only when citation verification removed ≥1 citation. Renders a muted note under the sources row (reasons in a tooltip). |
| `read_sources` | `Array<{ document_id?, citation_key?, file_name?, page?, collection?, shelf?, kind?, lane?, lane_label?, title?, url? }>` | Retrieved-but-uncited documents this turn: identity + placement, NO prose. Renders the collapsed "Gelesen, nicht zitiert" disclosure inside the answer details (muted document chips, capped at eight with an overflow count). Absent when everything retrieved was cited. |
| `job_admission_rejected` | `boolean` (default `false`) | Marks the answer text as a queue-rejection notice (NOT a research answer). The client renders a warning banner (error code `research.queue_full`) and leaves the composer unlocked. |
| `retry_after_seconds` | `number` | Only alongside `job_admission_rejected` — retry hint (seconds). |
| `skills_activated` | `string[]` | Agent Skills whose full instructions were LOADED this turn — the ones the model pulled in with `use_skill`, in call order, deduped. Absent/empty on a turn that activated none. Rendered as a quiet "Skills used" disclosure under the answer; persisted into assistant-message metadata with the rest of the result. Availability is the constant, activation is the event — see `docs/architecture/agent-skills.md`. |
| `skills_hidden` | `string[]` | The subset of `skills_activated` the disclosure de-emphasises. |
| `research_truncated` | `boolean` (default `false`) | The turn's research was cut off at its budget ceiling. The answer says so, and the mark is persisted so a reopened thread keeps saying it. |
| `retrieval_ledger` | `RetrievalLedgerEntry[]` | The backend's own account of this turn's retrieval rounds: per announced round what it was asked (query, tools), what it returned, and which documents it did work on (`new_docs`); `hits`/`documents` are tallies over `docs`. Absent when no round was announced. One `docs` entry is one PASSAGE — a document (`name`, `title`, `shelf`) at a page or Punkt (`detail`) — carrying `repeat: boolean`: true when an earlier round already returned that exact (document, `detail`) pair, or when an earlier round OPENED that document with a locator tool (`read_passage`). A search that merely ranked a document does not make the later open of it a repeat. `new_docs` is the document-level derivation of the same marks: a document is listed when at least one of its passages here is not a repeat. `repeat` is absent on turns stored before the backend stamped it, and the renderer then falls back to `new_docs`. The Herleitung spine draws each round's fan from it, one card per document: the pages or Punkte that round reached, listed under the card, „bereits abgerufen" on the passages it fetched a second time, and an „Öffnen" step kind for a round that only opened passages. Persisted into message metadata/provenance so reloads read the same account. Nothing retrieves outside it: the answer repair corrects a quote against a passage already in this turn's registry and retrieves nothing (ADR-0067). |
| `quote_stamps` | `Array<{ text, status: "verbatim" \| "not_found" \| "unchecked", number?, title?, file_name?, page?, punkt?, url? }>` | The server's check of each quote line `> „…“ [N]` of the answer, one entry per line in document order (`common/quote_stamps.py`), against the passages the prose's own quote check reads. `verbatim` names the passage that holds the wording and its `[N]` (absent when the passage was read, not cited); `not_found` means no retrieved passage holds it; `unchecked` means nothing to check against, or a span under 20 characters. `text` is the wording between the quote marks as the final text writes it. The excerpt renders „Wortlaut belegt [N]" and „Stelle öffnen" from it, never from the model. Absent when the answer quotes nothing. Persisted into message metadata under the same key. |

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

**Stop.** A `cancel_turn` from the asker ends the turn with
`RUN_FINISHED{outcome: "cancelled"}`, whose `result.text` is the prose streamed
so far, with any pending `[N]` removed. The server persists it with
`metadata.stopped = true`, which the BFF bounds into
`metadata.provenance.stopped`, so a reload shows what the reader saw, marked as
stopped.

### Every turn ends

A running turn heartbeats, and the client trusts the heartbeat, so a turn the
server never ends is a spinner that never stops. Four things make sure it
ends, each pinned by a test in `frontends/aiq_api/tests/test_chat_socket.py`:

- **One terminal, structurally.** `run_turn`'s `finally` sends a `RUN_ERROR` if
  no terminal went out, whatever escaped (a `BaseExceptionGroup` from a task
  group included). The escaped error is logged by the task's done-callback.
- **A deadline.** `GRID_CHAT_TURN_DEADLINE_SECONDS` (2700) on the turn's own
  clock, which stops while the turn waits on a person's answer. At the deadline
  the turn is cancelled like a Stop and ends with
  `RUN_ERROR{workflow_error, details: "turn_deadline_exceeded: …"}`.
- **A bounded teardown.** A Stop waits at most `PRODUCER_TEARDOWN_SECONDS`
  (`workflow_stream`, 10 s) for the workflow's `finally` blocks, then ends the
  turn without them.
- **No hidden queue.** The chat runs with NAT's per-replica semaphore off; the
  one concurrency gate is ADR-0040's admission (`GRID_MAX_ACTIVE_TURNS`), which
  refuses a turn at once with a retry hint rather than holding it after
  `RUN_STARTED`.

---

## Client → server

Four messages, each with `v: 2` and `conversation_id`. Unknown fields are
refused (`rejected{invalid_message}`), and so is an unknown `type`
(`rejected{of: unknown, code: invalid_message}`).

| `type` | Fields | Notes |
|---|---|---|
| `user_message` | `message_id` (becomes `turn_id`), `text`, `data_sources[]`, `context_only?`, `author_name?`, `focus_file_name?`, `focus_shelf?`, `source_preset?`, `focus_document_id?`, `focus_version_id?`, `focus_version_state?` | A question. The type name is what the gateway's turn limiter (`lib/limits/ws-frames.js`) counts. A second `user_message` for a turn already running or run, on any replica, is `rejected{duplicate_turn}` (the turn id is claimed on the bus for as long as the stream keeps it); a new one supersedes and cancels a stale turn, on whichever replica runs it. |
| `interaction_response` | `turn_id`, `interaction_id`, `answer: {text} \| {option_id}` | Exactly one answer, structurally. Only the person the prompt addressed may answer; anyone else gets `rejected{not_asker}`, and an answer with no prompt waiting `rejected{no_pending_interaction}`. |
| `cancel_turn` | `turn_id` | Stop. Only the asker's verified subject (or an internal caller) may cancel; anyone else gets `rejected{not_asker}`. The server cancels the graph run, not just the socket. |
| `attach` | `turn_id`, `after_seq` | Replay the turn from `after_seq + 1`, then continue live. Sent for every open turn after a reconnect, and with `after_seq: 0` after a reload. `rejected{turn_not_found}` when the stream holds nothing for the turn: ask for the persisted answer instead. |

```json
{"v":2,"type":"user_message","conversation_id":"s_1","message_id":"msg_1759000000000_3","text":"Wie lang darf der Fluchtweg in GK 4 sein?","data_sources":["knowledge_layer"]}
```

### Sensitive data is masked, never refused (ADR-0079)

The free text of a `user_message` (`context_only` lines included) and of an
`interaction_response` `{text}` answer is masked against the office's
„Sensible Daten" policy before the agent, its history or another replica sees
it: each content-term or detector match (IBAN, Austrian social-security number,
card number; checksum-valid only) becomes a placeholder such as
`[IBAN entfernt]`. The wire does not change and the turn is never refused for a
match. The composer masks first and asks the person; this is the backstop for a
client that did not. The socket reads the policy once per connection from
`GET /api/internal/chat-screening`, so a policy change applies from the next
connection; until it can be read (no signed organization, an older BFF, an
error) every detector applies and no term. A chosen `{option_id}` is not free
text and passes as it is. `aiq_api.chat_socket.ChatSocket._masked`;
the matcher is `aiq_agent.common.content_screen`.

### Invoking a skill (no wire field)

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

### Ingest-only messages (`context_only`)

Two fields deliver a human message to the agent *as context* rather than as a
question (ADR-0034 addendum). The agent's history is its LangGraph checkpoint,
so a message that never reaches it can never be referred back to: a hand-off
(`@Anna Weber …`, or a colleague's reply while a wait is open) has to be in the
agent's memory even though the agent must not answer it.

| Field | Type | Meaning |
|-------|------|---------|
| `context_only` | `true` | Append this turn to the conversation's state and **generate nothing**: no LLM call and no events beyond the turn's own bookkeeping. Only the literal `true` exists; the field is omitted otherwise. |
| `author_name` | `string` | Display name of the human who wrote it, so the agent can attribute the turn in its own history. Advisory: the backend prefers the **verified** principal's name from the handshake JWT, so a client cannot attribute text to a colleague. |

Who a message is addressed to is decided by the **server** at persist time
(`addressees`, ADR-0034 §4); this flag only carries that ruling to the agent
tier, so routing never becomes a model's judgement. Delivery is best-effort:
the message is already persisted by the BFF, so a dropped context message costs
the agent a line of memory and the thread nothing. The stored text is capped at
4000 chars (`aiq_agent/conversation_context.py`).

### Turn retrieval intent (`focus_file_name` / `focus_shelf` / `source_preset`)

The signed `X-Grid-Collection-Scope` header is the **authorization ceiling**
(which corpora this caller may read). What a *turn* actually searches is a
subtractive subset of that ceiling. The client states **intent**, never an
expanded collection list:

| Field | Type | Meaning |
|-------|------|---------|
| `focus_file_name` | `string` | Filename of the file this send is about (the composer "Asking about …" subject). Retrieval prefers it, AND it is named in the prompts. |
| `focus_shelf` | `"session"` \| `"project"` \| `"archiv"` | Shelf that file sits on. Wins over `source_preset`. |
| `source_preset` | `"law"` \| `"project"` \| `"office"` | Composer shortcut chip. Used only when no subject shelf is set. |

```json
{"v": 2, "type": "user_message", "conversation_id": "s_1", "message_id": "msg_1759000000000_3",
 "text": "Fass den Inhalt zusammen", "focus_file_name": "Protokoll.pdf", "focus_shelf": "session"}
```

The backend maps that intent via `shelves_for_turn`
(`src/aiq_agent/common/focus_file.py`) and subtracts other shelves at the
knowledge-layer retrieve site. `include_shelves` does not exist: the contract
**refuses** a message that carries it, because the mapping owns the expansion so a client cannot ask for
Archiv while claiming a project file. A subject shelf never subtracts the
building-code corpus (`base`): it narrows which *documents* a turn reads, not
whether the law is applied. Absence of both shelf and preset
leaves the signed scope intact (ADR-0024). See
`docs/architecture/backend-deep-dive.md` § Collection scoping.

Absence of every field is the unscoped project turn: the signed header stands
as-is.

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

### The subject's open version (`focus_document_id` / `focus_version_id` / `focus_version_state`)

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
three absent is every ordinary turn.

---

## Resume, replay and spectators

- **Every stamped event is appended** to the conversation's stream on
  Dragonfly (`conv:<id>:stream`, `ConversationBus.publish_frame`, bounded by
  `GRID_CONV_STREAM_MAXLEN` and its TTL). A `rejected` event (seq 0) is not.
- **The cursor is `(turn_id, seq)`.** The client drops an event with
  `seq ≤ lastSeq` for its turn, and treats `seq > lastSeq + 1` as a gap: it
  sends `attach{turn_id, after_seq: lastSeq}`.
- **Resume is on the socket.** `attach` registers the socket, buffers live
  events for it, replays the turn, then flushes whatever live events arrived
  above the last replayed `seq`. There is no HTTP replay. The replica running
  the turn replays it from the turn's own sequencer, which needs no bus; any
  other replica reads the stream once its relay subscription is confirmed, so
  a frame published between the read and the subscription arrives through the
  relay and is deduplicated by `seq`.
- **The bus fails fast.** Each bus command a turn waits on is bounded (1 s),
  and after a failure the bus refuses without I/O for 5 s, so a black-holed
  Dragonfly costs one bound per outage rather than one per frame. A relay or
  owner loop that dies is logged and restarted with backoff.
- **Liveness without a socket:** `GET /api/conversations/:id/frames?peek=1`
  answers `{available, newest, now}`, the newest stream entry id (`<ms>-<n>`)
  and the server clock, so a tab can tell a turn still working (a heartbeat
  every 20 s) from one that ended. It is the route's only form; any other
  query is a 400.
- **Spectators (ADR-0039)** read `GET /api/conversations/:id/live`, Server-Sent
  Events of `{"kind":"frame","payload":<event>}` relayed verbatim from the bus,
  plus a single `{"kind":"unsupported"}` (no shared cache tier) or
  `{"kind":"revoked"}` (access withdrawn) before the stream ends. The observer
  folds each payload with the asker's fold (`foldTurnEvent`) and hides
  interactive and system cards at render. It starts from whatever `seq`
  arrives and never asks to fill the gap; a spectator replay is follow-up F4.

---

## The client

`frontends/ui/src/adapters/api/turn-socket.ts` connects with `?v=2`, waits for
the server's `hello`, sends client messages, reconnects with jittered backoff and
an auth refresh before each attempt, and sends `attach` for every open turn once
the hello has arrived. Every event is parsed with `parseWireEvent`
(`adapters/api/wire-v2.ts`) and folded by `foldTurnEvent`
(`features/chat/lib/turn-fold.ts`), the one interpretation of the wire: the live
socket, the replay after `attach` and the spectator stream all use it. Design:
[`design/chat-wire-v2.md`](../design/chat-wire-v2.md) §e.

**Nothing the page waits on can wait forever.** Every one of these ends on a
clock, and ends visibly:

| The server… | The client | The reader sees |
|---|---|---|
| opens and says nothing for 5 s (`HELLO_TIMEOUT_MS`), or opens with anything but a v2 `hello` | drops the socket and tries again on the ladder; when it is spent the status is `incompatible` | `connection.server_incompatible` („Piloti ist gerade nicht erreichbar"), not "check your network". The health poll does not clear it, since an old agent is healthy; the next question tries a new socket, and its hello clears it |
| sends, after the hello, a frame this bundle cannot parse | closes the socket: `outdated`, as for `4426` | „Piloti wurde aktualisiert", reload. A turn whose next `seq` cannot be read could never fold its terminal |
| does not answer a `user_message` within 15 s (`ACK_TIMEOUT_MS`): no `RUN_STARTED`, no `rejected`, no frame of the turn | reopens the socket, which sends the question again; a second miss ends the turn | an `agent.response_failed` card with „Erneut versuchen", after the server was asked once for a finished answer |
| lets a running turn go silent for three beats | drops and reopens the socket, re-attaching the turn; a second silent socket in a row with nothing of the turn folded ends it | the answer, if the server finished it; otherwise `agent.response_interrupted` |
| refuses an `attach` or a `cancel_turn` as `invalid_message` or `conversation_mismatch` | treats it as `turn_not_found`: nothing is following the turn any more | as for `turn_not_found` |

A question stopped before its `RUN_STARTED` is not sent again on a reopen, and a
question asked while the socket has given up opens a new one with a fresh ladder.

---

## Run event streams


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
