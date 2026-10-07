"""The running turn's own clock on its conversation marker (ADR-0080, "the owner fences itself").

A turn that runs while ``GRID_CHAT_AFFINITY`` is off holds ``conv:<id>:running``
in Dragonfly, with a TTL it renews. Once that TTL runs out, a newer question on
another replica may take the marker and start writing the same LangGraph
thread. The turn must therefore be silent before that, and it cannot ask: the
reason it would ask is that Dragonfly may be unreachable, or the task that
renews may be late. So the answer comes from a local clock alone.

``deadline = (start of the last successful renewal) + TTL - margin``.

* **Measured from before the command was sent.** The server set its expiry
  after the command arrived, so the marker outlives the deadline by at least
  the round trip, never the other way round.
* **The margin covers one write in flight.** A write that began just before the
  deadline cannot be called back, so each guarded write must end within
  ``GUARDED_WRITE_TIMEOUT_SECONDS`` (``aiq_agent.common.write_fence``) of the
  deadline (not of its own start: a slow write with runway left is not cut off)
  and the margin is that bound plus ``FENCE_SLACK_SECONDS`` for cancellation latency
  and clock skew. It must stay below the TTL, or the turn would be fenced from
  the moment it started: :func:`fence_margin` refuses such a TTL.
* **Every write compares the clock itself.** :meth:`TurnFence.fenced` reads
  ``time.monotonic()`` on every call, so a renewal task that is starved or
  late cannot leave a stale "still the owner". The task that renews only
  extends the deadline and, when it sees the deadline pass, ends the turn.
* **Fenced is final.** The first time a check finds the deadline passed (or a
  renewal finds the marker gone) the flag is set and stays: a late successful
  renewal does not bring the turn back, because the turn is already being
  cancelled and may have refused a write.

Not covered: a marker that vanishes before its TTL (Dragonfly restarted without
its data, a failover that lost the key, a manual delete) can be taken at once,
and nothing local can know. Dragonfly is cache-only (ADR-0020); the renewal's
``False`` fences the turn the next time it runs, which is the most this
mechanism can do.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable

logger = logging.getLogger(__name__)

#: The longest one guarded write (a checkpoint write, the outcome's persist) may take.
GUARDED_WRITE_TIMEOUT_SECONDS = 3.0
#: What the margin adds to one write: the cancel reaching the turn, and clock skew.
FENCE_SLACK_SECONDS = 1.0


def fence_margin() -> float:
    """How long before the marker's expiry the turn stops writing."""
    return GUARDED_WRITE_TIMEOUT_SECONDS + FENCE_SLACK_SECONDS


def validate_running_ttl(ttl: float) -> float:
    """``ttl`` when it leaves the turn time to write before the fence closes, else a ``ValueError``."""
    margin = fence_margin()
    if margin >= ttl:
        raise ValueError(
            f"GRID_CHAT_RUNNING_TTL_SECONDS={ttl:g} is not above the fence margin of {margin:g}s "
            f"(a guarded write may take {GUARDED_WRITE_TIMEOUT_SECONDS:g}s): a turn would be fenced as it starts"
        )
    return ttl


class TurnFence:
    """One turn's answer to "may I still write my conversation?", from the clock alone.

    Implements :class:`aiq_agent.common.write_fence.WriteFence`.
    """

    def __init__(
        self, *, acquired_at: float, ttl: float, clock: Callable[[], float] = time.monotonic, label: str = ""
    ) -> None:
        self._ttl = validate_running_ttl(ttl)
        self._margin = fence_margin()
        self._clock = clock
        self._label = label
        self._deadline = acquired_at + self._ttl - self._margin
        self._tripped = False
        self._released = False
        self.write_timeout = GUARDED_WRITE_TIMEOUT_SECONDS

    @property
    def deadline(self) -> float:
        """The monotonic time after which the turn may not write."""
        return self._deadline

    def remaining(self) -> float:
        """Seconds until the deadline; 0 once it has passed."""
        return max(0.0, self._deadline - self._clock())

    def fenced(self) -> bool:
        """Whether the turn may no longer write. Reads the clock, and makes the answer final once it is yes."""
        if self._tripped:
            return True
        if self._released or self._clock() < self._deadline:
            return False
        self.trip("the renewal deadline passed")
        return True

    def renewed(self, sent_at: float) -> bool:
        """A renewal that was sent at ``sent_at`` succeeded. False when it came too late to count."""
        if self.fenced():
            return False
        self._deadline = max(self._deadline, sent_at + self._ttl - self._margin)
        return True

    def trip(self, reason: str) -> None:
        """Close the fence for good (the marker was lost, or the deadline passed)."""
        if not self._tripped:
            self._tripped = True
            logger.warning("Turn %s is fenced: %s", self._label or "?", reason)

    def release(self) -> None:
        """The turn ended on its own: its late, harmless writes (stage frames, the persist) are not fenced.

        A fence that already closed stays closed.
        """
        self._released = True
