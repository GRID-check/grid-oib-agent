"""The process's metrics provider: built from the endpoint the logs already use, a no-op without one."""

from __future__ import annotations

import pytest
from opentelemetry import metrics as otel_metrics
from opentelemetry.sdk.metrics.export import InMemoryMetricReader

from aiq_agent.observability import metrics as grid_metrics


@pytest.fixture(autouse=True)
def fresh_install(monkeypatch):
    monkeypatch.setattr(grid_metrics, "_installed", None)
    # The global provider can be set once per process; never let a test take it.
    monkeypatch.setattr(otel_metrics, "set_meter_provider", lambda provider: None)


def test_the_metrics_endpoint_is_derived_from_the_traces_path():
    assert (
        grid_metrics.metrics_endpoint("http://otel-collector:4318/v1/traces") == "http://otel-collector:4318/v1/metrics"
    )
    assert (
        grid_metrics.metrics_endpoint("http://otel-collector:4318/v1/traces/")
        == "http://otel-collector:4318/v1/metrics"
    )
    assert grid_metrics.metrics_endpoint("http://localhost:4318") == "http://localhost:4318/v1/metrics"
    assert grid_metrics.metrics_endpoint("http://localhost:4318/v1/metrics") == "http://localhost:4318/v1/metrics"


@pytest.mark.parametrize("endpoint", [None, "", "   "])
def test_without_an_endpoint_nothing_is_installed(endpoint):
    assert grid_metrics.install_meter_provider(endpoint) is None
    assert grid_metrics._installed is None


def test_a_provider_carries_the_tier_and_build_that_produced_a_reading():
    reader = InMemoryMetricReader()
    provider = grid_metrics.install_meter_provider(
        "http://otel-collector:4318/v1/traces",
        env={"OTEL_SERVICE_NAME": "ingest-worker", "GRID_GIT_SHA": "abc123"},
        reader=reader,
    )
    provider.get_meter("test").create_counter("grid.test").add(1)

    resource = reader.get_metrics_data().resource_metrics[0].resource.attributes

    assert resource["service.name"] == "ingest-worker"
    assert resource["service.version"] == "abc123"


def test_installing_twice_returns_the_first_provider():
    first = grid_metrics.install_meter_provider("http://otel-collector:4318", reader=InMemoryMetricReader())
    second = grid_metrics.install_meter_provider("http://other:4318", reader=InMemoryMetricReader())

    assert second is first


def test_the_default_reader_exports_to_the_collector_over_otlp_http():
    provider = grid_metrics.install_meter_provider("http://otel-collector:4318/v1/traces")
    try:
        reader = provider._sdk_config.metric_readers[0]
        assert type(reader._exporter).__name__ == "OTLPMetricExporter"
        assert reader._exporter._endpoint == "http://otel-collector:4318/v1/metrics"
    finally:
        grid_metrics.shutdown_meter_provider()


def test_shutdown_without_a_provider_is_a_no_op():
    grid_metrics.shutdown_meter_provider()
