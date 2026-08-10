"""Regression tests for the retrieval score scale, chunk identity, and embed metadata.

Each test here pins a defect that the suite passed straight through before, because
none of the three seams had any coverage at all:

- ``_chunks_from_raw_query`` fabricated a fresh ``uuid4`` for every lexical-channel
  chunk (``TextNode(node_id=...)`` is a read-only property, silently dropped by
  pydantic), so reciprocal rank fusion could never match a chunk across channels.
- ``normalize`` reported the store's ``exp(-distance)`` as if it were a cosine
  similarity, putting an *orthogonal* chunk at 0.37 and making the one threshold in
  the codebase a no-op.
- No document set ``excluded_embed_metadata_keys``, so LlamaIndex prepended the whole
  metadata dict -- ``file_size`` included -- to every chunk before embedding.

All offline: no ChromaDB, no embeddings, no network.
"""

from __future__ import annotations

import math
from types import SimpleNamespace

import pytest

from sources.knowledge_layer.src.llamaindex.adapter import EMBED_EXCLUDED_METADATA_KEYS
from sources.knowledge_layer.src.llamaindex.adapter import LlamaIndexRetriever
from sources.knowledge_layer.src.llamaindex.adapter import _apply_metadata_exclusions
from sources.knowledge_layer.src.llamaindex.adapter import _to_chroma_where
from sources.knowledge_layer.src.llamaindex.adapter import cosine_similarity_from_store_score

# ===========================================================================
# Score scale
# ===========================================================================


def test_orthogonal_chunk_scores_zero_not_zero_point_three_seven() -> None:
    """The store reports exp(-distance); at cosine 0 that is 0.37, not 0.

    This is the whole defect: a chunk with no relationship to the query was printed
    into the grounding block as ``Relevance Score: 0.37`` and read by the answering
    model as a moderate match.
    """
    assert cosine_similarity_from_store_score(math.exp(-1.0)) == pytest.approx(0.0, abs=1e-9)
    assert cosine_similarity_from_store_score(math.exp(-2.0)) == 0.0  # contradictory, floored


def test_conversion_is_exact_for_real_similarities() -> None:
    for cosine in (0.9, 0.8, 0.7, 0.5, 0.25, 0.05):
        store_score = math.exp(-(1.0 - cosine))
        assert cosine_similarity_from_store_score(store_score) == pytest.approx(cosine, abs=1e-9)


def test_conversion_is_total_and_never_raises() -> None:
    """``normalize``'s except-branch substitutes a poison chunk rather than dropping one.

    A chunk whose ``content`` is ``str(raw_result)`` and whose ``file_name`` is
    ``"unknown"`` still occupies a top-k slot and can be cited, so the conversion must
    not be able to raise in the first place.
    """
    for bad in (None, float("nan"), float("inf"), float("-inf"), -1.0, 0.0, "", "abc", object()):
        value = cosine_similarity_from_store_score(bad)
        assert isinstance(value, float)
        assert 0.0 <= value <= 1.0


def test_conversion_is_monotone_so_every_ordering_consumer_is_unaffected() -> None:
    scores = [math.exp(-d) for d in (0.05, 0.2, 0.4, 0.6, 0.8, 0.95)]
    converted = [cosine_similarity_from_store_score(s) for s in scores]
    assert converted == sorted(converted, reverse=True)


# ===========================================================================
# Chunk identity across the two retrieval channels
# ===========================================================================


def _raw_query(chunk_id: str, text: str = "Fluchtwege sind so auszubilden…") -> dict:
    return {
        "ids": [[chunk_id]],
        "documents": [[text]],
        "metadatas": [[{"file_name": "oib-rl_2.pdf", "page_label": "13", "content_type": "text"}]],
        "distances": [[0.4]],
    }


def test_lexical_channel_preserves_the_stored_chunk_id() -> None:
    """Fusion keys on ``chunk_id``; a fabricated id makes cross-channel matching impossible."""
    retriever = LlamaIndexRetriever(config={"persist_dir": "/tmp/unused"})
    chunks = retriever._chunks_from_raw_query(_raw_query("stored-id-42"))
    assert [c.chunk_id for c in chunks] == ["stored-id-42"]


def test_lexical_chunk_id_is_stable_across_calls() -> None:
    """The old code returned a new uuid4 every call, so even the same query never agreed."""
    retriever = LlamaIndexRetriever(config={"persist_dir": "/tmp/unused"})
    first = retriever._chunks_from_raw_query(_raw_query("stored-id-42"))
    second = retriever._chunks_from_raw_query(_raw_query("stored-id-42"))
    assert first[0].chunk_id == second[0].chunk_id == "stored-id-42"


def test_lexical_and_vector_channels_agree_on_identity_so_rrf_can_fuse() -> None:
    """The end-to-end property the id fix exists for: one passage, one identity."""
    from sources.knowledge_layer.src.llamaindex.hybrid import reciprocal_rank_fusion

    retriever = LlamaIndexRetriever(config={"persist_dir": "/tmp/unused"})
    lexical = retriever._chunks_from_raw_query(_raw_query("shared-id"))
    vector = [SimpleNamespace(chunk_id="shared-id"), SimpleNamespace(chunk_id="other-id")]

    fused = reciprocal_rank_fusion([vector, lexical])
    ids = [c.chunk_id for c in fused]
    assert ids.count("shared-id") == 1, "the same passage must not appear twice"
    assert ids[0] == "shared-id", "a chunk found by both channels must outrank a single-channel one"


# ===========================================================================
# Filter grammar parity between the channels
# ===========================================================================


def test_multi_key_filter_is_translated_rather_than_passed_raw() -> None:
    """Chroma requires exactly one operator per expression; siblings are an implicit AND.

    The base collection always carries the ``exclude_file_names`` clause, so a caller
    filter with two keys used to make the lexical pass raise and silently disable
    hybrid retrieval for exactly the filtered queries.
    """
    where = _to_chroma_where({"content_type": "text", "doc_class": "gesetz"})
    assert "$and" in where
    assert len(where["$and"]) == 2


def test_single_element_group_is_collapsed_to_a_bare_expression() -> None:
    """Chroma rejects an ``$and``/``$or`` with fewer than two operands."""
    where = _to_chroma_where({"$and": [{"content_type": "text"}]})
    assert "$and" not in where
    assert where == {"content_type": {"$eq": "text"}}


def test_empty_filter_translates_to_none() -> None:
    assert _to_chroma_where(None) is None
    assert _to_chroma_where({}) is None


# ===========================================================================
# Embed-metadata exclusions
# ===========================================================================


def test_noise_metadata_is_excluded_from_the_embedded_text() -> None:
    from llama_index.core import Document
    from llama_index.core.schema import MetadataMode

    doc = Document(
        text="Die nutzbare Breite von Fluchtwegen muss mindestens 1,20 m betragen.",
        metadata={
            "file_name": "oib-rl_2.pdf",
            "file_size": 1975942,
            "page_label": "13",
            "content_type": "text",
            "doc_class": "oib_richtlinie",
        },
    )
    _apply_metadata_exclusions(doc)

    embedded = doc.get_content(metadata_mode=MetadataMode.EMBED)
    assert "1975942" not in embedded, "a byte count carries no retrieval signal"
    assert "oib-rl_2.pdf" in embedded, "the filename is what users actually query by"
    assert "oib_richtlinie" in embedded
    # The metadata still exists for filtering and citation — only its embedding changed.
    assert doc.metadata["file_size"] == 1975942


def test_exclusions_extend_rather_than_replace_existing_ones() -> None:
    """SimpleDirectoryReader sets its own exclusions on the non-PDF path."""
    doc = SimpleNamespace(
        excluded_embed_metadata_keys=["creation_date"],
        excluded_llm_metadata_keys=[],
        metadata={},
    )
    _apply_metadata_exclusions(doc)
    assert "creation_date" in doc.excluded_embed_metadata_keys
    assert "file_size" in doc.excluded_embed_metadata_keys


def test_the_ingest_temp_path_is_never_embedded() -> None:
    """``file_path`` is the reader's temp file, so it differs on every re-upload."""
    assert "file_path" in EMBED_EXCLUDED_METADATA_KEYS


def test_exclusions_are_idempotent() -> None:
    doc = SimpleNamespace(excluded_embed_metadata_keys=[], excluded_llm_metadata_keys=[], metadata={})
    _apply_metadata_exclusions(doc)
    _apply_metadata_exclusions(doc)
    assert len(doc.excluded_embed_metadata_keys) == len(set(doc.excluded_embed_metadata_keys))
