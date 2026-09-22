"""The banner on a cut-off report names the cause, not a taxonomy."""

from aiq_agent.agents.deep_researcher.agent import _prepend_honesty_banner
from aiq_agent.common.turn_status import CUTOFF_STEP_LIMIT
from aiq_agent.common.turn_status import CUTOFF_UPSTREAM_TIMEOUT
from aiq_agent.common.turn_status import CUTOFF_WALL_CLOCK


def _banner(reason: str) -> str:
    return _prepend_honesty_banner("# Bericht", cutoff_reason=reason, degraded_reasons=None).splitlines()[0]


def test_the_wall_clock_is_a_time_limit():
    assert "wegen des erreichten Zeitlimits" in _banner(CUTOFF_WALL_CLOCK)


def test_the_step_limit_is_a_step_limit():
    assert "wegen des erreichten Schritt-Limits" in _banner(CUTOFF_STEP_LIMIT)


def test_a_source_that_did_not_answer_is_not_called_a_time_limit():
    """Readers asked for a longer budget on runs that died in three minutes,
    because a source's silence was labelled as the run's clock."""
    line = _banner(CUTOFF_UPSTREAM_TIMEOUT)

    assert "Quelle nicht rechtzeitig geantwortet" in line
    assert "Zeitlimit" not in line


def test_an_unknown_reason_still_says_the_report_is_partial():
    assert "unvollständig" in _banner("quota_exhausted")
