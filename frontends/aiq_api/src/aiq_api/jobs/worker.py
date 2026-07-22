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
from .runner import run_agent_job

logger = logging.getLogger(__name__)


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
        self._stop = asyncio.Event()
        self._running: set[asyncio.Task] = set()

    def request_stop(self) -> None:
        self._stop.set()

    async def _heartbeat_loop(self, job_id: str) -> None:
        """Keep the claim fresh while the job runs; stop on loss of ownership."""
        while True:
            await asyncio.sleep(self.heartbeat_seconds)
            alive = await asyncio.to_thread(queue.heartbeat, self.db_url, job_id, self.worker_id)
            if not alive:
                # Reclaimed or cancelled elsewhere. run_agent_job's own monitor
                # handles a cancel; nothing more to do here.
                logger.warning("Lost claim on job %s (reclaimed/cancelled)", job_id)
                return

    async def _run_claimed(self, claim: dict) -> None:
        job_id = claim["job_id"]
        payload = claim["payload"]
        logger.info("Worker %s running job %s (attempt %s)", self.worker_id, job_id, claim["attempts"])
        heartbeat = asyncio.create_task(self._heartbeat_loop(job_id))
        try:
            # run_agent_job owns its own job_info status transitions + telemetry.
            await run_agent_job(**payload)
        except Exception:
            logger.exception("Job %s failed in worker %s", job_id, self.worker_id)
        finally:
            heartbeat.cancel()
            await asyncio.to_thread(queue.mark_done, self.db_url, job_id)

    async def _fail_exhausted(self) -> None:
        """Flip crashed-and-exhausted claims to FAILURE in job_info."""
        reaped = await asyncio.to_thread(queue.reap_exhausted, self.db_url, self.stale_seconds, self.max_attempts)
        if not reaped:
            return
        from nat.front_ends.fastapi.async_jobs.job_store import JobStore

        store = JobStore(scheduler_address="", db_url=self.db_url)
        for job_id in reaped:
            try:
                await store.update_status(job_id, "FAILURE", error="research worker retries exhausted")
                logger.error("Job %s marked FAILURE after retry exhaustion", job_id)
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
        while not self._stop.is_set():
            self._running = {t for t in self._running if not t.done()}
            claimed_any = False
            while len(self._running) < self.concurrency:
                claim = await asyncio.to_thread(
                    queue.claim_next, self.db_url, self.worker_id, self.stale_seconds, self.max_attempts
                )
                if claim is None:
                    break
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
