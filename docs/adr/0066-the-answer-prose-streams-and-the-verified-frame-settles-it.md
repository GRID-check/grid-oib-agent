---
status: accepted
date: 2026-09-24
decision-makers: Grid engineering
consulted:
informed:
---

# The answer's prose streams as it is written, and the verified frame settles it

## Context and Problem Statement

The chat answer reached the reader only once the whole turn was done: research
rounds, the final call, card registration, citation verification, a possible
repair, sanitising. `docs/design/streaming-chat-answer.md` (2026-07-18) built
the wire for deltas but fed it the FINISHED text, cut into 24-character
pieces, because verification needs the complete answer and a turn can still be
superseded. The first frame therefore left with the last byte of work.

Measured on the answer suite's 25 recorded turns (2026-09-24): the final call
thinks for 5-28 s before its first visible token, then writes for 5-21 s; the
prose is about half of what it writes, the cards JSON the other half, and
verification follows. The prose could reach the reader about 7 s (median)
before the turn ended, and be complete before it would otherwise have begun.

## Decision Drivers

* A citation the verifier has not checked must never be shown.
* The terminal frame is authoritative for persistence and the single-consumer
  fold; nothing may change that.
* NAT's usage profiler rides the LLM call's inherited callbacks and bills it.
* No new wire message, no frontend contract change: the WebSocket, the store
  and the observer relay (ADR-0039) already carry deltas then a terminal.
* Nothing the reader is reading may move because something arrived above it.
  A chat answer is read from its top as it grows, so an insertion above the
  reading point (the masthead, a card) moves the very line the eye is on.

## Considered Options

* Keep the buffered pipeline (simulated streaming).
* Stream raw tokens as they come.
* Stream the envelope's `answer` string, withholding what only the finished
  answer settles, and let the terminal frame replace it.
* Stream it with its `[N]` markers as pending citations, and settle them the
  moment the string closes, before the cards and the pipeline.
* Change the carrier to a prose-first trailer (turns audit §3.4).

## Decision Outcome

Chosen option: "stream it with pending citations, settled at the string's
close", because it shows the reader the prose while the model writes it, each
citation in its place from the first moment, without ever showing an
unverified one as real. (The first cut withheld the markers until the
terminal frame; they then appeared all at once at the end, which read as
citations bolted on afterwards.)

The answering call runs with `bind(stream=True)`. A callback added to the
call's inherited callback manager (never passed as the call's own callbacks,
which replace the inherited ones and would drop the profiler) reads its tokens
through `common/answer_prose_stream.py`: it finds the `"answer"` key, decodes
the JSON string as it grows, streams each `[N]` and `[[card:N]]` marker
whole, and collects everything from the sources heading on,
recognised with the verifier's own pattern. A reply that is not an envelope
streams nothing, because a tool round can open with a line of preamble. While
the answer streams, the client renders a marker with no source entry yet as a
PENDING pill (`#cite-pending-N`: muted, pulsing, no peek).

When the string closes, the callback settles it with the pipeline's own
functions (`settle_streamed_citations`: `verify_citations`, `sanitize_report`,
the cited sources), against the registry the turn answers from, and sends ONE
snapshot frame (`stream_replace`, with `sources`) whose text replaces the
bubble's: the verified, renumbered prose and its written source list. The
pending pills become the answer's citations, or vanish if their line did not
verify. The turn generator relays deltas in 50 ms windows while the answer
task runs, then yields the terminal alone, which replaces the text once more
with the same numbers.

Everything that stands ABOVE or BESIDE the prose reaches the page before the
prose moves past it. The envelope writes its masthead (`kind`, `topic`,
`context`, `verdict`, `summary`) before `answer`, in the prompt's schema and
the strict `response_format` alike, so the reader parses it the moment the
`answer` key appears and a live frame carries it, gated
(`LiveAnswer.masthead`: `gate_answer_meta` and the grounding of a verdict's
value), above the first word; the snapshot re-gates it against the prose,
whose restatement checks need it. A `[[card:N]]` holds a placeholder where it
stands; each card object is read as it closes, gated
(`validate_model_card`, its `[N]` recited to the settled numbers), and sent
on a live `cards` frame that fills its place, growing from the placeholder.
Cards go live only while no tool pushed a card this turn: then the model's
numbers ARE the registry's. What the terminal omits (a suppressed card, a
masthead gated out) it takes back. Measured on two recorded turns with the
`/dev/stream-replay` probe, before this: the reader's anchor jumped 82-150 px
on desktop and 104-229 px on a phone at the terminal frame, from the masthead
inserted above it and a 580 px card spliced in after its first paragraph.

### Consequences

* Good, because the reader reads while the model writes the rest of the
  answer, its cards and the verification: 18.1 s to first prose against 21.9 s
  to the terminal on a short answer, 27.4 s against 32.4 s on a table answer.
* Good, because what streams is exactly the model's prose minus card markers
  and sources: all 25 recorded final replies replay through the reader to
  that. Live, the settled snapshot was byte-identical to the terminal text,
  its source list included, 2.6 s before the terminal (27.5 s against 30.1 s),
  2.5 s after the first pending pill.
* Bad, because the text can still change: a pending pill whose source did not
  verify vanishes at the snapshot, a repair pass (0 in the last 25-question
  sweep, 5 in the one before) rewrites prose at the terminal, and an escalation
  replaces the bubble with the run or the handoff.
* Bad, because the model's thinking before its first token (15-20 s on most
  turns) is untouched; streaming shortens the wait for the writing, not for
  the reasoning.
* Neutral: `DeferredToolBinding` stays buffered, since its fallback would
  replay tokens already shown.
* Bad, because the envelope's field order is now load-bearing: a model that
  writes `answer` first streams its masthead at the terminal, as before, and
  the prompt's examples and the strict schema are what keep the order.
* Bad, because a card's placeholder is representative, not its height: the
  card still grows by the difference when it lands, eased, above the reader.

### Confirmation

* `tests/aiq_agent/common/test_answer_prose_stream.py`: every chunking of an
  envelope shows the prose, no delta carries a half-written marker, a card
  marker or the sources heading, and the sources are collected whole.
* `tests/aiq_agent/agents/piloti/test_settle_streamed.py`: an unbacked marker
  goes and the rest take the numbers the terminal will give.
* `citation-markers.spec.ts`, `store.spec.ts`, `use-websocket-chat.spec.ts`,
  `spectator-frames.spec.ts`: a pending marker, the replacing snapshot, and a
  spectator that does not read the answer twice.
* `tests/aiq_agent/turn/test_answer_stream.py`: the inherited handlers still see
  the streamed call, a non-envelope round streams nothing, no second call
  streams once prose went out, Responses-API token blocks are read.
* The answer suite's live runs record the reply the pipeline read, unchanged.
* `test_answer_envelope.py`: the strict schema writes the masthead, then
  `answer`. `CardSlotArrival.spec.tsx`, `card-markers.spec.tsx`: a streaming
  marker holds its card's place, a final one with no card holds nothing.
  `store.spec.ts`: a masthead frame opens the bubble, a terminal without live
  cards takes them back.

## More Information

Amends `docs/design/streaming-chat-answer.md`, whose buffered orchestration
this replaces for the prose; its wire contract stands.
