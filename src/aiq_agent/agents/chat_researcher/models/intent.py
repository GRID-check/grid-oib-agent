"""Intent classification result model."""

from typing import Any
from typing import Literal

from pydantic import BaseModel


class IntentResult(BaseModel):
    """
    Result of intent classification.

    Attributes:
        intent: Classified intent - 'meta' (greetings, chit-chat, capability or
                memory requests; routed to the assistant agent), 'research'
                (queries requiring data lookup and sources), 'out_of_scope'
                (clearly off-domain questions; the classifier emits a fixed
                redirect message and the turn ends WITHOUT invoking any answering
                agent), or 'error' (classifier-level failure; a canned message is
                already in state and the turn ends).
        raw: Optional raw classification response from the LLM.
    """

    intent: Literal["meta", "research", "out_of_scope", "error"]
    raw: dict[str, Any] | None = None
