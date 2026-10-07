"""How long a process takes to become useful, by phase (ADR-0082: cold start).

Every role's scale-out is bounded by its cold start: a KEDA replica is only
capacity once it can claim, and a web replica once it serves. This measures the
phases that cost the time, so the role-scoped boot is decided on readings from
the cluster rather than a laptop:

- ``ready``: the process's age when it can do its work, interpreter start
  included (read from ``/proc``, so the imports before any code here ran count).
- ``load_config`` and ``workflow_build``: NAT's config load and
  ``WorkflowBuilder.from_config``, the two steps every role pays.
- Under the role ``research-job``, the same two phases once per job: the
  research worker builds a workflow for every job it runs, not once per process.

Each reading is one ``grid.boot.phase_seconds`` histogram point with ``role`` and
``phase`` attributes, and one ``[boot-timing]`` log line. A reading taken before
the meter provider exists (it is installed while the workflow builds) would go
to a no-op instrument, so readings wait in the process until ``flush``, which a
role calls once a workflow is built. The research worker is ready before its
first job builds one, so that job's build flushes the worker's reading too.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager

from opentelemetry import metrics

logger = logging.getLogger(__name__)

PHASE_HISTOGRAM = "grid.boot.phase_seconds"

#: Seconds, from a fast import to a slow build on a cold node.
_BUCKETS = (0.5, 1, 2, 3, 5, 8, 13, 20, 30, 45, 60, 90, 120)

_histogram = None
_histogram_lock = threading.Lock()


def _phase_histogram():
    global _histogram
    with _histogram_lock:
        if _histogram is None:
            _histogram = metrics.get_meter("aiq_agent.boot").create_histogram(
                PHASE_HISTOGRAM,
                unit="s",
                description="Seconds a process spent in one phase of becoming useful.",
                explicit_bucket_boundaries_advisory=_BUCKETS,
            )
        return _histogram


def process_age_seconds(proc: str = "/proc") -> float | None:
    """Seconds since this process started, by the kernel's clock; None off Linux."""
    try:
        with open(f"{proc}/uptime", encoding="ascii") as f:
            uptime = float(f.read().split()[0])
        with open(f"{proc}/self/stat", encoding="ascii") as f:
            # The command name (field 2) may contain spaces; fields after its
            # closing parenthesis are fixed. starttime is field 22.
            after_name = f.read().rsplit(")", 1)[1].split()
    except OSError:
        return None
    start_ticks = int(after_name[19])
    return uptime - start_ticks / os.sysconf("SC_CLK_TCK")


_pending: list[tuple[str, str, float]] = []
_pending_lock = threading.Lock()


class BootClock:
    """The phases of one role's start. Readings wait in the process until ``flush``."""

    def __init__(self, role: str) -> None:
        self.role = role

    def record(self, phase: str, seconds: float) -> None:
        logger.info("[boot-timing] role=%s phase=%s seconds=%.2f", self.role, phase, seconds)
        with _pending_lock:
            _pending.append((self.role, phase, seconds))

    @contextmanager
    def phase(self, name: str) -> Iterator[None]:
        started = time.monotonic()
        try:
            yield
        finally:
            self.record(name, time.monotonic() - started)

    def ready(self) -> None:
        """The process can do its work now: record its age as the ``ready`` phase."""
        age = process_age_seconds()
        if age is not None:
            self.record("ready", age)


def flush() -> None:
    """Hand every pending reading to the histogram; call once a workflow is built."""
    global _pending
    with _pending_lock:
        pending, _pending = _pending, []
    histogram = _phase_histogram()
    for role, phase, seconds in pending:
        histogram.record(seconds, {"role": role, "phase": phase})
