"""``project_lookup``: a solo chat looks across the office's other projects (ADR-0093).

## One tool, three actions

Search documents across projects, find projects by name or address, read one
project's brief. One tool with an ``action``, not three: every bound tool's
schema rides on every model call of every chat turn, and tool narrowing is off
in production. ``propose_file_change`` is the precedent.

## What the BFF decides and what this decides

The BFF decides everything about access (which projects, which folders, whether
this chat may look at all), records what it hands out on the conversation
before it answers, and refuses a chat that is not the asker's alone; this tool
echoes the envelope and words the answer. See ``client.py``.

## What the model may do with an answer

A search hit is rendered as an ordinary grounding hit (ADR-0061), with a
``Projekt:`` line naming where it is from, and cited by its key like any other
source. Its passage is all there is: another project's document is not in the
turn's scope, so ``read_passage`` cannot open it further, which is why the BFF
returns a longer passage than a hit list does.

Everything an answer carries was recorded by the BFF before it was returned,
so the tool tells the turn (:func:`note_cross_project_hand_out`): the admission
lets exactly these collections through, and every door a whole project reads
(memory, tasks, deep research, the profile, filing) is shut for the rest of the
conversation.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Annotated
from typing import Any
from typing import Literal

from pydantic import BeforeValidator

from aiq_agent import project_context
from aiq_agent.common.grounding_block import PROJECT_STATUS_LABELS
from aiq_agent.common.grounding_block import GroundingBlock
from aiq_agent.common.grounding_block import GroundingHit
from aiq_agent.common.grounding_block import SourceProject
from aiq_agent.common.grounding_block import render_grounding_block
from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.restricted_use import note_collections_read
from aiq_agent.knowledge.restricted_use import note_cross_project_hand_out
from aiq_agent.turn.response import turn_answer_message_id
from nat.plugin_api import Builder
from nat.plugin_api import FunctionBaseConfig
from nat.plugin_api import FunctionInfo
from nat.plugin_api import register_function

from ..documents.filing import SignedEnvelope
from .client import BRIEF_PATH
from .client import PROJECTS_PATH
from .client import SEARCH_PATH
from .client import CrossProjectLookupError
from .client import post_lookup

logger = logging.getLogger(__name__)

#: The tool's basename, as the ``sources`` step names it.
PROJECT_LOOKUP_TOOL = "project_lookup"

#: The ingestion tags' closed vocabularies, mirrored from
#: ``knowledge/document_classification.py`` (the BFF validates against its own
#: mirror, ``lib/documents/tag-vocabulary.ts``). Literal, so a provider
#: constrains the argument before it is sent.
DocumentType = Literal[
    "Bebauungsplan",
    "Flächenwidmungsplan",
    "Grundriss",
    "Schnitt",
    "Ansicht",
    "Detail",
    "Gutachten",
    "Bescheid",
    "Norm/Richtlinie",
    "Vertrag",
    "Foto",
    "Sonstiges",
]
Discipline = Literal[
    "Standsicherheit",
    "Brandschutz",
    "Hygiene/Gesundheit/Umweltschutz",
    "Nutzungssicherheit/Barrierefreiheit",
    "Schallschutz",
    "Energieeinsparung/Wärmeschutz",
]


def _normalized(value: object) -> object:
    return value.strip().lower() if isinstance(value, str) else value


Action = Annotated[Literal["search", "find", "brief"], BeforeValidator(_normalized)]
Scope = Annotated[Literal["all", "closed", "named"], BeforeValidator(_normalized)]

_DESCRIPTION = (
    "Schlägt in ANDEREN Projekten des Büros nach, nur in einem Chat, der der Nutzerin allein gehört. "
    "Nur aufrufen, wenn die Frage wirklich andere Projekte betrifft („wie haben wir das beim Holzbau in "
    "Graz gelöst“, „welche abgeschlossenen Projekte hatten …“); das Projekt dieses Chats ist nie dabei, "
    "dafür die üblichen Werkzeuge. `action`: "
    "`search` durchsucht Dokumente (`query` nötig; `scope` `all` = alle Projekte, in denen sie chatten "
    "darf, `closed` = abgeschlossene, `named` = nur `project_ids`; optional `document_types`, "
    "`disciplines`, `period_from`/`period_to` als JJJJ-MM-TT für den Projektzeitraum). Ein Aufruf "
    "durchsucht höchstens 8 Projekte; nennt das Ergebnis eine nächste Seite, mit `offset` weiter. "
    "`find` listet Projekte mit Status, Zeitraum und Adresse (`query` sucht in Name und Adresse). "
    "`brief` liest die bestätigten Eckdaten und die Zusammenfassung eines Projekts (`project_id` aus "
    "`find` oder einem Treffer). "
    "Treffer zitierst du wie jede Quelle über ihren Citation-Schlüssel und nennst das Projekt. Die "
    "Passage ist alles, was es gibt: Dokumente anderer Projekte lassen sich nicht weiter öffnen. "
    "Was aus einem anderen Projekt in diesem Chat steht, schließt ihn: Er ist dann nur noch mit "
    "Personen teilbar, die diese Projekte öffnen dürfen, und nichts daraus geht ins "
    "Projektgedächtnis, in Aufträge, Tiefenrecherche oder die Ablage."
)

_NO_ENVELOPE = (
    "Fehler: Dieser Lauf hat keinen signierten Sitzungsnachweis, deshalb kann nicht in anderen Projekten "
    "nachgeschlagen werden. Nicht erneut versuchen."
)
_UNREACHABLE = (
    "Fehler: Das Nachschlagen in anderen Projekten ist gerade nicht erreichbar. Sage der Nutzerin, dass "
    "es nicht geklappt hat; nicht in derselben Antwort erneut versuchen."
)
_NOT_FOUND = (
    "Dieses Projekt gibt es nicht, oder die Nutzerin darf darin nicht chatten. Nimm eine project_id aus `find`."
)

#: Said once per answer that handed content out: the doors it shut.
_CLOSED_DOORS = (
    "[Dieser Chat stützt sich jetzt auf andere Projekte: kein Projektgedächtnis, keine Aufträge, keine "
    "Tiefenrecherche, keine Ablage ins Projekt, und teilbar nur mit Personen, die diese Projekte öffnen "
    "dürfen.]"
)


class ProjectLookupConfig(FunctionBaseConfig, name="project_lookup"):
    """Configuration for the ``project_lookup`` tool."""


class _Refused(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def _envelope() -> SignedEnvelope:
    header, signature = project_context.get_request_envelope_from_context()
    if not header or not signature:
        raise _Refused(_NO_ENVELOPE)
    return SignedEnvelope(header=header, signature=signature)


def _with_answer(payload: dict[str, Any]) -> dict[str, Any]:
    """The body, naming the answer this turn writes (ADR-0092).

    The BFF marks that answer in the transaction that records what the lookup
    hands out, when the conversation then drew on a restricted folder, as the
    restricted-use admission does: a vote on it is judged by the server's record
    whether or not the answer is ever persisted. Without a conversation there is
    no answer to name.
    """
    conversation_id = project_context.get_conversation_id_from_context()
    if not conversation_id:
        return payload
    return {**payload, "answerMessageId": turn_answer_message_id(conversation_id)}


async def _call(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    """One lookup, off the event loop, with every refusal worded for the model."""
    envelope = _envelope()
    try:
        return await asyncio.to_thread(post_lookup, path, _with_answer(payload), envelope)
    except CrossProjectLookupError as exc:
        if exc.code == "CROSS_PROJECT_SHARED_CHAT":
            # The BFF's own sentence, in German: relayed to the reader as it is.
            raise _Refused(f"Nicht möglich: {exc}") from exc
        if exc.status == 404:
            raise _Refused(_NOT_FOUND) from exc
        if exc.status in (400, 422):
            raise _Refused(f"Fehler: Die Anfrage war ungültig ({exc}). Korrigiere die Argumente.") from exc
        raise _Refused(_UNREACHABLE) from exc


def _status_label(status: object) -> str:
    return PROJECT_STATUS_LABELS.get(str(status), str(status))


def _text(value: object) -> str:
    return " ".join(str(value).split()) if value is not None else ""


# ---------------------------------------------------------------------------
# search
# ---------------------------------------------------------------------------


def search_payload(
    *,
    query: str,
    scope: str,
    project_ids: list[str],
    document_types: list[str],
    disciplines: list[str],
    period_from: str,
    period_to: str,
    offset: int,
) -> dict[str, Any]:
    """The ``CrossProjectSearchRequest`` body; empty optional arguments are left out."""
    payload: dict[str, Any] = {"query": query.strip(), "scope": scope, "offset": max(0, int(offset))}
    if scope == "named":
        payload["projectIds"] = project_ids
    if document_types:
        payload["documentTypes"] = document_types
    if disciplines:
        payload["disciplines"] = disciplines
    if period_from.strip():
        payload["from"] = period_from.strip()
    if period_to.strip():
        payload["to"] = period_to.strip()
    return payload


#: What the backend appends to a passage it had to cut.
_SNIPPET_ELLIPSIS = "…"


def _hit(raw: dict[str, Any]) -> GroundingHit | None:
    """One BFF hit as a grounding record, or None for one missing what a citation needs."""
    project = raw.get("project") if isinstance(raw.get("project"), dict) else {}
    filename, collection, project_id = raw.get("filename"), raw.get("collection"), project.get("id")
    if not (isinstance(filename, str) and filename and isinstance(collection, str) and project_id):
        return None
    name = _text(project.get("name")) or "Projekt"
    page = raw.get("page") if isinstance(raw.get("page"), int) and raw.get("page") > 0 else None
    snippet = str(raw.get("snippet") or "").strip()
    truncated = snippet.endswith(_SNIPPET_ELLIPSIS)
    # The project qualifies the key: two projects' „Detail Traufe.pdf, p.2" are
    # two documents, and the answer must be able to cite each.
    key = f"{filename} ({name})"
    return GroundingHit(
        citation_key=f"{key}, p.{page}" if page is not None else key,
        file_name=filename,
        page=page,
        shelf=Shelf.PROJECT,
        collection=collection,
        doc_class=None,
        display_title=_text(raw.get("title")) or filename,
        folder_path=None,
        punkt=None,
        score=float(raw.get("score") or 0.0),
        content_type="text",
        provenance=None,
        stored_image_index=None,
        status_note=None,
        body=snippet.removesuffix(_SNIPPET_ELLIPSIS).rstrip() if truncated else snippet,
        body_truncated=truncated,
        project=SourceProject(id=str(project_id), name=name, status=str(project.get("status") or "active")),
    )


def _search_preamble(body: dict[str, Any], hits: tuple[GroundingHit, ...], scope: str) -> list[str]:
    projects = len({hit.project.id for hit in hits if hit.project})
    searched, in_scope = body.get("projectsSearched", 0), body.get("projectsInScope", 0)
    lines = [
        f"Treffer aus anderen Projekten: {len(hits)} Passage(n) aus {projects} Projekt(en); "
        f"{searched} von {in_scope} Projekten durchsucht."
    ]
    next_offset = body.get("nextOffset")
    if isinstance(next_offset, int):
        lines.append(f"[Weitere Projekte nicht durchsucht: dieselbe Suche mit offset={next_offset} setzt fort.]")
    if scope == "closed" and body.get("statusKnown") is False:
        lines.append(
            "[Der Projektstatus wird in diesem Büro noch nicht erfasst, deshalb findet `scope: closed` nichts. "
            "Mit `scope: all` und einem Zeitraum suchen.]"
        )
    if hits:
        lines.append(_CLOSED_DOORS)
    return lines


def _render_search(body: dict[str, Any], scope: str) -> str:
    raw_hits = body.get("hits") if isinstance(body.get("hits"), list) else []
    hits = tuple(hit for hit in (_hit(raw) for raw in raw_hits if isinstance(raw, dict)) if hit is not None)
    preamble = _search_preamble(body, hits, scope)
    if not hits:
        return "\n".join([*preamble, "Keine passenden Dokumente in diesen Projekten."])
    from knowledge_layer.register import _trace_lanes_for_hits

    # Handed out by the BFF, which recorded every one before it answered: what
    # the admission lets through for this turn, and what shuts its doors.
    note_cross_project_hand_out(hit.collection for hit in hits)
    return render_grounding_block(
        GroundingBlock(
            preamble="\n".join(preamble),
            degraded_banner="",
            hits=hits,
            lanes=_trace_lanes_for_hits(list(hits)),
            tool=PROJECT_LOOKUP_TOOL,
        )
    )


# ---------------------------------------------------------------------------
# find and brief
# ---------------------------------------------------------------------------


def _period(raw: object) -> str:
    period = raw if isinstance(raw, dict) else {}
    start, end = period.get("start"), period.get("end")
    if not start:
        return ""
    return f"seit {start}" if not end else f"{start} bis {end}"


def _project_line(project: dict[str, Any]) -> str:
    parts = [f"{_text(project.get('name'))} — {_status_label(project.get('status'))}"]
    if period := _period(project.get("period")):
        parts.append(period)
    if address := _text(project.get("address")):
        parts.append(address)
    line = " · ".join(parts) + f" (project_id {project.get('id')})"
    return f"- {line}" + (" — das Projekt dieses Chats" if project.get("current") else "")


def _hand_out(projects: list[dict[str, Any]]) -> None:
    """Every project an answer named other than the chat's own: recorded by the BFF, noted for the turn."""
    collections = [
        str(project["collection"]) for project in projects if project.get("collection") and not project.get("current")
    ]
    note_collections_read(collections)
    if collections:
        note_cross_project_hand_out(collections)


def _render_find(body: dict[str, Any]) -> str:
    projects = [project for project in body.get("projects") or [] if isinstance(project, dict)]
    if not projects:
        return "Keine Projekte gefunden, in denen die Nutzerin chatten darf."
    _hand_out(projects)
    total = body.get("total", len(projects))
    lines = [f"{len(projects)} von {total} Projekt(en):", *(_project_line(project) for project in projects)]
    if body.get("statusKnown") is False:
        lines.append("[Der Projektstatus wird noch nicht erfasst: alle Projekte gelten als laufend.]")
    if any(not project.get("current") for project in projects):
        lines.append(_CLOSED_DOORS)
    return "\n".join(lines)


def _render_brief(body: dict[str, Any]) -> str:
    project = body.get("project") if isinstance(body.get("project"), dict) else {}
    _hand_out([project])
    lines = [_project_line(project).removeprefix("- ")]
    if summary := _text(body.get("summary")):
        lines.append(f"Zusammenfassung: {summary}")
    facts = str(body.get("facts") or "").strip()
    lines.append(facts if facts else "Keine bestätigten Eckdaten.")
    if not project.get("current"):
        lines.append(_CLOSED_DOORS)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# The tool
# ---------------------------------------------------------------------------


async def _lookup(
    action: str,
    query: str,
    scope: str,
    project_ids: list[str],
    document_types: list[str],
    disciplines: list[str],
    period_from: str,
    period_to: str,
    offset: int,
    project_id: str,
) -> str:
    if action == "search":
        if not query.strip():
            raise _Refused("Fehler: `search` braucht eine `query`.")
        if scope == "named" and not project_ids:
            raise _Refused("Fehler: `scope: named` braucht `project_ids` (aus `find`).")
        payload = search_payload(
            query=query,
            scope=scope,
            project_ids=project_ids,
            document_types=document_types,
            disciplines=disciplines,
            period_from=period_from,
            period_to=period_to,
            offset=offset,
        )
        return _render_search(await _call(SEARCH_PATH, payload), scope)
    if action == "find":
        payload: dict[str, Any] = {}
        if query.strip():
            payload["query"] = query.strip()
        if period_from.strip():
            payload["from"] = period_from.strip()
        if period_to.strip():
            payload["to"] = period_to.strip()
        return _render_find(await _call(PROJECTS_PATH, payload))
    if not project_id.strip():
        raise _Refused("Fehler: `brief` braucht eine `project_id` (aus `find` oder einem Treffer).")
    return _render_brief(await _call(BRIEF_PATH, {"projectId": project_id.strip()}))


async def run_project_lookup(
    action: Action,
    query: str = "",
    scope: Scope = "all",
    project_ids: list[str] | None = None,
    document_types: list[DocumentType] | None = None,
    disciplines: list[Discipline] | None = None,
    period_from: str = "",
    period_to: str = "",
    offset: int = 0,
    project_id: str = "",
) -> str:
    """Look across the office's other projects. Module-level so the refusals are reachable without NAT."""
    try:
        return await _lookup(
            action,
            query or "",
            scope,
            list(project_ids or []),
            list(document_types or []),
            list(disciplines or []),
            period_from or "",
            period_to or "",
            offset or 0,
            project_id or "",
        )
    except _Refused as refused:
        return refused.message


@register_function(config_type=ProjectLookupConfig)
async def project_lookup(tool_config: ProjectLookupConfig, builder: Builder):
    yield FunctionInfo.from_fn(run_project_lookup, description=_DESCRIPTION)
