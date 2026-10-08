"""The precedent eval's harness: the part of it a CI machine can run.

`scripts/turn_census/suite.py --set precedent` needs a model key to RUN. What
is testable offline is everything around the agent: that the fixture BFF
answers the routes a cross-project turn reads in their wire shape and drops
every other route as today's suite does, that the envelope the suite mints is
one the agent accepts, that the question set only expects facts the fixture
office holds, and how the checks read an answer. An eval that misreads a turn
reports its own bugs as the agent's (docs/roadmap/office-experience.md, step A).
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts" / "turn_census"))

import suite  # noqa: E402
from fixture_bff import FixtureBFF  # noqa: E402
from fixture_bff import FixtureOffice  # noqa: E402

from aiq_agent.project_context import GridRequestContext  # noqa: E402

SCHEMA = json.loads((REPO_ROOT / "frontends" / "ui" / "tests" / "fixtures" / "cross-project.schema.json").read_text())
TOKEN = "eval-token"


def _validator(name: str) -> Draft202012Validator:
    return Draft202012Validator({**SCHEMA["$defs"][name], "$defs": SCHEMA["$defs"]})


@pytest.fixture
def bff(tmp_path):
    server = FixtureBFF(TOKEN, tmp_path / "requests.jsonl").start()
    yield server
    server.stop()


def _post(bff: FixtureBFF, path: str, body: dict, token: str = TOKEN) -> tuple[int, dict]:
    request = urllib.request.Request(
        f"{bff.url}{path}",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Grid-Internal-Token": token},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8") or "{}")


class TestTheFixtureBff:
    def test_the_search_answers_in_the_routes_own_wire_shape(self, bff):
        status, body = _post(bff, "/api/internal/cross-project/search", {"query": "Traufe Holzbau"})

        assert status == 200
        _validator("CrossProjectSearchResponse").validate(body)
        assert body["hits"][0]["filename"] == "Detail_Traufe_Holzbau.pdf"
        assert body["hits"][0]["project"] == {
            "id": "b0000000-0000-4000-8000-000000000002",
            "name": "Holzwohnbau Baden, Wiener Straße",
            "status": "closed",
            "bundesland": "niederoesterreich",
        }

    def test_a_search_walks_the_projects_in_the_similar_order_production_ranks(self, bff):
        _, body = _post(bff, "/api/internal/cross-project/search", {"query": "Bescheid Auflagen"})

        assert body["projectsInScope"] == 7
        assert {hit["project"]["name"] for hit in body["hits"]} >= {
            "Holzwohnbau Baden, Wiener Straße",
            "Wohnhausanlage Mödling, Brunner Gasse",
        }

    def test_a_projects_recorded_decision_answers_beside_its_passages(self, bff):
        _, body = _post(bff, "/api/internal/cross-project/search", {"query": "Kapselung Gipsfaserplatten"})

        _validator("CrossProjectSearchResponse").validate(body)
        assert body["decisions"][0]["project"]["name"] == "Holzwohnbau Baden, Wiener Straße"
        assert "Prüfbericht" in body["decisions"][0]["content"]

    def test_a_question_nothing_answers_still_gets_the_nearest_passages_as_in_production(self, bff):
        """No relevance floor: production hands the nearest passages over and the agent judges, so the eval does too."""
        _, body = _post(bff, "/api/internal/cross-project/search", {"query": "Feuerwehraufzug Hochhaus", "limit": 5})

        assert 0 < len(body["hits"]) <= 5
        # Without an embedder only shared tokens rank a decision, and none shares one.
        assert body["decisions"] == []

    def test_the_listing_and_the_brief_answer_in_their_wire_shapes(self, bff):
        status, listing = _post(bff, "/api/internal/cross-project/projects", {"query": "Mödling"})
        assert status == 200
        _validator("CrossProjectListResponse").validate(listing)
        assert [project["name"] for project in listing["projects"]] == ["Wohnhausanlage Mödling, Brunner Gasse"]

        status, brief = _post(bff, "/api/internal/cross-project/brief", {"projectId": listing["projects"][0]["id"]})
        assert status == 200
        _validator("CrossProjectBriefResponse").validate(brief)
        assert "bundesland=niederoesterreich" in brief["facts"]

        assert _post(bff, "/api/internal/cross-project/brief", {"projectId": "nope"})[0] == 404

    def test_the_turn_context_carries_the_catalog_the_production_renderer_wrote(self, bff):
        _, body = _post(bff, "/api/internal/turn-context", {})

        catalog = body["data"]["referenceProjects"]
        assert catalog.splitlines()[0].startswith("- Holzwohnbau Baden, Wiener Straße")
        assert "Schule Linz" not in catalog  # running: not a reference project
        assert body["data"]["projectContext"].startswith("PROJECT_CONTEXT v1")

    def test_every_other_route_is_as_unreachable_as_without_a_bff(self, bff):
        with pytest.raises((urllib.error.URLError, ConnectionError, OSError)):
            _post(bff, "/api/internal/stages", {})

    def test_a_wrong_token_is_not_answered(self, bff):
        with pytest.raises((urllib.error.URLError, ConnectionError, OSError)):
            _post(bff, "/api/internal/cross-project/search", {"query": "Traufe"}, token="wrong")

    def test_every_request_is_logged_for_the_checks(self, bff, tmp_path):
        _post(bff, "/api/internal/cross-project/search", {"query": "Traufe"})

        logged = [json.loads(line) for line in (tmp_path / "requests.jsonl").read_text().splitlines()]
        assert logged[0]["path"] == "/api/internal/cross-project/search"
        assert logged[0]["body"] == {"query": "Traufe"}


def test_the_envelope_the_suite_mints_is_one_the_agent_accepts():
    office = FixtureOffice().office
    header, signature = suite.precedent_envelope(office, "suite-1-traufe-frueher-1", TOKEN)

    context = GridRequestContext.from_envelope(header, signature, TOKEN)

    assert context is not None
    assert (context.project_id, context.conversation_id, context.context_transport) == (
        "a0000000-0000-4000-8000-000000000001",
        "suite-1-traufe-frueher-1",
        "bff",
    )
    assert context.bundesland == "niederoesterreich"
    assert GridRequestContext.from_envelope(header, signature, "another-secret") is None


def test_every_project_a_question_expects_is_in_its_scenarios_office():
    """An expectation is a fact read off the office the question sits in, never a name it does not hold."""
    for question in suite.load_precedent_questions():
        office = FixtureOffice(scenario=question.get("scenario") or "default")
        folded = suite._normal(" ".join(project["name"] for project in office.projects.values()))
        for group in (question.get("expect") or {}).get("cites") or []:
            assert any(suite._normal(option) in folded for option in group), (question["id"], group)


def test_the_questions_hold_a_held_out_share_in_every_scenario():
    """Overfitting shows only beside questions nobody tuned on, in an office nobody tuned on."""
    questions = suite.load_precedent_questions()
    assert sum(bool(q.get("holdout")) for q in questions) >= len(questions) // 3
    for scenario in {q.get("scenario") for q in questions if q.get("scenario")}:
        assert any(q.get("scenario") == scenario and q.get("holdout") for q in questions), scenario


class TestTheScenarios:
    def test_a_conversation_is_answered_from_its_scenarios_office(self, bff):
        bff.assign("suite-1-wien-1", "wien-bestand")
        bff.assign("suite-1-leer-1", "leeres-buero")

        def turn_context(conversation: str) -> dict:
            office = bff.office_for(conversation)
            return office.turn_context()["data"]

        assert turn_context("suite-1-wien-1")["referenceProjects"].startswith("- Bürogebäude Wien 22")
        assert not turn_context("suite-1-leer-1")["referenceProjects"]
        assert turn_context("suite-1-unassigned-1")["referenceProjects"].startswith("- Holzwohnbau Baden")
        assert bff.office_for("suite-1-leer-1").search({"query": "Traufe"})["projectsInScope"] == 0

    def test_a_hit_says_its_land_in_another_offices_search(self):
        hits = FixtureOffice(scenario="wien-bestand").search({"query": "Kapselung Gipsfaserplatten"})["hits"]

        assert hits[0]["project"]["bundesland"] == "niederoesterreich"
        assert {"wien", "niederoesterreich"} <= {hit["project"]["bundesland"] for hit in hits}


def _concept_embedder(concepts: dict[str, list[str]]):
    """A deterministic stand-in for the embedding model: one axis per concept, a text on every axis it names."""
    axes = list(concepts)

    def embed(texts: list[str]) -> list[list[float]]:
        return [
            [1.0 if any(word in text.casefold() for word in concepts[axis]) else 0.0 for axis in axes] + [0.01]
            for text in texts
        ]

    return embed


CONCEPTS = _concept_embedder({"eaves": ["eaves", "traufe"], "lining": ["lining", "kapselung", "gipsfaser"]})


class TestTheSearchRanksByMeaning:
    def test_a_question_in_another_language_finds_the_passage_by_meaning(self):
        office = FixtureOffice(embed=CONCEPTS)

        hits = office.search({"query": "How were the eaves of our timber houses built?"})["hits"]

        assert hits[0]["filename"] == "Detail_Traufe_Holzbau.pdf"

    def test_the_decisions_are_ranked_by_meaning_and_handed_over_like_the_passages(self):
        office = FixtureOffice(embed=CONCEPTS)

        decisions = office.search({"query": "Which fire lining did we choose?"})["decisions"]

        assert decisions[0]["project"]["name"] == "Holzwohnbau Baden, Wiener Straße"
        assert len(decisions) <= 6

    def test_an_embedder_that_fails_leaves_the_token_channel(self):
        office = FixtureOffice(embed=lambda texts: None)

        assert office.search({"query": "Traufe Holzbau"})["hits"][0]["filename"] == "Detail_Traufe_Holzbau.pdf"

    def test_the_envelope_sits_in_the_scenarios_current_project(self):
        office = FixtureOffice(scenario="wien-bestand")
        header, signature = suite.precedent_envelope(office.office, "suite-1-wien-1", TOKEN, office.current)

        context = GridRequestContext.from_envelope(header, signature, TOKEN)

        assert context is not None
        assert (context.project_id, context.bundesland) == ("a3000000-0000-4000-8000-000000000009", "wien")

    def test_an_unknown_scenario_is_refused_rather_than_answered_from_the_default(self):
        with pytest.raises(KeyError):
            FixtureOffice(scenario="nirgendwo")

    def test_the_report_scores_held_out_and_each_scenario_apart(self):
        runs = [
            suite.Run(question_id="a", run=1, checks={"cites:Baden": True}),
            suite.Run(question_id="b", run=1, checks={"cites:Baden": False}, holdout=True, scenario="wien-bestand"),
        ]

        lines = suite.split_lines(runs)

        assert "**Tuned questions** (1 runs):" in lines and "**Held-out questions** (1 runs):" in lines
        assert "**Scenario `wien-bestand`** (1 runs):" in lines
        assert suite.split_lines([suite.Run(question_id="a", run=1)]) == []


def test_every_question_says_whether_it_expects_a_lookup():
    for question in suite.load_precedent_questions():
        assert question["expect"].get("lookup") in {"required", "forbidden", "optional"}, question["id"]


class TestTheChecks:
    def _run(self, tools: list[str], answer: str) -> suite.Run:
        return suite.Run(question_id="q", run=1, tool_calls=tools, answer=answer)

    def test_a_required_lookup_and_its_citations_hold(self):
        expect = {"lookup": "required", "cites": [["Baden"]], "not_cites": ["Linz"]}
        run = self._run(["knowledge_search", "project_lookup"], "Beim Holzwohnbau Baden (2021) …")

        assert suite.precedent_checks(expect, run, suite._normal(run.answer)) == {
            "looked_up": True,
            "cites:Baden": True,
            "not_cites:Linz": True,
        }

    def test_a_lookup_on_a_norm_question_fails(self):
        run = self._run(["project_lookup"], "Das Fluchtniveau ist …")

        assert suite.precedent_checks({"lookup": "forbidden"}, run, suite._normal(run.answer)) == {"no_lookup": False}

    def test_meaning_is_the_judges_and_it_gets_the_question_and_the_raw_answer(self):
        asked = []

        def judge(kind: str, question: str, answer: str) -> bool | None:
            asked.append((kind, question, answer))
            return kind == "says_none"

        run = self._run(["project_lookup"], "Ein Hallenbad hatten wir **noch nie**.")
        checks = suite.precedent_checks(
            {"says_none": True, "caveat": True}, run, suite._normal(run.answer), question="Hallenbad?", judge=judge
        )

        assert checks == {"says_none": True, "caveat": False}
        assert asked == [
            ("says_none", "Hallenbad?", "Ein Hallenbad hatten wir **noch nie**."),
            ("caveat", "Hallenbad?", "Ein Hallenbad hatten wir **noch nie**."),
        ]

    def test_a_meaning_no_judge_could_read_is_left_out_never_guessed(self):
        run = self._run([], "Nichts Vergleichbares.")

        assert suite.precedent_checks({"says_none": True}, run, "", judge=None) == {}
        assert suite.precedent_checks({"says_none": True}, run, "", judge=lambda *_: None) == {}

    def test_the_report_counts_each_kind_of_check_over_every_run(self):
        runs = [
            suite.Run(question_id="a", run=1, checks={"looked_up": True, "cites:Baden": True}),
            suite.Run(question_id="b", run=1, checks={"looked_up": False, "cites:Mödling": True}),
        ]

        assert suite.aggregate_lines(runs) == ["- `cites`: 2/2", "- `looked_up`: 1/2"]


def test_a_lookup_counts_for_the_run_it_served_however_it_was_asked_for(tmp_path):
    """A round-0 prefetch shows in no model call; what the fixture served is what the turn read."""
    from fixture_bff import lookups_served

    office = FixtureOffice().office
    server = FixtureBFF(TOKEN, tmp_path / "requests.jsonl").start()
    try:
        for conversation in ("suite-1-a-1", "suite-1-b-1"):
            header, signature = suite.precedent_envelope(office, conversation, TOKEN)
            request = urllib.request.Request(
                f"{server.url}/api/internal/cross-project/search",
                data=json.dumps({"query": "Traufe"}).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "X-Grid-Internal-Token": TOKEN,
                    "X-Grid-Request-Context": header,
                    "X-Grid-Request-Context-Sig": signature,
                },
                method="POST",
            )
            urllib.request.urlopen(request, timeout=5).close()
    finally:
        server.stop()

    assert lookups_served(tmp_path / "requests.jsonl", "suite-1-a-1") == ["search"]
    assert lookups_served(tmp_path / "requests.jsonl", "suite-1-c-1") == []
    run = suite.Run(question_id="a", run=1, lookups=["search"])
    assert suite.precedent_checks({"lookup": "required"}, run, "") == {"looked_up": True}
