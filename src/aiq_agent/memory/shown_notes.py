"""The restricted memory a conversation's turns were shown (ADR-0084).

Each turn's prompt carries a project-memory digest, re-ranked per turn against
the question and capped (1,800 characters on the BFF). A note tagged
``restricted`` that reached the prompt in turn 3 may be gone from the digest in
turn 7, while what it said is still in the history the model answers from. The
memory restriction decision (``memory/restriction.py``) must still see it, or a
paraphrase written in turn 7 would be filed as open memory, and with no
restricted document listable the decision would not even ask its judge.

So every turn records, per conversation, the restricted notes its prompt carried
and the ones it wrote as restricted, each with the restricted collections of
the scope it was shown under (a digest line does not say which folder it came
from; the note is restricted to some of these). Later turns read the record as
evidence. It lives beside the citation registry, the other piece of
per-conversation evidence the decision reads, in the shared cache
(ADR-0020): the cache key is the conversation id, unique across tenants.

The record is bounded (:data:`MAX_NOTES`). A note that no longer fits is not
forgotten silently: its collections move to ``overflowed``, and every later
memory of the conversation is restricted to them, which fails closed.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Iterable
from collections.abc import Sequence
from contextvars import ContextVar
from contextvars import Token
from dataclasses import dataclass
from typing import Any

from aiq_agent.knowledge.restricted_collections import restricted_collections_in
from aiq_agent.memory.restriction import RestrictedNote

logger = logging.getLogger(__name__)

_CACHE_PREFIX = "restricted-notes:"
#: Thirty days. Longer than the citation registry's day on purpose: a forgotten
#: note is an open door, not a missing chip, and a record is a few kilobytes.
_TTL_SECONDS = 30 * 24 * 60 * 60
#: Notes kept per conversation. The judge is shown at most 150 entries
#: (``restriction.MAX_JUDGE_DOCUMENTS``), so a longer record could not be judged.
MAX_NOTES = 150
_MAX_NOTE_CHARS = 300


@dataclass(frozen=True)
class ShownNotes:
    """What earlier turns of one conversation were shown of restricted memory."""

    notes: tuple[RestrictedNote, ...] = ()
    #: Collections of notes that fell out of the bounded record: every later
    #: memory of the conversation is restricted to them.
    overflowed: tuple[str, ...] = ()

    @property
    def empty(self) -> bool:
        return not self.notes and not self.overflowed


def _key(conversation_id: str) -> str:
    return f"{_CACHE_PREFIX}{conversation_id}"


def _note_from(item: Any) -> RestrictedNote | None:
    if not isinstance(item, dict):
        return None
    content = item.get("content")
    collections = item.get("collections")
    if not isinstance(content, str) or not isinstance(collections, list):
        return None
    restricted = tuple(dict.fromkeys(restricted_collections_in(c for c in collections if isinstance(c, str))))
    content = content.strip()[:_MAX_NOTE_CHARS]
    return RestrictedNote(content, restricted) if content and restricted else None


def _decode(raw: Any) -> ShownNotes:
    if not isinstance(raw, dict):
        return ShownNotes()
    notes = tuple(note for note in map(_note_from, raw.get("notes") or ()) if note is not None)
    overflowed = raw.get("overflowed")
    names = overflowed if isinstance(overflowed, list) else []
    pinned = restricted_collections_in(name for name in names if isinstance(name, str))
    return ShownNotes(notes=notes, overflowed=tuple(dict.fromkeys(pinned)))


def _encode(shown: ShownNotes) -> dict[str, Any]:
    return {
        "notes": [{"content": note.content, "collections": list(note.collections)} for note in shown.notes],
        "overflowed": list(shown.overflowed),
    }


def load_shown_notes(conversation_id: str | None) -> ShownNotes:
    """The conversation's record; empty for no conversation or on any read failure.

    Synchronous (a cache round trip); call it through ``asyncio.to_thread``.
    """
    if not conversation_id:
        return ShownNotes()
    from aiq_agent.common import cache

    try:
        return _decode(cache.get_json(_key(conversation_id)))
    except Exception:  # noqa: BLE001 - evidence that cannot be read is evidence missing, not a failed turn
        logger.warning("Could not read the restricted notes shown in %s", conversation_id, exc_info=True)
        return ShownNotes()


def merged(shown: ShownNotes, contents: Iterable[str], collections: Sequence[str]) -> ShownNotes:
    """``shown`` plus ``contents`` shown under ``collections``, bounded; newest last.

    A note seen again under a different scope keeps both scopes' collections:
    it could have come from either.
    """
    restricted = tuple(dict.fromkeys(restricted_collections_in(collections)))
    if not restricted:
        return shown
    by_content = {note.content: note for note in shown.notes}
    for content in contents:
        text = (content or "").strip()[:_MAX_NOTE_CHARS]
        if not text:
            continue
        previous = by_content.pop(text, None)
        union = tuple(dict.fromkeys([*(previous.collections if previous else ()), *restricted]))
        by_content[text] = RestrictedNote(text, union)
    notes = list(by_content.values())
    overflowed = list(shown.overflowed)
    while len(notes) > MAX_NOTES:
        dropped = notes.pop(0)
        overflowed.extend(dropped.collections)
    return ShownNotes(notes=tuple(notes), overflowed=tuple(dict.fromkeys(overflowed)))


def persist_shown_notes(conversation_id: str | None, shown: ShownNotes) -> None:
    """Write the record (synchronous, best-effort). An empty record writes nothing."""
    if not conversation_id or shown.empty:
        return
    from aiq_agent.common import cache

    cache.set_json(_key(conversation_id), _encode(shown), _TTL_SECONDS)


# ---------------------------------------------------------------------------
# The turn's view: bound for the turn, read by the `remember` tool
# ---------------------------------------------------------------------------

_turn_shown_notes: ContextVar[ShownNotes | None] = ContextVar("turn_shown_restricted_notes", default=None)


def bind_shown_notes(shown: ShownNotes) -> Token:
    """Make what EARLIER turns were shown visible to this turn's tools; reset with the token."""
    return _turn_shown_notes.set(shown)


def unbind_shown_notes(token: Token) -> None:
    _turn_shown_notes.reset(token)


def turn_shown_notes() -> ShownNotes:
    """What earlier turns of this conversation were shown; empty outside a turn."""
    return _turn_shown_notes.get() or ShownNotes()


# Strong references to in-flight writes so the loop cannot collect them mid-run.
_persist_tasks: set[asyncio.Task] = set()


async def _persist(conversation_id: str, shown: ShownNotes) -> None:
    try:
        await asyncio.to_thread(persist_shown_notes, conversation_id, shown)
    except Exception:  # noqa: BLE001 - a background write; there is nobody left to raise to
        logger.warning("Persisting the restricted notes shown in %s failed", conversation_id, exc_info=True)


def schedule_shown_notes_persist(conversation_id: str | None, shown: ShownNotes) -> None:
    """Persist the record off the answer's path, like the citation registry."""
    if not conversation_id or shown.empty:
        return
    task = asyncio.get_running_loop().create_task(_persist(conversation_id, shown))
    _persist_tasks.add(task)
    task.add_done_callback(_persist_tasks.discard)
