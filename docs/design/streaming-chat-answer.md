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
> and grows into it (`CardArrival`). A live `cards` frame lists the cards in
> the terminal's order: the ones tools registered this turn first (a draft, a
> document grid), sent with the settled prose, then the envelope's as each
> closes; each streamed `[[card:N]]` is moved behind the tools' cards as the
> terminal moves it (`LiveAnswer.place`), so its numbers are the terminal's. The moment the
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
| Cards | empty `content`, `cards` | fills the `[[card:N]]` placeholders; the text is unchanged. The whole list so far, in the terminal's order: the tools' cards, then the envelope's, `null` holding a refused one's place |

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
  (`onlyTheLiveTurnGrewIn`, `stores/chat-storage.ts`), not even when a
  rename or a draft is written beside it. `getItem` drops an answer still
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
- A write costs one conversation, not the history. Storage is one key per
  conversation's messages (`aiq-chat-store:messages:<id>`) and a small index
  (`aiq-chat-store:index`: the list without messages, the open id, the drafts,
  the open question). A send or a settle writes the index and the conversation
  that changed; a switch or a draft writes the index alone; a read of an
  unchanged conversation is skipped by reference, never serialized.
- A full quota costs the oldest conversations' messages, never the list.
  Messages are a cache of the server: every message is posted as it is
  created (`_appendMessage`), the backend persists every finished answer
  itself ([A dropped socket resumes](#a-dropped-socket-resumes)),
  the Herleitung, card decisions, prompt answers and stages are mirrored to
  the row, and a conversation opened without messages is fetched
  (`hydrateConversationMessages`). So past `CHAT_STORAGE_BUDGET_CHARS` (3 M
  characters, headroom for the rest of the origin) or on a
  `QuotaExceededError`, the least recently updated conversation's messages
  are evicted, never the open one's or one with a run still going. What
  exists only in the browser (the drafts, the titles, each conversation's
  data-source choice) lives in the index, which is never evicted. A
  conversation read back without messages is marked as waiting for the server
  (`isAwaitingServerMessages`), so the upload-only cleanup does not take its
  empty list for an abandoned thread and delete it on the server.
  - The first load after the change moves the old single key `aiq-chat-store`
    into this shape: the index first, beside the old key; the old key then
    goes and the messages follow, newest first (`migrate`). A tab still
    running the old code that writes the old key again is moved on the next
    load.
  - History: each flush once pruned, serialized and wrote the whole history,
    74 writes of 1.3 MB for one answer beside forty conversations; coalesced
    to one write per two seconds it was still a 100 ms task plus a 55 ms
    native write every two seconds on a 4× throttled CPU. Removing it took the
    worst frame of a streamed answer from 1.4 s to 250 ms. The steps, the
    opening, the snapshot and the drafts still wrote the whole history until
    2026-09: 5–7 writes of 250–1000 ms per turn and 264 ms a keystroke with 20–40
    conversations stored (React performance audit, 2026-09). What remained
    (the send, the settle, a switch) each still pruned, serialized and wrote
    the whole history, and past the quota `setItem` threw and the recovery
    wiped every stored session. Measured before and after one key per
    conversation: see [Storage, measured](#storage-measured).
- Nothing outside the chat list subscribes to the conversation objects. The
  shell, the composer and their hooks select what they show (an id, a title, a
  count, a boolean), and the sessions panel's rows keep their identity across a
  flush (`use-session-rows.ts`). A flush does not bump `updatedAt`.

**The Markdown is parsed block by block.** `MarkdownRenderer` cuts the text
into top-level blocks of at least 1200 characters (`markdown-blocks.ts`) and
parses each on its own, memoised on its source, so a reveal step parses only
the block that grew. Parsing the whole text on every step cost time linear in
the answer's length: on a production build at 390×844 with a 4× CPU throttle,
a 10k-character answer spent 262 ms of every second in the Markdown pipeline,
its commits reached 41 ms at p95, and it had 32 long tasks (2026-09). Blocks
brought that to 75 ms, 14 ms and 7 to 9 long tasks.

Markdown is not safely incremental: a later line can change earlier blocks (a
`---` under a paragraph makes it a heading, a delimiter row makes it a table,
a blank line makes a whole list loose). So the text is cut only where no later
line can reach back across the cut, and one that holds a construct reaching
across blocks (a link definition, a footnote, an HTML block) is not cut at
all. The rule it is held to, `streaming-markdown-equivalence.spec.tsx`: for
every prefix of the recorded answers, the blocks render the same HTML as the
whole text rendered at once, at the default size and with a cut at every
permitted place. A cut, once made, stays where it is while the text grows.

Why a minimum size: every parse has a fixed cost, and when the turn ends
every block is parsed again, because the chat's plugins stop drawing pending
markers. A block per paragraph made that settle cost nearly twice what the
whole text does. At 1200 characters it is back near the whole-text cost: 28
against 24 ms for 11k characters under vitest. In the browser it is 10 to 25
ms heavier for a 2.6k-character answer, and no heavier for a 10k one.

**A reload mid-answer.** Nothing streams in a page that is only now loading,
so the storage drops a stored answer that still says `isStreaming` when it
reads the store (`createResilientStorage`, `stores/chat-storage.ts`). The reattached turn opens a bubble
of its own and its terminal frame carries the whole answer. The dropped
fragment used to stay beside that bubble with a caret, and it hid the
unanswered question from `restoreSessionState`'s recovery, which fetches a
finished answer the server kept while the page was away. A reload mid-answer
now takes the same path as a reload before the first word, and a turn still
running is rebuilt from the replay stream
([A dropped socket resumes](#a-dropped-socket-resumes)).

`/dev/stream-chat?history=40` measures this: the real store and the real shell
(`&shell=1`), fed a recorded answer at its recorded pace, with commits, storage
writes and long tasks in `window.__streamChat`. `&extras=1` gives every seeded
answer the sources, cards and masthead the recorded one settled with: bare,
forty conversations are 1.4 M characters; with them 4.6 M, the weight real
answers carry. Until 2026-09 it seeded a user
id the chat resets on mount, so the open thread and the sidebar were empty
whatever `history` said; the persisted size was real, the rendering was not
(`docs/contributing/gotchas.md`).

### Storage, measured

Production build, 390×844, Chromium at a 4× CPU throttle,
`/dev/stream-chat?history=N&shell=1&extras=1`, each store action timed to
the end of the task after it (React's commit included), median of three
runs, 2026-09:

| Stored | Action | Before: store action / longest task / written | After |
|---|---|---|---|
| 20 conversations (2.3 M chars) | send | 191 ms / 277 ms / 2.3 M chars | 15 ms / 78 ms / 71 k |
| | settle | 176 / 512 / 2.3 M | 10 / 251 / 74 k |
| | switch | 150 / 295 / 2.3 M | 4 / 117 / 3 k |
| | rehydrate | 94 ms | 67 ms |
| 40 (4.6 M chars) | send | 360 / 453 / 4.6 M | 16 / 97 / 74 k |
| | settle | 366 / 669 / 4.6 M | 22 / 367 / 77 k |
| | switch | 304 / 484 / 4.6 M | 3 / 126 / 6 k |
| | rehydrate | 138 ms | 73 ms |
| 60 (6.8 M chars) | every write | ~400 ms, `QuotaExceededError`, then **all 61 conversations wiped** (172 characters stored) | 12 ms a send, no error: 61 conversations listed, the newest 26 with their messages (2.9 M chars), the rest read from the server when opened |

"Store action" is the synchronous time of the action, where the storage write
happens; the longest task adds React's commit, which is what remains of the
settle (the answer's cards). Forty conversations used to fit the quota and now
keep 26 with their messages: the 3 M-character budget leaves the rest of the
origin room, and is the number to raise if refetching an older conversation
on open turns out to cost more than the headroom saves.

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

**A switch.** Opening another conversation mid-turn takes the socket with it, so
the open bubble can never finish. Leaving drops it as a reload does
(`leaveOpenTurn` in `sessions-store.ts`, `discardStreamingAssistantMessage`,
and the socket effect's cleanup for any other way out), and clears
`streamingAssistantMessageId`. Kept and settled, it blinked forever and, being
the last message, hid the open question from `restoreSessionState`; dropped,
coming back runs the reload's recovery. A frame or error that lands after the
switch belongs to the conversation it was fetched for: a commissioned run's
message goes into that conversation (`adoptRunMessage(conversationId, …)`), and
a connection error whose health check outlived the switch writes no card.

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

- The reveal aims to sit `TARGET_LAG_MS` (1.2 s) behind the arrivals, never
  slower than `MIN_CHARS_PER_SECOND`, and never holds text back longer than
  `MAX_LAG_MS` (2.5 s). Long enough that a burst is paid out at one rate
  rather than the reveal speeding up and stalling. Simulated over both
  recorded answers, targets from 1.0 to 1.5 s and ceilings from 2 to 3 s
  differ little: the stalls that remain (0.6 s at most) are the model's own
  pauses. 1.2 s had the steadiest rate. 1.5 s left twice the text for the
  finish (below).
- It is clocked by animation frames but commits only when the cut moves to
  the next word gap, so a word appears whole and the Markdown block that grew
  is re-parsed once per word, about 24 times a second on the recorded answer,
  as often as the 50 ms tick it replaced. The rate's carried-over credit
  always reaches the next word: capped at 200 ms of a slow rate, it could not
  reach „erforderlich, " and the reveal stalled until the ceiling dumped it.
- The newest words come out of a short gradient that trails the caret, drawn
  in the card's colour (`StreamingCaret`'s `veil`): each word starts faint and
  darkens as the next ones push it out. It moves with the caret and animates
  nothing. A fade per word (a span per word, each playing an opacity and 2 px
  lift entrance once, keyed so a shown word kept its DOM node) was built and
  measured first: on the prose-heavy recorded answer at 390 px with a 4×
  throttle it took fps from 57 to 45–49, long tasks from 4 to 7–10 and main
  thread from 580 to 780 ms/s, because each word is a compositor layer
  painted twice. With `display` animated in the keyframes the compositor
  could not run it at all (165 paints/s against 105); as an inline opacity
  fade it painted every frame (330/s). The veil keeps fps at 57–58, long
  tasks at 2–4 and main thread at 550 ms/s (2026-09).
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
- Only the prose is paced. A written `## Quellen` section is lifted into the
  source rows and never drawn as text (`proseLength`), so it joins the text
  once the prose is all shown. Pacing it held the end of the turn back by
  half a second after the last visible word.

**The end of the turn is one step.** With more than a second held back,
showing the terminal whole would be a visible jump, and draining it at the
streaming rate after the reasoning had collapsed made the end jump twice
(CLS after completion on the phone 0.02 → 0.59, removed in #772). So:

1. When the terminal lands, the text still held back is finished in 300–500
   ms (`finishCut`, `finishDuration`: longer for more text, fast at first and
   easing into the end, at clean word gaps). The caret fades out meanwhile.
   A terminal that does not continue what is shown (a rewrite, a shorter
   text) is shown whole at once, never typed again.
2. Only when all of it is on screen is the answer `settled`, and everything
   that belongs to a finished answer follows that, not `isStreaming`: the
   caret goes, the footer and the unplaced cards come, the citation chips
   turn real, and the Herleitung collapses. The Herleitung lives in
   `ChatArea`, outside the answer, so the answer publishes that it is still
   revealing (`stores/answer-reveal-store.ts`) and `ChatArea` keeps the turn
   live until it stops.
3. A hidden page gets no animation frames, so a turn that ends while the page
   is hidden, or is hidden during the finish, settles at once; a timer
   settles it if the frames stop for any other reason (`SETTLE_GRACE_MS`).

Specs: `use-paced-text.spec.ts` (settles only with the last word, settles
once, the hidden-page and timer fallbacks, and the recorded answers never
shrink and land whole at the end of the finish), `AgentResponse.settle.spec.tsx`
(the copy action and the reveal signal change in the frame the text is
complete, and the signal fires once), `ChatArea.spec.tsx` (the Herleitung
stays live until the answer has settled), and
`streaming-markdown-equivalence.spec.tsx` (what is already shown keeps its DOM
nodes through a reveal step).

Measured on both recorded answers (production build, 390×844, 4× throttle,
against the block-parsing renderer before this change): the answer settles
70–100 ms after the terminal; CLS after completion is unchanged (0.18–0.20 on
`varianten`, 0.59–0.69 on `oib2`, where it comes from the card placeholder
leaving and the Herleitung's height animation, both at the settle); fps,
long tasks and main-thread time are within run-to-run noise of before.

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
