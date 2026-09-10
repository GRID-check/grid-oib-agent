# The per-turn harness: `src/aiq_agent/turn`

Everything that happens exactly once per chat turn and is **not** the answering
agent: parsing what the request says about the turn, loading its context and
document inventory, binding the per-turn registries, admitting it against
capacity and budget, lifting the finished state onto the wire, streaming it.
`agents/researcher/conversation_register.py` composes these units in that order.

## What belongs here, and what does not

Ask how often it runs. **Once per request, whatever the graph decides** — a
header parse, an inventory load, a registry bind, a refusal — is a unit here.
**Once per step of the conversation, deciding what the turn is** — an escalation
edge, a clarify hop, an answer — is a graph node in `agents/researcher/`.

Each unit is a plain function with an explicit signature, so it can be tested
without standing up a NAT workflow. That is the point of the package: the
harness used to be one closure, and a field could be written, declared by the
frontend and reach nobody without a single test noticing.

**The dependency runs one way.** `aiq_api` hosts this workflow; `api_seam.py`
is the only file under `aiq_agent` that may import back into it, so undoing the
inversion is a change to one file. `turn/` also imports no agent state at
runtime — `response.py` and `dispatch.py` type against it under `TYPE_CHECKING`
only.

## Obligations

| When you | You must | What fails you |
|---|---|---|
| Reach for anything in `aiq_api` | Add it to `api_seam.py` and import it from there | `tests/aiq_agent/turn/test_api_seam.py` walks every module in `turn/` and `agents/researcher/` |
| Add a wire field or a stage fact | Add it to the table in `response.py` and give it a test that reads it back | Nothing. A field nobody lifts is set, valid, and invisible |
| Add setup I/O to the turn | Gather it with the existing `asyncio.gather` and let it fail open on its own | It lands on the time-to-first-byte path in series |
