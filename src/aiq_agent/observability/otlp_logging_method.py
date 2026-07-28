import logging
import os

from pydantic import Field

from nat.builder.builder import Builder
from nat.cli.register_workflow import register_logging_method
from nat.data_models.logging import LoggingBaseConfig

logger = logging.getLogger(__name__)


def ensure_registered() -> None:
    return None


_TRACES_SUFFIX = "/v1/traces"
_LOGS_SUFFIX = "/v1/logs"


def _logs_endpoint(endpoint: str) -> str:
    """Derive the OTLP/HTTP logs endpoint from the traces one.

    Pulumi injects OTEL_EXPORTER_OTLP_ENDPOINT as the FULL traces path
    (http://otel-collector:4318/v1/traces) because the NAT span exporter posts
    as-is (ADR-0029); the OTLP log exporter needs the sibling /v1/logs path.
    """
    endpoint = endpoint.strip().rstrip("/")
    if endpoint.endswith(_TRACES_SUFFIX):
        return endpoint[: -len(_TRACES_SUFFIX)] + _LOGS_SUFFIX
    return endpoint + _LOGS_SUFFIX


class _OtelSdkFilter(logging.Filter):
    """Drops records emitted by the OTel SDK itself.

    Without this, a failed log export logs a warning through the very handler
    that triggered it, feeding the next export attempt — an amplification loop
    against an unreachable collector.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        return not record.name.startswith("opentelemetry")


class OtlpLoggingMethodConfig(LoggingBaseConfig, name="otelcollector_logs"):
    """Ships runtime logs to the OTLP collector (Aspire dashboard, ADR-0029).

    `endpoint` is Optional because `${OTEL_EXPORTER_OTLP_ENDPOINT:-}`
    interpolates to None (not "") when the observability tier is not deployed.
    """

    endpoint: str | None = Field(
        default=None,
        description="OTLP traces endpoint (…/v1/traces); the /v1/logs sibling is derived from it.",
    )
    level: str = Field(default="INFO", description="The logging level of the OTLP log exporter.")


@register_logging_method(config_type=OtlpLoggingMethodConfig)
async def otlp_logging_method(config: OtlpLoggingMethodConfig, _builder: Builder):
    # Blank endpoint == observability tier not deployed (same capability check
    # as the tracing exporter, ADR-0029): no-op so compose/local pay nothing.
    if not config.endpoint or not config.endpoint.strip():
        logger.info(
            "otelcollector_logs: no OTLP endpoint configured "
            "(OTEL_EXPORTER_OTLP_ENDPOINT unset) - OTLP log export disabled.",
        )
        yield logging.NullHandler()
        return

    from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
    from opentelemetry.sdk._logs import LoggerProvider
    from opentelemetry.sdk._logs import LoggingHandler
    from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
    from opentelemetry.sdk.resources import Resource

    # Resource.create() merges passed attributes LAST (they would win over
    # env), so the per-tier OTEL_SERVICE_NAME Pulumi injects is resolved here.
    resource = Resource.create({"service.name": os.environ.get("OTEL_SERVICE_NAME", "aiq-agent")})
    provider = LoggerProvider(resource=resource)
    provider.add_log_record_processor(
        BatchLogRecordProcessor(OTLPLogExporter(endpoint=_logs_endpoint(config.endpoint)))
    )

    level = getattr(logging, config.level.upper(), logging.INFO)
    handler = LoggingHandler(level=level, logger_provider=provider)
    handler.addFilter(_OtelSdkFilter())

    yield handler

    provider.shutdown()
