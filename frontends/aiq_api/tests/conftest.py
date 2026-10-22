"""Register a lightweight ``aiq_api`` package before submodule imports.

Skips ``aiq_api/__init__.py`` (plugin pulls NAT) so tests can load
``aiq_api.auth`` and peers from ``src/`` without the full runtime stack.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

from sources.knowledge_layer.tests.qdrant_testing import fresh_qdrant_store  # noqa: F401 - a store of its own
from sources.knowledge_layer.tests.qdrant_testing import qdrant_store  # noqa: F401 - the shared store fixture

_SRC_ROOT = Path(__file__).resolve().parents[1] / "src"
_PKG_DIR = _SRC_ROOT / "aiq_api"

if _PKG_DIR.is_dir():
    if str(_SRC_ROOT) not in sys.path:
        sys.path.insert(0, str(_SRC_ROOT))

    if "aiq_api" not in sys.modules:
        _pkg = types.ModuleType("aiq_api")
        _pkg.__path__ = [str(_PKG_DIR)]
        sys.modules["aiq_api"] = _pkg


@pytest.fixture(autouse=True)
def _no_retry_pauses(monkeypatch):
    """The internal-write retry pauses 5 s and 20 s between attempts; tests do not.

    Every backend→BFF write goes through ``internal_retry.send_with_retry``, so
    a test that doubles a failing BFF would otherwise wait 25 s per call. The
    attempts still happen; only the pauses are skipped.
    """
    from aiq_api import internal_retry

    async def _instant(_seconds: float) -> None:
        return None

    monkeypatch.setattr(internal_retry, "_sleep", _instant)


@pytest.fixture(autouse=True)
def _no_live_decisions(monkeypatch):
    """The decision model (ADR-0064) is off unless a test turns it on.

    Same guard as ``tests/conftest.py``: the feedback digest now labels its
    down-votes on it, and a developer's OpenRouter key would otherwise send a
    test's fixtures to the live endpoint.
    """
    monkeypatch.setenv("GRID_DECISIONS_ENABLED", "false")
