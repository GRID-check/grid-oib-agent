"""Tests for agentic filters on knowledge retrieval.

``knowledge_retrieval.search`` accepts ``doc_class`` (validated against the
store vocabulary, store-authoritative), ``title_contains`` (case-insensitive
substring on file name OR display title), and ``file_name`` (indexed name).
Filtering happens post-merge so a reclassification without re-ingest is
honored; invalid input returns a clear message instead of raising.
"""

from __future__ import annotations

from types import SimpleNamespace

from aiq_agent.knowledge.document_classification import DOCUMENT_CLASSES
from sources.knowledge_layer.src.register import _AGENT_FILTER_OVERFETCH
from sources.knowledge_layer.src.register import _KNOWLEDGE_SEARCH_DESCRIPTION
from sources.knowledge_layer.src.register import _apply_agent_filters
from sources.knowledge_layer.src.register import _empty_search_message
from sources.knowledge_layer.src.register import _file_name_matches


def _chunk(
    file_name: str = "doc.pdf",
    doc_class: str | None = None,
    chunk_id: str | None = None,
) -> SimpleNamespace:
    metadata = {"collection": "oib_knowledge"}
    if doc_class:
        metadata["doc_class"] = doc_class
    return SimpleNamespace(
        chunk_id=chunk_id or f"{file_name}-{doc_class or 'none'}",
        file_name=file_name,
        content="text",
        score=0.9,
        content_type=SimpleNamespace(value="text"),
        metadata=metadata,
    )


def test_overfetch_constant() -> None:
    assert _AGENT_FILTER_OVERFETCH == 3


def test_doc_class_filter_uses_store_value_when_available(monkeypatch) -> None:
    # Store says oib_richtlinie for this file even though chunk metadata disagrees.
    chunk = _chunk(file_name="oib-3.pdf", doc_class="sonstiges")
    monkeypatch.setattr(
        "aiq_agent.knowledge.factory.get_document_doc_classes",
        lambda *args, **kwargs: {"oib-3.pdf": "oib_richtlinie"},
    )
    # The resolved store value must win, so the oib_richtlinie filter keeps it.
    kept = _apply_agent_filters([chunk], doc_class="oib_richtlinie", title_contains=None)
    assert len(kept) == 1


def test_doc_class_filter_drops_non_matching() -> None:
    chunks = [_chunk(file_name="a.pdf", doc_class="oib_richtlinie"), _chunk(file_name="b.pdf", doc_class="gesetz")]
    kept = _apply_agent_filters(chunks, doc_class="oib_richtlinie", title_contains=None)
    assert [c.file_name for c in kept] == ["a.pdf"]


def test_title_contains_matches_file_name_case_insensitive() -> None:
    chunks = [_chunk(file_name="OIB-3-Brandschutz.pdf"), _chunk(file_name="Wiener Bauordnung.pdf")]
    kept = _apply_agent_filters(chunks, doc_class=None, title_contains="oib-3")
    assert [c.file_name for c in kept] == ["OIB-3-Brandschutz.pdf"]


def test_title_contains_matches_display_title(monkeypatch) -> None:
    # Display title (store) is preferred over the raw file name.
    chunks = [_chunk(file_name="norms_2023.pdf"), _chunk(file_name="other.pdf")]
    monkeypatch.setattr(
        "aiq_agent.knowledge.factory.get_document_display_titles",
        lambda *args, **kwargs: {"norms_2023.pdf": "OIB Richtlinie 3"},
    )
    kept = _apply_agent_filters(chunks, doc_class=None, title_contains="richtlinie")
    assert [c.file_name for c in kept] == ["norms_2023.pdf"]


def test_no_filters_keeps_all() -> None:
    chunks = [_chunk(file_name="a.pdf"), _chunk(file_name="b.pdf")]
    kept = _apply_agent_filters(chunks, doc_class=None, title_contains=None)
    assert len(kept) == 2


def test_doc_class_and_title_combined() -> None:
    chunks = [
        _chunk(file_name="a.pdf", doc_class="oib_richtlinie"),
        _chunk(file_name="b.pdf", doc_class="gesetz"),
        _chunk(file_name="c.pdf", doc_class="oib_richtlinie"),
    ]
    kept = _apply_agent_filters(chunks, doc_class="oib_richtlinie", title_contains="c")
    assert [c.file_name for c in kept] == ["c.pdf"]


def test_document_classes_vocabulary_is_known() -> None:
    # Guards the vocabulary the tool validates against.
    assert "oib_richtlinie" in DOCUMENT_CLASSES
    assert "gesetz" in DOCUMENT_CLASSES
    assert "sonstiges" in DOCUMENT_CLASSES


def test_file_name_matches_exact_and_contained() -> None:
    assert _file_name_matches("Brandschutzplan_EG.pdf", "Brandschutzplan_EG.pdf")
    assert _file_name_matches("Brandschutzplan_EG.pdf", "brandschutzplan_eg.pdf")
    assert _file_name_matches("Brandschutzplan_EG.pdf", "Brandschutzplan")
    assert not _file_name_matches("Schnitt.pdf", "Brandschutzplan")
    assert not _file_name_matches(None, "x.pdf")


def test_file_name_filter_keeps_only_the_named_file() -> None:
    chunks = [_chunk(file_name="Brandschutzplan_EG.pdf"), _chunk(file_name="Schnitt.pdf")]
    kept = _apply_agent_filters(chunks, doc_class=None, title_contains=None, file_name="Brandschutzplan")
    assert [c.file_name for c in kept] == ["Brandschutzplan_EG.pdf"]


def test_empty_search_message_steers_and_forbids_invented_citations() -> None:
    text = _empty_search_message("Fluchtwege", file_name="fehlend.pdf")
    assert "fehlend.pdf" in text
    assert "inventory" in text
    assert "do not invent" in text.lower()
    assert "surface_documents" in text


def test_knowledge_search_description_is_the_evidence_tool() -> None:
    desc = _KNOWLEDGE_SEARCH_DESCRIPTION
    assert "evidence" in desc.lower()
    assert "surface_documents" in desc
    assert "file_name=" in desc
    assert "do not also call" in desc.lower() or "do not also call" in desc
    assert "WHEN TO CALL" in desc
    assert "WHEN NOT TO CALL" in desc
    assert "Citation" in desc
