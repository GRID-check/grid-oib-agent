"""The per-turn ceiling on ``view_knowledge_image`` calls.

What matters: a bound budget refuses the (N+1)-th view, a turn's budget is
invisible to a sibling context, and an unbound call site is not capped —
the cap is per turn, and a module-level fallback would be the leak the
ContextVar exists to prevent.
"""

from __future__ import annotations

import asyncio
import contextvars

from aiq_agent.common.image_view_budget import MAX_IMAGE_VIEWS_PER_TURN
from aiq_agent.common.image_view_budget import begin_image_view_budget
from aiq_agent.common.image_view_budget import end_image_view_budget
from aiq_agent.common.image_view_budget import get_image_view_budget
from aiq_agent.common.image_view_budget import try_consume_image_view


def test_refuses_the_view_past_the_cap_and_recovers_at_turn_end():
    token = begin_image_view_budget()
    try:
        assert [try_consume_image_view() for _ in range(MAX_IMAGE_VIEWS_PER_TURN)] == [True] * MAX_IMAGE_VIEWS_PER_TURN
        assert try_consume_image_view() is False
        assert get_image_view_budget().remaining == 0
    finally:
        end_image_view_budget(token)
    assert get_image_view_budget() is None
    assert try_consume_image_view() is True  # unbound: not capped


def test_a_custom_limit_is_honoured():
    token = begin_image_view_budget(limit=1)
    try:
        assert try_consume_image_view() is True
        assert try_consume_image_view() is False
    finally:
        end_image_view_budget(token)


def test_budgets_do_not_leak_between_contexts():
    """Two turns in flight at once each spend their own budget."""

    async def turn(limit: int) -> int:
        token = begin_image_view_budget(limit=limit)
        try:
            await asyncio.sleep(0)
            return sum(1 for _ in range(10) if try_consume_image_view())
        finally:
            end_image_view_budget(token)

    async def both() -> tuple[int, int]:
        return await asyncio.gather(turn(2), turn(5))

    assert asyncio.run(both()) == [2, 5]

    # A copied context sees the budget; the parent stays unbound.
    token = begin_image_view_budget(limit=1)
    try:
        ctx = contextvars.copy_context()
        assert ctx.run(try_consume_image_view) is True
        assert ctx.run(try_consume_image_view) is False
    finally:
        end_image_view_budget(token)
    assert get_image_view_budget() is None
