"""Backlog 11: broad overview query goes vector-only, fills top-k, hedges.

Root cause pinned here, fix ratcheted here: the turn-1 formulation
"was weißt du über die oib 2" carries no usable lexical signal while the
precise rewrite "OIB-Richtlinie 2 Brandschutz" lights all three channels.

(a) exact-terms: lowercase bare "oib" yields nothing (legal_terms.isupper),
    the canonical form yields a term.
(b) sparse: with real chunk_text_store frequencies (OIB/Richtlinie are
    corpus-identity words above the DF ceiling, filler words absent),
    the broad query keeps nothing while the precise one keeps the
    brandschutz stem.
(c) query formulation: turn-1 normalization must produce the retrievable
    formulation (canonical "OIB-Richtlinie N" + discipline term) so the
    first retrieval already sees what the turn-2 rewrite used to discover
    via history.

All offline: no LLM, no network, SQLite mirror only.
"""

from __future__ import annotations

from aiq_agent.common import german_text as g
from aiq_agent.common.legal_terms import extract_exact_terms
from aiq_agent.knowledge.chunk_text_store import ChunkTextRow
from aiq_agent.knowledge.chunk_text_store import ChunkTextStore

BROAD = "was weißt du über die oib 2"
PRECISE = "OIB-Richtlinie 2 Brandschutz"


def test_broad_overview_query_yields_no_exact_term_while_precise_does() -> None:
    """(a) The lexical $contains channel is blind to the broad form."""
    assert extract_exact_terms(BROAD) == []
    assert extract_exact_terms(PRECISE) != []
    assert "OIB-Richtlinie 2" in extract_exact_terms(PRECISE)


def _overview_store(tmp_path) -> ChunkTextStore:
    """SQLite mirror with a realistic DF profile: OIB/Richtlinie everywhere.

    27 generic normative chunks plus 3 Brandschutz chunks (30 total, so the
    25-row DF ceiling applies). "was"/"weißt"/"über" appear nowhere (df 0),
    "die"/"oib"/"richtlinie" everywhere (dropped by the ceiling), "2" in a
    few, "brandschutz" only in the 3 topical chunks.
    """
    url = f"sqlite:///{tmp_path / 'overview.db'}"
    store = ChunkTextStore(url)
    rows: list[ChunkTextRow] = []
    for i in range(27):
        rows.append(
            ChunkTextRow(
                chunk_id=f"g{i}",
                body=(
                    "Die OIB Richtlinie stellt allgemeine Anforderungen an Punkt 3.1 "
                    "der Bauweise. Die Anforderungen gelten für jedes Gebäude."
                ),
                file_name="oib-rl_4_ausgabe_mai_2023.pdf",
                page_label="1",
            )
        )
    for i in range(3):
        rows.append(
            ChunkTextRow(
                chunk_id=f"b{i}",
                body=(
                    "Die OIB Richtlinie 2 regelt den Brandschutz. Brandabschnitte und "
                    "Fluchtwege müssen den Anforderungen entsprechen."
                ),
                file_name="oib-rl_2_ausgabe_mai_2023.pdf",
                page_label="1",
            )
        )
    assert store.upsert_many("oib_knowledge", rows) == 30
    return store


def test_sparse_survivors_empty_for_broad_but_keep_brandschutz_for_precise(tmp_path) -> None:
    """(b) The German sparse channel is silent for the broad form only."""
    store = _overview_store(tmp_path)

    broad_cands = g.analyze_query(BROAD)
    broad_freqs = store.document_frequencies("oib_knowledge", broad_cands)
    broad_kept = g.select_terms(broad_cands, broad_freqs.counts, broad_freqs.total)
    assert broad_kept == []
    assert store.search("oib_knowledge", BROAD) == []

    precise_cands = g.analyze_query(PRECISE)
    precise_freqs = store.document_frequencies("oib_knowledge", precise_cands)
    precise_kept = g.select_terms(precise_cands, precise_freqs.counts, precise_freqs.total)
    assert "brandschutz" in precise_kept
    assert store.search("oib_knowledge", PRECISE) != []


def test_turn1_normalization_produces_retrievable_formulation(tmp_path) -> None:
    """(c) Turn-1 rewrite must already contain what turn-2 used to discover.

    The normalization is deterministic (no LLM): canonical "OIB-Richtlinie N"
    plus the discipline term, so the first retrieval sees the exact-terms
    channel and the sparse channel at once.
    """
    from aiq_agent.common.query_expansion import canonicalize_oib_query

    rewritten = canonicalize_oib_query(BROAD)
    assert "OIB-Richtlinie 2" in rewritten
    assert "Brandschutz" in rewritten
    # The rewritten form lights the exact channel the raw form missed.
    assert extract_exact_terms(rewritten) != []
    # And the sparse channel: the broad form searched nothing, the rewritten
    # form reaches the topical chunks.
    store = _overview_store(tmp_path)
    assert store.search("oib_knowledge", BROAD) == []
    assert store.search("oib_knowledge", rewritten) != []


def test_canonicalization_is_idempotent_and_leaves_precise_queries_alone() -> None:
    from aiq_agent.common.query_expansion import canonicalize_oib_query

    assert canonicalize_oib_query(PRECISE) == PRECISE
    once = canonicalize_oib_query(BROAD)
    assert canonicalize_oib_query(once) == once


def test_canonicalization_leaves_non_oib_queries_untouched() -> None:
    from aiq_agent.common.query_expansion import canonicalize_oib_query

    for q in ("Wie breit muss ein Fluchtweg sein?", "", "   "):
        assert canonicalize_oib_query(q) == (q or "")
