"""
The OTLP tracing exporter must follow "availability = flag AND capability"
(ADR-0029): no configured endpoint => no exporter, no retry storm.

This is the coverage the original observability push lacked. `configs/` was in
no CI paths-filter bucket, so the commit that switched tracing on never ran a
backend job at all.
"""

import pytest
import yaml

from aiq_agent.observability.otel_header_redaction_exporter import OtelCollectorRedactionTelemetryExporter
from aiq_agent.observability.otel_header_redaction_exporter import _DisabledSpanExporter
from aiq_agent.observability.otel_header_redaction_exporter import otelcollector_redaction_telemetry_exporter

CONFIG_PATH = "configs/config_oib_openrouter.yml"


def _make_config(endpoint: str | None) -> OtelCollectorRedactionTelemetryExporter:
    return OtelCollectorRedactionTelemetryExporter(
        _type="otelcollector_redaction", project="grid-aiq-agent", endpoint=endpoint
    )


@pytest.mark.parametrize("endpoint", ["", "   ", None])
async def test_blank_endpoint_yields_a_noop_exporter(endpoint):
    # None is what `${OTEL_EXPORTER_OTLP_ENDPOINT:-}` interpolates to when the
    # var is unset — this exact value crashed NAT startup before `endpoint`
    # was made Optional (pydantic str validation).
    # `register_telemetry_exporter` turns the factory into an async context manager.
    async with otelcollector_redaction_telemetry_exporter(_make_config(endpoint), None) as exporter:
        assert isinstance(exporter, _DisabledSpanExporter)
        # And it must actually swallow spans rather than raise.
        assert await exporter.export(object()) is None


async def test_configured_endpoint_yields_a_real_exporter():
    config = _make_config("http://otel-collector:4318/v1/traces")
    async with otelcollector_redaction_telemetry_exporter(config, None) as exporter:
        assert not isinstance(exporter, _DisabledSpanExporter)
        assert exporter is not None


def test_shipped_config_does_not_default_to_a_localhost_collector():
    """
    Regression guard: the endpoint default must stay empty. A non-empty default
    silently re-enables span export in Compose/local dev, where the exporter
    then queues and retries against a collector that does not exist.
    """
    with open(CONFIG_PATH, encoding="utf-8") as fh:
        raw = yaml.safe_load(fh)

    tracing = raw["general"]["telemetry"]["tracing"]["otelcollector_redaction"]
    assert tracing["endpoint"] == "${OTEL_EXPORTER_OTLP_ENDPOINT:-}", (
        "tracing endpoint must default to empty so the exporter no-ops when the observability tier is not deployed"
    )
