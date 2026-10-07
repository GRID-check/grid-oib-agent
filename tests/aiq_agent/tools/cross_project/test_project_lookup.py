"""``project_lookup`` (ADR-0082): what it sends, what it renders, what it admits.

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

SCHEMA_PATH = (
    Path(__file__).resolve().parents[4] / "frontends" / "ui" / "tests" / "fixtures" / "cross-project.schema.json"
)

HEADER, SIGNATURE = "eyJzaWduZWQiOiJ0dXJuIn0", "c0ffee"
OTHER = "22222222-0000-4000-8000-000000000002"
OTHER_COLLECTION = "proj_22222222"
HONORARE = f"{OTHER_COLLECTION}_rabcdef012345"


def _hit(filename: str, collection: str = OTHER_COLLECTION, **extra: Any) -> dict[str, Any]:
    return {
        "project": {"id": OTHER, "name": "Wohnbau Graz", "status": "closed"},
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
    "hits": [_hit("Detail Traufe.pdf"), _hit("Honorar.pdf", HONORARE)],
    "projectsInScope": 12,
    "projectsSearched": 8,
    "nextOffset": 8,
    "statusKnown": False,
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

    async def test_it_asks_for_what_it_needs_before_calling(self, monkeypatch, calls, turn) -> None:
        _answering(monkeypatch, calls, SEARCH_BODY)

        assert "`query`" in await lookup.run_project_lookup("search")
        assert "`project_ids`" in await lookup.run_project_lookup("search", query="x", scope="named")
        assert "`project_id`" in await lookup.run_project_lookup("brief")
        assert calls == []


class TestTheSearchAnswer:
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

    async def test_the_closed_scope_says_status_is_not_recorded_yet(self, monkeypatch, calls, turn) -> None:
        _answering(monkeypatch, calls, {**SEARCH_BODY, "hits": [], "nextOffset": None})

        result = await lookup.run_project_lookup("search", query="Traufe", scope="closed")

        assert "noch nicht erfasst" in result
        assert not turn.drew_on_others

    async def test_a_shared_chat_is_refused_in_the_bffs_own_words(self, monkeypatch, calls, turn) -> None:
        sentence = "Die Suche über Projekte hinweg geht nur in einem Chat, der Ihnen allein gehört."
        _answering(monkeypatch, calls, CrossProjectLookupError(sentence, status=409, code="CROSS_PROJECT_SHARED_CHAT"))

        result = await lookup.run_project_lookup("search", query="Traufe")

        assert result == f"Nicht möglich: {sentence}"
        assert not turn.drew_on_others

    async def test_a_project_out_of_reach_reads_as_not_found(self, monkeypatch, calls, turn) -> None:
        _answering(monkeypatch, calls, CrossProjectLookupError("Not found", status=404))

        assert "project_id aus `find`" in await lookup.run_project_lookup("brief", project_id=OTHER)


# Module-level: the collection-read inventory names it as the tool's proof.
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


class TestTheAdmission:
    async def test_another_projects_restricted_collection_not_handed_out_is_withheld(self, turn) -> None:
        stray = ToolMessage(content=f"Aus {HONORARE}: Honorar 48.000 €", tool_call_id="c2")

        [withheld] = await admit_tool_results([stray])

        assert withheld.content == WITHHELD_NOTICE
        assert not may_name(HONORARE)

    async def test_without_a_bound_turn_nothing_is_admitted(self) -> None:
        restricted_use.note_cross_project_hand_out([HONORARE])
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
            "collection": "proj_own",
            "address": None,
            "period": {"start": "2026-01-01", "end": None},
            "current": True,
        }
        other = {
            "id": OTHER,
            "name": "Wohnbau Graz",
            "status": "closed",
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
        assert turn.drew_on_others

    async def test_the_chats_own_project_alone_shuts_no_door(self, monkeypatch, calls, turn) -> None:
        own = {
            "id": "own",
            "name": "Dieses",
            "status": "active",
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
    """What the browser is told about a source from another project (ADR-0082)."""

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
