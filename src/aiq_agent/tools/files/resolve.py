"""Resolving what the reader said to what the turn can see.

The four write-side tools take NAMES — a file name, a folder path, a person —
because that is what the conversation contains. None of them may guess: a
proposal card that names a file the reader does not have is a decision they
cannot make, and one that names the WRONG file is worse than no card at all.

So everything here resolves against what the turn ALREADY knows and refuses
otherwise, with a message written for the model to act on rather than an
exception:

* documents come from the turn's inventory rows
  (:func:`aiq_agent.knowledge.inventory.get_turn_documents`) — the same rows
  the prompt's inventory block is rendered from, so the model can only name
  what it was shown;
* folders come from the ``folder_path`` those rows carry (ADR-0049 puts the
  materialised path on the row, so no join is needed) plus every ancestor of
  one, which is the whole folder tree the turn can see;
* a PERSON is the exception and is deliberately not resolved here at all. The
  turn carries no member roster — the project brief has no members block and
  no header carries one — so this tier has nothing to check a name against.
  The card carries the name as the user wrote it and the reader's own session
  resolves it against the project's assignment candidates, where the roster
  actually lives. Inventing a match here would be the guess this module exists
  to prevent.

Names are NFC-normalised on both sides before they are compared. macOS writes
filenames decomposed, the model retypes them composed, and the two render
identically — the same seam ``draft_store`` normalises for the same reason
(``docs/contributing/gotchas.md``).
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from typing import Any
from typing import Literal

from aiq_agent.common.source_kinds import Shelf
from aiq_agent.common.source_kinds import parse_shelf
from aiq_agent.knowledge.inventory import get_turn_documents

#: The two shelves a workspace operation can touch. `base` is the platform
#: corpus (nobody's to organise) and `session` is this chat's own attachments,
#: which are not project documents and have no folder to move into.
DocumentSource = Literal["projekt", "buero"]

_SHELF_SOURCES: dict[Shelf, DocumentSource] = {Shelf.PROJECT: "projekt", Shelf.ARCHIV: "buero"}

#: How many candidate names an ambiguity message lists before it stops. The
#: message exists so the model can ask a precise question; twenty names is not
#: a question.
_MAX_NAMED_CANDIDATES = 8


def _nfc(value: str) -> str:
    return unicodedata.normalize("NFC", value or "").strip()


def _key(value: str) -> str:
    return _nfc(value).casefold()


def _attr(row: Any, name: str) -> Any:
    return row.get(name) if isinstance(row, dict) else getattr(row, name, None)


@dataclass(frozen=True)
class Refusal:
    """Why a name could not be resolved, in the words the model gets back.

    A distinct type rather than a bare string, because a resolver can succeed
    WITH a string — a folder path is one — and ``str | str`` is not a signature
    anyone can read. The tools return ``refusal.message`` unchanged: it is
    written for the model to act on (ask for the exact name, offer what
    exists), so rewording it at the call site would only make it vaguer.
    """

    message: str


@dataclass(frozen=True)
class ResolvedDocument:
    """One document the turn can see, as the card needs to carry it."""

    file_name: str
    source: DocumentSource
    #: The folder it sits in today, ``""`` for the project root.
    folder_path: str


def _rows() -> list[ResolvedDocument]:
    """The turn's inventory, narrowed to documents a workspace verb may touch."""
    out: list[ResolvedDocument] = []
    for row in get_turn_documents():
        source = _SHELF_SOURCES.get(parse_shelf(_attr(row, "shelf")))
        file_name = _nfc(str(_attr(row, "file_name") or ""))
        if source is None or not file_name:
            continue
        out.append(
            ResolvedDocument(
                file_name=file_name,
                source=source,
                folder_path=_nfc(str(_attr(row, "folder_path") or "")),
            )
        )
    return out


def _named(candidates: list[ResolvedDocument]) -> str:
    shown = [f"`{doc.file_name}`" for doc in candidates[:_MAX_NAMED_CANDIDATES]]
    rest = len(candidates) - len(shown)
    return ", ".join(shown) + (f" (und {rest} weitere)" if rest > 0 else "")


def resolve_document(name: str) -> ResolvedDocument | Refusal:
    """One document for ``name``, or the message to hand back to the model.

    Three passes, each narrower than a search: the exact file name, the name
    without its extension, then a substring. A pass that matches more than one
    document does NOT fall through to the next one — two files that both
    contain „Brandschutz" are an ambiguity to ask about, not a ranking to pick
    a winner from.
    """
    wanted = _key(name)
    if not wanted:
        return Refusal(
            "Fehler: Es wurde kein Dateiname übergeben. Nenne die Datei genau so, wie sie in der Übersicht steht."
        )

    rows = _rows()
    if not rows:
        return Refusal(
            "Fehler: Diese Unterhaltung sieht keine Projekt- oder Büroarchiv-Dateien, also gibt es nichts "
            "zu ordnen. Sage das, statt einen Vorschlag zu machen."
        )

    for candidates in (
        [doc for doc in rows if _key(doc.file_name) == wanted],
        [doc for doc in rows if _key(doc.file_name.rsplit(".", 1)[0]) == wanted],
        [doc for doc in rows if wanted in _key(doc.file_name)],
    ):
        if len(candidates) == 1:
            return candidates[0]
        if len(candidates) > 1:
            return Refusal(
                f"Mehrdeutig: „{_nfc(name)}“ passt auf {_named(candidates)}. Frage die Nutzerin, welche Datei "
                "gemeint ist, und rufe das Werkzeug mit dem genauen Dateinamen erneut auf."
            )

    return Refusal(
        f"Nicht gefunden: „{_nfc(name)}“ steht nicht in der Dateiübersicht dieser Unterhaltung. Nenne den "
        "genauen Dateinamen aus der Übersicht oder frage die Nutzerin danach — rate nicht."
    )


def known_folders() -> list[str]:
    """Every folder path the turn can see, ancestors included, sorted.

    Built from the ``folder_path`` on the inventory rows, so it is the tree as
    far as filed documents reveal it. A folder nobody has filed anything into
    is invisible here — which is why ``create_folder`` exists, and why a move
    into an unknown folder is refused rather than silently creating one.
    """
    paths: set[str] = set()
    for doc in _rows():
        if not doc.folder_path:
            continue
        segments = [segment for segment in doc.folder_path.split("/") if segment.strip()]
        for depth in range(1, len(segments) + 1):
            paths.add("/".join(segments[:depth]))
    return sorted(paths, key=str.casefold)


#: What the reader calls the project root, in both languages the tools meet it
#: in. An empty string is the root on the wire.
_ROOT_WORDS = frozenset({"", "/", ".", "root", "stamm", "projektstamm", "hauptordner", "oberste ebene"})


def resolve_folder(path: str) -> str | Refusal:
    """An existing folder path for ``path``, ``""`` for the root, or a message.

    Matching is by full path first and then by a unique LAST SEGMENT, because
    „leg das in die Pläne" names the folder and not its lineage. Case- and
    NFC-insensitive, like every other name here; the stored spelling is what
    comes back, so the card shows the folder as the project spells it.
    """
    wanted = _key(path)
    if wanted in _ROOT_WORDS:
        return ""

    folders = known_folders()
    if not folders:
        return Refusal(
            f"Nicht gefunden: Dieses Projekt hat noch keine Ordner, „{_nfc(path)}“ also auch nicht. Schlage mit "
            "`create_folder` einen Ordner vor, bevor du etwas hineinlegst."
        )

    for candidates in (
        [folder for folder in folders if _key(folder) == wanted],
        [folder for folder in folders if _key(folder.rsplit("/", 1)[-1]) == wanted],
    ):
        if len(candidates) == 1:
            return candidates[0]
        if len(candidates) > 1:
            listed = ", ".join(f"`{folder}`" for folder in candidates[:_MAX_NAMED_CANDIDATES])
            return Refusal(f"Mehrdeutig: „{_nfc(path)}“ passt auf {listed}. Frage nach, welcher Ordner gemeint ist.")

    listed = ", ".join(f"`{folder}`" for folder in folders[:_MAX_NAMED_CANDIDATES])
    return Refusal(
        f"Nicht gefunden: Es gibt keinen Ordner „{_nfc(path)}“. Vorhanden sind: {listed}. Nenne einen davon "
        "oder schlage den neuen Ordner erst mit `create_folder` vor."
    )
