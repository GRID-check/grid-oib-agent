"""
Langfuse session/user attribution (ADR-0044).

Two things are worth pinning here, and they are not the same thing:

1. **The mapping** — which Grid identity field becomes which Langfuse
   attribute. Get a name wrong and Langfuse silently ignores the attribute:
   traces still arrive, they are just anonymous. Nothing errors, so only a test
   catches it.
2. **The pipeline position** — the processor must run BEFORE NAT's redaction
   processor, or attributes naming a person can never be redacted while
   `redaction_attributes` still claims to cover them.
"""

import pytest

from aiq_agent.observability.langfuse_trace_attributes import IDENTITY_ATTRIBUTES_ENV
from aiq_agent.observability.langfuse_trace_attributes import SESSION_ID_ATTRIBUTE
from aiq_agent.observability.langfuse_trace_attributes import TAGS_ATTRIBUTE
from aiq_agent.observability.langfuse_trace_attributes import USER_ID_ATTRIBUTE
from aiq_agent.observability.langfuse_trace_attributes import LangfuseTraceAttributeProcessor
from aiq_agent.observability.langfuse_trace_attributes import identity_attributes_enabled
from aiq_agent.observability.langfuse_trace_attributes import langfuse_attributes_for
from aiq_agent.observability.otel_header_redaction_exporter import OtelCollectorRedactionTelemetryExporter
from aiq_agent.observability.otel_header_redaction_exporter import otelcollector_redaction_telemetry_exporter

ENDPOINT = "http://otel-collector:4318/v1/traces"


def _make_config() -> OtelCollectorRedactionTelemetryExporter:
    return OtelCollectorRedactionTelemetryExporter(
        _type="otelcollector_redaction", project="grid-aiq-agent", endpoint=ENDPOINT
    )


class TestAttributeMapping:
    def test_maps_every_identity_field_to_the_name_langfuse_reads(self):
        attributes = langfuse_attributes_for(
            user_id="user_123",
            organization_id="org_456",
            project_id="proj_789",
            conversation_id="conv_abc",
        )

        assert attributes == {
            USER_ID_ATTRIBUTE: "user_123",
            SESSION_ID_ATTRIBUTE: "conv_abc",
            "langfuse.trace.metadata.organization_id": "org_456",
            "langfuse.trace.metadata.project_id": "proj_789",
            TAGS_ATTRIBUTE: ["org:org_456"],
        }

    def test_omits_absent_fields_rather_than_inventing_placeholders(self):
        """
        NAT writes the string "unknown" for its own absent context fields. Doing
        that here would be actively wrong: Langfuse would render a user named
        `unknown` and, worse, group every anonymous request into one shared
        session — inventing a conversation that never happened.
        """
        assert langfuse_attributes_for(user_id=None, organization_id=None, project_id=None, conversation_id=None) == {}

    def test_never_blanks_out_the_session_id_nat_already_set(self):
        """
        NAT's span exporter sets `session.id` from the conversation id at span
        creation. When our own read comes back empty we must add nothing, not
        write an empty `langfuse.session.id` — Langfuse prefers the prefixed
        attribute, so an empty one would OVERRIDE a good value.
        """
        attributes = langfuse_attributes_for(
            user_id="user_123", organization_id=None, project_id=None, conversation_id=None
        )

        assert SESSION_ID_ATTRIBUTE not in attributes

    def test_tags_the_tenant_so_the_trace_list_can_filter_on_it(self):
        attributes = langfuse_attributes_for(
            user_id=None, organization_id="org_456", project_id=None, conversation_id=None
        )

        # A list, not a comma-joined string: Langfuse expects an array here and
        # renders a joined string as one long single tag.
        assert attributes[TAGS_ATTRIBUTE] == ["org:org_456"]


class TestAvailabilityGate:
    """Availability = flag AND capability. The flag is the deployment's."""

    def test_defaults_to_off(self, monkeypatch):
        monkeypatch.delenv(IDENTITY_ATTRIBUTES_ENV, raising=False)
        assert identity_attributes_enabled() is False

    @pytest.mark.parametrize("value", ["true", "TRUE", " true "])
    def test_enabled_only_by_an_explicit_true(self, monkeypatch, value):
        monkeypatch.setenv(IDENTITY_ATTRIBUTES_ENV, value)
        assert identity_attributes_enabled() is True

    @pytest.mark.parametrize("value", ["", "false", "1", "yes"])
    def test_anything_else_leaves_it_off(self, monkeypatch, value):
        """
        Deliberately strict. This gate controls whether user identifiers are
        written into a telemetry store, so an ambiguous value must fail closed
        rather than be generously interpreted.
        """
        monkeypatch.setenv(IDENTITY_ATTRIBUTES_ENV, value)
        assert identity_attributes_enabled() is False


class TestProcessor:
    async def test_stamps_the_attributes_onto_a_span(self, monkeypatch):
        from nat.data_models.span import Span

        monkeypatch.setattr(
            "aiq_agent.observability.langfuse_trace_attributes.current_langfuse_attributes",
            lambda: {USER_ID_ATTRIBUTE: "user_123", SESSION_ID_ATTRIBUTE: "conv_abc"},
        )

        span = Span(name="llm-call")
        result = await LangfuseTraceAttributeProcessor().process(span)

        assert result.attributes[USER_ID_ATTRIBUTE] == "user_123"
        assert result.attributes[SESSION_ID_ATTRIBUTE] == "conv_abc"

    async def test_a_broken_context_degrades_the_trace_instead_of_failing_export(self, monkeypatch):
        """
        Enrichment sits in the export pipeline. An exception escaping it would
        take out span export for the whole process, which is a far worse outcome
        than a span with no user id on it.
        """
        from nat.data_models.span import Span

        def explode():
            raise RuntimeError("context is gone")

        monkeypatch.setattr(
            "aiq_agent.project_context.GridRequestContext.from_context",
            staticmethod(explode),
        )

        span = Span(name="llm-call")
        result = await LangfuseTraceAttributeProcessor().process(span)

        assert result is span
        assert USER_ID_ATTRIBUTE not in result.attributes


class TestPipelineWiring:
    async def test_absent_from_the_pipeline_when_the_tier_is_off(self, monkeypatch):
        monkeypatch.delenv(IDENTITY_ATTRIBUTES_ENV, raising=False)

        async with otelcollector_redaction_telemetry_exporter(_make_config(), None) as exporter:
            assert "langfuse_trace_attributes" not in exporter._processor_names

    async def test_runs_ahead_of_redaction_when_the_tier_is_on(self, monkeypatch):
        """
        The ordering IS the control. Attributes added after the redaction pass
        can never be redacted, so listing `langfuse.user.id` in
        `redaction_attributes` would configure something with no effect — a
        privacy setting that silently does nothing.
        """
        monkeypatch.setenv(IDENTITY_ATTRIBUTES_ENV, "true")

        async with otelcollector_redaction_telemetry_exporter(_make_config(), None) as exporter:
            positions = exporter._processor_names

            assert "langfuse_trace_attributes" in positions
            assert positions["langfuse_trace_attributes"] < positions["header_redaction"]

    async def test_identity_attributes_are_actually_redactable(self, monkeypatch):
        """
        The consequence of the ordering above, asserted end-to-end rather than
        by position: with redaction forced and `langfuse.user.id` listed, the
        user id must come out redacted.
        """
        from nat.data_models.span import Span

        monkeypatch.setenv(IDENTITY_ATTRIBUTES_ENV, "true")
        monkeypatch.setattr(
            "aiq_agent.observability.langfuse_trace_attributes.current_langfuse_attributes",
            lambda: {USER_ID_ATTRIBUTE: "user_123"},
        )

        config = OtelCollectorRedactionTelemetryExporter(
            _type="otelcollector_redaction",
            project="grid-aiq-agent",
            endpoint=ENDPOINT,
            redaction_enabled=True,
            force_redaction=True,
            redaction_attributes=[USER_ID_ATTRIBUTE],
        )

        async with otelcollector_redaction_telemetry_exporter(config, None) as exporter:
            span = Span(name="llm-call")
            for processor in exporter._processors[:2]:
                span = await processor.process(span)

        assert span.attributes[USER_ID_ATTRIBUTE] == "[REDACTED]"


class TestToolContributions:
    """Facts a TOOL recorded about what it did (ADR-0045).

    The gap is specific to the IFC tools: their work happens in the BFF, which
    exports OTel logs and no traces, so the span Langfuse receives is a
    duration and a rendered string. Everything that would explain a slow or a
    wrong answer — which model, which operation, whether the answer covered the
    whole building — is otherwise unrecoverable from the trace.
    """

    @pytest.fixture(autouse=True)
    def _clean(self):
        from aiq_agent.observability.langfuse_trace_attributes import reset_contributions

        reset_contributions()
        yield
        reset_contributions()

    def test_recorded_facts_are_namespaced_like_the_identity_metadata(self):
        from aiq_agent.observability.langfuse_trace_attributes import _CONTRIBUTED
        from aiq_agent.observability.langfuse_trace_attributes import record_trace_metadata

        record_trace_metadata(ifc_op="compliance", ifc_model="haus.ifc", ifc_truncated=True)

        assert langfuse_attributes_for(
            user_id=None,
            organization_id=None,
            project_id=None,
            conversation_id=None,
            contributed=_CONTRIBUTED.get(),
        ) == {
            "langfuse.trace.metadata.ifc_op": "compliance",
            "langfuse.trace.metadata.ifc_model": "haus.ifc",
            "langfuse.trace.metadata.ifc_truncated": True,
        }

    def test_a_tool_tag_joins_the_organization_tag_rather_than_replacing_it(self):
        # "Show me this organization's traces" and "show me the turns that read
        # a building model" are both trace-list filters, and losing the first to
        # gain the second would be a bad trade in a multi-tenant store.
        from aiq_agent.observability.langfuse_trace_attributes import _CONTRIBUTED
        from aiq_agent.observability.langfuse_trace_attributes import add_trace_tag

        add_trace_tag("feature:ifc")
        add_trace_tag("feature:ifc")

        attributes = langfuse_attributes_for(
            user_id=None,
            organization_id="org_456",
            project_id=None,
            conversation_id=None,
            contributed=_CONTRIBUTED.get(),
        )

        assert attributes[TAGS_ATTRIBUTE] == ["org:org_456", "feature:ifc"]

    def test_absent_values_are_dropped_here_too(self):
        # Same rule as the identity fields: Langfuse renders what it is given,
        # and `ifc_model=None` reads as a model actually called "None".
        from aiq_agent.observability.langfuse_trace_attributes import _CONTRIBUTED
        from aiq_agent.observability.langfuse_trace_attributes import record_trace_metadata

        record_trace_metadata(ifc_op="overview", ifc_model=None, ifc_truncated=None)

        assert langfuse_attributes_for(
            user_id=None,
            organization_id=None,
            project_id=None,
            conversation_id=None,
            contributed=_CONTRIBUTED.get(),
        ) == {"langfuse.trace.metadata.ifc_op": "overview"}

    def test_recording_never_raises_into_the_turn(self):
        # Telemetry enrichment must not be able to fail the answer it describes.
        from aiq_agent.observability.langfuse_trace_attributes import add_trace_tag
        from aiq_agent.observability.langfuse_trace_attributes import record_trace_metadata

        class Unhashable:
            __hash__ = None  # type: ignore[assignment]

        record_trace_metadata(ifc_op=Unhashable())
        add_trace_tag("feature:ifc")

    def test_nothing_is_attached_when_no_tool_contributed(self):
        assert langfuse_attributes_for(
            user_id="user_123",
            organization_id=None,
            project_id=None,
            conversation_id=None,
            contributed=None,
        ) == {USER_ID_ATTRIBUTE: "user_123"}


class TestContributionIsolation:
    """A reused worker must not hand job N's tags to job N+1, across tenants.

    Dask reuses processes: without a per-job bind/reset in ``finally`` (see
    ``DeepResearcherAgent.run``) the ContextVar still holds job N's dict when
    job N+1 starts. And without copy-on-write, ``asyncio.create_task`` snapshots
    the var's OBJECT reference, so a later in-place ``update``/``append`` rewrites
    an already-snapshotted export task and a concurrent researcher's writes.
    """

    @pytest.fixture(autouse=True)
    def _clean(self):
        from aiq_agent.observability.langfuse_trace_attributes import reset_contributions

        reset_contributions()
        yield
        reset_contributions()

    def test_next_job_starts_clean_after_previous_job_contributed(self):
        # Job N on a reused worker contributes, then its `finally` restores.
        from aiq_agent.observability.langfuse_trace_attributes import add_trace_tag
        from aiq_agent.observability.langfuse_trace_attributes import begin_trace_contributions
        from aiq_agent.observability.langfuse_trace_attributes import end_trace_contributions
        from aiq_agent.observability.langfuse_trace_attributes import record_trace_metadata
        from aiq_agent.observability.langfuse_trace_attributes import snapshot_contributions

        job_n = begin_trace_contributions()
        try:
            record_trace_metadata(ifc_op="compliance", ifc_model="haus.ifc")
            add_trace_tag("feature:ifc")
            assert snapshot_contributions()["tags"] == ["feature:ifc"]
        finally:
            end_trace_contributions(job_n)

        # Job N+1 on the SAME process/context starts fresh — no org tag bleed
        # into another tenant's traces.
        job_n_plus_1 = begin_trace_contributions()
        try:
            fresh = snapshot_contributions()
            assert fresh == {"metadata": {}, "tags": []}
            attributes = langfuse_attributes_for(
                user_id=None,
                organization_id=None,
                project_id=None,
                conversation_id=None,
                contributed=fresh,
            )
            assert TAGS_ATTRIBUTE not in attributes
            assert "langfuse.trace.metadata.ifc_op" not in attributes
        finally:
            end_trace_contributions(job_n_plus_1)

    async def test_concurrent_researchers_do_not_cross_contaminate(self):
        import asyncio

        from aiq_agent.observability.langfuse_trace_attributes import add_trace_tag
        from aiq_agent.observability.langfuse_trace_attributes import record_trace_metadata
        from aiq_agent.observability.langfuse_trace_attributes import snapshot_contributions

        # Parent contributes first so both children inherit the SAME dict object.
        # With in-place mutation both appends land in that shared object.
        record_trace_metadata(ifc_op="base")

        async def worker_a():
            add_trace_tag("job:a")
            await asyncio.sleep(0.05)
            record_trace_metadata(ifc_detail="a")
            return snapshot_contributions()

        async def worker_b():
            add_trace_tag("job:b")
            await asyncio.sleep(0.01)
            return snapshot_contributions()

        result_a, result_b = await asyncio.gather(worker_a(), worker_b())

        assert "job:b" not in result_a["tags"]
        assert "job:a" not in result_b["tags"]
        assert result_a["metadata"].get("ifc_op") == "base"
        assert result_b["metadata"].get("ifc_op") == "base"

    async def test_export_task_snapshot_is_frozen_against_later_writes(self):
        import asyncio

        from aiq_agent.observability.langfuse_trace_attributes import add_trace_tag
        from aiq_agent.observability.langfuse_trace_attributes import record_trace_metadata
        from aiq_agent.observability.langfuse_trace_attributes import snapshot_contributions

        record_trace_metadata(ifc_op="early")

        async def export_reader():
            await asyncio.sleep(0.05)
            return snapshot_contributions()

        # `create_task` snapshots the context NOW (span END); the tool's later
        # writes must not rewrite that snapshot.
        task = asyncio.create_task(export_reader())
        record_trace_metadata(ifc_op="late")
        add_trace_tag("feature:ifc")

        exported = await task
        assert exported["metadata"].get("ifc_op") == "early"
        assert "feature:ifc" not in exported["tags"]

    def test_snapshot_holds_no_live_reference(self):
        from aiq_agent.observability.langfuse_trace_attributes import record_trace_metadata
        from aiq_agent.observability.langfuse_trace_attributes import snapshot_contributions

        record_trace_metadata(ifc_op="early")
        snap = snapshot_contributions()
        assert snap is not None
        snap["metadata"]["ifc_op"] = "rewritten"
        snap["tags"].append("feature:ifc")

        fresh = snapshot_contributions()
        assert fresh["metadata"].get("ifc_op") == "early"
        assert "feature:ifc" not in fresh["tags"]
