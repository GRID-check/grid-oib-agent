"""
The OTLP logging method must follow the same "availability = capability"
doctrine as the tracing exporter (ADR-0029): no configured endpoint => a
NullHandler, no export attempts against a collector that does not exist.
"""

import logging

import yaml

from aiq_agent.observability.otlp_logging_method import OtlpLoggingMethodConfig
from aiq_agent.observability.otlp_logging_method import _logs_endpoint
from aiq_agent.observability.otlp_logging_method import otlp_logging_method

CONFIG_PATH = "configs/config_oib_openrouter.yml"


def test_logs_endpoint_is_derived_from_the_traces_path():
    assert _logs_endpoint("http://otel-collector:4318/v1/traces") == "http://otel-collector:4318/v1/logs"
    assert _logs_endpoint("http://otel-collector:4318/v1/traces/") == "http://otel-collector:4318/v1/logs"
    assert _logs_endpoint("http://localhost:4318") == "http://localhost:4318/v1/logs"


async def test_missing_endpoint_yields_a_null_handler():
    # `${OTEL_EXPORTER_OTLP_ENDPOINT:-}` interpolates to None when the
    # observability tier is not deployed — this must not raise (regression:
    # the tracing exporter crashed NAT startup on exactly this).
    async with otlp_logging_method(OtlpLoggingMethodConfig(), None) as handler:
        assert isinstance(handler, logging.NullHandler)


async def test_configured_endpoint_yields_an_otlp_handler():
    from opentelemetry.sdk._logs import LoggingHandler

    config = OtlpLoggingMethodConfig(endpoint="http://otel-collector:4318/v1/traces")
    async with otlp_logging_method(config, None) as handler:
        assert isinstance(handler, LoggingHandler)
        assert handler.level == logging.INFO


async def test_otel_sdk_records_are_filtered_to_prevent_export_loops():
    from opentelemetry.sdk._logs import LoggingHandler

    config = OtlpLoggingMethodConfig(endpoint="http://otel-collector:4318/v1/traces")
    async with otlp_logging_method(config, None) as handler:
        assert isinstance(handler, LoggingHandler)
        sdk_record = logging.LogRecord("opentelemetry.sdk._logs.export", logging.WARNING, __file__, 1, "boom", (), None)
        app_record = logging.LogRecord("aiq_agent.agents", logging.INFO, __file__, 1, "hello", (), None)
        assert not handler.filter(sdk_record)
        assert handler.filter(app_record)


def test_shipped_config_wires_the_otlp_logging_method():
    with open(CONFIG_PATH, encoding="utf-8") as fh:
        raw = yaml.safe_load(fh)

    otlp = raw["general"]["telemetry"]["logging"]["otlp"]
    assert otlp["_type"] == "otelcollector_logs"
    assert otlp["endpoint"] == "${OTEL_EXPORTER_OTLP_ENDPOINT:-}", (
        "logging endpoint must default to empty so the handler no-ops when the observability tier is not deployed"
    )
