"""Per-turn agent execution profiler.

Captures a nested span tree (turn -> graph node -> LLM/tool call) for every
agent run and ships it to the platform-owner-only timeline view. Structured
exactly like ``cost_tracking.py``'s ``GridCostTracker``: one
``BaseCallbackHandler`` installed through LangChain's
``register_configure_hook`` seam, so every LLM/tool call inside an active
``track_agent_profile()`` block is captured with zero per-agent wiring —
new agents built on the same LLM/tool callback stack are covered
automatically. Events are written to the ``agent_profiler_spans`` ledger via
the token-guarded internal BFF endpoint ``POST
/api/internal/agent-profiler-spans``, mirroring the usage-ledger single-writer
rule (see docs/architecture/usage-budgets.md for the sibling mechanism this
one is modeled on).

Span nesting cannot ride the callback seam alone: LangGraph node functions
are plain callables invoked by the graph executor, not runnables dispatched
through the LangChain callback manager, so they carry no ``run_id``/
``parent_run_id`` of their own. ``current_span_var`` closes that gap — the id
of the innermost open span, pushed/reset with the same ContextVar token idiom
already used in this codebase for ``session_registry``/``card_registry``
(see ``chat_researcher/register.py``) — so nesting is correct across
``await`` boundaries without depending on LangChain/LangGraph callback
internals. ``profiled_node()`` wraps each graph node with it; LLM/tool spans
read it as their parent when they open.
"""

from __future__ import annotations

import json
import logging
import os
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from dataclasses import field
from threading import Lock
from typing import Any

from langchain_core.callbacks import BaseCallbackHandler

logger = logging.getLogger(__name__)

_REQUEST_TIMEOUT_SECONDS = 5
_FLUSH_BATCH_SIZE = 20

SpanKind = str  # 'turn' | 'node' | 'llm' | 'tool'

# Single background worker so ledger writes never block the answer path and
# arrive in order — same rationale as cost_tracking._flush_executor.
_flush_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="grid-profiler-flush")


@dataclass
class _OpenSpan:
    kind: SpanKind
    name: str
    parent_span_id: str | None
    started_monotonic: float
    started_at_iso: str
    metadata: dict[str, Any] | None = None


@dataclass
class SpanRecord:
    """One closed span, as recorded in the ``agent_profiler_spans`` ledger."""

    span_id: str
    parent_span_id: str | None
    kind: SpanKind
    name: str
    started_at: str
    ended_at: str
    duration_ms: int
    status: str
    error_message: str | None
    metadata: dict[str, Any] | None = field(default=None)

    def to_payload(self) -> dict[str, Any]:
        return {
            "spanId": self.span_id,
            "parentSpanId": self.parent_span_id,
            "kind": self.kind,
            "name": self.name,
            "startedAt": self.started_at,
            "endedAt": self.ended_at,
            "durationMs": self.duration_ms,
            "status": self.status,
            "errorMessage": self.error_message,
            "metadata": self.metadata,
        }


class AgentProfiler(BaseCallbackHandler):
    """Request-scoped callback: capture a nested span tree for one agent turn.

    Sync ``BaseCallbackHandler`` methods are invoked for async runs as well
    (LangChain dispatches them via the running loop's executor), so one
    implementation covers every agent that shares the LLM/tool callback
    stack — the same guarantee ``GridCostTracker`` relies on.
    """

    raise_error = False
    run_inline = True

    def __init__(
        self,
        *,
        organization_id: str | None,
        conversation_id: str | None,
        turn_id: str,
        job_id: str | None = None,
    ) -> None:
        self.organization_id = organization_id
        self.conversation_id = conversation_id
        self.turn_id = turn_id
        self.job_id = job_id
        self._lock = Lock()
        self._open: dict[str, _OpenSpan] = {}
        self._pending: list[SpanRecord] = []
        self._spans_recorded = 0
        # LLM/tool spans are keyed by the callback's run_id so on_*_end can
        # find the span it opened, exactly like GridCostTracker._requested_models.
        self._run_span: dict[Any, str] = {}

    # -- span lifecycle --------------------------------------------------------

    def start_span(self, kind: SpanKind, name: str, *, metadata: dict[str, Any] | None = None) -> str:
        span_id = str(uuid.uuid4())
        with self._lock:
            self._open[span_id] = _OpenSpan(
                kind=kind,
                name=name,
                parent_span_id=current_span_var.get(),
                started_monotonic=time.monotonic(),
                started_at_iso=_now_iso(),
                metadata=metadata,
            )
        return span_id

    def end_span(self, span_id: str, *, status: str = "ok", error: str | None = None) -> None:
        with self._lock:
            open_span = self._open.pop(span_id, None)
            if open_span is None:
                return
            duration_ms = max(0, round((time.monotonic() - open_span.started_monotonic) * 1000))
            record = SpanRecord(
                span_id=span_id,
                parent_span_id=open_span.parent_span_id,
                kind=open_span.kind,
                name=open_span.name,
                started_at=open_span.started_at_iso,
                ended_at=_now_iso(),
                duration_ms=duration_ms,
                status=status,
                error_message=error,
                metadata=open_span.metadata,
            )
            self._pending.append(record)
            self._spans_recorded += 1
            should_flush = len(self._pending) >= _FLUSH_BATCH_SIZE
        if should_flush:
            self.flush(wait=False)

    # -- LLM calls ---------------------------------------------------------------

    def _model_name(self, kwargs: dict[str, Any]) -> str:
        params = kwargs.get("invocation_params") or {}
        model = params.get("model") or params.get("model_name")
        return model if isinstance(model, str) else "llm"

    def on_llm_start(self, serialized: dict[str, Any], prompts: list[str], **kwargs: Any) -> None:
        self._start_run_span("llm", self._model_name(kwargs), kwargs)

    def on_chat_model_start(self, serialized: dict[str, Any], messages: Any, **kwargs: Any) -> None:
        self._start_run_span("llm", self._model_name(kwargs), kwargs)

    def on_llm_end(self, response: Any, **kwargs: Any) -> None:
        self._end_run_span(kwargs, status="ok")

    def on_llm_error(self, error: BaseException, **kwargs: Any) -> None:
        self._end_run_span(kwargs, status="error", error=str(error))

    # -- tool calls ----------------------------------------------------------------

    @staticmethod
    def _tool_name(serialized: dict | None, kwargs: dict[str, Any]) -> str:
        if serialized:
            return serialized.get("name") or "tool"
        return kwargs.get("name") or "tool"

    def on_tool_start(self, serialized: dict[str, Any], input_str: str, **kwargs: Any) -> None:
        self._start_run_span("tool", self._tool_name(serialized, kwargs), kwargs)

    def on_tool_end(self, output: Any, **kwargs: Any) -> None:
        self._end_run_span(kwargs, status="ok")

    def on_tool_error(self, error: BaseException, **kwargs: Any) -> None:
        self._end_run_span(kwargs, status="error", error=str(error))

    # -- run_id-keyed span helpers (shared by LLM + tool callbacks) --------------

    def _start_run_span(self, kind: SpanKind, name: str, kwargs: dict[str, Any]) -> None:
        run_id = kwargs.get("run_id")
        span_id = self.start_span(kind, name)
        if run_id is not None:
            with self._lock:
                self._run_span[run_id] = span_id
        # A run_id-less call still gets a span, but on_*_end for it (if any)
        # cannot look it up; such spans are effectively orphaned and never
        # closed. This matches how run_id is treated as required elsewhere
        # in this codebase (cost_tracking._requested_models).

    def _end_run_span(self, kwargs: dict[str, Any], *, status: str, error: str | None = None) -> None:
        run_id = kwargs.get("run_id")
        if run_id is None:
            return
        with self._lock:
            span_id = self._run_span.pop(run_id, None)
        if span_id is not None:
            self.end_span(span_id, status=status, error=error)

    # -- ledger flush ----------------------------------------------------------

    @property
    def spans_recorded(self) -> int:
        return self._spans_recorded

    def flush(self, *, wait: bool) -> None:
        """Send pending spans to the internal ledger endpoint.

        ``wait=False`` hands the batch to the background worker (answer
        path); ``wait=True`` posts inline (end of turn / job teardown).
        """
        with self._lock:
            batch, self._pending = self._pending, []
        if not batch:
            return
        payload = {
            "organizationId": self.organization_id,
            "conversationId": self.conversation_id,
            "turnId": self.turn_id,
            "jobId": self.job_id,
            "spans": [span.to_payload() for span in batch],
        }
        if wait:
            _post_profiler_spans(payload)
        else:
            _flush_executor.submit(_post_profiler_spans, payload)


def _now_iso() -> str:
    from datetime import UTC
    from datetime import datetime

    return datetime.now(UTC).isoformat()


def _post_profiler_spans(payload: dict[str, Any]) -> None:
    """POST one batch to the BFF ledger endpoint. Best-effort, never raises."""
    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        logger.warning("GRID_INTERNAL_API_TOKEN not configured — dropping %d profiler spans", len(payload["spans"]))
        return
    base_url = (
        os.environ.get("FRONTEND_INTERNAL_URL") or os.environ.get("FRONTEND_URL") or "http://frontend:3000"
    ).rstrip("/")
    request = urllib.request.Request(
        f"{base_url}/api/internal/agent-profiler-spans",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-grid-internal-token": token,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=_REQUEST_TIMEOUT_SECONDS) as response:
            if response.status not in (200, 201, 202):
                logger.warning("Internal profiler endpoint returned %s", response.status)
    except urllib.error.HTTPError as error:
        logger.warning("Internal profiler endpoint rejected batch: HTTP %s", error.code)
    except Exception:
        logger.warning("Failed to post profiler spans to internal endpoint", exc_info=True)


# -- activation ----------------------------------------------------------------

# register_configure_hook adds the handler held here to every callback manager
# LangChain configures while the var is set (inheritable across sub-runs) —
# the single seam that makes span capture agent-agnostic, mirroring
# cost_tracking.grid_cost_tracker_var.
agent_profiler_var: ContextVar[AgentProfiler | None] = ContextVar("agent_profiler", default=None)

# The innermost currently-open span id, read as the parent when a new span
# starts. Set by track_agent_profile() (root) and profiled_node() (per node);
# LLM/tool spans opened by the callback handler read it without setting it.
current_span_var: ContextVar[str | None] = ContextVar("agent_profiler_current_span", default=None)

try:
    from langchain_core.tracers.context import register_configure_hook

    register_configure_hook(agent_profiler_var, inheritable=True)
    _CONFIGURE_HOOK_INSTALLED = True
except Exception:  # pragma: no cover - defensive against langchain-core API drift
    logger.exception("Could not install LangChain configure hook; agent profiling is DISABLED")
    _CONFIGURE_HOOK_INSTALLED = False


def profiled_node(name: str, fn: Any) -> Any:
    """Wrap an async LangGraph node callable with a ``kind="node"`` span.

    A no-op when no profiler is active (e.g. outside ``track_agent_profile()``,
    or graph invocations that don't opt in), so it is safe to apply
    unconditionally at every ``graph.add_node(...)`` call site.
    """

    async def _wrapped(*args: Any, **kwargs: Any) -> Any:
        profiler = agent_profiler_var.get()
        if profiler is None:
            return await fn(*args, **kwargs)
        span_id = profiler.start_span("node", name)
        token = current_span_var.set(span_id)
        try:
            result = await fn(*args, **kwargs)
        except Exception as exc:
            profiler.end_span(span_id, status="error", error=str(exc))
            raise
        else:
            profiler.end_span(span_id, status="ok")
            return result
        finally:
            current_span_var.reset(token)

    _wrapped.__name__ = getattr(fn, "__name__", name)
    return _wrapped


def _read_identity_from_context() -> dict[str, str | None]:
    from aiq_agent.project_context import get_conversation_id_from_context
    from aiq_agent.project_context import get_organization_id_from_context

    return {
        "organization_id": get_organization_id_from_context(),
        "conversation_id": get_conversation_id_from_context(),
    }


@contextmanager
def track_agent_profile(
    *,
    agent_name: str,
    job_id: str | None = None,
    identity: dict[str, str | None] | None = None,
):
    """Activate span capture for the enclosed agent run.

    Opens a root ``kind="turn"`` span named ``agent_name`` covering the whole
    block; every span opened inside (nodes, LLM calls, tool calls) nests under
    it. Identity defaults to the live request context — pass it explicitly
    from callers with no live request (async job workers, background
    reflection), same convention as ``track_llm_costs``. Never lets
    profiling setup/teardown failures break the answer path.
    """
    profiler: AgentProfiler | None = None
    profiler_token = None
    span_token = None
    root_span_id: str | None = None
    turn_failed = False
    turn_error: str | None = None
    try:
        resolved_identity = identity if identity is not None else _read_identity_from_context()
        profiler = AgentProfiler(
            organization_id=resolved_identity.get("organization_id"),
            conversation_id=resolved_identity.get("conversation_id"),
            turn_id=str(uuid.uuid4()),
            job_id=job_id,
        )
        root_span_id = profiler.start_span("turn", agent_name)
        profiler_token = agent_profiler_var.set(profiler)
        span_token = current_span_var.set(root_span_id)
    except Exception:
        logger.warning("Could not activate agent profiling", exc_info=True)
        profiler = None
    try:
        yield profiler
    except Exception as exc:
        turn_failed = True
        turn_error = str(exc)
        raise
    finally:
        if span_token is not None:
            current_span_var.reset(span_token)
        if profiler_token is not None:
            agent_profiler_var.reset(profiler_token)
        if profiler is not None and root_span_id is not None:
            profiler.end_span(root_span_id, status="error" if turn_failed else "ok", error=turn_error)
            try:
                # Inline post at teardown, same rationale as
                # cost_tracking.track_llm_costs: a wait=False flush would hand
                # the final batch to the daemon executor, which a worker
                # exiting right after this turn can strand.
                profiler.flush(wait=True)
            except Exception:
                logger.warning("Failed to flush profiler spans at end of turn", exc_info=True)
