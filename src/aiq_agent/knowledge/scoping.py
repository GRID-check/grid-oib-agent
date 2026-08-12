"""
Collection scope resolution from the ``X-Grid-Collection-Scope`` header.

The Next.js BFF sends an internal header::

    X-Grid-Collection-Scope: base64url(JSON.stringify([...]))

Two payload shapes are accepted (ADR-0047):

- **Current** — an array of objects carrying the SHELF explicitly::

      [{"collection": "s_9f2a", "shelf": "session"},
       {"collection": "proj_alpha", "shelf": "project"}]

- **Legacy** — a bare array of collection names (``["s_9f2a", "proj_alpha"]``).
  A bare string states no shelf, so the shelf is **unknown**; it is never
  guessed back from the collection-id prefix, and an unknown shelf renders
  unattributed rather than defaulting to ``base``/``baurecht``.

In Python/NAT this header is accessed lowercased via ``Context`` metadata.
When the header is missing the system falls back to legacy config-based
collection resolution.
"""

import base64
import json
import logging
from dataclasses import dataclass
from typing import Any

from aiq_agent.common.source_kinds import Shelf
from aiq_agent.common.source_kinds import parse_shelf
from nat.builder.context import Context

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ScopedCollection:
    """One collection a turn may read, plus the shelf it sits on.

    ``shelf`` is ``None`` when the producer did not state one (legacy
    bare-string scope entry). Unknown is a first-class value: the consumer
    renders such a hit unattributed instead of inventing a shelf for it.
    """

    collection: str
    shelf: Shelf | None = None


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


def _parse_scope_entry(item: Any) -> ScopedCollection | None:
    """One decoded scope entry → :class:`ScopedCollection`, or None if unusable.

    Accepts both wire shapes. A malformed entry is DROPPED rather than widening
    the scope: the list is an authorization boundary, so failing closed on the
    entry we cannot read is the safe direction.
    """
    if isinstance(item, str):
        name = item.strip()
        # A bare string states no shelf — unknown, never inferred from the name.
        return ScopedCollection(_normalize_collection_name(name)) if name else None
    if isinstance(item, dict):
        raw_name = item.get("collection")
        if not isinstance(raw_name, str) or not raw_name.strip():
            return None
        return ScopedCollection(
            _normalize_collection_name(raw_name.strip()),
            parse_shelf(item.get("shelf")),
        )
    return None


def _parse_scope_payload(scope: Any) -> list[ScopedCollection] | None:
    """Decoded header/envelope value → deduplicated scoped collections.

    Fails CLOSED on anything unreadable — a non-list payload, or a list holding
    an entry in neither wire shape, yields ``None`` (no scope at all) rather
    than a partially-read authorization boundary. De-duplication keeps the FIRST
    entry for a collection name, so a stated shelf is not lost to a later
    bare-string repeat of the same collection.
    """
    if not isinstance(scope, list):
        return None
    entries: list[ScopedCollection] = []
    seen: set[str] = set()
    for item in scope:
        parsed = _parse_scope_entry(item)
        if parsed is None:
            logger.debug("Unreadable collection-scope entry, ignoring the whole scope: %r", item)
            return None
        if parsed.collection in seen:
            continue
        seen.add(parsed.collection)
        entries.append(parsed)
    return entries


def _raw_collection_scope_from_header() -> list[Any] | None:
    """Decode the UNVERIFIED ``X-Grid-Collection-Scope`` header.

    Fallback used only when the signed request-context envelope cannot be parsed
    (e.g. ``aiq_agent.project_context`` is unavailable to import). Returns the raw
    decoded list (bare strings and/or ``{collection, shelf}`` objects), or
    ``None`` when the header is missing or malformed. Not normalized — the
    public functions normalize their result.
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

    if not isinstance(scope, list):
        logger.debug("X-Grid-Collection-Scope is not a list: %s", scope)
        return None

    return scope


def get_scoped_collections_from_context() -> list[ScopedCollection] | None:
    """The caller's collection scope WITH each collection's shelf.

    Same authorization semantics as :func:`get_collection_scope_from_context`
    (which is this function's names-only projection): the SIGNED envelope wins,
    the raw header is honored only when no valid envelope is present.

    Returns:
        Deduplicated, normalized ``(collection, shelf)`` entries (possibly
        empty), or ``None`` when no readable scope is present. ``shelf`` is
        ``None`` for a legacy bare-string entry — unknown, not guessed.
    """
    scope: Any = None
    try:
        from aiq_agent.project_context import GridRequestContext

        ctx = GridRequestContext.from_context()
        scope = ctx.collection_scope_entries if ctx.collection_scope_entries is not None else ctx.collection_scope
    except Exception:
        # project_context unavailable — fall back to the raw header so scoping
        # still functions (parity with pre-envelope behavior).
        logger.debug("Verified collection-scope read failed; falling back to raw header", exc_info=True)
        scope = _raw_collection_scope_from_header()

    return _parse_scope_payload(scope)


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
        scope is present. Callers that need the shelf each collection sits on
        want :func:`get_scoped_collections_from_context` instead.
    """
    entries = get_scoped_collections_from_context()
    return None if entries is None else [entry.collection for entry in entries]


def get_scoped_collections_from_context_or(
    config: Any,
    session_id: str | None,
) -> list[ScopedCollection]:
    """
    Try context-based collection scope, falling back to legacy resolution.

    Args:
        config: A :class:`knowledge_layer.register.KnowledgeRetrievalConfig`.
        session_id: Resolved per-session collection name, if any.

    Returns:
        Ordered, de-duplicated scoped collections (never empty). The legacy
        fallback knows each layer's shelf STRUCTURALLY (it builds the layers),
        so it states one rather than guessing from the name.
    """
    scope = get_scoped_collections_from_context()
    if scope:
        return scope
    from knowledge_layer.register import _resolve_scoped_collections

    return _resolve_scoped_collections(config, session_id)


def get_collection_scope_from_context_or(
    config: Any,
    session_id: str | None,
) -> list[str]:
    """Names-only projection of :func:`get_scoped_collections_from_context_or`.

    Returns:
        Ordered, de-duplicated list of collection names (never empty).
    """
    return [entry.collection for entry in get_scoped_collections_from_context_or(config, session_id)]
