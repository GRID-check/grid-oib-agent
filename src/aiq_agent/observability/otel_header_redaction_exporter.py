import logging
from typing import Any

from pydantic import BaseModel
from pydantic import Field

from nat.builder.builder import Builder
from nat.cli.register_workflow import register_telemetry_exporter
from nat.observability.exporter.base_exporter import BaseExporter

logger = logging.getLogger(__name__)


def ensure_registered() -> None:
    return None


def _should_redact_from_headers(headers: dict[str, Any]) -> bool:
    for value in headers.values():
        if value is None:
            continue
        if str(value).strip().lower() == "true":
            return True
    return False


try:
    from nat.observability.mixin.redaction_config_mixin import HeaderRedactionConfigMixin  # type: ignore
except Exception:

    class HeaderRedactionConfigMixin(BaseModel):
        redaction_enabled: bool = Field(default=False, description="Whether to enable redaction processing.")
        redaction_value: str = Field(default="[REDACTED]", description="Value to replace redacted attributes with.")
        redaction_attributes: list[str] = Field(
            default_factory=lambda: ["input.value", "output.value", "nat.metadata"],
            description="Attributes to redact when redaction is triggered.",
        )
        force_redaction: bool = Field(default=False, description="Always redact regardless of other conditions.")
        redaction_tag: str | None = Field(default=None, description="Tag to add to spans when redaction is triggered.")
        redaction_headers: list[str] = Field(default_factory=list, description="Headers to check for redaction.")


try:
    from nat.observability.mixin.tagging_config_mixin import PrivacyTaggingConfigMixin  # type: ignore
except Exception:

    class PrivacyTaggingConfigMixin(BaseModel):
        tags: dict[str, str] | None = Field(default=None, description="Tags to add to spans.")


try:
    from nat.plugins.opentelemetry.register import OtelCollectorTelemetryExporter  # type: ignore
except Exception as e:
    raise RuntimeError(
        "OpenTelemetry telemetry plugin is required for otelcollector_redaction. "
        "Install NeMo Agent toolkit with telemetry extras."
    ) from e


class OtelCollectorRedactionTelemetryExporter(
    HeaderRedactionConfigMixin,
    PrivacyTaggingConfigMixin,
    OtelCollectorTelemetryExporter,
    name="otelcollector_redaction",
):
    resource_attributes: dict[str, str] = Field(default_factory=dict, description="Resource attributes to attach.")
    # The parent mixin declares `endpoint: str`, but the config interpolates
    # `${OTEL_EXPORTER_OTLP_ENDPOINT:-}` to None (not "") when the
    # observability tier is not deployed, which crashed NAT startup with a
    # pydantic str-validation error before the no-op path below could run.
    endpoint: str | None = Field(default=None, description="The endpoint of the telemetry collector service.")


class _DisabledSpanExporter(BaseExporter):
    """
    No-op exporter yielded when no OTLP endpoint is configured.

    NAT has no way to conditionally declare a `general.telemetry.tracing`
    entry, so the exporter is always constructed. Availability is therefore
    derived here from the dependency (ADR-0029 "availability = flag AND
    capability"): no endpoint means nothing to export to, so spans are dropped
    at the source instead of being queued and retried forever against an
    address that does not exist. Mirrors `frontends/ui/src/instrumentation.ts`,
    which no-ops on the same missing env var.
    """

    async def export(self, event: Any) -> None:
        return None


@register_telemetry_exporter(config_type=OtelCollectorRedactionTelemetryExporter)
async def otelcollector_redaction_telemetry_exporter(
    config: OtelCollectorRedactionTelemetryExporter, _builder: Builder
):
    # Blank endpoint == the observability tier is not deployed. Pulumi injects
    # OTEL_EXPORTER_OTLP_ENDPOINT only when it is (and the config interpolates
    # `${OTEL_EXPORTER_OTLP_ENDPOINT:-}` to "" otherwise), so this is the
    # capability check, not a user-facing toggle. Compose and local dev land
    # here and pay nothing.
    if not config.endpoint or not config.endpoint.strip():
        logger.info(
            "otelcollector_redaction: no OTLP endpoint configured "
            "(OTEL_EXPORTER_OTLP_ENDPOINT unset) - span export disabled.",
        )
        yield _DisabledSpanExporter()
        return

    from nat.plugins.opentelemetry.otel_span_exporter import get_opentelemetry_sdk_version
    from nat.plugins.opentelemetry.otlp_span_redaction_adapter_exporter import OTLPSpanHeaderRedactionAdapterExporter

    default_resource_attributes = {
        "telemetry.sdk.language": "python",
        "telemetry.sdk.name": "opentelemetry",
        "telemetry.sdk.version": get_opentelemetry_sdk_version(),
        "service.name": config.project,
    }
    merged_resource_attributes = {**default_resource_attributes, **config.resource_attributes}

    yield OTLPSpanHeaderRedactionAdapterExporter(
        endpoint=config.endpoint,
        resource_attributes=merged_resource_attributes,
        batch_size=config.batch_size,
        flush_interval=config.flush_interval,
        max_queue_size=config.max_queue_size,
        drop_on_overflow=config.drop_on_overflow,
        shutdown_timeout=config.shutdown_timeout,
        redaction_attributes=config.redaction_attributes,
        redaction_headers=config.redaction_headers,
        redaction_callback=_should_redact_from_headers,
        redaction_enabled=config.redaction_enabled,
        force_redaction=config.force_redaction,
        redaction_tag=config.redaction_tag,
        redaction_value=getattr(config, "redaction_value", "[REDACTED]"),
        tags=config.tags,
    )
