"""Environment, release, observation type and trace name on every exported span (ADR-0089).

Langfuse ignores an attribute it does not recognise without a word, so each of
these mappings is invisible when it breaks: the trace still arrives, filed as
"default", with no release and every observation a plain span. Only a test
notices.
"""

import pytest

from aiq_agent.observability.langfuse_trace_attributes import TAGS_ATTRIBUTE
from aiq_agent.observability.langfuse_trace_attributes import TraceContextProcessor
from aiq_agent.observability.langfuse_trace_attributes import context_attributes_for
from aiq_agent.observability.langfuse_trace_attributes import merge_span_attributes
from aiq_agent.observability.trace_context import ENVIRONMENT_ATTRIBUTE
from aiq_agent.observability.trace_context import OBSERVATION_TYPE_ATTRIBUTE
from aiq_agent.observability.trace_context import RELEASE_ATTRIBUTE
from aiq_agent.observability.trace_context import TRACE_NAME_ATTRIBUTE
from aiq_agent.observability.trace_context import langfuse_environment
from aiq_agent.observability.trace_context import langfuse_release
from aiq_agent.observability.trace_context import observation_type
from aiq_agent.observability.trace_context import trace_name_for_root
from aiq_agent.observability.turn_outcome import begin_turn_outcome
from aiq_agent.observability.turn_outcome import end_turn_outcome
from aiq_agent.observability.turn_outcome import record_turn_error


class TestEnvironment:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [("production", "production"), ("Staging", "staging"), (" dev env ", "dev-env"), ("prod.eu/1", "prod-eu-1")],
    )
    def test_coerced_into_the_alphabet_langfuse_accepts(self, raw, expected):
        assert langfuse_environment(raw) == expected

    @pytest.mark.parametrize("raw", ["", "   ", "langfuse-internal", "///"])
    def test_unusable_or_reserved_names_are_absent_not_invented(self, raw):
        assert langfuse_environment(raw) is None

    def test_read_from_app_env_by_default(self, monkeypatch):
        monkeypatch.setenv("APP_ENV", "production")
        assert langfuse_environment() == "production"


class TestRelease:
    def test_the_commit_is_the_release(self, monkeypatch):
        monkeypatch.setenv("GRID_GIT_SHA", "fa9268b6abc")
        assert langfuse_release() == "fa9268b6abc"

    @pytest.mark.parametrize("raw", ["", "unknown"])
    def test_an_unknown_build_has_no_release(self, raw):
        assert langfuse_release(raw) is None


class TestObservationType:
    @pytest.mark.parametrize(
        ("kind", "expected"),
        [
            ("LLM", "generation"),
            ("TOOL", "tool"),
            ("WORKFLOW", "agent"),
            ("FUNCTION", "chain"),
            ("EMBEDDER", "embedding"),
            ("RERANKER", "retriever"),
            ("GUARDRAIL", "guardrail"),
        ],
    )
    def test_nat_kinds_map_to_langfuse_types(self, kind, expected):
        assert observation_type(name="x", kind=kind) == expected

    def test_grid_retrieval_steps_are_retrievers_whatever_nat_calls_them(self):
        assert observation_type(name="retrieve.knowledge_search", kind="FUNCTION") == "retriever"

    @pytest.mark.parametrize("kind", ["CUSTOM", "SPAN", "TASK", "UNKNOWN", None])
    def test_kinds_without_a_counterpart_stay_plain_spans(self, kind):
        assert observation_type(name="x", kind=kind) is None


class TestTraceName:
    def test_a_workflow_root_is_a_chat_turn(self):
        assert trace_name_for_root("chat_deepresearcher_agent") == "chat-turn"

    def test_a_standalone_job_root_is_a_research_job(self):
        assert trace_name_for_root("async_job:deep_research_agent") == "research-job"


class TestContextAttributes:
    def test_every_span_carries_environment_release_and_type(self, monkeypatch):
        monkeypatch.setenv("APP_ENV", "production")
        monkeypatch.setenv("GRID_GIT_SHA", "abc123")

        attributes = context_attributes_for(
            name="openai/gpt-x", attributes={"nat.span.kind": "LLM"}, is_root=False, outcome=None
        )

        assert attributes == {
            ENVIRONMENT_ATTRIBUTE: "production",
            RELEASE_ATTRIBUTE: "abc123",
            OBSERVATION_TYPE_ATTRIBUTE: "generation",
        }

    def test_only_a_root_names_its_trace_and_carries_the_outcome(self, monkeypatch):
        monkeypatch.delenv("GRID_GIT_SHA", raising=False)
        outcome = {"langfuse.trace.metadata.turn_outcome": "answered"}

        child = context_attributes_for(name="tool", attributes={}, is_root=False, outcome=outcome)
        root = context_attributes_for(name="chat_deepresearcher_agent", attributes={}, is_root=True, outcome=outcome)

        assert TRACE_NAME_ATTRIBUTE not in child
        assert "langfuse.trace.metadata.turn_outcome" not in child
        assert root[TRACE_NAME_ATTRIBUTE] == "chat-turn"
        assert root["langfuse.trace.metadata.turn_outcome"] == "answered"


class TestTagMerge:
    def test_a_second_processor_unites_tags_rather_than_replacing_them(self):
        attributes = {TAGS_ATTRIBUTE: ["org:o1", "feature:ifc"]}

        merge_span_attributes(attributes, {TAGS_ATTRIBUTE: ["outcome:answered", "org:o1"], "k": 1})

        assert attributes[TAGS_ATTRIBUTE] == ["org:o1", "feature:ifc", "outcome:answered"]
        assert attributes["k"] == 1


class TestProcessor:
    async def test_a_failed_turns_root_is_an_error_span(self, monkeypatch):
        from nat.data_models.span import Span
        from nat.data_models.span import SpanStatusCode

        token = begin_turn_outcome()
        try:
            record_turn_error("workflow_error", "boom")
            span = await TraceContextProcessor().process(Span(name="chat_deepresearcher_agent"))
        finally:
            end_turn_outcome(token)

        assert span.attributes["langfuse.observation.level"] == "ERROR"
        assert span.attributes["langfuse.observation.status_message"] == "boom"
        assert span.status.code == SpanStatusCode.ERROR
        assert "error:workflow_error" in span.attributes[TAGS_ATTRIBUTE]

    async def test_a_child_span_never_takes_the_turns_outcome(self):
        from nat.data_models.span import Span

        token = begin_turn_outcome()
        try:
            record_turn_error("workflow_error", "boom")
            parent = Span(name="root")
            child = await TraceContextProcessor().process(Span(name="tool", parent=parent))
        finally:
            end_turn_outcome(token)

        assert "langfuse.observation.level" not in child.attributes
        assert TRACE_NAME_ATTRIBUTE not in child.attributes


class TestPipelineWiring:
    @pytest.mark.parametrize("identity", ["true", ""])
    async def test_installed_whatever_the_identity_flag_and_ahead_of_redaction(self, monkeypatch, identity):
        from aiq_agent.observability.langfuse_trace_attributes import IDENTITY_ATTRIBUTES_ENV
        from aiq_agent.observability.otel_header_redaction_exporter import OtelCollectorRedactionTelemetryExporter
        from aiq_agent.observability.otel_header_redaction_exporter import otelcollector_redaction_telemetry_exporter

        monkeypatch.setenv(IDENTITY_ATTRIBUTES_ENV, identity)
        config = OtelCollectorRedactionTelemetryExporter(
            _type="otelcollector_redaction", project="grid-aiq-agent", endpoint="http://otel-collector:4318/v1/traces"
        )

        async with otelcollector_redaction_telemetry_exporter(config, None) as exporter:
            positions = exporter._processor_names

        assert positions["grid_trace_context"] < positions["header_redaction"]

    async def test_tool_contributions_reach_the_trace_with_identity_off(self, monkeypatch):
        """The privacy switch must not also switch off cost and quality reporting."""
        from aiq_agent.observability.langfuse_trace_attributes import IDENTITY_ATTRIBUTES_ENV
        from aiq_agent.observability.otel_header_redaction_exporter import OtelCollectorRedactionTelemetryExporter
        from aiq_agent.observability.otel_header_redaction_exporter import otelcollector_redaction_telemetry_exporter

        monkeypatch.delenv(IDENTITY_ATTRIBUTES_ENV, raising=False)
        config = OtelCollectorRedactionTelemetryExporter(
            _type="otelcollector_redaction", project="grid-aiq-agent", endpoint="http://otel-collector:4318/v1/traces"
        )

        async with otelcollector_redaction_telemetry_exporter(config, None) as exporter:
            positions = exporter._processor_names

        assert "grid_trace_contributions" in positions
        assert "langfuse_trace_attributes" not in positions
