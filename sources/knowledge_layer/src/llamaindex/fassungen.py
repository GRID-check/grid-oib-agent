"""The two ingestion hooks that read Fassungen: a suggestion for a new name, a change line for a re-upload.

``adapter.py`` calls :func:`record_fassungen` once per file, after the summary
row is written:

* A file whose NAME is new in the collection may be a newer Fassung of another
  document under a different name. The summary model reads a few candidates and
  its answer is stored as a ``revision_suggestion`` on the new row. A SUGGESTION:
  nothing is linked, hidden or re-ranked until a person confirms it.
* A file uploaded under a name the collection already holds replaces its
  predecessor's chunks (ADR-0054). What changed against the previous upload is
  written as the row's ``change_summary``, with its own name as ``change_basis``.

WHAT REACHES THE MODEL, AND WHEN (ADR-0086). The upload screen runs BEFORE this:
a file whose content or name matched a rule is quarantined by the ingest job,
which ``continue``s before any summary exists. So the new file has passed, and no
held file has a row to be read here. The one hole is a quarantined RE-upload,
whose predecessor keeps its row (it carries what people set); a re-upload still
being read is the same. Those names are read from the ingest job store and left
out of the candidates, and when that store cannot be read nothing is suggested:
the names stay home rather than guess. What a candidate sends is its name,
Dokumentart, tags and one-line summary, which an earlier ingest already sent to
the same model.

Both steps are fail-open and bounded by the caller; neither can fail an ingest.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Sequence
from typing import Any

from aiq_agent.knowledge.document_revisions import RevisionDocument
from aiq_agent.knowledge.document_revisions import judge_revision
from aiq_agent.knowledge.document_revisions import summarize_change

from ..revision_series import parse_revision_name
from ..revision_series import revision_label
from ..revision_series import series_key_of

logger = logging.getLogger(__name__)

#: How far back a quarantine verdict is looked for in the job store.
HELD_LOOKBACK_SECONDS = 30 * 24 * 3600


def revision_document(
    file_name: str,
    *,
    summary: str | None,
    doc_class: str | None,
    tags: Sequence[str] | None,
) -> RevisionDocument:
    """A file as the judge may read it: its name, class, tags, summary and what its name says of its Fassung."""
    revision = parse_revision_name(file_name)
    return RevisionDocument(
        file_name=file_name,
        summary=summary or "",
        doc_class=doc_class,
        tags=tuple(tags or ()),
        revision=revision_label(revision) if revision is not None else None,
        series_key=series_key_of(file_name),
    )


def held_file_names(collection: str) -> set[str] | None:
    """Names of files in ``collection`` that are quarantined or still being read; ``None`` when unknown.

    The newest job that names a file decides: a quarantine that a release then
    indexed is no longer held. ``None`` means the job store could not be read,
    and the caller must then send no name to a model.
    """
    try:
        from aiq_agent.knowledge import ingest_status_store

        in_flight = ingest_status_store.in_flight_files([collection]).get(collection, [])
        jobs = ingest_status_store.collection_jobs(collection, HELD_LOOKBACK_SECONDS)
    except Exception:  # noqa: BLE001 — unknown holds nothing back, so nothing is sent
        logger.warning("Could not read the held files of %s; no Fassung suggestion", collection, exc_info=True)
        return None
    quarantined: dict[str, bool] = {}
    for job in jobs:
        for detail in job.file_details:
            quarantined[detail.file_name] = detail.screening == "quarantined"
    return set(in_flight) | {name for name, held in quarantined.items() if held}


def read_rows(collection: str) -> list[Any]:
    """The collection's metadata rows (``AvailableDocument``), or none when they cannot be read."""
    try:
        from aiq_agent.knowledge import get_available_documents

        return list(get_available_documents(collection))
    except Exception:  # noqa: BLE001 — without rows there is nothing to compare, not a failed ingest
        logger.warning("Could not read the metadata rows of %s for Fassungen", collection, exc_info=True)
        return []


def previous_summary(rows: Sequence[Any], stored_names: Sequence[str]) -> str | None:
    """The summary a re-uploaded file had before this upload, read BEFORE the new row overwrites it."""
    wanted = set(stored_names)
    for row in rows:
        if row.file_name in wanted and (row.summary or "").strip():
            return row.summary
    return None


def candidate_documents(file_name: str, rows: Sequence[Any], held: set[str]) -> list[RevisionDocument]:
    """The rows the new file may be a newer Fassung of.

    Not itself, not a row a person already replaced, not one the person already
    dismissed for this file, not one with nothing to say, and not a held name.
    """
    own = next((row for row in rows if row.file_name == file_name), None)
    dismissed_suggestion = (own.revision_suggestion or {}) if own is not None else {}
    refused = {dismissed_suggestion["of"]} if dismissed_suggestion.get("dismissed") else set()
    return [
        revision_document(row.file_name, summary=row.summary, doc_class=row.doc_class, tags=row.tags)
        for row in rows
        if row.file_name != file_name
        and not row.superseded_by
        and (row.summary or "").strip()
        and row.file_name not in held
        and row.file_name not in refused
    ]


def suggest_revision(
    collection: str,
    file_name: str,
    *,
    rows: Sequence[Any],
    summary: str,
    doc_class: str | None,
    tags: Sequence[str] | None,
    llm: Any,
) -> dict[str, Any] | None:
    """Ask whether a new file name is a newer Fassung of another, and store the suggestion. Returns it."""
    held = held_file_names(collection)
    if held is None:
        return None
    candidates = candidate_documents(file_name, rows, held)
    if not candidates:
        return None
    verdict = judge_revision(
        revision_document(file_name, summary=summary, doc_class=doc_class, tags=tags), candidates, llm
    )
    if verdict is None:
        return None
    from aiq_agent.knowledge import set_document_revision_suggestion

    suggestion = verdict.as_suggestion()
    set_document_revision_suggestion(collection, file_name, suggestion)
    return suggestion


def record_change(
    collection: str,
    file_name: str,
    *,
    previous: str | None,
    summary: str,
    llm: Any,
) -> str | None:
    """Store what changed against the previous upload of the same name; clear a stale line when none can be told.

    ``change_basis`` is the file's own name: the comparison is with its previous
    upload, which the UI labels „vorige Fassung". The old line described an
    older upload and is replaced either way.
    """
    from aiq_agent.knowledge import set_document_change_summary

    change = None
    if previous:
        change = summarize_change(
            RevisionDocument(file_name=file_name, summary=previous),
            RevisionDocument(file_name=file_name, summary=summary),
            llm,
        )
    set_document_change_summary(collection, file_name, change, file_name if change else None)
    return change


def carried_links(preserved: dict[str, str]) -> tuple[str | None, dict[str, Any] | None]:
    """The person-set link and the suggestion a replaced version's row carried, decoded.

    ``preserved`` is :class:`_PreviousVersion.preserved`: JSON text for the
    suggestion, a plain name for the link. An unreadable suggestion is dropped.
    """
    link = preserved.get("superseded_by") or None
    raw = preserved.get("revision_suggestion")
    try:
        suggestion = json.loads(raw) if raw else None
    except ValueError:
        suggestion = None
    return link, suggestion if isinstance(suggestion, dict) else None


def record_fassungen(
    collection: str,
    file_name: str,
    *,
    replaced: bool,
    rows: Sequence[Any],
    previous: str | None,
    summary: str,
    doc_class: str | None,
    tags: Sequence[str] | None,
    llm: Any,
) -> None:
    """The per-file entry point ``adapter.py`` bounds with a timeout: a change line, or a suggestion.

    ``replaced``: the name was already in the collection. ``rows`` and
    ``previous`` were read before the new summary overwrote the old.
    """
    if replaced:
        record_change(collection, file_name, previous=previous, summary=summary, llm=llm)
        return
    suggest_revision(collection, file_name, rows=rows, summary=summary, doc_class=doc_class, tags=tags, llm=llm)
