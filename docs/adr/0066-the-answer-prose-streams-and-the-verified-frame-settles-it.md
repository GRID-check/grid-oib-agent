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
unverified one as real, and it needs no change to the prompt or the envelope.
(The first cut withheld the markers until the terminal frame; they then
appeared all at once at the end, which read as citations bolted on afterwards.)

The answering call runs with `bind(stream=True)`. A callback added to the
call's inherited callback manager (never passed as the call's own callbacks,
which replace the inherited ones and would drop the profiler) reads its tokens
through `common/answer_prose_stream.py`: it finds the `"answer"` key, decodes
the JSON string as it grows, streams each `[N]` marker whole, withholds
`[[card:N]]` markers, and collects everything from the sources heading on,
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

## More Information

Amends `docs/design/streaming-chat-answer.md`, whose buffered orchestration
this replaces for the prose; its wire contract stands.
