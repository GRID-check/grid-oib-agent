"""DB-claimed research worker (ADR-0021, ADR-0078).

Run as a dedicated container: ``python -m aiq_api.jobs.worker``. It claims
``research_job_queue`` rows on the claim substrate (``aiq_agent.common.claim_queue``:
fairly across organizations, interactive before bulk inside one, at most
``GRID_MAX_ACTIVE_JOBS_PER_ORG`` of an organization's jobs running at once),
executes the same ``run_agent_job`` body the Dask path runs, heartbeats the claim
so a crash is reclaimed, and marks the row done. Worker replicas scale research
execution horizontally, independently of the web tier, and KEDA scales them on the
queue's depth. Cancellation needs nothing special here: the cancel route flips
``job_info`` to INTERRUPTED and ``run_agent_job``'s own 1 s ``CancellationMonitor``
honors it from any replica.

On SIGTERM the worker stops claiming and waits up to
``GRID_RESEARCH_WORKER_DRAIN_SECONDS`` for the jobs it holds. A job still running
when that budget ends is given back to the queue at no cost in attempts, and
another worker claims it from the start at once; a pod that is killed instead
(OOM, node loss) leaves its claims to go stale and be claimed again.

Config (env):
  NAT_JOB_STORE_DB_URL            jobs DB (Postgres in prod; required)
  GRID_RESEARCH_WORKERS           concurrent jobs per process (default 1)
  GRID_RESEARCH_WORKER_POLL_SECONDS    idle poll interval (default 5)
  GRID_RESEARCH_WORKER_STALE_SECONDS   claim considered dead after (default 90)
  GRID_RESEARCH_WORKER_MAX_ATTEMPTS    claims before the job is dead (default 3)
  GRID_RESEARCH_WORKER_HEARTBEAT_SECONDS  heartbeat cadence (default 30)
  GRID_RESEARCH_WORKER_DRAIN_SECONDS   drain budget on SIGTERM (default 600)
  GRID_RESEARCH_DEAD_RETENTION_DAYS    how long a dead row is kept (default 14)
  GRID_MAX_ACTIVE_JOBS_PER_ORG    one organization's concurrent jobs (default 3)
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import socket
import time

from . import queue
from .outcome_notify import notify_job_outcome_from_access
from .runner import _purge_deep_checkpoint
from .runner import _update_status_if_not_terminal
from .runner import run_agent_job

logger = logging.getLogger(__name__)

# User-safe verdict for a quarantined queue payload. The stored blob was corrupt
# (bad base64 / torn write), undecryptable (KEK rotation, tampered tag), forged
# plaintext under KEK, or decoded to a non-dict — either way it can never run.
# The full exception stays server-side in the logs; clients get this string via
# job_info.error and the job.error event (same surfaces as runner failures).
POISON_PAYLOAD_ERROR = "The job payload could not be decrypted or parsed and was quarantined."
RETRIES_EXHAUSTED_ERROR = "research worker retries exhausted"

#: How often the worker deletes dead rows past their retention.
_PURGE_EVERY_SECONDS = 3600


def _int_env(name: str, default: int) -> int:
    try:
        val = int(os.environ.get(name, ""))
        return val if val > 0 else default
    except (TypeError, ValueError):
        return default


# @environment_variable GRID_RESEARCH_DEAD_RETENTION_DAYS
# @category Server
# @type int
# @default 14
# @required false
# How long a dead research queue row (a job that failed every claim, or whose
# payload could not be read) is kept as a trace before it is deleted.
def _dead_retention_seconds() -> int:
    return _int_env("GRID_RESEARCH_DEAD_RETENTION_DAYS", 14) * 86400


class ResearchWorker:
    def __init__(self) -> None:
        self.db_url = os.environ.get("NAT_JOB_STORE_DB_URL", "sqlite:///./data/jobs.db")
        self.worker_id = f"{socket.gethostname()}:{os.getpid()}"
        self.concurrency = _int_env("GRID_RESEARCH_WORKERS", 1)
        self.poll_seconds = _int_env("GRID_RESEARCH_WORKER_POLL_SECONDS", 5)
        self.stale_seconds = _int_env("GRID_RESEARCH_WORKER_STALE_SECONDS", 90)
        self.max_attempts = _int_env("GRID_RESEARCH_WORKER_MAX_ATTEMPTS", 3)
        self.heartbeat_seconds = _int_env("GRID_RESEARCH_WORKER_HEARTBEAT_SECONDS", 30)
        # How long a stopping worker waits for the jobs it holds before it gives them back.
        self.drain_seconds = _int_env("GRID_RESEARCH_WORKER_DRAIN_SECONDS", 600)
        # One organization's concurrent jobs, fleet-wide: the claim's per-lane cap (0 = none).
        self.per_org_cap = max(0, queue.max_active_per_org())
        # Liveness marker file the k8s probe checks (the backend image has no
        # pgrep/procps). Touched every loop tick; a stale mtime => the loop hung.
        self.liveness_file = os.environ.get("GRID_WORKER_LIVENESS_FILE", "/tmp/research-worker.alive")
        self._stop = asyncio.Event()
        self._running: set[asyncio.Task] = set()
        #: The claims this process holds, by job id, so a drain can give them back.
        self._held: dict[str, asyncio.Task] = {}
        self._next_purge = 0.0

    def _touch_liveness(self) -> None:
        try:
            with open(self.liveness_file, "w") as fh:
                fh.write("ok")
        except OSError:
            logger.warning("Could not write liveness file %s", self.liveness_file, exc_info=True)

    def request_stop(self) -> None:
        self._stop.set()

    async def _heartbeat_loop(self, job_id: str, run_task: asyncio.Task) -> None:
        """Keep the claim fresh while the job runs, and ABORT our own run if we
        lose ownership — otherwise a worker that stalled past the stale window
        (and was reclaimed by another worker) would keep running the same job,
        doubling LLM spend and duplicating memory writes.

        Transient DB errors are tolerated: we only give up after being unable to
        heartbeat for roughly the stale window (i.e. once another worker could
        legitimately reclaim), then cancel our run to stay single-execution.
        """
        max_consecutive = max(1, self.stale_seconds // max(1, self.heartbeat_seconds))
        consecutive_failures = 0
        while True:
            await asyncio.sleep(self.heartbeat_seconds)
            try:
                alive = await asyncio.to_thread(queue.heartbeat, self.db_url, job_id, self.worker_id)
                consecutive_failures = 0
            except Exception:
                consecutive_failures += 1
                logger.warning(
                    "Heartbeat DB error for job %s (%d/%d consecutive)",
                    job_id,
                    consecutive_failures,
                    max_consecutive,
                    exc_info=True,
                )
                if consecutive_failures >= max_consecutive:
                    logger.error("Cannot confirm ownership of job %s; aborting run to avoid duplicate", job_id)
                    run_task.cancel()
                    return
                continue
            if not alive:
                logger.warning("Lost claim on job %s (reclaimed/cancelled); aborting run", job_id)
                run_task.cancel()
                return

    async def _run_claimed(self, claim: dict) -> None:
        if claim.get(queue.POISON_CLAIM_MARKER):
            # Structural backstop: poison markers are routed to _fail_poison by
            # the poll loop and must never execute. If one arrives here, record
            # the verdict instead of running an absent payload.
            await self._fail_poison(claim)
            return
        job_id = claim["job_id"]
        payload = claim["payload"]
        logger.info(
            "Worker %s running job %s (attempt %s, lane %s, %s)",
            self.worker_id,
            job_id,
            claim["attempts"],
            claim.get("lane"),
            "bulk" if claim.get("priority") else "interactive",
        )
        started = time.monotonic()
        # run_agent_job owns its own job_info status transitions + telemetry.
        # Still-owner publish gate (hardening item 10): hand our claim id to
        # the run so a reclaimed loser publishes nothing user-visible
        # (status/turn/notice) — the spread keeps old payloads without the key
        # working, with our id winning over the submit-time None.
        run_task = asyncio.create_task(run_agent_job(**{**payload, "claim_owner": self.worker_id}))
        self._held[job_id] = run_task
        heartbeat = asyncio.create_task(self._heartbeat_loop(job_id, run_task))
        claim_lost = False
        try:
            await run_task
        except asyncio.CancelledError:
            # Heartbeat cancelled us because we lost the claim, or a drain gave
            # it back: another worker owns the job now; yield quietly.
            claim_lost = True
            logger.warning("Run for job %s aborted after claim loss", job_id)
        except Exception:
            logger.exception("Job %s failed in worker %s", job_id, self.worker_id)
        finally:
            heartbeat.cancel()
            self._held.pop(job_id, None)
            # Ownership-guarded: if we lost the claim, this deletes nothing and
            # leaves the new owner's row intact.
            await asyncio.to_thread(queue.mark_done, self.db_url, job_id, self.worker_id)
            if not claim_lost:
                queue.queue_for(self.db_url).record_duration(time.monotonic() - started, self._kind(payload))
            # Terminal on THIS worker (success or error — not a claim loss, where
            # the new owner may still resume) -> drop the durable deep checkpoint
            # so those tables don't grow forever.
            if not claim_lost:
                await asyncio.to_thread(_purge_deep_checkpoint, job_id)

    @staticmethod
    def _kind(payload: dict) -> str:
        """The job's kind for ``grid.queue.job_duration_seconds``: its agent, a small closed set."""
        return str(payload.get("agent_config_name") or "research")

    async def _fail_poison(self, claim: dict) -> None:
        """Record the FAILURE verdict for a quarantined queue payload.

        The queue row is already retired (dead, its payload blanked) by
        ``claim_next`` — this only flips the durable record (``job_info``, via the sticky-terminal conditional
        so a concurrent cancel/reaper verdict wins) and emits the ``job.error``
        event both surfaces stream. Best-effort throughout: a poison verdict
        must never itself kill the poll loop. There is no conversation notice
        here — the payload was undecryptable, so the run's conversation/usage
        context is unrecoverable by construction. The outcome IS reported: its
        tenant is on the ``job_access`` row, not in the payload, and without the
        report the BFF's run row stays ``running`` forever.
        """
        job_id = claim["job_id"]
        logger.error(
            "Job %s payload quarantined (%s); marking FAILURE",
            job_id,
            claim.get("poison_error", "undecryptable payload"),
        )
        from nat.front_ends.fastapi.async_jobs.job_store import JobStatus
        from nat.front_ends.fastapi.async_jobs.job_store import JobStore

        try:
            store = JobStore(scheduler_address="", db_url=self.db_url)
            written = await _update_status_if_not_terminal(store, job_id, JobStatus.FAILURE, error=POISON_PAYLOAD_ERROR)
            if written:
                logger.error("Job %s marked FAILURE after payload quarantine", job_id)
                await notify_job_outcome_from_access(
                    job_id=job_id, db_url=self.db_url, status="failure", error=POISON_PAYLOAD_ERROR
                )
            else:
                logger.info("Job %s already terminal; leaving the existing verdict", job_id)
        except Exception:
            logger.exception("Failed to mark quarantined job %s FAILURE", job_id)
        try:
            from .event_store import EventStore

            def _store_poison_event() -> None:
                EventStore(self.db_url, job_id).store(
                    {
                        "type": "job.error",
                        "data": {"error": POISON_PAYLOAD_ERROR, "error_type": "PoisonPayloadError"},
                    }
                )

            await asyncio.to_thread(_store_poison_event)
        except Exception:
            logger.warning("Failed to store job.error event for quarantined job %s (non-fatal)", job_id, exc_info=True)

    async def _fail_exhausted(self) -> None:
        """Flip crashed-and-exhausted claims to FAILURE in job_info."""
        reaped = await asyncio.to_thread(queue.reap_exhausted, self.db_url, self.stale_seconds, self.max_attempts)
        if not reaped:
            return
        from nat.front_ends.fastapi.async_jobs.job_store import JobStatus
        from nat.front_ends.fastapi.async_jobs.job_store import JobStore

        store = JobStore(scheduler_address="", db_url=self.db_url)
        for job_id in reaped:
            try:
                # Conditional: the run may have finalized itself after its
                # claim went stale (same sticky-terminal contract as the
                # runner and the ghost-job reaper). Also spelled as the enum,
                # not "FAILURE": NAT's JobStatus lookup is by value
                # ("failure"), so the old uppercase string raised ValueError
                # and these jobs were never actually marked.
                written = await _update_status_if_not_terminal(
                    store, job_id, JobStatus.FAILURE, error=RETRIES_EXHAUSTED_ERROR
                )
                if written:
                    logger.error("Job %s marked FAILURE after retry exhaustion", job_id)
                    # No run is left to report it: the BFF's run row closes here
                    # or never.
                    await notify_job_outcome_from_access(
                        job_id=job_id, db_url=self.db_url, status="failure", error=RETRIES_EXHAUSTED_ERROR
                    )
                else:
                    logger.info("Job %s already terminal; leaving the existing verdict", job_id)
            except Exception:
                logger.exception("Failed to mark exhausted job %s FAILURE", job_id)

    async def run(self) -> None:
        await asyncio.to_thread(queue.ensure_research_queue_table, self.db_url)
        # Depth, oldest age and dead rows are gauges this process reports for the fleet.
        queue.queue_for(self.db_url).observe()
        logger.info(
            "Research worker %s started (concurrency=%s, per-org cap=%s, poll=%ss, db=%s)",
            self.worker_id,
            self.concurrency,
            self.per_org_cap or "none",
            self.poll_seconds,
            self.db_url.split("@")[-1],
        )
        self._touch_liveness()
        while not self._stop.is_set():
            self._touch_liveness()
            self._running = {t for t in self._running if not t.done()}
            claimed_any = False
            while len(self._running) < self.concurrency:
                try:
                    claim = await asyncio.to_thread(
                        queue.claim_next,
                        self.db_url,
                        self.worker_id,
                        self.stale_seconds,
                        self.max_attempts,
                        self.per_org_cap,
                    )
                except Exception:
                    # Transient DB error: nothing was claimed (poison rows no
                    # longer raise — they come back as markers handled below),
                    # so skip the tick, never kill the poll loop over it.
                    logger.exception("Claim poll failed; skipping tick")
                    break
                if claim is None:
                    break
                if claim.get(queue.POISON_CLAIM_MARKER):
                    # Quarantined row: record FAILURE, then claim the next row
                    # in the same tick so a healthy job behind poison runs
                    # without waiting a poll interval.
                    await self._fail_poison(claim)
                    continue
                claimed_any = True
                self._running.add(asyncio.create_task(self._run_claimed(claim)))
            await self._fail_exhausted()
            await self._purge_dead()
            if not claimed_any:
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=self.poll_seconds)
                except TimeoutError:
                    pass
        await self._drain()

    async def _purge_dead(self) -> None:
        """Delete dead rows past their retention, at most once an hour per process."""
        now = time.monotonic()
        if now < self._next_purge:
            return
        self._next_purge = now + _PURGE_EVERY_SECONDS
        try:
            await asyncio.to_thread(queue.purge_dead, self.db_url, _dead_retention_seconds())
        except Exception:
            logger.warning("Purging dead research queue rows failed (non-fatal)", exc_info=True)

    async def _drain(self) -> None:
        """Wait for the jobs this worker holds; give back, at no cost, the ones that outlast the budget."""
        logger.info(
            "Research worker %s draining %s in-flight job(s) for up to %ss",
            self.worker_id,
            len(self._running),
            self.drain_seconds,
        )
        if not self._running:
            return
        _, unfinished = await asyncio.wait(self._running, timeout=self.drain_seconds)
        if unfinished:
            await self._give_back(unfinished)

    async def _give_back(self, unfinished: set[asyncio.Task]) -> None:
        """Requeue the claims of jobs that did not finish in the drain, stop their runs, then mark them waiting.

        The claims go back first: a run that stops while its row is still its own
        would delete the row on its way out, and a job that is neither running nor
        queued is lost. The runs are cancelled straight after, with nothing
        awaited in between, because a released row is any idle worker's to claim:
        every round trip before the cancel is time two runs of one job spend
        provider budget. Each aborted run sees its row QUEUED again, or claimed
        by another worker, which is a positive loss of the claim
        (``runner._lost_claim``), so it publishes nothing and the next worker's
        run is the one the reader sees. Only then is the job marked ``submitted``
        (so the ghost-job reaper leaves it alone), and only while nobody has
        claimed it since: a new owner's ``running`` is not set back.
        """
        held = dict(self._held)
        job_ids = list(held)
        released = await asyncio.to_thread(queue.release_claims, self.db_url, job_ids, self.worker_id)
        for task in held.values():
            task.cancel()
        logger.warning(
            "Research worker %s stopping with %d job(s) running; %d claim(s) given back to the queue",
            self.worker_id,
            len(job_ids),
            released,
        )
        await asyncio.gather(*unfinished, return_exceptions=True)
        await self._mark_waiting(job_ids)

    async def _mark_waiting(self, job_ids: list[str]) -> None:
        """Put requeued jobs back to ``submitted``: they wait in the queue like any other."""
        if not job_ids:
            return
        from nat.front_ends.fastapi.async_jobs.job_store import JobStore

        store = JobStore(scheduler_address="", db_url=self.db_url)
        for job_id in job_ids:
            try:
                await _mark_waiting_while_unclaimed(store, job_id)
            except Exception:
                logger.warning("Could not mark requeued job %s as waiting (non-fatal)", job_id, exc_info=True)


async def _mark_waiting_while_unclaimed(store, job_id: str) -> bool:
    """``running`` -> ``submitted`` in one statement, only while the job's queue row is still unclaimed.

    The row was released a moment ago. A worker that has claimed it since may
    already have written ``running`` for its own run, and that must stand: the
    reaper ignores ``submitted``, and the reader would see the job waiting.
    """
    from datetime import UTC as _UTC
    from datetime import datetime as _datetime

    from sqlalchemy import column
    from sqlalchemy import exists
    from sqlalchemy import table
    from sqlalchemy import update

    from nat.front_ends.fastapi.async_jobs.job_store import JobInfo
    from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

    row = table(queue.TABLE, column("job_id"), column("status"))
    stmt = (
        update(JobInfo)
        .where(
            JobInfo.job_id == job_id,
            JobInfo.status == JobStatus.RUNNING.value,
            exists().where(row.c.job_id == job_id, row.c.status == queue.QUEUED),
        )
        .values(status=JobStatus.SUBMITTED.value, updated_at=_datetime.now(_UTC))
    )
    async with store.session() as session:
        result = await session.execute(stmt)
    return (result.rowcount or 0) > 0


def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    worker = ResearchWorker()

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, worker.request_stop)
    try:
        loop.run_until_complete(worker.run())
    finally:
        loop.close()


if __name__ == "__main__":
    main()
