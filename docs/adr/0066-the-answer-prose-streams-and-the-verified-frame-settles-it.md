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
* Change the carrier to a prose-first trailer (turns audit §3.4).

## Decision Outcome

Chosen option: "stream the `answer` string, withheld and replaced", because it
shows the reader the prose while the model writes it without ever showing an
unverified citation, and it needs no change to the prompt, the envelope or the
wire.

The answering call runs with `bind(stream=True)`. A callback added to the
call's inherited callback manager (never passed as the call's own callbacks,
which replace the inherited ones and would drop the profiler) reads its tokens
through `common/answer_prose_stream.py`: it finds the `"answer"` key, decodes
the JSON string as it grows, and withholds `[N]` markers, `[[card:N]]` markers
and everything from the sources heading on, recognised with the verifier's own
pattern. A reply that is not an envelope streams nothing, because a tool round
can open with a line of preamble. The turn generator relays the queue as delta
chunks in 50 ms windows while the answer task runs, then yields the terminal
alone, and the client REPLACES the streamed text with it.

### Consequences

* Good, because the reader reads while the model writes the rest of the
  answer, its cards and the verification: 18.1 s to first prose against 21.9 s
  to the terminal on a short answer, 27.4 s against 32.4 s on a table answer.
* Good, because what streams is exactly the verified prose minus what is
  withheld: all 25 recorded final replies replay through the reader to that.
* Bad, because the text can change at the end: markers and sources appear, a
  repair pass (0 in the last 25-question sweep, 5 in the one before) rewrites
  prose, and an escalation replaces the bubble with the run or the handoff.
* Bad, because the model's thinking before its first token (15-20 s on most
  turns) is untouched; streaming shortens the wait for the writing, not for
  the reasoning.
* Neutral: `DeferredToolBinding` stays buffered, since its fallback would
  replay tokens already shown.

### Confirmation

* `tests/aiq_agent/common/test_answer_prose_stream.py`: every chunking of an
  envelope shows the prose and no delta carries a marker or the sources heading.
* `tests/aiq_agent/turn/test_answer_stream.py`: the inherited handlers still see
  the streamed call, a non-envelope round streams nothing, no second call
  streams once prose went out, Responses-API token blocks are read.
* The answer suite's live runs record the reply the pipeline read, unchanged.

## More Information

Amends `docs/design/streaming-chat-answer.md`, whose buffered orchestration
this replaces for the prose; its wire contract stands.
