"""The process's OpenTelemetry ``MeterProvider`` (ADR-0079, ADR-0081).

Feature code measures itself through the OpenTelemetry API only
(``opentelemetry.metrics.get_meter``): ``grid.queue.*`` in
``common.claim_queue``, ``grid.provider.*`` in ``common.provider_limiter``.
Without a provider every instrument is a no-op, which is what a test, a CLI run
and a deployment with no observability tier get. This module is the one place a
provider is built.

The destination is the collector the logs already go to
(``otelcollector_logs``, ADR-0029): the same ``OTEL_EXPORTER_OTLP_ENDPOINT``,
which Pulumi injects as the FULL traces path, so the ``/v1/metrics`` sibling is
derived from it. A blank endpoint installs nothing. The export interval is
OpenTelemetry's own ``OTEL_METRIC_EXPORT_INTERVAL`` (milliseconds, default 60 s).

Observable gauges (queue depth, oldest age) are read once per export interval,
by the SDK's reader thread.

The provider lives as long as the process, not as long as the workflow that
installed it. OpenTelemetry lets the global provider be set once, and the
research worker builds a workflow per job, so a provider stopped when its
workflow closed left every later job measuring into a dead one. The SDK flushes
it at interpreter exit (``shutdown_on_exit``); nothing here stops it sooner.
"""

from __future__ import annotations

import logging
import os
import threading
from collections.abc import Mapping

from opentelemetry import metrics

logger = logging.getLogger(__name__)

_TRACES_SUFFIX = "/v1/traces"
_METRICS_SUFFIX = "/v1/metrics"

_lock = threading.Lock()
_installed = None


def metrics_endpoint(endpoint: str) -> str:
    """The OTLP/HTTP metrics endpoint for a configured traces (or bare collector) endpoint."""
    endpoint = endpoint.strip().rstrip("/")
    if endpoint.endswith(_TRACES_SUFFIX):
        return endpoint[: -len(_TRACES_SUFFIX)] + _METRICS_SUFFIX
    if endpoint.endswith(_METRICS_SUFFIX):
        return endpoint
    return endpoint + _METRICS_SUFFIX


def install_meter_provider(
    endpoint: str | None,
    *,
    env: Mapping[str, str] | None = None,
    reader=None,
    set_global: bool = True,
):
    """Build the ``MeterProvider`` and make it the global one; None when there is no endpoint.

    Idempotent: a second call returns the provider the first built. ``reader``
    replaces the OTLP reader (tests); ``set_global=False`` builds without
    installing it.
    """
    global _installed
    with _lock:
        if _installed is not None:
            return _installed
        if reader is None and not (endpoint and endpoint.strip()):
            logger.info("metrics: no OTLP endpoint configured - metric export disabled.")
            return None
        provider = _build(endpoint, env if env is not None else os.environ, reader)
        if set_global:
            metrics.set_meter_provider(provider)
            _installed = provider
        return provider


def _build(endpoint: str | None, env: Mapping[str, str], reader):
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.resources import Resource

    from aiq_agent.observability.otlp_logging_method import _resource_attributes

    if reader is None:
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader

        reader = PeriodicExportingMetricReader(OTLPMetricExporter(endpoint=metrics_endpoint(endpoint or "")))
    return MeterProvider(resource=Resource.create(_resource_attributes(env)), metric_readers=[reader])
