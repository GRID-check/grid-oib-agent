"""`find_projects` — the Projektregister search tool (ADR-0054).

The tool is thin on purpose: the endpoint decides what this caller may see, the
digest client decides what a failure looks like, and this layer decides what the
MODEL is told. So what is tested here is exactly that last thing — that the
result names each project with its id, that it says it is a bounded best-match
list, that a missing organisation is a refusal rather than an empty result, and
that no failure reaches the turn as an exception.
"""

import contextlib
from unittest.mock import MagicMock

from aiq_agent.agents.workspace.register import WorkspaceFindProjectsConfig
from aiq_agent.agents.workspace.register import workspace_find_projects
from aiq_agent.knowledge.workspace_digest import WorkspaceDigest
from aiq_agent.knowledge.workspace_digest import WorkspaceProject

_HITS = (
    WorkspaceProject(id="proj_1", name="Seestadt Baufeld D", steckbrief="Wohnbau, GK5, Wien", score=0.9),
    WorkspaceProject(id="proj_2", name="Volksschule Krems", steckbrief="Bildungsbau, NÖ", score=0.4),
)


@contextlib.asynccontextmanager
async def _tool(monkeypatch, *, organization="org_1", membership="om_1", digest=None, raises=None, config=None):
    """Enter the NAT registration with the register endpoint stubbed.

    Yields ``(info, captured)``: the ``FunctionInfo`` NAT would bind, and what
    the stubbed endpoint was asked for.
    """
    import aiq_agent.project_context as pc
    from aiq_agent.knowledge import workspace_digest as wd

    monkeypatch.setattr(pc, "get_organization_id_from_context", lambda: organization)
    monkeypatch.setattr(pc, "get_organization_membership_id_from_context", lambda: membership)

    captured: dict = {}

    def _fetch(*, organization_id, membership_id, query, limit):
        captured.update(organization_id=organization_id, membership_id=membership_id, query=query, limit=limit)
        if raises is not None:
            raise raises
        return digest

    monkeypatch.setattr(wd, "fetch_workspace_digest", _fetch)

    async with workspace_find_projects(config or WorkspaceFindProjectsConfig(), MagicMock()) as info:
        yield info, captured


async def test_it_names_every_hit_with_its_id_and_bounds_the_claim(monkeypatch):
    async with _tool(monkeypatch, digest=WorkspaceDigest(digest="d", projects=_HITS)) as (info, captured):
        result = await info.single_fn("Wohnbau GK5 Holzbau")

    assert "Seestadt Baufeld D" in result and "proj_1" in result
    assert "Volksschule Krems" in result and "proj_2" in result
    # The two things a register hit must carry into the answer: it is bounded,
    # and it is not document content (spec PR-14/PR-15).
    assert "bounded best-match list" in result
    assert "no document content" in result
    # The caller's identity is what the endpoint filters on — not the tool's.
    assert captured["organization_id"] == "org_1"
    assert captured["membership_id"] == "om_1"
    assert captured["query"] == "Wohnbau GK5 Holzbau"


async def test_the_result_is_bounded_by_the_configured_maximum(monkeypatch):
    many = tuple(WorkspaceProject(id=f"p{i}", name=f"Projekt {i}", steckbrief="s") for i in range(5))
    config = WorkspaceFindProjectsConfig(max_results=2)
    async with _tool(monkeypatch, digest=WorkspaceDigest(projects=many), config=config) as (info, captured):
        result = await info.single_fn("alles")

    assert captured["limit"] == 2
    assert "Projekt 0" in result and "Projekt 1" in result
    assert "Projekt 2" not in result


async def test_without_an_organisation_it_refuses_instead_of_answering_empty(monkeypatch):
    """PR-17: the register never crosses the organisation boundary, and "no
    projects found" would read as a fact about an office we cannot see."""
    async with _tool(monkeypatch, organization=None, digest=WorkspaceDigest(projects=_HITS)) as (info, captured):
        result = await info.single_fn("Wohnbau")

    assert result.startswith("Error:")
    assert "organisation" in result
    assert captured == {}, "it must not call the endpoint without an organisation"


async def test_an_empty_query_is_refused_without_a_round_trip(monkeypatch):
    async with _tool(monkeypatch, digest=WorkspaceDigest(projects=_HITS)) as (info, captured):
        result = await info.single_fn("   ")

    assert result.startswith("Error:")
    assert captured == {}


async def test_no_match_says_nothing_was_found_and_forbids_naming_one(monkeypatch):
    async with _tool(monkeypatch, digest=WorkspaceDigest(digest="d", projects=())) as (info, _captured):
        result = await info.single_fn("Krankenhaus in Tirol")

    assert "No project" in result
    assert "do not name a project anyway" in result


async def test_an_unreachable_register_returns_a_string_not_an_exception(monkeypatch):
    """The digest client already fails open to None; this is what the model is
    told when it does."""
    async with _tool(monkeypatch, digest=None) as (info, _captured):
        result = await info.single_fn("Wohnbau")

    assert result.startswith("Error:")
    assert "temporarily unavailable" in result


async def test_a_raising_endpoint_never_reaches_the_turn(monkeypatch):
    """A tool that raises takes the turn down with it, so the fail-open of the
    client is not the tool's only line: an unexpected exception comes back as
    the same honest string."""
    async with _tool(monkeypatch, raises=RuntimeError("boom")) as (info, _captured):
        result = await info.single_fn("Wohnbau")

    assert result.startswith("Error:")
    assert "temporarily unavailable" in result


async def test_the_description_tells_the_model_what_a_register_hit_licenses(monkeypatch):
    async with _tool(monkeypatch, digest=WorkspaceDigest(projects=_HITS)) as (info, _captured):
        description = info.description

    # The description is the only thing the model reads before deciding to call
    # this, so the PR-15 boundary has to be in it, not only in the result.
    assert "NO document content" in description
    assert "Projektregister" in description
