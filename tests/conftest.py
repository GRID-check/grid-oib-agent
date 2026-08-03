"""Shared fixtures for the backend test suite."""

from __future__ import annotations

import logging

import pytest

logger = logging.getLogger(__name__)

try:  # pragma: no cover - import guard, not behaviour
    from aiq_agent.common.cache import reset_local_store
except Exception:  # pragma: no cover - only when the agent package is unusable
    reset_local_store = None
    logger.warning("Shared-cache isolation disabled: aiq_agent.common.cache is not importable", exc_info=True)


@pytest.fixture(autouse=True)
def _isolate_shared_cache():
    """Reset the shared cache around every test.

    The ingest pipeline reads/writes the fail-open shared cache
    (``aiq_agent.common.cache``, ADR-0020) — notably the content-hash VLM
    caption cache. Its in-process fallback store (``REDIS_URL`` unset, which is
    how the suite runs) is a module global, so without this a caption produced
    by one test is served to the next whenever the two feed the VLM identical
    image bytes: the second test's stubbed VLM is never called and it asserts
    against the first test's caption. Mirrors
    ``sources/ris_adapter/tests/conftest.py``. No-op on a real Redis backend.
    """
    if reset_local_store is None:
        yield
        return
    reset_local_store()
    yield
    reset_local_store()
