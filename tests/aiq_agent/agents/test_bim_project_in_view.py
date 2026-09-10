"""The building-model tools take their project explicitly (ADR-0054, spec AG-10).

`ifc_query` and `ifc_measure` used to read the project off the request context
and refuse without one. In the office there is none — and there may be several,
because a Büro conversation can hold up to five mounted projects — so "the
project of this turn" stopped being an answerable question. Both tools now take
an explicit `project_id`, and one resolver decides it for both.

What is checked here is the decision, not the plumbing behind it:

* a project chat is unchanged — no argument, and the turn's own project is read;
* a project that is IN VIEW proceeds to the existing path, addressed by the id
  the model named;
* a project that is NOT in view is refused before any network call, and the
  refusal names the projects that are, because a bare "no" produces a retry with
  the same id and spends the turn;
* an office call that names nothing is asked which project it means, rather than
  being answered from whichever project happens to be first.

The backend is stubbed the way the other BIM tool tests stub it: nothing here
stands up a model service, and a test that reached one would be testing the BFF.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from aiq_agent.agents.bim.register import IfcQueryConfig
from aiq_agent.agents.bim.register import ifc_query
from aiq_agent.agents.bim.register import resolve_tool_project
from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.scoping import ScopedCollection

#: The scope of an office turn that has brought one project into view: base,
#: the office Archiv, and the mounted project carrying its identity (ADR-0047 +
#: ADR-0054). This is the shape the BFF signs and `open_project` grants.
OFFICE_SCOPE = [
    ScopedCollection("oib_knowledge", Shelf.BASE),
    ScopedCollection("archiv_org_1", Shelf.ARCHIV),
    ScopedCollection("proj_seestadt", Shelf.PROJECT, project_id="proj-uuid-1", project_name="Seestadt Baufeld D"),
]


def _in_view(monkeypatch, entries: list | None) -> None:
    """Bind what this turn may read, at the seam `mounted_projects` reads it from.

    `knowledge.scoping.get_scoped_collections_from_context` is the union of the
    signed scope header and the mounts this turn earned, so binding it here
    covers both ways a project reaches a turn.
    """
    from aiq_agent.knowledge import scoping

    monkeypatch.setattr(scoping, "get_scoped_collections_from_context", lambda: entries)


def _context(monkeypatch, *, organization="org_1", project=None) -> None:
    import aiq_agent.project_context as pc

    monkeypatch.setattr(pc, "get_organization_id_from_context", lambda: organization)
    monkeypatch.setattr(pc, "get_project_id_from_context", lambda: project)


class TestTheResolver:
    """One decision, tested where it is made rather than through two tools."""

    def test_a_project_chat_needs_no_argument(self, monkeypatch):
        _in_view(monkeypatch, None)
        assert resolve_tool_project("", "p1") == ("p1", None)

    def test_a_project_chat_may_name_its_own_project(self, monkeypatch):
        """Without this the ordinary case would depend on the scope entry
        carrying a project identity, which a producer predating ADR-0054 does
        not send — and naming your own project would be refused."""
        _in_view(monkeypatch, None)
        assert resolve_tool_project("p1", "p1") == ("p1", None)

    def test_a_mounted_project_is_addressable_in_the_office(self, monkeypatch):
        _in_view(monkeypatch, OFFICE_SCOPE)
        assert resolve_tool_project("proj-uuid-1", None) == ("proj-uuid-1", None)

    def test_an_unmounted_project_is_refused_and_the_mounted_ones_are_named(self, monkeypatch):
        _in_view(monkeypatch, OFFICE_SCOPE)

        project_id, refusal = resolve_tool_project("proj-uuid-9", None)

        assert project_id is None
        assert "proj-uuid-9" in refusal
        # The recoverable next move, named: either one of these, or bring the
        # requested project in.
        assert "Seestadt Baufeld D" in refusal and "proj-uuid-1" in refusal
        assert "open_project" in refusal
        assert "Do not repeat this call with the same id" in refusal

    def test_a_project_chat_is_refused_a_project_it_has_not_mounted(self, monkeypatch):
        """The rule is about what the TURN can read, not about which surface it
        is: a project chat that names some other project may not read it either."""
        _in_view(monkeypatch, None)

        project_id, refusal = resolve_tool_project("proj-uuid-9", "p1")

        assert project_id is None
        assert "not in view" in refusal

    def test_an_office_call_naming_nothing_is_asked_which_project(self, monkeypatch):
        _in_view(monkeypatch, OFFICE_SCOPE)

        project_id, refusal = resolve_tool_project("", None)

        assert project_id is None
        assert "Seestadt Baufeld D" in refusal
        # Fixable by calling again, so it must NOT carry the do-not-retry text
        # that the genuinely unfixable case carries.
        assert "Do not retry" not in refusal

    def test_a_turn_with_nothing_in_view_gets_the_unfixable_refusal(self, monkeypatch):
        from aiq_agent.agents.bim.register import NO_PROJECT_TEXT

        _in_view(monkeypatch, None)

        assert resolve_tool_project("", None) == (None, NO_PROJECT_TEXT)

    def test_a_scope_entry_without_a_project_identity_names_no_project(self, monkeypatch):
        """A project-shelf entry from a producer that predates the identity
        fields carries no id, and the collection name is authorization rather
        than identity — so it must not be guessed back into one."""
        _in_view(monkeypatch, [ScopedCollection("proj_legacy", Shelf.PROJECT)])

        project_id, refusal = resolve_tool_project("proj_legacy", None)

        assert project_id is None
        assert "no project is" in refusal


class TestIfcQueryAddressesTheProjectItWasGiven:
    @staticmethod
    async def _call(monkeypatch, **kwargs) -> tuple[str, dict]:
        """Run `ifc_query` with the BIM endpoint stubbed; return (result, call)."""
        from aiq_agent.knowledge import bim_query

        seen: dict = {}

        def _run(**call_kwargs):
            seen.update(call_kwargs)
            return {"summary": "Ein Gebäude.", "op": "overview"}

        monkeypatch.setattr(bim_query, "run_bim_query", _run)
        async with ifc_query(IfcQueryConfig(), MagicMock()) as info:
            return await info.single_fn(info.input_schema(**kwargs)), seen

    @pytest.mark.asyncio
    async def test_a_mounted_project_proceeds_to_the_existing_path(self, monkeypatch):
        _context(monkeypatch, project=None)
        _in_view(monkeypatch, OFFICE_SCOPE)

        result, call = await self._call(monkeypatch, operation="overview", project_id="proj-uuid-1")

        assert not result.startswith("Error:")
        assert call["project_id"] == "proj-uuid-1"
        assert call["organization_id"] == "org_1"

    @pytest.mark.asyncio
    async def test_an_unmounted_project_never_reaches_the_endpoint(self, monkeypatch):
        _context(monkeypatch, project=None)
        _in_view(monkeypatch, OFFICE_SCOPE)

        result, call = await self._call(monkeypatch, operation="overview", project_id="proj-uuid-9")

        assert result.startswith("Error:")
        assert call == {}, "a project not in view must be refused before the network"

    @pytest.mark.asyncio
    async def test_a_project_turn_is_unchanged(self, monkeypatch):
        _context(monkeypatch, project="p1")
        _in_view(monkeypatch, None)

        result, call = await self._call(monkeypatch, operation="overview")

        assert not result.startswith("Error:")
        assert call["project_id"] == "p1"


class TestIfcMeasureAddressesTheProjectItWasGiven:
    @staticmethod
    async def _call(monkeypatch, **kwargs) -> tuple[object, dict]:
        """Run `ifc_measure` with the spatial engine stubbed at its resolver."""
        from aiq_agent.agents.bim.measure_register import IfcMeasureConfig
        from aiq_agent.agents.bim.measure_register import ifc_measure
        from aiq_agent.knowledge import ifc_spatial_client

        seen: dict = {}

        def _resolve_model_source(**call_kwargs):
            seen.update(call_kwargs)
            # "Resolved nothing" is a legitimate answer the tool renders; it is
            # enough to prove the call was addressed at the right project.
            return {"resolved": False, "reason": "no_model"}

        monkeypatch.setattr(ifc_spatial_client, "resolve_model_source", _resolve_model_source)
        async with ifc_measure(IfcMeasureConfig(), MagicMock()) as info:
            return await info.single_fn(info.input_schema(**kwargs)), seen

    @pytest.mark.asyncio
    async def test_a_mounted_project_proceeds_to_the_existing_path(self, monkeypatch):
        _context(monkeypatch, project=None)
        _in_view(monkeypatch, OFFICE_SCOPE)

        _result, call = await self._call(monkeypatch, operation="briefing", project_id="proj-uuid-1")

        assert call["project_id"] == "proj-uuid-1"

    @pytest.mark.asyncio
    async def test_an_unmounted_project_never_reaches_the_engine(self, monkeypatch):
        _context(monkeypatch, project=None)
        _in_view(monkeypatch, OFFICE_SCOPE)

        result, call = await self._call(monkeypatch, operation="briefing", project_id="proj-uuid-9")

        assert isinstance(result, str) and result.startswith("Error:")
        assert call == {}

    @pytest.mark.asyncio
    async def test_a_project_turn_is_unchanged(self, monkeypatch):
        _context(monkeypatch, project="p1")
        _in_view(monkeypatch, None)

        _result, call = await self._call(monkeypatch, operation="briefing")

        assert call["project_id"] == "p1"
