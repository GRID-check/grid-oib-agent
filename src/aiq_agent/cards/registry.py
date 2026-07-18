"""Session-scoped registry for cards emitted by the ``emit_card`` tool.

Cards are a first-class agent output: the answering agent calls ``emit_card``
mid-turn when a structured element adds value, and the tool pushes the
validated card into the conversation-scoped registry bound here. The chat
entrypoint reads the registry after the turn and attaches the cards to the
response — the same ContextVar pattern the citation registry uses
(:mod:`aiq_agent.common.citation_verification`).
"""

from __future__ import annotations

import contextvars
import logging
import threading
from collections import OrderedDict
from typing import Any

logger = logging.getLogger(__name__)


def _load_norm_registry_safe():
    """Load the norm registry, fail-open (stamping is a best-effort enrichment)."""
    try:
        from aiq_agent.common.norm_registry import load_registry

        return load_registry()
    except Exception:  # noqa: BLE001 - stamping must never break card emission
        logger.warning("norm registry unavailable; skipping NormReference trust-chain stamping")
        return None


def _resolve_bundesland_safe() -> str | None:
    try:
        from aiq_agent.common.norm_registry import resolve_bundesland

        return resolve_bundesland("")
    except Exception:  # noqa: BLE001
        return None


def _stamp_references(node: Any, registry, bundesland: str | None) -> None:
    """Walk a card dict and stamp trust-chain fields onto every reference dict."""
    if isinstance(node, dict):
        reference = node.get("reference")
        if isinstance(reference, dict) and isinstance(reference.get("document"), str):
            _stamp_reference(reference, registry, bundesland)
        for value in node.values():
            _stamp_references(value, registry, bundesland)
    elif isinstance(node, list):
        for item in node:
            _stamp_references(item, registry, bundesland)


def _stamp_reference(reference: dict[str, Any], registry, bundesland: str | None) -> None:
    from aiq_agent.common.norm_resolution import resolve_norm_reference

    resolved = resolve_norm_reference(reference["document"], reference.get("edition"), registry, bundesland=bundesland)
    if resolved is None:
        reference.pop("norm_id", None)
        reference.pop("rank", None)
        reference.pop("binding", None)
        reference.pop("via", None)
        return
    reference["norm_id"] = resolved.norm_id
    reference["rank"] = resolved.rank
    if resolved.binding is not None:
        reference["binding"] = resolved.binding
    else:
        reference.pop("binding", None)
    if resolved.via is not None:
        reference["via"] = resolved.via
    else:
        reference.pop("via", None)


class CardRegistry:
    """Accumulates validated card dicts emitted during a single turn."""

    def __init__(self) -> None:
        self._cards: list[dict[str, Any]] = []

    def add(self, card: dict[str, Any]) -> None:
        """Append one validated card dict (stamping norm trust-chain fields)."""
        registry = _load_norm_registry_safe()
        if registry is not None:
            _stamp_references(card, registry, _resolve_bundesland_safe())
        self._cards.append(card)

    def snapshot(self) -> list[dict[str, Any]]:
        """Return a shallow copy of the accumulated cards."""
        return list(self._cards)

    def clear(self) -> None:
        """Drop all accumulated cards (call at turn boundaries)."""
        self._cards.clear()


_session_card_registry: contextvars.ContextVar[CardRegistry | None] = contextvars.ContextVar(
    "_session_card_registry", default=None
)

_MAX_SESSION_REGISTRIES = 1000
_session_registries: OrderedDict[str, CardRegistry] = OrderedDict()
_session_registries_lock = threading.Lock()


def get_or_create_card_registry(session_id: str | None) -> CardRegistry:
    """Get or create a conversation-scoped ``CardRegistry`` (LRU, max 1000).

    When ``session_id`` is None (CLI / batch with no conversation), a fresh
    isolated registry is returned every call so concurrent anonymous requests
    never share card state. Registries are reused across turns of the same
    conversation, so callers must ``clear()`` at the start of a turn.
    """
    if session_id is None:
        return CardRegistry()
    with _session_registries_lock:
        if session_id in _session_registries:
            _session_registries.move_to_end(session_id)
            return _session_registries[session_id]
        registry = CardRegistry()
        _session_registries[session_id] = registry
        while len(_session_registries) > _MAX_SESSION_REGISTRIES:
            _session_registries.popitem(last=False)
        return registry


def set_card_registry(registry: CardRegistry | None) -> contextvars.Token:
    """Bind the card registry for the current async context."""
    return _session_card_registry.set(registry)


def reset_card_registry(token: contextvars.Token) -> None:
    """Restore the previously bound card registry."""
    _session_card_registry.reset(token)


def get_card_registry() -> CardRegistry | None:
    """Return the card registry bound to the current async context, if any."""
    return _session_card_registry.get()
