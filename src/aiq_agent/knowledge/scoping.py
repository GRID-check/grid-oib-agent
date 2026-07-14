"""
Collection scope resolution from the ``X-Grid-Collection-Scope`` header.

The Next.js BFF sends an internal header::

    X-Grid-Collection-Scope: base64url(JSON.stringify([...]))

In Python/NAT this header is accessed lowercased via ``Context`` metadata.
When the header is missing the system falls back to legacy config-based
collection resolution.
"""

import base64
import json
import logging
from typing import Any

from nat.builder.context import Context

logger = logging.getLogger(__name__)


def _normalize_collection_name(name: str) -> str:
    """Normalize known collection names while preserving custom collections."""
    while name.startswith("s_s_"):
        name = name[2:]
    return name


def _base64url_decode(value: str) -> bytes:
    """Base64url-decode *value*, adding padding if necessary."""
    padding = 4 - len(value) % 4
    if padding != 4:
        value += "=" * padding
    return base64.urlsafe_b64decode(value)


def get_collection_scope_from_context() -> list[str] | None:
    """
    Read and decode the ``X-Grid-Collection-Scope`` header from NAT context.

    Returns:
        Deduplicated list of collection names, or ``None`` when the header
        is missing, malformed, or not a list of strings.
    """
    try:
        ctx = Context.get()
        if ctx is None:
            return None
        metadata = ctx.metadata
        if metadata is None:
            return None
        raw = metadata.headers.get("x-grid-collection-scope")
        if raw is None:
            return None
    except Exception:
        logger.debug("Failed to read X-Grid-Collection-Scope from context", exc_info=True)
        return None

    try:
        decoded = _base64url_decode(raw)
        scope: Any = json.loads(decoded)
    except Exception:
        logger.debug("Failed to decode X-Grid-Collection-Scope header", exc_info=True)
        return None

    if not isinstance(scope, list) or not all(isinstance(item, str) for item in scope):
        logger.debug("X-Grid-Collection-Scope is not a list of strings: %s", scope)
        return None

    return list(dict.fromkeys(_normalize_collection_name(item) for item in scope))


def get_collection_scope_from_context_or(
    config: Any,
    session_id: str | None,
) -> list[str]:
    """
    Try context-based collection scope, falling back to legacy resolution.

    Args:
        config: A :class:`knowledge_layer.register.KnowledgeRetrievalConfig`.
        session_id: Resolved per-session collection name, if any.

    Returns:
        Ordered, de-duplicated list of collection names (never empty).
    """
    scope = get_collection_scope_from_context()
    if scope:
        return scope
    from knowledge_layer.register import _resolve_target_collections

    return _resolve_target_collections(config, session_id)
