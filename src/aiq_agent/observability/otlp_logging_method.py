import logging
import os
from collections.abc import Mapping

from pydantic import Field

from aiq_agent.common.log_redaction import PresignedUrlFilter
from aiq_agent.common.log_redaction import install_presigned_url_scrubbing
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


def _resource_attributes(env: Mapping[str, str]) -> dict[str, str]:
    """The resource every exported record carries: which tier, and which build.

    Resource.create() merges passed attributes LAST (they would win over env),
    so the per-tier OTEL_SERVICE_NAME Pulumi injects is resolved here.

    ``service.version`` is the commit the image was built from (GRID_GIT_SHA,
    stamped by both Dockerfiles). Without it every err2issue issue read
    "Version: unknown", and a "regression" on a closed issue could not be told
    apart from a pod still running the image from before the fix.
    """
    attributes = {"service.name": env.get("OTEL_SERVICE_NAME", "aiq-agent")}
    sha = env.get("GRID_GIT_SHA", "").strip()
    if sha:
        attributes["service.version"] = sha
    return attributes


class _OtelSdkFilter(logging.Filter):
    """Drops records emitted by the OTel SDK itself.

    Without this, a failed log export logs a warning through the very handler
    that triggered it, feeding the next export attempt — an amplification loop
    against an unreachable collector.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        return not record.name.startswith("opentelemetry")


class _NatBuildFailureItemizationFilter(logging.Filter):
    """Keeps one ERROR per failed workflow build instead of one per line.

    ``nat.builder.workflow_builder._log_build_failure`` reports a failed build
    as a dozen ``logger.error`` calls: a header, then every built and every
    remaining component on its own line, then ``Original error`` with the
    traceback. Each record is an ERROR, so err2issue filed one startup failure
    as eleven issues (#742-#752), none of which carried the cause. Only the
    ``Original error`` record is exported; the itemization still reaches stdout
    through the other handlers. If NAT renames the function, nothing matches
    and every line is exported again: this fails towards reporting.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        if record.funcName != "_log_build_failure" or not record.name.startswith("nat."):
            return True
        return str(record.msg).startswith("Original error")


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

    resource = Resource.create(_resource_attributes(os.environ))
    provider = LoggerProvider(resource=resource)
    provider.add_log_record_processor(
        BatchLogRecordProcessor(OTLPLogExporter(endpoint=_logs_endpoint(config.endpoint)))
    )

    level = getattr(logging, config.level.upper(), logging.INFO)
    handler = LoggingHandler(level=level, logger_provider=provider)
    handler.addFilter(_OtelSdkFilter())
    handler.addFilter(_NatBuildFailureItemizationFilter())
    # Exported logs leave the cluster and are retained by whatever is on the
    # other end, so this is the sink where a leaked presigned URL is hardest to
    # take back. Attached here rather than trusted to every call site — see
    # aiq_agent.common.log_redaction.
    handler.addFilter(PresignedUrlFilter())

    # Every other handler already on the root logger (stdout, and anything the
    # host added) gets the same treatment, so the guarantee does not depend on
    # which sink a record happens to reach.
    install_presigned_url_scrubbing()

    yield handler

    provider.shutdown()
