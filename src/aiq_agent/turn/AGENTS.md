# The per-turn harness: `src/aiq_agent/turn`

Everything that happens exactly once per chat turn and is **not** the answering
agent: parsing what the request says about the turn, loading its context and
document inventory, binding the per-turn registries, admitting it against
capacity and budget, lifting the finished state onto the wire, streaming it.
`agents/piloti/conversation_register.py` composes these units in that order.

## What belongs here, and what does not

Ask how often it runs. **Once per request, whatever the graph decides** — a
header parse, an inventory load, a registry bind, a refusal — is a unit here.
**Once per step of the conversation, deciding what the turn is** — an escalation
edge, a clarify hop, an answer — is a graph node in `agents/piloti/`.

Each unit is a plain function with an explicit signature, so it can be tested
without standing up a NAT workflow. That is the point of the package: a
field that is written and declared by the frontend but reaches nobody fails a
test.

**The dependency runs one way.** `aiq_api` hosts this workflow; `api_seam.py`
is the only file under `aiq_agent` that may import back into it, so undoing the
inversion is a change to one file. `turn/` also imports no agent state at
runtime — `response.py` and `dispatch.py` type against it under `TYPE_CHECKING`
only.

## Obligations

| When you | You must | What fails you |
|---|---|---|
| Reach for anything in `aiq_api` | Add it to `api_seam.py` and import it from there | `tests/aiq_agent/turn/test_api_seam.py` walks every module in `turn/` and `agents/piloti/` |
| Add a wire field or a stage fact | Add it to `TurnResult` (`common/wire_v2.py`), lift it in `response.build_result`, and give it a test that reads it back | Nothing. A field nobody lifts is set, valid, and invisible |
| Add setup I/O to the turn | Gather it with the existing `asyncio.gather` and let it fail open on its own | It lands on the time-to-first-byte path in series |

## Live answer (ADR-0066)

`answer_stream.py` streams the answering call's prose while the model writes
it, as wire bodies through the graph's own writer (`turn_status.emit`, chat wire
v2 §b). The docs of record are
[`docs/design/chat-wire-v2.md`](../../../docs/design/chat-wire-v2.md) and
[`docs/design/streaming-chat-answer.md`](../../../docs/design/streaming-chat-answer.md).

- **Add the token callback to the call's inherited manager** (`streaming_call`),
  never as the call's own `callbacks`. Those replace the inherited ones, and
  NAT's profiler, which bills the call, rides on them.
- **Live bodies are provisional.** `RUN_FINISHED` is authoritative, replaces the
  text, and is what the socket persists.
- **A streamed call that turns out to ask for tools was a round, not the
  answer.** It writes `answer_retracted`, `LiveProse.streamed` resets, and a
  later call of the turn may stream again.
- **Deltas are coalesced at the producer**: at most one `TEXT_MESSAGE_CONTENT`
  per `RELAY_WINDOW_S`, and whatever is held goes out before any other body.
- **Work in a token callback heavier than parsing goes off the loop**
  (`asyncio.to_thread`, as `_settle_prose` does). The stream awaits the
  callback, so body order holds.
- **The verifier and the gates stay on the agent side**, behind the `Live`
  protocol (`answer_pipeline.LiveAnswer`). `turn/` does not import them.
- **Every generator in the turn is closed with `contextlib.aclosing`.** `async
  for` never closes what it iterates, so a consumer that walks away would leave
  the graph suspended mid-run past the ledger flush.
- **Everything fails open.** Nothing bound, an LLM that cannot stream, or a
  callback that raises, and the turn is the buffered turn it was.
