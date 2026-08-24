"""Shared fixtures for the RIS adapter tests."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _isolate_shared_cache():
    """Reset the shared cache around every test.

    ``ris_search`` / ``ris_fetch_document`` now read/write the fail-open shared
    cache (``aiq_agent.common.cache``, ADR-0020). Its in-process fallback store
    is a module global, so without this a document/search cached in one test
    would be served in the next. No-op when the agent package is absent (the
    adapter used standalone), where the cache is a safe no-op anyway.
    """
    try:
        from aiq_agent.common.cache import reset_local_store
    except Exception:
        yield
        return
    reset_local_store()
    yield
    reset_local_store()
