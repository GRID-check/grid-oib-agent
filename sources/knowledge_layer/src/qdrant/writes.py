"""The adapter's writes beyond the store's primitives: a file's chunks, and the facts people set.

Ingestion embeds a file's chunks once and writes them here (:func:`write_chunks`),
with what the collection name used to only imply made explicit on every point
(:func:`enrichment`) and the facts the metadata store already holds for the
file. Qdrant is the only vector store (ADR-0113): a write that fails raises,
and the file fails where a person can see it.

The facts a person sets (tags, Dokumentart, Fassung, folder) live in Postgres,
their authority. :func:`refresh_facts` copies them onto the file's points
after every change, so a pre-filter sees what the post-filter would.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Iterable
from collections.abc import Mapping
from collections.abc import Sequence
from typing import Any

from .payload import ChunkRecord
from .payload import document_facts
from .payload import project_payload
from .prefilter import FOLDER_FIELD
from .schema import INDEXED_AT_FIELD
from .store import get_store

logger = logging.getLogger(__name__)


def facts_by_file(scope: str, file_names: Iterable[str] | None = None) -> dict[str, dict[str, Any]]:
    """The person-set facts of each file in ``scope`` (only of ``file_names`` when given), from the metadata store.

    Given names, only their rows are read: a change to one file must not load
    every document of the scope.
    """
    if file_names is None:
        from aiq_agent.knowledge import get_available_documents

        documents = get_available_documents(scope)
    else:
        from aiq_agent.knowledge import get_documents

        documents = get_documents(scope, sorted(set(file_names)))
    return {document.file_name: document_facts(document) for document in documents}


def enrichment(scope: str, config: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """What the collection name only implied, made explicit on every point.

    ``office_id`` comes from the ingest job (the BFF's ``x-grid-organization-id``)
    or, for the Büroablage, from the collection name itself; ``project_id``
    and ``grid_document_id`` from the job. The project's facts and status
    come from the job too (the BFF reads them off the project when it
    dispatches), so a new document is boosted and filtered like its siblings
    from its first search; a later change reaches it through
    ``PUT /v1/collections/{c}/project-facts``. ``indexed_at`` is when the
    chunks were written: what a collection's ``updated_at`` is read from,
    and what the 24-hour reaper of conversation uploads measures.
    """
    config = config or {}
    office_id = config.get("organization_id")
    if not office_id and scope.startswith("archiv_"):
        office_id = scope.removeprefix("archiv_")
    base: dict[str, Any] = {
        "office_id": office_id,
        "project_id": config.get("project_id"),
        "grid_document_id": config.get("document_id"),
        "folder_path": config.get("folder_path"),
        INDEXED_AT_FIELD: int(time.time()),
    }
    status = config.get("project_status")
    if status or config.get("project_facts") is not None:
        try:
            base.update(project_payload(config.get("project_facts"), status))
        except ValueError:
            # The file is not failed over it: the facts are a copy, and the
            # BFF's project-facts push and weekly sweep write them again.
            logger.error(
                "Qdrant: the ingest job for %s carries project facts with status %r; not written", scope, status
            )
    return base


def write_chunks(
    scope: str,
    file_name: str,
    records: Sequence[ChunkRecord],
    *,
    identity: Mapping[str, str],
    config: Mapping[str, Any] | None = None,
) -> int:
    """Write one file's embedded chunks into ``scope``; returns the points written.

    A point id is derived from its chunk id (``payload.point_id``), so a retry
    of the same records overwrites, never duplicates. A fact the metadata store
    does not hold yet (None) leaves the job's own value; the refresh that
    follows the store's write (:func:`refresh_facts`) settles it. Raises when
    the collection holds another embedder's vectors (``schema.ensure_collection``).
    """
    base = enrichment(scope, config)
    facts = facts_by_file(scope, [file_name]).get(file_name, {})
    base.update({key: value for key, value in facts.items() if value is not None})
    return get_store(identity).upsert(scope, records, base)


#: The facts a folder move changes, and all a re-filed subtree needs copied.
FOLDER_FACTS = frozenset({"folder_path", FOLDER_FIELD})


def copy_facts(scope: str, file_names: Iterable[str] | None = None, *, fields: Iterable[str] | None = None) -> int:
    """Copy the person-set facts of these files (all of ``scope`` when None) onto their points; the files copied.

    Raises when the metadata store or Qdrant fails. :func:`refresh_facts` is
    the call after a person's edit, which must not fail over its copy; the
    weekly vector reconcile calls this one through
    ``POST /v1/maintenance/refresh-document-facts`` so a failure is counted.

    The facts of every file go in bounded batches, not one request per file
    (a folder rename re-files a whole subtree). A file with no stored
    Dokumentart gets its own one back (``QdrantStore.restore_chunk_doc_classes``),
    so clearing a person's class is copied too. ``fields`` limits the copy
    to those facts (:data:`FOLDER_FACTS` after a folder move), and the
    Dokumentart is then put back only when it is one of them.
    """
    store = get_store()
    facts = facts_by_file(scope, file_names)
    wanted = set(fields) if fields is not None else None
    if wanted is not None:
        facts = {name: {key: value for key, value in values.items() if key in wanted} for name, values in facts.items()}
    store.set_file_payloads(scope, facts)
    if wanted is None or "doc_class" in wanted:
        store.restore_chunk_doc_classes(scope, [name for name, values in facts.items() if "doc_class" not in values])
    return len(facts)


def refresh_facts(scope: str, file_names: Iterable[str] | None = None, *, fields: Iterable[str] | None = None) -> None:
    """:func:`copy_facts`, after the metadata store changed a fact. Never raises.

    The store has the change, a person's edit must not fail over its copy,
    the Postgres post-filters stay as the backstop, and the weekly vector
    reconcile copies every live collection's facts again (its document facts
    half, ``lib/platform/vector-reconcile.ts``), which repairs a copy that
    failed here.
    """
    try:
        copy_facts(scope, file_names, fields=fields)
    except Exception:  # noqa: BLE001 - see the docstring
        logger.warning("Qdrant: copying the facts of %s onto its points failed", scope, exc_info=True)
