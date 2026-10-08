"""The ingest hook of the permitting memory: when a Bescheid's permit record is extracted.

``LlamaIndexIngestor._remember_permit`` runs once the tags are known. It reads the
tag decision and the job's identity, never the text, and a fault or a slow model
costs the record and not the file.
"""

from __future__ import annotations

import time
from types import SimpleNamespace

import pytest
from knowledge_layer.llamaindex import adapter as adapter_module
from knowledge_layer.llamaindex.adapter import LlamaIndexIngestor


def _page(label: str | None, text: str) -> SimpleNamespace:
    return SimpleNamespace(metadata={"page_label": label} if label else {}, get_content=lambda: text)


@pytest.fixture()
def calls(monkeypatch):
    seen: list[dict] = []

    def extract_and_store(pages, llm, **kwargs):
        seen.append({"pages": pages, "llm": llm, **kwargs})
        return True

    monkeypatch.setattr("aiq_agent.knowledge.permit_extraction.extract_and_store_permit_record", extract_and_store)
    return seen


def _ingestor(*, enabled: bool = True, llm: object | None = "llm") -> LlamaIndexIngestor:
    ingestor = object.__new__(LlamaIndexIngestor)
    ingestor.generate_summary_enabled = enabled
    ingestor.summary_llm = llm
    return ingestor


CONFIG = {"organization_id": "org_1", "document_id": "d1"}


def test_a_bescheid_is_extracted_over_its_pages_and_stored_for_its_document(calls):
    pages = [_page("1", "Seite eins"), _page("2", "Seite zwei")]

    _ingestor()._remember_permit(CONFIG, "proj_1", "Bescheid.pdf", ["Bescheid", "Brandschutz"], pages)

    assert calls == [
        {
            "pages": [("1", "Seite eins"), ("2", "Seite zwei")],
            "llm": "llm",
            "organization_id": "org_1",
            "document_id": "d1",
            "collection": "proj_1",
            "file_name": "Bescheid.pdf",
        }
    ]


@pytest.mark.parametrize("tags", [["Gutachten"], [], None])
def test_a_document_the_tags_do_not_call_a_bescheid_is_left_alone(calls, tags):
    _ingestor()._remember_permit(CONFIG, "proj_1", "f.pdf", tags, [_page("1", "x")])
    assert calls == []


@pytest.mark.parametrize(
    ("config", "ingestor"),
    [
        ({"organization_id": "org_1"}, _ingestor()),  # not dispatched for a BFF row (the corpus sync)
        ({"document_id": "d1"}, _ingestor()),
        (CONFIG, _ingestor(enabled=False)),  # the same switch the tag decision sits behind
        (CONFIG, _ingestor(llm=None)),
    ],
)
def test_nothing_runs_without_the_job_identity_or_the_summary_model(calls, config, ingestor):
    ingestor._remember_permit(config, "proj_1", "f.pdf", ["Bescheid"], [_page("1", "x")])
    assert calls == []


def test_a_model_that_never_answers_does_not_stall_the_ingest(monkeypatch):
    monkeypatch.setattr(adapter_module, "PERMIT_RECORD_TIMEOUT_SECONDS", 0.2)
    monkeypatch.setattr(
        "aiq_agent.knowledge.permit_extraction.extract_and_store_permit_record", lambda *a, **k: time.sleep(5)
    )

    started = time.monotonic()
    _ingestor()._remember_permit(CONFIG, "proj_1", "f.pdf", ["Bescheid"], [_page("1", "x")])

    assert time.monotonic() - started < 2


def test_a_fault_in_the_extraction_does_not_reach_the_ingest(monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("provider down")

    monkeypatch.setattr("aiq_agent.knowledge.permit_extraction.extract_and_store_permit_record", boom)

    _ingestor()._remember_permit(CONFIG, "proj_1", "f.pdf", ["Bescheid"], [_page("1", "x")])
