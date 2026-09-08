"""Per-turn context: gathered, fail-open where the callee says so, and the stage
facts captured whatever else failed."""

from __future__ import annotations

import asyncio
import time

import pytest

from aiq_agent.project_context import GridRequestContext
from aiq_agent.turn import context as context_mod
from aiq_agent.turn.context import load_turn_context
from aiq_agent.turn.context import thread_id_for_turn
from aiq_agent.turn.context import turn_identity
from aiq_agent.turn.context import user_info_from_principal


def _request(**fields) -> GridRequestContext:
    return GridRequestContext(**fields)


@pytest.fixture
def stubs(monkeypatch):
    """The three round-trips, replaced by stubs a test can shape."""
    calls: dict[str, object] = {"lessons": "LESSONS", "digest": "LIVE", "stages": frozenset({"follow_ups"})}

    def lessons(_conversation_id):
        return calls["lessons"]

    def digest(*, project_id, organization_id, query):
        calls["digest_args"] = (project_id, organization_id, query)
        value = calls["digest"]
        if isinstance(value, Exception):
            raise value
        return value

    async def stages(*, organization_id, memory_reflection_enabled):
        calls["stages_args"] = (organization_id, memory_reflection_enabled)
        return calls["stages"]

    monkeypatch.setattr(context_mod, "get_platform_lessons_digest", lessons)
    monkeypatch.setattr(context_mod, "fetch_memory_digest", digest)
    monkeypatch.setattr(context_mod, "resolve_enabled_stages", stages)
    monkeypatch.setattr(context_mod, "get_user_message_id_from_context", lambda: "msg-1")
    return calls


class TestLoadTurnContext:
    async def test_composes_the_live_digest_into_the_project_context(self, stubs):
        request = _request(project_id="p1", organization_id="org", project_context="PROFILE", project_memory="FROZEN")

        context = await load_turn_context(request, conversation_id="c1", query_text="Wie hoch?", resolve_stages=True)

        assert context.project_context == "PROFILE\n\nLIVE"
        assert context.platform_lessons == "LESSONS"
        assert stubs["digest_args"] == ("p1", "org", "Wie hoch?")
        facts = context.stage_facts
        assert (facts.conversation_id, facts.ws_parent_id, facts.organization_id, facts.project_id) == (
            "c1",
            "msg-1",
            "org",
            "p1",
        )
        assert facts.memory_digest == "LIVE"
        assert facts.enabled_stages == frozenset({"follow_ups"})

    async def test_a_failed_digest_fetch_keeps_the_header_digest_and_still_captures_the_stage_facts(self, stubs):
        """The old code wrapped the digest AND the stage facts in one try:
        one failure dropped both. The facts are the stages' only input."""
        stubs["digest"] = RuntimeError("GRID_INTERNAL_API_TOKEN is not configured")
        request = _request(project_id="p1", organization_id="org", project_memory="FROZEN", bundesland="wien")

        context = await load_turn_context(request, conversation_id="c1", query_text="q", resolve_stages=True)

        assert context.project_context == "FROZEN"
        assert context.stage_facts.organization_id == "org"
        assert context.stage_facts.memory_digest == "FROZEN"
        assert context.stage_facts.bundesland == "wien"
        assert context.stage_facts.enabled_stages == frozenset({"follow_ups"})

    async def test_a_bug_in_the_digest_fetch_is_not_swallowed(self, stubs):
        stubs["digest"] = TypeError("a bug, not a transport failure")
        with pytest.raises(TypeError):
            await load_turn_context(
                _request(project_id="p1"), conversation_id="c1", query_text="q", resolve_stages=False
            )

    async def test_no_project_and_no_org_means_no_fetch_and_the_header_value(self, stubs):
        context = await load_turn_context(
            _request(project_memory="FROZEN"), conversation_id="c1", query_text="q", resolve_stages=False
        )
        assert "digest_args" not in stubs
        assert context.project_context == "FROZEN"

    async def test_stage_flags_are_not_resolved_when_no_stage_has_a_model(self, stubs):
        context = await load_turn_context(
            _request(organization_id="org"), conversation_id="c1", query_text="q", resolve_stages=False
        )
        assert "stages_args" not in stubs
        assert context.stage_facts.enabled_stages == frozenset()

    async def test_the_three_round_trips_overlap(self, monkeypatch):
        """Gathered, not sequential: three 50 ms waits take ~50 ms, not ~150."""

        def slow_lessons(_cid):
            time.sleep(0.05)

        def slow_digest(**_kw):
            time.sleep(0.05)

        async def slow_stages(**_kw):
            await asyncio.sleep(0.05)
            return frozenset()

        monkeypatch.setattr(context_mod, "get_platform_lessons_digest", slow_lessons)
        monkeypatch.setattr(context_mod, "fetch_memory_digest", slow_digest)
        monkeypatch.setattr(context_mod, "resolve_enabled_stages", slow_stages)
        started = time.perf_counter()
        await load_turn_context(_request(project_id="p1"), conversation_id="c1", query_text="q", resolve_stages=True)
        assert time.perf_counter() - started < 0.12


class TestTurnIdentity:
    def test_the_conversation_id_is_the_thread(self):
        assert thread_id_for_turn("conv-1") == "conv-1"

    def test_a_missing_conversation_gets_a_fresh_thread(self):
        first, second = thread_id_for_turn(None), thread_id_for_turn("")
        assert first and second and first != second

    def test_user_info_is_none_when_anonymous(self, monkeypatch):
        monkeypatch.setattr(context_mod, "get_current_principal", lambda: None)
        assert user_info_from_principal() is None

    def test_user_info_carries_name_and_email(self, monkeypatch):
        class Principal:
            name = "Anna"
            email = "anna@example.com"

        monkeypatch.setattr(context_mod, "get_current_principal", lambda: Principal())
        assert user_info_from_principal() == {"name": "Anna", "email": "anna@example.com"}


def test_turn_identity_is_the_parsed_request_in_ledger_shape():
    request = _request(organization_id="org", user_id="u", project_id="p")
    assert turn_identity(request, "conv") == {
        "organization_id": "org",
        "user_id": "u",
        "project_id": "p",
        "conversation_id": "conv",
    }
