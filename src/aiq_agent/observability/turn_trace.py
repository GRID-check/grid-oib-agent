"""Which trace an answer was produced in, written down where the BFF can read it.

Langfuse identifies a trace by its OTel trace id, and NAT picks that id when a
workflow run starts: ``Runner.result_stream`` adopts ``workflow_trace_id`` from
the context when one is set and otherwise draws ``uuid4().int``
(``nat/runtime/runner.py``), and every span with no parent takes it
(``nat/observability/exporter/span_exporter.py``, ``_process_start_event``).
Nothing outside the process ever learned which id a turn got, so the BFF, where
a person rates an answer, could not name the trace that produced it.

Two halves close that, and both live here so they cannot drift apart:

* **The chat turn pins its trace id to its answer's id.** The answer id is
  already a UUID, derived per ``(conversation, turn)``
  (``turn.response.answer_message_id``), and an OTel trace id is 128 bits, the
  size of a UUID. :func:`trace_id_for_message` is that identity; the chat
  socket binds it with :func:`pinned_trace` before the run starts, so the turn's
  spans, and the research job it hands off (which inherits the parent's trace,
  ``aiq_api.jobs.submit``), land in the trace named by the answer.
* **The persisted answer row says which trace it is in**, under
  :data:`TRACE_ID_METADATA_KEY`, as the 32-hex-digit spelling Langfuse shows in
  its URLs. The chat socket writes the pinned id; the jobs runner writes the id
  its run actually used (:func:`current_trace_id_hex`), which for a job a chat
  turn handed off is that turn's. The BFF reads this key and nothing else: a
  row without it is a row whose trace nobody recorded, not one to guess at.

Telemetry bookkeeping, so best-effort throughout: a malformed id yields no pin
and no key, never an exception in the turn.
"""

from __future__ import annotations

import contextlib
import logging
import uuid
from collections.abc import Iterator

logger = logging.getLogger(__name__)

#: The message-row metadata key naming the OTel/Langfuse trace (32 lowercase hex).
TRACE_ID_METADATA_KEY = "trace_id"


def trace_id_for_message(message_id: str | None) -> int | None:
    """The trace id a turn answering as ``message_id`` runs in: the UUID's own 128 bits.

    ``None`` when the id is not a UUID (or is the nil UUID, which OTel reserves
    as "invalid"), so the caller leaves NAT to draw its own.
    """
    if not message_id:
        return None
    try:
        value = uuid.UUID(str(message_id)).int
    except (ValueError, TypeError, AttributeError):
        return None
    return value or None


def trace_id_hex(trace_id: int | None) -> str | None:
    """``trace_id`` as Langfuse spells it: 32 lowercase hex digits, or None."""
    if not isinstance(trace_id, int) or trace_id <= 0 or trace_id >= 1 << 128:
        return None
    return f"{trace_id:032x}"


def _context_state():  # noqa: ANN202 — NAT's type, imported lazily like everywhere else here
    from nat.plugin_api import ContextState

    return ContextState.get()


@contextlib.contextmanager
def pinned_trace(trace_id: int | None) -> Iterator[None]:
    """Run the enclosed workflow in trace ``trace_id``; a no-op for None.

    Sets NAT's ``workflow_trace_id`` for this context and restores the previous
    value on exit, the token discipline every per-turn binding here follows.
    Tasks created inside (the workflow producer in ``workflow_stream``) copy
    the context and so see the pin.
    """
    token = None
    if trace_id is not None:
        try:
            token = _context_state().workflow_trace_id.set(trace_id)
        except Exception:  # noqa: BLE001 — a failed pin costs the link, never the turn
            logger.debug("Could not pin the workflow trace id", exc_info=True)
    try:
        yield
    finally:
        if token is not None:
            with contextlib.suppress(Exception):
                _context_state().workflow_trace_id.reset(token)


def current_trace_id_hex() -> str | None:
    """The trace id NAT's current workflow run is in, as 32 hex digits, or None."""
    try:
        return trace_id_hex(_context_state().workflow_trace_id.get())
    except Exception:  # noqa: BLE001 — outside a NAT context there is simply no trace
        return None
