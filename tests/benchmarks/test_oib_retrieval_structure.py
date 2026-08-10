"""Offline tests for the OIB retrieval harness's corpus, structure, lexical and dense arms.

Everything here runs without a network, an API key, a PDF or a model download: the
documents are synthetic page dicts of the exact shape
``knowledge_layer.llamaindex.adapter._extract_text_from_pdf`` returns, and the dense arm is
the deterministic hashed embedder. The real corpus run and the real model live in
``runner.py`` behind an explicit flag, deliberately outside CI.

Import fallback as in ``test_oib_compliance_checklist.py`` — see the sibling
``test_oib_retrieval_metrics.py`` docstring.
"""

import sys
from pathlib import Path

import pytest

try:
    from oib_retrieval_eval import corpus
    from oib_retrieval_eval import dense
    from oib_retrieval_eval import lexical
    from oib_retrieval_eval import structure
    from oib_retrieval_eval.qrels import PunktIndex
except ImportError:
    _SRC = Path(__file__).resolve().parents[2] / "frontends" / "benchmarks" / "oib_retrieval" / "src"
    sys.path.insert(0, str(_SRC))
    from oib_retrieval_eval import corpus
    from oib_retrieval_eval import dense
    from oib_retrieval_eval import lexical
    from oib_retrieval_eval import structure
    from oib_retrieval_eval.qrels import PunktIndex

pytest.importorskip("llama_index.core", reason="the chunking arms are llama-index Documents")

FILE_NAME = "oib-rl_9_ausgabe_mai_2023.pdf"
HEADER = "Österreichisches Institut für Bautechnik OIB-330.9-001/23 OIB-Richtlinie 9"
FOOTER = "OIB-Richtlinie 9 Ausgabe Mai 2023 Seite {page} von 2"


def _page(number: int, body: str) -> dict:
    return {"page_number": number, "text": f"{HEADER}\n{body.strip()}\n{FOOTER.format(page=number)}"}


@pytest.fixture(scope="module")
def synthetic_pages() -> list[dict]:
    """Two body pages carrying eight Punkte, in the shape the real corpus has.

    Short enough that one 1024-token page chunk swallows a whole page — which is precisely
    the page-arm failure the structural metric exists to expose.
    """
    page_one = """
0 Vorbemerkungen
Diese Richtlinie gilt für Gebäude.
1 Begriffsbestimmungen
Es gelten die Begriffsbestimmungen des Dokumentes.
2 Fluchtwege
2.1 Gehweglänge
2.1.1 Von jeder Stelle jedes Raumes muss in höchstens 40 m Gehweglänge ein direkter Ausgang
zu einem sicheren Ort des angrenzenden Geländes im Freien erreichbar sein.
2.1.2 Bei Wohnungen wird die Gehweglänge ab der Wohnungseingangstüre gemessen.
2.2 Breite
2.2.1 Hauptgänge müssen eine lichte Durchgangsbreite von mindestens 1,20 m aufweisen.
"""
    page_two = """
3 Brandabschnitte
3.1 Brandabschnitte in oberirdischen Geschoßen dürfen eine maximale Netto-Grundfläche von
1.600 m² nicht überschreiten.
3.2 Brandabschnitte in unterirdischen Geschoßen dürfen eine maximale Netto-Grundfläche von
800 m² nicht überschreiten.
Impressum
Medieninhaber und Herausgeber: OIB
"""
    return [_page(1, page_one), _page(2, page_two)]


@pytest.fixture(scope="module")
def synthetic_index() -> PunktIndex:
    def entry(page: int, heading: str) -> dict:
        return {"file_name": FILE_NAME, "pages": [page], "heading": heading}

    return PunktIndex(
        {
            "9": {
                "0": entry(1, "Vorbemerkungen"),
                "1": entry(1, "Begriffsbestimmungen"),
                "2": entry(1, "Fluchtwege"),
                "2.1": entry(1, "Gehweglänge"),
                "2.1.1": entry(1, "Von jeder Stelle jedes Raumes"),
                "2.1.2": entry(1, "Bei Wohnungen wird die Gehweglänge"),
                "2.2": entry(1, "Breite"),
                "2.2.1": entry(1, "Hauptgänge müssen eine lichte"),
                "3": entry(2, "Brandabschnitte"),
                "3.1": entry(2, "Brandabschnitte in oberirdischen"),
                "3.2": entry(2, "Brandabschnitte in unterirdischen"),
            },
            "_unresolved": {},
        }
    )


# ---------------------------------------------------------------------------
# The structural before/after
# ---------------------------------------------------------------------------


def test_every_indexed_punkt_is_located_in_the_extracted_line_stream(synthetic_index, synthetic_pages):
    _results, located, _parents, unlocated = structure.measure_document(
        synthetic_index, "9", synthetic_pages, FILE_NAME, 1024
    )
    assert unlocated == []
    assert located == 11


def test_structural_parents_are_counted_from_the_index_and_excluded_from_the_leaves(synthetic_index, synthetic_pages):
    results, _located, parents, _unlocated = structure.measure_document(
        synthetic_index, "9", synthetic_pages, FILE_NAME, 1024
    )
    # "2", "2.1", "2.2" and "3" have numbered children; the other seven Punkte are leaves.
    assert parents == 4
    assert results[corpus.ARM_PAGE].leaf_punkte == 7
    assert results[corpus.ARM_PUNKT].leaf_punkte == 7


def test_page_chunking_blends_many_punkte_into_one_chunk_so_almost_none_is_citable(synthetic_index, synthetic_pages):
    results, _located, _parents, _unlocated = structure.measure_document(
        synthetic_index, "9", synthetic_pages, FILE_NAME, 1024
    )
    page_arm = results[corpus.ARM_PAGE]
    # One chunk per page swallows the page whole: every Punkt on it is contiguous, and
    # essentially none of them is the chunk's own unit.
    assert page_arm.contiguous == page_arm.leaf_punkte
    assert page_arm.isolated <= 1
    assert page_arm.punkte_per_chunk > 2.0


def test_punkt_chunking_makes_almost_every_punkt_its_own_citable_chunk(synthetic_index, synthetic_pages):
    results, _located, _parents, _unlocated = structure.measure_document(
        synthetic_index, "9", synthetic_pages, FILE_NAME, 1024
    )
    punkt_arm = results[corpus.ARM_PUNKT]
    assert punkt_arm.isolated == punkt_arm.leaf_punkte
    assert punkt_arm.punkte_per_chunk == pytest.approx(1.0)
    assert punkt_arm.isolated_pct == pytest.approx(100.0)


def test_the_punkt_arm_is_strictly_better_on_the_citable_unit_property(synthetic_index, synthetic_pages):
    results, _located, _parents, _unlocated = structure.measure_document(
        synthetic_index, "9", synthetic_pages, FILE_NAME, 1024
    )
    assert results[corpus.ARM_PUNKT].isolated > results[corpus.ARM_PAGE].isolated


def test_text_after_the_impressum_is_not_absorbed_into_the_last_punkt(synthetic_index, synthetic_pages):
    # Punkt 3.2 is the last one; the colophon that follows it must not be part of its span,
    # or it would fail containment on every arm for a reason unrelated to chunking.
    results, _located, _parents, _unlocated = structure.measure_document(
        synthetic_index, "9", synthetic_pages, FILE_NAME, 1024
    )
    assert results[corpus.ARM_PUNKT].contiguous == results[corpus.ARM_PUNKT].leaf_punkte


# ---------------------------------------------------------------------------
# Chunk building and the unit collapse
# ---------------------------------------------------------------------------


def test_the_punkt_arm_emits_more_and_smaller_chunks_than_the_page_arm(synthetic_pages):
    page_chunks = corpus._chunks_from_documents(
        corpus.page_documents(synthetic_pages, FILE_NAME, 1024), FILE_NAME, corpus.ARM_PAGE
    )
    punkt_chunks = corpus._chunks_from_documents(
        corpus.punkt_or_page_documents(synthetic_pages, FILE_NAME, 1024), FILE_NAME, corpus.ARM_PUNKT
    )
    assert len(punkt_chunks) > len(page_chunks)
    assert all(chunk.page > 0 for chunk in punkt_chunks)
    assert {chunk.arm for chunk in punkt_chunks} == {corpus.ARM_PUNKT}


def test_ranked_chunks_collapse_to_distinct_units_keeping_the_first_occurrence():
    chunks = [
        corpus.Chunk(chunk_id="a", text="", file_name="x.pdf", page=5, arm="punkt"),
        corpus.Chunk(chunk_id="b", text="", file_name="x.pdf", page=5, arm="punkt"),
        corpus.Chunk(chunk_id="c", text="", file_name="x.pdf", page=6, arm="punkt"),
    ]
    assert corpus.dedupe_to_units(chunks) == [("x.pdf", 5), ("x.pdf", 6)]
    assert corpus.dedupe_to_units(chunks, limit=1) == [("x.pdf", 5)]


def test_the_production_exclusion_list_still_covers_every_change_log_pdf():
    # The ONLY thing keeping the aenderungen_* change logs out of answers is this list in
    # configs/config_oib_openrouter.yml. A new change-log file that nobody adds to it is a
    # silent regression, so the harness asserts the list is still complete.
    excluded = corpus.production_excluded_file_names()
    corpus_dir = corpus.default_corpus_dir()
    if not corpus_dir.exists() or not excluded:
        pytest.skip("data/oib or the production OIB config is not present in this checkout")
    change_logs = {path.name for path in corpus_dir.glob("aenderungen_*.pdf")}
    assert change_logs, "no aenderungen_* files found — the forbidden-hit metric would measure nothing"
    assert change_logs <= excluded


# ---------------------------------------------------------------------------
# The lexical channel
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def lexical_corpus(synthetic_pages) -> lexical.LexicalIndex:
    chunks = corpus._chunks_from_documents(
        corpus.punkt_or_page_documents(synthetic_pages, FILE_NAME, 1024), FILE_NAME, corpus.ARM_PUNKT
    )
    return lexical.build_index(chunks)


def test_a_german_question_retrieves_the_punkt_that_answers_it(lexical_corpus):
    hits = lexical.search(lexical_corpus, "Wie lang darf die Gehweglänge zum Ausgang sein?", 5)
    assert hits, "the German lexical channel must fire on a German question"
    assert any("40 m Gehweglänge" in hit.text for hit in hits)


def test_german_morphology_variants_of_one_need_reach_the_same_punkt(lexical_corpus):
    # 'Gehweglänge' vs 'Gehweglängen': the shipped stemmer folds the inflection, which is
    # the property the golden set's morphology variants exist to keep measured.
    first = lexical.search(lexical_corpus, "Gehweglänge", 3)
    second = lexical.search(lexical_corpus, "Gehweglängen", 3)
    assert first and second
    assert first[0].chunk_id == second[0].chunk_id


def test_the_lexical_channel_is_silent_for_an_english_question_by_construction(lexical_corpus):
    # german_text's own docstring states this: an English term has document frequency 0 in
    # a German corpus, so select_terms drops it and the channel correctly returns nothing
    # rather than the chunks that merely share a digit.
    assert lexical.selected_terms(lexical_corpus, "What is the maximum escape route length?") == []
    assert lexical.search(lexical_corpus, "What is the maximum escape route length?", 5) == []


def test_the_tsquery_handed_to_postgres_ors_the_surviving_lexemes(lexical_corpus):
    query = lexical.tsquery_for(lexical_corpus, "Gehweglänge Ausgang")
    assert " | " in query
    assert query.count("'") % 2 == 0


def test_the_document_frequency_ceiling_is_not_applied_to_a_collection_this_small(lexical_corpus):
    # 'Richtlinie' appears in nearly every chunk, but german_text deliberately suspends the
    # ceiling below DEFAULT_DF_CEILING_MIN_TOTAL rows: in a ten-chunk collection every
    # content word looks too frequent, and dropping them all would silence the channel for
    # a project collection. The harness measures the shipped rule, so it must show it.
    from aiq_agent.common.german_text import DEFAULT_DF_CEILING_MIN_TOTAL
    from aiq_agent.common.german_text import select_terms

    assert lexical_corpus.total < DEFAULT_DF_CEILING_MIN_TOTAL
    assert lexical.search(lexical_corpus, "Richtlinie", 5) != []

    # With the collection large enough for a ratio to mean anything, the same lexeme is
    # dropped and the channel correctly returns nothing instead of the whole corpus.
    assert select_terms(["richtlini"], {"richtlini": 90}, 100, df_ceiling_ratio=0.2, min_total=1) == []
    assert select_terms(["gehweglang"], {"gehweglang": 3}, 100, df_ceiling_ratio=0.2, min_total=1) == ["gehweglang"]


# ---------------------------------------------------------------------------
# The dense arm's CI path
# ---------------------------------------------------------------------------


def test_the_hashed_embedder_is_deterministic_and_unit_normalised():
    import numpy as np

    embedder = dense.HashedEmbedder()
    first = embedder.encode_documents(["Gehweglänge von höchstens 40 m"])
    second = embedder.encode_documents(["Gehweglänge von höchstens 40 m"])
    assert np.array_equal(first, second)
    assert float(np.linalg.norm(first[0])) == pytest.approx(1.0, abs=1e-6)


def test_the_dense_index_returns_the_requested_depth_in_descending_similarity(synthetic_pages):
    chunks = corpus._chunks_from_documents(
        corpus.punkt_or_page_documents(synthetic_pages, FILE_NAME, 1024), FILE_NAME, corpus.ARM_PUNKT
    )
    embedder = dense.HashedEmbedder()
    index = dense.build_dense_index(embedder, chunks)
    hits = index.search(embedder, "Brandabschnitte in unterirdischen Geschoßen", 3)
    assert len(hits) == 3
    assert "unterirdischen" in hits[0].text


def test_asking_for_an_unknown_embedder_is_an_error_not_a_silent_fallback():
    with pytest.raises(ValueError):
        dense.make_embedder("text-embedding-3-large")


# ---------------------------------------------------------------------------
# The fused path, through the production helpers
# ---------------------------------------------------------------------------


def test_the_hybrid_path_runs_through_the_production_fusion_and_merge(synthetic_pages):
    from oib_retrieval_eval import runner

    chunks = corpus._chunks_from_documents(
        corpus.punkt_or_page_documents(synthetic_pages, FILE_NAME, 1024), FILE_NAME, corpus.ARM_PUNKT
    )
    embedder = dense.HashedEmbedder()
    dense_index = dense.build_dense_index(embedder, chunks)
    lexical_index = lexical.build_index(chunks)
    question = "Wie lang darf die Gehweglänge zum Ausgang sein?"

    fused = runner._hybrid(
        dense_index.search(embedder, question, 10),
        lexical.search(lexical_index, question, 10),
        10,
    )
    assert fused, "fusion must not swallow both channels"
    assert len(fused) == len(set(fused)), "the fused ranking must be distinct units"
    assert all(isinstance(unit[1], int) and unit[1] > 0 for unit in fused)


def test_the_production_diversity_cap_limits_pages_taken_from_one_document(synthetic_pages):
    from oib_retrieval_eval import runner

    chunks = corpus._chunks_from_documents(
        corpus.punkt_or_page_documents(synthetic_pages, FILE_NAME, 1024), FILE_NAME, corpus.ARM_PUNKT
    )
    embedder = dense.HashedEmbedder()
    dense_index = dense.build_dense_index(embedder, chunks)
    fused = runner._hybrid(dense_index.search(embedder, "Brandabschnitte", 10), [], 10)
    # Every synthetic chunk is from one file, so the soft cap plus the fill pass decides
    # how many of its pages survive; the invariant under test is that the merge ran at all
    # and returned a bounded, ordered result rather than the whole ranking.
    assert 0 < len(fused) <= 10


# ---------------------------------------------------------------------------
# The failure mode the harness found in the real corpus, reproduced offline
# ---------------------------------------------------------------------------


def test_a_numbered_table_derails_punkt_chunking_and_the_metric_shows_it():
    """A table whose ROWS are numbered is read as a Punkt sequence, and the metric catches it.

    This is the real defect the harness surfaced in OIB-Richtlinie 6: the U-value table's
    rows ("5 WÄNDE (Trennwände) …", "6 WÄNDE gegen andere Bauwerke …") parse as top-level
    Punkte, they are monotonic, so they are accepted — and every genuine Punkt after them
    is then rejected as non-monotonic and absorbed into the last accepted segment. The
    structural metric must report that as a citability collapse rather than average it
    away, which is the property under test here.
    """
    body_one = """
1 Allgemeines
Diese Richtlinie gilt für Gebäude.
2 Anforderungen
2.1 Beim Neubau dürfen folgende Wärmedurchgangskoeffizienten nicht überschritten werden:
1 WÄNDE gegen Außenluft 0,35
2 WÄNDE gegen unbeheizte Dachräume 0,35
3 WÄNDE erdberührt 0,40
4 FENSTER gegen Außenluft 1,40
"""
    body_two = """
2.2 Sommerlicher Wärmeschutz ist beim Neubau von Wohngebäuden einzuhalten.
2.3 Die Luftdichtheit der Gebäudehülle ist nachzuweisen.
"""
    pages = [_page(1, body_one), _page(2, body_two)]
    index = PunktIndex(
        {
            "6": {
                "1": {"file_name": FILE_NAME, "pages": [1], "heading": "Allgemeines"},
                "2": {"file_name": FILE_NAME, "pages": [1], "heading": "Anforderungen"},
                "2.1": {"file_name": FILE_NAME, "pages": [1], "heading": "Beim Neubau"},
                "2.2": {"file_name": FILE_NAME, "pages": [2], "heading": "Sommerlicher Wärmeschutz"},
                "2.3": {"file_name": FILE_NAME, "pages": [2], "heading": "Die Luftdichtheit"},
            },
            "_unresolved": {},
        }
    )
    results, located, _parents, unlocated = structure.measure_document(index, "6", pages, FILE_NAME, 1024)

    # Ground truth is unaffected: all five Punkte are found in the raw line stream.
    assert located == 5
    assert unlocated == []
    # But the Punkt chunker loses the ones that follow the numbered table, so they are not
    # their own citable unit any more — and the metric says so instead of scoring ~100%.
    punkt_arm = results[corpus.ARM_PUNKT]
    assert punkt_arm.isolated < punkt_arm.leaf_punkte
