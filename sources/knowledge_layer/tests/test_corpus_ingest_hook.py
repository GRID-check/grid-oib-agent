"""Phase-2 ingestion hook: corpus resolver → LlamaIndex Documents."""

from knowledge_layer.llamaindex.adapter import _corpus_text_documents
from llama_index.core import Document

from aiq_agent.knowledge.corpus import CorpusChunk


def _chunks() -> list[CorpusChunk]:
    return [
        CorpusChunk(
            text="OIB-RL 2 - Brandschutz (Ausgabe Mai 2023), Pkt 3.1.2, normativ\nAnforderungstext",
            metadata={
                "doc_id": "oib-rl-2",
                "edition": "2023-05",
                "rank": "oib_richtlinie",
                "role": "normativ",
                "country": "at",
                "punkt": "3.1.2",
                "file_name": "oib-rl_2_ausgabe_mai_2023.pdf",
                "page_label": "12",
                "chunk_index": 0,
            },
        )
    ]


def test_no_resolver_returns_none():
    assert _corpus_text_documents(None, "file.pdf", [], 123, Document) is None


def test_resolver_miss_returns_none():
    pages = [{"text": "x", "page_number": 1}]
    assert _corpus_text_documents(lambda name, p: None, "file.pdf", pages, 123, Document) is None


def test_empty_chunk_list_returns_none():
    assert _corpus_text_documents(lambda name, pages: [], "file.pdf", [], 123, Document) is None


def test_builds_documents_with_merged_metadata():
    resolver = lambda name, pages: _chunks()  # noqa: E731
    docs = _corpus_text_documents(resolver, "oib-rl_2_ausgabe_mai_2023.pdf", [], 456, Document)
    assert docs is not None and len(docs) == 1
    doc = docs[0]
    assert "Anforderungstext" in doc.text
    assert doc.metadata["doc_id"] == "oib-rl-2"
    assert doc.metadata["punkt"] == "3.1.2"
    assert doc.metadata["file_size"] == 456
    assert doc.metadata["content_type"] == "text"
    assert doc.metadata["file_name"] == "oib-rl_2_ausgabe_mai_2023.pdf"
