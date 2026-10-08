"""HTTP requests in flight per web role: the measurement behind the api tier's scaling trigger.

The api role is scaled on CPU today, and most of its work waits: on a model
call, or on a long-lived SSE stream of a research job. A saturated api replica
can therefore show a quiet CPU. Before the trigger changes, this module measures
the thing it would scale on, so the decision is made on readings from the
cluster and not on a guess.

Two instruments, both on the OpenTelemetry API (``aiq_agent.observability``
installs the provider; without one they are no-ops):

- ``grid.http.requests_in_flight`` (UpDownCounter): +1 when an HTTP request
  starts, -1 when its response finishes, on error and on cancellation alike.
- ``grid.http.request_seconds`` (histogram): the duration of a finished request.

Both carry ``role`` (``chat`` or ``api``) and ``kind``:

- ``stream`` for a job SSE stream. These are long-lived and would otherwise
  dominate the count, so they are counted apart. They record no duration.
- ``request`` for everything else.

The route path is deliberately not an attribute: it is unbounded. Only
``scope["type"] == "http"`` counts; WebSockets (the chat socket) and the
probe and docs routes are not requests this measures.
"""

from __future__ import annotations

import re
import threading
import time

from opentelemetry import metrics
from starlette.types import ASGIApp
from starlette.types import Receive
from starlette.types import Scope
from starlette.types import Send

IN_FLIGHT = "grid.http.requests_in_flight"
REQUEST_SECONDS = "grid.http.request_seconds"

KIND_REQUEST = "request"
KIND_STREAM = "stream"

#: The job SSE routes (``routes/jobs.py``): ``.../stream`` and ``.../stream/{last_event_id}``.
_STREAM_PATH = re.compile(r"^/v1/jobs/async/job/[^/]+/stream(?:/[^/]+)?$")

#: Not requests this measures: the liveness probe, and the OpenAPI document and its viewers.
_SKIPPED_EXACT = frozenset({"/health", "/openapi.json"})
_SKIPPED_PREFIXES = ("/docs", "/redoc")

#: Seconds, from a metadata read to a request that waits on a model call.
_BUCKETS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60)


class _Instruments:
    """The ``grid.http.*`` instruments, created once against the global meter provider."""

    def __init__(self, meter: metrics.Meter) -> None:
        self.in_flight = meter.create_up_down_counter(
            IN_FLIGHT, description="HTTP requests in flight, by role and kind (stream or request)"
        )
        self.request_seconds = meter.create_histogram(
            REQUEST_SECONDS,
            unit="s",
            description="Seconds an HTTP request took to finish (kind=request only)",
            explicit_bucket_boundaries_advisory=_BUCKETS,
        )


_instruments: _Instruments | None = None
_instruments_lock = threading.Lock()


def instruments() -> _Instruments:
    """The process's instruments, created on first use so they bind to the installed provider."""
    global _instruments
    with _instruments_lock:
        if _instruments is None:
            _instruments = _Instruments(metrics.get_meter("aiq_api.inflight"))
        return _instruments


def kind_for_path(path: str) -> str | None:
    """``stream`` or ``request`` for a counted path; None for one this measures nothing on."""
    if path in _SKIPPED_EXACT or path.startswith(_SKIPPED_PREFIXES):
        return None
    return KIND_STREAM if _STREAM_PATH.match(path) else KIND_REQUEST


class InFlightMiddleware:
    """Pure ASGI: counts each HTTP request from the moment it enters until its response finishes."""

    def __init__(self, app: ASGIApp, *, role: str) -> None:
        self.app = app
        self._role = role

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        kind = kind_for_path(scope.get("path", "")) if scope.get("type") == "http" else None
        if kind is None:
            await self.app(scope, receive, send)
            return

        meters = instruments()
        attributes = {"role": self._role, "kind": kind}
        started = time.monotonic()
        meters.in_flight.add(1, attributes)
        try:
            await self.app(scope, receive, send)
        finally:
            meters.in_flight.add(-1, attributes)
            if kind == KIND_REQUEST:
                meters.request_seconds.record(time.monotonic() - started, attributes)
