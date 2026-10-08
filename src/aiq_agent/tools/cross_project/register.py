"""``project_lookup``: a chat looks across the office's other projects (ADR-0085).

The escalation step of docs/design/cross-project-escalation.md: the model
climbs from this project to the office's reference projects on its own, when
the question is comparative or the project's own sources are thin. The turn
context lists the closest closed projects (``<referenzprojekte>``), so the
model knows what is there before it looks.

## One tool, three actions

Search documents across projects, find projects by name or address, read one
project's brief. One tool with an ``action``, not three: every bound tool's
schema rides on every model call of every chat turn, and tool narrowing is off
in production. ``propose_file_change`` is the precedent.

## What the BFF decides and what this decides

The BFF decides everything about access: it searches as the conversation's
whole audience (a solo chat reaches what the asker may chat in, a shared one
what every reader may open, always including the closed projects), records
what it hands out on the conversation before it answers, and refuses when the
audience changed mid-lookup. This tool echoes the envelope and words the
answer. See ``client.py``.

## What the model may do with an answer

A search hit is rendered as an ordinary grounding hit (ADR-0061), with a
``Projekt:`` line naming where it is from, and cited by its key like any other
source. Its passage is all there is: another project's document is not in the
turn's scope, so ``read_passage`` cannot open it further, which is why the BFF
returns a longer passage than a hit list does.

Everything an answer carries was recorded by the BFF before it was returned,
so the tool tells the turn (:func:`note_cross_project_hand_out`): the admission
lets exactly these collections through. Only content that narrows the
conversation's readers (an active project, a restricted folder) shuts the doors
a whole project reads (memory, tasks, deep research, the profile, filing); a
closed project's open folders are read by the whole office and shut nothing.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import date
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
from aiq_agent.common.norm_registry import BUNDESLAND_TOKENS
from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.restricted_collections import is_restricted_collection
from aiq_agent.knowledge.restricted_use import note_collections_read
from aiq_agent.knowledge.restricted_use import note_cross_project_hand_out
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
Scope = Annotated[Literal["similar", "closed", "all", "named"], BeforeValidator(_normalized)]

_DESCRIPTION = (
    "Schlägt in den ANDEREN Projekten des Büros nach, vor allem in den abgeschlossenen "
    "Referenzprojekten. Ruf es selbst auf, ohne dass die Nutzerin danach fragt, wenn (a) die Frage "
    "vergleichend oder erfahrungsbezogen ist („wie haben wir …“, „schon mal“, „früher“, „üblich bei "
    "uns“, Details, Lösungen, Abweichungen, Gutachten, Behördenauflagen), (b) die Quellen dieses "
    "Projekts die Frage nicht beantworten, oder (c) ein Referenzprojekt aus `<referenzprojekte>` "
    "dieselbe Entscheidung schon getroffen hat. Nicht für reine Normtexte oder Definitionen. Das "
    "Projekt dieses Chats ist nie dabei, dafür die üblichen Werkzeuge. `action`: "
    "`search` durchsucht Dokumente (`query` nötig; `scope` `similar` = Projekte, die diesem am "
    "ähnlichsten sind, zuerst (Standard), `closed` = nur abgeschlossene, `all` = alle neueste zuerst, "
    "`named` = nur `project_ids`; optional `document_types`, `disciplines`, "
    "`period_from`/`period_to` als JJJJ-MM-TT für den Projektzeitraum). Ein Aufruf durchsucht "
    "höchstens 8 Projekte; nennt das Ergebnis eine nächste Seite, mit `offset` weiter. "
    "`open_folders_only` lässt Ordner mit eigener Zugriffsliste weg (Standard: aus; lass es weg, außer du "
    "willst bewusst nichts, was diesen Chat einschränkt). "
    "Die Suche liefert auch Bescheide früherer Verfahren (Auflagen, Nachforderungen mit Behörde, Gemeinde "
    "und Datum): zitiere sie wie ein Dokument und nenne Behörde und Jahr. "
    "`find` listet Projekte mit Status, Zeitraum und Adresse (`query` sucht in Name und Adresse). "
    "`brief` liest die bestätigten Eckdaten und die Zusammenfassung eines Projekts (`project_id` aus "
    "`<referenzprojekte>`, `find` oder einem Treffer). "
    "Treffer zitierst du wie jede Quelle über ihren Citation-Schlüssel und nennst Projekt und Jahr; "
    "eine Referenz ist ein Präzedenzfall, keine Norm: sag, wenn sich die Rechtslage seither geändert "
    "haben kann. Die Passage ist alles, was es gibt: Dokumente anderer Projekte lassen sich nicht "
    "weiter öffnen. Abgeschlossene Projekte darf das ganze Büro lesen, sie schränken diesen Chat nicht "
    "ein. Inhalte aus LAUFENDEN Projekten machen ihn nur noch mit Personen teilbar, die diese Projekte "
    "öffnen dürfen, und schließen Projektgedächtnis, Aufträge, Tiefenrecherche und Ablage."
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
    "Dieses Projekt gibt es nicht, oder nicht alle, die diesen Chat lesen, dürfen es öffnen. Nimm eine "
    "project_id aus `<referenzprojekte>` oder `find`."
)

#: Said once per answer that handed out content narrowing the chat's readers: the doors it shut.
_CLOSED_DOORS = (
    "[Dieser Chat stützt sich jetzt auf laufende andere Projekte oder auf Ordner mit eigener Zugriffsliste: "
    "kein Projektgedächtnis, keine Aufträge, keine Tiefenrecherche, keine Ablage ins Projekt, und teilbar "
    "nur mit Personen, die diese Projekte und Ordner öffnen dürfen.]"
)


def _restricts(status: object, collection: object) -> bool:
    """Whether content from this project and collection narrows the chat's readers.

    Everything does except a closed project's open folder, which every office member reads.
    """
    return str(status) != "closed" or is_restricted_collection(collection if isinstance(collection, str) else None)


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


async def _call(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    """One lookup, off the event loop, with every refusal worded for the model."""
    envelope = _envelope()
    try:
        return await asyncio.to_thread(post_lookup, path, payload, envelope)
    except CrossProjectLookupError as exc:
        if exc.code == "CROSS_PROJECT_AUDIENCE_CHANGED":
            # The BFF's own sentence, in German: relayed to the reader as it is.
            raise _Refused(f"Nicht möglich: {exc}") from exc
        if exc.status == 404:
            raise _Refused(_NOT_FOUND) from exc
        if exc.status in (400, 422):
            raise _Refused(f"Fehler: Die Anfrage war ungültig ({exc}). Korrigiere die Argumente.") from exc
        raise _Refused(_UNREACHABLE) from exc


def _land_note(project: dict[str, Any]) -> str | None:
    """The project's Land, and a warning when it is not this chat's project's.

    Said by the tool, not left to the model: a precedent from another Land
    was decided under another Bauordnung, and nothing else on the hit shows it.
    """
    theirs = project.get("bundesland")
    if not isinstance(theirs, str) or not theirs:
        return None
    label = BUNDESLAND_TOKENS.get(theirs) or (
        "außerhalb Österreichs" if theirs == "ausserhalb_oesterreichs" else theirs
    )
    context = project_context.get_signed_request_context()
    ours = context.bundesland if context is not None else None
    if ours and ours != theirs:
        return f"{label} — nicht das Bundesland dieses Projekts: dort gilt eine andere Bauordnung"
    return label


def _source_project(project: dict[str, Any], name: str) -> SourceProject:
    return SourceProject(
        id=str(project.get("id")),
        name=name,
        status=str(project.get("status") or "active"),
        land_note=_land_note(project),
    )


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
    open_folders_only: bool = False,
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
    if open_folders_only:
        payload["openFoldersOnly"] = True
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
        project=_source_project(project, name),
    )


def _search_preamble(
    body: dict[str, Any], passages: tuple[GroundingHit, ...], permits: list[GroundingHit]
) -> list[str]:
    projects = len({hit.project.id for hit in (*passages, *permits) if hit.project})
    searched, in_scope = body.get("projectsSearched", 0), body.get("projectsInScope", 0)
    found = f"{len(passages)} Passage(n)" + (f", {len(permits)} Bescheid(e)" if permits else "")
    lines = [
        f"Treffer aus anderen Projekten: {found} aus {projects} Projekt(en); "
        f"{searched} von {in_scope} Projekten durchsucht."
    ]
    next_offset = body.get("nextOffset")
    if isinstance(next_offset, int):
        lines.append(f"[Weitere Projekte nicht durchsucht: dieselbe Suche mit offset={next_offset} setzt fort.]")
    if any(_restricts(hit.project.status if hit.project else None, hit.collection) for hit in passages):
        lines.append(_CLOSED_DOORS)
    return lines


_DECISION_KIND = {"decision": "Entscheidung", "constraint": "Vorgabe"}

#: The file name a project's recorded decisions are cited under: not a document, its memory.
MEMORY_SOURCE_NAME = "Projektgedächtnis"


def _decisions(body: dict[str, Any]) -> list[dict[str, Any]]:
    raw = body.get("decisions") if isinstance(body.get("decisions"), list) else []
    usable = (item for item in raw if isinstance(item, dict) and isinstance(item.get("project"), dict))
    return [item for item in usable if item.get("content") and item.get("collection")]


def _decision_line(item: dict[str, Any]) -> str:
    year = str(item.get("recordedAt") or "")[:4]
    label = _DECISION_KIND.get(str(item.get("kind")), "Entscheidung")
    who = "von einer Person bestätigt" if item.get("confirmed") else "von Piloti festgehalten"
    return f"{label} ({who}{', ' + year if year else ''}): {_text(item['content'])}"


def _decision_hits(decisions: list[dict[str, Any]]) -> list[GroundingHit]:
    """One citable source per project: the decisions its memory recorded, before its passages.

    One per project because the registry merges a source by (collection, file,
    page): two decisions of one project are one source, the project's memory.
    """
    by_project: dict[str, list[dict[str, Any]]] = {}
    for item in decisions:
        by_project.setdefault(str(item["project"].get("id")), []).append(item)
    hits = []
    for items in by_project.values():
        project = items[0]["project"]
        name = _text(project.get("name")) or "Projekt"
        hits.append(
            GroundingHit(
                citation_key=f"{MEMORY_SOURCE_NAME} ({name})",
                file_name=MEMORY_SOURCE_NAME,
                page=None,
                shelf=Shelf.PROJECT,
                collection=str(items[0]["collection"]),
                doc_class=None,
                display_title="Festgehaltene Entscheidungen (aus dem Projektgedächtnis, kein Dokument)",
                folder_path=None,
                punkt=None,
                score=1.0,
                content_type="text",
                provenance=None,
                stored_image_index=None,
                status_note=None,
                body="\n".join(_decision_line(item) for item in items),
                body_truncated=False,
                project=_source_project(project, name),
            )
        )
    return hits


#: How a record's kind reads in a permit source: labels for the closed enums the BFF stores, not a reading of any text.
_PERMIT_KIND = {
    "bewilligung": "Bewilligung",
    "nachforderung": "Nachforderung",
    "ablehnung": "Ablehnung",
    "sonstiges": "Bescheid",
}
_PERMIT_REQUIREMENT_KIND = {"auflage": "Auflage", "nachforderung": "Nachforderung", "hinweis": "Hinweis"}


def _permits(body: dict[str, Any]) -> list[dict[str, Any]]:
    raw = body.get("permits") if isinstance(body.get("permits"), list) else []
    usable = (item for item in raw if isinstance(item, dict) and isinstance(item.get("project"), dict))
    return [item for item in usable if item.get("fileName") and item.get("collection")]


def _german_day(value: object) -> str:
    """``2020-03-12`` as ``12.03.2020``; anything else as it came."""
    try:
        return date.fromisoformat(str(value)).strftime("%d.%m.%Y")
    except ValueError:
        return _text(value)


def _requirement_line(item: dict[str, Any]) -> str:
    label = _PERMIT_REQUIREMENT_KIND.get(str(item.get("kind")), _text(item.get("kind")) or "Auflage")
    page = item.get("page")
    line = f"{label}{f' (S. {page})' if isinstance(page, int) and page > 0 else ''}: {_text(item.get('content'))}"
    if evidence := _text(item.get("evidence")):
        line += f" Nachweis: {evidence}"
    if basis := _text(item.get("legalBasis")):
        line += f" Rechtsgrundlage: {basis}"
    return line


def _permit_title(item: dict[str, Any]) -> str:
    kind = _PERMIT_KIND.get(str(item.get("kind")), "Bescheid")
    title = f"{kind} – {_text(item.get('authority'))}" if _text(item.get("authority")) else kind
    return f"{title}, {_german_day(item['issuedOn'])}" if item.get("issuedOn") else title


def _permit_body(item: dict[str, Any]) -> str:
    procedure = ", ".join(
        part
        for part in (
            f"Gemeinde {_text(item.get('municipality'))}" if _text(item.get("municipality")) else "",
            f"Geschäftszahl {_text(item.get('reference'))}" if _text(item.get("reference")) else "",
        )
        if part
    )
    requirements = [
        _requirement_line(requirement)
        for requirement in item.get("requirements") or []
        if isinstance(requirement, dict)
    ]
    return "\n".join(([f"Verfahren: {procedure}"] if procedure else []) + requirements)


#: A passage is capped at 900 characters; a record's requirements are several short items.
PERMIT_BODY_MAX_CHARS = 2400


def _capped_body(text: str) -> tuple[str, bool]:
    """``text`` cut to PERMIT_BODY_MAX_CHARS, and whether it was cut; the renderer marks a cut body itself."""
    if len(text) <= PERMIT_BODY_MAX_CHARS:
        return text, False
    return text[:PERMIT_BODY_MAX_CHARS].rstrip(), True


def _permit_hits(permits: list[dict[str, Any]]) -> list[GroundingHit]:
    """One citable source per permit record: the DOCUMENT it was read from, with what it demands.

    Cited like a passage (file, collection, the first requirement's page), so
    the same Bescheid found as a passage too is one source, not two.
    """
    hits = []
    for item in permits:
        project = item["project"]
        name = _text(project.get("name")) or "Projekt"
        first = next((r for r in item.get("requirements") or [] if isinstance(r, dict)), {})
        page = first.get("page") if isinstance(first.get("page"), int) and first.get("page") > 0 else None
        key = f"{item['fileName']} ({name})"
        body, truncated = _capped_body(_permit_body(item))
        hits.append(
            GroundingHit(
                citation_key=f"{key}, p.{page}" if page is not None else key,
                file_name=str(item["fileName"]),
                page=page,
                shelf=Shelf.PROJECT,
                collection=str(item["collection"]),
                doc_class=None,
                display_title=_permit_title(item),
                folder_path=None,
                punkt=None,
                score=1.0,
                content_type="text",
                provenance=None,
                stored_image_index=None,
                status_note=None,
                body=body,
                body_truncated=truncated,
                project=_source_project(project, name),
            )
        )
    return hits


def _records_restrict(records: list[dict[str, Any]]) -> bool:
    """Whether a decision or permit record narrows the chat's readers: a running project's or a restricted folder's."""
    return any(
        str(item["project"].get("status")) != "closed"
        or item.get("restricted")
        or is_restricted_collection(item["collection"] if isinstance(item.get("collection"), str) else None)
        for item in records
    )


def _render_search(body: dict[str, Any]) -> str:
    raw_hits = body.get("hits") if isinstance(body.get("hits"), list) else []
    passages = tuple(hit for hit in (_hit(raw) for raw in raw_hits if isinstance(raw, dict)) if hit is not None)
    decisions, permits = _decisions(body), _permits(body)
    permit_hits = _permit_hits(permits)
    # The decisions first: short, comparable, and they say why. Then what the
    # authorities demanded of past procedures, then the passages.
    hits = (*_decision_hits(decisions), *permit_hits, *passages)
    preamble = _search_preamble(body, passages, permit_hits)
    recorded = [*decisions, *permits]
    if recorded and _records_restrict(recorded) and _CLOSED_DOORS not in preamble:
        preamble.append(_CLOSED_DOORS)
    if not hits:
        return "\n".join([*preamble, "Keine passenden Dokumente, Entscheidungen oder Bescheide in diesen Projekten."])
    from knowledge_layer.register import _trace_lanes_for_hits

    # Handed out by the BFF, which recorded every one before it answered: what
    # the admission lets through for this turn, and what shuts its doors.
    note_cross_project_hand_out(
        (hit.collection for hit in hits),
        restricting=_records_restrict(recorded)
        or any(_restricts(hit.project.status if hit.project else None, hit.collection) for hit in passages),
    )
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


def _edition_note(project: dict[str, Any]) -> str | None:
    """The OIB edition the project was planned under; unconfirmed when only its documents suggest it."""
    edition = project.get("oibEdition")
    if not isinstance(edition, dict) or not _text(edition.get("value")):
        return None
    note = f"geplant nach OIB-Richtlinien {_text(edition['value'])}"
    if not edition.get("confirmed"):
        note += " (aus den Unterlagen, unbestätigt)"
    return note


def _project_line(project: dict[str, Any]) -> str:
    parts = [f"{_text(project.get('name'))} — {_status_label(project.get('status'))}"]
    if period := _period(project.get("period")):
        parts.append(period)
    if land := _land_note(project):
        parts.append(land)
    if edition := _edition_note(project):
        parts.append(edition)
    if address := _text(project.get("address")):
        parts.append(address)
    line = " · ".join(parts) + f" (project_id {project.get('id')})"
    return f"- {line}" + (" — das Projekt dieses Chats" if project.get("current") else "")


def _others(projects: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [project for project in projects if project.get("collection") and not project.get("current")]


def _any_active(projects: list[dict[str, Any]]) -> bool:
    """Whether an answer named another project still running: that narrows the chat's readers."""
    return any(str(project.get("status")) != "closed" for project in _others(projects))


def _hand_out(projects: list[dict[str, Any]]) -> None:
    """Every project an answer named other than the chat's own: recorded by the BFF, noted for the turn."""
    collections = [str(project["collection"]) for project in _others(projects)]
    note_collections_read(collections)
    if collections:
        note_cross_project_hand_out(collections, restricting=_any_active(projects))


def _render_find(body: dict[str, Any]) -> str:
    projects = [project for project in body.get("projects") or [] if isinstance(project, dict)]
    if not projects:
        return "Keine Projekte gefunden, die alle in diesem Chat öffnen dürfen."
    _hand_out(projects)
    total = body.get("total", len(projects))
    lines = [f"{len(projects)} von {total} Projekt(en):", *(_project_line(project) for project in projects)]
    if _any_active(projects):
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
    if _any_active([project]):
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
    open_folders_only: bool,
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
            open_folders_only=open_folders_only,
        )
        return _render_search(await _call(SEARCH_PATH, payload))
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
    scope: Scope = "similar",
    project_ids: list[str] | None = None,
    document_types: list[DocumentType] | None = None,
    disciplines: list[Discipline] | None = None,
    period_from: str = "",
    period_to: str = "",
    offset: int = 0,
    project_id: str = "",
    open_folders_only: bool = False,
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
            bool(open_folders_only),
        )
    except _Refused as refused:
        return refused.message


@register_function(config_type=ProjectLookupConfig)
async def project_lookup(tool_config: ProjectLookupConfig, builder: Builder):
    yield FunctionInfo.from_fn(run_project_lookup, description=_DESCRIPTION)
