"""Memory reflection as a post-answer stage.

The gate cases moved here verbatim from
``tests/aiq_agent/agents/chat_researcher/test_register_helpers.py`` — the
predicate is the same predicate, it just reads ``TurnFacts`` instead of the graph
state now. The new cases are the two defects the migration closes: a hard
timeout, and a gate that finally reads ``research_truncated``.
"""

import dataclasses
from unittest.mock import patch

import pytest

from aiq_agent.stages import get_stage
from aiq_agent.stages.flags import legacy_enabled_stages
from aiq_agent.stages.flags import stages_for_flag_slug
from aiq_agent.stages.memory_reflection import MEMORY_REFLECTION
from aiq_agent.stages.memory_reflection import MemoryReflectionPayload
from aiq_agent.stages.spec import StageContext
from aiq_agent.stages.spec import TurnFacts


def _facts(**overrides) -> TurnFacts:
    base = TurnFacts(
        conversation_id="conv_1",
        ws_parent_id="msg_1",
        organization_id="org_1",
        project_id="proj_1",
        query="Wie hoch darf die Brüstung sein?",
        answer="Das Gebäude ist Gebäudeklasse 4.",
        intent="research",
        enabled_stages=frozenset({"memory_reflection"}),
    )
    return dataclasses.replace(base, **overrides)


def _gate(**overrides):
    return MEMORY_REFLECTION.gate(_facts(**overrides))


#: What `run_memory_reflection` reports it wrote — one row per project_memory
#: insert, in write order, as the reader will see it.
_WRITTEN = [
    {"id": "9d2f6b41", "kind": "constraint", "content": "Das Projekt liegt in Wien."},
    {"id": "1a7c9e02", "kind": "derived_fact", "content": "Das oberste Fluchtniveau beträgt 9,80 m."},
]


class TestDeclaration:
    def test_it_is_registered_under_its_wire_id(self):
        assert get_stage("memory_reflection") is MEMORY_REFLECTION

    def test_it_declares_a_hard_timeout(self):
        """The defect this migration closes: before, the only bound was the
        provider's 120s x 2 retries, holding one of four concurrency slots."""
        assert MEMORY_REFLECTION.timeout_s == 45.0

    def test_it_delivers_a_frame_and_keeps_its_flag(self):
        """Slice 4b: the DB write is still the durable act, and the turn that
        caused it is now TOLD. That frame is the whole reason the per-answer
        memory poll could be deleted rather than merely slowed down — with
        `silent` there was no channel, so a browser had to guess when to ask.

        The flag does not move: an operator who switches `memory-reflection` off
        still switches off the writes AND the frame, which is what they mean.
        """
        assert MEMORY_REFLECTION.delivery == "frame"
        assert MEMORY_REFLECTION.flag_slug == "memory-reflection"


class TestFlagPlumbing:
    def test_the_legacy_boolean_still_switches_the_stage_on(self):
        """One release of overlap: an older BFF sends only
        `memoryReflectionEnabled`, and a mixed deployment must not go dark."""
        assert "memory_reflection" in legacy_enabled_stages(memory_reflection_enabled=True)

    def test_the_legacy_boolean_off_switches_it_off(self):
        assert legacy_enabled_stages(memory_reflection_enabled=False) == frozenset()

    def test_the_mapping_follows_the_declared_slug_not_a_hardcoded_id(self):
        assert stages_for_flag_slug(MEMORY_REFLECTION.flag_slug) == frozenset({"memory_reflection"})
        assert stages_for_flag_slug("no-such-flag") == frozenset()


class TestGate:
    def test_real_research_answer_passes(self):
        assert _gate().run is True

    def test_meta_intent_skipped(self):
        decision = _gate(intent="meta", answer="Hello! How can I help?")
        assert decision.run is False
        assert decision.reason == "intent_meta"

    def test_error_intent_skipped(self):
        assert _gate(intent="error", answer="Something went wrong.").reason == "intent_error"

    def test_out_of_scope_intent_skipped(self):
        assert _gate(intent="out_of_scope", answer="A concrete finding.").reason == "intent_out_of_scope"

    def test_insufficiency_answer_skipped(self):
        decision = _gate(answer="I don't have enough information to answer that.")
        assert decision.run is False
        assert decision.reason == "escalation"

    def test_canned_error_answer_skipped(self):
        decision = _gate(answer="An error occurred while researching your question. Please try again.")
        assert decision.reason == "canned_non_answer"

    def test_empty_answer_skipped(self):
        assert _gate(answer="   ").reason == "empty_turn"

    def test_a_truncated_turn_is_not_reflected_on(self):
        """`research_truncated` rides the wire but the old gate never read it, so
        durable project memory was distilled out of evidence-gathering that had
        been cut off at the tool-iteration ceiling."""
        decision = _gate(research_truncated=True)
        assert decision.run is False
        assert decision.reason == "research_truncated"

    def test_deep_research_stub_skipped(self):
        assert _gate(deep_research_job_id="job_1").reason == "deep_research_job"

    def test_a_project_less_conversation_has_nothing_it_may_write(self):
        assert _gate(project_id=None).reason == "no_project"


class TestHandler:
    @pytest.mark.asyncio
    async def test_nothing_durable_is_an_empty_payload_not_an_invention(self):
        with patch("aiq_agent.agents.project_memory.reflection.run_memory_reflection", return_value=[]) as run:
            payload = await MEMORY_REFLECTION.handler(StageContext(facts=_facts(), llm=object()))
        assert payload is None
        assert run.await_count == 1

    @pytest.mark.asyncio
    async def test_written_items_are_reported_as_the_payload(self):
        with patch("aiq_agent.agents.project_memory.reflection.run_memory_reflection", return_value=_WRITTEN):
            payload = await MEMORY_REFLECTION.handler(StageContext(facts=_facts(), llm=object()))
        assert payload == {"items": _WRITTEN}
        assert MemoryReflectionPayload.model_validate(payload).items[0].kind == "constraint"

    @pytest.mark.asyncio
    async def test_the_payload_carries_the_item_text_and_not_only_its_id(self):
        """What the chip renders is the finding's own words.

        A payload of ids would leave the browser holding a receipt for text it
        cannot read, and the only way to read it would be the GET this slice
        exists to delete — the poll would come back, wearing a frame as a
        trigger. The writer had the words in hand; it sends them.
        """
        with patch("aiq_agent.agents.project_memory.reflection.run_memory_reflection", return_value=_WRITTEN):
            payload = await MEMORY_REFLECTION.handler(StageContext(facts=_facts(), llm=object()))
        items = MemoryReflectionPayload.model_validate(payload).items
        assert [item.content for item in items] == [row["content"] for row in _WRITTEN]
        assert all(item.id and item.kind for item in items)

    @pytest.mark.asyncio
    async def test_the_pass_sees_the_digest_the_agent_saw_this_turn(self):
        facts = _facts(memory_digest='- [decision | high | verified] "Flachdach"')
        with patch("aiq_agent.agents.project_memory.reflection.run_memory_reflection", return_value=[]) as run:
            await MEMORY_REFLECTION.handler(StageContext(facts=facts, llm="the-llm"))
        kwargs = run.await_args.kwargs
        assert kwargs["memory_digest"] == facts.memory_digest
        assert kwargs["llm"] == "the-llm"
        assert kwargs["project_id"] == "proj_1"
        assert kwargs["organization_id"] == "org_1"
        assert kwargs["conversation_id"] == "conv_1"
