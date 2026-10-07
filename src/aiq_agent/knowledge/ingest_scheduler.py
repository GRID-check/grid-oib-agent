"""Fair share of the ingest workers between organisations.

The ingestor used to hand every job to one ``ThreadPoolExecutor``: a FIFO
across every tenant. One office's folder upload or project reindex of a few
hundred plan sets queued every other office's single upload behind it for
hours, and nothing reordered the queue.

This scheduler keeps one lane per organisation and gives a free worker to the
organisation with the FEWEST jobs running; among those, to the one served
LONGEST AGO, which is round-robin when every lane has as many running (one
worker, or a full house). The oldest waiting job breaks what is left. It is
work-conserving: while nobody else waits, one organisation may use
every worker; the moment a second one submits, its job takes the next worker
that frees up. ``per_org_cap`` (off by default) additionally bounds how many
workers one organisation may hold at once, at the price of idle workers when
it is the only one with work.

A job with no organisation (the base-corpus sync, a RIS fetch) is its own lane,
``PLATFORM_LANE``, and is scheduled like any organisation.

A SOURCE is the other way work arrives: a callable a worker asks when it is
free, which claims one job from somewhere else (the durable queue,
``aiq_agent.knowledge.ingest_queue``) and returns it as a zero-argument callable,
or None when there is nothing. Local lanes and the source take turns, so neither
starves the other; the source orders its own jobs fairly (the claim query does
the same fewest-running-first ordering, across every replica).

A worker counts as BUSY from the moment it asks the source, not from the moment
the claim returns: a drain that waits for ``busy`` must not see zero while a
claim is committed in the database and not yet running. A job claimed after the
source was detached is given back (``release``, when the job has one) instead of
started.

Stdlib only and free of the ingestor, so it is tested on its own.
"""

from __future__ import annotations

import itertools
import logging
import os
import threading
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

#: The lane of a job no organisation owns.
PLATFORM_LANE = "__platform__"

#: What a source hands back: the claimed job, ready to run, or None. A job may
#: also have a ``release()``, which gives the claim back without running it.
JobSource = Callable[[], Callable[[], None] | None]

_CAP_ENV = "GRID_INGEST_MAX_PER_ORG"
_LEGACY_CAP_ENV = "AIQ_INGEST_MAX_PER_ORG"
_legacy_cap_warned = False


# @environment_variable GRID_INGEST_MAX_PER_ORG
# @category Knowledge Layer
# @type int
# @default 0
# @required false
# Most ingestion jobs one organisation may have running; 0 for no cap. Across
# the whole fleet for jobs in the durable queue, and per process for jobs in a
# process's own pool. The claim is fair without it (fewest running first); a
# cap also idles workers when one organisation is alone. `AIQ_INGEST_MAX_PER_ORG`
# is the deprecated name for the same setting.
def per_org_cap_from_env() -> int:
    """The per-organisation cap: ``GRID_INGEST_MAX_PER_ORG``, else its deprecated alias."""
    global _legacy_cap_warned
    raw = os.environ.get(_CAP_ENV, "").strip()
    if not raw:
        raw = os.environ.get(_LEGACY_CAP_ENV, "").strip()
        if raw and not _legacy_cap_warned:
            _legacy_cap_warned = True
            logger.warning("%s is deprecated; set %s instead", _LEGACY_CAP_ENV, _CAP_ENV)
    try:
        return max(0, int(raw))
    except ValueError:
        return 0


@dataclass
class _Queued:
    seq: int
    lane: str
    run: Callable[[], None]


def lane_of(organization_id: str | None) -> str:
    """The lane a job with this organisation id waits in."""
    return organization_id or PLATFORM_LANE


class FairIngestScheduler:
    """``workers`` threads shared fairly between organisations (see module docstring).

    Threads start on the first submit or source, not in the constructor, so an
    ingestor built for a test or a CLI run costs none.
    """

    def __init__(
        self,
        workers: int,
        *,
        name: str = "ingest",
        per_org_cap: int = 0,
        idle_poll_seconds: float = 5.0,
    ) -> None:
        self._workers = max(1, workers)
        self._name = name
        self._per_org_cap = max(0, per_org_cap)
        self._idle_poll_seconds = idle_poll_seconds
        self._cond = threading.Condition()
        self._lanes: dict[str, deque[_Queued]] = {}
        self._running: dict[str, int] = {}
        # When each lane was last given a worker (a tick of `_served`); a lane
        # never served ranks first. One entry per organisation ever seen.
        self._last_served: dict[str, int] = {}
        self._served = itertools.count()
        self._busy = 0
        self._seq = itertools.count()
        self._source: JobSource | None = None
        self._prefer_source = False
        self._threads: list[threading.Thread] = []
        self._stopping = False

    # ------------------------------------------------------------------ intake

    def submit(self, organization_id: str | None, fn: Callable[..., Any], *args: Any) -> None:
        """Queue ``fn(*args)`` in the organisation's lane."""
        lane = lane_of(organization_id)
        item = _Queued(seq=next(self._seq), lane=lane, run=lambda: fn(*args))
        with self._cond:
            if self._stopping:
                raise RuntimeError("the ingest scheduler is shutting down")
            self._lanes.setdefault(lane, deque()).append(item)
            self._ensure_started()
            self._cond.notify()

    def attach_source(self, source: JobSource) -> None:
        """Let free workers also claim from ``source`` (one source; a second replaces the first)."""
        with self._cond:
            self._source = source
            self._ensure_started()
            self._cond.notify_all()

    def detach_source(self) -> None:
        """Stop claiming from the source; jobs already claimed run to the end."""
        with self._cond:
            self._source = None

    # ------------------------------------------------------------- inspection

    def waiting(self) -> dict[str, int]:
        """Jobs waiting per lane, for logs and tests."""
        with self._cond:
            return {lane: len(items) for lane, items in self._lanes.items() if items}

    def running(self) -> dict[str, int]:
        """Local jobs running per lane (claimed source jobs are not attributed)."""
        with self._cond:
            return {lane: n for lane, n in self._running.items() if n}

    @property
    def busy(self) -> int:
        """Workers running a job right now, local or claimed, or claiming one (see the module docstring)."""
        with self._cond:
            return self._busy

    # -------------------------------------------------------------- lifecycle

    def shutdown(self, wait: bool = True, timeout: float | None = None) -> None:
        """Stop taking work; with ``wait``, let the running jobs finish.

        Jobs still waiting in a local lane are dropped, as the executor this
        replaced dropped its queue: they have no durable record to run from.
        Claimed source jobs are durable and are reclaimed by another worker.
        """
        with self._cond:
            self._stopping = True
            self._source = None
            self._cond.notify_all()
            threads = list(self._threads)
        if wait:
            for thread in threads:
                thread.join(timeout)

    # ---------------------------------------------------------------- workers

    def _ensure_started(self) -> None:
        """Start the worker threads once. Caller holds ``_cond``."""
        if self._threads:
            return
        for index in range(self._workers):
            thread = threading.Thread(target=self._work, name=f"{self._name}-{index}", daemon=True)
            self._threads.append(thread)
            thread.start()

    def _pick_local(self) -> _Queued | None:
        """The head of the least-served eligible lane, or None. Caller holds ``_cond``."""
        best: _Queued | None = None
        best_key: tuple[int, int, int] | None = None
        for lane, items in self._lanes.items():
            if not items:
                continue
            running = self._running.get(lane, 0)
            if self._per_org_cap and running >= self._per_org_cap:
                continue
            key = (running, self._last_served.get(lane, -1), items[0].seq)
            if best_key is None or key < best_key:
                best, best_key = items[0], key
        if best is None:
            return None
        self._lanes[best.lane].popleft()
        self._last_served[best.lane] = next(self._served)
        if not self._lanes[best.lane]:
            del self._lanes[best.lane]
        return best

    def _next(self, source_was_empty: bool) -> tuple[_Queued | None, JobSource | None]:
        """Block until there is local work or a source to ask; None, None to stop.

        ``source_was_empty``: the last claim found nothing, so local work is
        taken first and the source is asked again only after a poll interval
        (or at once, when a submit wakes the worker with nothing local left).
        """
        with self._cond:
            while True:
                if self._stopping:
                    return None, None
                source = self._source if not source_was_empty else None
                # Take turns so a busy source cannot starve the local lanes, and
                # a long local backlog cannot keep the durable queue waiting.
                if source is not None and self._prefer_source:
                    self._prefer_source = False
                    return None, source
                local = self._pick_local()
                if local is not None:
                    self._prefer_source = True
                    self._running[local.lane] = self._running.get(local.lane, 0) + 1
                    self._busy += 1
                    return local, None
                if source is not None:
                    return None, source
                self._cond.wait(self._idle_poll_seconds if self._source is not None else None)
                source_was_empty = False

    def _work(self) -> None:
        source_was_empty = False
        while True:
            local, source = self._next(source_was_empty)
            if local is None and source is None:
                return
            if local is not None:
                self._run_local(local)
                source_was_empty = False
                continue
            source_was_empty = not self._run_claimed(source)

    def _run_local(self, item: _Queued) -> None:
        try:
            item.run()
        except Exception:  # noqa: BLE001 - one job's failure must not take a worker with it
            logger.exception("Ingest job in lane %s raised", item.lane)
        finally:
            with self._cond:
                self._running[item.lane] -= 1
                if not self._running[item.lane]:
                    del self._running[item.lane]
                self._busy -= 1
                self._cond.notify()

    def _run_claimed(self, source: JobSource | None) -> bool:
        """Ask the source for a job and run it; whether there was one.

        Busy for the whole ask, so a claim that commits is never invisible to a
        drain between the database and the run.
        """
        if source is None:
            return False
        with self._cond:
            self._busy += 1
        try:
            job = self._claim(source)
            if job is None:
                return False
            try:
                job()
            except Exception:  # noqa: BLE001
                logger.exception("Claimed ingest job raised")
            return True
        finally:
            with self._cond:
                self._busy -= 1
                self._cond.notify()

    def _claim(self, source: JobSource) -> Callable[[], None] | None:
        """The job the source claimed, or None: nothing waits, the claim failed, or it was given back."""
        try:
            job = source()
        except Exception:  # noqa: BLE001 - a failed claim is an empty one; the next poll retries
            logger.warning("Claiming an ingest job failed; retrying on the next poll", exc_info=True)
            return None
        if job is None:
            return None
        with self._cond:
            leaving = self._stopping or self._source is None
        release = getattr(job, "release", None)
        if leaving and callable(release):
            # Claimed in the instant the worker stopped asking: another worker takes it now.
            try:
                release()
            except Exception:  # noqa: BLE001 - the stale window returns it, as for any lost claim
                logger.warning("Giving back an ingest claim failed; it will be claimed again when stale", exc_info=True)
            return None
        return job
