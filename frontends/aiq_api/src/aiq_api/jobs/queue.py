"""The research queue: ``research_job_queue`` on the claim substrate (ADR-0021, ADR-0079).

The submit path persists a deep-research job as a row here. Dedicated worker
containers claim rows, run the job in-process, and heartbeat the row so a crashed
worker's job is reclaimed. This is what lets research execution scale
horizontally across worker replicas.

The claim itself is ``aiq_agent.common.claim_queue``, the algorithm ingestion
runs on too, so this module is only what is research's own: its table, its lane
(the organisation), its encrypted payload and its poison verdict.

* FAIR. A free worker takes the next job of the organisation with the fewest
  research jobs running anywhere, then the one served longest ago. One office's
  scheduled sweep of twenty jobs does not make another office's question wait for
  all twenty.
* PRIORITISED. Inside one organisation an ``interactive`` job (a question the
  reader escalated, a "run now") goes before a ``bulk`` one (a scheduled fire).
* CAPPED PER ORGANISATION, by claiming. ``GRID_MAX_ACTIVE_JOBS_PER_ORG`` is how
  many of an organisation's jobs run at once; the rest wait their turn.
* KEPT WHEN DEAD. A job that crashed every worker that took it is moved to
  ``status='dead'`` with a reason, not deleted: dead rows are the trace, counted
  by ``grid.queue.dead_total`` and never counted as work.
* GIVEN BACK WHEN A WORKER DRAINS. ``release_claims`` requeues the jobs a stopping
  worker could not finish, without spending an attempt.

This table carries only *dispatch* metadata and the serialized
``run_agent_job`` payload. User-facing status stays in NAT's ``job_info``
(written by the runner) and events stay in ``job_events``: SSE streaming is
unchanged, and a job that waits here is ``SUBMITTED`` there.

Cancellation is handled entirely through ``job_info`` (the cancel route flips it
to INTERRUPTED, which the runner's ``CancellationMonitor`` honors) plus deleting
the queue row, so there is deliberately no ``cancel_requested`` column here.
A FINISHED job's row is deleted too (``mark_done``); only a job that could not
finish stays, as dead.
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Any

from aiq_agent.common.claim_queue import CLAIMED
from aiq_agent.common.claim_queue import DEAD
from aiq_agent.common.claim_queue import QUEUED
from aiq_agent.common.claim_queue import ClaimQueue
from aiq_agent.knowledge.ingest_scheduler import lane_of

from . import payload_crypto

logger = logging.getLogger(__name__)

__all__ = [
    "CLAIMED",
    "DEAD",
    "NAME",
    "POISON_CLAIM_MARKER",
    "QUEUED",
    "TABLE",
    "claim_next",
    "claim_owner",
    "claim_state",
    "counts",
    "enqueue",
    "ensure_research_queue_table",
    "heartbeat",
    "lane_for",
    "mark_dead",
    "mark_done",
    "max_active_per_org",
    "max_queued_per_org",
    "purge_dead",
    "queue_for",
    "queued_in_lane",
    "reap_exhausted",
    "release_claims",
]

TABLE = "research_job_queue"
TURNS_TABLE = "research_lane_turns"
#: The queue's name in ``grid.queue.*`` meters.
NAME = "research"

#: Why a poison row is retired, as stored in ``dead_reason``.
REASON_POISON = "payload_unreadable"
#: Why a job that never ran is retired when its submission is withdrawn.
REASON_WITHDRAWN = "withdrawn"

# Marker key on ``claim_next`` results whose stored payload could not be
# deserialized (corrupt ``enc:`` blob, undecryptable KEK rotation, forged
# plaintext under KEK). The row is already retired (dead) when the marker is
# returned, so the worker must record the FAILURE verdict in ``job_info`` and
# move on, never hand the row to ``run_agent_job``.
POISON_CLAIM_MARKER = "poison"

# Transaction-level advisory lock so only ONE worker replica runs the
# exhausted-claim reap per cycle. Without it every worker ran the scan on every
# poll tick, so DB load scaled with replica count, not job volume (scaling
# review phase-2, item 12). Distinct from the web-tier reaper/cleanup lock ids in
# routes/jobs.py. "AIQRXHS" in hex.
_PG_REAP_EXHAUSTED_LOCK_ID = 0x41495152_58485300

# @environment_variable GRID_MAX_ACTIVE_JOBS_PER_ORG
# @category Server
# @type int
# @default 3
# @required false
# Research jobs one organization may RUN at once, fleet-wide, so one tenant cannot
# occupy every worker. It is the claim's per-lane cap: a job over it waits in the
# queue instead of being refused. 0 or negative disables it.
_MAX_ACTIVE_PER_ORG_ENV = "GRID_MAX_ACTIVE_JOBS_PER_ORG"
_DEFAULT_MAX_ACTIVE_PER_ORG = 3

# @environment_variable GRID_MAX_QUEUED_JOBS_PER_ORG
# @category Server
# @type int
# @default 50
# @required false
# Research jobs one organization may have WAITING in the queue (db execution).
# Past it a submit is refused with 429: abuse protection against a runaway caller,
# not capacity management, because capacity makes a job wait, never fail. 0 or
# negative disables the bound.
_MAX_QUEUED_PER_ORG_ENV = "GRID_MAX_QUEUED_JOBS_PER_ORG"
_DEFAULT_MAX_QUEUED_PER_ORG = 50


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, ""))
    except (TypeError, ValueError):
        return default


def max_active_per_org() -> int:
    """Research jobs an organization may run at once; 0 or less is no cap."""
    return _int_env(_MAX_ACTIVE_PER_ORG_ENV, _DEFAULT_MAX_ACTIVE_PER_ORG)


def max_queued_per_org() -> int:
    """Research jobs an organization may have waiting; 0 or less is no bound."""
    return _int_env(_MAX_QUEUED_PER_ORG_ENV, _DEFAULT_MAX_QUEUED_PER_ORG)


def lane_for(organization_id: str | None) -> str:
    """The lane a research job waits in: its organization, or the platform's."""
    return lane_of(organization_id)


def _engine(db_url: str):
    from .event_store import EventStore

    return EventStore._get_or_create_sync_engine(db_url)


_queues: dict[str, ClaimQueue] = {}
_queues_lock = threading.Lock()


def _connection(db_url: str):
    return _engine(db_url).connect()


def queue_for(db_url: str) -> ClaimQueue:
    """The research queue of one database (the job store's), built once per URL."""
    with _queues_lock:
        queue = _queues.get(db_url)
        if queue is None:
            queue = ClaimQueue(
                name=NAME,
                table=TABLE,
                turns_table=TURNS_TABLE,
                db_url=lambda: db_url,
                engine_for=_engine,
                reap_lock_id=_PG_REAP_EXHAUSTED_LOCK_ID,
            )
            _queues[db_url] = queue
        return queue


def ensure_research_queue_table(db_url: str) -> None:
    """Create the queue and its lane-turn table once per process; an older table is upgraded in place."""
    queue_for(db_url).ensure_table(db_url)


def enqueue(
    db_url: str,
    job_id: str,
    payload: dict[str, Any],
    organization_id: str | None = None,
    priority: str | None = None,
) -> None:
    """Persist a claimable research job. Payload = ``run_agent_job`` kwargs.

    ``priority`` is ``interactive`` (the default) or ``bulk``: inside one
    organization, interactive jobs are claimed first.
    """
    queue_for(db_url).enqueue(job_id, lane_for(organization_id), payload_crypto.serialize(payload), priority)


def queued_in_lane(db_url: str, organization_id: str | None) -> int:
    """Research jobs of one organization still waiting for a worker."""
    return queue_for(db_url).queued_in_lane(lane_for(organization_id))


def claim_next(
    db_url: str,
    worker_id: str,
    stale_seconds: int,
    max_attempts: int,
    per_lane_cap: int = 0,
) -> dict[str, Any] | None:
    """Claim the fairest runnable job (queued, or stale-claimed for reclaim), or None.

    Returns ``{"job_id", "payload", "attempts", "lane", "priority"}``, a poison
    marker ``{"job_id", "poison": True, "poison_error": ...}`` (row already dead:
    record FAILURE, never execute), or None when nothing is runnable.

    A payload that cannot be read never raises. It is retired right here, so the
    worker loop survives a corrupt ``enc:`` blob by construction and its next
    claim in the same tick already sees the healthy row behind it. The claim has
    committed by then, so the row is CLAIMED for the instant before it is dead:
    no other worker is handed it, because a claim is exclusive.
    """
    claim = queue_for(db_url).claim_next(
        worker_id, stale_seconds=stale_seconds, max_attempts=max_attempts, per_lane_cap=per_lane_cap
    )
    if claim is None:
        return None
    try:
        payload = payload_crypto.deserialize(claim.payload)
        if not isinstance(payload, dict):
            raise ValueError(f"job payload decoded to {type(payload).__name__}, not a dict")
    except Exception as exc:
        return _quarantine_poison(db_url, claim.job_id, exc)
    return {
        "job_id": claim.job_id,
        "payload": payload,
        "attempts": claim.attempts,
        "lane": claim.lane,
        "priority": claim.priority,
    }


def _quarantine_poison(db_url: str, job_id: str, exc: Exception) -> dict[str, Any]:
    """Retire an undecryptable or unparsable queue row, and say so in a marker.

    A poison payload is deterministic: retrying it after the stale window just
    kills the next claimant identically. Retiring it here means no worker ever
    blocks on it and no replica ever dies on it. The caller returns the marker so
    the worker can record the FAILURE verdict in ``job_info`` (the durable
    record) plus a ``job.error`` event; the dead row, its payload blanked, is the
    queue's own trace.

    Only the exception *type* is kept server-side in the marker detail; the raw
    stored blob is never echoed (it may carry a forged auth token).
    """
    logger.error(
        "Retiring undecryptable queue payload for job %s (%s); row is dead, not run",
        job_id,
        type(exc).__name__,
        exc_info=True,
    )
    queue_for(db_url).mark_dead(job_id, REASON_POISON)
    return {
        "job_id": job_id,
        POISON_CLAIM_MARKER: True,
        "poison_error": f"{type(exc).__name__}: job payload undecryptable or unparsable",
    }


def heartbeat(db_url: str, job_id: str, worker_id: str) -> bool:
    """Refresh the claim's heartbeat. Returns False if we no longer own it
    (reclaimed by another worker / row deleted by cancel) so the worker can
    abort its run promptly and avoid duplicate execution."""
    return queue_for(db_url).heartbeat(job_id, worker_id)


def claim_state(db_url: str, job_id: str) -> tuple[str | None, str | None]:
    """``(status, claimed_by)`` of the live, non-dead row for ``job_id``, or ``(None, None)``.

    Read-only probe for the runner's still-owner publish gate (deep-research
    hardening, item 10). Never raises: an unreadable row is the same answer as an
    absent one, which every caller treats as indeterminate.
    """
    from sqlalchemy import text

    try:
        queue_for(db_url).ensure_table(db_url)
        with _connection(db_url) as conn:
            row = conn.execute(
                # Only module constants are interpolated; the id and the status are bound.
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(f"SELECT status, claimed_by FROM {TABLE} WHERE job_id = :job_id AND status <> :dead"),
                {"job_id": job_id, "dead": DEAD},
            ).first()
    except Exception:
        logger.warning("Claim-state read failed for job %s (treating as indeterminate)", job_id, exc_info=True)
        return None, None
    if row is None:
        return None, None
    owner = row[1]
    return row[0], owner if isinstance(owner, str) and owner else None


def claim_owner(db_url: str, job_id: str) -> str | None:
    """The worker holding the live CLAIMED row for ``job_id``, or None.

    A worker that lost its claim to another replica must publish nothing
    user-visible — no terminal status steal, no thread turn or notice — so the
    thread, the persisted report and the job status stay one coherent artefact,
    published by the winner alone.

    None is *indeterminate*, not "unowned": the row may be gone (the cancel
    route and mark_done delete it unconditionally on their paths), may still be
    QUEUED (see ``claim_state`` for what that says of a run that is alive), or may
    be unreadable. Callers fall back to the job_info terminal verdict in that case
    and fail open. Never raises.
    """
    status, owner = claim_state(db_url, job_id)
    return owner if status == CLAIMED else None


def mark_done(db_url: str, job_id: str, worker_id: str | None = None) -> None:
    """Remove a finished job's queue row (terminal status lives in job_info).

    When ``worker_id`` is given the delete is guarded by ownership, so a stalled
    worker that lost its claim (and whose job another worker now owns) cannot
    delete the new owner's live row. The cancel route passes no worker_id — it
    intends to drop the row unconditionally.
    """
    queue_for(db_url).mark_done(job_id, worker_id)


def release_claims(db_url: str, job_ids: list[str], worker_id: str) -> int:
    """Give a draining worker's claimed jobs back WITHOUT spending an attempt; how many."""
    return queue_for(db_url).release_claims(job_ids, worker_id)


def mark_dead(db_url: str, job_id: str, reason: str) -> bool:
    """Retire a job that must not run, keeping the row as the trace; whether a live row was retired."""
    return queue_for(db_url).mark_dead(job_id, reason)


def reap_exhausted(db_url: str, stale_seconds: int, max_attempts: int) -> list[str]:
    """Move claims that crashed and exhausted their retries to dead; return their ids.

    Callers flip these to FAILURE in job_info (the durable record). The row stays,
    as dead, until ``purge_dead`` ages it out: it is not work, so it is in no
    autoscaler's depth.
    """
    return queue_for(db_url).reap_exhausted(stale_seconds=stale_seconds, max_attempts=max_attempts)


def purge_dead(db_url: str, older_than_seconds: int) -> int:
    """Delete dead rows past their retention; how many."""
    return queue_for(db_url).purge_dead(older_than_seconds=older_than_seconds)


def counts(db_url: str) -> dict[str, int]:
    """Rows by status. The autoscaler scales on every row that is not dead."""
    return queue_for(db_url).counts()
