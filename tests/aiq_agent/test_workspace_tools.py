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
from aiq_agent.agents.workspace.register import WorkspaceOpenProjectConfig
from aiq_agent.agents.workspace.register import workspace_find_projects
from aiq_agent.agents.workspace.register import workspace_open_project
from aiq_agent.knowledge.mounts import REFUSAL_CAP
from aiq_agent.knowledge.mounts import REFUSAL_NO_ACCESS
from aiq_agent.knowledge.mounts import REFUSAL_NOT_FOUND
from aiq_agent.knowledge.mounts import REFUSAL_UNAVAILABLE
from aiq_agent.knowledge.mounts import REFUSAL_WOULD_EXCLUDE
from aiq_agent.knowledge.mounts import MountGranted
from aiq_agent.knowledge.mounts import MountRefused
from aiq_agent.knowledge.workspace_digest import RECALL_MAX_LIMIT
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


async def _search(info, query: str, limit: int | None = None) -> str:
    """One `find_projects` call, through the schema NAT binds the tool by.

    The tool takes two arguments now (`limit` joined `query`), so NAT wraps it
    in a generated input model instead of passing the query positionally — the
    same convention `info.single_fn(info.input_schema(...))` follows everywhere
    a tool has more than one.
    """
    return await info.single_fn(info.input_schema(query=query, limit=limit))


async def test_it_names_every_hit_with_its_id_and_bounds_the_claim(monkeypatch):
    async with _tool(monkeypatch, digest=WorkspaceDigest(digest="d", projects=_HITS)) as (info, captured):
        result = await _search(info, "Wohnbau GK5 Holzbau")

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
        result = await _search(info, "alles")

    assert captured["limit"] == 2
    assert "Projekt 0" in result and "Projekt 1" in result
    assert "Projekt 2" not in result


async def test_the_model_may_ask_for_more_when_it_has_to_enumerate_a_set(monkeypatch):
    """Spec DR-3: a portfolio question is handed over with the projects NAMED,
    so the tool has to be able to name more than the five an ordinary lookup
    shows. The number reaches the endpoint, and every project it returns is in
    the block."""
    many = tuple(WorkspaceProject(id=f"p{i}", name=f"Projekt {i}", steckbrief="s") for i in range(8))
    async with _tool(monkeypatch, digest=WorkspaceDigest(projects=many)) as (info, captured):
        result = await _search(info, "alle Projekte in Wien", limit=8)

    assert captured["limit"] == 8
    assert all(f"Projekt {i}" in result for i in range(8))


async def test_a_limit_above_the_endpoints_ceiling_is_clamped_not_promised(monkeypatch):
    """Asking for more than the register can serve returns the ceiling anyway,
    so the request is clamped rather than passed on — a block that claimed 40
    would be claiming a completeness it never had."""
    async with _tool(monkeypatch, digest=WorkspaceDigest(projects=_HITS)) as (info, captured):
        result = await _search(info, "alles", limit=40)

    assert captured["limit"] == RECALL_MAX_LIMIT
    assert f"at most {RECALL_MAX_LIMIT}" in result


async def test_no_limit_keeps_the_configured_default(monkeypatch):
    async with _tool(monkeypatch, digest=WorkspaceDigest(projects=_HITS)) as (info, captured):
        await _search(info, "alles")

    assert captured["limit"] == WorkspaceFindProjectsConfig().max_results


async def test_a_limit_that_is_not_a_size_falls_back_to_the_default(monkeypatch):
    """Zero and a negative are the model saying nothing in particular, and the
    ordinary lookup is what nothing in particular means. Reading them as "one"
    would answer a question about a SET with a single Steckbrief — the one
    failure DR-3 exists to prevent, arrived at by arithmetic."""
    for garbage in (0, -3):
        async with _tool(monkeypatch, digest=WorkspaceDigest(projects=_HITS)) as (info, captured):
            result = await _search(info, "alle Projekte in Wien", limit=garbage)

        assert captured["limit"] == WorkspaceFindProjectsConfig().max_results, garbage
        assert "Seestadt Baufeld D" in result


async def test_without_an_organisation_it_refuses_instead_of_answering_empty(monkeypatch):
    """PR-17: the register never crosses the organisation boundary, and "no
    projects found" would read as a fact about an office we cannot see."""
    async with _tool(monkeypatch, organization=None, digest=WorkspaceDigest(projects=_HITS)) as (info, captured):
        result = await _search(info, "Wohnbau")

    assert result.startswith("Error:")
    assert "organisation" in result
    assert captured == {}, "it must not call the endpoint without an organisation"


async def test_an_empty_query_is_refused_without_a_round_trip(monkeypatch):
    async with _tool(monkeypatch, digest=WorkspaceDigest(projects=_HITS)) as (info, captured):
        result = await _search(info, "   ")

    assert result.startswith("Error:")
    assert captured == {}


async def test_no_match_says_nothing_was_found_and_forbids_naming_one(monkeypatch):
    async with _tool(monkeypatch, digest=WorkspaceDigest(digest="d", projects=())) as (info, _captured):
        result = await _search(info, "Krankenhaus in Tirol")

    assert "No project" in result
    assert "do not name a project anyway" in result


async def test_an_unreachable_register_returns_a_string_not_an_exception(monkeypatch):
    """The digest client already fails open to None; this is what the model is
    told when it does."""
    async with _tool(monkeypatch, digest=None) as (info, _captured):
        result = await _search(info, "Wohnbau")

    assert result.startswith("Error:")
    assert "temporarily unavailable" in result


async def test_a_raising_endpoint_never_reaches_the_turn(monkeypatch):
    """A tool that raises takes the turn down with it, so the fail-open of the
    client is not the tool's only line: an unexpected exception comes back as
    the same honest string."""
    async with _tool(monkeypatch, raises=RuntimeError("boom")) as (info, _captured):
        result = await _search(info, "Wohnbau")

    assert result.startswith("Error:")
    assert "temporarily unavailable" in result


async def test_the_description_tells_the_model_what_a_register_hit_licenses(monkeypatch):
    async with _tool(monkeypatch, digest=WorkspaceDigest(projects=_HITS)) as (info, _captured):
        description = info.description

    # The description is the only thing the model reads before deciding to call
    # this, so the PR-15 boundary has to be in it, not only in the result.
    assert "NO document content" in description
    assert "Projektregister" in description


# ---------------------------------------------------------------------------
# `open_project` — bringing one project into view (ADR-0054, spec MT-*)
# ---------------------------------------------------------------------------


@contextlib.asynccontextmanager
async def _open_tool(
    monkeypatch,
    *,
    organization="org_1",
    conversation="conv_1",
    outcome=None,
    raises=None,
    grant_verifies=True,
):
    """Enter the mounting tool with the mounts endpoint stubbed.

    Yields ``(info, captured)``. The GRANT is separately stubbed: what this tool
    owes the turn is the prose and the event line, and whether a signature holds
    is `knowledge/mounts.py`'s question (`tests/aiq_agent/test_mount_grants.py`).
    """
    import aiq_agent.project_context as pc
    from aiq_agent.knowledge import mounts

    class _Ctx:
        organization_id = organization
        user_id = "user_1"
        organization_membership_id = "om_1"

        @classmethod
        def from_context(cls):
            return cls()

    monkeypatch.setattr(pc, "GridRequestContext", _Ctx)
    monkeypatch.setattr(pc, "get_conversation_id_from_context", lambda: conversation)

    captured: dict = {}

    def _request_mount(**kwargs):
        captured.update(kwargs)
        if raises is not None:
            raise raises
        return outcome

    monkeypatch.setattr(mounts, "request_mount", _request_mount)
    # Bound at REGISTRATION (the tool imports it once), so both stubs have to be
    # in place before the async with — which is the tool's own shape, not a
    # convenience of this fixture.
    monkeypatch.setattr(mounts, "register_mount_grant", lambda grant, sig: object() if grant_verifies else None)

    async with workspace_open_project(WorkspaceOpenProjectConfig(), MagicMock()) as info:
        yield info, captured


def _event(result: str) -> dict:
    """The first line of a tool result: the JSON the UI's MountNotice reads."""
    import json

    head, _, _prose = result.partition("\n\n")
    return json.loads(head)


async def test_a_successful_mount_says_the_project_is_now_in_view(monkeypatch):
    granted = MountGranted(project_id="proj-uuid-1", project_name="Seestadt Baufeld D", grant="g", sig="s")
    async with _open_tool(monkeypatch, outcome=granted) as (info, captured):
        result = await info.single_fn("proj-uuid-1")

    assert "Seestadt Baufeld D ist jetzt eingeblendet" in result
    # The tool asks AS THE USER; the endpoint decides (spec MT-3).
    assert captured["user_id"] == "user_1"
    assert captured["membership_id"] == "om_1"
    assert captured["conversation_id"] == "conv_1"
    assert captured["organization_id"] == "org_1"
    assert _event(result) == {
        "event": "mount",
        "status": "mounted",
        "projectId": "proj-uuid-1",
        "projectName": "Seestadt Baufeld D",
        "mountedBy": "agent",
    }


async def test_the_cap_refusal_names_the_cap_and_offers_deep_research(monkeypatch):
    """MT-9: the agent must say plainly that the question exceeds what it can
    read live, and offer the one path that reads more (spec DR-3)."""
    refusal = MountRefused(REFUSAL_CAP, cap=5, mounted=("Seestadt", "Krems"))
    async with _open_tool(monkeypatch, outcome=refusal) as (info, _captured):
        result = await info.single_fn("proj-uuid-9")

    assert "5 Projekte" in result
    assert "Seestadt" in result and "Krems" in result
    assert "vertiefte Recherche" in result
    # And it must not tidy up on its own initiative.
    assert "Blende nichts von dir aus aus" in result
    event = _event(result)
    assert event["status"] == "refused" and event["code"] == REFUSAL_CAP and event["cap"] == 5


async def test_a_refused_project_is_never_paraphrased_as_existing(monkeypatch):
    """MT-4: a refusal is indistinguishable from the project not existing, so
    neither branch may license a claim about the project."""
    async with _open_tool(monkeypatch, outcome=MountRefused(REFUSAL_NO_ACCESS)) as (info, _captured):
        no_access = await info.single_fn("proj-uuid-9")
    async with _open_tool(monkeypatch, outcome=MountRefused(REFUSAL_NOT_FOUND)) as (info, _captured):
        not_found = await info.single_fn("proj-uuid-9")

    assert "nicht eingeblendet" in no_access
    assert "erfinden oder aus dem Steckbrief ableiten" in no_access
    assert "behaupte nicht, dass es das Projekt nicht gibt" in not_found
    assert _event(no_access)["code"] == REFUSAL_NO_ACCESS
    assert _event(not_found)["code"] == REFUSAL_NOT_FOUND


async def test_without_a_conversation_or_an_organisation_it_refuses_without_a_round_trip(monkeypatch):
    async with _open_tool(monkeypatch, organization=None) as (info, captured):
        result = await info.single_fn("proj-uuid-1")
    assert "keinem Büro" in result and captured == {}

    async with _open_tool(monkeypatch, conversation=None) as (info, captured):
        result = await info.single_fn("proj-uuid-1")
    assert "nicht möglich" in result and captured == {}


async def test_a_raising_endpoint_never_reaches_the_turn_as_an_exception(monkeypatch):
    async with _open_tool(monkeypatch, raises=RuntimeError("boom")) as (info, _captured):
        result = await info.single_fn("proj-uuid-1")

    assert _event(result)["code"] == REFUSAL_UNAVAILABLE
    assert "vorübergehend" in result


async def test_a_grant_that_does_not_verify_still_reports_the_mount_and_says_this_turn_is_blind(monkeypatch):
    """The mount ROW exists — the office wrote it — so the UI must show it and
    the next turn will carry it on the scope header. Only THIS turn cannot read
    it, and searching anyway would answer from the office corpus while claiming
    the project."""
    granted = MountGranted(project_id="proj-uuid-1", project_name="Seestadt", grant="g", sig="bad")
    async with _open_tool(monkeypatch, outcome=granted, grant_verifies=False) as (info, _captured):
        result = await info.single_fn("proj-uuid-1")

    assert _event(result)["status"] == "mounted"
    assert "erst ab der nächsten Frage lesbar" in result


async def test_the_description_tells_the_model_to_mount_before_it_searches(monkeypatch):
    async with _open_tool(monkeypatch, outcome=MountRefused(REFUSAL_UNAVAILABLE)) as (info, _captured):
        description = info.description

    assert "BEFORE searching" in description
    assert "never a name" in description


async def test_a_shared_conversation_that_would_exclude_someone_says_who(monkeypatch):
    """AC-8: the mounted set belongs to the conversation (MT-14), so a project a
    participant may not read cannot be mounted into a shared thread. That is not
    the cap — nothing is in the way and unmounting would not help — so it must
    not be reported as one."""
    refusal = MountRefused(REFUSAL_WOULD_EXCLUDE, excluded=("Anna Meier", "Bernd Huber"))
    async with _open_tool(monkeypatch, outcome=refusal) as (info, _captured):
        result = await info.single_fn("proj-uuid-9")

    assert "Anna Meier" in result and "Bernd Huber" in result
    assert "geteilt" in result
    assert "Freigabe dieser Unterhaltung" in result
    event = _event(result)
    assert event["code"] == REFUSAL_WOULD_EXCLUDE
    assert event["excluded"] == ["Anna Meier", "Bernd Huber"]
    # Explicitly not the cap: the notice must not render a limit nobody hit.
    assert event["cap"] is None
