"""Grid NAT telemetry types (`otelcollector_logs`, `otelcollector_redaction`)."""


def ensure_registered() -> None:
    """Import the two Grid telemetry `_type`s so NAT's registry can resolve them.

    Registration is a decorator side-effect of importing the modules. This
    function exists so boot paths can name that import. Safe to call twice.
    """
    from aiq_agent.observability.otel_header_redaction_exporter import ensure_registered as register_redaction
    from aiq_agent.observability.otlp_logging_method import ensure_registered as register_logs

    register_logs()
    register_redaction()
