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
  condition declined" — emits a span;
- it delivers a **frame** as well as writing its rows (slice 4b). The write is
  still the durable act and still the source of truth; the frame tells the turn
  that caused it what was written, which is what let the per-answer memory poll
  be deleted rather than merely reduced (§5.1, §1.7).

See docs/architecture/post-answer-stages.md and
docs/architecture/project-memory-design.md.
"""

from __future__ import annotations

import logging
from typing import Any

from pydantic import BaseModel
from pydantic import Field

from aiq_agent.cards.models import MemoryProposalCard
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

#: Paths with nothing durable to record: a direct reply (greeting, shelf
#: listing, off-topic decline) or an error. Reflecting on them only risks
#: spurious writes.
_SKIP_ROUTES = {"meta", "error"}

#: A generous bound, not a tuning knob. Reflection is one structured-output call
#: over a turn that is already sliced to ~6k characters of prompt; 45s covers a
#: slow provider and still frees the concurrency slot long before a stall could
#: disable the stage for the replica.
REFLECTION_TIMEOUT_S = 45.0


class MemoryReflectionItem(BaseModel):
    """One ``project_memory`` row this stage wrote, as the reader sees it.

    ``content`` rides along and not just the id, because the surface this
    payload feeds — the „Piloti hat sich gemerkt" chip — renders the item's own
    words. Sending ids alone would make the browser ask the database for text
    the writer already had in hand, which is the round trip §5.1 is removing.
    """

    id: str = Field(description="Id of the project_memory row.")
    kind: str = Field(description="decision | constraint | open_question | derived_fact | preference.")
    content: str = Field(description="The finding, verbatim as it was written.")


class MemoryReflectionPayload(BaseModel):
    """What the stage produced: what it WROTE, and what it can only PROPOSE.

    The DB write stays the source of truth — this payload is a notification of
    what happened, never a transfer of authority. ``grid_app`` stays
    single-writer, and a client may not create, edit or delete an item through
    this channel; it only learns that one exists.

    ``items`` are rows that exist. ``proposals`` are ``memory_proposal`` cards
    for which NOTHING was written: an organisation-scoped finding the BFF
    refused because the acting user does not hold ``org:memory:write``, which is
    the human review ADR-0055 makes the office's writer out of. Two fields and
    not one flagged list, because the distinction is the whole point — a client
    that rendered a proposal as a write would claim a firm-wide note that does
    not exist.

    ``proposals`` is absent rather than empty when there are none, the rule this
    whole envelope follows (§4.1): an absent key and a null are the same fact and
    only one of them is the contract.

    There is no ``empty`` payload: a turn that established nothing durable is a
    ``StageEmpty``, so neither list on the wire is ever empty.
    """

    items: list[MemoryReflectionItem] = Field(description="The project_memory rows written, in write order.")
    proposals: list[MemoryProposalCard] | None = Field(
        default=None,
        description="memory_proposal cards awaiting a person's acceptance. NOTHING was written for these.",
    )


# ── KNOWN DEBT: the client half of `proposals` (ADR-0055, contract C6) ────────
#
# The producer half is complete and the shape is in the shared wire contract
# (`shared/stages/frames.json`, `memory_reflection.ready`), which both halves
# read. The CLIENT half is not, and until it lands a proposal reaches the
# browser and is dropped there rather than rendered. Recorded here, at the field
# that produces it, rather than as a log line — the pattern
# `docs/architecture/adding-a-shareable-resource-type.md` uses for a known leak.
#
# Two edits, in files this track does not own:
#
# 1. `frontends/ui/src/lib/conversations/message-stages.ts` —
#    `sanitizeMemoryReflectionStage` returns `null` unless `items` holds at least
#    one usable row, so a proposals-only payload is discarded whole. It needs to
#    read `proposals` through the card sanitiser the same way the turn's own
#    cards are read, store them on `StoredMemoryReflectionStage`, and return a
#    stage object when EITHER list survives.
# 2. `frontends/ui/src/features/chat/lib/turn-memory.ts` — it already renders a
#    `memory_proposal` card as one of the two things the "Piloti hat sich
#    gemerkt" chip is made of; it reads them off the turn's CARDS. It needs to
#    merge `message.stages.memoryReflection.proposals` into that same list, so a
#    proposal made after the answer is the same offer as one made during it.
#
# Nothing about the producer changes when they land: the frame is already the
# shape the fixture pins. Until then an office finding is proposed, delivered,
# and seen by nobody — which is a gap in the reader's surface, never a write.


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
    if not facts.project_id and not facts.organization_id:
        # Nothing to write to and nothing to propose for. This used to read
        # `not facts.project_id` and skip every office turn, because the stage
        # could only write project-scoped memory (audit S1) — the objection
        # ADR-0054's gate and ADR-0055's proposal card together answered. An
        # office turn now produces PROPOSALS: nothing is written, and a person
        # who may set firm-wide memory decides. A turn with neither id is
        # anonymous and is still the one shape with no target at all.
        return GateDecision.skip("no_target")
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
    if facts.routing_decision in _SKIP_ROUTES:
        return GateDecision.skip(f"routing_{facts.routing_decision}")
    return GateDecision.proceed()


def digest_with_turn_writes(memory_digest: str | None, written: tuple[str, ...]) -> str | None:
    """The digest the agent saw, plus what the ``remember`` tool wrote after it.

    Rendered in the digest's own line grammar, so the reflection prompt shows
    them as existing memory and the "already in the digest" filter drops a
    finding that restates one — the tool and the stage no longer write the
    same fact twice within one turn.
    """
    if not written:
        return memory_digest
    lines = [f'- [this turn | recorded] "{content.replace(chr(34), chr(39))}"' for content in written]
    return "\n".join(([memory_digest.rstrip()] if memory_digest else []) + lines)


async def _handler(ctx: StageContext) -> dict[str, Any] | None:
    """One reflection pass. ``None`` when the turn established nothing durable —
    the common, correct outcome, recorded as ``empty`` rather than invented into
    a payload.

    A pass that only PROPOSED is still ``ready``: nothing was written, and the
    offer is the thing the reader has to see.
    """
    from aiq_agent.agents.project_memory.reflection import run_memory_reflection

    facts = ctx.facts
    outcome = await run_memory_reflection(
        llm=ctx.llm,
        query=facts.query,
        answer=facts.answer,
        project_id=facts.project_id,
        organization_id=facts.organization_id,
        conversation_id=facts.conversation_id,
        memory_digest=digest_with_turn_writes(facts.memory_digest, facts.remembered_this_turn),
        # WHO the answered turn ran for. Read on the organisation branch alone,
        # where a proposal is authorized as that person rather than as the
        # service token (ADR-0055, contract C6).
        user_id=facts.user_id,
        organization_membership_id=facts.organization_membership_id,
    )
    if not outcome:
        # `None` is `empty` — the common, correct outcome for a turn that
        # established nothing durable, and a first-class success rather than a
        # failure to invent output.
        return None
    payload: dict[str, Any] = {"items": [dict(item) for item in outcome.recorded]}
    if outcome.proposed:
        # Absent unless applicable, like every other optional key on this wire.
        payload["proposals"] = [dict(card) for card in outcome.proposed]
    return payload


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
        # BOTH, and in that order: the write to project_memory is the durable
        # act and stays the source of truth, and the frame is a notification of
        # it addressed to the turn that caused it.
        #
        # The frame is what retires the poll. Before it, the only way a reader
        # learned that reflection had written anything was a three-shot HTTP
        # poll on a fixed `[0, 1500, 4000]` ms schedule — a guess about how long
        # an LLM takes, made by the half of the system that cannot know, and
        # mounted once per RENDERED ANSWER, so a ten-answer thread fired thirty
        # GETs for one conversation's memory (§1.7). The stage knows exactly
        # when it finished and exactly what it wrote; saying so costs one frame.
        delivery="frame",
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
