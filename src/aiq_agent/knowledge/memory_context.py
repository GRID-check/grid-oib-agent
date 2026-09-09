"""What memory this turn READ — the record the answer marker renders (ADR-0055).

Memory reaches a turn two ways: the digest injected before the agent runs, and
the ``search_memory`` tool the agent may call while it runs. Neither of them
left a trace the READER could see; the digest's own text tells the *model* how
many notes were dropped and told nobody else. This module is that trace.

**It says what was read, never what was used.** That distinction is the whole
point of ADR-0055's marker rule and it is load-bearing here: whether a note
changed the answer is a claim we cannot verify, so nothing in this module — no
field name, no docstring, no count — may be worded as influence. ``carried`` is
"was in the prompt", ``searched`` is "came back from a tool call". A future
field that would claim more does not belong on this shape.

Two halves, bound differently because they happen at different times:

* the **digest** half is known before the agent runs, so it travels as an
  ordinary value (:class:`MemoryCarry`, built by the digest clients from the
  BFF's ``carried``/``omitted``/``total`` — contract C2) and is passed to
  :func:`build_memory_context` at the end of the turn;
* the **search** half happens inside the turn, in a tool that has no way to
  hand a value back to the turn's assembly code, so it is a per-turn
  ``ContextVar`` registry created and reset per turn — the rule
  ``cards/registry.py`` and ``knowledge/project_memory.py``'s write log already
  follow (``src/aiq_agent/AGENTS.md``). Module-level state here would leak one
  tenant's read counts into the next turn.

Both halves are BOUNDED, and the bounds are the contract's: at most
:data:`MAX_CARRIED` notes, each cut to :data:`MAX_CONTENT_CHARS` characters. The
frame this feeds is rendered as one collapsed line, so an unbounded list would
be twenty kilobytes on the wire for a line nobody opened.
"""

from __future__ import annotations

import logging
from contextvars import ContextVar
from contextvars import Token
from dataclasses import dataclass
from dataclasses import field
from typing import Any

logger = logging.getLogger(__name__)

#: Notes the frame ever names. The same ceiling the digest itself is built
#: under, so the marker can never claim more notes were carried than the digest
#: could have held (contract C2/C3).
MAX_CARRIED = 20

#: Per-note character ceiling on the wire. The marker renders one line per note
#: in an expandable list, not the note's full text — the memory panel is where a
#: note is read in full, and the marker links there.
MAX_CONTENT_CHARS = 120


@dataclass(frozen=True)
class MemoryNote:
    """One note the turn read: enough to name it and link to it, nothing more.

    Deliberately NOT the stored row: no confidence, no verification, no scope,
    no timestamp. Those are curation facts and they belong to the memory panel,
    which the marker links to. A marker that repeated them would be a second
    place to keep them correct.
    """

    id: str
    kind: str
    content: str

    def as_wire(self) -> dict[str, str]:
        return {"id": self.id, "kind": self.kind, "content": self.content}


@dataclass(frozen=True)
class MemoryCarry:
    """The digest half of the turn's memory read, as the BFF reported it.

    ``carried`` is exactly what went into the digest TEXT (contract C2 builds it
    from the same selection, not a second query), ``omitted`` is the number the
    digest text already discloses to the model, and ``total`` is how many notes
    exist in scope. The three together are what makes the omission count reach
    the reader as well as the model — the inversion ADR-0055 names.

    All-zero-and-empty is the honest default for a BFF that does not send these
    fields yet: unknown, so nothing is claimed.
    """

    carried: tuple[MemoryNote, ...] = ()
    omitted: int = 0
    total: int = 0

    def __bool__(self) -> bool:
        return bool(self.carried) or self.total > 0 or self.omitted > 0


def _clean_int(value: Any) -> int:
    """A wire number as a non-negative int; 0 for anything unusable.

    ``bool`` is an ``int`` in Python and ``True`` is not a count, so it is
    refused rather than read as one.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    try:
        return max(0, int(value))
    except (TypeError, ValueError, OverflowError):
        return 0


def parse_notes(raw: Any, *, limit: int = MAX_CARRIED) -> tuple[MemoryNote, ...]:
    """Wire entries to :class:`MemoryNote`, bounded and cleaned.

    Fails per ENTRY, never per response: a malformed row is dropped and the rest
    still reaches the reader — the same discipline ``workspace_digest._as_project``
    follows. An entry without an id is dropped because the marker links each note
    to the memory panel by it, and a note that cannot be opened is a line that
    lies about being openable.
    """
    if not isinstance(raw, list):
        return ()
    notes: list[MemoryNote] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        note_id = entry.get("id")
        if not isinstance(note_id, str) or not note_id.strip():
            continue
        kind = entry.get("kind")
        content = entry.get("content")
        notes.append(
            MemoryNote(
                id=note_id.strip(),
                kind=kind.strip() if isinstance(kind, str) else "",
                content=(content.strip()[:MAX_CONTENT_CHARS] if isinstance(content, str) else ""),
            )
        )
        if len(notes) >= max(0, limit):
            break
    return tuple(notes)


def parse_carry(body: Any) -> MemoryCarry:
    """The ``carried``/``omitted``/``total`` half of a digest response.

    Tolerates every one of them being absent: an older BFF that has not shipped
    contract C2 yet serves the digest string and nothing else, and that must
    cost the turn nothing — the marker is then simply absent, which is the
    honest rendering of "we do not know what was read".
    """
    if not isinstance(body, dict):
        return MemoryCarry()
    return MemoryCarry(
        carried=parse_notes(body.get("carried")),
        omitted=_clean_int(body.get("omitted")),
        total=_clean_int(body.get("total")),
    )


@dataclass
class _TurnMemoryReads:
    """Mutable per-turn tally. One instance per turn, never shared."""

    searched: int = 0
    searches: int = 0
    #: Ids returned by ``search_memory`` this turn, first mention wins. Kept so
    #: ``searched`` counts NOTES and not rows-returned-twice when the agent
    #: searches more than once and the same note comes back.
    seen: list[str] = field(default_factory=list)


#: Bound per turn by the answering agent, reset with the token. ``None`` means
#: "no turn" — a background stage, the CLI, a unit test — and every recorder
#: below is a no-op there rather than a crash or a leak.
_turn_memory_reads: ContextVar[_TurnMemoryReads | None] = ContextVar("turn_memory_reads", default=None)


def begin_turn_memory_reads() -> Token:
    """Start tallying this turn's memory reads; reset with the token."""
    return _turn_memory_reads.set(_TurnMemoryReads())


def end_turn_memory_reads(token: Token) -> None:
    _turn_memory_reads.reset(token)


def record_memory_search(notes: list[MemoryNote] | tuple[MemoryNote, ...]) -> int:
    """Note that ``search_memory`` returned these notes. Returns the NEW count.

    The return is what the caller puts on its status line, so the line says how
    many notes this call found rather than how many the turn has found so far.
    No-op outside a turn, where it returns the call's own count anyway.
    """
    reads = _turn_memory_reads.get()
    if reads is None:
        return len(notes)
    reads.searches += 1
    fresh = 0
    for note in notes:
        if note.id in reads.seen:
            continue
        reads.seen.append(note.id)
        fresh += 1
    reads.searched = len(reads.seen)
    return fresh


def turn_memory_searched() -> int:
    """Distinct notes ``search_memory`` returned this turn; 0 if never called."""
    reads = _turn_memory_reads.get()
    return reads.searched if reads is not None else 0


def build_memory_context(carry: MemoryCarry | None, *, searched: int) -> dict[str, Any] | None:
    """The ``memory_context`` frame extra (contract C3), or ``None``.

    ``None`` — and therefore no field on the frame at all — when the turn read
    no memory: nothing carried, nothing in scope, nothing searched. Presence is
    what the frontend renders on, so an empty shape on the wire would put an
    empty marker under an answer that never touched memory.

    Everything here is a READ. ``carried`` is what the digest put in front of
    the model, ``searched`` is what a tool call brought back. Neither says the
    answer used any of it, and no caller may present it as if it did.
    """
    carry = carry or MemoryCarry()
    searched = max(0, int(searched or 0))
    if not carry and searched <= 0:
        return None
    return {
        "carried": [note.as_wire() for note in carry.carried[:MAX_CARRIED]],
        "omitted": carry.omitted,
        "total": carry.total,
        "searched": searched,
    }
