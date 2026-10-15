"""Rebuild a physical collection as a new ``_vN`` and move its alias (ADR-0113).

Open-source Qdrant cannot reshard or change a collection's replication shape
in place, so a changed shape is a new collection beside the live one, a copy,
and one alias switch. Every client addresses the store through the alias
(``piloti_office``, ``piloti_corpus``), so nothing else changes.

The copy is a scroll of the live collection with its stored vectors, upserted
page by page into the new one: nothing is re-embedded, and the lexical sparse
vector is copied as Qdrant computed it. Each page is an upsert by point id,
so a transient failure is retried like every other write (``store.with_retry``)
instead of leaving a half copy behind a refused target. ``init_from`` is no shortcut: Qdrant
1.19.2 accepts it and ignores it, leaving the new collection empty (drilled
2026-10-13, ``docs/deployment/qdrant-runbook.md``).

The alias moves only in :func:`switch_alias`, one request that deletes and
recreates it, which Qdrant applies atomically. The old collection is left
where it was: switching back to it is the rollback. Writes that land in the old
collection while the copy runs are not in the new one, and nothing else holds
them, so ingestion is paused for the copy (the runbook,
``docs/deployment/qdrant-runbook.md``, says how).

``scripts/qdrant_rebuild.py`` is the command line around it.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from qdrant_client import QdrantClient
from qdrant_client import models

from .schema import ALIASES
from .schema import DENSE
from .schema import Physical
from .schema import create_collection
from .store import with_retry

logger = logging.getLogger(__name__)

DEFAULT_PAGE_SIZE = 256


@dataclass
class RebuildReport:
    """What one copy did, and whether the two collections now hold the same number of points."""

    source: str
    target: str
    copied: int
    source_count: int
    target_count: int

    @property
    def complete(self) -> bool:
        return self.source_count == self.target_count


def current_collection(client: QdrantClient, physical: Physical) -> str:
    """The collection the physical collection's alias points at; raises when there is no alias."""
    alias = ALIASES[physical]
    for entry in client.get_aliases().aliases:
        if entry.alias_name == alias:
            return entry.collection_name
    raise RuntimeError(f"alias {alias} does not exist")


def _exact_count(client: QdrantClient, name: str) -> int:
    return client.count(name, exact=True).count


def copy_collection(
    client: QdrantClient,
    physical: Physical,
    target: str,
    *,
    shards: int | None = None,
    replication: int | None = None,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> RebuildReport:
    """Create ``target`` in the live collection's shape (or ``shards``/``replication``) and copy every point into it.

    Refuses a ``target`` that exists: a half-copied collection from an earlier
    attempt is dropped by a person, never overwritten here.
    """
    source = current_collection(client, physical)
    if target == source:
        raise ValueError(f"{target} is the live collection behind {ALIASES[physical]}")
    if client.collection_exists(target):
        raise RuntimeError(f"{target} already exists: drop it, or rebuild into the next _vN")
    info = client.get_collection(source)
    params = info.config.params
    identity = dict(info.config.metadata or {})
    # The live collection's shape unless told otherwise, never the environment's:
    # the process running this need not carry the backend's AIQ_QDRANT_* values.
    create_collection(
        client,
        physical,
        target,
        params.vectors[DENSE].size,
        identity,
        shards=shards or params.shard_number,
        replication=replication or params.replication_factor,
    )
    copied = 0
    offset = None
    while True:
        page, offset = client.scroll(source, limit=page_size, offset=offset, with_payload=True, with_vectors=True)
        if page:
            points = [models.PointStruct(id=record.id, vector=record.vector, payload=record.payload) for record in page]
            with_retry(f"copy into {target}", lambda: client.upsert(target, points, wait=True))
            copied += len(page)
        if offset is None:
            break
    report = RebuildReport(source, target, copied, _exact_count(client, source), _exact_count(client, target))
    logger.info(
        "Copied %d points %s -> %s (%d vs %d)", copied, source, target, report.source_count, report.target_count
    )
    return report


def switch_alias(client: QdrantClient, physical: Physical, target: str) -> str:
    """Point the physical collection's alias at ``target`` in one atomic request; returns the previous collection."""
    alias = ALIASES[physical]
    previous = current_collection(client, physical)
    if not client.collection_exists(target):
        raise RuntimeError(f"{target} does not exist")
    client.update_collection_aliases(
        change_aliases_operations=[
            models.DeleteAliasOperation(delete_alias=models.DeleteAlias(alias_name=alias)),
            models.CreateAliasOperation(create_alias=models.CreateAlias(collection_name=target, alias_name=alias)),
        ]
    )
    logger.info("Alias %s: %s -> %s", alias, previous, target)
    return previous
