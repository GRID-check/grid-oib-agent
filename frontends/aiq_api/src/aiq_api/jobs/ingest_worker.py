"""The dedicated ingestion worker tier (ADR-0074).

Run as its own container: ``GRID_ROLE=ingest-worker`` makes the entrypoint start
``python -m aiq_api.jobs.ingest_worker``. It builds the NAT workflow once, which
activates the ingestor exactly as the web tier's does (same summary model, same
shared Chroma, same object store), attaches the durable queue to it, and then
does nothing but claim: its ``AIQ_INGEST_MAX_WORKERS`` threads take the next job
fairly across every organisation, run it, and come back for another.

No web server, no port, no state of its own: jobs live in Postgres, vectors in
the shared Chroma. So the tier scales on the one number that says how much
ingestion is waiting, the depth of ``ingest_job_queue``, from zero workers when
nothing is queued to as many as the provider's rate limit allows.

On SIGTERM it stops claiming and waits up to ``GRID_INGEST_WORKER_DRAIN_SECONDS``
for the jobs it holds. A job still running when the pod dies is claimed again
by another worker once its heartbeat is stale; re-indexing replaces a file's
chunks, so the second run is the one that counts.

Config (env):
  CONFIG_FILE / NAT_CONFIG_FILE        the NAT config the web tier runs
  AIQ_INGEST_MAX_WORKERS               jobs this process runs at once (default 2)
  GRID_INGEST_WORKER_DRAIN_SECONDS     drain budget on SIGTERM (default 600)
  GRID_WORKER_LIVENESS_FILE            touched while the loop is alive
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal

from . import ingest_dispatch

logger = logging.getLogger(__name__)

_DEFAULT_CONFIG = "/app/configs/config_oib_openrouter.yml"
_LIVENESS_EVERY_SECONDS = 15


def _drain_seconds() -> int:
    try:
        return max(0, int(os.environ.get("GRID_INGEST_WORKER_DRAIN_SECONDS", "600")))
    except ValueError:
        return 600


def _touch(path: str) -> None:
    try:
        with open(path, "w") as handle:
            handle.write("ok")
    except OSError:
        logger.warning("Could not write the liveness file %s", path, exc_info=True)


async def run(stop: asyncio.Event) -> None:
    """Build the ingestor, claim until ``stop``, then drain."""
    from aiq_agent.knowledge.factory import get_active_ingestor
    from aiq_agent.observability import ensure_registered as register_grid_telemetry
    from nat.builder.workflow_builder import WorkflowBuilder
    from nat.runtime.loader import load_config

    config_file = os.environ.get("CONFIG_FILE") or os.environ.get("NAT_CONFIG_FILE") or _DEFAULT_CONFIG
    liveness = os.environ.get("GRID_WORKER_LIVENESS_FILE", "/tmp/ingest-worker.alive")
    # Grid's telemetry `_type`s register at import; load_config fails without them.
    register_grid_telemetry()
    config = load_config(config_file)
    async with WorkflowBuilder.from_config(config=config):
        ingestor = get_active_ingestor()
        if ingestor is None:
            raise RuntimeError(f"{config_file} activates no ingestor; there is nothing to run jobs with")
        if not ingest_dispatch.attach(ingestor, claim=True):
            raise RuntimeError("the ingest queue is off or has no database (GRID_INGEST_QUEUE, AIQ_SUMMARY_DB)")
        logger.info("Ingest worker %s claiming", ingest_dispatch.worker_id())
        while not stop.is_set():
            _touch(liveness)
            try:
                await asyncio.wait_for(stop.wait(), timeout=_LIVENESS_EVERY_SECONDS)
            except TimeoutError:
                pass
        await _drain(ingestor)


async def _drain(ingestor) -> None:
    ingestor.detach_job_source()
    budget = _drain_seconds()
    logger.info("Ingest worker draining %d job(s) for up to %ds", ingestor.busy_workers, budget)
    waited = 0.0
    while ingestor.busy_workers and waited < budget:
        await asyncio.sleep(1)
        waited += 1
    if ingestor.busy_workers:
        logger.warning(
            "Ingest worker stopping with %d job(s) running; they will be claimed again", ingestor.busy_workers
        )


def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    stop = asyncio.Event()
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    try:
        loop.run_until_complete(run(stop))
    finally:
        loop.close()


if __name__ == "__main__":
    main()
