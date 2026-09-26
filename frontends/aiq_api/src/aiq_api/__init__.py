"""
AI-Q API - Unified Knowledge API and Async Job API.

This package combines:
- Knowledge API: Collection and document management
- Async Job API: Agent job submission and SSE streaming

``AIQAPIConfig`` and ``AIQAPIWorker`` load on first use. Importing ``.plugin``
here pulled the routes, the job runner and the agents in with ANY submodule
(``aiq_api.auth.errors`` included), which closed an import cycle through
``aiq_agent.turn.api_seam``. NAT registers through ``aiq_api.register``.
"""

from typing import TYPE_CHECKING
from typing import Any

if TYPE_CHECKING:
    from .plugin import AIQAPIConfig
    from .plugin import AIQAPIWorker

__all__ = ["AIQAPIConfig", "AIQAPIWorker"]


def __getattr__(name: str) -> Any:
    if name in __all__:
        from . import plugin

        return getattr(plugin, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
