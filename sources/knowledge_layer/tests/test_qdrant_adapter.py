"""The LlamaIndex adapter on Qdrant: retrieval, exact search, the ingest write, facts, health.

Against a real Qdrant (``qdrant_testing``). The embedding API is stood in for:
what is under test is the seam, that the adapter's contract (``retrieve``,
``find_text``, the chunk a caller gets) holds on the store, and that what the
ingest path writes (``writes.write_chunks``) carries everything a read filters on.
"""

from __future__ import annotations

import math
import re
from typing import Any

import pytest
from knowledge_layer.llamaindex import adapter as adapter_module
from knowledge_layer.llamaindex.adapter import LlamaIndexRetriever
from knowledge_layer.qdrant import store as store_module
from knowledge_layer.qdrant import writes
from knowledge_layer.qdrant.payload import ChunkRecord

from sources.knowledge_layer.tests.qdrant_testing import record as _record
from sources.knowledge_layer.tests.qdrant_testing import vector as _vector

#: The real reader, before ``retriever`` stubs it for the tests that need no metadata store.
FACTS_BY_FILE = writes.facts_by_file


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    return dot / (math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b)))


@pytest.fixture
def retriever(qdrant_store, monkeypatch) -> LlamaIndexRetriever:
    monkeypatch.setattr(writes, "facts_by_file", lambda scope, names=None: {})
    instance = LlamaIndexRetriever({"embed_model": "test-model", "embed_base_url": "https://test"})
    instance._initialized = True
    monkeypatch.setattr(instance, "_embed_query_cached", lambda query: _vector(query))
    # The process-wide store takes this retriever's embedder as its identity.
    store_module.reset_store()
    store_module.get_store(instance._identity())
    return instance


def _row(text: str, file_name: str, **metadata: Any) -> ChunkRecord:
    return _record(text, file_name, page_label="2", _node_content="{...}", **metadata)


def _ingest(retriever: LlamaIndexRetriever, scope: str, rows: list[ChunkRecord], **config: Any) -> None:
    """Write ``rows`` the way the ingest path does: one ``write_chunks`` per file."""
    for file_name in sorted({row.metadata["file_name"] for row in rows}):
        mine = [row for row in rows if row.metadata["file_name"] == file_name]
        writes.write_chunks(scope, file_name, mine, identity=retriever._identity(), config=config)


async def test_retrieve_answers_from_qdrant_with_the_chunk_contract(retriever):
    rows = [
        _row("Die Fluchtwege sind in Gebäudeklasse 4 rauchfrei auszuführen.", "brandschutz.pdf"),
        _row("Die Tragwerksplanung berücksichtigt die Holzbauweise.", "statik.pdf"),
    ]
    _ingest(retriever, "proj_a", rows, organization_id="org_1", project_id="p1", document_id="d1")

    result = await retriever.retrieve("Fluchtweg", "proj_a", top_k=2)

    assert result.success and result.chunks
    top = result.chunks[0]
    assert top.file_name == "brandschutz.pdf" and top.page_number == 2
    assert top.chunk_id == rows[0].chunk_id
    assert top.score == pytest.approx(max(0.0, _cosine(_vector("Fluchtweg"), rows[0].embedding)), abs=1e-3)
    # The chunk carries the metadata the chunker gave it, not the store's own fields.
    assert "office_id" not in top.metadata and "_node_content" not in top.metadata
    assert "indexed_at" not in top.metadata
    assert [chunk.retrieval_rank for chunk in result.chunks] == list(range(len(result.chunks)))


async def test_retrieve_applies_the_callers_filter(retriever):
    _ingest(
        retriever,
        "oib_knowledge",
        [_row("Punkt eins", "rl2.pdf", punkt_id="1"), _row("Seite", "rl2.pdf", chunking="page")],
    )
    result = await retriever.retrieve("Punkt", "oib_knowledge", top_k=5, filters={"chunking": {"$ne": "page"}})
    assert [chunk.content for chunk in result.chunks] == ["Punkt eins"]


async def test_retrieve_from_a_collection_with_no_chunks_is_an_empty_success(retriever):
    result = await retriever.retrieve("Fluchtweg", "s_never_uploaded", top_k=3)
    assert result.success and result.chunks == []


def test_bm25_terms_are_priced_like_the_german_mirror(retriever):
    """Ubiquitous or absent terms leave BM25 silent instead of ranking the corpus (qdrant-gates-2026-10.md)."""
    rows = [_row(f"OIB-Richtlinie Ausgabe Mai 2023, Abschnitt {i}.", "rl.pdf") for i in range(27)]
    rows += [_row("Ausgabe Mai 2023: Fluchtwege sind zu kennzeichnen.", "rl.pdf")]
    _ingest(retriever, "oib_knowledge", rows)

    text, _terms = retriever._qdrant_lexical_inputs("oib-rl_2_ausgabe_mai_2023.pdf", "oib_knowledge")
    assert text == "", "every term is on the whole corpus or on none of it"

    text, _terms = retriever._qdrant_lexical_inputs("Fluchtwege Ausgabe", "oib_knowledge")
    assert text == "fluchtwege"
    assert ("oib_knowledge", 28, "fluchtwege") in retriever._qdrant_term_df, "a priced term is cached per size"


def test_unmeasurable_term_frequencies_leave_the_lexical_channels_unpriced(retriever, monkeypatch):
    """Fail open: pricing sharpens the channels, it never takes them away."""
    from knowledge_layer.qdrant import retrieval as qdrant_retrieval

    def down(*args: Any, **kwargs: Any) -> None:
        raise ConnectionError("qdrant down")

    monkeypatch.setattr(qdrant_retrieval, "term_frequencies", down)
    text, terms = retriever._qdrant_lexical_inputs("Was regelt § 3 zur Fluchttreppe?", "proj_a")
    assert text == retriever._bm25_text("Was regelt § 3 zur Fluchttreppe?")
    assert terms == ["§ 3"]


async def test_a_foreign_embedder_fails_the_retrieval_loudly(retriever, monkeypatch):
    _ingest(retriever, "proj_a", [_row("x", "a.pdf")])
    store_module.reset_store()
    monkeypatch.setattr(retriever, "embed_model_name", "another-model")
    result = await retriever.retrieve("x", "proj_a")
    assert not result.success and "embedding mismatch" in (result.error_message or "")


def test_a_foreign_embedder_is_refused_on_write(retriever):
    """The write checks the identity the collection was created with: two vector spaces never share one."""
    _ingest(retriever, "proj_a", [_row("x", "a.pdf")])
    store_module.reset_store()
    other = {"aiq:embed_fingerprint": "other-fp", "aiq:embed_model": "other-model"}
    with pytest.raises(RuntimeError, match="embedding mismatch"):
        writes.write_chunks("proj_a", "b.pdf", [_row("y", "b.pdf")], identity=other)
    store_module.reset_store()
    assert store_module.get_store(retriever._identity()).count("proj_a") == 1


async def test_find_text_applies_the_phrase_pattern(retriever):
    from knowledge_layer.browse import phrase_pattern

    _ingest(
        retriever,
        "proj_a",
        [_row("Die Fluchtstiege ist zu beleuchten.", "a.pdf"), _row("Keine Stiege hier: Rampe.", "b.pdf")],
    )
    chunks = await retriever.find_text("proj_a", phrase_pattern(["Fluchtstiege"]))
    assert [chunk.file_name for chunk in chunks] == ["a.pdf"]


def test_the_write_carries_the_ids_the_collection_name_implied(retriever):
    _ingest(retriever, "archiv_org_9", [_row("Ablage", "a.pdf")], document_id="doc-1")
    store = store_module.get_store()
    assert store.count("archiv_org_9", {"office_id": "org_9"}) == 1
    assert store.count("archiv_org_9", {"grid_document_id": "doc-1"}) == 1


def test_the_write_stamps_when_it_happened(retriever, monkeypatch):
    """``indexed_at`` is what a collection's ``updated_at`` (and the reaper of uploads) reads."""
    monkeypatch.setattr(writes.time, "time", lambda: 1_700_000_000.5)
    _ingest(retriever, "s_conv", [_row("eins", "a.pdf")])
    monkeypatch.setattr(writes.time, "time", lambda: 1_700_000_900.0)
    _ingest(retriever, "s_conv", [_row("zwei", "b.pdf")])
    store = store_module.get_store()
    assert store.newest("s_conv", "indexed_at") == 1_700_000_900
    assert store.newest("s_conv", "indexed_at", oldest=True) == 1_700_000_000
    assert store.newest("s_other", "indexed_at") is None


def test_a_rewrite_of_the_same_records_overwrites_and_never_duplicates(retriever):
    rows = [_row("eins", "a.pdf"), _row("zwei", "a.pdf")]
    _ingest(retriever, "proj_a", rows)
    _ingest(retriever, "proj_a", rows)
    assert store_module.get_store().count("proj_a") == 2


def test_deletes_go_by_chunk_file_and_scope(retriever):
    rows = [_row("eins", "a.pdf"), _row("zwei", "a.pdf"), _row("drei", "b.pdf")]
    _ingest(retriever, "proj_a", rows)
    _ingest(retriever, "proj_b", [_row("vier", "a.pdf")])
    store = store_module.get_store()
    store.delete_chunks("proj_a", [rows[0].chunk_id, "no-such-chunk"])
    assert store.count("proj_a") == 2
    store.delete_file("proj_a", "a.pdf")
    assert store.count("proj_a") == 1
    store.delete_scope("proj_a")
    assert store.count("proj_a") == 0
    assert store.count("proj_b") == 1, "a delete names its scope and never reaches another"


def test_a_long_delete_goes_in_bounded_requests(retriever, monkeypatch):
    rows = [_row(f"Chunk {index}", "a.pdf") for index in range(7)]
    _ingest(retriever, "proj_a", rows)
    monkeypatch.setattr(store_module, "DELETE_BATCH", 3)
    store = store_module.get_store()
    calls = {"delete": 0}
    real = store.client.delete

    def counted(*args, **kwargs):
        calls["delete"] += 1
        return real(*args, **kwargs)

    monkeypatch.setattr(store.client, "delete", counted)
    store.delete_chunks("proj_a", [row.chunk_id for row in rows])
    assert calls["delete"] == 3 and store.count("proj_a") == 0


def test_a_write_the_store_refuses_raises(retriever, monkeypatch):
    """No other store holds the chunk: a refused write fails the file instead of passing as written."""

    def refused(*args: Any, **kwargs: Any) -> None:
        raise ConnectionError("qdrant down")

    monkeypatch.setattr(store_module, "_sleep", lambda seconds: None)
    monkeypatch.setattr(store_module.get_store().client, "upsert", refused)
    with pytest.raises(ConnectionError):
        _ingest(retriever, "proj_a", [_row("eins", "a.pdf")])


def test_adapter_never_imports_qdrant_client():
    """The adapter reaches Qdrant only through ``knowledge_layer.qdrant`` (ADR-0113)."""
    source = open(adapter_module.__file__, encoding="utf-8").read()
    assert not re.search(r"^\s*(from|import)\s+qdrant_client\b", source, re.MULTILINE)


def test_refresh_facts_copies_a_persons_edit_onto_the_points(retriever, monkeypatch):
    _ingest(retriever, "proj_a", [_row("eins", "a.pdf"), _row("zwei", "b.pdf")])
    facts = {"a.pdf": {"tags": ["bescheid"], "superseded": True, "doc_class": "Baubescheid"}}
    monkeypatch.setattr(writes, "facts_by_file", lambda scope, names=None: {n: facts[n] for n in (names or facts)})
    writes.refresh_facts("proj_a", ["a.pdf"])
    store = store_module.get_store()
    assert store.count("proj_a", {"tags": "bescheid"}) == 1
    assert store.count("proj_a", {"superseded": True}) == 1
    assert store.count("proj_a", {"doc_class": "Baubescheid"}) == 1


def test_copy_facts_repairs_a_copy_refresh_facts_swallowed_and_counts_the_files(retriever, monkeypatch):
    """The weekly reconcile's document facts half: what a failed copy left stale is copied again.

    ``refresh_facts`` never raises after a person's edit; ``copy_facts``, which the
    reconcile calls, raises so the sweep can count the failure.
    """
    _ingest(retriever, "proj_a", [_row("eins", "a.pdf"), _row("zwei", "b.pdf")])
    facts = {"a.pdf": {"tags": ["bescheid"], "superseded": True}, "b.pdf": {"tags": ["plan"]}}

    def metadata_store_down(scope, names=None):
        raise RuntimeError("metadata store down")

    monkeypatch.setattr(writes, "facts_by_file", metadata_store_down)
    writes.refresh_facts("proj_a")  # the edit's copy: logged, never raised
    with pytest.raises(RuntimeError):
        writes.copy_facts("proj_a")
    store = store_module.get_store()
    assert store.count("proj_a", {"tags": "bescheid"}) == 0

    monkeypatch.setattr(writes, "facts_by_file", lambda scope, names=None: {n: facts[n] for n in (names or facts)})
    assert writes.copy_facts("proj_a") == 2
    assert store.count("proj_a", {"tags": "bescheid"}) == 1
    assert store.count("proj_a", {"superseded": True}) == 1
    assert store.count("proj_a", {"tags": "plan"}) == 1


def test_an_ingest_job_stamps_the_projects_facts_on_its_chunks(retriever):
    """A new document is boosted and filtered like its siblings from its first search."""
    facts = {"bundesland": "wien", "gebaeudeklasse": [4], "bauweise": ["holzbau"]}
    _ingest(retriever, "proj_a", [_row("eins", "a.pdf")], project_facts=facts, project_status="closed")
    _ingest(retriever, "proj_a", [_row("zwei", "b.pdf")])
    store = store_module.get_store()
    assert store.count("proj_a", {"project_facts.bauweise": "holzbau", "project_status": "closed"}) == 1
    # A job with a status it does not know writes no facts rather than failing the file.
    _ingest(retriever, "proj_a", [_row("drei", "c.pdf")], project_facts=facts, project_status="archived")
    assert store.count("proj_a", {"project_facts.bauweise": "holzbau"}) == 1


async def test_search_grouped_carries_each_chunks_fused_score(retriever):
    from aiq_agent.knowledge.base import FUSED_SCORE_KEY

    _ingest(retriever, "proj_a", [_row("Fluchttreppe aus Holz", "a.pdf")])
    _ingest(retriever, "proj_b", [_row("Fluchttreppe", "b.pdf")])
    groups = await retriever.search_grouped("Fluchttreppe", ["proj_a", "proj_b"], groups=5, group_size=2)
    fused = [chunk.metadata[FUSED_SCORE_KEY] for _, chunks in groups for chunk in chunks]
    assert fused == sorted(fused, reverse=True) and all(score > 0 for score in fused)


async def test_search_grouped_ranks_projects_in_one_query(retriever):
    _ingest(retriever, "proj_a", [_row("Fluchttreppe aus Holz", "a.pdf"), _row("Fassade", "a2.pdf")])
    _ingest(retriever, "proj_b", [_row("Fluchttreppe als Sicherheitstreppenhaus", "b.pdf")])
    _ingest(retriever, "proj_c", [_row("Fluchttreppe", "c.pdf")])

    groups = await retriever.search_grouped("Fluchttreppe", ["proj_a", "proj_b"], groups=5, group_size=2)

    assert {scope for scope, _ in groups} == {"proj_a", "proj_b"}  # proj_c was not asked for
    assert all(chunk.metadata.get("file_name") for _, chunks in groups for chunk in chunks)


# ---------------------------------------------------------------- numeric legal references, end to end


NUMBERED = [
    "Gemäß § 3 Abs. 2 sind Fluchtwege vorzusehen.",
    "Nach §3 gilt dies sinngemäß.",
    "Punkt 5.1.1 der OIB-Richtlinie 2 regelt Treppen.",
    "Die Brüstungshöhe beträgt 43 cm.",
    "Abs. 3 und Seite 3 nennen keinen Paragraphen.",
    "OIB-Richtlinie 3 ist eine andere.",
    "Punkt 5.1.10 und § 13 Abs. 2 sind andere Stellen.",
]


async def test_numeric_legal_references_reach_the_exact_term_channel(retriever):
    """extract_exact_terms -> term_frequencies -> the phrase prefetch, as ``knowledge_search`` runs it.

    On the ``multilingual`` tokenizer every count here was 0, so
    ``selective_terms`` dropped the terms and the channel the Chroma path's
    ``$contains`` served never ran.
    """
    from knowledge_layer.qdrant import retrieval as qdrant_retrieval

    _ingest(retriever, "proj_a", [_row(text, f"{index}.pdf") for index, text in enumerate(NUMBERED)])

    _, terms = retriever._qdrant_lexical_inputs("Was regelt § 3 zur Fluchttreppe?", "proj_a")
    assert terms == ["§ 3"]
    _, terms = retriever._qdrant_lexical_inputs('Was sagt die OIB-Richtlinie 2 in "5.1.1"? Und "43 cm"?', "proj_a")
    assert terms == ["OIB-Richtlinie 2", "5.1.1", "43 cm"]

    total, frequencies = qdrant_retrieval.term_frequencies("proj_a", ["§ 3", "5.1.1", "43 cm", "OIB-Richtlinie 2"])
    assert total == len(NUMBERED)
    assert frequencies == {"§ 3": 2, "5.1.1": 1, "43 cm": 1, "OIB-Richtlinie 2": 1}

    # The exact channel alone beside the dense one: the two chunks citing § 3
    # are in both, every other chunk in one, so they lead.
    hits = qdrant_retrieval.search(
        "proj_a",
        vector=_vector("Was regelt § 3?"),
        lexical_text="",
        top_k=len(NUMBERED),
        filters=None,
        exact_terms=["§ 3"],
        identity=retriever._identity(),
    )
    assert {hit.payload["file_name"] for hit in hits[:2]} == {"0.pdf", "1.pdf"}


# ---------------------------------------------------------------- find_text narrows on the server


FIND_CORPUS = [
    "Die Größe der Fläche ist anzugeben.",
    "Die Grösse der Flaeche ist anzugeben.",
    "DIE GROESSE DER FLAECHE IST ANZUGEBEN.",
    "Die Größe der Fläche, geschützt.",
    "Die Größe-der-Fläche als Begriff.",
    "Die Größe der Fläche, zerlegt.",
    "Die Größe der Flächen im Plural.",
    "Größe und Fläche, ohne der.",
    "Die Strasse und die Straße und die STRASSE.",
    "Der Weg, der Steg, das EG und die Regel.",
    "EG-Richtlinie und eg.",
    "Hauptfluchtstiegen sind breit.",
    "Die Fluchtstiege ist beleuchtet.",
    "Gemäß § 3 Abs. 2 und 3 sowie §3.",
    "Punkt 5.1.1 und 15.1.10 und 5.1.10.",
    "OIB-Richtlinie 2 und OIB Richtlinie 2 und OIB-Richtlinie 21.",
    "T30-2 Tür und T30-2-Tür.",
    "Abs.2 und 3 ohne Leerzeichen; Abs. 2 und 3 mit.",
] + [f"Füllkapitel {index} über Beton und Holz." for index in range(40)]

FIND_PHRASES = [
    ["Größe der Fläche"],
    ["Grösse der Flaeche"],
    ["Strasse"],
    ["Straße", "Weg"],
    ["EG"],
    ["weg", "EG"],
    ["Fluchtstiege"],
    ["§ 3"],
    ["5.1.1"],
    ["OIB-Richtlinie 2"],
    ["T30-2 Tür"],
    ["Abs. 2 und 3"],
    ["Beton und Holz"],
    ["der"],
]


async def test_find_text_with_the_token_prefilter_returns_exactly_what_the_full_scroll_does(retriever, monkeypatch):
    from knowledge_layer.browse import phrase_pattern
    from knowledge_layer.qdrant import retrieval as qdrant_retrieval
    from knowledge_layer.qdrant import store as store_module

    _ingest(retriever, "proj_a", [_row(text, f"{index:02d}.pdf") for index, text in enumerate(FIND_CORPUS)])
    scanned = {"n": 0}
    real_scroll = store_module.QdrantStore.scroll

    def counting(self, *args, **kwargs):
        for record in real_scroll(self, *args, **kwargs):
            scanned["n"] += 1
            yield record

    monkeypatch.setattr(store_module.QdrantStore, "scroll", counting)

    def run(pattern: str) -> tuple[list[str], int]:
        scanned["n"] = 0
        hits = qdrant_retrieval.find_text("proj_a", pattern, None, 100)
        return [hit.chunk_id for hit in hits], scanned["n"]

    narrowed_patterns = 0
    for phrases in FIND_PHRASES:
        pattern = phrase_pattern(phrases)
        narrowed, narrowed_scanned = run(pattern)
        with monkeypatch.context() as full_scroll:
            full_scroll.setattr(qdrant_retrieval, "_text_prefilter", lambda scope, pattern: [])
            full, full_scanned = run(pattern)
        assert narrowed == full, phrases
        assert full_scanned == len(FIND_CORPUS)
        if qdrant_retrieval.literal_tokens(pattern):
            narrowed_patterns += 1
            assert narrowed_scanned < full_scanned, phrases
    # Not vacuous: most of these patterns narrow on the server.
    assert narrowed_patterns >= 8
    # And the matches themselves are the ones a reader expects.
    found, _ = run(phrase_pattern(["Größe der Fläche"]))
    assert len(found) == 7  # every spelling, the plural included (a substring), not "ohne der"


def test_literal_tokens_only_names_words_every_match_holds_whole():
    from knowledge_layer.browse import phrase_pattern
    from knowledge_layer.qdrant.retrieval import literal_tokens

    assert literal_tokens(phrase_pattern(["Größe der Fläche"])) == [["der"]]
    assert literal_tokens(phrase_pattern(["OIB-Richtlinie 2"])) == [["richtlinie"]]
    assert literal_tokens(phrase_pattern(["weg", "EG"])) == [["weg"], ["eg"]]
    # A word longer than three characters matches inside longer words: no token.
    assert literal_tokens(phrase_pattern(["Fluchtstiege"])) is None
    # One alternative without a safe word leaves no safe condition at all.
    assert literal_tokens(phrase_pattern(["Straße", "Weg"])) is None
    assert literal_tokens("(?i)fo+") is None


# ---------------------------------------------------------------- facts: per file, batched, cleared


@pytest.fixture
def metadata_store(tmp_path, monkeypatch):
    """A real SQLite metadata store, with ``facts_by_file`` reading it (the module fixture stubs it out)."""
    from aiq_agent.knowledge import configure_summary_db
    from aiq_agent.knowledge import factory

    monkeypatch.setattr(writes, "facts_by_file", FACTS_BY_FILE)
    factory._document_metadata_store = None
    configure_summary_db(f"sqlite:///{tmp_path / 'summaries.db'}")
    yield
    factory._document_metadata_store = None


def test_refreshing_one_file_reads_only_its_row(retriever, metadata_store, monkeypatch):
    from aiq_agent import knowledge
    from aiq_agent.knowledge import register_summary
    from aiq_agent.knowledge import set_document_tags_by_person

    _ingest(retriever, "proj_a", [_row("eins", "a.pdf"), _row("zwei", "b.pdf")])
    register_summary("proj_a", "a.pdf", "A")
    register_summary("proj_a", "b.pdf", "B")
    monkeypatch.setattr(
        knowledge, "get_available_documents", lambda scope: pytest.fail("a one-file refresh read the whole scope")
    )

    assert set_document_tags_by_person("proj_a", "a.pdf", ["bescheid"]) is True

    assert store_module.get_store().count("proj_a", {"tags": "bescheid"}) == 1


def test_a_folder_rename_mirrors_in_one_batch_not_one_request_per_file(retriever, metadata_store, monkeypatch):
    from aiq_agent.knowledge import register_summary
    from aiq_agent.knowledge import rewrite_document_folder_paths
    from aiq_agent.knowledge import set_document_folder_path

    names = [f"{index}.pdf" for index in range(5)]
    _ingest(retriever, "proj_a", [_row(f"Text {name}", name) for name in names])
    for name in names:
        register_summary("proj_a", name, f"Summary {name}")
        set_document_folder_path("proj_a", name, "Brandschutz/Fluchtwege")
    client = store_module.get_store().client
    calls = {"set_payload": 0, "batch_update_points": 0, "scroll": 0}
    for method in calls:
        real = getattr(client, method)

        def counted(*args, _real=real, _method=method, **kwargs):
            calls[_method] += 1
            return _real(*args, **kwargs)

        monkeypatch.setattr(client, method, counted)

    assert rewrite_document_folder_paths("proj_a", "Brandschutz", "Feuer") == 5

    assert calls == {"set_payload": 0, "batch_update_points": 1, "scroll": 0}
    store = store_module.get_store()
    assert store.count("proj_a", {"folder_ancestors": "feuer/fluchtwege"}) == 5
    assert store.count("proj_a", {"folder_ancestors": "brandschutz"}) == 0


def test_clearing_a_dokumentart_puts_the_chunks_own_back(retriever, metadata_store):
    from aiq_agent.knowledge import register_summary
    from aiq_agent.knowledge import set_document_doc_class

    _ingest(retriever, "proj_a", [_row("Plan", "plan.pdf", doc_class="einreichplan"), _row("Brief", "brief.pdf")])
    register_summary("proj_a", "plan.pdf", "P")
    register_summary("proj_a", "brief.pdf", "B")
    store = store_module.get_store()
    set_document_doc_class("proj_a", "plan.pdf", "bescheid")
    set_document_doc_class("proj_a", "brief.pdf", "korrespondenz")
    assert store.count("proj_a", {"doc_class": "bescheid"}) == 1
    assert store.count("proj_a", {"doc_class": "korrespondenz"}) == 1

    set_document_doc_class("proj_a", "plan.pdf", None)
    set_document_doc_class("proj_a", "brief.pdf", None)

    # What register._hit_doc_class falls back to once the stored class is gone.
    assert store.count("proj_a", {"doc_class": "einreichplan"}) == 1
    assert store.count("proj_a", {"doc_class": "bescheid"}) == 0
    assert store.count("proj_a", {"doc_class": "korrespondenz"}) == 0


async def test_a_hit_carries_the_chunks_own_dokumentart(retriever, metadata_store):
    from aiq_agent.knowledge import register_summary
    from aiq_agent.knowledge import set_document_doc_class

    _ingest(retriever, "proj_a", [_row("Plan", "plan.pdf", doc_class="einreichplan")])
    register_summary("proj_a", "plan.pdf", "P")
    set_document_doc_class("proj_a", "plan.pdf", "bescheid")

    result = await retriever.retrieve("Plan", "proj_a", top_k=1)

    assert result.chunks[0].metadata.get("doc_class") == "einreichplan"


# ---------------------------------------------------------------- what BM25 may be asked for


def test_bm25_candidates_leave_out_the_stopwords_qdrants_folding_lets_through():
    """Qdrant folds „über“ to ``uber`` before its German stopword list runs, so it
    ranked every chunk with an „über“ for „was weißt du über die oib 1“."""
    from knowledge_layer.qdrant.retrieval import bm25_candidates

    assert "über" not in bm25_candidates("was weißt du über die oib 1")
    assert bm25_candidates("Anforderungen für Fluchtwege während des Brandes") == [
        "anforderungen",
        "fluchtwege",
        "des",
        "brandes",
    ]


def test_bm25_candidates_leave_out_the_pieces_of_a_file_name():
    """„oib-rl_5_ausgabe_mai_2023.pdf“ asked BM25 for „ausgabe mai 2023“, every Richtlinie's front matter."""
    from knowledge_layer.qdrant.retrieval import bm25_candidates

    assert bm25_candidates("oib-rl_5_ausgabe_mai_2023.pdf") == []
    assert bm25_candidates("Was steht in Brandschutzkonzept_V2.PDF zur Fluchttreppe?") == [
        "was",
        "steht",
        "zur",
        "fluchttreppe",
    ]
    assert "5.1.1" in bm25_candidates("Punkt 5.1.1 der OIB-RL 2"), "a Punkt number is no file name"


def test_umlaut_stopwords_never_reach_bm25_whatever_their_frequency(retriever):
    rows = [_row(f"Abschnitt {i} regelt die Treppe.", "rl.pdf") for i in range(24)]
    rows += [_row(f"Fluchtwege führen über das Dach {i}.", "rl.pdf") for i in range(4)]
    _ingest(retriever, "oib_knowledge", rows)

    text, _terms = retriever._qdrant_lexical_inputs("Fluchtwege über das Dach", "oib_knowledge")

    assert "über" not in text.split() and "fluchtwege" in text.split()


# ---------------------------------------------------------------- grouped search: BM25 priced over the union


def _write(retriever: LlamaIndexRetriever, scope: str, texts: list[str]) -> None:
    records = [_record(text, f"{scope}_{i}.pdf") for i, text in enumerate(texts)]
    store_module.get_store(retriever._identity()).upsert(scope, records)


@pytest.fixture
def three_projects(retriever):
    """Two searched projects (56 chunks together) and one that is not searched.

    „Ausgabe“ is on every searched chunk; „Holzbau“ on half of proj_a (13 of
    26) but under a quarter of the union (13 of 56); „Fluchttreppe“ only in
    proj_c, which the search does not reach.
    """
    _write(retriever, "proj_a", [f"Ausgabe {i}: Holzbau im Wohnbau" for i in range(13)])
    _write(retriever, "proj_a", [f"Ausgabe {i}: Fassade aus Glas" for i in range(13, 26)])
    _write(retriever, "proj_b", [f"Ausgabe {i}: Stahlbeton und Decken" for i in range(30)])
    _write(retriever, "proj_c", [f"Fluchttreppe Nummer {i}" for i in range(30)])
    return retriever


def test_term_frequencies_count_over_the_union_of_the_searched_scopes(three_projects):
    from knowledge_layer.qdrant import retrieval

    total, counts = retrieval.term_frequencies(["proj_a", "proj_b"], ["holzbau", "ausgabe", "fluchttreppe"])
    assert (total, counts) == (56, {"holzbau": 13, "ausgabe": 56, "fluchttreppe": 0})
    assert retrieval.term_frequencies("proj_a", ["holzbau"]) == (26, {"holzbau": 13})


async def test_grouped_search_prices_bm25_over_the_searched_scopes(three_projects, monkeypatch):
    """Cross-project search sent the raw question to BM25 (qdrant-gates-2026-10.md, "Open, before the flip").

    Priced over the union: the ubiquitous „Ausgabe“ and the unreachable
    „Fluchttreppe“ drop out, and „Holzbau“, common in one project but selective
    across both, stays.
    """
    from knowledge_layer.qdrant import retrieval

    sent: list[str] = []
    real = retrieval.search_grouped

    def spy(scopes, **kwargs):
        sent.append(kwargs["lexical_text"])
        return real(scopes, **kwargs)

    monkeypatch.setattr(retrieval, "search_grouped", spy)
    three_projects.hybrid_search = True

    groups = await three_projects.search_grouped("Holzbau Fluchttreppe Ausgabe", ["proj_a", "proj_b"], 5, 2)

    assert sent == ["holzbau"]
    assert groups and {scope for scope, _ in groups} <= {"proj_a", "proj_b"}
    assert ("proj_a,proj_b", 56, "holzbau") in three_projects._qdrant_term_df


async def test_grouped_search_runs_the_exact_term_channels(three_projects, monkeypatch):
    """Cross-project „§ 8“ got neither the ``paragraph_refs`` nor the phrase channel:
    grouped search passed no exact terms. Now the one passage citing it ranks first."""
    from knowledge_layer.qdrant import retrieval

    _write(three_projects, "proj_b", ["Nach § 8 sind die Decken brandbeständig auszuführen."])
    sent: list[list[str]] = []
    real = retrieval.search_grouped

    def spy(scopes, **kwargs):
        sent.append(list(kwargs["exact_terms"]))
        return real(scopes, **kwargs)

    monkeypatch.setattr(retrieval, "search_grouped", spy)
    three_projects.hybrid_search = True

    groups = await three_projects.search_grouped("Was regelt § 8?", ["proj_a", "proj_b"], 5, 2)

    assert sent == [["§ 8"]]
    scope, hits = groups[0]
    assert scope == "proj_b" and "§ 8" in hits[0].content


# ---------------------------------------------------------------- health


async def test_health_is_qdrants(retriever, monkeypatch):
    """Qdrant is the one store: it answering is the whole of health."""
    assert await retriever.health_check() is True
    monkeypatch.setattr(store_module.QdrantStore, "health", lambda self: False)
    assert await retriever.health_check() is False


# ---------------------------------------------------------------- superseded follows the newer row


def test_removing_the_newer_fassung_makes_the_older_one_findable_again(retriever, metadata_store):
    """A link counts only while the newer row exists; the points must say what the rows say.

    Left ``superseded: true``, the ``superseded != true`` pre-filter hid the
    Fassung that had become the current one from every search.
    """
    from aiq_agent.knowledge import link_document_fassung
    from aiq_agent.knowledge import register_summary
    from aiq_agent.knowledge import unregister_summary

    _ingest(retriever, "proj_a", [_row("Alte Statik", "alt.pdf"), _row("Neue Statik", "neu.pdf")])
    register_summary("proj_a", "alt.pdf", "A")
    register_summary("proj_a", "neu.pdf", "N")
    link_document_fassung("proj_a", "alt.pdf", "neu.pdf")
    store = store_module.get_store()
    assert store.count("proj_a", {"superseded": True, "file_name": "alt.pdf"}) == 1

    unregister_summary("proj_a", "neu.pdf")
    assert store.count("proj_a", {"superseded": True}) == 0

    register_summary("proj_a", "neu.pdf", "N, wieder da")
    assert store.count("proj_a", {"superseded": True, "file_name": "alt.pdf"}) == 1


def test_clearing_many_dokumentarten_restores_them_in_one_batch(retriever, metadata_store, monkeypatch):
    names = [f"{index}.pdf" for index in range(4)]
    _ingest(retriever, "proj_a", [_row(f"Plan {name}", name, doc_class="einreichplan") for name in names])
    store = store_module.get_store()
    store.set_file_payloads("proj_a", {name: {"doc_class": "bescheid"} for name in names})
    monkeypatch.setattr(writes, "facts_by_file", lambda scope, names=None: {name: {"tags": []} for name in names})
    calls = {"batch_update_points": 0}
    real = store.client.batch_update_points

    def counted(*args, **kwargs):
        calls["batch_update_points"] += 1
        return real(*args, **kwargs)

    monkeypatch.setattr(store.client, "batch_update_points", counted)

    writes.refresh_facts("proj_a", names)

    assert calls["batch_update_points"] == 2  # the facts, then every restore together
    assert store.count("proj_a", {"doc_class": "einreichplan"}) == 4


# ---------------------------------------------------------------- the query vector for a caller


def test_embed_query_initializes_without_reaching_any_store(monkeypatch):
    """„Im Büro behandelt“ embeds the selected sentence first: that needs the embedder, never a vector store."""

    class Embedder:
        def get_query_embedding(self, text: str) -> list[float]:
            return _vector(text)

    monkeypatch.delenv("AIQ_QDRANT_URL", raising=False)
    monkeypatch.setattr(adapter_module, "make_embed_model", lambda **kwargs: Embedder())
    monkeypatch.setattr(store_module, "get_store", lambda *a, **k: pytest.fail("embedding reached the store"))
    instance = LlamaIndexRetriever({"embed_model": "test-model", "embed_base_url": "https://test"})

    assert instance.embed_query("Brandwand zwischen Reihenhäusern") == _vector("Brandwand zwischen Reihenhäusern")
    assert instance.embedding_identity() == instance._identity() != {}
