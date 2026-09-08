"""Result models for chat research agent."""

from pydantic import BaseModel


class ShallowResult(BaseModel):
    """The shallow agent's structured verdict on its own turn.

    Set only on the error and escalation branches of the shallow node; the
    normal success path leaves ``shallow_result`` as ``None`` entirely, so
    ``escalate_to_deep`` is the one bit the graph's escalation edge reads.
    Named in the checkpointer serde allow-list (``aiq_agent.common``).

    Attributes:
        answer: The answer text (or the error text) the verdict is about.
        escalate_to_deep: Whether this turn asked for deep research.
        escalation_reason: The model's own clause for why, when it asked.
    """

    answer: str
    escalate_to_deep: bool
    escalation_reason: str | None = None
