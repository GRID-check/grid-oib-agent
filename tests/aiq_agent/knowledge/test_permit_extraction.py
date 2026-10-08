"""The pen of the permitting memory: a document's text in, a validated permit record out.

The model is the reader, so these tests pin the contract around it and never its
wording: the schema it is held to, what it is shown, and that no fault reaches
the ingest.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from langchain_core.messages import HumanMessage

from aiq_agent.knowledge import permit_extraction
from aiq_agent.knowledge.document_classification import DOCUMENT_TYPE_TAGS
from aiq_agent.knowledge.permit_extraction import MAX_REQUIREMENTS
from aiq_agent.knowledge.permit_extraction import MAX_TEXT_CHARS
from aiq_agent.knowledge.permit_extraction import PermitExtraction
from aiq_agent.knowledge.permit_extraction import extract_permit_record
from aiq_agent.knowledge.permit_extraction import is_bescheid
from aiq_agent.knowledge.permit_extraction import pages_with_markers

# docs/design/permitting-memory.md, "Contract": the kinds the tables' CHECK constraints allow.
CONTRACT_RECORD_KINDS = ["bewilligung", "nachforderung", "ablehnung", "sonstiges"]
CONTRACT_REQUIREMENT_KINDS = ["auflage", "nachforderung", "hinweis"]

FIXTURE = Path(__file__).resolve().parents[3] / "frontends/ui/tests/fixtures/precedent/office.json"


def _fixture_text(document_id: str) -> str:
    office = json.loads(FIXTURE.read_text(encoding="utf-8"))
    for project in office["projects"]:
        for document in project["documents"]:
            if document["documentId"] == document_id:
                return document["text"]
    raise AssertionError(document_id)


class FakeLLM:
    """Records the bound response_format and the messages; answers with ``reply``."""

    def __init__(self, reply: Any = None, raises: Exception | None = None):
        self.reply = reply
        self.raises = raises
        self.bound: dict[str, Any] = {}
        self.messages: list[Any] = []
        self.model_name = "fake/model"

    def bind(self, **kwargs: Any) -> FakeLLM:
        self.bound = kwargs
        return self

    def invoke(self, messages: list[Any]) -> SimpleNamespace:
        self.messages = messages
        if self.raises:
            raise self.raises
        content = self.reply if isinstance(self.reply, str) else json.dumps(self.reply)
        return SimpleNamespace(content=content)


def _record(**overrides: Any) -> dict[str, Any]:
    record = {
        "kind": "nachforderung",
        "authority": "Stadtgemeinde Mödling",
        "municipality": "Mödling",
        "bundesland": "niederoesterreich",
        "issued_on": "2019-06-18",
        "reference": None,
        "requirements": [
            {
                "kind": "nachforderung",
                "content": "Nachweis der lichten Breite der Fluchtwege von mindestens 1,20 m.",
                "evidence": "Bemaßte Grundrisse aller Geschoße",
                "legal_basis": "§ 13 Abs. 3 AVG",
                "page": 1,
            }
        ],
    }
    return {"record": {**record, **overrides}}


def test_a_structured_reply_becomes_a_validated_record():
    llm = FakeLLM(_record())

    record = extract_permit_record(_fixture_text("doc-moedling-nachforderung"), llm, file_name="m.pdf")

    assert record is not None
    assert (record.kind, record.authority, record.bundesland, record.issued_on) == (
        "nachforderung",
        "Stadtgemeinde Mödling",
        "niederoesterreich",
        "2019-06-18",
    )
    assert record.requirements[0].legal_basis == "§ 13 Abs. 3 AVG"
    assert record.to_wire()["requirements"][0]["legalBasis"] == "§ 13 Abs. 3 AVG"
    assert record.to_wire()["issuedOn"] == "2019-06-18"


def test_a_null_record_is_the_models_answer_that_this_is_no_notice():
    assert extract_permit_record("Ein Vertrag.", FakeLLM({"record": None}), file_name="v.pdf") is None


def test_the_call_demands_a_strict_json_schema():
    llm = FakeLLM(_record())
    extract_permit_record("Text", llm, file_name="m.pdf")

    json_schema = llm.bound["response_format"]["json_schema"]
    assert json_schema["strict"] is True
    assert json_schema["schema"]["additionalProperties"] is False


def test_the_schema_kinds_are_the_contracts():
    schema = PermitExtraction.model_json_schema()
    assert schema["$defs"]["PermitRecord"]["properties"]["kind"]["enum"] == CONTRACT_RECORD_KINDS
    assert schema["$defs"]["PermitRequirement"]["properties"]["kind"]["enum"] == CONTRACT_REQUIREMENT_KINDS


def test_every_field_is_required_for_strict_mode():
    schema = PermitExtraction.model_json_schema()
    for name in ("PermitRecord", "PermitRequirement"):
        definition = schema["$defs"][name]
        assert set(definition["required"]) == set(definition["properties"])


@pytest.mark.parametrize(
    "reply",
    [
        "this is not json",
        "[1, 2]",
        {"record": {"kind": "genehmigung", "authority": "MA 37", "requirements": []}},
        {"record": {**_record()["record"], "bundesland": "bayern"}},
        {"record": {**_record()["record"], "unexpected": 1}},
        {"unrelated": True},
    ],
)
def test_a_reply_that_does_not_fit_returns_none(reply, caplog):
    with caplog.at_level("WARNING"):
        assert extract_permit_record("Text", FakeLLM(reply), file_name="m.pdf") is None
    assert any(r.levelname == "WARNING" for r in caplog.records)


def test_a_provider_fault_returns_none_and_never_raises(caplog):
    with caplog.at_level("WARNING"):
        record = extract_permit_record("Text", FakeLLM(raises=RuntimeError("503")), file_name="m.pdf")
    assert record is None
    assert any("503" in r.getMessage() for r in caplog.records)


def test_empty_text_asks_nothing():
    llm = FakeLLM(_record())
    assert extract_permit_record("  \n", llm, file_name="m.pdf") is None
    assert llm.messages == []


def test_a_date_in_another_format_costs_the_date_and_nothing_else():
    record = extract_permit_record("Text", FakeLLM(_record(issued_on="18. Juni 2019")), file_name="m.pdf")
    assert record is not None and record.issued_on is None and record.requirements


def test_an_overlong_item_is_clipped_and_the_list_is_bounded():
    items = [{**_record()["record"]["requirements"][0], "content": "x" * 1500} for _ in range(MAX_REQUIREMENTS + 5)]
    record = extract_permit_record("Text", FakeLLM(_record(requirements=items)), file_name="m.pdf")

    assert record is not None
    assert len(record.requirements) == MAX_REQUIREMENTS
    assert len(record.requirements[0].content) == 1000


def test_blank_optionals_are_stored_as_absent():
    reply = _record(municipality=" ", reference="")
    record = extract_permit_record("Text", FakeLLM(reply), file_name="m.pdf")
    assert record is not None and record.municipality is None and record.reference is None


def test_the_prompt_carries_the_page_markers_and_the_file_name():
    text = pages_with_markers([("1", "Seite eins."), ("2", "Seite zwei.")])
    llm = FakeLLM(_record())

    extract_permit_record(text, llm, file_name="Bescheid_Baden.pdf")

    shown = next(m for m in llm.messages if isinstance(m, HumanMessage)).content
    assert "[Seite 1]\n\nSeite eins." in shown
    assert "[Seite 2]\n\nSeite zwei." in shown
    assert "Bescheid_Baden.pdf" in shown


def test_the_text_the_model_reads_is_capped():
    llm = FakeLLM(_record())
    extract_permit_record("a" * (MAX_TEXT_CHARS + 5000) + "ENDMARK", llm, file_name="m.pdf")

    shown = next(m for m in llm.messages if isinstance(m, HumanMessage)).content
    assert "ENDMARK" not in shown
    assert shown.endswith("a" * MAX_TEXT_CHARS)
    assert not shown.endswith("a" * (MAX_TEXT_CHARS + 1))


def test_the_system_prompt_names_the_fields_and_the_way_out():
    llm = FakeLLM(_record())
    extract_permit_record("Text", llm, file_name="m.pdf")

    system = llm.messages[0].content
    for field in ("kind", "authority", "municipality", "bundesland", "issued_on", "reference", "requirements"):
        assert field in system
    assert "null record" in system


def test_pages_without_a_label_follow_the_previous_marker():
    text = pages_with_markers([("3", "A"), (None, "B"), ("", "  "), ("4", "C"), ("4", "D")])
    assert text == "[Seite 3]\n\nA\n\nB\n\n[Seite 4]\n\nC\n\nD"


def test_the_model_name_is_read_off_the_llm():
    assert permit_extraction.llm_model_name(FakeLLM()) == "fake/model"
    assert permit_extraction.llm_model_name(SimpleNamespace(model="m/x")) == "m/x"
    assert permit_extraction.llm_model_name(object()) == "unknown"


def test_the_bescheid_tag_is_the_controlled_vocabulary_one():
    assert permit_extraction.BESCHEID_TAG in DOCUMENT_TYPE_TAGS


@pytest.mark.parametrize(
    ("tags", "expected"),
    [(["Bescheid"], True), (["Bescheid", "Brandschutz"], True), (["Gutachten"], False), ([], False), (None, False)],
)
def test_is_bescheid_reads_the_tag_decision(tags, expected):
    assert is_bescheid(tags) is expected


@pytest.mark.parametrize("document_id", ["doc-baden-bescheid", "doc-moedling-nachforderung", "doc-wien22-ma37"])
def test_the_synthetic_notices_reach_the_model_whole(document_id):
    text = _fixture_text(document_id)
    llm = FakeLLM(_record())

    extract_permit_record(pages_with_markers([(1, text)]), llm, file_name=f"{document_id}.pdf")

    assert text in next(m for m in llm.messages if isinstance(m, HumanMessage)).content


def test_extract_and_store_hands_the_record_to_the_client(monkeypatch):
    stored: list[tuple] = []
    monkeypatch.setattr(
        "aiq_agent.knowledge.permit_records_client.store_permit_record", lambda *args: stored.append(args) or True
    )

    landed = permit_extraction.extract_and_store_permit_record(
        [(1, "Text")],
        FakeLLM(_record()),
        organization_id="org_1",
        document_id="d1",
        collection="proj_1",
        file_name="m.pdf",
    )

    assert landed is True
    org, doc, collection, file_name, model, record = stored[0]
    assert (org, doc, collection, file_name, model) == ("org_1", "d1", "proj_1", "m.pdf", "fake/model")
    assert record.kind == "nachforderung"


def test_nothing_extracted_leaves_the_stored_record_alone(monkeypatch):
    stored: list[tuple] = []
    monkeypatch.setattr(
        "aiq_agent.knowledge.permit_records_client.store_permit_record", lambda *args: stored.append(args) or True
    )

    landed = permit_extraction.extract_and_store_permit_record(
        [(1, "Text")],
        FakeLLM(raises=RuntimeError("down")),
        organization_id="o",
        document_id="d",
        collection="c",
        file_name="f",
    )

    assert landed is False
    assert stored == []
