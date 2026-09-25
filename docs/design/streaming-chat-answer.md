# Streaming the Chat Answer — wire contract

**Status:** Implemented (2026-07-18); orchestration amended by
[ADR-0066](../adr/0066-the-answer-prose-streams-and-the-verified-frame-settles-it.md)
(2026-09-24): the answer's prose now streams while the final call writes it,
each `[N]` a pending citation until the text closes and a settled snapshot
names its sources, and the terminal frame replaces it. The wire contract
below still holds for the terminal frame and for a buffered turn; ADR-0066
added three kinds of live `IN_PROGRESS` frame beside the plain delta
([Live frames](#live-frames-adr-0066)). Streaming is the default delivery; there is
no runtime flag — the backend and frontend ship together in this monorepo, so
the change is atomic and needs no staged rollout toggle.
**Related:** the per-turn chat path (`agents/piloti/conversation_register.py`), `websocket_reconnect.py`,
the `frontends/ui` chat store.

## Why this is cross-stack, not backend-only

The transport can already carry many chunks, but two layers assume **one content
frame per turn**:

1. **Rendering** — `frontends/ui/.../messages-store.ts` appends a *brand-new*
   assistant bubble for every content frame; it never merges deltas. N streamed
   frames ⇒ N bubbles.
2. **Persistence** — on a client disconnect, the terminal message is persisted
   under `deterministic_assistant_message_id(conversation, parent)` with
   `onConflictDoNothing`. The **first** frame that fails to send wins the id;
   every later frame (including the one carrying `cards`/`sources`) no-ops. So
   naive delta frames persist a *partial* answer and drop cards/citations.

Therefore streaming requires coordinated changes in the backend generator, the
WS handler's persistence gating, and the frontend accumulation logic.

## The citation constraint (why this was progressive rendering, not lower TTFT)

> **Superseded for the prose by ADR-0066.** The constraint still holds and is
> met differently: the live stream is the envelope's `answer` string, its `[N]`
> markers rendered as PENDING pills (no source, no peek) and the sources
> section withheld, so no unverified citation is ever shown as real. The
> envelope writes its masthead (`kind`, `topic`, `context`, `verdict`,
> `summary`) BEFORE `answer`, so a live frame carries it, gated, above the
> first word; a `[[card:N]]` marker streams whole and holds its card's place
> (`PendingCardSlot`) until the card, gated, arrives on a live `cards` frame
> and grows into it (`CardArrival`). Live cards go out only while no tool
> pushed a card this turn, so their numbers are the terminal's. The moment the string closes, a `stream_replace` snapshot carries the
> verified, renumbered text and its sources; the terminal frame, which the
> client already REPLACES the bubble with, carries the finished answer. What remains
> true below: the terminal is authoritative, and verification needs the whole
> answer. What changed: the first delta leaves while the model writes.

`verify_citations` + `sanitize_report` rewrite the answer body — they delete
unverified `[N]` markers and renumber the `## Sources` section — and they need
the **complete** answer text. A shallow answer can also still escalate to deep
research. So we cannot stream the model's raw tokens without briefly showing
unverified citations (the exact thing "preserve citations first" forbids) or
streaming text that gets superseded.

**Consequence (2026-07-18, until ADR-0066):** orchestration stayed fully
buffered. We streamed the **already-verified** final text as deltas. This was a
progressive rendering improvement, **not** a time-to-first-token reduction — the
first delta left only after the answer was generated, verified, and sanitized.
Since ADR-0066 that holds only for a turn with nothing streamed live (a
buffered LLM, a reply that was not an envelope).

**And the deltas carry no pace** — see [There is no typewriter](#there-is-no-typewriter).

## Wire contract

Backend `_run` is an async generator yielding `ChatResponseChunk`s.

- **Answer turns:** yield incremental **delta** chunks (`finish_reason=None`),
  then one
  **terminal** chunk — full content, `finish_reason="stop"`, extras
  (`cards`/`sources`/`answer_confidence`/`run_id`) on
  `model_extra`. The terminal is authoritative for persistence and for the
  single-consumer fold. On a buffered turn the deltas carry no extras and
  concatenate to *exactly* the final text (`response_to_chunks`). On a live
  turn they are the model's prose as it is written, and they need not add up
  to the final text: a snapshot replaces them, and the terminal replaces the
  snapshot.
- **Error / budget turns:** a single **terminal** chunk (short, fully known up
  front — no point tokenizing). The WS handler renders a lone terminal chunk
  with the pre-streaming frame pattern, so these are unaffected.

The delta/terminal distinction reaches the wire via WS message **status**:
deltas ⇒ `IN_PROGRESS`, terminal ⇒ the completing frame. `_response_to_chunks`
keeps a `stream` parameter (True for answers, False for errors), but there is no
env/runtime gate — streaming is always on for answer turns.

### Live frames (ADR-0066)

`turn/streaming.py::live_chunk` builds every live chunk; all are
`finish_reason=None`, so all reach the wire as `IN_PROGRESS` and none is
persist-eligible. Besides the plain delta, which appends, there are three:

| Frame | Carries | The client |
|---|---|---|
| Snapshot | `content`, `sources`, `stream_replace: true`, and the re-gated `answer_meta` | REPLACES the bubble's text with the settled, renumbered prose; the pending `[N]` become citations against `sources` |
| Masthead | empty `content`, `answer_meta` | sets the masthead above the prose; the text is unchanged |
| Cards | empty `content`, `cards` | fills the `[[card:N]]` placeholders; the text is unchanged |

One snapshot is sent per turn, when the envelope's `answer` string closes. The
terminal then replaces the text once more and takes back what it omits (a
suppressed card, a masthead gated out). The wire fields:
[`websocket-protocol.md`](../api/websocket-protocol.md#live-frames-adr-0066).

### WS handler (`websocket_reconnect.py::_run_workflow`)

- A chunk with `finish_reason=None` (delta) ⇒ send `IN_PROGRESS`,
  **not persist-eligible**.
- A chunk with `finish_reason="stop"` (terminal) ⇒ the finalizing frame,
  full content + extras, **persist-eligible** (fixes the partial-persist bug).
- When only a terminal chunk is seen (error/budget turns, or any single-chunk
  producer), the existing `IN_PROGRESS content` + synthetic `COMPLETE` behavior
  is preserved.

### Frontend (`use-websocket-chat.ts` / `messages-store.ts`)

- Maintain one streaming bubble per turn (keyed by `parent_id`).
- `IN_PROGRESS` content frame ⇒ **append** delta to the streaming bubble
  (create it on the first delta); with `stream_replace` ⇒ **replace** it
  (`replaceStreamingAgentResponse`); with `answer_meta` or `cards` ⇒ set them
  on the bubble.
- Completing frame with full content ⇒ **replace** the bubble content with the
  authoritative full text (idempotent when equal to the accumulation), attach
  `cards`/`sources`, finalize.
- Backward compatible: with the current backend (one content frame), "append the
  only delta then finalize" yields the same single bubble as today.

### Single-consumer fold (`--input` CLI, single-shot HTTP)

`_fold_chunks_to_response` collapses the chunk stream to one `ChatResponse`:
the terminal (`finish_reason="stop"`) content is authoritative; extras are
copied from the terminal. Deltas are ignored when a terminal is present, so the
folded content is never doubled.

## There is no typewriter

This section is about a buffered turn; on a live turn the pace is the
model's own.

The delta sequence is a SHAPE, not a pace. `_response_to_chunks` cuts a finished
answer into ~24-character pieces (`_iter_answer_deltas`) and yields them as fast
as the socket takes them, so they reach `appendAgentResponseDelta` one or two
animation frames apart: the answer paints essentially at once, and `isStreaming`
is a state the turn passes through in a frame or two.

A client-side typewriter (`use-typed-reveal.ts`) used to pace a character-level
reveal over that window. It was removed deliberately: the text is finished and
verified before the first delta leaves the agent, and animating it as if it
were being written cost real render work (each reveal frame re-parsed the
answer as markdown) to simulate a latency the system does not have. The full
text now renders as soon as it arrives; `AgentResponse` treats `isStreaming`
alone as "still arriving", and nothing that acts on a whole answer (the copy
actions, the cards no `[[card:N]]` marker claimed) is offered over half of one.

Pacing on the backend remains the wrong option for the same reasons it always
was: an `asyncio.sleep` between chunks holds a worker for the length of the
answer, and the network re-clumps whatever the sleep spaced out.

## Tests

- Backend: `stream=False` (error/budget) yields one terminal chunk equal to
  today's response; `stream=True` (answers) yields deltas whose join equals the
  verified text, extras only on the terminal; fold reproduces the single
  response either way.
- Handler: delta frames are IN_PROGRESS and not persisted; terminal frame is the
  finalizing, persist-eligible frame with cards/sources.
- Frontend: deltas accumulate into one bubble; terminal replaces + attaches
  cards; single-frame backend still renders one bubble; the whole-answer
  affordances (copy, unclaimed cards) wait for `isStreaming` to clear
  (`AgentResponse.spec.tsx`, "a streaming answer").
