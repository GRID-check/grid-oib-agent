"""A deep run started from the Büro reads the office, not a project (ADR-0054).

Module under test: ``aiq_api.jobs.runner`` — ``_collection_scope_header``,
``_resolve_run_context`` and the ``_run_agent`` state build.

Three things have to hold for spec DR-1/DR-2, and each of them is a place where
a Büro escalation could quietly become something else:

* every mounted collection is replayed WITH its project identity, so the report
  attributes a passage the way the conversation did;
* no project identity travels beside it, so `remember` stays unavailable to the
  run by the tool-context contract rather than by prompt instruction;
* the run's turn-start context is the workspace digest, fetched the way project
  memory is fetched, and composed into the one field the prompts read.
"""

from __future__ import annotations

import base64
import json

import pytest

from aiq_agent.knowledge.workspace_digest import WorkspaceDigest
from aiq_agent.knowledge.workspace_digest import WorkspaceProject
from aiq_api.jobs.runner import COLLECTION_SCOPE_HEADER
from aiq_api.jobs.runner import _collection_scope_header
from aiq_api.jobs.runner import _resolve_run_context
from aiq_api.jobs.submit import _derive_project_collection

#: The scope a Büro turn with two mounted projects hands to its escalation, in
#: the shape `knowledge/scoping.scope_entries_to_wire` produces.
WORKSPACE_SCOPE = [
    {"collection": "oib_knowledge", "shelf": "base"},
    {"collection": "archiv_org_1", "shelf": "archiv"},
    {
        "collection": "proj_seestadt",
        "shelf": "project",
        "projectId": "proj-uuid-1",
        "projectName": "Seestadt Baufeld D",
    },
    {
        "collection": "proj_krems",
        "shelf": "project",
        "projectId": "proj-uuid-2",
        "projectName": "Volksschule Krems",
    },
]


def _decode(header: str) -> list:
    padded = header + "=" * (-len(header) % 4)
    return json.loads(base64.urlsafe_b64decode(padded.encode()).decode())


class TestTheMountedSetIsReplayed:
    def test_every_mount_reaches_the_worker_with_its_project_identity(self):
        replayed = _decode(_collection_scope_header(WORKSPACE_SCOPE))

        assert replayed == WORKSPACE_SCOPE

    def test_the_agent_reads_it_back_as_the_scope_it_was(self, monkeypatch):
        """The header is only worth what the scope parser gets out of it, so the
        contract is checked end to end rather than on the encoding alone."""
        from unittest.mock import MagicMock

        from aiq_agent.common.source_kinds import Shelf
        from aiq_agent.knowledge.scoping import get_scoped_collections_from_context

        headers = {COLLECTION_SCOPE_HEADER: _collection_scope_header(WORKSPACE_SCOPE)}
        ctx = MagicMock()
        # Read back through the header NAME the runner writes, so a rename on
        # either side fails here rather than in a silently unscoped run.
        ctx.metadata.headers.get.side_effect = lambda name, default=None: headers.get(name, default)
        monkeypatch.setattr("aiq_agent.knowledge.scoping.Context.get", lambda: ctx)

        entries = get_scoped_collections_from_context()

        assert [entry.collection for entry in entries] == [
            "oib_knowledge",
            "archiv_org_1",
            "proj_seestadt",
            "proj_krems",
        ]
        mounted = [entry for entry in entries if entry.shelf is Shelf.PROJECT]
        assert [(entry.project_id, entry.project_name) for entry in mounted] == [
            ("proj-uuid-1", "Seestadt Baufeld D"),
            ("proj-uuid-2", "Volksschule Krems"),
        ]

    def test_a_bare_name_scope_still_replays_unchanged(self):
        """Scheduled runs and every pre-ADR-0047 caller pass names; the runner
        rewrites nothing (the BFF is the naming authority, ADR-0006)."""
        assert _decode(_collection_scope_header(["oib_knowledge", "s_conv1"])) == ["oib_knowledge", "s_conv1"]

    def test_a_workspace_run_is_filed_under_no_project(self):
        """DR-2: a Büro run has no single project identity, so nothing derives
        one from the several projects it happens to read."""
        assert _derive_project_collection(WORKSPACE_SCOPE) is None

    def test_a_project_run_is_still_filed_under_its_project(self):
        project_scope = [
            {"collection": "oib_knowledge", "shelf": "base"},
            {"collection": "archiv_org_1", "shelf": "archiv"},
            {"collection": "proj_seestadt", "shelf": "project", "projectId": "proj-uuid-1"},
            {"collection": "s_conv1", "shelf": "session"},
        ]

        assert _derive_project_collection(project_scope) == "proj_seestadt"


class TestTheWorkerFetchesTheOfficesDigest:
    RECALL = WorkspaceDigest(
        digest="ORG_MEMORY v1\n- Das Büro plant überwiegend Wohnbau",
        projects=(WorkspaceProject(id="proj-uuid-1", name="Seestadt Baufeld D", steckbrief="Wohnbau, GK5"),),
    )

    def _stub(self, monkeypatch, *, recall=None, raises=None):
        from aiq_agent.knowledge import workspace_digest as wd

        captured: dict = {}

        def _fetch(*, organization_id, membership_id, query, limit=5):
            captured.update(organization_id=organization_id, membership_id=membership_id, query=query)
            if raises is not None:
                raise raises
            return recall

        monkeypatch.setattr(wd, "fetch_workspace_digest", _fetch)
        return captured

    async def test_an_office_run_reads_the_workspace_digest(self, monkeypatch):
        captured = self._stub(monkeypatch, recall=self.RECALL)

        memory_digest, workspace_context = await _resolve_run_context(
            identity={
                "organization_id": "org_1",
                "project_id": None,
                "organization_membership_id": "om_1",
            },
            project_memory="frozen digest from submit time",
            query="Wo haben wir GK5 in Holzbau gemacht?",
            job_id="job-1",
        )

        # Readability is keyed on the MEMBERSHIP (ADR-0038), so it has to travel
        # with the identity or the register comes back empty.
        assert captured == {
            "organization_id": "org_1",
            "membership_id": "om_1",
            "query": "Wo haben wir GK5 in Holzbau gemacht?",
        }
        assert workspace_context is not None
        assert "Diese Unterhaltung läuft im Büro" in workspace_context
        assert "Seestadt Baufeld D" in workspace_context
        # A successful fetch is authoritative: the submit-time digest is dropped.
        assert memory_digest == self.RECALL.digest

    async def test_a_failed_office_fetch_still_says_it_is_the_office(self, monkeypatch):
        self._stub(monkeypatch, recall=None)

        memory_digest, workspace_context = await _resolve_run_context(
            identity={"organization_id": "org_1", "project_id": None, "organization_membership_id": "om_1"},
            project_memory="frozen digest from submit time",
            query="x",
            job_id="job-1",
        )

        assert "Projektregister war für diese Frage nicht erreichbar" in workspace_context
        assert memory_digest == "frozen digest from submit time"

    async def test_a_raising_fetch_never_takes_the_run_down(self, monkeypatch):
        self._stub(monkeypatch, raises=RuntimeError("boom"))

        memory_digest, workspace_context = await _resolve_run_context(
            identity={"organization_id": "org_1", "project_id": None, "organization_membership_id": "om_1"},
            project_memory="frozen",
            query="x",
            job_id="job-1",
        )

        assert workspace_context is None
        assert memory_digest == "frozen"

    async def test_a_project_run_still_reads_project_memory(self, monkeypatch):
        from aiq_agent.knowledge import project_memory as pm

        called: dict = {}

        def _fetch(*, project_id, organization_id, query):
            called.update(project_id=project_id, organization_id=organization_id)
            return "PROJECT_MEMORY v1\n- Atrium ist OIB 2.3"

        monkeypatch.setattr(pm, "fetch_memory_digest", _fetch)

        memory_digest, workspace_context = await _resolve_run_context(
            identity={"organization_id": "org_1", "project_id": "proj-uuid-1"},
            project_memory="frozen",
            query="x",
            job_id="job-1",
        )

        assert called == {"project_id": "proj-uuid-1", "organization_id": "org_1"}
        assert memory_digest.startswith("PROJECT_MEMORY v1")
        assert workspace_context is None

    async def test_an_anonymous_run_fetches_nothing(self, monkeypatch):
        memory_digest, workspace_context = await _resolve_run_context(
            identity={},
            project_memory="frozen",
            query="x",
            job_id="job-1",
        )

        assert (memory_digest, workspace_context) == ("frozen", None)


class TestTheOfficeShapeReachesTheAgentState:
    """The composed block rides ``project_context`` (what the prompts read) and
    ``workspace_context`` is the flag that says which shape it is — a field the
    state must DECLARE, or the runner's injection is dropped in silence."""

    def test_the_deep_state_declares_the_workspace_field(self):
        from aiq_agent.agents.deep_researcher.models.state import DeepResearchAgentState

        assert "workspace_context" in DeepResearchAgentState.model_fields

    async def test_run_agent_sets_both_fields_on_the_state(self):
        from aiq_api.jobs.runner import _run_agent

        class _Monitor:
            is_cancelled = False

            def start(self) -> None: ...

            def stop(self) -> None: ...

        from aiq_agent.agents.deep_researcher.models.state import DeepResearchAgentState

        seen: dict = {}

        class _Agent:
            async def run(self, state):
                seen["project_context"] = state.project_context
                seen["workspace_context"] = state.workspace_context
                return "# Bericht"

            @staticmethod
            def _state_cls():
                return DeepResearchAgentState

        agent = _Agent()
        # `_get_agent_state_class` resolves by naming convention; hand it the
        # class directly through the module the agent claims to come from.
        agent.__class__.__module__ = DeepResearchAgentState.__module__.replace(".models.state", ".agent")
        agent.__class__.__name__ = "DeepResearcherAgent"

        block = "WORKSPACE_CONTEXT v1\n\nDiese Unterhaltung läuft im Büro, nicht in einem Projekt."
        await _run_agent(
            agent=agent,
            input_text="Wo haben wir GK5 gemacht?",
            monitor=_Monitor(),
            project_context=block,
            workspace_context=block,
        )

        assert seen == {"project_context": block, "workspace_context": block}


@pytest.mark.parametrize("scope", [None, []])
def test_no_scope_derives_no_project(scope):
    assert _derive_project_collection(scope) is None
