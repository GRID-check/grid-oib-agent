"""The in-flight measurement: an HTTP request is counted from entry until its response finishes, per role."""

from __future__ import annotations

import asyncio

import pytest
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader

from aiq_api import inflight
from aiq_api.inflight import IN_FLIGHT
from aiq_api.inflight import REQUEST_SECONDS
from aiq_api.inflight import InFlightMiddleware


@pytest.fixture
def reader(monkeypatch):
    """Instruments on a local provider: the global one can be set once per process."""
    reader = InMemoryMetricReader()
    provider = MeterProvider(metric_readers=[reader])
    monkeypatch.setattr(inflight, "_instruments", inflight._Instruments(provider.get_meter("test")))
    yield reader
    provider.shutdown()


def _points(reader, name) -> dict[tuple[str, str], object]:
    """Every data point of one metric, keyed by (role, kind)."""
    data = reader.get_metrics_data()
    if data is None:
        return {}
    return {
        (point.attributes["role"], point.attributes["kind"]): point
        for resource in data.resource_metrics
        for scope in resource.scope_metrics
        for metric in scope.metrics
        if metric.name == name
        for point in metric.data.data_points
    }


def _gauge(reader, role: str, kind: str) -> float | None:
    point = _points(reader, IN_FLIGHT).get((role, kind))
    return None if point is None else point.value


def _app(role: str, reader) -> tuple[FastAPI, dict[str, float | None]]:
    """A FastAPI app behind the middleware, and what the gauge read while each handler ran."""
    app = FastAPI()
    app.add_middleware(InFlightMiddleware, role=role)
    during: dict[str, float | None] = {}

    @app.get("/ok")
    async def ok():
        during["request"] = _gauge(reader, role, "request")
        return {"ok": True}

    @app.get("/boom")
    async def boom():
        raise RuntimeError("the handler failed")

    @app.get("/v1/jobs/async/job/{job_id}/stream")
    @app.get("/v1/jobs/async/job/{job_id}/stream/{last_event_id}")
    async def stream(job_id: str, last_event_id: str = ""):
        during["stream"] = _gauge(reader, role, "stream")

        async def events():
            for n in range(3):
                yield f"data: {n}\n\n"

        return StreamingResponse(events(), media_type="text/event-stream")

    @app.get("/health")
    async def health():
        return {"status": "healthy"}

    return app, during


def test_a_request_is_counted_while_it_runs_and_back_to_zero_after(reader):
    app, during = _app("api", reader)

    response = TestClient(app).get("/ok")

    assert response.status_code == 200
    assert during["request"] == 1
    assert _gauge(reader, "api", "request") == 0
    duration = _points(reader, REQUEST_SECONDS)[("api", "request")]
    assert duration.count == 1
    assert duration.sum > 0


def test_a_handler_that_raises_still_returns_the_gauge_to_zero(reader):
    app, _ = _app("api", reader)

    response = TestClient(app, raise_server_exceptions=False).get("/boom")

    assert response.status_code == 500
    assert _gauge(reader, "api", "request") == 0
    assert _points(reader, REQUEST_SECONDS)[("api", "request")].count == 1


def test_a_cancelled_request_still_returns_the_gauge_to_zero(reader):
    async def cancelled(scope, receive, send):
        raise asyncio.CancelledError

    middleware = InFlightMiddleware(cancelled, role="api")

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(middleware({"type": "http", "path": "/ok"}, None, None))

    assert _gauge(reader, "api", "request") == 0


@pytest.mark.parametrize("path", ["/v1/jobs/async/job/job-1/stream", "/v1/jobs/async/job/job-1/stream/42"])
def test_a_job_stream_counts_as_a_stream_and_records_no_duration(reader, path):
    app, during = _app("api", reader)

    response = TestClient(app).get(path)

    assert response.status_code == 200
    assert during["stream"] == 1
    assert _gauge(reader, "api", "stream") == 0
    assert set(_points(reader, IN_FLIGHT)) == {("api", "stream")}
    assert set(_points(reader, REQUEST_SECONDS)) == set()


@pytest.mark.parametrize("path", ["/health", "/docs", "/redoc", "/openapi.json"])
def test_probe_and_docs_routes_are_not_counted(reader, path):
    app, _ = _app("api", reader)

    TestClient(app).get(path)

    assert _points(reader, IN_FLIGHT) == {}
    assert _points(reader, REQUEST_SECONDS) == {}


@pytest.mark.parametrize("role", ["chat", "api"])
def test_the_role_is_an_attribute_of_both_instruments(reader, role):
    app, during = _app(role, reader)

    TestClient(app).get("/ok")

    assert during["request"] == 1
    assert _gauge(reader, role, "request") == 0
    assert (role, "request") in _points(reader, REQUEST_SECONDS)


def test_a_websocket_is_not_counted(reader):
    async def socket_app(scope, receive, send):
        return None

    middleware = InFlightMiddleware(socket_app, role="chat")

    asyncio.run(middleware({"type": "websocket", "path": "/websocket"}, None, None))

    assert _points(reader, IN_FLIGHT) == {}


@pytest.mark.parametrize(
    ("path", "kind"),
    [
        ("/v1/jobs/async/job/job-1", "request"),
        ("/v1/jobs/async/job/job-1/streams", "request"),
        ("/v1/jobs/async/job/job-1/stream/42/extra", "request"),
        ("/v1/jobs/async/job/job-1/stream", "stream"),
        ("/v1/jobs/async/job/job-1/stream/42", "stream"),
    ],
)
def test_the_kind_of_a_path(path, kind):
    assert inflight.kind_for_path(path) == kind
