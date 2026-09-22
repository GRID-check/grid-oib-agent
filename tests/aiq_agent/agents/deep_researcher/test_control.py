"""„Jetzt schreiben": the reader's one lever over a running deep research."""

import asyncio

from aiq_agent.agents.deep_researcher.control import bind_write_now
from aiq_agent.agents.deep_researcher.control import reset_write_now
from aiq_agent.agents.deep_researcher.control import write_now_requested
from aiq_agent.agents.deep_researcher.finalize import _prepend_honesty_banner
from aiq_agent.common.turn_status import CUTOFF_USER_REQUESTED


def test_nothing_bound_means_nothing_requested():
    assert write_now_requested() is False


def test_the_bound_signal_is_read_and_the_binding_is_per_run():
    signal = asyncio.Event()
    token = bind_write_now(signal)
    try:
        assert write_now_requested() is False
        signal.set()
        assert write_now_requested() is True
    finally:
        reset_write_now(token)
    assert write_now_requested() is False


def test_the_banner_names_the_readers_choice_not_a_limit():
    line = _prepend_honesty_banner(
        "# Bericht", cutoff_reason=CUTOFF_USER_REQUESTED, degraded_reasons=None
    ).splitlines()[0]
    assert "auf Ihren Wunsch" in line and "unvollständig" in line
    english = _prepend_honesty_banner(
        "# Report\n\nThe escape route is compliant and the fire resistance is REI 60.",
        cutoff_reason=CUTOFF_USER_REQUESTED,
        degraded_reasons=None,
    ).splitlines()[0]
    assert "at your request" in english
