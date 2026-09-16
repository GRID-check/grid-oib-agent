"""Prompt linkage: the two attributes that stop `promptVersion` rendering as null.

Langfuse's prompt view answers "did version 12 cost more than version 11" by
grouping generations on `langfuse.observation.prompt.name` /
`.version`. Nothing writes those unless we do, so every assertion here is about
a column an operator would otherwise find empty — or, worse, populated for a
span that never used the prompt.
"""

from __future__ import annotations

import pytest

from aiq_agent.observability.langfuse_trace_attributes import OBSERVATION_PROMPT_NAME
from aiq_agent.observability.langfuse_trace_attributes import OBSERVATION_PROMPT_VERSION
from aiq_agent.observability.langfuse_trace_attributes import PromptLinkProcessor
from aiq_agent.observability.langfuse_trace_attributes import current_prompt_attributes
from aiq_agent.observability.langfuse_trace_attributes import is_generation_span
from aiq_agent.observability.langfuse_trace_attributes import prompt_observation_attributes
from aiq_agent.observability.langfuse_trace_attributes import record_prompt_link
from aiq_agent.observability.langfuse_trace_attributes import reset_prompt_link


@pytest.fixture(autouse=True)
def _clean_link():
    reset_prompt_link()
    yield
    reset_prompt_link()


class TestAttributeMapping:
    def test_the_keys_are_the_ones_langfuses_otel_mapping_reads(self):
        """
        Pinned as literals rather than derived, because these two strings are
        the whole contract with Langfuse's ingestion and a typo in either is
        invisible: the span exports fine and the column stays null.
        """
        assert prompt_observation_attributes(name="piloti-system-static", version="12") == {
            "langfuse.observation.prompt.name": "piloti-system-static",
            "langfuse.observation.prompt.version": 12,
        }

    def test_half_a_link_is_no_link(self):
        """
        A name without a version points at a prompt Langfuse cannot resolve to
        a text; a version without a name belongs to nothing. Either alone is
        worse than null, because it reads as a real linkage.
        """
        assert prompt_observation_attributes(name="p", version=None) == {}
        assert prompt_observation_attributes(name=None, version="12") == {}
        assert prompt_observation_attributes(name="", version="") == {}

    def test_the_version_is_an_int_whichever_way_it_arrives(self):
        """
        Langfuse numbers versions from 1 as ints and its ingestion declares
        `promptVersion` as one. A string is not coerced server-side: the
        generation event is rejected whole, which erased every GENERATION
        observation from production while CHAIN and TOOL kept arriving.
        """
        assert prompt_observation_attributes(name="p", version=12)[OBSERVATION_PROMPT_VERSION] == 12
        assert prompt_observation_attributes(name="p", version="12")[OBSERVATION_PROMPT_VERSION] == 12

    def test_the_type_is_read_off_the_installed_langfuse_rather_than_copied(self):
        """
        The ratchet. The schema is the oracle, so a Langfuse release that moves
        `promptVersion` to another type fails this suite instead of the fleet —
        which is the only way this fault announces itself, the spans being
        dropped silently and the trace otherwise complete.
        """
        import typing

        from langfuse.api.ingestion.types.create_generation_body import CreateGenerationBody

        declared = CreateGenerationBody.model_fields["prompt_version"].annotation
        emitted = prompt_observation_attributes(name="p", version="12")[OBSERVATION_PROMPT_VERSION]

        assert typing.get_args(declared) == (int, type(None))
        assert CreateGenerationBody(prompt_version=emitted).prompt_version == emitted

    def test_a_git_blob_version_is_no_link_at_all(self):
        """
        The bundled fallback is versioned by the git blob hash of the committed
        file, and named `git:...` — a prompt Langfuse does not hold. There is
        no int to emit and nothing to link to, so the generation carries
        neither attribute rather than one the schema rejects. Langfuse's own
        SDK links no fallback either (`_client/attributes.py`).
        """
        assert prompt_observation_attributes(name="git:prompts/piloti_static.md", version="3f2a9c1") == {}


class TestRecording:
    def test_nothing_is_attached_before_a_prompt_is_resolved(self):
        assert current_prompt_attributes() == {}

    def test_recording_replaces_rather_than_accumulates(self):
        record_prompt_link(name="piloti-system-static", version="11")
        record_prompt_link(name="piloti-system-static", version="12")

        assert current_prompt_attributes() == {
            OBSERVATION_PROMPT_NAME: "piloti-system-static",
            OBSERVATION_PROMPT_VERSION: 12,
        }

    def test_an_incomplete_record_leaves_the_last_good_one_alone(self):
        record_prompt_link(name="piloti-system-static", version="12")
        record_prompt_link(name="piloti-system-static", version="")

        assert current_prompt_attributes()[OBSERVATION_PROMPT_VERSION] == 12

    def test_recording_never_raises_into_the_render_that_called_it(self):
        """
        This is called from the prompt render path. A telemetry bookkeeping
        failure must degrade the trace, never cost a user their turn.
        """

        class Hostile:
            def __str__(self):
                raise RuntimeError("no")

        record_prompt_link(name=Hostile(), version="12")

        assert current_prompt_attributes() == {}


class TestGenerationDetection:
    def test_an_llm_span_is_a_generation_whatever_the_key_prefix(self):
        assert is_generation_span({"nat.event_type": "LLM_END"}) is True
        assert is_generation_span({"some.vendor.event_type": "LLM_START"}) is True

    def test_everything_else_is_not(self):
        assert is_generation_span({}) is False
        assert is_generation_span({"nat.event_type": "TOOL_END"}) is False
        assert is_generation_span({"nat.event_type": 7}) is False


class TestProcessor:
    async def test_it_stamps_the_current_link_onto_a_generation(self):
        from nat.data_models.span import Span

        record_prompt_link(name="piloti-system-static", version="12")
        span = Span(name="a-model", attributes={"nat.event_type": "LLM_END"})

        result = await PromptLinkProcessor().process(span)

        assert result.attributes[OBSERVATION_PROMPT_NAME] == "piloti-system-static"
        assert result.attributes[OBSERVATION_PROMPT_VERSION] == 12

    async def test_a_tool_span_is_left_alone(self):
        """
        A retrieval span has no prompt. Stamping one would make Langfuse's
        per-prompt aggregates count spans that never used the prompt, which is
        a wrong number rather than a missing one.
        """
        from nat.data_models.span import Span

        record_prompt_link(name="piloti-system-static", version="12")
        span = Span(name="search_documents", attributes={"nat.event_type": "TOOL_END"})

        result = await PromptLinkProcessor().process(span)

        assert OBSERVATION_PROMPT_NAME not in (result.attributes or {})

    async def test_no_recorded_link_leaves_the_span_untouched(self):
        from nat.data_models.span import Span

        span = Span(name="a-model", attributes={"nat.event_type": "LLM_END"})

        result = await PromptLinkProcessor().process(span)

        assert OBSERVATION_PROMPT_NAME not in (result.attributes or {})

    async def test_a_broken_link_degrades_the_trace_instead_of_failing_export(self, monkeypatch):
        """
        Same rule as every other processor here: an exception escaping the
        pipeline stops span export for the whole process.
        """
        import aiq_agent.observability.langfuse_trace_attributes as module
        from nat.data_models.span import Span

        def boom():
            raise RuntimeError("nope")

        monkeypatch.setattr(module, "current_prompt_attributes", boom)
        span = Span(name="a-model", attributes={"nat.event_type": "LLM_END"})

        result = await PromptLinkProcessor().process(span)

        assert result is span


class TestPipelineWiring:
    async def test_it_is_installed_ahead_of_redaction(self, monkeypatch):
        """
        Installed unconditionally (a prompt name is not personal data), and at
        `position=0` so the attributes it adds stay redactable like every other
        attribute we add — the ordering NAT's redaction pass depends on.
        """
        from aiq_agent.observability.otel_header_redaction_exporter import otelcollector_redaction_telemetry_exporter
        from tests.aiq_agent.observability.test_langfuse_trace_attributes import _make_config

        async with otelcollector_redaction_telemetry_exporter(_make_config(), None) as exporter:
            positions = exporter._processor_names

            assert "grid_prompt_link" in positions
            assert positions["grid_prompt_link"] < positions["header_redaction"]
