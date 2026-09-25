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


def test_resource_names_the_build_the_record_came_from():
    # err2issue reads service.version into the issue's "Version" row; without
    # it a regression on a closed issue could not be told from a stale pod.
    from aiq_agent.observability.otlp_logging_method import _resource_attributes

    attributes = _resource_attributes({"OTEL_SERVICE_NAME": "grid-agent-worker", "GRID_GIT_SHA": " abc123 "})
    assert attributes == {"service.name": "grid-agent-worker", "service.version": "abc123"}


def test_resource_omits_the_version_when_the_image_carries_none():
    from aiq_agent.observability.otlp_logging_method import _resource_attributes

    assert _resource_attributes({"GRID_GIT_SHA": ""}) == {"service.name": "aiq-agent"}


def test_a_failed_build_exports_its_cause_not_its_itemization(caplog):
    # NAT's own logger, driven for real, so a change in how it reports a failed
    # build shows up here rather than as eleven issues again (#742-#752).
    from nat.builder.workflow_builder import _log_build_failure

    from aiq_agent.observability.otlp_logging_method import _NatBuildFailureItemizationFilter

    with caplog.at_level(logging.ERROR, logger="nat.builder.workflow_builder"):
        try:
            raise RuntimeError("database system is shutting down")
        except RuntimeError as exc:
            _log_build_failure(
                "<workflow>", "workflow", [("summary_llm", "llms")], [("knowledge_search", "functions")], exc
            )

    assert len(caplog.records) > 3, "NAT itemizes a failed build; if this changed, revisit the filter"
    exported = [r for r in caplog.records if _NatBuildFailureItemizationFilter().filter(r)]
    assert len(exported) == 1
    assert exported[0].exc_info is not None
    assert "database system is shutting down" in exported[0].getMessage()


def test_other_nat_errors_are_still_exported():
    from aiq_agent.observability.otlp_logging_method import _NatBuildFailureItemizationFilter

    record = logging.LogRecord("nat.runtime", logging.ERROR, __file__, 1, "- summary_llm (llms)", (), None)
    record.funcName = "run"
    assert _NatBuildFailureItemizationFilter().filter(record)
