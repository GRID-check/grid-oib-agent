"""The four write-side workspace tools. Every one of them proposes.

``move_document``, ``rename_document``, ``create_folder`` and
``assign_document``. Each resolves its arguments against what the turn can
already see (``resolve.py``), emits one ``file_operation_proposal`` card, and
returns text that says in its first words that NOTHING has been changed.

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
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

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

#: Every one of the five acts on a project's workspace: folders are
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


# ── move_document ────────────────────────────────────────────────────────────

_MOVE_DESCRIPTION = (
    "SCHLÄGT VOR, eine Projekt- oder Büroarchiv-Datei in einen vorhandenen Ordner zu verschieben. "
    "Verschiebt nichts: Es entsteht eine Karte, die die Nutzerin annimmt oder verwirft — erst dann "
    "wird verschoben, in ihrer eigenen Sitzung. `document` ist der Dateiname genau so, wie er in der "
    "Dateiübersicht steht; `target_folder` ist ein Ordnerpfad, der es bereits gibt (z. B. "
    "'Einreichung/Pläne'), oder eine leere Zeichenkette für die oberste Ebene. Gibt es den Ordner noch "
    "nicht, zuerst `create_folder` aufrufen. Mehrere Aufrufe in derselben Antwort sammeln sich auf EINER "
    "Karte, damit „räum die Einreichunterlagen zusammen“ eine Entscheidung bleibt und nicht vier."
)


class MoveDocumentConfig(FunctionBaseConfig, name="move_document"):
    """Configuration for the ``move_document`` proposal tool."""


@register_function(config_type=MoveDocumentConfig)
async def move_document(tool_config: MoveDocumentConfig, builder: Builder):
    async def _move(document: str, target_folder: str = "") -> str:
        """Propose moving one document into an existing folder."""
        if (refused := _project_or_error()) is not None:
            return refused
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

    yield FunctionInfo.from_fn(_move, description=_MOVE_DESCRIPTION)


# ── rename_document ──────────────────────────────────────────────────────────

_RENAME_DESCRIPTION = (
    "SCHLÄGT VOR, den Anzeigenamen einer Datei zu ändern. Benennt nichts um: Die Nutzerin entscheidet "
    "auf der Karte. `document` ist der Dateiname aus der Übersicht, `new_display_name` der neue "
    "Anzeigename (der Dateiname auf der Platte bleibt, was er ist). Nur vorschlagen, wenn die Nutzerin "
    "eine Umbenennung will oder ein Name nachweislich falsch ist — nicht, um Namen zu vereinheitlichen, "
    "nach denen niemand gefragt hat."
)

#: Same ceiling the BFF's rename route enforces
#: (``MAX_DOCUMENT_NAME_LENGTH`` in ``lib/documents/display-name.ts``). Checked
#: here so a name that is too long is refused where the model can fix it,
#: rather than on a card the reader has already pressed.
MAX_DISPLAY_NAME_CHARS = 255


class RenameDocumentConfig(FunctionBaseConfig, name="rename_document"):
    """Configuration for the ``rename_document`` proposal tool."""


@register_function(config_type=RenameDocumentConfig)
async def rename_document(tool_config: RenameDocumentConfig, builder: Builder):
    async def _rename(document: str, new_display_name: str) -> str:
        """Propose a new display name for one document."""
        if (refused := _project_or_error()) is not None:
            return refused
        resolved = _document(document)
        if isinstance(resolved, str):
            return resolved
        name = " ".join((new_display_name or "").split())
        if not name:
            return "Fehler: `new_display_name` ist leer. Nenne den neuen Namen."
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

    yield FunctionInfo.from_fn(_rename, description=_RENAME_DESCRIPTION)


# ── create_folder ────────────────────────────────────────────────────────────

_CREATE_FOLDER_DESCRIPTION = (
    "SCHLÄGT VOR, im Projekt einen neuen Ordner anzulegen. Legt nichts an: Die Nutzerin entscheidet auf "
    "der Karte. `name` ist der Name des neuen Ordners (EIN Segment, keine Schrägstriche); `parent` ist "
    "der Pfad eines vorhandenen Ordners oder eine leere Zeichenkette für die oberste Ebene. Danach kann "
    "`move_document` Dateien hineinlegen — beide Vorschläge stehen dann als zwei Karten nebeneinander, "
    "und die Nutzerin nimmt sie in dieser Reihenfolge an."
)

#: One segment. The BFF's own folder validation refuses separators
#: (``lib/projects/folders.ts``); refusing them here keeps the model's mistake
#: on the tool result, where it can still fix it.
_FOLDER_NAME_MAX = 120


class CreateFolderConfig(FunctionBaseConfig, name="create_folder"):
    """Configuration for the ``create_folder`` proposal tool."""


@register_function(config_type=CreateFolderConfig)
async def create_folder(tool_config: CreateFolderConfig, builder: Builder):
    async def _create(name: str, parent: str = "") -> str:
        """Propose one new project folder."""
        if (refused := _project_or_error()) is not None:
            return refused
        folder_name = " ".join((name or "").split())
        if not folder_name:
            return "Fehler: `name` ist leer. Nenne den Ordnernamen."
        if "/" in folder_name or "\\" in folder_name:
            return (
                "Fehler: `name` ist EIN Ordnername ohne Schrägstriche. Für einen Unterordner den "
                "übergeordneten Pfad in `parent` angeben."
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

    yield FunctionInfo.from_fn(_create, description=_CREATE_FOLDER_DESCRIPTION)


# ── assign_document ──────────────────────────────────────────────────────────

_ASSIGN_DESCRIPTION = (
    "SCHLÄGT VOR, eine Datei einer Person im Projekt zuzuweisen. Weist nichts zu: Die Nutzerin "
    "entscheidet auf der Karte. `member` ist die Person so, wie sie in der Unterhaltung genannt wurde "
    "(Name oder E-Mail) — DIESE Ausführung kennt die Projektmitglieder nicht und prüft den Namen nicht; "
    "aufgelöst wird er beim Annehmen, gegen die tatsächliche Mitgliederliste des Projekts. Deshalb nur "
    "vorschlagen, wenn die Nutzerin die Person selbst genannt hat, und den Namen unverändert übernehmen."
)


class AssignDocumentConfig(FunctionBaseConfig, name="assign_document"):
    """Configuration for the ``assign_document`` proposal tool."""


@register_function(config_type=AssignDocumentConfig)
async def assign_document(tool_config: AssignDocumentConfig, builder: Builder):
    async def _assign(document: str, member: str) -> str:
        """Propose assigning one document to one person."""
        if (refused := _project_or_error()) is not None:
            return refused
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

    yield FunctionInfo.from_fn(_assign, description=_ASSIGN_DESCRIPTION)
