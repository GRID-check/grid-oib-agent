"""A chat turn's use of restricted folders (ADR-0078, ADR-0079).

A conversation is restricted by what it actually USED, per person: content
from a folder not every project member may read enters the model's context
only after the BFF admitted that use for the conversation, against everyone
who can read the conversation, and recorded the folder
(``POST /api/internal/conversations/{id}/restricted-use``). This module is the
agent's side of that, and the one place it is decided:

- at turn start (:func:`begin_restricted_use`) the BFF answers which of the
  restricted collections the turn's SIGNED scope carries the asker and
  everyone the conversation is shared with may read NOW (``drawable``), and
  whether the conversation already recorded a restricted folder
  (``confined``). The turn's scope is narrowed to the drawable ones at the one
  place every read path takes its scope from
  (:func:`aiq_agent.knowledge.scoping.get_scoped_collections_from_context`), so
  a share made between turns narrows the next turn's search;
- a tool round's results are ADMITTED before the model reads them
  (:func:`admit_tool_results`, called by the Piloti tools node): every drawable
  restricted collection a result carries is admitted, and a result carrying a
  refused one (a share raced the turn, or the BFF could not be asked) is
  replaced by a notice, its passages dropped;
- listing is not use: restricted collections stay out of the inventory block
  and ``list_files`` (:func:`without_restricted`), so a name or a summary never
  reaches the prompt without an admission.

Every failure fails closed: no drawable collection, the conversation counted
as confined, a result withheld.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterable
from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import field
from typing import Any

from aiq_agent.knowledge.restricted_collections import is_restricted_collection
from aiq_agent.knowledge.restricted_collections import restricted_collections_in

logger = logging.getLogger(__name__)

#: One short attempt: the check sits in front of the turn and in a tool round.
_TIMEOUT_SECONDS = 5.0

_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

#: What a tool result carrying refused restricted content is replaced with. In
#: German, the language the model answers the office in.
WITHHELD_NOTICE = (
    "Dieses Ergebnis wurde zurückgehalten: Es stammt aus einem Ordner mit eingeschränktem Zugriff, "
    "den nicht alle lesen dürfen, die dieses Gespräch lesen. Antworte ohne diesen Inhalt."
)


@dataclass
class RestrictedUse:
    """What one chat turn may draw on from restricted folders, and what it did."""

    organization_id: str
    user_id: str
    conversation_id: str
    project_id: str | None
    #: The restricted collections this turn may search. Narrowed when an
    #: admission is refused; never widened.
    drawable: set[str] = field(default_factory=set)
    #: The conversation recorded a restricted folder (or that could not be
    #: established): nothing it writes may reach the whole project.
    confined: bool = False

    def allows(self, collection: str) -> bool:
        """Whether a restricted ``collection`` may stay in this turn's scope."""
        return collection in self.drawable

    def drop(self, collections: Iterable[str]) -> None:
        """Take refused collections out of the turn's scope for the rest of the turn."""
        self.drawable.difference_update(collections)

    def note_recorded(self) -> None:
        """Content from a restricted folder entered the turn: the conversation is confined from here."""
        self.confined = True


_turn_use: contextvars.ContextVar[RestrictedUse | None] = contextvars.ContextVar("grid_restricted_use", default=None)


def current_restricted_use() -> RestrictedUse | None:
    """The bound turn's restricted use, or ``None`` outside an interactive chat turn with restricted scope."""
    return _turn_use.get()


def bind_restricted_use(use: RestrictedUse | None) -> contextvars.Token:
    """Bind ``use`` for the turn; the caller resets with the token when the turn ends."""
    return _turn_use.set(use)


def reset_restricted_use(token: contextvars.Token) -> None:
    _turn_use.reset(token)


def without_restricted(entries: Sequence[Any]) -> list[Any]:
    """``entries`` (scoped collections) without restricted ones: what may be LISTED to the model."""
    return [entry for entry in entries if not is_restricted_collection(getattr(entry, "collection", None))]


def _base_url() -> str:
    url = os.environ.get("FRONTEND_INTERNAL_URL") or os.environ.get("FRONTEND_URL") or "http://frontend:3000"
    return url.rstrip("/")


def _post(use: RestrictedUse, body: dict[str, Any]) -> dict[str, Any] | None:
    """``POST`` to the restricted-use route; ``None`` on any failure (the caller fails closed)."""
    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        logger.warning("Restricted use for %s not checked: GRID_INTERNAL_API_TOKEN is not set", use.conversation_id)
        return None
    payload = {"organizationId": use.organization_id, "userId": use.user_id, **body}
    if use.project_id:
        payload["projectId"] = use.project_id
    conversation = urllib.parse.quote(use.conversation_id, safe="")
    request = urllib.request.Request(
        f"{_base_url()}/api/internal/conversations/{conversation}/restricted-use",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Grid-Internal-Token": token},
        method="POST",
    )
    try:
        with _opener.open(request, timeout=_TIMEOUT_SECONDS) as response:
            parsed = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError):
        logger.warning("Restricted-use check for conversation %s failed", use.conversation_id, exc_info=True)
        return None
    return parsed if isinstance(parsed, dict) else None


def _names(value: object) -> list[str]:
    return [name for name in value if isinstance(name, str)] if isinstance(value, list) else []


def check_restricted_use(use: RestrictedUse, candidates: Sequence[str]) -> RestrictedUse:
    """Ask which candidates the turn may draw on and whether the conversation is confined. Blocking.

    Fails closed: on any failure nothing is drawable and the conversation
    counts as confined.
    """
    body = _post(use, {"candidates": list(dict.fromkeys(candidates))})
    if body is None:
        use.drawable = set()
        use.confined = True
        return use
    offered = set(candidates)
    use.drawable = {name for name in _names(body.get("drawable")) if name in offered}
    use.confined = bool(_names(body.get("recorded")))
    return use


def admit(use: RestrictedUse, collections: Sequence[str]) -> set[str]:
    """Admit restricted content from ``collections`` for the conversation; the admitted ones. Blocking.

    A collection the BFF refuses, or every one when it could not be asked, is
    dropped from the turn's scope. Anything admitted confines the conversation.
    """
    asked = [name for name in dict.fromkeys(collections) if name]
    if not asked:
        return set()
    body = _post(use, {"admit": asked})
    admitted = set(_names(body.get("admitted"))) & set(asked) if body is not None else set()
    refused = set(asked) - admitted
    if refused:
        logger.warning(
            "Restricted content from %d collection(s) withheld in conversation %s", len(refused), use.conversation_id
        )
        use.drop(refused)
    if admitted:
        use.note_recorded()
    return admitted


async def begin_restricted_use(request: Any, conversation_id: str | None) -> RestrictedUse | None:
    """The turn's restricted use, asked of the BFF; ``None`` when its scope holds no restricted collection.

    ``request`` is the turn's :class:`aiq_agent.project_context.GridRequestContext`.
    Only a VERIFIED envelope counts: a restricted collection in a scope read
    from the unsigned header fallback vouches for nothing, so the turn gets a
    use with nothing drawable and counts as confined, without asking.
    """
    candidates = restricted_collections_in(getattr(request, "collection_scope", None))
    if not candidates:
        return None
    organization_id = getattr(request, "organization_id", None)
    user_id = getattr(request, "user_id", None)
    use = RestrictedUse(
        organization_id=organization_id or "",
        user_id=user_id or "",
        conversation_id=conversation_id or "",
        project_id=getattr(request, "project_id", None),
        confined=True,
    )
    if not getattr(request, "envelope_header", None):
        logger.warning("Restricted collections in an unsigned scope: nothing drawable")
        return use
    if not organization_id or not user_id or not conversation_id:
        logger.warning("Restricted scope without an organization, asker or conversation: nothing drawable")
        return use
    return await asyncio.to_thread(check_restricted_use, use, candidates)


def _text_of(message: Any) -> str:
    content = getattr(message, "content", "")
    if isinstance(content, str):
        return content
    try:
        return json.dumps(content, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return str(content)


def _carried(message: Any, watched: Sequence[str]) -> set[str]:
    """The watched restricted collections a tool result names: its passages, image or error came from them."""
    text = _text_of(message)
    return {name for name in watched if name in text}


async def admit_tool_results(messages: list[Any], watched: Sequence[str] | None = None) -> list[Any]:
    """Admit the restricted content a tool round returned, before the model reads it.

    ``watched`` defaults to the collections the turn could still draw on. A
    result naming one is admitted for the conversation; a result naming one the
    BFF refused is replaced with :data:`WITHHELD_NOTICE` (same tool call id, so
    the provider still sees one result per call). Outside a turn with
    restricted scope, ``messages`` come back untouched.
    """
    use = current_restricted_use()
    if use is None:
        return messages
    names = sorted(watched if watched is not None else use.drawable)
    if not names:
        return messages
    carried = [_carried(message, names) for message in messages]
    wanted = sorted(set().union(*carried)) if carried else []
    if not wanted:
        return messages
    admitted = await asyncio.to_thread(admit, use, wanted)
    if admitted.issuperset(wanted):
        return messages
    return [
        _withheld(message) if names_in_message - admitted else message
        for message, names_in_message in zip(messages, carried, strict=True)
    ]


def _withheld(message: Any) -> Any:
    try:
        return message.model_copy(update={"content": WITHHELD_NOTICE, "artifact": None})
    except Exception:  # noqa: BLE001 - a message type without model_copy keeps nothing of its content
        from langchain_core.messages import ToolMessage

        return ToolMessage(
            content=WITHHELD_NOTICE,
            tool_call_id=str(getattr(message, "tool_call_id", "") or ""),
            name=getattr(message, "name", None),
        )
