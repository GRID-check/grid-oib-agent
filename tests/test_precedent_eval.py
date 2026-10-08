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

        assert body["projectsInScope"] == len(FixtureOffice().projects) > 20
        assert body["projectsSearched"] == 8
        assert {hit["project"]["name"] for hit in body["hits"]} >= {
            "Holzwohnbau Baden, Wiener Straße",
            "Wohnhausanlage Mödling, Brunner Gasse",
        }

    def test_a_projects_recorded_decision_answers_beside_its_passages(self, bff):
        _, body = _post(bff, "/api/internal/cross-project/search", {"query": "Kapselung Gipsfaserplatten"})

        _validator("CrossProjectSearchResponse").validate(body)
        assert body["decisions"][0]["project"]["name"] == "Holzwohnbau Baden, Wiener Straße"
        assert "Prüfbericht" in body["decisions"][0]["content"]

    def test_a_projects_permit_record_answers_in_the_routes_wire_shape_with_only_the_requirements_that_matched(
        self, bff
    ):
        _, body = _post(bff, "/api/internal/cross-project/search", {"query": "Druckbelüftung Prüfbericht"})

        _validator("CrossProjectSearchResponse").validate(body)
        permit = body["permits"][0]
        assert (permit["fileName"], permit["collection"], permit["kind"], permit["restricted"]) == (
            "MA37_Nachforderung_Druckbelueftung.pdf",
            "proj_eval_wien22",
            "nachforderung",
            False,
        )
        assert permit["project"]["name"] == "Bürogebäude Wien 22, Wagramer Straße"
        assert permit["project"]["bundesland"] == "wien"
        assert "Prüfbericht" in permit["requirements"][0]["content"]
        assert len(body["permits"]) <= 8
        assert all(0 < len(found["requirements"]) <= 6 for found in body["permits"])

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


def test_the_fixture_permit_records_are_of_documents_the_office_holds_and_the_ingest_typed_bescheid():
    """`permits.json` is the pen's output over the office: a record for a document that is not one is a stale render."""
    permits = json.loads(
        (REPO_ROOT / "frontends" / "ui" / "tests" / "fixtures" / "precedent" / "permits.json").read_text()
    )
    documents = {
        document["documentId"]: document
        for project in FixtureOffice().office["projects"]
        for document in project["documents"]
    }
    bescheide = {
        document_id for document_id, document in documents.items() if "Bescheid" in (document.get("tags") or [])
    }

    assert permits["records"], "no record at all: render_fixture_permits.py has not been run"
    assert set(permits["records"]) <= set(documents)
    assert set(permits["records"]) <= bescheide
    # A Bescheid with no record would be a fixture office the production ingest does not produce.
    assert set(permits["records"]) == bescheide


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


PERMIT_CONCEPTS = _concept_embedder({"pressure": ["druckbel", "pressuris"], "escape": ["fluchtweg", "escape"]})


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

    def test_the_permit_records_are_ranked_by_meaning_too(self):
        office = FixtureOffice(embed=PERMIT_CONCEPTS)

        permits = office.search({"query": "Must we prove the stairwell is pressurised?"})["permits"]

        assert permits[0]["fileName"] == "MA37_Nachforderung_Druckbelueftung.pdf"
        assert permits[0]["requirements"][0]["content"].startswith("Für das Sicherheitstreppenhaus")

    def test_a_scenario_without_the_projects_has_no_permit_of_them(self):
        assert FixtureOffice(scenario="leeres-buero").search({"query": "Druckbelüftung"})["permits"] == []

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

    def test_a_meaning_no_judge_could_read_is_a_recorded_failure_never_a_missing_check(self):
        """`says_none` 9/9 once hid a tenth run: a judge that could not answer dropped the check from the count."""
        for judge in (None, lambda *_: None):
            run = self._run([], "Nichts Vergleichbares.")

            checks = suite.precedent_checks({"says_none": True}, run, "", judge=judge)

            assert checks == {"says_none": False}
            assert run.signals == ["judge_unavailable:says_none"]

    def test_a_judge_that_answers_leaves_no_trace_and_a_rerun_clears_the_old_one(self):
        run = suite.Run(question_id="q", run=1, answer="Nichts Vergleichbares.", signals=["judge_unavailable:caveat"])

        checks = suite.precedent_checks(
            {"says_none": True, "caveat": True}, run, "", judge=lambda kind, *_: kind == "caveat"
        )

        assert checks == {"says_none": False, "caveat": True}
        assert run.signals == []

    def test_an_empty_answer_says_nothing_and_is_not_blamed_on_the_judge(self):
        asked = []
        run = self._run([], "")

        checks = suite.precedent_checks({"says_none": True}, run, "", judge=lambda *args: asked.append(args))

        assert checks == {"says_none": False}
        assert asked == [] and run.signals == []

    def test_the_report_shows_caveat_and_how_many_meaning_checks_the_judge_could_not_answer(self):
        runs = [
            suite.Run(question_id="a", run=1, checks={"says_none": True, "looked_up": True}),
            suite.Run(question_id="b", run=1, checks={"says_none": False}, signals=["judge_unavailable:says_none"]),
            suite.Run(question_id="c", run=1, checks={"caveat": True}),
            suite.Run(question_id="d", run=1, checks={"caveat": False}, signals=["judge_unavailable:caveat"]),
        ]

        assert suite.aggregate_lines(runs) == [
            "- `caveat`: 1/2",
            "- `looked_up`: 1/1",
            "- `says_none`: 1/2",
            "- judge could not answer: 2 of 4 meaning checks (says_none 1, caveat 1)",
        ]
        assert suite.aggregate_lines([suite.Run(question_id="a", run=1, checks={"looked_up": True})]) == [
            "- `looked_up`: 1/1"
        ]

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


def _repeating(question: dict) -> tuple[suite.Run, str]:
    """The run of an answer that says nothing but the question, and that answer as the checks read it."""
    run = suite.Run(question_id=str(question["id"]), run=1, answer=str(question["question"]))
    return run, suite._normal(run.answer)


class TestCites:
    def test_an_answer_that_only_repeats_the_question_cites_nothing(self):
        """8 of 19 groups passed on exactly that: the question names the town, the check looked for the town."""
        questions = [q for q in suite.load_precedent_questions() if q["expect"].get("cites")]
        assert questions
        for question in questions:
            run, answer = _repeating(question)

            checks = suite.precedent_checks(question["expect"], run, answer, question=question["question"])

            assert not [key for key, held in checks.items() if key.startswith("cites:") and held], question["id"]

    def test_every_group_can_be_met_by_a_name_the_question_does_not_contain(self):
        for question in suite.load_precedent_questions():
            asked = suite._normal(question["question"])
            for group in question["expect"].get("cites") or []:
                assert any(suite._normal(option) not in asked for option in group), (question["id"], group)

    def test_the_project_by_a_name_the_question_leaves_out_does_count(self):
        question = next(q for q in suite.load_precedent_questions() if q["id"] == "kapselung-wie-baden")
        answer = "Das Brandschutzkonzept stammt aus dem Projekt Wiener Straße (2020)."
        run = suite.Run(question_id="kapselung-wie-baden", run=1, answer=answer)

        checks = suite.precedent_checks(question["expect"], run, suite._normal(answer), question=question["question"])

        assert checks["cites:Wiener Straße"] is True

    def test_a_word_of_the_question_is_no_alternative_even_inside_a_longer_group(self):
        """`hold-dachgeschoss-auflagen` listed „Dachgeschoßausbau", the word its own question uses."""
        expect = {"cites": [["Dachgeschoßausbau", "Neubaugasse"]]}
        question = "Welche Auflagen gab es bei unserem Dachgeschoßausbau?"
        repeated = suite.Run(question_id="q", run=1, answer=question)
        named = suite.Run(question_id="q", run=1, answer="Das Projekt Neubaugasse.")

        assert suite.precedent_checks(expect, repeated, suite._normal(question), question=question) == {
            "cites:Dachgeschoßausbau": False
        }
        assert suite.precedent_checks(expect, named, suite._normal(named.answer), question=question) == {
            "cites:Dachgeschoßausbau": True
        }


SOURCES = (
    "Text [1] [2] [3].\n\n## Quellen\n"
    "- [1] [KB] Detail_Traufe_Holzbau.pdf (Holzwohnbau Baden, Wiener Straße), p.2\n"
    "- [2] [KB] oib-rl_2_ausgabe_mai_2023.pdf, p.4\n"
    "- [3] [RIS] NÖ Bautechnikverordnung 2014, § 3 (Fassung 2015-02-01)\n"
    "- [4] [KB] Projektgedächtnis (Wohnhausanlage Mödling, Brunner Gasse)\n"
    "- [5] project_lookup\n"
)


class TestTheProjectsAnAnswerNames:
    def test_the_projects_the_source_lines_name_are_read_off_the_cross_project_lines_only(self):
        assert suite.sourced_projects(SOURCES) == [
            "Holzwohnbau Baden, Wiener Straße",
            "Wohnhausanlage Mödling, Brunner Gasse",
        ]

    def test_a_filename_with_parentheses_of_its_own_is_no_project(self):
        assert suite.sourced_projects("- [1] [KB] Plan (1).pdf, p.3\n- [2] [KB] Plan (Entwurf).pdf") == []

    def test_projects_the_office_holds_pass(self):
        names = FixtureOffice().project_names()
        run = suite.Run(question_id="q", run=1, answer=SOURCES)

        checks = suite.precedent_checks({"lookup": "optional"}, run, suite._normal(SOURCES), projects=names)

        assert checks == {"real_projects": True}

    def test_an_invented_project_in_a_source_line_fails_however_real_the_rest_looks(self):
        invented = SOURCES + "- [6] [KB] Brandschutzkonzept.pdf (Wohnhausanlage Tulln, Hauptstraße), p.3\n"
        run = suite.Run(question_id="q", run=1, answer=invented)

        checks = suite.precedent_checks(
            {"lookup": "optional"}, run, suite._normal(invented), projects=FixtureOffice().project_names()
        )

        assert checks == {"real_projects": False}

    def test_a_real_project_the_scenarios_office_does_not_hold_is_invented_there(self):
        """The empty office holds no other project: a source naming Baden there came from nowhere."""
        run = suite.Run(question_id="q", run=1, answer=SOURCES)
        names = FixtureOffice(scenario="leeres-buero").project_names()

        assert names == ["Wohnhaus Perchtoldsdorf, Hochstraße"]
        assert suite.precedent_checks({"lookup": "optional"}, run, "", projects=names) == {"real_projects": False}

    def test_a_name_differing_only_in_case_and_spacing_is_the_same_project(self):
        run = suite.Run(question_id="q", run=1, answer="- [1] [KB] x.pdf (holzwohnbau  baden, wiener straße), p.1")

        assert suite.precedent_checks({}, run, "", projects=FixtureOffice().project_names()) == {"real_projects": True}

    def test_without_a_name_list_the_check_is_not_asked(self):
        assert suite.precedent_checks({}, suite.Run(question_id="q", run=1, answer=SOURCES), "") == {}

    def test_a_turn_with_a_lookup_expectation_is_checked_against_its_scenarios_office(self, monkeypatch):
        monkeypatch.setattr(suite, "_judge", lambda: None)
        question = next(q for q in suite.load_precedent_questions() if q["id"] == "leer-aehnliche")
        run = suite.Run(question_id="leer-aehnliche", run=1, answer=SOURCES, lookups=["search"])

        checks = suite.check(question, run, {"kind": "answer", "cards": []})

        assert checks["real_projects"] is False
        norm = next(q for q in suite.load_questions(core_only=False)[0] if not q.get("expect", {}).get("lookup"))
        assert "real_projects" not in suite.check(norm, suite.Run(question_id=str(norm["id"]), run=1), None)


NEEDS_THE_EMBEDDER = {"hold-english-escape-stair"}
"""An English question shares no content word with a German passage: only the embedder can rank it."""


def _with_evidence() -> list[dict]:
    return [q for q in suite.load_precedent_questions() if q["expect"].get("evidence")]


def _searched(question: dict) -> list[str]:
    """The documents the fixture search hands back for the question as asked: the tool's default scope and limit.

    Token channel only (no embedder): deterministic, and what a CI machine has.
    """
    office = FixtureOffice(scenario=question.get("scenario") or "default")
    return [hit["documentId"] for hit in office.search({"query": question["question"], "scope": "similar"})["hits"]]


def _inverted(real):
    """A ranking that is wrong the other way round: the worst passage first, its score the lowest."""

    def rank(self, query, texts):
        return [
            (index, -score, None if rel is None else -rel) for index, score, rel in reversed(real(self, query, texts))
        ]

    return rank


class TestTheFixtureOfficeIsLargeEnoughToTestRanking:
    def test_the_office_holds_enough_projects_and_passages_that_a_search_must_choose(self):
        office = FixtureOffice()
        documents = [d for project in office.projects.values() for d in project["documents"]]

        assert len(office.projects) >= 20 and len(documents) >= 70
        first_page = office.search({"query": "Auflagen", "scope": "similar"})
        assert first_page["projectsSearched"] == 8 and first_page["nextOffset"] == 8

    def test_the_first_page_alone_holds_far_more_passages_than_a_search_returns(self):
        for scenario in ("default", "wien-bestand"):
            office = FixtureOffice(scenario=scenario)
            page = [office.projects[pid] for pid in office.rendered["similarOrder"][:8]]

            assert sum(len(project["documents"]) for project in page) >= 3 * 10, scenario

    def test_every_question_with_a_lookup_and_a_project_names_its_evidence(self):
        needing = {
            q["id"]
            for q in suite.load_precedent_questions()
            if q["expect"].get("lookup") == "required" and q["expect"].get("cites") and not q["expect"].get("evidence")
        }

        assert needing == NEEDS_THE_EMBEDDER

    def test_the_evidence_is_a_passage_of_the_project_the_question_cites_and_on_its_first_page(self):
        for question in _with_evidence():
            office = FixtureOffice(scenario=question.get("scenario") or "default")
            first_page = office.rendered["similarOrder"][:8]
            for document_id in question["expect"]["evidence"]:
                owner = next(
                    p for p in office.projects.values() if any(d["documentId"] == document_id for d in p["documents"])
                )
                cited = [
                    suite._normal(option) in suite._normal(owner["name"])
                    for g in question["expect"]["cites"]
                    for option in g
                ]
                assert any(cited), (question["id"], document_id)
                assert owner["id"] in first_page, (question["id"], document_id)

    def test_the_real_ranking_brings_the_evidence_into_the_hits(self):
        """Among the 30 and more passages of the first page, ten are returned: the answering one must be among them."""
        missed = [q["id"] for q in _with_evidence() if not set(q["expect"]["evidence"]) & set(_searched(q))]

        assert missed == []

    def test_inverted_scores_lose_nearly_all_of_it(self, monkeypatch):
        """The revert-check of the scores: passages merge by score, so a search that scores badly must fail here."""
        monkeypatch.setattr(FixtureOffice, "_rank", _inverted(FixtureOffice._rank))

        kept = [q["id"] for q in _with_evidence() if set(q["expect"]["evidence"]) & set(_searched(q))]

        assert len(kept) <= len(_with_evidence()) // 4, kept
