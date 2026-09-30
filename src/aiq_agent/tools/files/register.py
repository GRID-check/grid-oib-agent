"""The write-side workspace tool. It proposes; it never changes anything.

ONE tool, ``propose_file_change``, with an ``operation`` of ``move``,
``rename``, ``create_folder`` or ``assign``. It resolves its arguments against
what the turn can already see (``resolve.py``), emits one
``file_operation_proposal`` card, and returns text that says in its first words
that NOTHING has been changed.

It used to be four tools, one per operation. They shared the card, the
contract, the resolver and every refusal; what differed was one or two
arguments. Four names cost the model four choices and ~760 tokens of schema on
every call for what a person thinks of as one act — "tidy the files" — so the
operation is an argument now (docs/architecture/agent-tool-surface.md). The
card's ``operation`` vocabulary is unchanged, so the frontend executor and every
stored card read exactly as before.

The reason is the invariant in ``src/aiq_agent/tools/AGENTS.md``: the BFF is
the single writer of ``grid_app`` (ADR-0003), so this tier has no route to a
document row and must not grow one. Accepting the card runs the change through
the same endpoints the Files pane uses, in the reader's own session, where
``requireProjectAccess`` and the audit trail already are. A tool here that
wrote directly would bypass all three in one call — and would do it on behalf
of a user who never saw what was about to happen.

The descriptions and the results are GERMAN, like the working directory's four
verbs and unlike ``remember``: every argument these tools take is a name the
user typed in German — a file, a folder, a colleague — and the
refusals are written to be turned straight into the sentence the model says
back („welche der beiden Dateien meinst du?").
"""

from __future__ import annotations

import logging

from aiq_agent import project_context
from aiq_agent.tools.files.cards import propose_file_operation
from aiq_agent.tools.files.resolve import Refusal
from aiq_agent.tools.files.resolve import ResolvedDocument
from aiq_agent.tools.files.resolve import known_folders
from aiq_agent.tools.files.resolve import resolve_document
from aiq_agent.tools.files.resolve import resolve_folder
from nat.plugin_api import Builder
from nat.plugin_api import FunctionBaseConfig
from nat.plugin_api import FunctionInfo
from nat.plugin_api import register_function

logger = logging.getLogger(__name__)

#: The sentence every successful call ends on. It leads with the negative
#: because that is the part the model gets wrong: a tool that returns
#: „Verschoben" in any form produces an answer claiming the file has moved,
#: and the reader then finds it where it was. ``remember``'s card path says
#: the same thing for the same reason.
_PROPOSED = (
    "Ein Vorschlag wurde als Karte angezeigt. Es wurde NOCH NICHTS geändert — "
    "sage nicht, dass es erledigt ist; die Nutzerin entscheidet auf der Karte."
)

#: No card channel, no proposal. Never dressed up as success.
_NO_CARD = (
    "Fehler: In dieser Ausführung gibt es keinen Kartenkanal, der Vorschlag konnte also nicht "
    "angezeigt werden. Es wurde nichts geändert. Sage der Nutzerin, dass sie den Vorgang selbst "
    "in der Dateiablage vornehmen muss."
)

#: Every operation acts on a project's workspace: folders are
#: project-scoped and the reader's session applies the change against a
#: project. A chat with no project in scope has nothing to organise.
_NO_PROJECT = (
    "Fehler: Diese Unterhaltung gehört zu keinem Projekt, deshalb gibt es keine Ablage, in der "
    "etwas geordnet werden könnte. Es wurde nichts geändert. Nicht erneut versuchen."
)


def _project_or_error() -> str | None:
    """``None`` when a project is in scope, else the message to hand back."""
    return None if project_context.get_project_id_from_context() else _NO_PROJECT


def _document(name: str) -> ResolvedDocument | str:
    """Resolve a document argument, flattening a refusal to its message."""
    resolved = resolve_document(name)
    return resolved.message if isinstance(resolved, Refusal) else resolved


# ── the four operations ─────────────────────────────────────────────────────
# Each returns the result text. A proposal that could be shown ends on
# `_PROPOSED`; anything else is a refusal the model can turn into its answer.


def _move(document: str, target_folder: str) -> str:
    resolved = _document(document)
    if isinstance(resolved, str):
        return resolved
    folder = resolve_folder(target_folder)
    if isinstance(folder, Refusal):
        return folder.message
    if folder == resolved.folder_path:
        where = f"„{folder}“" if folder else "der obersten Ebene"
        return f"`{resolved.file_name}` liegt bereits in {where}. Kein Vorschlag nötig."

    item = {
        "document": resolved.file_name,
        "source": resolved.source,
        "current": resolved.folder_path,
        "target_folder": folder,
    }
    title = f"Verschieben nach „{folder}“" if folder else "Auf die oberste Ebene verschieben"
    if not propose_file_operation(operation="move", title=title, item=item):
        return _NO_CARD
    return f"Vorgeschlagen: `{resolved.file_name}` → {folder or 'oberste Ebene'}. {_PROPOSED}"


#: Same ceiling the BFF's rename route enforces
#: (``MAX_DOCUMENT_NAME_LENGTH`` in ``lib/documents/display-name.ts``). Checked
#: here so a name that is too long is refused where the model can fix it,
#: rather than on a card the reader has already pressed.
MAX_DISPLAY_NAME_CHARS = 255


def _rename(document: str, new_name: str) -> str:
    resolved = _document(document)
    if isinstance(resolved, str):
        return resolved
    name = " ".join((new_name or "").split())
    if not name:
        return "Fehler: `new_name` ist leer. Nenne den neuen Anzeigenamen."
    if len(name) > MAX_DISPLAY_NAME_CHARS:
        return f"Fehler: Der neue Name ist länger als {MAX_DISPLAY_NAME_CHARS} Zeichen. Kürze ihn."
    if name == resolved.file_name:
        return f"`{resolved.file_name}` heißt bereits so. Kein Vorschlag nötig."

    item = {
        "document": resolved.file_name,
        "source": resolved.source,
        "current": resolved.file_name,
        "new_display_name": name,
    }
    if not propose_file_operation(operation="rename", title="Datei umbenennen", item=item):
        return _NO_CARD
    return f"Vorgeschlagen: `{resolved.file_name}` → „{name}“. {_PROPOSED}"


#: One segment. The BFF's own folder validation refuses separators
#: (``lib/projects/folders.ts``); refusing them here keeps the model's mistake
#: on the tool result, where it can still fix it.
_FOLDER_NAME_MAX = 120


def _create_folder(name: str, parent: str) -> str:
    folder_name = " ".join((name or "").split())
    if not folder_name:
        return "Fehler: `new_name` ist leer. Nenne den Namen des neuen Ordners."
    if "/" in folder_name or "\\" in folder_name:
        return (
            "Fehler: `new_name` ist EIN Ordnername ohne Schrägstriche. Für einen Unterordner den "
            "übergeordneten Pfad in `target_folder` angeben."
        )
    if len(folder_name) > _FOLDER_NAME_MAX:
        return f"Fehler: Ordnernamen sind auf {_FOLDER_NAME_MAX} Zeichen begrenzt. Kürze ihn."

    parent_path = resolve_folder(parent)
    if isinstance(parent_path, Refusal):
        return parent_path.message
    full = f"{parent_path}/{folder_name}" if parent_path else folder_name
    if full.casefold() in {folder.casefold() for folder in known_folders()}:
        return f"Den Ordner „{full}“ gibt es bereits. Kein Vorschlag nötig; du kannst direkt hineinlegen."

    item = {"folder_name": folder_name, "parent_folder": parent_path, "current": full}
    if not propose_file_operation(operation="create_folder", title="Neuen Ordner anlegen", item=item):
        return _NO_CARD
    return f"Vorgeschlagen: neuer Ordner „{full}“. {_PROPOSED}"


def _assign(document: str, member: str) -> str:
    resolved = _document(document)
    if isinstance(resolved, str):
        return resolved
    person = " ".join((member or "").split())
    if not person:
        return "Fehler: `member` ist leer. Nenne die Person so, wie die Nutzerin sie genannt hat."

    item = {"document": resolved.file_name, "source": resolved.source, "member": person}
    if not propose_file_operation(operation="assign", title="Datei zuweisen", item=item):
        return _NO_CARD
    return f"Vorgeschlagen: `{resolved.file_name}` → {person}. {_PROPOSED}"


# ── propose_file_change ─────────────────────────────────────────────────────

_DESCRIPTION = (
    "SCHLÄGT eine Änderung an der Dateiablage VOR — ändert selbst nichts. Es entsteht eine Karte, die "
    "die Nutzerin annimmt oder verwirft; erst dann wird es ausgeführt, in ihrer eigenen Sitzung. "
    "Nur vorschlagen, wenn die Nutzerin darum bittet („leg die Einreichunterlagen in einen Ordner“, "
    "„benenn das um“, „gib das Anna“) oder ein Name nachweislich falsch ist.\n"
    "`operation` und was sie braucht:\n"
    "- `move`: `document` in den vorhandenen Ordner `target_folder` (Pfad wie 'Einreichung/Pläne', "
    "leer = oberste Ebene).\n"
    "- `rename`: `document` bekommt den Anzeigenamen `new_name` (der gespeicherte Dateiname bleibt).\n"
    "- `create_folder`: neuer Ordner `new_name` (EIN Segment, keine Schrägstriche) unter "
    "`target_folder` (leer = oberste Ebene). Danach kann `move` hineinlegen; die Nutzerin nimmt die "
    "Karten in dieser Reihenfolge an.\n"
    "- `assign`: `document` an die Person `member`, so wie die Nutzerin sie genannt hat (Name oder "
    "E-Mail) — hier nicht geprüft, sondern beim Annehmen gegen die Projektmitglieder aufgelöst. Nur "
    "vorschlagen, wenn die Nutzerin die Person selbst genannt hat, und den Namen unverändert übernehmen; "
    "nie eine Person aus dem Zusammenhang erschließen.\n"
    "`document` ist der Dateiname genau so, wie ihn die Übersicht oder `list_files` zeigt. Mehrere "
    "Aufrufe derselben Operation in einer Antwort sammeln sich auf EINER Karte: „räum die "
    "Einreichunterlagen zusammen“ bleibt eine Entscheidung, nicht vier."
)

_OPERATIONS = ("move", "rename", "create_folder", "assign")


class ProposeFileChangeConfig(FunctionBaseConfig, name="propose_file_change"):
    """Configuration for the ``propose_file_change`` proposal tool."""


@register_function(config_type=ProposeFileChangeConfig)
async def propose_file_change(tool_config: ProposeFileChangeConfig, builder: Builder):
    async def _propose(
        operation: str,
        document: str = "",
        target_folder: str = "",
        new_name: str = "",
        member: str = "",
    ) -> str:
        """Propose one change to the project's files: move, rename, create_folder or assign.

        Args:
            operation: move | rename | create_folder | assign.
            document: The file, exactly as the overview or `list_files` names it (move, rename, assign).
            target_folder: Existing folder path; the destination for move, the parent for create_folder.
            new_name: The new display name (rename) or the new folder's name (create_folder).
            member: The person, as the user named them (assign).
        """
        if (refused := _project_or_error()) is not None:
            return refused
        op = (operation or "").strip().lower()
        if op == "move":
            return _move(document, target_folder)
        if op == "rename":
            return _rename(document, new_name)
        if op == "create_folder":
            return _create_folder(new_name, target_folder)
        if op == "assign":
            return _assign(document, member)
        return f"Fehler: `operation` muss eine von {', '.join(_OPERATIONS)} sein."

    yield FunctionInfo.from_fn(_propose, description=_DESCRIPTION)
