"""The running turn's clock on its conversation marker (ADR-0080, "the owner fences itself")."""

from __future__ import annotations

import pytest

from aiq_api import turn_fence
from aiq_api.turn_fence import TurnFence
from aiq_api.turn_fence import fence_margin
from aiq_api.turn_fence import validate_running_ttl


class Clock:
    def __init__(self, now: float = 100.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


def _fence(clock: Clock, *, acquired_at: float = 100.0, ttl: float = 12.0) -> TurnFence:
    return TurnFence(acquired_at=acquired_at, ttl=ttl, clock=clock)


def test_the_margin_is_one_guarded_write_plus_slack():
    assert fence_margin() == turn_fence.GUARDED_WRITE_TIMEOUT_SECONDS + turn_fence.FENCE_SLACK_SECONDS


def test_the_deadline_is_the_acquire_time_plus_the_ttl_minus_the_margin():
    clock = Clock()
    fence = _fence(clock)

    assert fence.deadline == pytest.approx(100.0 + 12.0 - fence_margin())
    assert fence.remaining() == pytest.approx(12.0 - fence_margin())


def test_the_check_reads_the_clock_itself_so_no_task_has_to_have_run():
    clock = Clock()
    fence = _fence(clock)
    clock.now = fence.deadline - 0.001
    assert not fence.fenced()

    clock.now = fence.deadline  # nothing renewed, nothing cancelled, nothing flagged: the clock alone answers
    assert fence.fenced()


def test_a_renewal_counts_from_when_it_was_sent_not_when_the_answer_came_back():
    clock = Clock()
    fence = _fence(clock)
    clock.now = 103.0
    sent_at = clock.now
    clock.now = 104.0  # the answer took a second

    assert fence.renewed(sent_at)
    assert fence.deadline == pytest.approx(sent_at + 12.0 - fence_margin())


def test_a_renewal_never_moves_the_deadline_back():
    clock = Clock()
    fence = _fence(clock)
    fence.renewed(105.0)
    later = fence.deadline

    fence.renewed(101.0)  # a slow answer to an older command

    assert fence.deadline == later


def test_a_fence_that_closed_stays_closed_though_a_renewal_arrives_late():
    clock = Clock()
    fence = _fence(clock)
    clock.now = fence.deadline + 0.5
    assert fence.fenced()

    assert not fence.renewed(clock.now)
    assert fence.fenced()


def test_a_lost_marker_closes_the_fence_at_once():
    fence = _fence(Clock())
    fence.trip("its running marker is gone")

    assert fence.fenced()


def test_a_turn_that_ended_on_its_own_is_no_longer_fenced_by_the_clock_but_a_closed_fence_stays_closed():
    clock = Clock()
    ended = _fence(clock)
    ended.release()
    clock.now = ended.deadline + 60

    closed = _fence(Clock())
    closed.trip("lost")
    closed.release()

    assert not ended.fenced()  # the stage frames behind its terminal are not refused for the old deadline
    assert closed.fenced()


def test_a_ttl_the_margin_does_not_fit_in_is_refused():
    with pytest.raises(ValueError, match="GRID_CHAT_RUNNING_TTL_SECONDS"):
        validate_running_ttl(fence_margin())
    with pytest.raises(ValueError, match="fenced as it starts"):
        _fence(Clock(), ttl=fence_margin() - 1)
    assert validate_running_ttl(fence_margin() + 0.1) == fence_margin() + 0.1


def test_the_default_ttl_leaves_a_window_longer_than_a_renewal_interval():
    """The shipped defaults, not a test's: a blip of a couple of renewal rounds must not cancel an answer."""
    from aiq_api import chat_socket
    from aiq_api import conversation_bus

    ttl = conversation_bus.RUNNING_TTL_SECONDS
    window = ttl - fence_margin()
    assert window >= 2 * (ttl / 4)  # at least two renewal rounds fit before the deadline
    assert ttl < chat_socket.SUPERSEDE_WAIT_SECONDS < 15  # a dead owner never costs a refusal, and the client hears it
