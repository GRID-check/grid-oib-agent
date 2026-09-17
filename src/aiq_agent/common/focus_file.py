"""Turn-level retrieval intent.

The signed ``X-Grid-Collection-Scope`` header is the **authorization
ceiling** (which corpora this caller may read). What a *turn* actually
searches is a subtractive subset of that ceiling.

The client states **intent**, never an expanded collection list:

* ``focus_file_name`` — the file this send is about (composer subject)
* ``focus_shelf`` — the shelf that file sits on (``session`` / ``project`` / ``archiv``)
* ``source_preset`` — the composer chip (``law`` / ``project`` / ``office``)

:func:`shelves_for_turn` is the one mapping from that intent to the
shelves retrieval may keep. A subject shelf wins over a preset. Absence
of both leaves the signed scope intact (ADR-0024: Archiv stays in
every unscoped project turn).

The mapping is a twin of ``includeShelvesForTurn`` in
``frontends/ui/src/features/layout/lib/retrieval-scope.ts``. Change both.
"""

from __future__ import annotations

from contextvars import ContextVar

SHELVES = frozenset({"archiv", "project", "session", "base"})
PRESETS = frozenset({"law", "project", "office"})

_focused_file_name: ContextVar[str | None] = ContextVar("grid_focused_file_name", default=None)
_focused_shelf: ContextVar[str | None] = ContextVar("grid_focused_shelf", default=None)
_turn_shelves: ContextVar[frozenset[str] | None] = ContextVar("grid_turn_shelves", default=None)


def _normalize_shelf(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip().lower()
    return trimmed if trimmed in SHELVES else None


def _normalize_preset(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip().lower()
    return trimmed if trimmed in PRESETS else None


def shelves_for_turn(*, focus_shelf: object = None, source_preset: object = None) -> frozenset[str] | None:
    """Shelves this turn may retrieve from, or ``None`` to keep the signed scope.

    A focused file's shelf is the commitment; the composer chip is the
    fallback when no file is bound.
    """
    shelf = _normalize_shelf(focus_shelf)
    # THE LAW IS NOT A COMPETING SHELF, SO A SUBJECT FILE NEVER SUBTRACTS IT.
    #
    # A subject narrows WHICH DOCUMENTS a turn reads — that is what #429 and
    # #436 asked for: "summarize this upload" must not walk the whole corpus,
    # and a project question must not mix in Archiv hits. Neither complaint was
    # about the building-code corpus, and dropping it made the product unable to
    # answer its own central question: bind a plan, ask whether it meets the
    # escape-route requirement, and retrieval held the plan and no OIB at all.
    #
    # The asymmetry gave it away. The `project` PRESET keeps `base`; the
    # `project` SHELF did not, although the reader had expressed the same
    # narrowing by a different control. `law` is the one branch that still
    # subtracts everything else, because there the reader asked for the law
    # alone.
    if shelf == "session":
        return frozenset({"session", "base"})
    if shelf == "project":
        return frozenset({"project", "session", "base"})
    if shelf == "archiv":
        return frozenset({"archiv", "session", "base"})
    preset = _normalize_preset(source_preset)
    if preset == "law":
        return frozenset({"base"})
    if preset == "project":
        return frozenset({"project", "session", "base"})
    if preset == "office":
        return frozenset({"archiv", "session", "base"})
    return None


def set_turn_intent(
    *,
    file_name: object = None,
    shelf: object = None,
    source_preset: object = None,
) -> None:
    """Replace the whole turn intent. Every extract path goes through here."""
    trimmed = file_name.strip() if isinstance(file_name, str) else ""
    _focused_file_name.set(trimmed or None)
    _focused_shelf.set(_normalize_shelf(shelf))
    _turn_shelves.set(shelves_for_turn(focus_shelf=shelf, source_preset=source_preset))


def set_focused_file_name(name: str | None) -> None:
    """Name-only setter kept for callers that do not know a shelf.

    Clears shelf/preset so a leftover turn-shelf set cannot ride along.
    """
    set_turn_intent(file_name=name)


def set_focus(
    *,
    file_name: str | None = None,
    shelf: str | None = None,
    source_preset: object = None,
    include_shelves: object = None,
) -> None:
    """Back-compat wrapper. Prefer :func:`set_turn_intent`.

    ``include_shelves`` is ignored — the mapping owns the expansion so a
    client cannot ask for Archiv while claiming a project file.
    """
    del include_shelves
    set_turn_intent(file_name=file_name, shelf=shelf, source_preset=source_preset)


def get_focused_file_name() -> str | None:
    return _focused_file_name.get()


def get_focused_shelf() -> str | None:
    return _focused_shelf.get()


def get_turn_shelves() -> frozenset[str] | None:
    return _turn_shelves.get()
