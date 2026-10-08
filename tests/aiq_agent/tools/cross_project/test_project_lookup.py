"""``project_lookup`` (ADR-0093): what it sends, what it renders, what it admits.

The HTTP call is the only thing faked. The tool, the grounding renderer, the
citation readers and the admission are the real ones, because what is under
test is the seam: the signed bytes leave unchanged; the bodies are the ones the
BFF's own schema accepts; a hit cites like any other source and names its
project; what the BFF handed out is admitted for the turn and shuts its doors;
a restricted collection of another project the BFF did NOT hand out is still
withheld; and the BFF's refusals reach the reader in its own words.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from langchain_core.messages import ToolMessage

from aiq_agent import project_context
from aiq_agent.common.citation_verification import _parse_knowledge_layer
from aiq_agent.common.citation_verification import extract_sources_from_tool_result
from aiq_agent.common.grounding_block import begin_grounding_capture
from aiq_agent.common.grounding_block import end_grounding_capture
from aiq_agent.knowledge import restricted_use
from aiq_agent.knowledge.restricted_use import COLLECTIONS_READ_KEY
from aiq_agent.knowledge.restricted_use import WITHHELD_NOTICE
from aiq_agent.knowledge.restricted_use import CrossProjectTurn
from aiq_agent.knowledge.restricted_use import admit_tool_results
from aiq_agent.knowledge.restricted_use import bind_cross_project_turn
from aiq_agent.knowledge.restricted_use import may_name
from aiq_agent.knowledge.restricted_use import reset_cross_project_turn
from aiq_agent.tools.cross_project import register as lookup
from aiq_agent.tools.cross_project.client import CrossProjectLookupError
from aiq_agent.tools.documents.filing import SignedEnvelope
from aiq_agent.turn.response import answer_message_id

SCHEMA_PATH = (
    Path(__file__).resolve().parents[4] / "frontends" / "ui" / "tests" / "fixtures" / "cross-project.schema.json"
)

HEADER, SIGNATURE = "eyJzaWduZWQiOiJ0dXJuIn0", "c0ffee"
OTHER = "22222222-0000-4000-8000-000000000002"
OTHER_COLLECTION = "proj_22222222"
HONORARE = f"{OTHER_COLLECTION}_rabcdef012345"


def _hit(filename: str, collection: str = OTHER_COLLECTION, **extra: Any) -> dict[str, Any]:
    return {
        "project": {"id": OTHER, "name": "Wohnbau Graz", "status": "closed", "bundesland": "steiermark"},
        "documentId": "doc-1",
        "filename": filename,
        "title": None,
        "collection": collection,
        "page": 3,
        "snippet": "Die Traufe ist hinterlüftet ausgeführt, Konterlattung 5/8 …",
        "score": 0.81,
        "tags": ["Detail"],
        "uploadedAt": "2026-05-01T08:00:00.000Z",
        **extra,
    }


SEARCH_BODY = {
    "decisions": [],
    "permits": [],
    "hits": [_hit("Detail Traufe.pdf"), _hit("Honorar.pdf", HONORARE)],
    "projectsInScope": 12,
    "projectsSearched": 8,
    "nextOffset": 8,
    "statusKnown": True,
}


@pytest.fixture
def calls(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict[str, Any], SignedEnvelope]]:
    seen: list[tuple[str, dict[str, Any], SignedEnvelope]] = []
    monkeypatch.setattr(project_context, "get_request_envelope_from_context", lambda: (HEADER, SIGNATURE))
    return seen


def _answering(monkeypatch, calls, body: dict[str, Any] | Exception) -> None:
    def fake(path: str, payload: dict[str, Any], envelope: SignedEnvelope) -> dict[str, Any]:
        calls.append((path, payload, envelope))
        if isinstance(body, Exception):
            raise body
        return body

    monkeypatch.setattr(lookup, "post_lookup", fake)


@pytest.fixture
def turn():
    bound = CrossProjectTurn()
    token = bind_cross_project_turn(bound)
    capture = begin_grounding_capture()
    yield bound
    end_grounding_capture(capture)
    reset_cross_project_turn(token)


@pytest.fixture(scope="module")
def schema() -> dict[str, Any]:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def _validator(schema: dict[str, Any], name: str) -> Draft202012Validator:
    return Draft202012Validator({**schema["$defs"][name], "$defs": schema["$defs"]})


class TestWhatItSends:
    async def test_it_echoes_the_envelope_unchanged(self, monkeypatch, calls, turn) -> None:
        _answering(monkeypatch, calls, SEARCH_BODY)

        await lookup.run_project_lookup("search", query="Traufe Holzbau")

        assert calls[0][2] == SignedEnvelope(header=HEADER, signature=SIGNATURE)

    async def test_a_run_with_no_envelope_looks_up_nothing(self, monkeypatch, calls, turn) -> None:
        monkeypatch.setattr(project_context, "get_request_envelope_from_context", lambda: (None, None))
        _answering(monkeypatch, calls, SEARCH_BODY)

        result = await lookup.run_project_lookup("search", query="Traufe")

        assert "Sitzungsnachweis" in result
        assert calls == []
        assert not turn.drew_on_others

    async def test_every_body_is_one_the_bffs_own_schema_accepts(self, monkeypatch, calls, turn, schema) -> None:
        _answering(monkeypatch, calls, SEARCH_BODY)
        await lookup.run_project_lookup(
            "search",
            query="Dachdetail",
            scope="named",
            project_ids=[OTHER],
            document_types=["Detail"],
            disciplines=["Brandschutz"],
            period_from="2019-01-01",
            period_to="2022-12-31",
            offset=8,
        )
        _answering(monkeypatch, calls, {"projects": [], "total": 0, "statusKnown": False})
        await lookup.run_project_lookup("find", query="Graz", period_from="2020-01-01")
        _answering(monkeypatch, calls, {"project": {}, "summary": None, "facts": ""})
        await lookup.run_project_lookup("brief", project_id=OTHER)

        by_path = {path: payload for path, payload, _ in calls}
        _validator(schema, "CrossProjectSearchRequest").validate(by_path["/api/internal/cross-project/search"])
        _validator(schema, "CrossProjectListRequest").validate(by_path["/api/internal/cross-project/projects"])
        _validator(schema, "CrossProjectBriefRequest").validate(by_path["/api/internal/cross-project/brief"])
        assert by_path["/api/internal/cross-project/search"]["from"] == "2019-01-01"

    async def test_every_body_names_the_answer_this_turn_writes(self, monkeypatch, calls, turn, schema) -> None:
        # The BFF marks that answer with the hand-out (ADR-0092); the id is the
        # one the turn streams and persists the answer under.
        monkeypatch.setattr(project_context, "get_conversation_id_from_context", lambda: "s_conv_1")
        monkeypatch.setattr(project_context, "get_user_message_id_from_context", lambda: "m_user_7")
        _answering(monkeypatch, calls, SEARCH_BODY)
        await lookup.run_project_lookup("search", query="Dachdetail")
        _answering(monkeypatch, calls, {"projects": [], "total": 0, "statusKnown": False})
        await lookup.run_project_lookup("find", query="Graz")
        _answering(monkeypatch, calls, {"project": {}, "summary": None, "facts": ""})
        await lookup.run_project_lookup("brief", project_id=OTHER)

        expected = answer_message_id("s_conv_1", "m_user_7")
        assert [payload.get("answerMessageId") for _, payload, _ in calls] == [expected] * 3
        by_path = {path: payload for path, payload, _ in calls}
        _validator(schema, "CrossProjectSearchRequest").validate(by_path["/api/internal/cross-project/search"])

    async def test_a_run_with_no_conversation_names_no_answer(self, monkeypatch, calls, turn) -> None:
        monkeypatch.setattr(project_context, "get_conversation_id_from_context", lambda: None)
        _answering(monkeypatch, calls, SEARCH_BODY)

        await lookup.run_project_lookup("search", query="Dachdetail")

        assert "answerMessageId" not in calls[0][1]

    async def test_open_folders_only_reaches_the_body_the_bffs_own_schema_accepts(
        self, monkeypatch, calls, turn, schema
    ) -> None:
        _answering(monkeypatch, calls, SEARCH_BODY)

        await lookup.run_project_lookup("search", query="Traufe", scope="closed", open_folders_only=True)
        await lookup.run_project_lookup("search", query="Traufe", scope="closed")

        (_, narrowed, _), (_, plain, _) = calls
        assert narrowed["openFoldersOnly"] is True
        assert "openFoldersOnly" not in plain
        _validator(schema, "CrossProjectSearchRequest").validate(narrowed)

    async def test_it_asks_for_what_it_needs_before_calling(self, monkeypatch, calls, turn) -> None:
        _answering(monkeypatch, calls, SEARCH_BODY)

        assert "`query`" in await lookup.run_project_lookup("search")
        assert "`project_ids`" in await lookup.run_project_lookup("search", query="x", scope="named")
        assert "`project_id`" in await lookup.run_project_lookup("brief")
        assert calls == []


class TestTheSearchAnswer:
    @pytest.mark.parametrize(
        ("ours", "line"),
        [
            ("wien", "Bundesland: Steiermark — nicht das Bundesland dieses Projekts: dort gilt eine andere Bauordnung"),
            ("steiermark", "Bundesland: Steiermark\n"),
            (None, "Bundesland: Steiermark\n"),
        ],
    )
    async def test_a_hit_says_its_land_and_warns_when_it_is_not_this_projects(
        self, monkeypatch, calls, turn, ours, line
    ) -> None:
        """A precedent from another Land was decided under another Bauordnung: the tool says so, not the model."""
        context = None if ours is None else type("Context", (), {"bundesland": ours})()
        monkeypatch.setattr(project_context, "get_signed_request_context", lambda: context)
        _answering(monkeypatch, calls, {**SEARCH_BODY, "hits": [_hit("Detail Traufe.pdf")]})

        result = await lookup.run_project_lookup("search", query="Traufe")

        assert line in result
        if ours != "wien":
            assert "andere Bauordnung" not in result

    async def test_a_project_without_a_land_gets_no_land_line(self, monkeypatch, calls, turn) -> None:
        hit = _hit("Detail Traufe.pdf")
        hit["project"] = {**hit["project"], "bundesland": None}
        _answering(monkeypatch, calls, {**SEARCH_BODY, "hits": [hit]})

        assert "Bundesland:" not in await lookup.run_project_lookup("search", query="Traufe")

    async def test_a_hit_cites_like_any_source_and_names_its_project(self, monkeypatch, calls, turn) -> None:
        _answering(monkeypatch, calls, SEARCH_BODY)

        result = await lookup.run_project_lookup("search", query="Traufe")

        assert "Projekt: Wohnbau Graz — abgeschlossen (project_id 22222222-0000-4000-8000-000000000002)" in result
        assert "Citation: Detail Traufe.pdf (Wohnbau Graz), p.3" in result
        assert "offset=8" in result
        assert "kein Projektgedächtnis" in result
        entry = next(
            e
            for e in extract_sources_from_tool_result("project_lookup", result)
            if e.citation_key == "Detail Traufe.pdf (Wohnbau Graz), p.3"
        )
        assert (entry.project_id, entry.project_name, entry.project_status) == (OTHER, "Wohnbau Graz", "closed")
        assert entry.collection == OTHER_COLLECTION

    async def test_the_text_reader_reads_the_project_back_as_the_record_does(self, monkeypatch, calls, turn) -> None:
        _answering(monkeypatch, calls, SEARCH_BODY)
        result = await lookup.run_project_lookup("search", query="Traufe")

        # A replayed turn holds the text without the records: the registered parser reads it.
        replayed = _parse_knowledge_layer(result, "project_lookup")

        assert [(e.project_id, e.project_name, e.project_status) for e in replayed] == [
            (OTHER, "Wohnbau Graz", "closed"),
            (OTHER, "Wohnbau Graz", "closed"),
        ]

    async def test_a_closed_projects_open_folder_is_admitted_and_shuts_no_door(self, monkeypatch, calls, turn) -> None:
        _answering(monkeypatch, calls, {**SEARCH_BODY, "hits": [_hit("Detail Traufe.pdf")], "nextOffset": None})

        result = await lookup.run_project_lookup("search", query="Traufe", scope="closed")

        assert turn.admitted == {OTHER_COLLECTION}
        assert not turn.drew_on_others
        assert "laufende andere Projekte" not in result

    async def test_a_running_projects_passage_shuts_the_doors(self, monkeypatch, calls, turn) -> None:
        running = _hit(
            "Detail Attika.pdf",
            project={"id": OTHER, "name": "Schule Linz", "status": "active", "bundesland": "oberoesterreich"},
        )
        _answering(monkeypatch, calls, {**SEARCH_BODY, "hits": [running], "nextOffset": None})

        result = await lookup.run_project_lookup("search", query="Attika")

        assert turn.drew_on_others
        assert "laufende andere Projekte" in result

    async def test_the_default_scope_is_the_most_similar_projects(self, monkeypatch, calls, turn) -> None:
        _answering(monkeypatch, calls, SEARCH_BODY)

        await lookup.run_project_lookup("search", query="Traufe")

        assert calls[0][1]["scope"] == "similar"

    async def test_a_changed_audience_is_refused_in_the_bffs_own_words(self, monkeypatch, calls, turn) -> None:
        sentence = "Wer diese Unterhaltung lesen darf, hat sich gerade geändert. Fragen Sie bitte noch einmal."
        _answering(
            monkeypatch, calls, CrossProjectLookupError(sentence, status=409, code="CROSS_PROJECT_AUDIENCE_CHANGED")
        )

        result = await lookup.run_project_lookup("search", query="Traufe")

        assert result == f"Nicht möglich: {sentence}"
        assert not turn.drew_on_others

    async def test_a_project_out_of_reach_reads_as_not_found(self, monkeypatch, calls, turn) -> None:
        _answering(monkeypatch, calls, CrossProjectLookupError("Not found", status=404))

        assert "`find`" in await lookup.run_project_lookup("brief", project_id=OTHER)


# Module-level: the collection-read inventory names it as the tool's proof. The
# answer holds a restricted folder of the (closed) project: that narrows the
# chat's readers, closed or not, so the doors shut.
async def test_project_lookup_admits_what_the_bff_handed_out_and_shuts_the_turns_doors(
    monkeypatch, calls, turn
) -> None:
    _answering(monkeypatch, calls, SEARCH_BODY)
    result = await lookup.run_project_lookup("search", query="Traufe")
    message = ToolMessage(content=result, tool_call_id="c1", response_metadata={COLLECTIONS_READ_KEY: [HONORARE]})

    [admitted] = await admit_tool_results([message])

    assert admitted.content == result
    assert turn.drew_on_others
    assert may_name(HONORARE)


def _decision(content: str, *, status: str = "closed", restricted: bool = False, **extra: Any) -> dict[str, Any]:
    return {
        "project": {"id": OTHER, "name": "Wohnbau Graz", "status": status, "bundesland": "steiermark"},
        "collection": OTHER_COLLECTION,
        "kind": "decision",
        "content": content,
        "confirmed": True,
        "recordedAt": "2021-04-02T08:00:00.000Z",
        "restricted": restricted,
        **extra,
    }


def _permit(*, status: str = "closed", restricted: bool = False, **extra: Any) -> dict[str, Any]:
    return {
        "project": {"id": OTHER, "name": "Wohnbau Graz", "status": status, "bundesland": "steiermark"},
        "collection": OTHER_COLLECTION,
        "fileName": "Baubescheid_Baden_2020.pdf",
        "kind": "nachforderung",
        "authority": "Stadtgemeinde Baden",
        "municipality": "Baden",
        "issuedOn": "2020-03-12",
        "reference": "BA-123/2020",
        "requirements": [
            {
                "kind": "nachforderung",
                "content": "Ein Brandschutzgutachten ist vorzulegen.",
                "evidence": "Gutachten eines Sachverständigen",
                "legalBasis": "§ 13 Abs. 3 AVG",
                "page": 2,
            },
            {
                "kind": "hinweis",
                "content": "Die Frist beträgt vier Wochen.",
                "evidence": None,
                "legalBasis": None,
                "page": None,
            },
        ],
        "restricted": restricted,
        **extra,
    }


class TestThePermitRecords:
    async def test_each_is_one_citable_source_on_the_document_between_decisions_and_passages(
        self, monkeypatch, calls, turn, schema
    ) -> None:
        body = {**SEARCH_BODY, "decisions": [_decision("Stiegenhaus in Stahlbeton.")], "permits": [_permit()]}
        _validator(schema, "CrossProjectSearchResponse").validate(body)
        _answering(monkeypatch, calls, body)

        result = await lookup.run_project_lookup("search", query="Brandschutzgutachten")
        sources = extract_sources_from_tool_result("project_lookup", result)

        assert [s.citation_key for s in sources[:3]] == [
            "Projektgedächtnis (Wohnbau Graz)",
            "Baubescheid_Baden_2020.pdf (Wohnbau Graz), p.2",
            "Detail Traufe.pdf (Wohnbau Graz), p.3",
        ]
        permit = sources[1]
        assert (permit.project_id, permit.project_name, permit.project_status) == (OTHER, "Wohnbau Graz", "closed")
        assert permit.collection == OTHER_COLLECTION
        assert "Source: Nachforderung – Stadtgemeinde Baden, 12.03.2020" in result
        assert "Projekt: Wohnbau Graz — abgeschlossen" in result
        assert "Bundesland: Steiermark" in result
        assert "Verfahren: Gemeinde Baden, Geschäftszahl BA-123/2020" in result
        assert (
            "Nachforderung (S. 2): Ein Brandschutzgutachten ist vorzulegen. "
            "Nachweis: Gutachten eines Sachverständigen Rechtsgrundlage: § 13 Abs. 3 AVG"
        ) in result
        assert "Hinweis: Die Frist beträgt vier Wochen." in result
        assert "1 Bescheid(e)" in result

    async def test_the_text_reader_reads_the_permit_back_as_the_record_does(self, monkeypatch, calls, turn) -> None:
        _answering(monkeypatch, calls, {**SEARCH_BODY, "hits": [], "permits": [_permit()]})
        result = await lookup.run_project_lookup("search", query="Brandschutzgutachten")

        replayed = _parse_knowledge_layer(result, "project_lookup")

        assert [(e.citation_key, e.project_id, e.project_status) for e in replayed] == [
            ("Baubescheid_Baden_2020.pdf (Wohnbau Graz), p.2", OTHER, "closed")
        ]

    async def test_a_record_without_a_page_is_cited_by_its_file_alone(self, monkeypatch, calls, turn) -> None:
        unpaged = _permit(
            requirements=[{"kind": "auflage", "content": "x", "evidence": None, "legalBasis": None, "page": None}]
        )
        _answering(monkeypatch, calls, {**SEARCH_BODY, "hits": [], "permits": [unpaged]})

        result = await lookup.run_project_lookup("search", query="x")

        assert [s.citation_key for s in extract_sources_from_tool_result("project_lookup", result)] == [
            "Baubescheid_Baden_2020.pdf (Wohnbau Graz)"
        ]

    async def test_permits_alone_are_still_a_source_so_the_answer_is_not_replaced(
        self, monkeypatch, calls, turn
    ) -> None:
        _answering(monkeypatch, calls, {**SEARCH_BODY, "hits": [], "permits": [_permit()]})

        result = await lookup.run_project_lookup("search", query="Brandschutzgutachten")

        assert "Keine passenden" not in result
        assert len(extract_sources_from_tool_result("project_lookup", result)) == 1
        assert turn.admitted == {OTHER_COLLECTION}

    async def test_nothing_found_says_so_for_permits_too(self, monkeypatch, calls, turn) -> None:
        _answering(monkeypatch, calls, {**SEARCH_BODY, "hits": []})

        result = await lookup.run_project_lookup("search", query="x")

        assert "Keine passenden Dokumente, Entscheidungen oder Bescheide" in result

    async def test_a_closed_projects_open_permit_shuts_no_door(self, monkeypatch, calls, turn) -> None:
        _answering(monkeypatch, calls, {**SEARCH_BODY, "hits": [], "permits": [_permit()]})

        result = await lookup.run_project_lookup("search", query="x")

        assert not turn.drew_on_others
        assert "laufende andere Projekte" not in result

    @pytest.mark.parametrize(
        "permit",
        [{"status": "active"}, {"restricted": True}, {"collection": HONORARE}],
        ids=["running project", "restricted folder flag", "restricted folder collection"],
    )
    async def test_a_running_projects_or_a_restricted_permit_shuts_the_doors(
        self, monkeypatch, calls, turn, permit
    ) -> None:
        _answering(monkeypatch, calls, {**SEARCH_BODY, "hits": [], "permits": [_permit(**permit)]})

        result = await lookup.run_project_lookup("search", query="x")

        assert turn.drew_on_others
        assert "laufende andere Projekte" in result

    async def test_a_record_missing_what_a_citation_needs_is_dropped(self, monkeypatch, calls, turn) -> None:
        _answering(monkeypatch, calls, {**SEARCH_BODY, "hits": [], "permits": [_permit(fileName="")]})

        result = await lookup.run_project_lookup("search", query="x")

        assert "Keine passenden" in result

    async def test_a_notice_without_its_authority_is_titled_by_kind_and_date_and_still_cited(
        self, monkeypatch, calls, turn, schema
    ) -> None:
        body = {**SEARCH_BODY, "hits": [], "permits": [_permit(authority=None)]}
        _validator(schema, "CrossProjectSearchResponse").validate(body)
        _answering(monkeypatch, calls, body)

        result = await lookup.run_project_lookup("search", query="Brandschutzgutachten")
        sources = extract_sources_from_tool_result("project_lookup", result)

        assert "Source: Nachforderung, 12.03.2020" in result
        assert [s.citation_key for s in sources] == ["Baubescheid_Baden_2020.pdf (Wohnbau Graz), p.2"]
        assert "Verfahren: Gemeinde Baden, Geschäftszahl BA-123/2020" in result

    async def test_a_record_longer_than_the_cap_is_cut_and_marked_as_truncated(self, monkeypatch, calls, turn) -> None:
        long_requirements = [
            {
                "kind": "auflage",
                "content": f"Auflage {n:02d} " + "x" * 300,
                "evidence": None,
                "legalBasis": None,
                "page": 1,
            }
            for n in range(12)
        ]
        _answering(
            monkeypatch, calls, {**SEARCH_BODY, "hits": [], "permits": [_permit(requirements=long_requirements)]}
        )

        result = await lookup.run_project_lookup("search", query="x")

        assert "Auflage 00" in result
        assert "Auflage 11" not in result
        assert "... [truncated]" in result

    async def test_a_short_record_is_not_marked_as_truncated(self, monkeypatch, calls, turn) -> None:
        _answering(monkeypatch, calls, {**SEARCH_BODY, "hits": [], "permits": [_permit()]})

        result = await lookup.run_project_lookup("search", query="Brandschutzgutachten")

        assert "[truncated]" not in result

    @pytest.mark.parametrize(
        ("length", "cut"),
        [(lookup.PERMIT_BODY_MAX_CHARS, False), (lookup.PERMIT_BODY_MAX_CHARS + 1, True)],
        ids=["exactly the cap", "one over"],
    )
    def test_the_cap_is_inclusive_and_a_cut_body_is_at_most_the_cap(self, length: int, cut: bool) -> None:
        body, truncated = lookup._capped_body("a" * length)

        assert truncated is cut
        assert len(body) <= lookup.PERMIT_BODY_MAX_CHARS


class TestTheRecordedDecisions:
    async def test_they_come_first_as_one_citable_source_per_project_named_by_its_project(
        self, monkeypatch, calls, turn, schema
    ) -> None:
        body = {
            **SEARCH_BODY,
            "decisions": [
                _decision("Stiegenhaus in Stahlbeton, weil das Gutachten nur so die Abweichung zuließ."),
                _decision("Brandsperre je Geschoß in der Hinterlüftung.", kind="constraint", confirmed=False),
            ],
        }
        _validator(schema, "CrossProjectSearchResponse").validate(body)
        _answering(monkeypatch, calls, body)

        result = await lookup.run_project_lookup("search", query="Stiegenhaus")
        sources = extract_sources_from_tool_result("project_lookup", result)

        assert sources[0].citation_key == "Projektgedächtnis (Wohnbau Graz)"
        assert sources[0].project_name == "Wohnbau Graz"
        assert "Entscheidung (von einer Person bestätigt, 2021): Stiegenhaus in Stahlbeton" in result
        assert "Vorgabe (von Piloti festgehalten, 2021): Brandsperre" in result
        assert result.index("Projektgedächtnis") < result.index("Detail Traufe.pdf")

    async def test_decisions_alone_are_still_a_source_so_the_answer_is_not_replaced(self, monkeypatch, calls, turn):
        _answering(monkeypatch, calls, {**SEARCH_BODY, "hits": [], "decisions": [_decision("Holz-Massivbau-Treppe.")]})

        result = await lookup.run_project_lookup("search", query="Treppe")

        assert len(extract_sources_from_tool_result("project_lookup", result)) == 1
        assert turn.admitted == {OTHER_COLLECTION}

    async def test_a_closed_projects_open_decision_shuts_no_door(self, monkeypatch, calls, turn):
        _answering(monkeypatch, calls, {**SEARCH_BODY, "hits": [], "decisions": [_decision("x")]})

        await lookup.run_project_lookup("search", query="x")

        assert not turn.drew_on_others

    @pytest.mark.parametrize("decision", [{"status": "active"}, {"restricted": True}])
    async def test_a_running_projects_or_a_restricted_decision_shuts_the_doors(
        self, monkeypatch, calls, turn, decision
    ):
        _answering(monkeypatch, calls, {**SEARCH_BODY, "hits": [], "decisions": [_decision("x", **decision)]})

        result = await lookup.run_project_lookup("search", query="x")

        assert turn.drew_on_others
        assert "laufende andere Projekte" in result


class TestTheAdmission:
    async def test_another_projects_restricted_collection_not_handed_out_is_withheld(self, turn) -> None:
        stray = ToolMessage(content=f"Aus {HONORARE}: Honorar 48.000 €", tool_call_id="c2")

        [withheld] = await admit_tool_results([stray])

        assert withheld.content == WITHHELD_NOTICE
        assert not may_name(HONORARE)

    async def test_without_a_bound_turn_nothing_is_admitted(self) -> None:
        restricted_use.note_cross_project_hand_out([HONORARE], restricting=True)
        stray = ToolMessage(content=f"Aus {HONORARE}", tool_call_id="c3")

        [withheld] = await admit_tool_results([stray])

        assert withheld.content == WITHHELD_NOTICE


class TestFindAndBrief:
    async def test_find_lists_status_period_and_address_and_hands_out_only_other_projects(
        self, monkeypatch, calls, turn
    ) -> None:
        own = {
            "id": "own",
            "name": "Dieses",
            "status": "active",
            "bundesland": "niederoesterreich",
            "collection": "proj_own",
            "address": None,
            "period": {"start": "2026-01-01", "end": None},
            "current": True,
        }
        other = {
            "id": OTHER,
            "name": "Wohnbau Graz",
            "status": "closed",
            "bundesland": "steiermark",
            "collection": OTHER_COLLECTION,
            "address": "Hauptstraße 3, Graz",
            "period": {"start": "2019-03-01", "end": "2021-06-30"},
            "current": False,
        }
        _answering(monkeypatch, calls, {"projects": [own, other], "total": 2, "statusKnown": True})

        result = await lookup.run_project_lookup("find", query="Graz")

        assert "- Wohnbau Graz — abgeschlossen · 2019-03-01 bis 2021-06-30 · Hauptstraße 3, Graz (project_id" in result
        assert "das Projekt dieses Chats" in result
        assert turn.admitted == {OTHER_COLLECTION}
        # A closed project: every office member reads it, so naming it shuts nothing.
        assert not turn.drew_on_others

    async def test_find_naming_a_running_project_shuts_the_doors(self, monkeypatch, calls, turn) -> None:
        running = {
            "id": OTHER,
            "name": "Schule Linz",
            "status": "active",
            "bundesland": "oberoesterreich",
            "collection": OTHER_COLLECTION,
            "address": None,
            "period": {"start": "2026-01-01", "end": None},
            "current": False,
        }
        _answering(monkeypatch, calls, {"projects": [running], "total": 1, "statusKnown": True})

        result = await lookup.run_project_lookup("find", query="Linz")

        assert turn.drew_on_others
        assert "laufende andere Projekte" in result

    async def test_the_chats_own_project_alone_shuts_no_door(self, monkeypatch, calls, turn) -> None:
        own = {
            "id": "own",
            "name": "Dieses",
            "status": "active",
            "bundesland": "niederoesterreich",
            "collection": "proj_own",
            "address": None,
            "period": {"start": "2026-01-01", "end": None},
            "current": True,
        }
        _answering(monkeypatch, calls, {"project": own, "summary": "Ein Schulbau.", "facts": "confirmed:\n- x=y"})

        result = await lookup.run_project_lookup("brief", project_id="own")

        assert "Zusammenfassung: Ein Schulbau." in result
        assert not turn.drew_on_others


class TestTheWire:
    """What the browser is told about a source from another project (ADR-0093)."""

    def _entry(self):
        from aiq_agent.common.citation_verification import SourceEntry

        return SourceEntry(
            citation_key="Detail Traufe.pdf (Wohnbau Graz), p.3",
            title="Detail Traufe",
            source_type="knowledge_layer",
            tool_name="project_lookup",
            collection=OTHER_COLLECTION,
            shelf="project",
            chunk_text="Die Traufe ist hinterlüftet ausgeführt.",
            project_id=OTHER,
            project_name="Wohnbau Graz",
            project_status="closed",
        )

    def test_the_cited_wire_names_the_project_and_the_real_file(self) -> None:
        from aiq_agent.common.citation_verification import source_entry_to_wire

        wire = source_entry_to_wire(self._entry(), number=1)

        assert wire["project"] == {"id": OTHER, "name": "Wohnbau Graz", "status": "closed"}
        # The key names the project after the file; the file is called Detail Traufe.pdf.
        assert wire["file_name"] == "Detail Traufe.pdf"
        assert wire["page"] == 3

    def test_the_read_wire_keeps_the_project_and_a_source_of_the_chat_names_none(self) -> None:
        from dataclasses import replace

        from aiq_agent.common.citation_verification import read_source_to_wire
        from aiq_agent.common.citation_verification import source_entry_to_wire

        assert read_source_to_wire(self._entry())["project"]["id"] == OTHER
        own = replace(
            self._entry(), citation_key="Plan.pdf, p.1", project_id=None, project_name=None, project_status=None
        )
        assert "project" not in source_entry_to_wire(own)
