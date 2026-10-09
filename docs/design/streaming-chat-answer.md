# Streaming the Chat Answer — wire contract

**Status:** Implemented (2026-07-18); orchestration amended by
[ADR-0066](../adr/0066-the-answer-prose-streams-and-the-verified-frame-settles-it.md)
(2026-09-24): the answer's prose streams while the final call writes it, each
`[N]` a pending citation until the text closes and a settled snapshot names its
sources, and the terminal replaces it. The wire was rebuilt as typed `v: 2`
events by [chat wire v2](chat-wire-v2.md) (ADR-0068): the sections
[Wire contract](#wire-contract) and [A dropped socket resumes](#a-dropped-socket-resumes)
describe that wire. The settle and verify rules, the paced reveal and the
storage rules are unchanged by it. Streaming is the default delivery; there is
no runtime flag beyond the platform switch below.
**Related:** the per-turn chat path (`agents/piloti/conversation_register.py`,
`note_settled_replaced`), the chat socket (`frontends/aiq_api/src/aiq_api/chat_socket.py`),
the turn fold (`frontends/ui/src/features/chat/lib/turn-fold.ts`) and the chat
store. Live prose: `common/answer_prose_stream.py` and
`agents/piloti/answer_pipeline.py` (`LiveAnswer`, `settle_streamed_citations`).
The events themselves: [`websocket-protocol.md`](../api/websocket-protocol.md).
What the reader sees at every phase and edge of a turn, with the fixture and
check for each: [`lifecycles/chat-turn.md`](lifecycles/chat-turn.md).

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
> `summary`) BEFORE `answer`, so a `masthead` event carries it, gated, above
> the first word; a `[[card:N]]` marker streams whole and holds its card's
> place (`CardSlot`) until the card, gated, arrives as its own `card` event and
> is drawn into it (see [card arrival](#card-arrival)). A card's `index` is its
> place in the terminal's order: the ones tools registered this turn first (a
> draft, a document grid), then the envelope's as each closes; each streamed
> `[[card:N]]` is moved behind the tools' cards as the terminal moves it
> (`LiveAnswer.place`), so its numbers are the terminal's. The moment the
> string closes, a `STATE_SNAPSHOT` carries the verified, renumbered text and
> its sources; `RUN_FINISHED`, which the client REPLACES the answer with,
> carries the finished answer. What remains true below: the terminal is
> authoritative, and verification needs the whole answer. What
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

A turn is a sequence of typed events, each one fact, stamped with
`(turn_id, seq)` (the full table: [`websocket-protocol.md`](../api/websocket-protocol.md#events-server--client)).
The producers inside the conversation graph write wire bodies through
LangGraph's custom stream (`get_stream_writer()`), the setup phase in `_run`
yields its own, and the chat socket stamps each one with the turn's sequencer.
For the answer that means:

- **`TEXT_MESSAGE_START` / `_CONTENT` / `_END`.** The prose as the final call
  writes it. The token callback coalesces deltas to at most one per 50 ms
  (`RELAY_WINDOW_S`), flushed before any other body and at the end of the call.
  `_END` marks the envelope's `answer` string closed.
- **`RUN_FINISHED{outcome, result: TurnResult}`.** The terminal, authoritative
  for the reader and for persistence: text, keyed cards, sources, masthead and
  every transparency field. A refusal is `outcome: "refused"`, a commissioned
  run `handed_off` with `result.run`, the asker's Stop `cancelled`. The live
  events need not add up to `result.text`: a snapshot replaces them and the
  terminal replaces the snapshot.
- **`RUN_ERROR`.** The turn failed and nothing was persisted.

No frame's size depends on the prompt's length: the recorded answered turn
(`shared/wire/v2/turn-answered.jsonl`) is 22 events and 8.5 KB, the terminal
its largest at about 2 KB.

### The platform switch

Platform → Abruf carries one on/off setting, `chat.answer_streaming` (catalog:
`frontends/ui/src/lib/retrieval-settings/catalog.ts`, on by default). The
backend reads it once per turn through the retrieval-settings pull
(`answer_streaming_enabled`, TTL 60 s). Off, the answering call is buffered: no
prose, snapshot, masthead or card event goes out, the Herleitung steps still
stream live, and the answer arrives whole with `RUN_FINISHED`. The client needs
no change for that.

### Live events (ADR-0066)

Besides the prose, four events shape the answer while it is written:

| Event | Carries | The client |
|---|---|---|
| `STATE_SNAPSHOT` | `snapshot: {text, sources, answer_meta?}` | REPLACES the text with the settled, renumbered prose; the pending `[N]` become citations against `sources`. It replaces the citations too, and a snapshot without `answer_meta` removes the masthead: the re-gate dropped it. Cards are untouched |
| `CUSTOM masthead` | `{answer_meta}` | sets the masthead above the prose; the text is unchanged |
| `CUSTOM card` / `card_refused` | `{index, key, card}` / `{index}` | one card at `cards[index]` the moment its JSON closes (the tools' cards first, then the envelope's), or the refused index left empty. `key` is stable into the terminal, so the card keeps its node |
| `CUSTOM answer_retracted` | `{}` | the streamed call carried tool calls: it was a round, not the answer. Its text, citations, masthead and cards are cleared |

At most one snapshot is sent per answering call, when the envelope's `answer`
string closes, and none when there is nothing to settle:
`settle_streamed_citations` returns `None` for prose without a sources section
or a turn whose source registry is empty, and the streamed prose then stands
until the terminal. The terminal replaces the text once more and takes back
what it omits (a suppressed card, a masthead gated out). A later call of the
turn may stream again after a retraction, and settle again, but need not. A
call that put nothing on the wire is not retracted.

The settle runs the terminal's shape pass as well. A mindmap whose words are
at least 70% a table's in the same answer (`drop_restated_mindmaps`,
`agents/piloti/answer_shape.py`, `MINDMAP_TABLE_COVERAGE`) goes when the prose
settles rather than at the terminal; the reader may still see it while the
prose streams.

### Frontend (`turn-fold.ts` / `use-websocket-chat.ts` / `messages-store.ts`)

- One pure fold, `foldTurnEvent(view, event)`, is the only interpretation of
  the wire. The live socket, the replay after `attach` and the spectator
  stream (`GET /api/conversations/{id}/live`) all use it, so the asker and an
  observer cannot apply different rules.
- A duplicate `seq` returns the same view (nothing re-renders); a gap sets
  `gap` and the driver sends `attach`.
- The driver projects the view onto the assistant `ChatMessage`: text,
  `streaming`, sources, masthead, keyed cards, and the Herleitung steps in
  their stored shape (`StoredThinkingStep`). At `RUN_FINISHED` it calls the
  store's `settleTurn`.
- Diagrams: only the fence the text still ends inside is streaming
  (`isOpenFence` in `MarkdownRenderer.tsx`), and it holds its place with a
  skeleton (`DrawingSkeleton`) in the frame the drawing will be drawn in,
  guessed from the fence's first keyword until the parse says. Every closed
  fence is drawn while the answer streams. The skeleton grows into the drawing
  (`DrawingReveal`): to the drawing's laid-out height as a `ResizeObserver`
  reports it once it has stood still (a view lays its nodes out after its first
  paint, so a mindmap measures 184 px on the frame it mounts and 222 px on the
  next; it waits up to about six frames), on `motionDeliberateEntrance`, while
  the skeleton fades out over it. The line under the drawing arrives on the
  same step (`DrawingCaption`). A fence that cannot be drawn shows its source
  instead, inside the figure's own frame: the figure fades out, the source fades
  in, and the frame glides between the two heights (`useHeightGlide`,
  `motionBase`). Under reduced motion each of these lands at once, without a
  one-frame flash of the state it leaves.

**What a delta may cost.** Deltas are buffered and applied to the store every
`DELTA_FLUSH_MS` (100 ms): a `TEXT_MESSAGE_CONTENT` waits for the next flush,
anything else flushes at once, and each flush folds every buffered event in
one `set()`. Each flush replaces the
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
  and the settled turn is written one task after the one it settles in
  (below). A store update that leaves
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
of its own and its `RUN_FINISHED` carries the whole answer. The dropped
fragment used to stay beside that bubble with a caret, and it hid the
unanswered question from `restoreSessionState`'s recovery, which fetches a
finished answer the server kept while the page was away. A reload mid-answer
now takes the same path as a reload before the first word, and a turn still
running is folded again from its first event (`attach{after_seq: 0}`,
[A dropped socket resumes](#a-dropped-socket-resumes)).

`/dev/stream-socket` measures what a whole turn costs the page, through the
real socket client, hook, store and components
([the socket-level streaming harness](../contributing/testing-and-verification.md#the-socket-level-streaming-harness)).
The storage figures below were taken on `/dev/stream-chat`, which drove the
pre-v2 store actions and was deleted with them in the chat wire v2 cut; it
seeded `history=N` conversations of the recorded answer (`&extras=1` with its
sources, cards and masthead), which `/dev/stream-socket` does not.

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

### The end of a turn

The settle is the most expensive frame the chat draws: the whole answer
re-renders with its footer, its citations and its cards. A production trace
(2026-09) showed a 1018 ms task there, most of it the browser copy of the
history (a prune, a `JSON.stringify` and a `localStorage.setItem`) written
inside the settle, ahead of the render. The store's settle (`applyTurnEvents`,
on the terminal) now holds that write for one task (`deferChatStorageWrites`), the way a composer draft is
held, so it is still written at once when the page hides or a later update
writes anyway.

A turn that commissions a run (`RUN_FINISHED{outcome: "handed_off"}`) does not
end with an answer. The projection swaps the answer, in the same frame, for a
provisional run message under the id the server wrote the run's message with
(`result.run.run_message_id`, `provisionalRunMessage` in `turn-projection.ts`),
whose ledger is stamped older than any the server writes. `adoptRunMessage`
replaces it in place when the stored row arrives. A fetch that fails leaves the
provisional block standing; it follows the run's own stream from its id, so it
still shows the run. Before this the answer was dropped and the turn had no
response for a round trip, which the Herleitung read as an interrupted turn.
The thread keys a turn's answer row by its question, not by the message's own
id, so the swap keeps the row's node ([The turn on screen](#the-turn-on-screen)).

### Card arrival

A placed card's place is one element from marker to card (`CardSlot`,
`CardSlotArrival.tsx`), so the reader sees one frame change, never one box
replaced by another. Pending, it is a card-shaped placeholder
(`CardPlaceholder`, the framed register) 96 px tall. When the card exists it
is mounted invisibly under the placeholder; when it reports itself drawn (the
catalog's `DrawnProvider`, which `A2uiCard` passes on) the card fades in over
the placeholder while the frame grows to the card's height on
`motionDeliberateEntrance` (`height: 'auto'`, `AnimatePresence` for the
placeholder's exit). A card arrives once per page (`messageId:index`): a
remounted slot (the Markdown renderer keys blocks by position) shows it at
once, as do a reload, a finished answer and reduced motion. Whether the answer
is live reaches the slot through context (`CardSlotLiveProvider`), so the
settle does not hand every slot a new renderer; a card re-sent unchanged on a
later frame keeps its object (TanStack Query's `replaceEqualDeep`), so nothing
under it re-renders. `/dev/stream-socket` plays the recorded cards as their
own `card` events and in the terminal.

A place held for a card that never comes (`card_refused`, a card this reader
may not see, or an answer that settled without it) folds away on the exit
curve, its paragraph margin with it, instead of vanishing: a 120 px
placeholder that left in one frame pulled everything under it up by as much.
Only a slot the reader saw hold a place animates; one that never showed
renders nothing.

The cards no `[[card:N]]` claimed are drawn only once "unplaced" is final, which
is the moment the shown prose is the whole arrived text and the frame carries
cards (`unplacedIsFinal`), or the settle. Read off the body so far, a card
whose marker had not been revealed yet rendered below the prose and then
jumped up into it. They arrive the way a placed card does (`CardSlot`), inside
a `HeightArrival` like the answer's other late blocks
([below](#the-turn-on-screen)).

The `[N]` markers are pending pills while the answer is live: in their place
and shape, muted and still. They do not pulse: an answer holds dozens, and a
pulse on each was dozens of ambient loops beside the one a turn allows. The
remark plugins mark every unresolved `[N]` pending whether or not the answer is
live, so the plugin list keeps its identity through the settle and the settle
frame re-parses nothing; `CitationMarker` reads `useAnswerLive` and draws the
pill while live and the plain „[N]" once settled.

### Single-consumer fold (`--input` CLI, single-shot HTTP)

`_run` is annotated `Streaming(convert=fold_turn)`, so `nat run`, `nat eval`
and single-shot HTTP still get one `ChatResponse`: `fold_turn`
(`turn/streaming.py`) returns the `RUN_FINISHED` result's text. The answer
suite reads that output, and it counts the `Piloti: the terminal frame replaced
the settled answer` log line (`note_settled_replaced`).

## A dropped socket resumes

iOS closes a page's WebSocket the moment the app goes to the background, and a
phone on the move loses it for a few seconds anyway. The answer must still
arrive when the reader comes back (2026-09).

**The cursor is `(turn_id, seq)`.** Every event names its turn and carries a
per-turn `seq` from 1, and `ConversationBus.publish_frame` appends every
stamped event to the conversation's stream on Dragonfly (`conv:<id>:stream`,
ADR-0028), also when no socket is attached. The fold drops an event with
`seq ≤ lastSeq`, so an event that arrives both replayed and live counts once.

**A reconnect.** The socket client reconnects with backoff and an auth refresh,
and on open sends `attach{turn_id, after_seq: lastSeq}` for every turn still
open. The server registers the socket, buffers live events for it, replays the
turn from the stream after `after_seq`, then flushes the buffered events above
the last replayed `seq`: no event missing, none twice. A gap noticed in the
live stream (`seq > lastSeq + 1`) sends the same `attach`. There is no HTTP
replay: the BFF's `/frames` route answers only the liveness peek below.

**A reload.** A page that reloads has lost its fold with its memory. The
question's own id is the turn id (the `user_message`'s `message_id`), so
`restoreSessionState` leaves the open question as the turn to resume, and the
socket sends `attach{turn_id, after_seq: 0}` once it is up: the whole turn is
folded again from its first event. `rejected{turn_not_found}`
(the stream no longer holds the turn) ends it by asking for the persisted
answer, and shows the banner only if there is none.

**A switch.** Opening another conversation mid-turn takes the socket with it,
but not the turn: its view stays in the store (`turns`), and the partial answer
stays in its thread. Coming back opens a socket that re-`attach`es the turn
from the last `seq` its view folded, so it carries on where it was left. An event
or error that lands after the switch belongs to the conversation it was fetched
for: a commissioned run's message goes into that conversation
(`adoptRunMessage(conversationId, …)`), and a connection error whose health
check outlived the switch writes no card.

**The server keeps every answer.** The chat socket persists every finished
turn from its `TurnResult` (`persist_turn_result`), whether or not a socket
took `RUN_FINISHED`. The reader's connection decides only how soon the answer
appears, never whether it exists. A turn the asker stopped is persisted too:
its text is what was on screen at the press, not what had arrived ahead of the
reveal (`cancel_turn.shown`, chat wire v2 §b Cancel), and `metadata.stopped =
true` (kept by the BFF as `provenance.stopped`) marks it as stopped on reload.

**One answer, not two.** The browser still writes the answer it received.
Both use `uuid5(grid:assistant:<conversation>:<turn>)`
(`deterministic_assistant_message_id`, `turnAnswerId`), so the second write
collides on `messages.id` and no-ops, and the recovery dedupes by id.

**Waiting, not accusing.** A page that lost its turn and finds no finished
answer does not say "lost" at once: the turn may still be running.
`_awaitServerAnswer` asks for the answer every 4 s for as long as the turn
still produces events. It peeks at the newest entry of the stream
(`GET /api/conversations/:id/frames?peek=1`, one entry id and the server's
clock), and the heartbeat every 20 s keeps that fresh while the turn runs,
socket or not. Only a turn silent for 70 s (two minutes when there is no
stream to ask, 40 minutes at most) ends with the banner. The reader meanwhile
sees „prüfe auf fertige Antwort".

**Bounds.** `GRID_CONV_STREAM_MAXLEN` (2000 events, many turns) and
`GRID_CONV_STREAM_TTL_SECONDS` (an hour since the last event). A reader away
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
- The caret is a node inside the Markdown, not a sibling after it
  (`rehypeStreamingCaret`, `streaming-caret.tsx`): it is appended to the
  deepest last paragraph, list item, heading or table cell of the block being
  written, so every block keeps its own display. To trail the last glyph from
  outside, the renderer once forced the last block `display: inline`: the
  paragraph being written ignored its `72ch` measure (930 px on a desktop,
  rewrapped the moment the next block began), a list lost its indent, a
  heading dropped 16 px when the paragraph after it began (stream audit,
  2026-10). Where the text ends in a figure, a card slot or a code block there
  is no caret; that block shows its own progress. The caret takes no width: a
  zero-width box at the baseline with the bar and the veil drawn out of it,
  because a caret with a width pushed a last word that just fitted onto the
  next line and pulled it back when the caret moved on.
- The caret stands solid while words advance and breathes
  (`animate-caret-breathe`) only once the reveal has stood still for
  `IDLE_AFTER_MS` (600 ms), as an editor's caret does. `usePacedText` reports
  `idle` as the length it stood still at, so it flips once per pause and the
  next word ends it without a second render. A caret pulsing under arriving
  words read as a blink.
- The newest words come out of a short gradient that trails the caret, drawn
  in the card's colour (`StreamingCaret`'s `veil`) on eased stops, so its
  faint end does not read as an edge: each word starts faint and darkens as
  the next ones push it out. It moves with the caret and animates nothing. It
  is hidden after markup with a ground of its own (a code span, a citation
  pill), which the card's colour would paint over, and under
  `prefers-contrast: more` and forced colours. A fade per word (a span per word, each playing an opacity and 2 px
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
- A table appears with its first body row, not before: a header line without
  its delimiter row renders as a paragraph of pipes, and a header alone is
  drawn as a table for a frame and, on a phone, restacked into rows as soon as
  the first row comes. A row with no cell written yet (`| `) is not a clean
  cut either: it drew as a blank row whose cells then grew one by one, each
  step pushing everything below it down (64 → 84 → 87 → 90 px on a phone,
  stream audit 2026-10).
- The first clean cut is shown at once. The target lag smooths text that is
  already moving; it does not hold back the first words.
- An answer that mounts with text the reader already had starts where they
  were, at the furthest clean cut of what has arrived, and paces only what
  comes next (`startingLength`). That is an answer still on screen in this
  page when it remounted (a thread switch and back), or one born with more
  than `ARRIVED_AT_MOUNT_CHARS` (400) beyond its head, which is a turn joined
  mid-way: a reload's replay, a spectator, a thread opened again. A live
  answer is otherwise born with its first flush (35 and 63 characters on the
  recorded turns). Typing the arrived text out again read as the answer being
  written a second time.
- The masthead's summary, which arrives whole before the prose, is paced as
  the head of the prose when it leads an answer the reader is watching begin:
  one reveal writes the summary, then the body, with one caret, in reading
  order (`leadChars`, `SUMMARY_GAP`). A two-to-five-line paragraph appearing
  in one frame read as the answer's first words popping in finished. Decided
  once, at the first summary: one that arrives after prose is on screen fades
  in whole, since writing it in above the text the reader is on would move
  that text line by line. A summary that restates the body's opening is
  dropped before it is shown, judged on everything that has arrived; once
  shown, it stays.
- The lede (the first paragraph set at 17 px) is decided once, at the answer's
  first words, from what is known then: the kind (a note is never a lede),
  whether it opens with prose, and whether the masthead carries a summary or a
  topic. It used to be decided on the paced body behind a 600-character gate,
  so the paragraph the reader was on restyled from 16 to 17 px mid-stream. A
  settled answer runs the same predicate, so a stored answer looks as it did
  live. Only a retraction decides it again.
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
   text) is shown whole at once, never typed again; how the body changes
   then is under [The turn on screen](#the-turn-on-screen). A turn the reader
   stopped, or that failed under the answer, settles at once at what is
   shown and keeps it (`stopped`), so nothing types on after the press.
2. Only when all of it is on screen is the answer `settled`, and everything
   that belongs to a finished answer follows that, not `isStreaming`: the
   caret goes, the footer fades in and becomes operable, the citation pills
   turn real, the role tab's dot becomes a check, and the Herleitung's header
   (folded since the answer's first word) swaps its glyph and freezes its
   timer. The Herleitung lives in `ChatArea`, outside the answer, so the
   answer publishes that it is still revealing
   (`stores/answer-reveal-store.ts`) and `ChatArea` keeps the turn live until
   it stops.
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

Measured on both recorded answers when the paced reveal landed (production
build, 390×844, 4× throttle, against the block-parsing renderer before it):
the answer settled 70–100 ms after the terminal; CLS after completion was
unchanged (0.18–0.20 on `varianten`, 0.59–0.69 on `oib2`), and fps, long tasks
and main-thread time were within run-to-run noise. That CLS came from the card
placeholder leaving and the Herleitung's height animation, both at the settle.
Neither happens there any more: the Herleitung folds at the first word, and a
place is held or folded away while the reader watches
([The turn on screen](#the-turn-on-screen)). `measure-stream-socket.mjs` now
splits CLS at the settle (`clsBeforeSettle`, `clsAfterSettle`) and observes
2.5 s past it.

This is not the typewriter below. That one simulated a latency the system
did not have, over text that was already finished; this one smooths a
latency the system does have, and is bounded by `MAX_LAG_MS`. A buffered turn
still paints at once: it sends no deltas, only the terminal, which is never
paced.

### The typewriter that was removed

This section is about a buffered turn.

The delta sequence is a SHAPE, not a pace. `response_to_chunks` cuts a finished
answer into ~24-character pieces (`iter_answer_deltas`) and yields them as fast
as the socket takes them, so they reach the store one or two
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

## The turn on screen

Six components draw into one region while a turn's frames arrive: the
question row, the Herleitung (`ChatThinking`), the answer card
(`AgentResponse`), its cards, the composer and the thread's scroll
(`ChatArea`). Most of what went wrong on screen (stream and motion audits,
2026-10) was one component's correct move shoving another's content. The rules
below are what each of them does instead. Every phase and edge, with its
fixture and its check: [`lifecycles/chat-turn.md`](lifecycles/chat-turn.md).
Three rules hold across all of them:

- **One ambient loop per phase.** Before the answer, the Herleitung header's
  shimmering label. During the prose, the caret. After the settle, nothing.
  No spinner beside the label, no pulsing pill, no progress sweep.
- **Fade, then resize.** A block that must change size while visible fades
  first, then changes height in one frame while it is invisible. Only a block
  arriving below the reading point, a card slot growing and a panel the
  reader opened animate their height
  ([design language, Height](grid-design-language.md#motion-vocabulary)).
- **What you saw is kept.** A stop, an error, a remount or a replay never takes
  away text the reader has seen, and never types it out again.

### From the send to the settle

**One object from the send.** The question's Herleitung header mounts with the
question row and is the working cue from the first frame: „Denkt nach…" with
the label's shimmer, a timer from the question's timestamp once it passes two
seconds (`useElapsedSeconds`, in a reserved `3.5ch` with tabular digits), and
no typing bubble that a panel later replaces. The steps grow into the same
object. The header's icon slot is static; the screen reader hears the phase,
never the per-step phrase, at most once every 3 s.

**The live cap.** While the turn works, the panel's content is capped at
`min(50svh, 420px)` and scrolls inside itself, pinned to its newest row while
the reader is at its bottom, with a top fade only while something is above.
A Herleitung that grew past the viewport used to push the answer it was about
to fold into below the fold.

**The fold.** The answer has begun the moment it has anything to draw: a
masthead or a card counts as well as the first word. At that moment a panel
the turn opened, and the reader never touched, folds: its content fades on
`motionQuickExit` (180 ms) with its height held, then the height drops in one
frame (`AnimatePresence` custom reason `fold`). The answer row is withheld
until the fold is done (`FOLD_HOLD_MS`, the fade plus two frames) and mounts
directly under the folded bar. Mounted at once, its first line painted below
the open panel and was yanked up by the panel's height, 400 px, as the reader
started reading. The hold applies only to an answer this view watched begin
under a Herleitung that had steps to fold. A panel the reader opened or closed
by hand is never overruled; one they opened keeps its cap through the settle,
and their next toggle releases it.

**The header through the settle.** From the first word the label stops
shimmering and becomes the panel's summary („Herleitung · n Quellen"); the
caret is the turn's one moving thing from then on. The header stays live
until the answer settles. At the settle the label does not change: the dot in
the icon slot becomes a check on `iconSwapTransition` (scale 0.7 → 1 on
`springSnap`, opacity on a tween), and the timer freezes on the answer's own
duration, never below the last live figure. There is no „Fertig": swapping
the label for it at the settle moved the summary across the row. A turn that
did not simply finish says how it ended in a word on the right, with a neutral
glyph: „Gestoppt", „Fehlgeschlagen", „Auftrag angelegt" (a run was
commissioned, `handed_off`) or „Nicht bearbeitet" (refused). A turn that took
no step keeps its bar after the settle, so the answer is not pulled up by its
height in the frame the turn ends.

**The settle is said once.** One polite region in `ChatArea`, mounted for the
thread's life, says „Antwort fertig: {gist}" when this client's turn ends: the
verdict, else the first sentence, at most 120 characters. The thread is not a
`role="log"`, which would announce every word.

**The footer.** While the answer arrives its footer (sources row, actions,
details) is hidden, and fades in at the settle. Shown, it moved down a line
with every line the prose grew: 0.18 of the turn's 0.20 CLS on the desktop
harness. Its room is reserved, invisibly, only once the body reaches below the
viewport, where nobody sees it (`footerReserved`, `HeightExpand`); reserved
from the first frame, it drew the card's first words over a 116 px empty band.
An answer shorter than the viewport opens its footer at the settle, below the
last line. The copy actions are in the row from the first frame, invisible and
inert (`pending`), so the settle does not widen the row or wrap it onto a
second line on a phone.

**Late blocks.** What arrives below the prose after it began (a Projektbezug
strip, the takeaways and an unplaced callout, the unplaced cards) takes its
height on `HeightArrival` while it fades in, inside `AnimatePresence
initial={false}`, so a stored answer's blocks simply stand. A Projektbezug that
binds its first fact while the reader is reading goes below the prose; the next
view puts it back above. A masthead that arrives after the prose fades in
alone; one gated out by a snapshot or the terminal fades out first and loses
its height in one frame once invisible. The turn's self-assessment, which
arrives with the terminal, lives in the answer details, not above the prose.
The role tab carries a quiet dot while the answer arrives and its check from
the settle.

**A terminal that does not continue what was shown.** A settled snapshot or a
terminal that rewrites or shortens the text replaces the body in one frame;
tables and diagrams vanished with it. The new body now fades in on the same
element, so the Markdown tree is not rebuilt, and the body's frame keeps its
old height as a minimum and lets go of it on a glide (`glideFrameDown`). The
verified text is often much shorter (the recorded `oib2` terminal is 541
characters against 1,724 streamed), and everything below used to jump up by
the difference. The glide eases the minimum, not the height, so words that
keep arriving are never clipped.

### Stop

Stop keeps what was on screen at the press. The rule of what that is has one
copy per language and three writers (the agent tier, the asker's browser and
the BFF), held to the same cases by `shared/wire/v2/stopped-cases.jsonl`:
[chat wire v2, Cancel](chat-wire-v2.md#c-the-route-and-the-handler) and
`features/chat/lib/stopped-answer.ts`. In short: the shown code points, a
marker cut in half dropped, a streamed `[N]` dropped and a settled one kept
with its source, and only the cards whose place was shown.

On the page, `stopStreaming` marks the turn stopped before the `cancel_turn`
goes out, with the position the reader had (`shown{seq, chars}`). The fold
then takes nothing more for that turn (`stoppedHere`): deltas still in flight
and the cancelled terminal, which carries everything the model had written,
are recorded but do not replace the text, sources, masthead or cards. Sent
first, a terminal that came back at once was folded as an ordinary end, and
its missing masthead took the masthead away 140 px above the reader's line.
The reveal settles at once at the shown length; the caret fades and „Gestoppt"
fades in under the last word. Nothing the stream had not shown arrives
afterwards: no takeaways, no „Ohne Quellenbeleg" row, no unplaced card that was
not already drawn. The header reads „Gestoppt" with the glyph a cancelled run
carries, never the green check, and a panel the reader was watching is left
as it was. A reload shows the stored row, which is the same cut.

A Stop that crosses the finished answer (the reveal runs up to about a second
behind the wire) finds no turn on the server, which has stored the whole
answer. The browser then cuts its copy where the text on screen and the
terminal's part (`stoppedLate`) and asks the BFF to cut the stored row:
`POST /api/conversations/{id}/messages/{messageId}/stopped`
([BFF routes](../api/bff-routes.md)). The BFF applies the same rule to the
text it holds, so it can only shorten it, for the asker only and within ten
minutes (`STOP_CUT_WINDOW_MS`).

Accepted residuals:

- Between the terminal and the settle (the 300 to 500 ms finish) the composer
  already shows Send, so Stop is not offered there.
- During a rolling deploy, a socket on an agent that does not accept
  `cancel_turn.shown` stores the prose it had, not the shown cut. Whichever of
  the two writes reaches the BFF first wins the row, so a reload may show more
  than the reader saw.

### When a turn fails

`RUN_ERROR` under a written answer keeps the words: frozen at what was shown,
as for Stop, and dimmed on a transition, with the error card under them. The
role tab gets no check and the footer stays inert, because a cut-off fragment
is not an answer to copy or rate. The header reads „Fehlgeschlagen", never
„Unterbrochen": `ChatArea` notes a failed turn as the fold marks it, because
the store drops the view before the error card is added, and with neither on
screen the turn read as lost, with a recovery spinner in front of a failure.
„Erneut versuchen" removes the card and the fragment at once, without their
exit, and resends the question; a re-sent question already within a viewport
of where it would land is not glided to.

A question the server never acknowledges fails the same way: no `RUN_STARTED`
within `ACK_TIMEOUT_MS` (15 s) reopens the socket and resends it, and a second
miss fails the turn: the Herleitung goes from live to „Fehlgeschlagen", and
an `agent.no_response` warning card („Keine Rückmeldung") offers „Erneut
versuchen" (`use-websocket-chat.ts`).

### A retraction

`answer_retracted` empties the answer mid-stream. The card used to return
nothing for it: it vanished in one frame, and the next round's first word drew
it again with a second entrance. Now the frame stays. The words fade out on
`motionQuickExit`, the body holds the height it had with one quiet line in it
(„Antwort wird erstellt …"), and the next round's first word on screen, or the
settle, lets go of the height on a glide. The lede and the kept summary are
decided again from the next round's first words, once the old ones have
faded. The Herleitung stays folded: reopening it pushed the held frame down by
248 px, only to fold again at the next first word.

### Joining a turn that is already running

A reload, a thread switch back, or an observer arriving mid-turn sees the text
that had arrived at once, and the reveal paces only what comes next (see the
reveal rules above). An observer's Herleitung timer counts from the question,
as the asker's does, and their view keeps one ambient loop; an observer who joined mid-answer waits for
the whole text rather than starting mid-sentence. When a colleague's answer,
watched live, is swapped for its persisted row, the row is placed, not
entered: the swap is like for like.

### Opening a thread

`selectThreadPhase` (`features/layout/lib/thread-phase.ts`) decides once what
the open thread is: `hydrating`, `loading`, `empty` or `thread`. `MainLayout`
lifts the composer onto the empty canvas and `ChatArea` draws the greeting from
the same selector. Deciding "empty" separately, from different inputs, flashed
the greeting and sprang the composer to the middle and back while a thread's
messages were on their way. While they load the thread shows a skeleton, never
the greeting, and the messages that replace it are placed, not entered.

Where a thread opens, once its messages are here, in this order:

1. the message a deep link names (`useMessageAnchor`), which then owns the
   position: neither the bottom jump nor following moves the reader off it;
2. in a shared thread, the unread divider;
3. where the reader was when they left it this session
   (`thread-positions.ts`: the first visible row and its offset, in memory
   only, or "at the end");
4. else its end, or the last turn's question when that turn is taller than the
   viewport, so a long answer is read from its start.

The position is set directly in a layout effect, so a switch never paints a
frame at the old thread's scroll position. A thread switched back to mid-turn
is anchored again as it was. Opened at its end and following, it scrolled with
every flush: 25 programmatic scrolls in one switch and back (motion audit,
2026-10).

### The status dock and the composer

**The status dock** is one quiet line just above the composer, positioned out
of the thread's flow: a dropped connection („Verbindung unterbrochen · Piloti
verbindet sich neu …", then „Wieder verbunden" for 2.4 s), or in a shared thread a colleague typing. Both used to
live in the thread: the connection error as a card that collapsed out on
reconnect, the typing line at the list's end, which bobbed the thread every
time someone started or stopped typing. A transient connection error is not a
displayable message any more (`isTransientConnectionError`). A polite live
region beside the dock says each change once. The jump-to-latest button lifts
above the dock while it speaks.

**Typing ahead.** During the reader's own turn the composer's field stays live
(`canDraft`) and keeps its focus, so the follow-up can be written while the
answer arrives. Only the send waits: Enter is swallowed, no newline lands and
nothing is queued, since a queued send would fire on a settle the reader may
not have read. The placeholder says so while the field is empty. Send and Stop
are one button whose glyph morphs (`useIconSwapTransition`); Stop shows the
moment the turn exists, and Send returns on the press, not on the server's
acknowledgement. Escape stops the answer from the composer or from the page
body, after any open picker has taken its own Escape, and never touches the
draft. On a coarse pointer the send blurs the field so the keyboard closes and
the answer is visible; a fine pointer keeps focus.

### Scroll

- **The send anchors the question.** The question glides to the top of the
  viewport (`glideScrollTo`, `springGlide`, started a frame after layout so
  the question is measured where it landed and without its entrance rise). A
  travel over 1.5 viewports first jumps to half a viewport short and glides
  the rest. The reader's wheel, touch, pointer or key stops it where it is.
  Reduced motion sets the position directly. `scrollIntoView({behavior:
  'smooth'})` it replaced could not be interrupted and crossed thousands of
  pixels at a speed nobody could read.
- **Following is the reader's choice.** Growth below is followed only after a
  scroll the reader drove to the end of the content, or a press on
  jump-to-latest. A scroll the page caused (a clamp as a panel shrinks the
  list, a glide) never starts it: reading a clamp as "the reader is at the
  bottom" chased a reader at the settle with seven programmatic scrolls in a
  row (motion audit, 2026-10). While a question is anchored, reaching the end
  does not start following on its own. A follow waits while a finger is down
  or a fling is still moving.
- **Unseen below is measured from the content's end**, the anchor spacer's
  top, against what the reader can see above the composer. Measured against
  the scroll height, every live turn read as "not at the bottom" and showed
  the button.
- **The anchor spacer counts the composer.** The list's bottom padding (the
  composer's height plus 1.5rem) is scroll room too, so a composer that shrinks
  after a send gives back what the spacer takes and nothing is clamped. The
  spacer is fitted and kept until the next question or a thread swap
  ([gotchas](../contributing/gotchas.md)).
- **An observer following a colleague's turn is anchored too**, its question
  at the top. One reading further up is not moved.

## Tests

- Contract: every recorded turn in `shared/wire/v2/` is valid and is byte for
  byte the frame the server writes (`tests/aiq_agent/common/test_wire_v2.py`,
  `frontends/ui/src/adapters/api/wire-v2.spec.ts`).
- Producers and handler: prose deltas are coalesced, the snapshot and the
  retraction are emitted from the streamed call, `RUN_FINISHED` is persisted
  from `TurnResult`, and a cancelled turn persists its partial marked stopped
  (`tests/aiq_agent/turn/`, `frontends/aiq_api/tests/test_chat_socket.py`).
- Fold: every fixture turn folds to the expected view; a duplicate `seq` keeps
  identity and a gap is flagged; snapshot, retraction and terminal
  replacement; a card before its marker; a spectator starting mid-turn
  (`frontends/ui/src/features/chat/lib/turn-fold.spec.ts`).
- Frontend: the whole-answer affordances (copy, unclaimed cards) wait for
  `isStreaming` to clear (`AgentResponse.spec.tsx`, "a streaming answer");
  `stable-overrides.spec.tsx` (a drawn diagram and an arrived card survive the
  next token). ADR-0066's Confirmation lists the rest.
- The turn on screen: `AgentResponse.settle.spec.tsx` (the caret's idle
  breath, the footer handed over at the settle, Stop, a mid-turn mount, the
  paced summary, a retraction), `use-paced-text.spec.ts` ("after Stop",
  "mounting mid-turn"), `turn-fold.spec.ts` ("after a Stop pressed on this
  page"), `stopped-answer.spec.ts` and `stopped-cut.spec.ts` (the stop rule),
  `ChatThinking.spec.tsx` ("the header from the send to the settle"),
  `ChatArea.spec.tsx` ("the live Herleitung", "opening a thread, its endings
  and its dock", "the jump-to-latest button"), `thread-phase.spec.ts`. The
  scenarios to watch them in: `/dev/stream-socket?scenario=…` and
  `/dev/turn-outcomes?scenario=…`
  ([lifecycle matrix](lifecycles/chat-turn.md)).
