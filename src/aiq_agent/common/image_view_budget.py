"""Per-turn ceiling on ``view_knowledge_image`` calls.

Every call hands the model one image block: a page render or a stored
raster, base64-encoded, on the order of a few hundred kilobytes of context
and one vision-model input. A model that decides to "look at every figure"
in a plan set — or loops on a tool result it cannot parse — would otherwise
spend the turn's whole budget on images. The card registry's problem, in
another shape: something per-turn that a tool must see and that must not
leak into the next turn or another tenant, so it is the same ContextVar
pattern (:mod:`aiq_agent.cards.registry`).

The chat entrypoint binds a budget around each turn. A call site with no
budget bound (CLI, batch, tests) is not capped: an unbound default would
have to live at module level, and that is exactly the state that leaks
across turns.
"""

from __future__ import annotations

import contextvars

#: How many images one turn may ask to see. Six covers a question that needs a
#: plan, its section and a detail with room to re-look; past that the model
#: is browsing, not answering.
MAX_IMAGE_VIEWS_PER_TURN = 6


class ImageViewBudget:
    """Counts image views against a fixed limit for one turn."""

    def __init__(self, limit: int = MAX_IMAGE_VIEWS_PER_TURN) -> None:
        self.limit = limit
        self.used = 0

    @property
    def remaining(self) -> int:
        return max(0, self.limit - self.used)

    def try_consume(self) -> bool:
        """Take one view if any remain; ``False`` when the turn is spent."""
        if self.used >= self.limit:
            return False
        self.used += 1
        return True


_budget_var: contextvars.ContextVar[ImageViewBudget | None] = contextvars.ContextVar("_image_view_budget", default=None)


def begin_image_view_budget(limit: int = MAX_IMAGE_VIEWS_PER_TURN) -> contextvars.Token:
    """Bind a fresh budget for the current turn; pair with :func:`end_image_view_budget`."""
    return _budget_var.set(ImageViewBudget(limit))


def end_image_view_budget(token: contextvars.Token) -> None:
    """Restore whatever was bound before :func:`begin_image_view_budget`."""
    _budget_var.reset(token)


def get_image_view_budget() -> ImageViewBudget | None:
    """The budget bound to the current turn, or ``None`` outside one."""
    return _budget_var.get()


def try_consume_image_view() -> bool:
    """Take one view from the turn's budget; always ``True`` when none is bound."""
    budget = _budget_var.get()
    return True if budget is None else budget.try_consume()
