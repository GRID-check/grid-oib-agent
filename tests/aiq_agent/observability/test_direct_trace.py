"""A direct model call becomes one Langfuse generation, or nothing when there is no collector (ADR-0089)."""

from __future__ import annotations

import json

import httpx
import pytest
from opentelemetry import trace as otel_trace
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode

from aiq_agent.observability import direct_trace

_MESSAGES = [
    {"role": "system", "content": "Name the chat."},
    {"role": "user", "content": "Brandschutz im Stiegenhaus"},
]

_RESPONSE = {
    "model": "openai/gpt-6-luna-20260901",
    "choices": [{"message": {"content": '{"title": "Brandschutz Stiegenhaus"}'}, "finish_reason": "stop"}],
    "usage": {
        "prompt_tokens": 120,
        "completion_tokens": 40,
        "total_tokens": 160,
        "prompt_tokens_details": {"cached_tokens": 20},
        "completion_tokens_details": {"reasoning_tokens": 10},
        "cost": 0.00042,
    },
}


@pytest.fixture(autouse=True)
def fresh_provider(monkeypatch):
    monkeypatch.delenv(direct_trace.ENDPOINT_ENV, raising=False)
    monkeypatch.setenv("APP_ENV", "staging")
    monkeypatch.setenv("GRID_GIT_SHA", "abc123")
    direct_trace.reset_tracer_provider()
    yield
    direct_trace.reset_tracer_provider()


@pytest.fixture
def exporter():
    memory = InMemorySpanExporter()
    direct_trace.install_tracer_provider(None, env={"GRID_GIT_SHA": "abc123"}, exporter=memory)
    return memory


def _spans(memory: InMemorySpanExporter):
    direct_trace._provider.force_flush()
    return memory.get_finished_spans()


def test_the_traces_endpoint_accepts_the_full_path_pulumi_injects_and_a_bare_collector():
    assert (
        direct_trace.traces_endpoint("http://otel-collector:4318/v1/traces") == "http://otel-collector:4318/v1/traces"
    )
    assert (
        direct_trace.traces_endpoint("http://otel-collector:4318/v1/traces/") == "http://otel-collector:4318/v1/traces"
    )
    assert direct_trace.traces_endpoint("http://localhost:4318") == "http://localhost:4318/v1/traces"
    assert direct_trace.traces_endpoint("http://localhost:4318/") == "http://localhost:4318/v1/traces"


@pytest.mark.parametrize("endpoint", [None, "", "   "])
async def test_without_an_endpoint_nothing_is_built_and_the_call_runs_untouched(monkeypatch, endpoint):
    if endpoint is not None:
        monkeypatch.setenv(direct_trace.ENDPOINT_ENV, endpoint)

    async with direct_trace.observed_generation("conversation-title", model="m", messages=_MESSAGES) as generation:
        generation.finish(_RESPONSE)

    assert direct_trace._provider is None
    assert direct_trace._tracer is None


async def test_without_an_endpoint_the_route_exception_still_propagates_unchanged():
    error = httpx.ConnectError("boom")
    with pytest.raises(httpx.ConnectError) as raised:
        async with direct_trace.observed_generation("skill-review", model="m", messages=_MESSAGES):
            raise error
    assert raised.value is error


def test_the_endpoint_builds_a_private_provider_and_never_the_global_one(monkeypatch):
    monkeypatch.setenv(direct_trace.ENDPOINT_ENV, "http://otel-collector:4318/v1/traces")
    global_before = otel_trace.get_tracer_provider()

    tracer = direct_trace._current_tracer()

    assert tracer is not None
    assert otel_trace.get_tracer_provider() is global_before
    resource = direct_trace._provider.resource.attributes
    assert resource["service.name"] == "grid-aiq-agent"
    assert resource["service.version"] == "abc123"


async def test_a_call_becomes_one_root_generation_with_usage_cost_and_content(exporter):
    async with direct_trace.observed_generation(
        "conversation-title",
        model="openai/gpt-6-luna",
        messages=_MESSAGES,
        session_id="conv-1",
        metadata={"step": "distill", "ignored": {"nested": True}},
    ) as generation:
        generation.finish(_RESPONSE)

    (span,) = _spans(exporter)
    attributes = dict(span.attributes)
    assert span.parent is None
    assert span.name == "conversation-title"
    assert attributes["langfuse.observation.type"] == "generation"
    assert attributes["langfuse.trace.name"] == "conversation-title"
    assert attributes["langfuse.environment"] == "staging"
    assert attributes["langfuse.release"] == "abc123"
    assert list(attributes["langfuse.trace.tags"]) == ["feature:conversation-title", "surface:auxiliary"]
    assert attributes["langfuse.session.id"] == "conv-1"
    assert attributes["langfuse.trace.metadata.feature"] == "conversation-title"
    assert attributes["langfuse.trace.metadata.step"] == "distill"
    assert attributes["langfuse.trace.metadata.finish_reason"] == "stop"
    assert "langfuse.trace.metadata.ignored" not in attributes
    assert attributes["gen_ai.request.model"] == "openai/gpt-6-luna"
    assert attributes["langfuse.observation.model.name"] == "openai/gpt-6-luna-20260901"
    assert attributes["gen_ai.usage.input_tokens"] == 120
    assert attributes["gen_ai.usage.output_tokens"] == 40
    assert json.loads(attributes["langfuse.observation.usage_details"]) == {
        "input": 100,
        "output": 30,
        "total": 160,
        "input_cached_tokens": 20,
        "output_reasoning_tokens": 10,
    }
    assert json.loads(attributes["langfuse.observation.cost_details"]) == {"total": 0.00042}
    assert json.loads(attributes["langfuse.observation.input"]) == _MESSAGES
    assert attributes["langfuse.observation.output"] == '{"title": "Brandschutz Stiegenhaus"}'
    assert "langfuse.observation.level" not in attributes
    assert span.status.status_code is not StatusCode.ERROR


async def test_no_session_is_claimed_without_a_conversation(exporter):
    async with direct_trace.observed_generation("project-summary", model="m", messages=_MESSAGES) as generation:
        generation.finish({"choices": [{"message": {"content": "x"}}]})

    (span,) = _spans(exporter)
    assert "langfuse.session.id" not in span.attributes
    # No usage object, no invented zeros.
    assert "langfuse.observation.usage_details" not in span.attributes


async def test_a_failed_call_is_an_error_generation_and_the_exception_reaches_the_route(exporter):
    request = httpx.Request("POST", "https://openrouter.ai/api/v1/chat/completions")
    error = httpx.HTTPStatusError("429", request=request, response=httpx.Response(429, request=request))

    with pytest.raises(httpx.HTTPStatusError) as raised:
        async with direct_trace.observed_generation("feedback-digest", model="m", messages=_MESSAGES):
            raise error

    assert raised.value is error
    (span,) = _spans(exporter)
    assert span.attributes["langfuse.observation.level"] == "ERROR"
    assert span.attributes["langfuse.observation.status_message"] == "HTTPStatusError: HTTP 429"
    assert span.status.status_code is StatusCode.ERROR


async def test_prompt_and_reply_are_capped(exporter):
    huge = "x" * (direct_trace.MAX_PAYLOAD_CHARS * 2)
    async with direct_trace.observed_generation(
        "skill-review", model="m", messages=[{"role": "user", "content": huge}]
    ) as generation:
        generation.finish({"choices": [{"message": {"content": huge}}]})

    (span,) = _spans(exporter)
    for key in ("langfuse.observation.input", "langfuse.observation.output"):
        value = span.attributes[key]
        assert value.endswith(direct_trace.TRUNCATION_MARKER)
        assert len(value) == direct_trace.MAX_PAYLOAD_CHARS + len(direct_trace.TRUNCATION_MARKER)


@pytest.mark.parametrize("response", [None, "not json", {"choices": None, "usage": "x"}, {"choices": [None]}])
async def test_an_unreadable_reply_never_raises_into_the_route(exporter, response):
    async with direct_trace.observed_generation("consistency-check", model="m", messages=_MESSAGES) as generation:
        generation.finish(response)

    (span,) = _spans(exporter)
    assert "langfuse.observation.output" not in span.attributes


async def test_a_broken_tracer_never_raises_into_the_route(monkeypatch, exporter):
    class _Broken:
        def start_span(self, *args, **kwargs):
            raise RuntimeError("exporter is gone")

    monkeypatch.setattr(direct_trace, "_tracer", _Broken())

    async with direct_trace.observed_generation("lesson-distill", model="m", messages=_MESSAGES) as generation:
        generation.finish(_RESPONSE)

    assert _spans(exporter) == ()
