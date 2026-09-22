"""The retriever's document-frequency gate on the exact (``$contains``) channel.

``hybrid.selective_terms`` decides WHAT is noise (tested in ``test_hybrid.py``);
this file covers the measuring seam around it — that the frequency is read from
the live collection, that it is cached, that a ubiquitous term never reaches a
vector query, and that an unmeasurable frequency degrades to the previous
behaviour rather than to no lexical channel at all.
"""

from __future__ import annotations

from typing import Any

import pytest

from sources.knowledge_layer.src.llamaindex.adapter import LlamaIndexRetriever


class FakeCollection:
    """Minimal Chroma stand-in: `count` plus a substring `get`."""

    def __init__(self, documents: dict[str, str], *, fail_on: str | None = None):
        self.documents = documents
        self.fail_on = fail_on
        self.get_calls: list[str] = []
        self.count_calls = 0

    def count(self) -> int:
        self.count_calls += 1
        if self.fail_on == "count":
            raise RuntimeError("collection unavailable")
        return len(self.documents)

    def get(self, *, where_document: dict[str, Any], include: list[str]) -> dict[str, Any]:
        term = where_document["$contains"]
        self.get_calls.append(term)
        if self.fail_on == "get":
            raise RuntimeError("get unavailable")
        return {"ids": [cid for cid, text in self.documents.items() if term in text]}


def _corpus(size: int = 40) -> dict[str, str]:
    """A corpus shaped like this one: ``OIB`` everywhere, ``§ 3`` in two chunks."""
    documents = {f"c{i}": "OIB-Richtlinie, Ausgabe Mai 2023." for i in range(size)}
    documents["c0"] += " § 3 Bauweise."
    documents["c1"] += " § 3 Bauweise."
    return documents


@pytest.fixture
def retriever() -> LlamaIndexRetriever:
    return LlamaIndexRetriever({})


def test_a_corpus_identity_term_never_reaches_a_contains_pass(retriever) -> None:
    collection = FakeCollection(_corpus())
    assert retriever._selective_exact_terms(collection, "oib", ["OIB"]) == []


def test_a_selective_term_survives(retriever) -> None:
    collection = FakeCollection(_corpus())
    assert retriever._selective_exact_terms(collection, "oib", ["§ 3", "OIB"]) == ["§ 3"]


def test_the_frequency_is_measured_once_per_collection_size(retriever) -> None:
    collection = FakeCollection(_corpus())
    retriever._selective_exact_terms(collection, "oib", ["§ 3"])
    retriever._selective_exact_terms(collection, "oib", ["§ 3"])
    assert collection.get_calls == ["§ 3"]


def test_a_changed_collection_size_invalidates_the_measurement(retriever) -> None:
    documents = _corpus()
    collection = FakeCollection(documents)
    retriever._selective_exact_terms(collection, "oib", ["§ 3"])
    documents["c99"] = "Neu ingestiert. § 3 Bauweise."
    retriever._selective_exact_terms(collection, "oib", ["§ 3"])
    assert collection.get_calls == ["§ 3", "§ 3"]


def test_the_same_term_is_measured_per_collection(retriever) -> None:
    """ "OIB is noise" is a property of a corpus: a project collection that
    barely mentions it must not inherit the base corpus's verdict."""
    base = FakeCollection(_corpus())
    project = FakeCollection({f"p{i}": "Projektnotiz." for i in range(40)} | {"p0": "Verweis auf OIB."})
    assert retriever._selective_exact_terms(base, "oib", ["OIB"]) == []
    assert retriever._selective_exact_terms(project, "projekt", ["OIB"]) == ["OIB"]


def test_an_unmeasurable_frequency_keeps_the_term(retriever) -> None:
    """Fail OPEN: a Chroma that cannot answer `get` degrades to the behaviour
    before the ceiling existed, never to a dead lexical channel."""
    collection = FakeCollection(_corpus(), fail_on="get")
    assert retriever._selective_exact_terms(collection, "oib", ["§ 3"]) == ["§ 3"]


def test_an_unavailable_collection_keeps_every_term(retriever) -> None:
    collection = FakeCollection(_corpus(), fail_on="count")
    assert retriever._selective_exact_terms(collection, "oib", ["§ 3", "OIB"]) == ["§ 3", "OIB"]
