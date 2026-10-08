"""The closed-project reading: what the documents state, bounded and checked in code.

The model is the reader, so these tests pin the contract around it and never its wording:
the schema it is held to, what it is shown, and which of its answers the code keeps.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest
from langchain_core.messages import HumanMessage
from pydantic import ValidationError

from aiq_agent.knowledge.project_experience import MAX_DECISIONS
from aiq_agent.knowledge.project_experience import MAX_TEXT_CHARS
from aiq_agent.knowledge.project_experience import ChosenFiles
from aiq_agent.knowledge.project_experience import DecisionReply
from aiq_agent.knowledge.project_experience import DraftedDecision
from aiq_agent.knowledge.project_experience import Evidence
from aiq_agent.knowledge.project_experience import FingerprintReply
from aiq_agent.knowledge.project_experience import FingerprintValue
from aiq_agent.knowledge.project_experience import ProjectExperienceRequest
from aiq_agent.knowledge.project_experience import VocabularyEntry
from aiq_agent.knowledge.project_experience import VocabularyOption
from aiq_agent.knowledge.project_experience import choose_documents
from aiq_agent.knowledge.project_experience import draft_decisions
from aiq_agent.knowledge.project_experience import extract_fingerprint
from aiq_agent.knowledge.project_experience import read_project_experience
from aiq_agent.knowledge.schema import AvailableDocument


class FakeLLM:
    """Answers each call in turn: a reply dict or string, or an exception to raise. Records what it was asked."""

    def __init__(self, *replies: Any):
        self.replies = list(replies)
        self.bound: list[dict[str, Any]] = []
        self.calls: list[list[Any]] = []
        self.model_name = "fake/model"

    def bind(self, **kwargs: Any) -> FakeLLM:
        self.bound.append(kwargs)
        return self

    def invoke(self, messages: list[Any]) -> SimpleNamespace:
        self.calls.append(messages)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        content = reply if isinstance(reply, str) else json.dumps(reply)
        return SimpleNamespace(content=content)

    def user_prompt(self, call: int = 0) -> str:
        return next(m for m in self.calls[call] if isinstance(m, HumanMessage)).content

    def system_prompt(self, call: int = 0) -> str:
        return self.calls[call][0].content


def _option(token: str, label: str | None = None) -> VocabularyOption:
    return VocabularyOption(token=token, label=label or token.title())


VOCABULARY = {
    "bundesland": VocabularyEntry(multiple=False, options=[_option("niederoesterreich"), _option("wien")]),
    "gebaeudeklasse": VocabularyEntry(multiple=False, options=[_option("4", "GK 4"), _option("3", "GK 3")]),
    "bauweise": VocabularyEntry(multiple=True, options=[_option("holzbau"), _option("stahlbeton")]),
    "nutzungen": VocabularyEntry(multiple=True, options=[]),
}


def _ev(file_name: str, quote: str, page: str | None = "2") -> dict[str, Any]:
    return {"fileName": file_name, "page": page, "quote": quote}


def _doc(file_name: str, **fields: Any) -> AvailableDocument:
    return AvailableDocument(file_name=file_name, **fields)


def _pages(*texts: str) -> list[tuple[str, str]]:
    return [(str(index + 1), text) for index, text in enumerate(texts)]


def _fetch_from(files: dict[str, Any]):
    """A ``fetch_pages`` over an in-memory collection; a file mapped to None is missing."""

    def fetch(collection: str, file_name: str):
        return files.get(file_name)

    return fetch


def _request(**overrides: Any) -> ProjectExperienceRequest:
    body = {
        "organizationId": "org_1",
        "projectId": "proj-1",
        "collection": "col-main",
        "vocabulary": {key: entry.model_dump() for key, entry in VOCABULARY.items()},
        "knownFacts": [],
        "knownDecisions": [],
        **overrides,
    }
    return ProjectExperienceRequest.model_validate(body)


# --- choose_documents -----------------------------------------------------------------------


def test_a_file_name_the_inventory_does_not_have_is_dropped():
    llm = FakeLLM({"file_names": ["Baubeschreibung.pdf", "erfunden.pdf", "Baubeschreibung.pdf"]})
    inventory = [_doc("Baubeschreibung.pdf"), _doc("Bescheid.pdf")]

    assert choose_documents(inventory, llm) == ["Baubeschreibung.pdf"]


def test_the_chooser_keeps_at_most_the_limit_in_its_order():
    llm = FakeLLM({"file_names": ["c.pdf", "a.pdf", "b.pdf"]})
    inventory = [_doc("a.pdf"), _doc("b.pdf"), _doc("c.pdf")]

    assert choose_documents(inventory, llm, limit=2) == ["c.pdf", "a.pdf"]


def test_an_empty_inventory_asks_nothing():
    llm = FakeLLM()

    assert choose_documents([], llm) == []
    assert llm.calls == []


def test_the_inventory_is_bounded_to_200_documents():
    inventory = [_doc(f"datei-{index:03d}.pdf") for index in range(250)]
    llm = FakeLLM({"file_names": []})

    choose_documents(inventory, llm)

    shown = llm.user_prompt()
    assert "datei-199.pdf" in shown
    assert "datei-200.pdf" not in shown


def test_a_summary_is_cut_to_400_characters():
    llm = FakeLLM({"file_names": []})

    choose_documents([_doc("a.pdf", summary="k" * 450 + "ENDMARK")], llm)

    shown = llm.user_prompt()
    assert "k" * 400 in shown
    assert "k" * 401 not in shown
    assert "ENDMARK" not in shown


# --- extract_fingerprint --------------------------------------------------------------------

BUNDESLAND_QUOTE = "Das Vorhaben liegt in Niederösterreich."


def test_a_token_outside_the_vocabulary_is_dropped():
    llm = FakeLLM(
        {
            "values": [
                {"key": "gebaeudeklasse", "value": "5", "evidence": [_ev("b.pdf", "Gebäudeklasse 5")]},
                {"key": "bauweise", "value": ["holzbau"], "evidence": [_ev("b.pdf", "Holzbau")]},
            ]
        }
    )

    values = extract_fingerprint("Text", VOCABULARY, [], llm)

    assert [value.key for value in values] == ["bauweise"]


def test_a_value_without_a_quote_is_dropped():
    llm = FakeLLM(
        {
            "values": [
                {"key": "gebaeudeklasse", "value": "4", "evidence": [_ev("b.pdf", "")]},
                {"key": "bauweise", "value": ["holzbau"], "evidence": [_ev("b.pdf", "   ")]},
            ]
        }
    )

    assert extract_fingerprint("Text", VOCABULARY, [], llm) == []


def test_a_value_without_evidence_is_dropped():
    llm = FakeLLM({"values": [{"key": "gebaeudeklasse", "value": "4", "evidence": []}]})

    assert extract_fingerprint("Text", VOCABULARY, [], llm) == []


def test_a_key_the_vocabulary_does_not_have_is_dropped():
    llm = FakeLLM({"values": [{"key": "erfunden", "value": "x", "evidence": [_ev("b.pdf", "x")]}]})

    assert extract_fingerprint("Text", VOCABULARY, [], llm) == []


def test_a_confirmed_fact_is_not_asked_and_is_not_in_the_prompt():
    llm = FakeLLM({"values": []})

    extract_fingerprint(f"Der Bau ist fertig. {BUNDESLAND_QUOTE}", VOCABULARY, ["bundesland"], llm)

    assert "bundesland" not in llm.user_prompt()
    assert "bundesland" not in llm.system_prompt()
    assert "gebaeudeklasse" in llm.user_prompt()


def test_a_key_with_no_options_is_not_asked():
    llm = FakeLLM({"values": []})

    extract_fingerprint("Text", VOCABULARY, [], llm)

    assert "nutzungen" not in llm.user_prompt()


def test_a_multi_valued_key_keeps_its_valid_tokens_and_drops_the_others_one_by_one():
    llm = FakeLLM(
        {
            "values": [
                {"key": "bauweise", "value": ["holzbau", "lehm", "stahlbeton"], "evidence": [_ev("b.pdf", "Holz")]}
            ]
        }
    )

    [value] = extract_fingerprint("Text", VOCABULARY, [], llm)

    assert value.value == ["holzbau", "stahlbeton"]


def test_a_single_valued_key_refuses_a_list_of_several_tokens():
    llm = FakeLLM(
        {"values": [{"key": "gebaeudeklasse", "value": ["4", "3"], "evidence": [_ev("b.pdf", "GK 3 und 4")]}]}
    )

    assert extract_fingerprint("Text", VOCABULARY, [], llm) == []


def test_a_single_valued_key_answers_with_one_token_not_a_list():
    llm = FakeLLM({"values": [{"key": "gebaeudeklasse", "value": "4", "evidence": [_ev("b.pdf", "Gebäudeklasse 4")]}]})

    [value] = extract_fingerprint("Text", VOCABULARY, [], llm)

    assert value.value == "4"


def test_a_quote_longer_than_300_characters_is_cut():
    llm = FakeLLM({"values": [{"key": "gebaeudeklasse", "value": "4", "evidence": [_ev("b.pdf", "q" * 500)]}]})

    [value] = extract_fingerprint("Text", VOCABULARY, [], llm)

    assert len(value.evidence[0].quote) == 300


def test_the_fingerprint_call_demands_a_strict_schema_with_no_extra_keys():
    llm = FakeLLM({"values": []})

    extract_fingerprint("Text", VOCABULARY, [], llm)

    json_schema = llm.bound[0]["response_format"]["json_schema"]
    assert json_schema["strict"] is True
    assert json_schema["schema"]["additionalProperties"] is False


# --- draft_decisions ------------------------------------------------------------------------


def _decision(content: str = "Brandsperre je Geschoß.", quote: str = "Brandsperre") -> dict[str, Any]:
    return {
        "kind": "decision",
        "content": content,
        "outcome": "accepted",
        "evidence": [_ev("bescheid.pdf", quote, "3")],
    }


def test_a_decision_without_evidence_is_dropped():
    llm = FakeLLM({"decisions": [{**_decision(), "evidence": []}, _decision(content="Fluchttreppe außen.")]})

    decisions = draft_decisions("Text", [], llm)

    assert [decision.content for decision in decisions] == ["Fluchttreppe außen."]


def test_a_decision_whose_quote_is_blank_is_dropped():
    llm = FakeLLM({"decisions": [_decision(quote="  ")]})

    assert draft_decisions("Text", [], llm) == []


def test_evidence_without_a_file_name_is_no_evidence():
    nameless = {**_decision(), "evidence": [_ev("  ", "Brandsperre")]}
    llm = FakeLLM({"decisions": [nameless]})

    assert draft_decisions("Text", [], llm) == []


def test_a_page_the_model_writes_as_a_number_is_kept_as_its_label():
    llm = FakeLLM({"decisions": [{**_decision(), "evidence": [{"fileName": "b.pdf", "page": 3, "quote": "Brand"}]}]})

    [decision] = draft_decisions("Text", [], llm)

    assert decision.evidence[0].page == "3"


def test_a_decision_content_is_cut_to_600_characters():
    llm = FakeLLM({"decisions": [_decision(content="k" * 900)]})

    [decision] = draft_decisions("Text", [], llm)

    assert len(decision.content) == 600


def test_the_decisions_are_capped_at_twelve():
    llm = FakeLLM({"decisions": [_decision(content=f"Entscheidung {index}.") for index in range(15)]})

    assert len(draft_decisions("Text", [], llm)) == MAX_DECISIONS == 12


def test_the_known_decisions_are_shown_as_already_known():
    llm = FakeLLM({"decisions": []})

    draft_decisions("Text", ["Brandsperre je Geschoß aus 1 mm Stahlblech"], llm)

    assert "Already known" in llm.user_prompt()
    assert "Brandsperre je Geschoß aus 1 mm Stahlblech" in llm.user_prompt()


# --- the request and reply contracts --------------------------------------------------------


def test_the_request_reads_the_contract_spelling():
    request = _request(knownFacts=["bundesland"], knownDecisions=["Brandsperre"])

    assert request.known_facts == ["bundesland"]
    assert request.known_decisions == ["Brandsperre"]
    assert request.vocabulary["bauweise"].multiple is True


def test_more_than_sixty_known_decisions_are_refused():
    with pytest.raises(ValidationError):
        _request(knownDecisions=["x"] * 61)


def test_a_known_decision_longer_than_300_characters_is_refused():
    with pytest.raises(ValidationError):
        _request(knownDecisions=["x" * 301])


@pytest.mark.parametrize(
    "model", [Evidence, FingerprintValue, DraftedDecision, ChosenFiles, FingerprintReply, DecisionReply]
)
def test_every_field_of_a_strict_reply_is_required(model):
    """Strict structured output has no defaults: a field with one is refused by the provider's schema."""
    schema = model.model_json_schema()
    definitions = schema.get("$defs", {})
    for definition in [schema, *definitions.values()]:
        properties = definition.get("properties")
        if properties:
            assert set(definition.get("required", [])) == set(properties)


# --- read_project_experience ----------------------------------------------------------------


def test_a_closed_project_is_read_end_to_end_and_each_value_names_its_file():
    llm = FakeLLM(
        {"file_names": ["Baubeschreibung.pdf"]},
        {"values": [{"key": "gebaeudeklasse", "value": "4", "evidence": [_ev("Baubeschreibung.pdf", "GK 4", "2")]}]},
        {
            "decisions": [
                {
                    "kind": "constraint",
                    "content": "Stahltür als Brandabschluss, weil die Auflage es verlangt.",
                    "outcome": "auflage",
                    "evidence": [_ev("Baubeschreibung.pdf", "Stahltür", "5")],
                }
            ]
        },
    )

    response = read_project_experience(
        _request(),
        llm=llm,
        list_documents=lambda collection: [_doc("Baubeschreibung.pdf")],
        fetch_pages=_fetch_from(
            {"Baubeschreibung.pdf": _pages("Gebäudeklasse GK 4", "Eine Stahltür als Brandabschluss")}
        ),
    )

    assert response.error is None
    assert response.model == "fake/model"
    assert response.documents_read == ["Baubeschreibung.pdf"]
    assert [(value.key, value.value) for value in response.fingerprint] == [("gebaeudeklasse", "4")]
    assert response.fingerprint[0].evidence[0].file_name == "Baubeschreibung.pdf"
    assert response.decisions[0].outcome == "auflage"


def test_evidence_that_names_a_file_nobody_read_is_dropped_and_the_value_with_only_such_is_too():
    llm = FakeLLM(
        {"file_names": ["a.pdf", "b.pdf"]},
        {
            "values": [
                {"key": "gebaeudeklasse", "value": "4", "evidence": [_ev("b.pdf", "GK 4")]},
                {
                    "key": "bauweise",
                    "value": ["holzbau"],
                    "evidence": [_ev("b.pdf", "Holz"), _ev("a.pdf", "Holzbau")],
                },
            ]
        },
        {"decisions": []},
    )

    response = read_project_experience(
        _request(),
        llm=llm,
        list_documents=lambda collection: [_doc("a.pdf"), _doc("b.pdf")],
        fetch_pages=_fetch_from({"a.pdf": _pages("Holzbau"), "b.pdf": None}),
    )

    assert response.documents_read == ["a.pdf"]
    assert [value.key for value in response.fingerprint] == ["bauweise"]
    assert [entry.file_name for entry in response.fingerprint[0].evidence] == ["a.pdf"]


def test_the_text_the_pens_read_is_bounded_to_24000_characters_split_fairly():
    llm = FakeLLM({"file_names": ["a.pdf", "b.pdf"]}, {"values": []}, {"decisions": []})

    read_project_experience(
        _request(),
        llm=llm,
        list_documents=lambda collection: [_doc("a.pdf"), _doc("b.pdf")],
        fetch_pages=_fetch_from({"a.pdf": _pages("x" * 30_000), "b.pdf": _pages("y" * 30_000)}),
    )

    shown = llm.user_prompt(1).split("## Document\n", 1)[1]
    assert len(shown) <= MAX_TEXT_CHARS
    assert shown.count("x") > 11_000
    assert shown.count("y") > 11_000
    assert "=== a.pdf ===" in shown and "=== b.pdf ===" in shown


def test_a_short_file_leaves_its_unused_share_to_the_longer_one():
    llm = FakeLLM({"file_names": ["a.pdf", "b.pdf"]}, {"values": []}, {"decisions": []})

    read_project_experience(
        _request(),
        llm=llm,
        list_documents=lambda collection: [_doc("a.pdf"), _doc("b.pdf")],
        fetch_pages=_fetch_from({"a.pdf": _pages("x" * 100), "b.pdf": _pages("y" * 30_000)}),
    )

    shown = llm.user_prompt(1).split("## Document\n", 1)[1]
    assert shown.count("x") == 100
    assert shown.count("y") > 23_000


def test_no_documents_is_answered_as_no_documents():
    llm = FakeLLM()

    response = read_project_experience(
        _request(), llm=llm, list_documents=lambda collection: [], fetch_pages=_fetch_from({})
    )

    assert response.error == "no_documents"
    assert response.fingerprint == [] and response.decisions == [] and response.documents_read == []
    assert llm.calls == []


def test_chosen_files_with_no_readable_text_are_no_documents():
    llm = FakeLLM({"file_names": ["a.pdf"]})

    response = read_project_experience(
        _request(), llm=llm, list_documents=lambda collection: [_doc("a.pdf")], fetch_pages=_fetch_from({})
    )

    assert response.error == "no_documents"


def test_no_model_is_answered_as_no_model():
    response = read_project_experience(
        _request(), llm=None, list_documents=lambda collection: [_doc("a.pdf")], fetch_pages=_fetch_from({})
    )

    assert response.error == "no_model"
    assert response.fingerprint == [] and response.decisions == []


@pytest.mark.parametrize(
    "failing_reply",
    [RuntimeError("503 from the provider"), "this is not json"],
    ids=["provider-fault", "unreadable-reply"],
)
def test_a_fingerprint_pen_that_fails_answers_extraction_failed_with_empty_lists(failing_reply, caplog):
    llm = FakeLLM({"file_names": ["a.pdf"]}, failing_reply, {"decisions": [_decision()]})

    with caplog.at_level("ERROR"):
        response = read_project_experience(
            _request(),
            llm=llm,
            list_documents=lambda collection: [_doc("a.pdf")],
            fetch_pages=_fetch_from({"a.pdf": _pages("Text")}),
        )

    assert response.error == "extraction_failed"
    assert response.fingerprint == [] and response.decisions == [] and response.documents_read == []
    assert any(record.exc_info for record in caplog.records)


def test_a_decision_pen_that_fails_drops_the_fingerprint_too():
    llm = FakeLLM(
        {"file_names": ["a.pdf"]},
        {"values": [{"key": "gebaeudeklasse", "value": "4", "evidence": [_ev("a.pdf", "GK 4")]}]},
        RuntimeError("timeout"),
    )

    response = read_project_experience(
        _request(),
        llm=llm,
        list_documents=lambda collection: [_doc("a.pdf")],
        fetch_pages=_fetch_from({"a.pdf": _pages("GK 4")}),
    )

    assert response.error == "extraction_failed"
    assert response.fingerprint == [] and response.decisions == []


def test_a_failure_to_list_the_documents_is_extraction_failed_not_a_raise():
    def broken_listing(collection: str):
        raise RuntimeError("summary table unreachable")

    response = read_project_experience(
        _request(), llm=FakeLLM(), list_documents=broken_listing, fetch_pages=_fetch_from({})
    )

    assert response.error == "extraction_failed"


def _read_one(text: str, quote: str):
    llm = FakeLLM(
        {"file_names": ["Baubeschreibung.pdf"]},
        {"values": [{"key": "gebaeudeklasse", "value": "4", "evidence": [_ev("Baubeschreibung.pdf", quote, "1")]}]},
        {"decisions": []},
    )
    return read_project_experience(
        _request(),
        llm=llm,
        list_documents=lambda collection: [_doc("Baubeschreibung.pdf")],
        fetch_pages=_fetch_from({"Baubeschreibung.pdf": _pages(text)}),
    )


def test_a_quote_the_document_does_not_contain_is_no_evidence():
    # The model's quote is the proof; one it made up proves nothing, however plausible.
    response = _read_one("Das Gebäude ist ein Wohnhaus in Holzbauweise.", "Gebäudeklasse 4")
    assert response.fingerprint == []


def test_a_quote_the_pdf_broke_across_lines_still_stands_in_the_document():
    response = _read_one("Einstufung:\nGebäude-\nklasse   4 gemäß OIB", "einstufung: gebäude- klasse 4")
    assert [value.value for value in response.fingerprint] == ["4"]


def test_a_quote_from_text_the_bound_cut_off_is_not_what_the_pens_read():
    response = _read_one("x" * (MAX_TEXT_CHARS + 10) + " Gebäudeklasse 4", "Gebäudeklasse 4")
    assert response.fingerprint == []
