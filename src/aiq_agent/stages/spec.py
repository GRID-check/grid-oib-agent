"""The post-answer **stage** primitive: what a stage declares, receives, returns.

A post-answer stage is a bounded, gated, independently-failing unit of work that
runs *after* a turn's answer exists, produces at most one payload addressed to
that turn, and may not affect the answer in any way. Two properties are
load-bearing:

- **The answer is already written when a stage runs.** A stage can therefore
  never delay, alter, block or fail an answer. If it can, it is not a stage.
- **A stage is addressed to a turn, not to a session.** Its output lands on one
  turn or nowhere.

This module holds only the shapes. Registration lives in :mod:`.registry`,
execution in :mod:`.runner`, and the frame channel in :mod:`.delivery`. Nothing
here knows about any individual stage — a module in this package that branches on
a stage id is a design failure, not a special case.

See docs/architecture/post-answer-stages.md.
"""

from __future__ import annotations

from collections.abc import Awaitable
from collections.abc import Callable
from dataclasses import dataclass
from dataclasses import field
from typing import Any
from typing import Literal

from pydantic import BaseModel

from aiq_agent.common.model_overrides import AgentGroup

#: Terminal states a stage run can end in. Every one of them is recorded, so
#: "how often did this stage fire, succeed, time out, or skip and why" is a
#: GROUP BY rather than an argument.
#:
#: - ``ready``    — the handler produced a payload.
#: - ``empty``    — the handler ran and deliberately produced nothing. A
#:                  first-class success: reflection's most common correct
#:                  outcome is "nothing durable here". A handler may return
#:                  :class:`StageEmpty` instead of ``None`` to say which
#:                  nothing, and the reason rides the span.
#: - ``skipped``  — the deterministic gate (or a load-shedding cap) declined
#:                  before any work started; ``reason`` says which condition.
#: - ``failed``   — the handler raised, or its payload failed validation.
#: - ``timeout``  — the handler exceeded ``StageSpec.timeout_s``.
#: - ``disabled`` — the stage's flag is off for this tenant, or no LLM is
#:                  configured for its agent group (the capability bit).
StageStatus = Literal["ready", "empty", "skipped", "failed", "timeout", "disabled"]


@dataclass(frozen=True)
class TurnFacts:
    """Everything a gate or handler may know about the finished turn.

    Frozen and request-context-free: captured by the single call site **while
    the request context is still live**, then passed explicitly, because a stage
    task outlives that context. Everything a gate needs to decide must be in
    here. If a stage wants a fact that is not present, the fact gets added to
    ``TurnFacts`` — never fetched inside the handler, where the request context
    is gone.
    """

    #: The conversation the answered turn belongs to.
    conversation_id: str | None = None
    #: The WebSocket ``user_message`` id of the answered turn — the only id both
    #: the browser and the agent tier genuinely share, and therefore the turn
    #: half of the idempotency key (see :mod:`.runner`). ``None`` off the
    #: WebSocket path (CLI, REST, job worker), where there is no turn identity.
    ws_parent_id: str | None = None
    organization_id: str | None = None
    project_id: str | None = None
    user_id: str | None = None

    #: The user's question and the delivered answer, verbatim. A handler that
    #: needs them bounded slices them itself — the caps differ per stage.
    query: str = ""
    answer: str = ""
    #: The project-memory digest the agent actually saw this turn.
    memory_digest: str | None = None
    bundesland: str | None = None

    #: Classified user intent (``research`` / ``meta`` / ``error`` / …).
    intent: str | None = None
    #: The derived routing decision surfaced on the answer (WP-A transparency).
    routing_decision: str | None = None
    #: The research loop hit its tool-iteration ceiling: the turn ran out of
    #: budget before it ran out of question.
    research_truncated: bool = False
    #: Set when the chat turn is only a stub for an async deep-research job.
    deep_research_job_id: str | None = None
    #: Card types the model emitted in-turn, so a stage can decline to duplicate
    #: something the reader already has.
    emitted_card_types: frozenset[str] = frozenset()
    #: The model's guarded self-assessment of answer grounding, when present.
    answer_confidence: str | None = None

    #: Stage ids enabled for this tenant on THIS turn (flag ∧ capability is
    #: resolved per stage in the runner). ``None`` means "unknown" and is
    #: treated as nothing enabled — fail-closed, exactly as the individual
    #: feature-flag header is read.
    enabled_stages: frozenset[str] | None = None

    def stage_enabled(self, stage_id: str) -> bool:
        """Whether ``stage_id``'s flag is on for this turn. Fails closed."""
        return bool(self.enabled_stages) and stage_id in self.enabled_stages

    @property
    def turn_key(self) -> tuple[str, str] | None:
        """The ``(conversation_id, ws_parent_id)`` pair that identifies the turn.

        ``None`` when either half is missing — there is then no turn identity to
        be idempotent against, and the runner says so rather than inventing one
        that would collapse every turn of a conversation onto the same key.
        """
        if not self.conversation_id or not self.ws_parent_id:
            return None
        return (self.conversation_id, self.ws_parent_id)


@dataclass(frozen=True)
class StageContext:
    """What a handler receives: the turn's facts plus its resolved LLM.

    The LLM has already been through the org's model override and the ADR-0022
    BYOK credential swap, applied at schedule time while the request context was
    live. The handler is given **no reference to the response object**: it cannot
    mutate the answer even if it tries.
    """

    facts: TurnFacts
    llm: Any


@dataclass(frozen=True)
class StageEmpty:
    """A deliberate "nothing" that names *which* nothing it was.

    A handler may return ``None`` for the plain case, but "nothing" is rarely one
    fact. A follow-ups handler that gets no questions back from the model and one
    that gets four unusable ones have produced the same absence for opposite
    reasons: the first says the gate let through a turn the model saw nothing in,
    the second says the prompt is not landing. Collapsing them into one
    ``empty`` bucket makes the number the stage exists to produce unreadable, so
    a handler may name the case and the runner puts the name on the span next to
    the outcome.

    Not a status: ``empty`` stays a first-class *success* on the wire, and the
    reason is telemetry, never something a client reads.
    """

    #: A machine key, never prose — it is grouped on, not read.
    reason: str

    def __post_init__(self) -> None:
        if not self.reason:
            raise ValueError("StageEmpty requires a machine-readable reason")


@dataclass(frozen=True)
class GateDecision:
    """A deterministic gate's verdict. Never an LLM's opinion."""

    run: bool
    #: A machine key, never prose — it is grouped on, not read.
    reason: str | None = None

    @classmethod
    def proceed(cls) -> GateDecision:
        return cls(run=True)

    @classmethod
    def skip(cls, reason: str) -> GateDecision:
        """Decline, naming the condition that declined. The reason is required:
        a gate's own correctness is then measurable rather than assumed."""
        if not reason:
            raise ValueError("GateDecision.skip requires a machine-readable reason")
        return cls(run=False, reason=reason)


@dataclass(frozen=True)
class StageOutcome:
    """One terminal record per stage per turn — including the runs that did not
    happen, which is exactly the data that makes the gate falsifiable."""

    stage_id: str
    status: StageStatus
    #: Required for ``skipped``/``failed``/``disabled``; optional on
    #: ``empty``, where it names which "nothing" this was. A machine key.
    reason: str | None = None
    #: Only when ``status == "ready"``.
    payload: dict[str, Any] | None = None
    duration_ms: int = 0

    def __post_init__(self) -> None:
        if self.status in {"skipped", "failed", "disabled"} and not self.reason:
            raise ValueError(f"a {self.status!r} outcome must name a reason")
        if self.status != "ready" and self.payload is not None:
            raise ValueError("only a 'ready' outcome may carry a payload")


@dataclass(frozen=True)
class StageSpec:
    """One stage, declared once. Adding a stage is a declaration and a handler.

    ``timeout_s`` has **no default**: a stage without a hard bound is the defect
    this primitive exists to close (memory reflection ran with the provider's
    120s × 2 retries as its only limit, holding a concurrency slot for minutes),
    so the declaration is forced to state one.
    """

    #: Stable wire identity, e.g. ``"memory_reflection"``.
    id: str
    #: The existing model-selection group — reused, not re-invented, so a stage
    #: inherits Platform → Models defaults, the org override and the ADR-0022
    #: BYOK credential swap by construction.
    agent_group: AgentGroup
    #: WorkOS flag slug gating the stage per organization.
    flag_slug: str
    #: Env var consulted when flag enforcement is off.
    env_default: str
    #: HARD ``asyncio.wait_for`` bound on the whole handler.
    timeout_s: float
    #: Deterministic, LLM-free predicate over :class:`TurnFacts`.
    gate: Callable[[TurnFacts], GateDecision]
    #: Returns the payload, ``None`` for a plain "nothing", or
    #: :class:`StageEmpty` to name which nothing it was.
    handler: Callable[[StageContext], Awaitable[dict[str, Any] | StageEmpty | None]]
    #: Validated before the outcome is recorded or anything is delivered.
    payload_model: type[BaseModel] | None
    #: ``"frame"`` pushes a frame to the browser; ``"silent"`` stages write
    #: their own durable state and tell nobody.
    delivery: Literal["frame", "silent"]
    #: Output-token ceiling bound onto the stage's LLM, or ``None`` when the
    #: configured model's own ceiling is the bound. Explicit either way: a stage
    #: author has to make the call rather than inherit a default.
    max_output_tokens: int | None
    #: Free-form notes for the registry listing; never read by the runner.
    tags: frozenset[str] = field(default_factory=frozenset)

    def __post_init__(self) -> None:
        if not self.id:
            raise ValueError("a StageSpec needs a stable id")
        if not self.timeout_s or self.timeout_s <= 0:
            raise ValueError(f"stage {self.id!r} must declare a positive timeout_s")
        if self.max_output_tokens is not None and self.max_output_tokens <= 0:
            raise ValueError(f"stage {self.id!r} declared a non-positive max_output_tokens")
