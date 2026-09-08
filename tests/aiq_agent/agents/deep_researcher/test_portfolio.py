"""The arithmetic of a Portfolio-Recherche (ADR-0054, spec DR-4…DR-8).

Module under test: ``aiq_agent.agents.deep_researcher.portfolio``. Everything
here is a pure function on purpose — which projects a run reads, what each
sub-run may see, what share of the budget it gets, and how the pieces become one
report — so the properties that make a portfolio run *correct* can be checked
without a worker, a Dask cluster or a model provider. The loop that uses them
inside a job is exercised in ``frontends/aiq_api/tests/test_portfolio_research.py``.
"""

from __future__ import annotations

import asyncio

import pytest

from aiq_agent.agents.deep_researcher.portfolio import BUDGET
from aiq_agent.agents.deep_researcher.portfolio import FAILED
from aiq_agent.agents.deep_researcher.portfolio import NOT_REACHED
from aiq_agent.agents.deep_researcher.portfolio import PORTFOLIO_MAX_PROJECTS
from aiq_agent.agents.deep_researcher.portfolio import READ
from aiq_agent.agents.deep_researcher.portfolio import PortfolioProject
from aiq_agent.agents.deep_researcher.portfolio import PortfolioSelection
from aiq_agent.agents.deep_researcher.portfolio import narrow_scope_to_project
from aiq_agent.agents.deep_researcher.portfolio import per_project_completion_ceiling
from aiq_agent.agents.deep_researcher.portfolio import project_collection
from aiq_agent.agents.deep_researcher.portfolio import render_portfolio_report
from aiq_agent.agents.deep_researcher.portfolio import renumber_citations
from aiq_agent.agents.deep_researcher.portfolio import resolve_portfolio_projects
from aiq_agent.agents.deep_researcher.portfolio import run_portfolio_iteration
from aiq_agent.agents.deep_researcher.portfolio import synthesis_prompt
from aiq_agent.knowledge.workspace_digest import WorkspaceDigest
from aiq_agent.knowledge.workspace_digest import WorkspaceProject

SEESTADT = PortfolioProject(id="p-1", name="Seestadt Baufeld D", collection="proj_p-1")
KREMS = PortfolioProject(id="p-2", name="Volksschule Krems", collection="proj_p-2")

OFFICE_SCOPE = [
    {"collection": "oib_knowledge", "shelf": "base"},
    {"collection": "archiv_org_1", "shelf": "archiv"},
    {"collection": "proj_p-1", "shelf": "project", "projectId": "p-1", "projectName": "Seestadt Baufeld D"},
    {"collection": "proj_p-2", "shelf": "project", "projectId": "p-2", "projectName": "Volksschule Krems"},
]


def _digest(*projects: WorkspaceProject) -> WorkspaceDigest:
    return WorkspaceDigest(digest=None, projects=tuple(projects))


def _hit(project_id: str, name: str) -> WorkspaceProject:
    return WorkspaceProject(id=project_id, name=name, steckbrief="")


class TestWhichProjectsAreRead:
    def test_a_named_project_the_caller_may_not_read_is_named_not_read(self):
        """The intersection is with the readable set, never a union onto it."""
        selection = resolve_portfolio_projects(
            organization_id="org-1",
            membership_id="om-1",
            query="Brandschutz",
            requested_ids=["p-1", "p-9"],
            fetch=lambda **_: _digest(_hit("p-1", "Seestadt Baufeld D")),
        )

        assert [project.id for project in selection.projects] == ["p-1"]
        assert selection.unreadable == ("p-9",)

    def test_no_named_projects_takes_what_the_register_offers(self):
        selection = resolve_portfolio_projects(
            organization_id="org-1",
            membership_id="om-1",
            query="Brandschutz",
            fetch=lambda **_: _digest(_hit("p-1", "Seestadt"), _hit("p-2", "Krems")),
        )

        assert [project.id for project in selection.projects] == ["p-1", "p-2"]
        assert selection.unreadable == ()

    def test_a_mounted_project_keeps_the_collection_the_bff_named(self):
        """The scope carries the real collection; only the rest is derived."""
        selection = resolve_portfolio_projects(
            organization_id="org-1",
            membership_id="om-1",
            query="Brandschutz",
            collection_scope=[{"collection": "proj_custom", "shelf": "project", "projectId": "p-1"}],
            fetch=lambda **_: _digest(_hit("p-1", "Seestadt"), _hit("p-2", "Krems")),
        )

        assert selection.projects[0].collection == "proj_custom"
        assert selection.projects[1].collection == project_collection("p-2")

    def test_a_register_that_cannot_be_reached_reads_nothing(self):
        """Fails CLOSED: "we could not ask who you may read" is not "read everyone"."""

        def _boom(**_):
            raise RuntimeError("register down")

        selection = resolve_portfolio_projects(
            organization_id="org-1",
            membership_id="om-1",
            query="Brandschutz",
            requested_ids=["p-1"],
            fetch=_boom,
        )

        assert selection.projects == ()
        assert selection.unreadable == ("p-1",)

    def test_without_an_organization_nothing_is_readable(self):
        selection = resolve_portfolio_projects(
            organization_id=None,
            membership_id=None,
            query="Brandschutz",
            requested_ids=["p-1"],
            fetch=lambda **_: pytest.fail("the register must not be asked without an organisation"),
        )

        assert selection.projects == ()
        assert selection.unreadable == ("p-1",)


class TestWhatOneSubRunMaySee:
    def test_every_other_project_is_dropped_and_this_one_is_named(self):
        narrowed = narrow_scope_to_project(OFFICE_SCOPE, SEESTADT)

        assert [entry["collection"] for entry in narrowed] == ["oib_knowledge", "archiv_org_1", "proj_p-1"]
        assert narrowed[-1] == {
            "collection": "proj_p-1",
            "shelf": "project",
            "projectId": "p-1",
            "projectName": "Seestadt Baufeld D",
        }

    def test_the_law_and_the_archive_survive(self):
        """A sub-run is still a building-law question, not a file search."""
        narrowed = narrow_scope_to_project(OFFICE_SCOPE, KREMS)

        assert {"collection": "oib_knowledge", "shelf": "base"} in narrowed
        assert {"collection": "archiv_org_1", "shelf": "archiv"} in narrowed

    def test_a_bare_collection_name_survives_as_an_entry(self):
        narrowed = narrow_scope_to_project(["oib_knowledge"], SEESTADT)

        assert narrowed[0] == {"collection": "oib_knowledge"}

    def test_a_run_with_no_scope_still_gets_its_project(self):
        assert narrow_scope_to_project(None, SEESTADT) == [
            {
                "collection": "proj_p-1",
                "shelf": "project",
                "projectId": "p-1",
                "projectName": "Seestadt Baufeld D",
            }
        ]


class TestTheBudgetShare:
    def test_the_ceiling_is_divided_equally(self):
        assert per_project_completion_ceiling(1000, 4) == 250

    def test_a_run_without_a_ceiling_does_not_get_one_invented(self):
        assert per_project_completion_ceiling(None, 4) is None
        assert per_project_completion_ceiling(0, 4) is None

    def test_more_projects_than_tokens_still_leaves_every_project_something(self):
        assert per_project_completion_ceiling(3, 10) == 1


class TestTheIteration:
    def _run(self, **kwargs):
        return asyncio.run(run_portfolio_iteration(**kwargs))

    def test_projects_are_read_one_at_a_time_in_order(self):
        seen: list[str] = []
        in_flight = 0

        async def _read(project, ceiling):
            nonlocal in_flight
            in_flight += 1
            assert in_flight == 1, "a portfolio run reads projects sequentially (DR-4)"
            await asyncio.sleep(0)
            seen.append(project.id)
            in_flight -= 1
            return f"Bericht {project.id}", []

        run = self._run(
            query="Brandschutz",
            selection=PortfolioSelection(projects=(SEESTADT, KREMS)),
            run_project=_read,
        )

        assert seen == ["p-1", "p-2"]
        assert [outcome.status for outcome in run.outcomes] == [READ, READ]

    def test_each_project_gets_its_own_share_of_the_run_ceiling(self):
        ceilings: list[int | None] = []

        async def _read(project, ceiling):
            ceilings.append(ceiling)
            return "Bericht", []

        self._run(
            query="Brandschutz",
            selection=PortfolioSelection(projects=(SEESTADT, KREMS)),
            run_project=_read,
            run_ceiling=1000,
        )

        assert ceilings == [500, 500]

    def test_a_project_that_errors_is_recorded_and_the_run_goes_on(self):
        async def _read(project, ceiling):
            if project.id == "p-1":
                raise RuntimeError("retrieval exploded")
            return "Bericht Krems", []

        run = self._run(
            query="Brandschutz",
            selection=PortfolioSelection(projects=(SEESTADT, KREMS)),
            run_project=_read,
        )

        assert [outcome.status for outcome in run.outcomes] == [FAILED, READ]
        assert [outcome.project.id for outcome in run.read_projects()] == ["p-2"]

    def test_one_projects_share_running_out_does_not_end_the_run(self):
        from aiq_agent.common import RunBudgetExceededError

        async def _read(project, ceiling):
            if project.id == "p-1":
                raise RunBudgetExceededError(100, 120)
            return "Bericht Krems", []

        run = self._run(
            query="Brandschutz",
            selection=PortfolioSelection(projects=(SEESTADT, KREMS)),
            run_project=_read,
        )

        assert [outcome.status for outcome in run.outcomes] == [BUDGET, READ]

    def test_the_organisation_budget_stops_the_run_and_marks_the_rest(self):
        from aiq_agent.common.cost_tracking import BudgetExceededError

        async def _read(project, ceiling):
            raise BudgetExceededError("the organisation's LLM budget is exhausted")

        run = self._run(
            query="Brandschutz",
            selection=PortfolioSelection(projects=(SEESTADT, KREMS)),
            run_project=_read,
        )

        assert [outcome.status for outcome in run.outcomes] == [BUDGET, NOT_REACHED]

    def test_cancellation_is_never_swallowed_into_a_project_note(self):
        async def _read(project, ceiling):
            raise asyncio.CancelledError

        with pytest.raises(asyncio.CancelledError):
            self._run(
                query="Brandschutz",
                selection=PortfolioSelection(projects=(SEESTADT,)),
                run_project=_read,
            )

    def test_a_failed_synthesis_still_yields_the_sections(self):
        async def _read(project, ceiling):
            return f"Bericht {project.id}", []

        async def _synthesize(run):
            raise RuntimeError("the model timed out")

        run = self._run(
            query="Brandschutz",
            selection=PortfolioSelection(projects=(SEESTADT,)),
            run_project=_read,
            synthesize=_synthesize,
        )

        assert run.synthesis == ""
        assert len(run.read_projects()) == 1


class TestTheOneReport:
    def _report(self, **kwargs) -> str:
        async def _read(project, ceiling):
            return f"Bericht über {project.label()}.", []

        run = asyncio.run(
            run_portfolio_iteration(
                query="Brandschutz",
                selection=kwargs.pop("selection"),
                run_project=kwargs.pop("run_project", _read),
                **kwargs,
            )
        )
        return render_portfolio_report(run)[0]

    def test_every_read_project_gets_its_own_section(self):
        report = self._report(selection=PortfolioSelection(projects=(SEESTADT, KREMS)))

        assert "## Seestadt Baufeld D" in report
        assert "## Volksschule Krems" in report
        assert "Gelesen wurden 2 von 2 Projekten" in report

    def test_a_project_that_could_not_be_read_is_named(self):
        report = self._report(
            selection=PortfolioSelection(projects=(SEESTADT,), unreadable=("p-9",)),
        )

        assert "## Nicht gelesen" in report
        assert "p-9" in report

    def test_a_failing_project_is_a_line_not_a_missing_run(self):
        async def _read(project, ceiling):
            if project.id == "p-1":
                raise RuntimeError("boom")
            return "Bericht Krems", []

        report = self._report(
            selection=PortfolioSelection(projects=(SEESTADT, KREMS)),
            run_project=_read,
        )

        assert "## Volksschule Krems" in report
        assert "Seestadt Baufeld D: konnte nicht gelesen werden" in report

    def test_citations_are_renumbered_into_one_document(self):
        async def _read(project, ceiling):
            return (
                "Der Nachweis liegt vor [1]. Die Fassade ist geprüft [2].",
                [{"number": 1, "title": f"{project.id}-a"}, {"number": 2, "title": f"{project.id}-b"}],
            )

        run = asyncio.run(
            run_portfolio_iteration(
                query="Brandschutz",
                selection=PortfolioSelection(projects=(SEESTADT, KREMS)),
                run_project=_read,
            )
        )
        report, sources = render_portfolio_report(run)

        assert "[3]" in report and "[4]" in report
        assert [source["number"] for source in sources] == [1, 2, 3, 4]
        assert [source["title"] for source in sources] == ["p-1-a", "p-1-b", "p-2-a", "p-2-b"]

    def test_a_run_that_read_nothing_says_so(self):
        report = self._report(selection=PortfolioSelection(unreadable=("p-9",)))

        assert "Es konnte keines der 1 angefragten Projekte gelesen werden." in report


class TestRenumbering:
    def test_a_grouped_marker_is_shifted_whole(self):
        report, sources, offset = renumber_citations("Beides gilt [1, 2].", [{"number": 1}, {"number": 2}], 5)

        assert report == "Beides gilt [6, 7]."
        assert [source["number"] for source in sources] == [6, 7]
        assert offset == 7

    def test_a_source_without_a_number_keeps_its_place_unnumbered(self):
        _, sources, _ = renumber_citations("Kein Verweis.", [{"title": "x"}], 3)

        assert sources == [{"title": "x"}]


class TestTheSynthesisPrompt:
    def test_it_carries_the_question_and_every_read_project(self):
        from aiq_agent.agents.deep_researcher.portfolio import PortfolioOutcome
        from aiq_agent.agents.deep_researcher.portfolio import PortfolioRun

        run = PortfolioRun(
            query="Brandschutz",
            selection=PortfolioSelection(projects=(SEESTADT, KREMS)),
            outcomes=[
                PortfolioOutcome(project=SEESTADT, status=READ, report="A" * 10),
                PortfolioOutcome(project=KREMS, status=FAILED),
            ],
        )
        prompt = synthesis_prompt(run)

        assert "FRAGE: Brandschutz" in prompt
        assert "PROJEKT: Seestadt Baufeld D" in prompt
        assert "Volksschule Krems" not in prompt

    def test_one_projects_findings_cannot_grow_without_bound(self):
        from aiq_agent.agents.deep_researcher.portfolio import PortfolioOutcome
        from aiq_agent.agents.deep_researcher.portfolio import PortfolioRun

        run = PortfolioRun(
            query="Brandschutz",
            selection=PortfolioSelection(projects=(SEESTADT,)),
            outcomes=[PortfolioOutcome(project=SEESTADT, status=READ, report="A" * 9000)],
        )

        assert len(synthesis_prompt(run)) < 6000


def test_the_run_never_reads_more_projects_than_its_own_ceiling():
    """The bound is one number, and it is the one the digest can serve."""
    selection = resolve_portfolio_projects(
        organization_id="org-1",
        membership_id="om-1",
        query="Brandschutz",
        fetch=lambda **kwargs: _digest(*(_hit(f"p-{n}", f"Projekt {n}") for n in range(20))),
    )

    assert len(selection.projects) <= PORTFOLIO_MAX_PROJECTS
