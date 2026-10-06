"""The durable, fair claim queue for ingestion jobs.

An ingestion job used to live only in the memory of the replica that accepted
it: a restart lost every queued job (settled ``failed: interrupted``), a second
replica could not take work from the first, and nothing could scale ingestion
apart from the chat tier. A job the durable queue carries is a row here instead,
claimed by whichever worker is free, on any replica or in the dedicated
ingest-worker tier (``aiq_api.jobs.ingest_worker``).

The claim itself, its fairness across organisations (fewest running first, then
the lane served longest ago, then priority, then oldest), the heartbeat, the
reclaim of a dead worker's job, the release of a drained worker's jobs and the
dead rows are ``aiq_agent.common.claim_queue`` (ADR-0078), shared with the
research queue. This module is the ingestion queue on it: its table, its lane
(an organisation, or ``PLATFORM_LANE``) and the database it lives in, which is
the status store's.

The payload is opaque here: ``aiq_api.jobs.ingest_dispatch`` writes it
(encrypted, since it carries presigned URLs) and reads it back. The status store
(``ingest_status_store``) reads this table to know that a PENDING job whose
accepting replica is gone is still waiting here, not lost; a DEAD row does not
hold a job.
"""

from __future__ import annotations

import os

from aiq_agent.common import claim_queue
from aiq_agent.common.claim_queue import CLAIMED
from aiq_agent.common.claim_queue import DEAD
from aiq_agent.common.claim_queue import QUEUED
from aiq_agent.common.claim_queue import Claim

from .document_metadata_store import DocumentMetadataStore
from .ingest_scheduler import lane_of

__all__ = [
    "CLAIMED",
    "DEAD",
    "QUEUED",
    "TABLE",
    "Claim",
    "ahead_in_lane",
    "claim_next",
    "counts",
    "db_url",
    "enqueue",
    "ensure_table",
    "heartbeat",
    "mark_dead",
    "mark_done",
    "mark_ensured",
    "purge_dead",
    "reap_exhausted",
    "release_claims",
]

TABLE = "ingest_job_queue"
#: The queue's name in ``grid.queue.*`` meters.
NAME = "ingest"

#: One replica reaps exhausted claims per cycle ("AIQINGRP" in hex).
_PG_REAP_LOCK_ID = 0x41495149_4E475250


def db_url() -> str | None:
    """The database the queue lives in: the ingest status store's."""
    url = os.environ.get("AIQ_SUMMARY_DB") or os.environ.get("NAT_JOB_STORE_DB_URL")
    return url or None


def _engine(url: str):
    return DocumentMetadataStore._get_or_create_sync_engine(url)


QUEUE = claim_queue.ClaimQueue(
    name=NAME,
    table=TABLE,
    turns_table="ingest_lane_turns",
    db_url=db_url,
    engine_for=_engine,
    reap_lock_id=_PG_REAP_LOCK_ID,
)

#: URLs whose table is known to exist; the status store's init and the tests share it.
_initialized = QUEUE.initialized


def ensure_table(url: str, conn=None) -> None:
    """Create the queue and the lane-turn tables once per process; an older table is upgraded in place.

    With ``conn`` the caller commits, then calls :func:`mark_ensured`.
    """
    QUEUE.ensure_table(url, conn)


def mark_ensured(url: str) -> None:
    """The caller's transaction that ran :func:`ensure_table` has committed."""
    QUEUE.mark_ensured(url)


def enqueue(job_id: str, organization_id: str | None, payload: str, priority: str | None = None) -> None:
    """Store a claimable job. Raises: the caller runs the job locally when this fails.

    ``priority`` is ``interactive`` (the default) or ``bulk``: inside one
    organisation, interactive jobs are claimed first.
    """
    QUEUE.enqueue(job_id, lane_of(organization_id), payload, priority)


def claim_next(worker: str, *, stale_seconds: int, max_attempts: int, per_lane_cap: int = 0) -> Claim | None:
    """Claim the fairest runnable job (``common.claim_queue``), or None."""
    return QUEUE.claim_next(worker, stale_seconds=stale_seconds, max_attempts=max_attempts, per_lane_cap=per_lane_cap)


def heartbeat(job_id: str, worker: str) -> bool:
    """Refresh a claim; False when it is not this worker's any more."""
    return QUEUE.heartbeat(job_id, worker)


def mark_done(job_id: str, worker: str | None = None) -> None:
    """Forget a finished job; with ``worker``, only while the claim is still its own."""
    QUEUE.mark_done(job_id, worker)


def release_claims(job_ids: list[str], worker: str) -> int:
    """Give a worker's claimed jobs back without spending an attempt; how many."""
    return QUEUE.release_claims(job_ids, worker)


def mark_dead(job_id: str, reason: str) -> bool:
    """Retire a job that must never run (an unreadable payload), keeping the row."""
    return QUEUE.mark_dead(job_id, reason)


def reap_exhausted(*, stale_seconds: int, max_attempts: int) -> list[str]:
    """Move claims that died ``max_attempts`` times to dead; their ids.

    Their status rows are then no longer held by the queue, so the status store
    settles them ``failed: interrupted`` like any job whose owner is gone.
    """
    return QUEUE.reap_exhausted(stale_seconds=stale_seconds, max_attempts=max_attempts)


def purge_dead(*, older_than_seconds: int) -> int:
    """Delete dead rows past their retention; how many."""
    return QUEUE.purge_dead(older_than_seconds=older_than_seconds)


def counts() -> dict[str, int]:
    """Rows by status. The autoscaler scales on every row that is not dead."""
    return QUEUE.counts()


def ahead_in_lane(job_ids: list[str]) -> dict[str, int]:
    """For each job still waiting, how many of its own lane's jobs wait ahead of it."""
    return QUEUE.ahead_in_lane(job_ids)
