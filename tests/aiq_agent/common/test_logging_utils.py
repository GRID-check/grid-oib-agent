"""Tests for targeted dependency-logger quieting."""

import logging

from aiq_agent.common.logging_utils import suppress_noisy_dependency_logs


def test_step_manager_warnings_are_suppressed_but_errors_kept():
    lg = logging.getLogger("nat.builder.intermediate_step_manager")
    original_level = lg.level
    try:
        suppress_noisy_dependency_logs()
        assert not lg.isEnabledFor(logging.WARNING)
        assert lg.isEnabledFor(logging.ERROR)
        # Idempotent.
        suppress_noisy_dependency_logs()
        assert lg.level == logging.ERROR
    finally:
        lg.setLevel(original_level)
