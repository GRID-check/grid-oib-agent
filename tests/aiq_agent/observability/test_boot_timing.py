"""Boot timing: readings wait in the process until the meter provider can take them."""

from __future__ import annotations

import os

import pytest
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader

from aiq_agent.observability import boot_timing
from aiq_agent.observability.boot_timing import BootClock


@pytest.fixture
def reader(monkeypatch):
    """A histogram on a local provider: the global one can be set once per process."""
    reader = InMemoryMetricReader()
    provider = MeterProvider(metric_readers=[reader])
    histogram = provider.get_meter("test").create_histogram(boot_timing.PHASE_HISTOGRAM)
    monkeypatch.setattr(boot_timing, "_histogram", histogram)
    monkeypatch.setattr(boot_timing, "_pending", [])
    yield reader
    provider.shutdown()


def _points(reader) -> dict[tuple[str, str], float]:
    data = reader.get_metrics_data()
    if data is None:
        return {}
    return {
        (point.attributes["role"], point.attributes["phase"]): point.sum
        for resource in data.resource_metrics
        for scope in resource.scope_metrics
        for metric in scope.metrics
        if metric.name == boot_timing.PHASE_HISTOGRAM
        for point in metric.data.data_points
    }


def test_a_reading_waits_until_flush(reader):
    BootClock("ingest-worker").record("workflow_build", 4.5)

    assert _points(reader) == {}

    boot_timing.flush()

    assert _points(reader) == {("ingest-worker", "workflow_build"): 4.5}


def test_a_flush_takes_every_role_s_readings_once(reader):
    # The research worker is ready before any workflow exists; its first job's
    # build flushes both readings.
    BootClock("research-worker").record("ready", 2.0)
    BootClock("research-job").record("workflow_build", 3.0)

    boot_timing.flush()
    boot_timing.flush()

    assert _points(reader) == {("research-worker", "ready"): 2.0, ("research-job", "workflow_build"): 3.0}


def test_a_phase_is_recorded_even_when_it_raises(reader):
    with pytest.raises(ValueError), BootClock("web").phase("load_config"):
        raise ValueError("bad config")

    boot_timing.flush()

    assert ("web", "load_config") in _points(reader)


def test_the_process_age_comes_from_the_kernel_s_start_time(tmp_path):
    ticks = os.sysconf("SC_CLK_TCK")
    (tmp_path / "self").mkdir()
    (tmp_path / "uptime").write_text("1000.00 4000.00\n")
    fields = ["S"] + ["0"] * 18 + [str(990 * ticks)] + ["0"] * 10
    # A command name with spaces and a parenthesis must not shift the fields.
    (tmp_path / "self" / "stat").write_text(f"42 (python (worker) x) {' '.join(fields)}\n")

    assert boot_timing.process_age_seconds(str(tmp_path)) == pytest.approx(10.0)


def test_without_proc_there_is_no_age(tmp_path, reader):
    assert boot_timing.process_age_seconds(str(tmp_path / "missing")) is None


def test_ready_records_this_process_s_age(reader):
    BootClock("web").ready()
    boot_timing.flush()

    age = _points(reader)[("web", "ready")]
    assert 0 < age < 3600
