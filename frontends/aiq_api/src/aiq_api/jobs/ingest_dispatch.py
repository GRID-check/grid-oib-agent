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

A claimed job is held until it is done, and given back, not lost, when its
worker cannot finish it:

* A drain that runs out of time releases what the process still holds
  (``release_held``), costing the jobs no attempt.
* A job past ``GRID_INGEST_MAX_JOB_SECONDS``, or silent for
  ``GRID_INGEST_PROGRESS_TIMEOUT_SECONDS``, stops being heartbeat, so its claim
  goes stale and another worker takes it (up to the attempt limit, then dead).
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
from aiq_agent.knowledge.ingest_scheduler import per_org_cap_from_env
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


def _per_org_cap() -> int:
    """``GRID_INGEST_MAX_PER_ORG`` (documented with ``per_org_cap_from_env``): the fleet-wide cap."""
    return per_org_cap_from_env()


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


# @environment_variable GRID_INGEST_MAX_JOB_SECONDS
# @category Knowledge Layer
# @type int
# @default 7200
# @required false
# The longest one claimed ingestion job may run. Past it the worker stops
# heartbeating and stops the job at its next check, and the claim goes stale and
# is claimed again (up to `GRID_INGEST_CLAIM_MAX_ATTEMPTS`, then the job is dead).
# 0 for no limit.
def _max_job_seconds() -> int:
    return _int_env("GRID_INGEST_MAX_JOB_SECONDS", 7200)


# @environment_variable GRID_INGEST_PROGRESS_TIMEOUT_SECONDS
# @category Knowledge Layer
# @type int
# @default 900
# @required false
# A claimed ingestion job that has not started a file or written its chunks for
# this long is treated as hung: its worker stops heartbeating it, so it goes
# stale and another worker claims it. It resumes beating if the job moves again
# before then. 0 for no check. Must exceed the slowest single file.
def _progress_timeout_seconds() -> int:
    return _int_env("GRID_INGEST_PROGRESS_TIMEOUT_SECONDS", 900)


# @environment_variable GRID_INGEST_DEAD_RETENTION_DAYS
# @category Knowledge Layer
# @type int
# @default 14
# @required false
# How long a dead ingestion queue row (a job that failed every claim, or whose
# payload could not be read) is kept as a trace before it is deleted.
def _dead_retention_seconds() -> int:
    return max(1, _int_env("GRID_INGEST_DEAD_RETENTION_DAYS", 14)) * 86400


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
            ingest_queue.enqueue(prepared.job_id, prepared.organization_id, encode(prepared), prepared.priority)
            logger.info("Ingestion job %s queued for any worker", prepared.job_id)
            return
        except Exception:
            # Class name only: the payload and its error carry presigned URLs.
            logger.warning("Could not queue ingestion job %s durably; running it here", prepared.job_id)
    ingestor.submit_prepared(prepared)


# ------------------------------------------------------------------ claims

#: What a heartbeat decides about a running job, once per beat.
_BEAT = "beat"
_STALLED = "stalled"
_EXPIRED = "expired"


class _Run:
    """What one claimed job's heartbeat watches: how long it has run, and when it last moved."""

    def __init__(self) -> None:
        self.started = time.monotonic()
        self.last_progress = self.started
        #: Set when this run no longer owns the job; the ingestor stops at its next check.
        self.lost = threading.Event()
        #: Set when the run is over; ends its heartbeat.
        self.stop = threading.Event()
        #: The deadline, not another worker, ended the run: its row must stay for a reclaim.
        self.expired = False

    def progress(self) -> None:
        self.last_progress = time.monotonic()


def beat_verdict(run: _Run, *, now: float, max_job_seconds: int, progress_timeout_seconds: int) -> str:
    """Whether a run's claim should still be refreshed.

    ``expired``: past its maximum runtime, never refreshed again. ``stalled``:
    nothing started or written for the progress timeout, so this beat is
    skipped (a job that moves again is refreshed again). Pure, so it is tested
    without a clock. 0 disables either limit.
    """
    if max_job_seconds and now - run.started > max_job_seconds:
        return _EXPIRED
    if progress_timeout_seconds and now - run.last_progress > progress_timeout_seconds:
        return _STALLED
    return _BEAT


class ClaimedJob:
    """A claimed job as the scheduler runs it: callable, and able to be given back unrun."""

    def __init__(self, source: QueueSource, job_id: str, run: Callable[[], None]) -> None:
        self.job_id = job_id
        self._source = source
        self._run = run

    def __call__(self) -> None:
        self._run()

    def release(self) -> None:
        """Give the claim back without running it, at no cost in attempts."""
        self._source.release([self.job_id])


class QueueSource:
    """What an ingestor's free worker asks for its next job (``FairIngestScheduler`` source).

    Claims the fairest job, beats for it while it runs, and forgets it when it
    is done. A payload that cannot be read (corrupt, a KEK it was not written
    with, a URL off the object store) is never run: its row is retired dead and
    its status settled failed at once.

    Holds every claim until the job ends, so a worker that must leave can give
    them back (``release_held``) instead of leaving them to go stale.
    """

    def __init__(self, ingestor: BaseIngestor, *, heartbeat_seconds: int = 30) -> None:
        self._ingestor = ingestor
        self._worker = ingest_status_store.OWNER
        self._heartbeat_seconds = heartbeat_seconds
        self._stale = _stale_seconds()
        self._max_attempts = _max_attempts()
        self._cap = _per_org_cap()
        self._max_job_seconds = _max_job_seconds()
        self._progress_timeout_seconds = _progress_timeout_seconds()
        self._next_reap = 0.0
        self._next_purge = 0.0
        self._held: dict[str, _Run] = {}
        self._held_lock = threading.Lock()

    def __call__(self) -> Callable[[], None] | None:
        self._maintain()
        claim = ingest_queue.claim_next(
            self._worker, stale_seconds=self._stale, max_attempts=self._max_attempts, per_lane_cap=self._cap
        )
        if claim is None:
            return None
        run = _Run()
        with self._held_lock:
            self._held[claim.job_id] = run
        try:
            prepared = decode(claim.payload)
        except Exception as error:  # noqa: BLE001 - a poison row must not reach the ingestor
            reason = type(error).__name__
            return ClaimedJob(self, claim.job_id, lambda: self._quarantine(claim.job_id, reason))
        logger.info(
            "Claimed ingestion job %s (lane %s, attempt %d, priority %d)",
            claim.job_id,
            claim.lane,
            claim.attempts,
            claim.priority,
        )
        return ClaimedJob(self, claim.job_id, lambda: self._run(claim.job_id, prepared, run))

    def _maintain(self) -> None:
        """Reap exhausted claims and purge old dead rows, not on every poll.

        Idle workers ask every few seconds, and one reaper per cycle across the
        fleet is all the table needs.
        """
        now = time.monotonic()
        if now >= self._next_reap:
            self._next_reap = now + self._heartbeat_seconds
            ingest_queue.reap_exhausted(stale_seconds=self._stale, max_attempts=self._max_attempts)
        if now >= self._next_purge:
            self._next_purge = now + _PURGE_EVERY_SECONDS
            ingest_queue.purge_dead(older_than_seconds=_dead_retention_seconds())

    def _run(self, job_id: str, prepared: PreparedIngestJob, run: _Run) -> None:
        beat = threading.Thread(target=self._beat, args=(job_id, run), daemon=True, name=f"ingest-claim-{job_id[:8]}")
        beat.start()
        try:
            self._ingestor.run_prepared(prepared, still_owner=lambda: self._still_owner(job_id, run))
        finally:
            run.stop.set()
            self._finish(job_id, run)

    def _finish(self, job_id: str, run: _Run) -> None:
        """Account for a run that ended, and forget its job unless the deadline ended it."""
        with self._held_lock:
            self._held.pop(job_id, None)
        ingest_queue.QUEUE.record_duration(time.monotonic() - run.started, "ingest")
        if run.expired:
            # The row keeps its stale heartbeat: another worker takes the job,
            # and the attempt limit decides when it is given up.
            logger.error("Ingestion job %s ran past %ds and was stopped", job_id, self._max_job_seconds)
            return
        ingest_queue.mark_done(job_id, self._worker)

    def _still_owner(self, job_id: str, run: _Run) -> bool:
        """Whether this worker still holds the claim, asked of the database at the moment it matters.

        The ingestor asks before reading each file and before writing its
        chunks, so a run that lost its claim (it stalled past the stale window
        and another worker took the job) stops before writing anything twice.
        Each ask is also the run's proof of progress. A database that cannot
        answer is not a lost claim: the run goes on.
        """
        if run.lost.is_set():
            return False
        run.progress()
        try:
            if ingest_queue.heartbeat(job_id, self._worker):
                return True
        except Exception:  # noqa: BLE001 - an unanswered question is not a "no"
            logger.warning("Could not confirm the claim on ingestion job %s; continuing", job_id, exc_info=True)
            return True
        run.lost.set()
        return False

    def _beat(self, job_id: str, run: _Run) -> None:
        while not run.stop.wait(self._heartbeat_seconds):
            verdict = beat_verdict(
                run,
                now=time.monotonic(),
                max_job_seconds=self._max_job_seconds,
                progress_timeout_seconds=self._progress_timeout_seconds,
            )
            if verdict == _EXPIRED:
                # Stop the run at its next check, and let the claim go stale.
                run.expired = True
                run.lost.set()
                return
            if verdict == _STALLED:
                logger.warning("Ingestion job %s made no progress; its claim is no longer refreshed", job_id)
                continue
            try:
                if not ingest_queue.heartbeat(job_id, self._worker):
                    # Another worker holds it now. The ingestor stops at its
                    # next check, before it writes this file's chunks.
                    logger.warning("Lost the claim on ingestion job %s", job_id)
                    run.lost.set()
                    return
            except Exception:  # noqa: BLE001 - a missed beat is retried; the stale window allows several
                logger.warning("Heartbeat for ingestion job %s failed", job_id, exc_info=True)

    def release(self, job_ids: list[str]) -> int:
        """Give claims back without spending an attempt, and stop running them; how many were put back."""
        with self._held_lock:
            runs = [self._held.pop(job_id) for job_id in job_ids if job_id in self._held]
        for run in runs:
            run.lost.set()
            run.stop.set()
        return ingest_queue.release_claims(job_ids, self._worker)

    def release_held(self) -> int:
        """Give back every claim this process still holds (a drain that ran out of time)."""
        with self._held_lock:
            job_ids = list(self._held)
        return self.release(job_ids)

    def _quarantine(self, job_id: str, reason: str) -> None:
        logger.error("Ingestion job %s has an unreadable payload (%s); retired dead", job_id, reason)
        with self._held_lock:
            self._held.pop(job_id, None)
        ingest_queue.mark_dead(job_id, f"unreadable_payload: {reason}")
        status = ingest_status_store.get(job_id)
        if status is not None and status.status in (JobState.PENDING, JobState.PROCESSING):
            failed = ingest_status_store.interrupted(status)
            failed.error_message = (
                "unreadable_job: the queued ingestion job could not be read; retry to index this file"
            )
            ingest_status_store.put(failed)


#: Dead rows are looked for this often per process, not on every poll.
_PURGE_EVERY_SECONDS = 600

#: The source this process claims through, for ``release_held``.
_active: QueueSource | None = None


def worker_id() -> str:
    """This process as a claim's ``claimed_by``."""
    return ingest_status_store.OWNER


def release_held() -> int:
    """Give back the claims this process still holds without spending their attempts; how many.

    For a worker that must exit with jobs unfinished: another worker may take
    them now instead of after the stale window.
    """
    source = _active
    return source.release_held() if source is not None else 0


def attach(ingestor: BaseIngestor | None, *, claim: bool | None = None) -> bool:
    """Start claiming from the durable queue in this process, when it should; whether it does.

    ``claim`` overrides ``GRID_INGEST_QUEUE_CLAIM``: the ingest-worker tier
    exists to claim, whatever the web tier's environment it shares says.
    """
    global _active
    if ingestor is None or getattr(ingestor, "supports_durable_jobs", False) is not True:
        return False
    if not (queue_enabled() and (claim_enabled() if claim is None else claim)):
        logger.info("This process does not claim queued ingestion jobs")
        return False
    _active = QueueSource(ingestor)
    ingestor.attach_job_source(_active)
    ingest_queue.QUEUE.observe()
    logger.info("Claiming queued ingestion jobs (fair across organisations)")
    return True


def stamp_queue_ahead(statuses: dict[str, Any]) -> None:
    """Put each waiting job's place among its own office's jobs into ``metadata.queue_ahead``.

    Every pending status gets the key, ``None`` when the queue does not hold the
    job (an in-memory job, or the queue off), so a reader that showed a count
    clears it rather than keeping the last one. Best effort: a failed count
    leaves the statuses as they were, since the status is the answer and the
    count only decorates it.
    """
    waiting = [
        job_id for job_id, status in statuses.items() if status and status.get("status") == JobState.PENDING.value
    ]
    if not waiting:
        return
    ahead: dict[str, int] = {}
    if queue_enabled():
        try:
            ahead = ingest_queue.ahead_in_lane(waiting)
        except Exception as exc:
            logger.warning("ingest queue: counting the jobs ahead failed (%s)", type(exc).__name__)
            return
    for job_id in waiting:
        statuses[job_id].setdefault("metadata", {})["queue_ahead"] = ahead.get(job_id)
