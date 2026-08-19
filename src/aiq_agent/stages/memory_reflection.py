"""Memory reflection, declared as a post-answer stage.

This is the migration of the bespoke block that used to sit inline in
``chat_researcher/register.py`` (schedule + gate) and in
``project_memory/reflection.schedule_memory_reflection`` (semaphore, pending cap,
cost/profile tracking). **What it does is unchanged** — the same predicate, the
same prompt, the same writes through the same token-guarded endpoint. What
changed is how it is wired and bounded:

- it now runs under a **hard 45s timeout**. Before, the only bound was the
  provider's ``request_timeout: 120`` with ``max_retries: 2`` — nearly six
  minutes holding one of four concurrency slots, i.e. one stalled provider
  silently disabled reflection for the whole replica;
- the gate now reads ``research_truncated``. A turn cut off at its
  tool-iteration ceiling produces a substantive-looking answer, and reflection
  was distilling durable project memory out of evidence-gathering that had been
  interrupted;
- every terminal state — including "the gate declined, and here is which
  condition declined" — emits a span.

See docs/architecture/post-answer-stages.md and
docs/architecture/project-memory-design.md.
"""

from __future__ import annotations

import logging
from typing import Any

from pydantic import BaseModel
from pydantic import Field

from aiq_agent.common.model_overrides import AgentGroup
from aiq_agent.stages.registry import register_stage
from aiq_agent.stages.spec import GateDecision
from aiq_agent.stages.spec import StageContext
from aiq_agent.stages.spec import StageSpec
from aiq_agent.stages.spec import TurnFacts

logger = logging.getLogger(__name__)

#: Canned error/empty answers that must never be reflected on. Moved verbatim
#: from ``chat_researcher/register.py``.
REFLECTION_NON_ANSWERS = (
    "No response generated.",
    "An error occurred",
    "The search tools did not return any results",
    "I searched the available sources but couldn't retrieve anything usable",
)

#: Intents with nothing durable to record: reflecting on them only risks
#: spurious writes.
_SKIP_INTENTS = {"meta", "error", "out_of_scope"}

#: A generous bound, not a tuning knob. Reflection is one structured-output call
#: over a turn that is already sliced to ~6k characters of prompt; 45s covers a
#: slow provider and still frees the concurrency slot long before a stall could
#: disable the stage for the replica.
REFLECTION_TIMEOUT_S = 45.0


class MemoryReflectionPayload(BaseModel):
    """What the stage produced: the ids of the memory items it wrote.

    The DB write stays the source of truth — this payload is a notification of
    what happened, never a transfer of authority. ``grid_app`` stays
    single-writer.
    """

    item_ids: list[str] = Field(default_factory=list, description="Ids of the project_memory rows written.")


def _gate(facts: TurnFacts) -> GateDecision:
    """The existing predicate, moved verbatim, plus the truncation skip.

    Deterministic Python over facts the backend already has — never a model's
    opinion about its own answer. Each failed condition names itself, so the
    gate's own correctness is measurable rather than assumed.
    """
    from aiq_agent.agents.chat_researcher.agent import matches_escalation_keywords

    if facts.deep_research_job_id:
        # The chat turn is only a stub; the report path reflects on the worker
        # once the report exists.
        return GateDecision.skip("deep_research_job")
    if not facts.project_id:
        # The autonomous stage writes project-scoped memory ONLY (audit S1), so
        # an org-only conversation has nothing it may safely write.
        return GateDecision.skip("no_project")
    text = (facts.answer or "").strip()
    if not facts.query or not text:
        return GateDecision.skip("empty_turn")
    if facts.research_truncated:
        # The turn ran out of budget before it ran out of question. Distilling
        # durable memory from interrupted evidence-gathering is memory rot with
        # a plausible surface.
        return GateDecision.skip("research_truncated")
    if any(text.startswith(prefix) for prefix in REFLECTION_NON_ANSWERS):
        return GateDecision.skip("canned_non_answer")
    if matches_escalation_keywords(text):
        return GateDecision.skip("escalation")
    if facts.intent in _SKIP_INTENTS:
        return GateDecision.skip(f"intent_{facts.intent}")
    return GateDecision.proceed()


async def _handler(ctx: StageContext) -> dict[str, Any] | None:
    """One reflection pass. ``None`` when the turn established nothing durable —
    the common, correct outcome, recorded as ``empty`` rather than invented into
    a payload."""
    from aiq_agent.agents.project_memory.reflection import run_memory_reflection

    facts = ctx.facts
    recorded = await run_memory_reflection(
        llm=ctx.llm,
        query=facts.query,
        answer=facts.answer,
        project_id=facts.project_id,
        organization_id=facts.organization_id,
        conversation_id=facts.conversation_id,
        memory_digest=facts.memory_digest,
    )
    if not recorded:
        return None
    return {"item_ids": list(recorded)}


MEMORY_REFLECTION = register_stage(
    StageSpec(
        id="memory_reflection",
        agent_group=AgentGroup.MEMORY_REFLECTION,
        # Unchanged from the pre-stage wiring: this migration is not a
        # user-visible change, so the flag that governed it still does.
        flag_slug="memory-reflection",
        env_default="GRID_MEMORY_REFLECTION_ENABLED",
        timeout_s=REFLECTION_TIMEOUT_S,
        gate=_gate,
        handler=_handler,
        payload_model=MemoryReflectionPayload,
        # The write to project_memory IS the delivery. A frame telling the
        # browser what was written is a later slice; it retires the per-answer
        # poll, which is a frontend change, not this one.
        delivery="silent",
        # Deliberately unbound HERE. The configured model already caps output
        # (``card_llm.max_tokens``), and the model runs with reasoning enabled —
        # reasoning tokens count against that ceiling, so a tighter cap set by
        # this migration would truncate the response and silently turn a working
        # stage into one that writes nothing. The cost bound that matters for
        # reflection is the input side, which is already sliced
        # (``_MAX_ANSWER_CHARS`` / ``_MAX_QUERY_CHARS`` / ``_MAX_DIGEST_CHARS``),
        # plus ``timeout_s`` above.
        max_output_tokens=None,
    )
)
