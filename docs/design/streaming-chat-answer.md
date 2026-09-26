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
**Related:** the per-turn chat path (`agents/piloti/conversation_register.py`,
with `_live_item_chunk` and `note_settled_replaced`), `websocket_reconnect.py`,
the `frontends/ui` chat store. Live prose: `turn/answer_stream.py`,
`common/answer_prose_stream.py`, and `agents/piloti/answer_pipeline.py`
(`LiveAnswer`, `settle_streamed_citations`).

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
> pushed a card this turn, so their numbers are the terminal's. The moment the
> string closes, a `stream_replace` snapshot carries the verified, renumbered
> text and its sources; the terminal frame, which the client already REPLACES
> the bubble with, carries the finished answer. What remains true below: the
> terminal is authoritative, and verification needs the whole answer. What
> changed: the first delta leaves while the model writes.

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

**And the deltas carry no pace**: the client paces the reveal, see [The reveal is paced, not typed](#the-reveal-is-paced-not-typed).

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
deltas ⇒ `IN_PROGRESS`, terminal ⇒ the completing frame. `response_to_chunks`
(`turn/streaming.py`) takes a `stream` parameter, and
`conversation_register.py::_answer_chunks` passes `stream=not live`: a buffered
answer is cut into deltas, while a live answer, whose prose already went out,
and a refusal get the terminal alone. There is no env/runtime gate; every
answer turn streams one way or the other.

### The platform switch

Platform → Abruf carries one on/off setting, `chat.answer_streaming` (catalog:
`frontends/ui/src/lib/retrieval-settings/catalog.ts`, on by default). The
backend reads it once per turn through the retrieval-settings pull
(`turn/answer_stream.py::answer_streaming_enabled`, TTL 60 s). Off, the turn
binds no `AnswerStreamSink`, so `streaming_call` hands back the buffered call:
no delta, snapshot, masthead or cards frame goes out, the reasoning steps still
stream live, and the answer arrives whole with the terminal frame. The client
needs no change for that; it is the turn as it was before ADR-0066.

### Live frames (ADR-0066)

`turn/streaming.py::live_chunk` builds every live chunk; all are
`finish_reason=None`, so all reach the wire as `IN_PROGRESS` and none is
persist-eligible. Besides the plain delta, which appends, there are three:

| Frame | Carries | The client |
|---|---|---|
| Snapshot | `content`, `sources`, `stream_replace: true`, and the re-gated `answer_meta` | REPLACES the bubble's text with the settled, renumbered prose; the pending `[N]` become citations against `sources`. It replaces the citations too (an empty `sources` clears them), and a snapshot without `answer_meta` removes the masthead: the re-gate dropped it |
| Masthead | empty `content`, `answer_meta` | sets the masthead above the prose; the text is unchanged |
| Cards | empty `content`, `cards` | fills the `[[card:N]]` placeholders; the text is unchanged |

At most one snapshot is sent per answering call, when the envelope's `answer`
string closes, and none when there is nothing to settle:
`settle_streamed_citations` returns `None` for prose without a sources section
or a turn whose source registry is empty, and the streamed prose then stands
until the terminal. The terminal replaces the text once more and takes back
what it omits (a suppressed card, a masthead gated out). One exception: a
streamed call that turns out to carry tool calls was a round, not the answer,
and is retracted with an EMPTY snapshot (`AnswerStreamSink.retract`), which
clears its text, citations, masthead and cards. On the wire the retraction
carries no `sources` field (`websocket_reconnect.py` attaches `sources` only
when non-empty), and the client reads empty content with no sources as a
retraction. A later call of the turn may stream again, and settle again, but
need not. A call that put nothing on the wire is not retracted. The wire fields:
[`websocket-protocol.md`](../api/websocket-protocol.md#live-frames-adr-0066).

The settle runs the terminal's shape pass as well. A mindmap whose words are
at least 70% a table's in the same answer (`drop_restated_mindmaps`,
`agents/piloti/answer_shape.py`, `MINDMAP_TABLE_COVERAGE`) goes when the prose
settles rather than at the terminal; the reader may still see it while the
prose streams.

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
  (create it on the first delta with something to draw; a whitespace-only
  first frame opens nothing); with `stream_replace` ⇒ **replace** it
  (`replaceStreamingAgentResponse`), its citations and its masthead; with
  `answer_meta` or `cards` ⇒ set them on the bubble.
- What is provisional: only a masthead or cards that came on a text-less live
  frame, or a masthead on a snapshot. A terminal WITH text takes back what it
  omits. An empty terminal takes back nothing. Cards on a legacy
  text-bearing `IN_PROGRESS` frame are final.
- Completing frame with full content ⇒ **replace** the bubble content with the
  authoritative full text (idempotent when equal to the accumulation), attach
  `cards`/`sources`, finalize.
- Diagrams: only the fence the text still ends inside is streaming
  (`isOpenFence` in `MarkdownRenderer.tsx`), and it holds its place with a
  skeleton (`DrawingSkeleton`). Every closed fence is drawn while the answer
  streams.
- Backward compatible: with the current backend (one content frame), "append the
  only delta then finalize" yields the same single bubble as today.

Two folds consume these frames: the asker's store (`messages-store.ts`) and
the observer's (`spectator-frames.ts`, via `GET /api/conversations/{id}/live`).
Both must apply the same rules.

**What a delta may cost.** Deltas are buffered and applied to the store every
`DELTA_FLUSH_MS` (100 ms, `messages-store.ts`), and each flush replaces the
open conversation in the store, so every subscriber to `currentConversation`
or `conversations` re-renders once per flush. The flush used to run once per
animation frame; on a 4× throttled CPU that was a 50–70 ms task every few
frames. It can be this coarse because the reader does not see it: the answer
paces its own reveal ([The reveal is paced](#the-reveal-is-paced-not-typed)).
Three rules keep the rest to the answer bubble:

- The persisted store never writes a live turn's growth: the streaming
  answer, and the reasoning steps of the question it answers
  (`onlyTheLiveTurnGrew`, `sessions-store.ts`). `getItem` drops an answer still
  marked streaming, so a stored fragment would read back exactly as the last
  write does: the turn is rebuilt from the replay stream or fetched finished
  ([A dropped socket resumes](#a-dropped-socket-resumes)). No mid-turn action
  bumps `updatedAt` (the bubble opening, a step, a snapshot): a bump made each
  of them a full write. A composer draft is written 400 ms after the last
  keystroke and when the page is hidden, not with every key. Any other change
  while a turn works (a deletion, a rename, a new session) is written at once,
  and the settled turn is written when it settles. A store update that leaves
  every persisted field the same object (a loading flag) writes nothing and
  serializes nothing.
  - History: each flush once pruned, serialized and wrote the whole history,
    74 writes of 1.3 MB for one answer beside forty conversations; coalesced
    to one write per two seconds it was still a 100 ms task plus a 55 ms
    native write every two seconds on a 4× throttled CPU. Removing it took the
    worst frame of a streamed answer from 1.4 s to 250 ms. The steps, the
    opening, the snapshot and the drafts still wrote the whole history until
    2026-09: 5–7 writes of 250–1000 ms per turn and 264 ms a keystroke with 20–40
    conversations stored (React performance audit, 2026-09).
- Nothing outside the chat list subscribes to the conversation objects. The
  shell, the composer and their hooks select what they show (an id, a title, a
  count, a boolean), and the sessions panel's rows keep their identity across a
  flush (`use-session-rows.ts`). A flush does not bump `updatedAt`.

**Why the Markdown is re-parsed whole on every flush.** Rendering the
streamed prefix costs about 3 ms per flush for the recorded 2.9k-character
answer, 84% of it parsing (2026-09, `MarkdownRenderer` rendered to a string
under vitest). Rendering only the blocks that changed would save little
unless the parse were incremental too, and Markdown is not safely
incremental: a later line can change earlier blocks (a `---` under a
paragraph makes it a heading, a delimiter row makes it a table, a blank line
makes a whole list loose). The cost is linear in length, about 14 ms at 9k
characters and 30 ms at 17k, so it starts to cost frames on answers past
roughly 10k characters. Revisit when answers that long are common, and
check any incremental scheme against rendering the whole text for every
prefix of the recorded answers.

**A reload mid-answer.** Nothing streams in a page that is only now loading,
so the storage drops a stored answer that still says `isStreaming` when it
reads the store (`createResilientStorage`). The reattached turn opens a bubble
of its own and its terminal frame carries the whole answer. The dropped
fragment used to stay beside that bubble with a caret, and it hid the
unanswered question from `restoreSessionState`'s recovery, which fetches a
finished answer the server kept while the page was away. A reload mid-answer
now takes the same path as a reload before the first word, and a turn still
running is rebuilt from the replay stream
([A dropped socket resumes](#a-dropped-socket-resumes)).

`/dev/stream-chat?history=40` measures this: the real store and the real shell
(`&shell=1`), fed a recorded answer at its recorded pace, with commits, storage
writes and long tasks in `window.__streamChat`. Until 2026-09 it seeded a user
id the chat resets on mount, so the open thread and the sidebar were empty
whatever `history` said; the persisted size was real, the rendering was not
(`docs/contributing/gotchas.md`).

### Single-consumer fold (`--input` CLI, single-shot HTTP)

`fold_chunks_to_response` (`turn/streaming.py`) collapses the chunk stream to
one `ChatResponse`: the terminal (`finish_reason="stop"`) content is
authoritative; extras are copied from the terminal. Deltas are ignored when a
terminal is present, so the folded content is never doubled. A stream that
never reached its terminal is folded by `_fold_live` the way the client folds
it: deltas append, a snapshot (`stream_replace`) replaces the text before it
and drops the masthead, and an empty snapshot with no sources (a retraction)
drops the cards as well.

## A dropped socket resumes

iOS closes a page's WebSocket the moment the app goes to the background, and a
phone on the move loses it for a few seconds anyway. The answer must still
arrive when the reader comes back (2026-09).

Before, the first `onclose` ended the turn (`setStreaming(false)`), every later
frame of it was dropped as stale, and the server, seeing a socket attached again,
left persisting the answer to the client that had just thrown it away. The
reader got „Verbindung kurz unterbrochen — Antwort ging verloren" for an answer
that had finished.

**The cursor.** `ConversationBus.publish_frame` appends every outbound frame to
the conversation's replay stream on Dragonfly (`conv:<id>:stream`, ADR-0028),
also when no socket is attached, and the frame reaches the socket tagged with
its stream entry id, `grid_frame_id` (`<ms>-<n>`, monotonic across replicas and
restarts). The client keeps the id of the last frame it applied
(`NATWebSocketClient.lastFrameId`) and drops a frame at or before it, so a
frame that arrives both replayed and live counts once.

**A reconnect.** While the client is reconnecting and has a cursor
(`canResume()`), the turn stays open: the hook does not end it on
`disconnected`, and the watchdog re-arms instead of calling the gone socket
evidence. On the next open the client holds live frames, reads
`GET /api/conversations/:id/frames?after=<cursor>`, applies what it missed
through the same handler as live frames, then releases the held ones
(`onResume`). `unavailable` (no shared cache, a failed read) ends the turn the
way a dead socket always did: ask the server for a finished answer, and show
the banner only if there is none.

**A reload.** A page that reloads has lost its cursor with its memory. The
question is stamped with the id it went out under (`wsParentId`, persisted with
the store); `restoreSessionState` first asks for the finished answer, and when
there is none leaves `resumableTurn`. Once the socket is up the hook reopens the
turn (`resumeTurn`), reads the newest frames the stream holds (backwards, then
in order, since approximate trimming can leave more than one read returns) and
applies them from the question's first frame on (`replayTurn`), so an older
turn's frames never come back to life. A prompt of a later turn is dropped as
stale like any other frame of another turn. The stream no longer holding the turn ends it with the
banner.

**The server keeps every answer.** The backend persists every finished
answer, whether or not a socket took the terminal frame
(`_persist_terminal_message_in_background`). It used to persist only when no socket was
attached, leaving the write to the browser; a socket that took the frame and
died before the browser saved it lost the answer for good. Now the reader's
connection decides only how soon the answer appears, never whether it exists.

**One answer, not two.** The browser still writes the answer it received.
Both use `uuid5(grid:assistant:<conversation>:<turn>)`
(`deterministic_assistant_message_id`, `turnAnswerId`), so the second write
collides on `messages.id` and no-ops, and the recovery dedupes by id.

**Waiting, not accusing.** A page that lost its turn and finds no finished
answer does not say "lost" at once: the turn may still be running.
`_awaitServerAnswer` asks for the answer every 4 s for as long as the turn
still produces frames. It peeks at the newest frame of the replay stream
(`GET /api/conversations/:id/frames?peek=1`, one entry and the server's
clock), and the backend's heartbeat every 20 s keeps that fresh while the turn
runs, socket or not. Only a turn silent for 70 s (two minutes when there is no
stream to ask, 40 minutes at most) ends with the banner. The reader meanwhile
sees „prüfe auf fertige Antwort".

**Bounds.** `GRID_CONV_STREAM_MAXLEN` (2000 frames, a few turns) and
`GRID_CONV_STREAM_TTL_SECONDS` (an hour since the last frame). A reader away
longer than that gets the finished answer from Postgres, or the banner.

## The reveal is paced, not typed

A live turn's prose arrives in bursts: the model writes a sentence, the
network clumps two frames, the store flushes every 100 ms. Painted as it
arrived, the answer lurched forward a sentence at a time. Since 2026-09 it is
shown at a steady pace a beat behind what has arrived (`usePacedText`, rules
in `features/chat/lib/stream-pace.ts`):

- The reveal aims to sit `TARGET_LAG_MS` (450 ms) behind the arrivals, never
  slower than `MIN_CHARS_PER_SECOND`, and never holds text back longer than
  `MAX_LAG_MS` (1.2 s).
- It steps every `PACE_TICK_MS` (50 ms), not every frame: each step re-parses
  the answer as Markdown, and a phone pays for that per step.
- It cuts only at a word gap outside an open `**`, link, code span, fence or
  table row; a table row appears whole. A store flush boundary is not a clean
  cut: a recorded first delta was `**Die Außentreppe ist in GK 4 in A2`, and
  cutting there flashed a raw `**`. Only the `MAX_LAG_MS` ceiling may show
  text whose end is not clean.
- The first clean cut is shown at once. The target lag smooths text that is
  already moving; it does not hold back the first words.
- A rewrite of text already shown (the settled snapshot dropping or
  renumbering a marker) keeps the length that was shown, moved on to the next
  clean cut, and paces only what lies beyond it (`keepThroughRewrite`). It
  used to fall back to the first changed character and type the answer out
  again: 1086 → 391 characters on the phone, and CLS in the answer phase
  0.16 → 1.19 (stream audit, 2026-09). A spec replays both recorded answers
  through the hook and fails if the shown text ever shrinks.
- A finished answer is never paced. The terminal is authoritative and is
  shown whole the moment it lands, so the answer settles in the same frame
  as the reasoning collapses; a drain after the terminal made the end of the
  turn jump twice (CLS after completion on the phone 0.02 → 0.59).
  `AgentResponse` gates its caret, footer and whole-answer actions on
  `isStreaming` alone.

Measured on the recorded answer (production build, 390 px, 4× throttle): the
visible text grows in steps of 15 characters every 50 ms (median) where it
used to grow in 25-character steps every 83 ms with gaps up to 400 ms, and
long tasks during the answer fell from 9–12 to 4–7.

This is not the typewriter below. That one simulated a latency the system
did not have, over text that was already finished; this one smooths a
latency the system does have, and is bounded by `MAX_LAG_MS`. A buffered turn
still paints at once: it sends no deltas, only the terminal, which is never
paced.

### The typewriter that was removed

This section is about a buffered turn.

The delta sequence is a SHAPE, not a pace. `response_to_chunks` cuts a finished
answer into ~24-character pieces (`iter_answer_deltas`) and yields them as fast
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
- Live turns (ADR-0066): `tests/aiq_agent/turn/test_answer_stream.py` (the
  streamed call, the retraction of a tool round, the settle off the loop);
  `frontends/ui/src/features/chat/store.spec.ts` and
  `frontends/ui/src/features/collaboration/lib/spectator-frames.spec.ts` (the
  two folds, case for case); `stable-overrides.spec.tsx` (a drawn diagram and
  an arrived card survive the next token). ADR-0066's Confirmation lists the
  rest.
