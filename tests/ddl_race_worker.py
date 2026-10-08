"""What each process of ``test_ddl_concurrency`` runs.

A module of its own, because ``multiprocessing`` ("spawn") imports the target by
name in the child and the test modules are collected with ``importlib`` mode.
Imports of the code under test are inside the functions: a child must import
THIS checkout's packages, and only after :func:`worker` has put them first on
its path (``aiq_api`` is a workspace package the venv may have installed from
another checkout).
"""

from __future__ import annotations

import sys
import weakref
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
_TIMEOUT_SECONDS = 120

#: site -> the tables its ensure function must leave behind.
SITES: dict[str, tuple[str, ...]] = {
    "ingest_status_store": ("ingest_jobs", "ingest_job_queue", "ingest_lane_turns"),
    "research_queue": ("research_job_queue", "research_lane_turns"),
    "chunk_text_store": ("chunk_text",),
    "norm_store": ("norm_registry",),
    "document_metadata_store": ("document_metadata",),
    "corpus_store": ("oib_corpus_files",),
    "event_store_instance": ("job_events",),
    "event_store_class": ("job_events",),
    "event_store_async": ("job_events",),
    "job_access": ("job_access",),
}


def _ingest_status_store(url: str) -> bool:
    from aiq_agent.knowledge import ingest_status_store

    ingest_status_store._ensure_table(url)
    return url in ingest_status_store._initialized


def _research_queue(url: str) -> bool:
    from aiq_api.jobs import queue

    queue.ensure_research_queue_table(url)
    return url in queue.queue_for(url).initialized


def _chunk_text_store(url: str) -> bool:
    from aiq_agent.knowledge.chunk_text_store import ChunkTextStore

    ChunkTextStore(url)
    return url in ChunkTextStore._tables_initialized


def _norm_store(url: str) -> bool:
    from aiq_agent.knowledge.norm_store import NormRegistryStore

    NormRegistryStore(url)
    return url in NormRegistryStore._tables_initialized


def _document_metadata_store(url: str) -> bool:
    from aiq_agent.knowledge.document_metadata_store import DocumentMetadataStore

    DocumentMetadataStore(url)
    return url in DocumentMetadataStore._tables_initialized


def _corpus_store(url: str) -> bool:
    from aiq_agent import corpus_store

    corpus_store._ensure_table(url)
    return url in corpus_store._initialized


def _event_store_instance(url: str) -> bool:
    from aiq_api.jobs.event_store import EventStore

    EventStore(url)
    return url in EventStore._tables_initialized


def _event_store_class(url: str) -> bool:
    from aiq_api.jobs.event_store import EventStore

    EventStore._ensure_table_exists(url)
    return url in EventStore._tables_initialized


def _event_store_async(url: str) -> bool:
    import asyncio

    from aiq_api.jobs.event_store import EventStore

    asyncio.run(EventStore._ensure_table_async(url))
    return url in EventStore._tables_initialized


def _job_access(url: str) -> bool:
    from aiq_api.jobs import access

    access.ensure_job_access_table(url)
    return url in access._job_access_schema_initialized


_ENSURE = {
    "ingest_status_store": _ingest_status_store,
    "research_queue": _research_queue,
    "chunk_text_store": _chunk_text_store,
    "norm_store": _norm_store,
    "document_metadata_store": _document_metadata_store,
    "corpus_store": _corpus_store,
    "event_store_instance": _event_store_instance,
    "event_store_class": _event_store_class,
    "event_store_async": _event_store_async,
    "job_access": _job_access,
}


_engines: weakref.WeakSet = weakref.WeakSet()


def _track_engines() -> None:
    """Remember every sync engine this process opens, so :func:`_dispose_engines` can close them."""
    from sqlalchemy.engine import Engine

    original = Engine.__init__

    def remembering(self, *args, **kwargs):
        original(self, *args, **kwargs)
        _engines.add(self)

    Engine.__init__ = remembering


def _dispose_engines() -> None:
    """Close the pools of the round just finished: fifty databases would otherwise hold fifty open."""
    for engine in list(_engines):
        if not engine.dialect.is_async:
            engine.dispose()


def worker(index: int, barrier, tasks: list[tuple[str, str]], results) -> None:
    """Ensure each ``(site, url)`` in turn, released together with the other workers by ``barrier``.

    Puts ``(site, url, index, error, ensured)`` on ``results``: ``error`` is the
    exception that escaped, ``ensured`` whether the site marked ``url`` as ensured.
    """
    sys.path[:0] = [str(_REPO / "src"), str(_REPO / "frontends" / "aiq_api" / "src")]
    _track_engines()
    for site, url in tasks:
        barrier.wait(timeout=_TIMEOUT_SECONDS)
        try:
            ensured = _ENSURE[site](url)
            results.put((site, url, index, None, ensured))
        except BaseException as exc:  # noqa: BLE001 - the parent reports it
            results.put((site, url, index, f"{type(exc).__name__}: {str(exc).splitlines()[0]}", False))
        _dispose_engines()
