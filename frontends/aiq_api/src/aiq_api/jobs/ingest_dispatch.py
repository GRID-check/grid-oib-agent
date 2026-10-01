"""Where an ingestion job runs: the durable queue, claimed by any worker.

``POST /v1/ingest`` prepares a job (validated, recorded PENDING) and puts it in
the durable, fair queue (``aiq_agent.knowledge.ingest_queue``). Every process
that claims (the web tier unless ``GRID_INGEST_QUEUE_CLAIM=false``, and the
dedicated ingest-worker tier, ``ingest_worker``) attaches ``QueueSource`` to its
ingestor, so its free workers claim the next job fairly across every
organisation and run it. A job survives the restart of the replica that
accepted it, and ingestion scales apart from the chat tier.

The queue is used when the ingestor can run a job elsewhere, a database is
configured, every file is a deferred object-store download (a local path exists
only on the replica that wrote it) and ``GRID_INGEST_QUEUE`` is not ``off``.
Otherwise, and whenever storing the job fails, the job runs in this process's
own fair pool, which is what every job did before.

The payload carries presigned URLs, bearer credentials to a tenant's objects,
so it is encrypted like the research queue's (``payload_crypto``,
``GRID_JOB_PAYLOAD_KEK``), and every URL passes the SSRF gates again when a
worker reads it back.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections.abc import Callable
from typing import Any

from aiq_agent.knowledge import ingest_queue
from aiq_agent.knowledge import ingest_status_store
from aiq_agent.knowledge.base import BaseIngestor
from aiq_agent.knowledge.base import PreparedIngestJob
from aiq_agent.knowledge.schema import IngestionJobStatus
from aiq_agent.knowledge.schema import JobState

from . import payload_crypto

logger = logging.getLogger(__name__)

#: The config key whose entries are deferred downloads, beside ``file_paths``.
_DEFERRED_CONFIG_LISTS = ("extraction_paths",)

#: Config keys that are URLs a worker requests: gated again on the way back in.
_URL_CONFIG_KEYS = ("thumbnail_upload_url",)

_DOWNLOAD = "__object_download__"


def _flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    return raw not in ("0", "false", "no", "off")


def _int_env(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, ""))
    except ValueError:
        return default
    return value if value >= 0 else default


# @environment_variable GRID_INGEST_QUEUE
# @category Knowledge Layer
# @type bool
# @default on
# @required false
# Put `/v1/ingest` jobs in the durable, fair Postgres queue (`ingest_job_queue`)
# for any worker to claim. `off` runs every job in the accepting process, as
# before the queue existed.
def queue_enabled() -> bool:
    return _flag("GRID_INGEST_QUEUE", True) and ingest_queue.db_url() is not None


# @environment_variable GRID_INGEST_QUEUE_CLAIM
# @category Knowledge Layer
# @type bool
# @default true
# @required false
# Whether this process's ingest workers claim from the durable queue. Set
# `false` on the web tier when the ingest-worker tier runs, so ingestion stays
# off the chat pods.
def claim_enabled() -> bool:
    return _flag("GRID_INGEST_QUEUE_CLAIM", True)


# @environment_variable GRID_INGEST_MAX_PER_ORG
# @category Knowledge Layer
# @type int
# @default 0
# @required false
# Most queued ingestion jobs one organisation may have running across the whole
# fleet; 0 for no cap. The claim is fair without it (fewest running first).
def _per_org_cap() -> int:
    return _int_env("GRID_INGEST_MAX_PER_ORG", 0)


# @environment_variable GRID_INGEST_CLAIM_STALE_SECONDS
# @category Knowledge Layer
# @type int
# @default 180
# @required false
# A claimed ingestion job whose worker has not beaten for this long is claimed
# again, up to `GRID_INGEST_CLAIM_MAX_ATTEMPTS` times.
def _stale_seconds() -> int:
    return max(30, _int_env("GRID_INGEST_CLAIM_STALE_SECONDS", 180))


# @environment_variable GRID_INGEST_CLAIM_MAX_ATTEMPTS
# @category Knowledge Layer
# @type int
# @default 3
# @required false
# Claims of one ingestion job before it is given up as interrupted: a file that
# kills its worker every time must not take a worker down forever.
def _max_attempts() -> int:
    return max(1, _int_env("GRID_INGEST_CLAIM_MAX_ATTEMPTS", 3))


# ----------------------------------------------------------------- payload


def _encode_entry(entry: Any) -> Any:
    from ..routes.ingest import DeferredObjectDownload

    if isinstance(entry, DeferredObjectDownload):
        return {_DOWNLOAD: entry.to_payload()}
    return entry


def durable(prepared: PreparedIngestJob) -> bool:
    """Whether the job can run in another process: every file a deferred download."""
    from ..routes.ingest import DeferredObjectDownload

    entries = list(prepared.file_paths)
    for key in _DEFERRED_CONFIG_LISTS:
        entries.extend(prepared.config.get(key) or [])
    return bool(prepared.file_paths) and all(isinstance(e, DeferredObjectDownload) for e in entries)


def encode(prepared: PreparedIngestJob) -> str:
    """The job as the queue stores it: encrypted, with its downloads as plain data."""
    config = dict(prepared.config)
    for key in _DEFERRED_CONFIG_LISTS:
        if key in config:
            config[key] = [_encode_entry(e) for e in config[key]]
    return payload_crypto.serialize(
        {
            "job_id": prepared.job_id,
            "status": prepared.status.model_dump(mode="json"),
            "file_paths": [_encode_entry(e) for e in prepared.file_paths],
            "collection_name": prepared.collection_name,
            "config": config,
        }
    )


def _decode_entry(entry: Any) -> Any:
    from ..routes.ingest import DeferredObjectDownload

    if isinstance(entry, dict) and _DOWNLOAD in entry:
        return DeferredObjectDownload.from_payload(entry[_DOWNLOAD])
    raise ValueError("a queued ingestion job may only carry object-store downloads")


def decode(stored: str) -> PreparedIngestJob:
    """Inverse of ``encode``; raises on anything a worker must not run."""
    from ..routes.ingest import _assert_fetchable_object_store_url

    data = payload_crypto.deserialize(stored)
    config = dict(data["config"])
    for key in _DEFERRED_CONFIG_LISTS:
        if key in config:
            config[key] = [_decode_entry(e) for e in config[key]]
    for key in _URL_CONFIG_KEYS:
        if config.get(key):
            _assert_fetchable_object_store_url(config[key], field=key)
    return PreparedIngestJob(
        job_id=data["job_id"],
        status=IngestionJobStatus.model_validate(data["status"]),
        file_paths=[_decode_entry(e) for e in data["file_paths"]],
        collection_name=data["collection_name"],
        config=config,
    )


# ---------------------------------------------------------------- dispatch


def dispatch(ingestor: BaseIngestor, prepared: PreparedIngestJob) -> None:
    """Hand a PENDING job to the durable queue, or to this process when it cannot go there."""
    if prepared.status.status != JobState.PENDING:
        return
    if queue_enabled() and getattr(ingestor, "supports_durable_jobs", False) is True and durable(prepared):
        try:
            ingest_queue.enqueue(prepared.job_id, prepared.organization_id, encode(prepared))
            logger.info("Ingestion job %s queued for any worker", prepared.job_id)
            return
        except Exception:
            # Class name only: the payload and its error carry presigned URLs.
            logger.warning("Could not queue ingestion job %s durably; running it here", prepared.job_id)
    ingestor.submit_prepared(prepared)


# ------------------------------------------------------------------ claims


class QueueSource:
    """What an ingestor's free worker asks for its next job (``FairIngestScheduler`` source).

    Claims the fairest job, beats for it while it runs, and forgets it when it
    is done. A payload that cannot be read (corrupt, a KEK it was not written
    with, a URL off the object store) is never run: its row is dropped and its
    status settled failed at once.
    """

    def __init__(self, ingestor: BaseIngestor, *, heartbeat_seconds: int = 30) -> None:
        self._ingestor = ingestor
        self._worker = ingest_status_store.OWNER
        self._heartbeat_seconds = heartbeat_seconds
        self._stale = _stale_seconds()
        self._max_attempts = _max_attempts()
        self._cap = _per_org_cap()
        self._next_reap = 0.0

    def __call__(self) -> Callable[[], None] | None:
        if time.monotonic() >= self._next_reap:
            # Not on every poll: idle workers ask every few seconds, and one
            # reaper per cycle across the fleet is all the table needs.
            self._next_reap = time.monotonic() + self._heartbeat_seconds
            ingest_queue.reap_exhausted(stale_seconds=self._stale, max_attempts=self._max_attempts)
        claim = ingest_queue.claim_next(
            self._worker, stale_seconds=self._stale, max_attempts=self._max_attempts, per_lane_cap=self._cap
        )
        if claim is None:
            return None
        try:
            prepared = decode(claim.payload)
        except Exception as error:  # noqa: BLE001 - a poison row must not reach the ingestor
            reason = type(error).__name__
            return lambda: self._quarantine(claim.job_id, reason)
        logger.info("Claimed ingestion job %s (lane %s, attempt %d)", claim.job_id, claim.lane, claim.attempts)
        return lambda: self._run(claim.job_id, prepared)

    def _run(self, job_id: str, prepared: PreparedIngestJob) -> None:
        stop = threading.Event()
        lost = threading.Event()
        beat = threading.Thread(
            target=self._beat, args=(job_id, stop, lost), daemon=True, name=f"ingest-claim-{job_id[:8]}"
        )
        beat.start()
        try:
            self._ingestor.run_prepared(prepared, still_owner=lambda: self._still_owner(job_id, lost))
        finally:
            stop.set()
            ingest_queue.mark_done(job_id, self._worker)

    def _still_owner(self, job_id: str, lost: threading.Event) -> bool:
        """Whether this worker still holds the claim, asked of the database at the moment it matters.

        The ingestor asks before reading each file and before writing its
        chunks, so a run that lost its claim (it stalled past the stale window
        and another worker took the job) stops before writing anything twice.
        A database that cannot answer is not a lost claim: the run goes on.
        """
        if lost.is_set():
            return False
        try:
            if ingest_queue.heartbeat(job_id, self._worker):
                return True
        except Exception:  # noqa: BLE001 - an unanswered question is not a "no"
            logger.warning("Could not confirm the claim on ingestion job %s; continuing", job_id, exc_info=True)
            return True
        lost.set()
        return False

    def _beat(self, job_id: str, stop: threading.Event, lost: threading.Event) -> None:
        while not stop.wait(self._heartbeat_seconds):
            try:
                if not ingest_queue.heartbeat(job_id, self._worker):
                    # Another worker holds it now. The ingestor stops at its
                    # next check, before it writes this file's chunks.
                    logger.warning("Lost the claim on ingestion job %s", job_id)
                    lost.set()
                    return
            except Exception:  # noqa: BLE001 - a missed beat is retried; the stale window allows several
                logger.warning("Heartbeat for ingestion job %s failed", job_id, exc_info=True)

    def _quarantine(self, job_id: str, reason: str) -> None:
        logger.error("Ingestion job %s has an unreadable payload (%s); dropped", job_id, reason)
        ingest_queue.mark_done(job_id)
        status = ingest_status_store.get(job_id)
        if status is not None and status.status in (JobState.PENDING, JobState.PROCESSING):
            failed = ingest_status_store.interrupted(status)
            failed.error_message = (
                "unreadable_job: the queued ingestion job could not be read; retry to index this file"
            )
            ingest_status_store.put(failed)


def worker_id() -> str:
    """This process as a claim's ``claimed_by``."""
    return ingest_status_store.OWNER


def attach(ingestor: BaseIngestor | None, *, claim: bool | None = None) -> bool:
    """Start claiming from the durable queue in this process, when it should; whether it does.

    ``claim`` overrides ``GRID_INGEST_QUEUE_CLAIM``: the ingest-worker tier
    exists to claim, whatever the web tier's environment it shares says.
    """
    if ingestor is None or getattr(ingestor, "supports_durable_jobs", False) is not True:
        return False
    if not (queue_enabled() and (claim_enabled() if claim is None else claim)):
        logger.info("This process does not claim queued ingestion jobs")
        return False
    ingestor.attach_job_source(QueueSource(ingestor))
    logger.info("Claiming queued ingestion jobs (fair across organisations)")
    return True
