"""the four file verbs Piloti gets, and nothing else.

``ls``, ``read_file``, ``write_file``, ``edit_file`` — stock DeepAgents tools
over :class:`~aiq_agent.tools.documents.draft_store.DraftBackend`. ``glob``,
``grep`` and ``execute`` are built by the same middleware and dropped here:
over one flat directory of at most a handful of files, a search verb buys
nothing and costs a tool call, and ``execute`` has no sandbox behind it.

The descriptions are German, because the model writes German documents and the
tool description is the last thing it reads before choosing a verb. Two things
they deliberately do NOT say:

* **"You must read the file before editing it."** DeepAgents' stock text claims
  it; nothing enforces it here, and an instruction the system does not check is
  one the model learns to ignore.
* **Anything about filing.** The working directory is not the project. What a
  draft becomes is decided by a person, through the lifecycle API.
"""

from __future__ import annotations

import logging

from deepagents.middleware.filesystem import FilesystemMiddleware
from deepagents.middleware.filesystem import FilesystemPermission
from langchain_core.tools import BaseTool

from aiq_agent.project_context import get_conversation_id_from_context

from .draft_store import DRAFT_ROOT
from .draft_store import DraftBackend
from .draft_store import get_draft_backend

logger = logging.getLogger(__name__)

#: The verbs bound into Piloti's tool node, in the order the model
#: meets them. Everything else the middleware builds is dropped.
DRAFT_TOOL_NAMES = ("ls", "read_file", "write_file", "edit_file")

#: Model-facing German, replacing DeepAgents' English. ``edit_file`` carries the
#: two things that actually make an exact-string replacement land: anchor on a
#: heading, and copy the paragraph rather than retyping it — with the warning
#: that ``read_file`` prints line numbers that are not part of the file.
_TOOL_DESCRIPTIONS = {
    "ls": (
        "Listet die Entwürfe dieser Unterhaltung. Der Arbeitsordner liegt unter "
        f"`{DRAFT_ROOT}` und enthält nur, was in dieser Unterhaltung geschrieben wurde — "
        "keine Projektdateien, kein Büroarchiv. Vor einer Überarbeitung aufrufen, wenn der "
        "Pfad des Entwurfs nicht bekannt ist."
    ),
    "read_file": (
        "Liest einen Entwurf aus dem Arbeitsordner. Die Ausgabe ist dem Text jeder Zeile eine "
        "Zeilennummer und ein Tabulator vorangestellt; beides gehört zur Anzeige und nicht zum "
        "Dokument. Vor einer Überarbeitung lesen, damit `old_string` wörtlich aus dem Dokument "
        "stammt."
    ),
    "write_file": (
        "Schreibt ein NEUES Dokument in den Arbeitsordner dieser Unterhaltung, als Markdown "
        f"unter `{DRAFT_ROOT}<name>.md` (kurzer, sprechender Dateiname, Kleinbuchstaben, "
        "Bindestriche). Für ein in Auftrag gegebenes Dokument — Aktenvermerk, Protokoll, "
        "Checkliste, Flächenaufstellung, Konzeptentwurf: das Dokument wird geschrieben, nicht "
        "in der Antwort beschrieben. Das Dokument beginnt mit einer Überschrift (`# …`) und ist "
        "vollständig; die Antwort sagt danach in einem Satz, was geschrieben wurde. "
        "Legt nur neue Dateien an: Gibt es den Pfad schon, ist `edit_file` das Werkzeug."
    ),
    "edit_file": (
        "Überarbeitet einen vorhandenen Entwurf, indem `old_string` genau einmal durch "
        "`new_string` ersetzt wird. `old_string` muss im Dokument eindeutig sein: An einer "
        "Überschrift verankern und den ganzen Absatz von der Überschrift bis zum Ende des zu "
        "ändernden Textes übernehmen, wörtlich aus der Ausgabe von `read_file` — ohne die "
        "vorangestellten Zeilennummern und Tabulatoren. Kommt der Text mehrfach vor, meldet das "
        "Werkzeug die Anzahl; dann mit mehr Umgebung erneut versuchen. Für ein neues Dokument "
        "`write_file` verwenden."
    ),
}

#: Read and write are confined to the one root. The permission is checked in the
#: TOOL, before the backend is reached, so the model gets "permission denied" on
#: a path it invented instead of a storage error; the backend refuses the same
#: paths on its own (``draft_store.path_refusal``), because a second consumer
#: of the backend must not have to remember this list.
_PERMISSIONS = [
    FilesystemPermission(operations=["read", "write"], paths=[f"{DRAFT_ROOT}**"], mode="allow"),
    FilesystemPermission(operations=["read", "write"], paths=["/**"], mode="deny"),
]


def draft_tools(backend: DraftBackend) -> list[BaseTool]:
    """The four verbs bound to one conversation's working directory."""
    middleware = FilesystemMiddleware(
        backend=backend,
        custom_tool_descriptions=_TOOL_DESCRIPTIONS,
        _permissions=_PERMISSIONS,
    )
    by_name = {tool.name: tool for tool in middleware.tools}
    return [by_name[name] for name in DRAFT_TOOL_NAMES if name in by_name]


async def draft_tools_for_turn() -> list[BaseTool]:
    """The working-directory tools for the turn in context; ``[]`` when there is none.

    No conversation id means there is nothing to namespace a working directory
    by (a CLI run, an eval, a job worker), so the turn is offered no file verbs
    at all rather than a directory shared by everyone. A store that cannot be
    reached is the same answer: the turn answers without drafting, which is what
    every turn did before this existed.
    """
    conversation_id = get_conversation_id_from_context()
    if not conversation_id:
        return []
    try:
        backend = await get_draft_backend(conversation_id)
    except Exception:  # noqa: BLE001 - a working directory is never worth the turn
        logger.warning("Working directory unavailable; this turn is answered without it.", exc_info=True)
        return []
    return draft_tools(backend)
