# Project memory: `src/aiq_agent/memory`

The two agent-side writers of a project's durable findings: the in-turn
`remember` tool (`register.py`) and the body of the post-answer reflection pass
(`reflection.py`). Not an agent — one NAT tool and one stage handler.

Do not confuse it with `aiq_agent/knowledge/project_memory.py`, which is the
HTTP client both use, or with `aiq_agent/stages/memory_reflection.py`, which
declares when the stage runs. This package holds only what a memory *is*.

## The invariants

**The backend never writes the app database.** Every write goes through the
token-guarded internal BFF endpoint, so `grid_app` stays single-writer
(ADR-0003). A new write path is a new call to that endpoint, not a new
connection.

**Reflection writes project scope only.** The tool may escalate a scopeless
project write to the organization; reflection never does. A wrong firm-wide
finding poisons every project in the org, and no human saw this one.

**A supersede must quote one COMPLETE entry of the digest the model was
shown.** The frontend resolves supersedes fuzzily (≥0.7 Jaccard), so a
truncated or paraphrased quote would retire an entry nobody named. Reflection
drops the quote and keeps the finding.

## Obligations

| When you | You must | What fails you |
|---|---|---|
| Add a reason a finding is dropped | Drop it in `_finding_from_entry`, before the `MAX_NEW_ITEMS` slice | A rejected finding eats a slot, and the pass records fewer than it found |
| Change what the tool returns to the model | Say plainly whether the item was saved; a card shown is not a write | The model tells the reader it remembered something that was never stored |
| Change the reflection prompt or schema | Run `tests/aiq_agent/memory/test_reflection.py`; the prompt and `_ReflectionFinding` must name the same fields | The pass parses nothing and silently records zero findings |
