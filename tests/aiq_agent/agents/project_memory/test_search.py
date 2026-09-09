"""``search_memory`` — the read half of memory (ADR-0055).

Two things this file exists to hold still. The first is the SCOPE rule
(contract C1): the tool passes the turn's own organization and, on a project
turn, the turn's own project, and it exposes no way for the model to ask for
anything else. The BFF enforces that too, and the second lock is the point — a
knob the model can set is a knob that can be set wrong, and a refusal on the
other side of the network is not a design.

The second is that a bounded result SAYS it is bounded. A model that reads a
silently truncated list answers "what do you know about the cellar" as if it
had seen everything.

Drives the inner ``_search_memory`` the way NAT does, with the BFF client
mocked, so the tool's user-facing strings can be asserted without an endpoint.
"""

from unittest.mock import MagicMock

import pytest

import aiq_agent.knowledge.project_memory as pm
import aiq_agent.project_context as pc
from aiq_agent.agents.project_memory.search import ProjectMemorySearchConfig
from aiq_agent.agents.project_memory.search import project_memory_search
from aiq_agent.knowledge.memory_context import begin_turn_memory_reads
from aiq_agent.knowledge.memory_context import end_turn_memory_reads
from aiq_agent.knowledge.memory_context import turn_memory_searched


def _patch_context(monkeypatch, *, project_id="p1", organization_id="o1"):
    monkeypatch.setattr(pc, "get_project_id_from_context", lambda: project_id)
    monkeypatch.setattr(pc, "get_organization_id_from_context", lambda: organization_id)


def _hit(note_id="m1", **kwargs):
    fields = {
        "id": note_id,
        "kind": "decision",
        "content": "Flachdach gewählt",
        "confidence": "high",
        "verification": "user_confirmed",
    }
    fields.update(kwargs)
    return pm.MemorySearchHit(**fields)


async def _search(monkeypatch, client, **params):
    monkeypatch.setattr(pm, "search_memory_notes", client)
    async with project_memory_search(ProjectMemorySearchConfig(), MagicMock()) as info:
        return await info.single_fn(info.input_schema(**({"query": "Dachaufbau"} | params)))


class TestScopeIsStatedNeverChosen:
    """Contract C1, the non-negotiable half."""

    async def test_the_model_has_no_scope_argument_to_set(self, monkeypatch):
        """Not 'the BFF would refuse it' — there is nothing to send.

        The tool's input schema is what the model sees. A `scope`, a
        `project_id` or an `organization_id` on it is a way to ask across a
        tenant boundary, and the only design that cannot be asked wrong is the
        one with no field to put the question in.
        """
        _patch_context(monkeypatch)
        client = MagicMock(return_value=pm.MemorySearchResult(items=(_hit(),), total=1, returned=1))
        monkeypatch.setattr(pm, "search_memory_notes", client)
        async with project_memory_search(ProjectMemorySearchConfig(), MagicMock()) as info:
            fields = set(info.input_schema.model_fields)
        assert fields == {"query", "limit"}
        for forbidden in ("scope", "project_id", "projectId", "organization_id", "organizationId"):
            assert forbidden not in fields

    async def test_a_project_turn_sends_its_own_project_and_organization(self, monkeypatch):
        _patch_context(monkeypatch, project_id="proj-1", organization_id="org-1")
        client = MagicMock(return_value=pm.MemorySearchResult(items=(_hit(),), total=1, returned=1))
        await _search(monkeypatch, client)
        assert client.call_args.kwargs["project_id"] == "proj-1"
        assert client.call_args.kwargs["organization_id"] == "org-1"

    async def test_an_office_turn_sends_no_project_at_all(self, monkeypatch):
        """The Büro (ADR-0054): no project is what tells the endpoint to serve
        organization-scoped notes ONLY. Sending an empty string, or the last
        project this process saw, is how an office turn would read another
        project's memory."""
        _patch_context(monkeypatch, project_id=None, organization_id="org-1")
        client = MagicMock(return_value=pm.MemorySearchResult(items=(_hit(),), total=1, returned=1))
        await _search(monkeypatch, client)
        assert client.call_args.kwargs["project_id"] is None
        assert client.call_args.kwargs["organization_id"] == "org-1"

    async def test_without_an_organization_it_refuses_rather_than_searching(self, monkeypatch):
        """A scope-less search is the one thing this tool may never perform, and
        a refusal is not an empty result: "nothing found" would read as a fact
        about the project."""
        _patch_context(monkeypatch, project_id="proj-1", organization_id=None)
        client = MagicMock()
        result = await _search(monkeypatch, client)
        assert "Error" in result
        assert "Do not retry" in result
        assert not client.called


class TestTheResultSaysWhatItIs:
    async def test_it_states_the_bound_and_the_total(self, monkeypatch):
        _patch_context(monkeypatch)
        client = MagicMock(return_value=pm.MemorySearchResult(items=(_hit("m1"), _hit("m2")), total=31, returned=2))
        result = await _search(monkeypatch, client)
        assert "2 von 31" in result
        assert "BEGRENZTE Auswahl" in result
        # Memory is influence, never evidence (ADR-0026/0037): the block must
        # say so where the model reads it, not only in the tool description.
        assert "keine Belege" in result

    async def test_a_note_is_rendered_with_the_facts_a_reader_weighs_it_by(self, monkeypatch):
        _patch_context(monkeypatch)
        client = MagicMock(return_value=pm.MemorySearchResult(items=(_hit(pinned=True),), total=1, returned=1))
        result = await _search(monkeypatch, client)
        assert '- [decision | high | user_confirmed | angeheftet] "Flachdach gewählt"' in result

    async def test_a_long_note_is_cut_rather_than_shipped_whole(self, monkeypatch):
        _patch_context(monkeypatch)
        client = MagicMock(return_value=pm.MemorySearchResult(items=(_hit(content="x" * 5000),), total=1, returned=1))
        result = await _search(monkeypatch, client)
        assert len(result) < 1500

    async def test_nothing_found_says_nothing_was_found(self, monkeypatch):
        _patch_context(monkeypatch)
        client = MagicMock(return_value=pm.MemorySearchResult(items=(), total=0, returned=0))
        result = await _search(monkeypatch, client)
        assert "No note" in result
        assert "do not state a remembered fact anyway" in result

    async def test_an_unreachable_endpoint_is_a_refusal_not_an_empty_store(self, monkeypatch):
        _patch_context(monkeypatch)
        result = await _search(monkeypatch, MagicMock(return_value=None))
        assert "Error" in result
        assert "could not look it up" in result

    async def test_a_raising_client_never_takes_the_turn_down(self, monkeypatch):
        _patch_context(monkeypatch)
        result = await _search(monkeypatch, MagicMock(side_effect=RuntimeError("boom")))
        assert "Error" in result

    async def test_an_empty_query_is_refused_before_the_call(self, monkeypatch):
        _patch_context(monkeypatch)
        client = MagicMock()
        result = await _search(monkeypatch, client, query="   ")
        assert "Error" in result
        assert not client.called


class TestTheLimitIsHeldInsideTheCeiling:
    @pytest.mark.parametrize(
        ("asked", "expected"),
        [(None, 8), (3, 3), (0, 8), (-4, 8), (99, 20), (20, 20)],
    )
    async def test_a_requested_size_is_clamped(self, monkeypatch, asked, expected):
        _patch_context(monkeypatch)
        client = MagicMock(return_value=pm.MemorySearchResult(items=(_hit(),), total=1, returned=1))
        params = {} if asked is None else {"limit": asked}
        await _search(monkeypatch, client, **params)
        assert client.call_args.kwargs["limit"] == expected


class TestTheTurnLearnsWhatWasRead:
    async def test_the_notes_are_tallied_for_the_answer_marker(self, monkeypatch):
        """Contract C3's ``searched``: notes, not calls, and never twice."""
        _patch_context(monkeypatch)
        token = begin_turn_memory_reads()
        try:
            client = MagicMock(return_value=pm.MemorySearchResult(items=(_hit("m1"), _hit("m2")), total=9, returned=2))
            await _search(monkeypatch, client)
            assert turn_memory_searched() == 2
            # A second search that returns one of the same notes adds one, not two.
            client = MagicMock(return_value=pm.MemorySearchResult(items=(_hit("m2"), _hit("m3")), total=9, returned=2))
            await _search(monkeypatch, client, query="Keller")
            assert turn_memory_searched() == 3
        finally:
            end_turn_memory_reads(token)

    async def test_outside_a_turn_it_records_nothing_and_still_answers(self, monkeypatch):
        """A CLI run has no per-turn registry, and a tool that needed one would
        crash there rather than degrade."""
        _patch_context(monkeypatch)
        client = MagicMock(return_value=pm.MemorySearchResult(items=(_hit(),), total=1, returned=1))
        result = await _search(monkeypatch, client)
        assert "1 von 1" in result
        assert turn_memory_searched() == 0
