"""A Langfuse generation for a model call that no NAT workflow makes (ADR-0089).

Every model call must be observable, and NAT's span exporter only sees what runs
inside a workflow. The auxiliary routes in ``aiq_api`` (conversation title,
project summary, consistency check, skill review, lesson distill, feedback
digest) post to the chat-completions endpoint straight from a FastAPI handler, so
they cost money and took seconds without leaving a span anywhere. This module gives
each such call ONE span, which Langfuse files as a root trace holding a single
GENERATION observation: model, usage, cost, input, output, and a level of ERROR
when the call failed.

Mechanics, each a decision:

* **A private ``TracerProvider``, never the global one.** NAT, and whatever else
  in the process speaks the OpenTelemetry API, must not start exporting through
  this provider. Built lazily on the first call and kept for the life of the
  process, like the meter provider (``observability.metrics``); the SDK flushes
  it at interpreter exit.
* **The collector the rest already uses.** ``OTEL_EXPORTER_OTLP_ENDPOINT``, which
  Pulumi injects as the full ``/v1/traces`` URL; a bare collector URL gets the
  suffix. A blank endpoint builds nothing and every call is a no-op, the same
  availability rule as ``otel_header_redaction_exporter``.
* **Always a root.** The span starts from an empty context, so an ambient span
  (an instrumented request, a test harness) cannot adopt it into its trace.
* **Fail-open.** A telemetry fault logs at DEBUG and the route carries on; the
  context manager never raises and never swallows the route's own exception.

Input and output are the content category NAT already exports for a chat turn
(ADR-0029), each capped at :data:`MAX_PAYLOAD_CHARS` so a long skill document
cannot turn one span into megabytes. The environment, release and observation
type come from ``trace_context`` and the usage buckets from
``usage_observation_attributes``, so this span and a NAT generation cannot
disagree about what they carry.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from collections.abc import Mapping
from typing import Any

from aiq_agent.observability.langfuse_trace_attributes import GEN_AI_REQUEST_MODEL
from aiq_agent.observability.langfuse_trace_attributes import METADATA_PREFIX
from aiq_agent.observability.langfuse_trace_attributes import OBSERVATION_MODEL_NAME
from aiq_agent.observability.langfuse_trace_attributes import SESSION_ID_ATTRIBUTE
from aiq_agent.observability.langfuse_trace_attributes import TAGS_ATTRIBUTE
from aiq_agent.observability.langfuse_trace_attributes import usage_observation_attributes
from aiq_agent.observability.trace_context import OBSERVATION_LEVEL_ATTRIBUTE
from aiq_agent.observability.trace_context import OBSERVATION_STATUS_MESSAGE_ATTRIBUTE
from aiq_agent.observability.trace_context import OBSERVATION_TYPE_ATTRIBUTE
from aiq_agent.observability.trace_context import TRACE_NAME_ATTRIBUTE
from aiq_agent.observability.trace_context import process_trace_attributes

logger = logging.getLogger(__name__)

ENDPOINT_ENV = "OTEL_EXPORTER_OTLP_ENDPOINT"
SERVICE_NAME_ENV = "OTEL_SERVICE_NAME"
#: The NAT exporter's ``project`` default in ``configs/config_oib_openrouter.yml``,
#: so these traces sit under the same service as the chat turns.
DEFAULT_SERVICE_NAME = "grid-aiq-agent"

#: Langfuse's observation-level input/output, which win over ``input.value``.
INPUT_ATTRIBUTE = "langfuse.observation.input"
OUTPUT_ATTRIBUTE = "langfuse.observation.output"
#: The served model, when the provider names one other than the requested id.
GEN_AI_RESPONSE_MODEL = "gen_ai.response.model"

#: What one span may carry of the prompt and of the reply, each.
MAX_PAYLOAD_CHARS = 16_000
TRUNCATION_MARKER = "…[truncated]"

#: Every trace from here is filterable as "not a chat turn" in one click.
AUXILIARY_SURFACE_TAG = "surface:auxiliary"

_TRACES_SUFFIX = "/v1/traces"
_SCOPE = "aiq_agent.observability.direct_trace"

_lock = threading.Lock()
_resolved = False
_provider = None
_tracer = None


def traces_endpoint(endpoint: str) -> str:
    """The OTLP/HTTP traces endpoint for a configured traces (or bare collector) endpoint."""
    endpoint = endpoint.strip().rstrip("/")
    if endpoint.endswith(_TRACES_SUFFIX):
        return endpoint
    return endpoint + _TRACES_SUFFIX


def _resource_attributes(env: Mapping[str, str]) -> dict[str, str]:
    """Which tier and which build produced a span; blank values are left out."""
    attributes = {"service.name": env.get(SERVICE_NAME_ENV, "").strip() or DEFAULT_SERVICE_NAME}
    sha = env.get("GRID_GIT_SHA", "").strip()
    if sha:
        attributes["service.version"] = sha
    return attributes


def install_tracer_provider(endpoint: str | None, *, env: Mapping[str, str] | None = None, exporter=None):
    """Build the private ``TracerProvider``; None when there is no endpoint.

    Idempotent: a later call returns what the first one decided, including
    "disabled". ``exporter`` replaces the OTLP exporter (tests). The provider
    is never made the global one.
    """
    global _resolved, _provider, _tracer
    with _lock:
        if _resolved:
            return _provider
        _resolved = True
        if exporter is None and not (endpoint and endpoint.strip()):
            logger.info("direct_trace: no OTLP endpoint configured - direct model-call spans disabled.")
            return None
        _provider = _build(endpoint, env if env is not None else os.environ, exporter)
        _tracer = _provider.get_tracer(_SCOPE)
        return _provider


def reset_tracer_provider() -> None:
    """Forget the provider, so the next call decides again (tests)."""
    global _resolved, _provider, _tracer
    with _lock:
        if _provider is not None:
            _provider.shutdown()
        _resolved, _provider, _tracer = False, None, None


def _build(endpoint: str | None, env: Mapping[str, str], exporter):
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    if exporter is None:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

        exporter = OTLPSpanExporter(endpoint=traces_endpoint(endpoint or ""))
    provider = TracerProvider(resource=Resource.create(_resource_attributes(env)))
    provider.add_span_processor(BatchSpanProcessor(exporter))
    return provider


def _current_tracer():
    """The tracer, building the provider from the environment on first use; None when disabled."""
    if not _resolved:
        try:
            install_tracer_provider(os.environ.get(ENDPOINT_ENV))
        except Exception:
            logger.debug("direct_trace: could not build the tracer provider", exc_info=True)
    return _tracer


def _clip(text: str) -> str:
    if len(text) <= MAX_PAYLOAD_CHARS:
        return text
    return text[:MAX_PAYLOAD_CHARS] + TRUNCATION_MARKER


def _count(value: Any) -> int:
    """A token count as a non-negative int; anything else (a bool included) is 0."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return 0
    return max(0, int(value))


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def generation_start_attributes(
    feature: str,
    *,
    model: str | None,
    messages: list | None,
    session_id: str | None = None,
    metadata: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """What the span knows before the call: trace identity, model, prompt. Pure.

    Metadata keeps scalars only, since a Langfuse metadata value is one
    attribute; ``feature`` is written last so a caller cannot rename the trace.
    """
    attributes: dict[str, Any] = {
        **process_trace_attributes(),
        OBSERVATION_TYPE_ATTRIBUTE: "generation",
        TRACE_NAME_ATTRIBUTE: feature,
        TAGS_ATTRIBUTE: [f"feature:{feature}", AUXILIARY_SURFACE_TAG],
    }
    for key, value in {**(metadata or {}), "feature": feature}.items():
        if isinstance(value, str | int | float | bool):
            attributes[f"{METADATA_PREFIX}{key}"] = value
    if model:
        attributes[GEN_AI_REQUEST_MODEL] = model
        attributes[OBSERVATION_MODEL_NAME] = model
    if session_id:
        attributes[SESSION_ID_ATTRIBUTE] = session_id
    if messages is not None:
        attributes[INPUT_ATTRIBUTE] = _clip(json.dumps(messages, ensure_ascii=False, default=str))
    return attributes


def _usage_attributes(usage: Any) -> dict[str, Any]:
    """OpenRouter's ``usage`` object as generation usage and cost; empty when absent."""
    if not isinstance(usage, Mapping):
        return {}
    cost = usage.get("cost")
    return usage_observation_attributes(
        prompt_tokens=_count(usage.get("prompt_tokens")),
        completion_tokens=_count(usage.get("completion_tokens")),
        total_tokens=_count(usage.get("total_tokens")),
        cached_tokens=_count(_mapping(usage.get("prompt_tokens_details")).get("cached_tokens")),
        reasoning_tokens=_count(_mapping(usage.get("completion_tokens_details")).get("reasoning_tokens")),
        cost_usd=cost if isinstance(cost, int | float) and not isinstance(cost, bool) else None,
    )


def generation_result_attributes(response: Any) -> dict[str, Any]:
    """What a chat-completion body adds to the span: usage, served model, output. Pure.

    Tolerates any shape; what it cannot read stays absent rather than zero.
    """
    if not isinstance(response, Mapping):
        return {}
    attributes = _usage_attributes(response.get("usage"))
    served = response.get("model")
    if isinstance(served, str) and served:
        attributes[GEN_AI_RESPONSE_MODEL] = served
        attributes[OBSERVATION_MODEL_NAME] = served
    choices = response.get("choices")
    choice = _mapping(choices[0]) if isinstance(choices, list) and choices else {}
    content = _mapping(choice.get("message")).get("content")
    if isinstance(content, str):
        attributes[OUTPUT_ATTRIBUTE] = _clip(content)
    finish_reason = choice.get("finish_reason")
    if isinstance(finish_reason, str):
        attributes[f"{METADATA_PREFIX}finish_reason"] = finish_reason
    return attributes


def failure_message(exc: BaseException) -> str:
    """The exception's type, plus the HTTP status when it carries one. No URL, no body."""
    status = getattr(getattr(exc, "response", None), "status_code", None)
    if isinstance(status, int):
        return f"{type(exc).__name__}: HTTP {status}"
    return type(exc).__name__


class GenerationRecorder:
    """The handle a route reports its reply through. A no-op when tracing is off."""

    __slots__ = ("_span",)

    def __init__(self, span: Any | None) -> None:
        self._span = span

    def finish(self, response: Any) -> None:
        """Record the parsed chat-completion body. Never raises."""
        if self._span is None:
            return
        try:
            self._span.set_attributes(generation_result_attributes(response))
        except Exception:
            logger.debug("direct_trace: could not record a generation's reply", exc_info=True)


class _ObservedGeneration:
    """The async context manager :func:`observed_generation` returns."""

    def __init__(self, feature: str, attributes: dict[str, Any]) -> None:
        self._feature = feature
        self._attributes = attributes
        self._span: Any | None = None

    async def __aenter__(self) -> GenerationRecorder:
        self._span = _start_span(self._feature, self._attributes)
        return GenerationRecorder(self._span)

    async def __aexit__(self, exc_type, exc, traceback) -> bool:
        _end_span(self._span, exc)
        return False


def _start_span(feature: str, attributes: dict[str, Any]) -> Any | None:
    tracer = _current_tracer()
    if tracer is None:
        return None
    try:
        from opentelemetry.context import Context
        from opentelemetry.trace import SpanKind

        return tracer.start_span(
            feature,
            context=Context(),
            kind=SpanKind.CLIENT,
            attributes=generation_start_attributes(feature, **attributes),
        )
    except Exception:
        logger.debug("direct_trace: could not start a generation span", exc_info=True)
        return None


def _end_span(span: Any | None, exc: BaseException | None) -> None:
    if span is None:
        return
    try:
        if exc is not None:
            from opentelemetry.trace import Status
            from opentelemetry.trace import StatusCode

            message = failure_message(exc)
            span.set_attributes({OBSERVATION_LEVEL_ATTRIBUTE: "ERROR", OBSERVATION_STATUS_MESSAGE_ATTRIBUTE: message})
            span.set_status(Status(StatusCode.ERROR, message))
    except Exception:
        logger.debug("direct_trace: could not mark a generation as failed", exc_info=True)
    try:
        span.end()
    except Exception:
        logger.debug("direct_trace: could not end a generation span", exc_info=True)


def observed_generation(
    feature: str,
    *,
    model: str | None,
    messages: list | None,
    session_id: str | None = None,
    metadata: Mapping[str, Any] | None = None,
) -> _ObservedGeneration:
    """Trace one direct model call as a Langfuse generation named ``feature``.

    Wrap the request and ``.finish(body)`` the parsed reply inside the block::

        async with observed_generation("conversation-title", model=cred.model, messages=msgs) as generation:
            response = await client.post(...)
            response.raise_for_status()
            data = response.json()
            generation.finish(data)

    An exception leaving the block marks the generation ERROR and propagates
    unchanged, so the route's own ``except`` clauses see exactly what they did
    before. ``session_id`` is the conversation id, when the call belongs to
    one; only then is the trace grouped into a Langfuse session.
    """
    return _ObservedGeneration(
        feature,
        {"model": model, "messages": messages, "session_id": session_id, "metadata": metadata},
    )
