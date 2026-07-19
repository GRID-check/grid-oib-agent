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


def _raw_collection_scope_from_header() -> list[str] | None:
    """Decode the UNVERIFIED ``X-Grid-Collection-Scope`` header.

    Fallback used only when the signed request-context envelope cannot be parsed
    (e.g. ``aiq_agent.project_context`` is unavailable to import). Returns the raw
    list of collection names, or ``None`` when the header is missing or malformed.
    Not normalized — the public function normalizes its result.
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

    return scope


def get_collection_scope_from_context() -> list[str] | None:
    """Read the caller's collection scope, preferring the SIGNED envelope.

    The collection scope is an authorization boundary: it selects which document
    collections a turn may read — the shared corpus, per-project stores, and the
    per-conversation ``s_<conversation_id>`` upload store. Because collection
    names are guessable, an attacker who could set a raw ``X-Grid-Collection-Scope``
    header would read another conversation's or tenant's documents.

    The BFF computes the scope server-side from the authenticated session and
    signs it into the ``X-Grid-Request-Context`` envelope (HMAC). We therefore
    consume the envelope's VERIFIED ``collection_scope``; the raw header is
    honored only when no valid envelope is present (anonymous / internal-service
    / dev / legacy) — exactly ``GridRequestContext.from_context()``'s
    envelope-preferring fallback, and the aiq_api enforcement middleware
    fail-closes authenticated turns that lack a valid envelope, so an
    authenticated request always resolves against the signed value. In legitimate
    traffic the BFF dual-writes identical values to both header and envelope, so
    this is behavior-neutral; it diverges only when a raw header is forged to
    differ from the signed envelope — the case we must not honor.

    Returns:
        Deduplicated, normalized list of collection names, or ``None`` when no
        scope is present.
    """
    try:
        from aiq_agent.project_context import GridRequestContext

        scope: Any = GridRequestContext.from_context().collection_scope
    except Exception:
        # project_context unavailable — fall back to the raw header so scoping
        # still functions (parity with pre-envelope behavior).
        logger.debug("Verified collection-scope read failed; falling back to raw header", exc_info=True)
        scope = _raw_collection_scope_from_header()

    if not isinstance(scope, list) or not all(isinstance(item, str) for item in scope):
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
