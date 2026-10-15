"""Regression tests for the retrieval score scale, chunk identity, and embed metadata.

Each test here pins a defect that the suite passed straight through before, because
none of the three seams had any coverage at all:

- the lexical channel fabricated a fresh ``uuid4`` for every chunk
  (``TextNode(node_id=...)`` is a read-only property, silently dropped by pydantic),
  so reciprocal rank fusion could never match a chunk across channels;
- ``normalize`` reported the old store's ``exp(-distance)`` as if it were a cosine
  similarity, putting an *orthogonal* chunk at 0.37 and making the one threshold in
  the codebase a no-op;
- no document set ``excluded_embed_metadata_keys``, so LlamaIndex prepended the whole
  metadata dict -- ``file_size`` included -- to every chunk before embedding.

All offline: no store, no embeddings, no network.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from knowledge_layer.qdrant.schema import identity_mismatch
from knowledge_layer.qdrant.search import Hit

from sources.knowledge_layer.src.llamaindex.adapter import EMBED_EXCLUDED_METADATA_KEYS
from sources.knowledge_layer.src.llamaindex.adapter import LlamaIndexRetriever
from sources.knowledge_layer.src.llamaindex.adapter import _apply_metadata_exclusions
from sources.knowledge_layer.src.llamaindex.adapter import embed_fingerprint
from sources.knowledge_layer.src.llamaindex.adapter import embed_fingerprint_metadata
from sources.knowledge_layer.src.llamaindex.adapter import unit_score

# ===========================================================================
# Score scale
# ===========================================================================


def _hit(chunk_id: str, cosine: float, text: str = "Fluchtwege sind so auszubilden…") -> Hit:
    payload = {"file_name": "oib-rl_2.pdf", "page_label": "13", "content_type": "text", "chunk_id": chunk_id}
    return Hit(chunk_id, text, payload, 0.0, cosine)


def _retriever() -> LlamaIndexRetriever:
    return LlamaIndexRetriever(config={"embed_model": "m", "embed_base_url": "https://host"})


def test_a_hits_score_is_its_true_cosine() -> None:
    """An orthogonal chunk scores 0, not the 0.37 ``exp(-1)`` the old store reported."""
    retriever = _retriever()
    assert retriever._chunk_from_hit(_hit("a", 0.0)).score == pytest.approx(0.0, abs=1e-9)
    assert retriever._chunk_from_hit(_hit("a", 0.73)).score == pytest.approx(0.73, abs=1e-9)
    assert retriever._chunk_from_hit(_hit("a", -0.4)).score == 0.0  # contradictory, floored


def test_the_score_is_total_and_never_raises() -> None:
    """``normalize``'s except-branch substitutes a poison chunk rather than dropping one.

    A chunk whose ``content`` is ``str(raw_result)`` and whose ``file_name`` is
    ``"unknown"`` still occupies a top-k slot and can be cited, so the score must
    not be able to raise in the first place.
    """
    for bad in (None, float("nan"), float("inf"), float("-inf"), -1.0, 0.0, 2.0, "", "abc", object()):
        value = unit_score(bad)
        assert isinstance(value, float)
        assert 0.0 <= value <= 1.0


def test_the_score_is_monotone_so_every_ordering_consumer_is_unaffected() -> None:
    cosines = [0.95, 0.8, 0.6, 0.4, 0.2, 0.05]
    assert [unit_score(c) for c in cosines] == cosines


# ===========================================================================
# Chunk identity
# ===========================================================================


def test_a_hit_keeps_the_stored_chunk_id() -> None:
    """Fusion and citations key on ``chunk_id``; a fabricated id breaks both."""
    retriever = _retriever()
    first = retriever._chunk_from_hit(_hit("stored-id-42", 0.6))
    second = retriever._chunk_from_hit(_hit("stored-id-42", 0.6))
    assert first.chunk_id == second.chunk_id == "stored-id-42"


def test_two_rankings_agree_on_identity_so_rrf_can_fuse() -> None:
    """The end-to-end property the id fix exists for: one passage, one identity."""
    from sources.knowledge_layer.src.llamaindex.hybrid import reciprocal_rank_fusion

    lexical = [_retriever()._chunk_from_hit(_hit("shared-id", 0.6))]
    vector = [SimpleNamespace(chunk_id="shared-id"), SimpleNamespace(chunk_id="other-id")]

    fused = reciprocal_rank_fusion([vector, lexical])
    ids = [c.chunk_id for c in fused]
    assert ids.count("shared-id") == 1, "the same passage must not appear twice"
    assert ids[0] == "shared-id", "a chunk found by both channels must outrank a single-channel one"


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


# ===========================================================================
# Cross-encoder configuration must never take retrieval down
# ===========================================================================


def test_a_malformed_reranker_env_var_does_not_break_the_import() -> None:
    """Module-scope ``float(os.environ[...])`` made a typo an unimportable module."""
    import importlib
    import os

    from sources.knowledge_layer.src import cross_encoder

    os.environ["AIQ_RERANKER_TIMEOUT_SECONDS"] = "abc"
    os.environ["AIQ_RERANKER_MAX_DOC_CHARS"] = "lots"
    try:
        reloaded = importlib.reload(cross_encoder)
        assert reloaded.DEFAULT_TIMEOUT_SECONDS == 3.0
        assert reloaded.DEFAULT_MAX_DOC_CHARS == 4000
    finally:
        del os.environ["AIQ_RERANKER_TIMEOUT_SECONDS"]
        del os.environ["AIQ_RERANKER_MAX_DOC_CHARS"]
        importlib.reload(cross_encoder)


def test_resolving_a_nonsense_provider_returns_none_rather_than_raising() -> None:
    """A YAML ``provider: 0`` arrives as an int, not a string."""
    from sources.knowledge_layer.src.cross_encoder import resolve_cross_encoder

    for hostile in (0, ["openrouter"], object(), "definitely-not-a-provider", "", "none"):
        assert resolve_cross_encoder(hostile) is None


# ===========================================================================
# Embedding-model fingerprint
#
# Swapping AIQ_EMBED_MODEL between two models of the SAME dimension, or
# repointing AIQ_EMBED_BASE_URL, produces no error anywhere: stored and query
# vectors come from different spaces and retrieval is quietly wrong at a score
# distribution that looks entirely normal.
# ===========================================================================


def test_a_matching_fingerprint_passes_and_a_different_model_is_reported() -> None:
    stamped = embed_fingerprint_metadata("model-a", "https://host/v1")
    assert identity_mismatch(stamped, embed_fingerprint_metadata("model-a", "https://host/v1")) is None

    mismatch = identity_mismatch(stamped, embed_fingerprint_metadata("model-b", "https://host/v1"))
    assert mismatch and "model-b" in mismatch and "model-a" in mismatch


def test_the_same_model_on_a_different_host_is_a_different_vector_space() -> None:
    """This deployment's code default and its compose default disagree on both."""
    stamped = embed_fingerprint_metadata("text-embedding-3-large", "https://openrouter.ai/api/v1")
    other = embed_fingerprint_metadata("text-embedding-3-large", "https://embeddings.example.com/v1")
    assert identity_mismatch(stamped, other)


def test_a_trailing_slash_is_not_a_different_deployment() -> None:
    assert embed_fingerprint("m", "https://host/v1/") == embed_fingerprint("m", "https://host/v1")
