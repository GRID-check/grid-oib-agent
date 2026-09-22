"""DB-claimed research worker (ADR-0021).

Run as a dedicated container: ``python -m aiq_api.jobs.worker``. It claims
``research_job_queue`` rows (``FOR UPDATE SKIP LOCKED``), executes the same
``run_agent_job`` body the Dask path runs, heartbeats the claim so a crash is
reclaimed, and marks the row done. Worker replicas scale research execution
horizontally, independently of the web tier. Cancellation needs nothing special
here: the cancel route flips ``job_info`` to INTERRUPTED and ``run_agent_job``'s
own 1 s ``CancellationMonitor`` honors it from any replica.

Config (env):
  NAT_JOB_STORE_DB_URL            jobs DB (Postgres in prod; required)
  GRID_RESEARCH_WORKERS           concurrent jobs per process (default 1)
  GRID_RESEARCH_WORKER_POLL_SECONDS    idle poll interval (default 5)
  GRID_RESEARCH_WORKER_STALE_SECONDS   claim considered dead after (default 90)
  GRID_RESEARCH_WORKER_MAX_ATTEMPTS    reclaim attempts before FAILURE (default 3)
  GRID_RESEARCH_WORKER_HEARTBEAT_SECONDS  heartbeat cadence (default 30)
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import socket

from . import queue
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


def _int_env(name: str, default: int) -> int:
    try:
        val = int(os.environ.get(name, ""))
        return val if val > 0 else default
    except (TypeError, ValueError):
        return default


class ResearchWorker:
    def __init__(self) -> None:
        self.db_url = os.environ.get("NAT_JOB_STORE_DB_URL", "sqlite:///./data/jobs.db")
        self.worker_id = f"{socket.gethostname()}:{os.getpid()}"
        self.concurrency = _int_env("GRID_RESEARCH_WORKERS", 1)
        self.poll_seconds = _int_env("GRID_RESEARCH_WORKER_POLL_SECONDS", 5)
        self.stale_seconds = _int_env("GRID_RESEARCH_WORKER_STALE_SECONDS", 90)
        self.max_attempts = _int_env("GRID_RESEARCH_WORKER_MAX_ATTEMPTS", 3)
        self.heartbeat_seconds = _int_env("GRID_RESEARCH_WORKER_HEARTBEAT_SECONDS", 30)
        # Liveness marker file the k8s probe checks (the backend image has no
        # pgrep/procps). Touched every loop tick; a stale mtime => the loop hung.
        self.liveness_file = os.environ.get("GRID_WORKER_LIVENESS_FILE", "/tmp/research-worker.alive")
        self._stop = asyncio.Event()
        self._running: set[asyncio.Task] = set()

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
        logger.info("Worker %s running job %s (attempt %s)", self.worker_id, job_id, claim["attempts"])
        # run_agent_job owns its own job_info status transitions + telemetry.
        # Still-owner publish gate (hardening item 10): hand our claim id to
        # the run so a reclaimed loser publishes nothing user-visible
        # (status/turn/notice) — the spread keeps old payloads without the key
        # working, with our id winning over the submit-time None.
        run_task = asyncio.create_task(run_agent_job(**{**payload, "claim_owner": self.worker_id}))
        heartbeat = asyncio.create_task(self._heartbeat_loop(job_id, run_task))
        claim_lost = False
        try:
            await run_task
        except asyncio.CancelledError:
            # Heartbeat cancelled us because we lost the claim — another worker
            # owns the job now; yield quietly.
            claim_lost = True
            logger.warning("Run for job %s aborted after claim loss", job_id)
        except Exception:
            logger.exception("Job %s failed in worker %s", job_id, self.worker_id)
        finally:
            heartbeat.cancel()
            # Ownership-guarded: if we lost the claim, this deletes nothing and
            # leaves the new owner's row intact.
            await asyncio.to_thread(queue.mark_done, self.db_url, job_id, self.worker_id)
            # Terminal on THIS worker (success or error — not a claim loss, where
            # the new owner may still resume) -> drop the durable deep checkpoint
            # so those tables don't grow forever.
            if not claim_lost:
                await asyncio.to_thread(_purge_deep_checkpoint, job_id)

    async def _fail_poison(self, claim: dict) -> None:
        """Record the FAILURE verdict for a quarantined queue payload.

        The queue row is already deleted by ``claim_next`` — this only flips
        the durable record (``job_info``, via the sticky-terminal conditional
        so a concurrent cancel/reaper verdict wins) and emits the ``job.error``
        event both surfaces stream. Best-effort throughout: a poison verdict
        must never itself kill the poll loop. There is no conversation notice
        or outcome notify here — the payload was undecryptable, so the run's
        conversation/usage context is unrecoverable by construction.
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
                    store, job_id, JobStatus.FAILURE, error="research worker retries exhausted"
                )
                if written:
                    logger.error("Job %s marked FAILURE after retry exhaustion", job_id)
                else:
                    logger.info("Job %s already terminal; leaving the existing verdict", job_id)
            except Exception:
                logger.exception("Failed to mark exhausted job %s FAILURE", job_id)

    async def run(self) -> None:
        await asyncio.to_thread(queue.ensure_research_queue_table, self.db_url)
        logger.info(
            "Research worker %s started (concurrency=%s, poll=%ss, db=%s)",
            self.worker_id,
            self.concurrency,
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
                        queue.claim_next, self.db_url, self.worker_id, self.stale_seconds, self.max_attempts
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
            if not claimed_any:
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=self.poll_seconds)
                except TimeoutError:
                    pass
        logger.info("Research worker %s draining %s in-flight job(s)", self.worker_id, len(self._running))
        if self._running:
            await asyncio.gather(*self._running, return_exceptions=True)


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
