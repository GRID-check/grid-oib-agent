"""A Portfolio-Recherche as the job runner runs it (ADR-0054, spec DR-4…DR-8).

Module under test: ``aiq_api.jobs.runner`` — ``_is_office_run`` and
``_run_portfolio_job``, the loop that turns one deep-research job into one
bounded sub-run per project and one report.

The three properties that make the difference between a portfolio run and an
expensive way to lose a night's work, each checked here because each of them
fails silently:

* **the budget is divided, not spent first-come** — a run whose first project
  takes the whole ceiling produces one thorough section and nine stubs, and
  looks like a complete report;
* **a project that errors is a line in the report** — the alternative is that
  project seven's retrieval failure discards the six that already succeeded;
* **a project the caller may not read is skipped AND NAMED** — silence there
  reads as "we looked and found nothing", which is a different and much worse
  answer than "we never looked".

The scope narrowing is checked with them, because it is what makes a section's
citations belong to the project the section is about (spec DR-6).
"""

from __future__ import annotations

import base64
import json

import pytest
from starlette.datastructures import Headers

from aiq_agent.knowledge.workspace_digest import WorkspaceDigest
from aiq_agent.knowledge.workspace_digest import WorkspaceProject
from aiq_api.jobs.phase_events import PHASE_PORTFOLIO_PROJECT_STARTED
from aiq_api.jobs.phase_events import PHASE_PORTFOLIO_STARTED
from aiq_api.jobs.runner import COLLECTION_SCOPE_HEADER
from aiq_api.jobs.runner import _is_office_run
from aiq_api.jobs.runner import _run_portfolio_job

OFFICE_SCOPE = [
    {"collection": "oib_knowledge", "shelf": "base"},
    {"collection": "archiv_org_1", "shelf": "archiv"},
    {"collection": "proj_p-1", "shelf": "project", "projectId": "p-1", "projectName": "Seestadt Baufeld D"},
    {"collection": "proj_p-2", "shelf": "project", "projectId": "p-2", "projectName": "Volksschule Krems"},
]

IDENTITY = {"organization_id": "org-1", "organization_membership_id": "om-1", "user_id": "user-1"}


class _Metadata:
    """The worker's request-metadata slot, in the two calls the runner makes of it."""

    def __init__(self) -> None:
        self._attrs = _RequestAttrs()

    def get(self):
        return self._attrs

    def set(self, attrs) -> None:
        self._attrs = attrs


class _Request:
    def __init__(self) -> None:
        self.headers = Headers({})


class _RequestAttrs:
    def __init__(self) -> None:
        self._request = _Request()

    @property
    def headers(self):
        return self._request.headers


class _ContextState:
    def __init__(self) -> None:
        self.metadata = _Metadata()

    def scope(self) -> list:
        raw = self.metadata.get().headers.get(COLLECTION_SCOPE_HEADER)
        if not raw:
            return []
        padded = raw + "=" * (-len(raw) % 4)
        return json.loads(base64.urlsafe_b64decode(padded.encode()).decode())


class _EventStore:
    def __init__(self) -> None:
        self.events: list[dict] = []

    def store(self, event: dict) -> None:
        self.events.append(event)

    def phases(self) -> list[str]:
        return [event["data"]["phase"] for event in self.events if event.get("type") == "job.phase"]


def _digest(*ids: str) -> WorkspaceDigest:
    return WorkspaceDigest(
        digest=None,
        projects=tuple(WorkspaceProject(id=pid, name=f"Projekt {pid}", steckbrief="") for pid in ids),
    )


@pytest.fixture
def readable(monkeypatch):
    """What the workspace digest says this membership may read."""

    def _set(*ids: str):
        monkeypatch.setattr(
            "aiq_agent.knowledge.workspace_digest.fetch_workspace_digest",
            lambda **_: _digest(*ids),
        )

    return _set


async def _portfolio(run_project, *, context_state=None, event_store=None, project_ids=None, synthesize=None):
    return await _run_portfolio_job(
        job_id="job-1",
        query="Wie ist der Brandschutz gelöst?",
        identity=IDENTITY,
        collection_scope=OFFICE_SCOPE,
        project_ids=project_ids,
        context_state=context_state or _ContextState(),
        run_project=run_project,
        synthesize=synthesize,
        event_store=event_store,
    )


class TestOnlyTheOfficeIteratesProjects:
    def test_an_organisation_without_a_project_is_the_office(self):
        assert _is_office_run({"organization_id": "org-1"}) is True

    def test_a_project_run_is_not(self):
        """A project run already HAS its one project; iterating it is the same
        run with extra steps, and honoring the flag there would read the whole
        office out of one project's conversation."""
        assert _is_office_run({"organization_id": "org-1", "project_id": "p-1"}) is False

    def test_an_anonymous_run_is_not(self):
        assert _is_office_run({}) is False


@pytest.mark.asyncio
class TestTheBudgetIsDivided:
    async def test_each_project_gets_an_equal_share_of_the_run_ceiling(self, readable, monkeypatch):
        monkeypatch.setenv("GRID_MAX_RUN_COMPLETION_TOKENS", "1000")
        readable("p-1", "p-2", "p-3", "p-4")
        ceilings: list[int | None] = []

        async def _read(project, ceiling, sub_job_id):
            ceilings.append(ceiling)
            return {"report": f"Bericht {project.id}"}

        await _portfolio(_read)

        assert ceilings == [250, 250, 250, 250]

    async def test_a_deployment_without_a_ceiling_does_not_get_one_invented(self, readable, monkeypatch):
        monkeypatch.delenv("GRID_MAX_RUN_COMPLETION_TOKENS", raising=False)
        readable("p-1", "p-2")
        ceilings: list[int | None] = []

        async def _read(project, ceiling, sub_job_id):
            ceilings.append(ceiling)
            return {"report": "Bericht"}

        await _portfolio(_read)

        assert ceilings == [None, None]

    async def test_every_sub_run_gets_its_own_job_scope(self, readable):
        """One sandbox per project, so project two cannot read project one's draft."""
        readable("p-1", "p-2")
        sub_job_ids: list[str] = []

        async def _read(project, ceiling, sub_job_id):
            sub_job_ids.append(sub_job_id)
            return {"report": "Bericht"}

        await _portfolio(_read)

        assert sub_job_ids == ["job-1-p1", "job-1-p2"]


@pytest.mark.asyncio
class TestAProjectThatErrorsDoesNotFailTheRun:
    async def test_the_other_projects_still_reach_the_report(self, readable):
        readable("p-1", "p-2", "p-3")

        async def _read(project, ceiling, sub_job_id):
            if project.id == "p-2":
                raise RuntimeError("retrieval exploded")
            return {"report": f"Bericht über {project.id}"}

        result = await _portfolio(_read)

        assert "Bericht über p-1" in result["report"]
        assert "Bericht über p-3" in result["report"]

    async def test_the_failure_is_recorded_in_the_report(self, readable):
        readable("p-1", "p-2")

        async def _read(project, ceiling, sub_job_id):
            if project.id == "p-2":
                raise RuntimeError("retrieval exploded")
            return {"report": "Bericht"}

        result = await _portfolio(_read)

        assert "## Nicht gelesen" in result["report"]
        assert "Projekt p-2: konnte nicht gelesen werden" in result["report"]

    async def test_the_failure_reason_never_reaches_the_reader(self, readable):
        """A sub-run's exception text is diagnostics, not product copy."""
        readable("p-1")

        async def _read(project, ceiling, sub_job_id):
            raise RuntimeError("Milvus collection proj_p-1 is corrupt at segment 42")

        result = await _portfolio(_read)

        assert "Milvus" not in result["report"]
        assert "segment 42" not in result["report"]


@pytest.mark.asyncio
class TestAnUnreadableProjectIsSkippedAndNamed:
    async def test_it_is_never_read(self, readable):
        readable("p-1")
        seen: list[str] = []

        async def _read(project, ceiling, sub_job_id):
            seen.append(project.id)
            return {"report": "Bericht"}

        await _portfolio(_read, project_ids=["p-1", "p-9"])

        assert seen == ["p-1"]

    async def test_it_is_named_in_the_report(self, readable):
        readable("p-1")

        async def _read(project, ceiling, sub_job_id):
            return {"report": "Bericht"}

        result = await _portfolio(_read, project_ids=["p-1", "p-9"])

        assert "p-9" in result["report"]
        assert "Gelesen wurden 1 von 2 Projekten" in result["report"]

    async def test_a_register_that_cannot_be_reached_reads_nothing(self, monkeypatch):
        def _boom(**_):
            raise RuntimeError("register down")

        monkeypatch.setattr("aiq_agent.knowledge.workspace_digest.fetch_workspace_digest", _boom)

        async def _read(project, ceiling, sub_job_id):
            pytest.fail("nothing may be read when the readable set is unknown")

        result = await _portfolio(_read, project_ids=["p-1"])

        assert "p-1" in result["report"]


@pytest.mark.asyncio
class TestOneProjectAtATime:
    async def test_the_scope_is_narrowed_to_the_project_being_read(self, readable):
        readable("p-1", "p-2")
        context_state = _ContextState()
        scopes: list[list] = []

        async def _read(project, ceiling, sub_job_id):
            scopes.append(context_state.scope())
            return {"report": "Bericht"}

        await _portfolio(_read, context_state=context_state)

        assert [entry["collection"] for entry in scopes[0]] == ["oib_knowledge", "archiv_org_1", "proj_p-1"]
        assert [entry["collection"] for entry in scopes[1]] == ["oib_knowledge", "archiv_org_1", "proj_p-2"]

    async def test_the_project_entry_carries_its_identity(self, readable):
        """Without it a section's citations could not say which project they are from."""
        readable("p-1")
        context_state = _ContextState()
        scopes: list[list] = []

        async def _read(project, ceiling, sub_job_id):
            scopes.append(context_state.scope())
            return {"report": "Bericht"}

        await _portfolio(_read, context_state=context_state)

        assert scopes[0][-1]["projectId"] == "p-1"
        assert scopes[0][-1]["projectName"] == "Projekt p-1"


@pytest.mark.asyncio
class TestWhatTheRestOfTheJobReceives:
    async def test_the_result_is_the_shape_a_single_run_returns(self, readable):
        """Cards, the persisted output and the thread turn all read this."""
        readable("p-1", "p-2")

        async def _read(project, ceiling, sub_job_id):
            return {
                "report": f"Der Nachweis liegt vor [1]. ({project.id})",
                "verified_sources": [{"number": 1, "title": f"{project.id}.pdf"}],
            }

        result = await _portfolio(_read)

        assert set(result) == {"report", "verified_sources"}
        assert [source["number"] for source in result["verified_sources"]] == [1, 2]
        assert "[2]" in result["report"]

    async def test_the_stream_is_told_how_many_projects_and_which_one_is_running(self, readable):
        readable("p-1", "p-2")
        event_store = _EventStore()

        async def _read(project, ceiling, sub_job_id):
            return {"report": "Bericht"}

        await _portfolio(_read, event_store=event_store)

        assert event_store.phases() == [
            PHASE_PORTFOLIO_STARTED,
            PHASE_PORTFOLIO_PROJECT_STARTED,
            PHASE_PORTFOLIO_PROJECT_STARTED,
        ]
        started = event_store.events[0]["data"]
        assert started["count"] == 2
        assert started["projects"] == ["Projekt p-1", "Projekt p-2"]

    async def test_the_synthesis_opens_the_report_when_it_succeeds(self, readable):
        readable("p-1")

        async def _read(project, ceiling, sub_job_id):
            return {"report": "Bericht"}

        async def _synthesize(run):
            return "Beide Projekte lösen den Brandschutz über Sprinkler."

        result = await _portfolio(_read, synthesize=_synthesize)

        assert "## Überblick" in result["report"]
        assert "Sprinkler" in result["report"]

    async def test_a_failed_synthesis_still_ships_the_sections(self, readable):
        readable("p-1")

        async def _read(project, ceiling, sub_job_id):
            return {"report": "Bericht über p-1"}

        async def _synthesize(run):
            raise RuntimeError("the model timed out")

        result = await _portfolio(_read, synthesize=_synthesize)

        assert "## Überblick" not in result["report"]
        assert "Bericht über p-1" in result["report"]
