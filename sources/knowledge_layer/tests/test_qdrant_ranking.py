"""``search.Ranking``: what each knob the parity sweep measures sends to Qdrant.

Offline: the requests are built, not run. The sweep
(``oib_retrieval_eval.qdrant_parity.variants``) swaps ``search.RANKING`` and
reads through production, so a knob that silently sent nothing would measure the
baseline under another name. What each setting does to the ranking is measured
by ``task be:eval:qdrant-parity -- --variants all`` (``qdrant-gates-2026-10.md``).
"""

from __future__ import annotations

import math
import os
import uuid

import pytest
from knowledge_layer.qdrant import schema
from knowledge_layer.qdrant import search
from knowledge_layer.qdrant.payload import ChunkRecord
from knowledge_layer.qdrant.schema import DENSE
from knowledge_layer.qdrant.schema import LEXICAL
from knowledge_layer.qdrant.scope import scope_filter
from knowledge_layer.qdrant.store import QdrantStore
from qdrant_client import models

VECTOR = [0.1, 0.2, 0.3]


def _channels(ranking: search.Ranking, exact_terms: tuple[str, ...] = ()) -> list[models.Prefetch]:
    return search._prefetches(["proj_a"], scope_filter(["proj_a"]), VECTOR, "fluchtweg", exact_terms, 60, ranking)


def test_production_runs_the_ranking_the_sweep_supports():
    """Plain RRF at k=60 over plain nearest queries, no weights and no rescoring, ties
    ordered by cosine: the one setting that cleared the adoption rule (``qdrant-gates-2026-10.md``)."""
    assert search.RANKING == search.Ranking()
    assert search.RANKING.cosine_tie_break
    fusion = search._fusion(search.RANKING, 3)
    assert isinstance(fusion, models.RrfQuery) and fusion.rrf.k == 60 and fusion.rrf.weights is None
    dense, lexical = _channels(search.RANKING)
    assert dense.using == DENSE and dense.query == VECTOR and dense.params is None
    assert lexical.using == LEXICAL and lexical.params.idf is not None
    assert search.RANKING.label() == "rrf60+cosine_ties"


def test_rescoring_and_oversampling_reach_every_dense_channel_and_only_those():
    ranking = search.Ranking(rescore=True, oversampling=2.0)
    dense, lexical, restricted = _channels(ranking, ("OIB-RL 2",))
    for channel in (dense, restricted):
        assert channel.params.quantization == models.QuantizationSearchParams(rescore=True, oversampling=2.0)
    assert lexical.params.quantization is None
    assert ranking.label() == "rrf60+rescore_os2+cosine_ties"


def test_the_dense_weight_goes_to_the_unrestricted_dense_channel_first():
    ranking = search.Ranking(dense_weight=2.0)
    assert search._fusion(ranking, 3).rrf.weights == [2.0, 1.0, 1.0]
    assert search._fusion(ranking, 1).rrf.weights is None, "one channel has nothing to weigh against"


def test_dbsf_and_mmr_are_sent_as_qdrant_spells_them():
    assert search._fusion(search.Ranking(fusion="dbsf"), 2) == models.FusionQuery(fusion=models.Fusion.DBSF)
    dense, _lexical, restricted = _channels(search.Ranking(mmr_diversity=0.4, mmr_candidates=120), ("OIB-RL 2",))
    assert dense.query == models.NearestQuery(nearest=VECTOR, mmr=models.Mmr(diversity=0.4, candidates_limit=120))
    assert restricted.query == VECTOR, "an exact-term channel keeps its plain dense order"


def _hit(chunk_id: str, fused: float, cosine: float) -> search.Hit:
    return search.Hit(chunk_id=chunk_id, text="", payload={}, fused=fused, cosine=cosine)


def test_tied_fused_scores_are_ordered_by_cosine_and_nothing_else_moves():
    """Equal-weight RRF ties exactly (dense rank 3 alone against BM25 rank 3 alone), and
    Qdrant returns a tie in no fixed order: 86 of 105 parity queries came back in a
    different top-60 order on four identical calls."""
    hits = [
        _hit("a", 1 / 61 + 1 / 62, 0.40),
        _hit("b", 1 / 63, 0.30),
        _hit("c", 1 / 63, 0.55),
        _hit("d", 1 / 63 + 1e-12, 0.20),  # float noise from summing in another order is a tie
        _hit("e", 1 / 70, 0.90),
    ]
    assert [hit.chunk_id for hit in search._cosine_ordered_ties(hits)] == ["a", "c", "b", "d", "e"]


def test_a_tie_straddling_the_cut_is_fetched_whole_before_it_is_cut():
    assert search._tie_slack(60) == 15 and search._tie_slack(3) == 4


# ---------------------------------------------------------------- against a real Qdrant (AIQ_QDRANT_TEST_URL)


@pytest.fixture
def store(monkeypatch):
    url = os.environ.get("AIQ_QDRANT_TEST_URL", "").strip()
    if not url:
        if os.environ.get("CI"):
            pytest.fail("AIQ_QDRANT_TEST_URL is unset on CI: the Qdrant service container is missing")
        pytest.skip("AIQ_QDRANT_TEST_URL not set; start a Qdrant 1.19 server to run these")
    from qdrant_client import QdrantClient

    client = QdrantClient(url=url, cloud_inference=True, timeout=30, check_compatibility=False)
    suffix = uuid.uuid4().hex[:8]
    monkeypatch.setitem(schema.ALIASES, schema.Physical.CORPUS, f"ranking_corpus_{suffix}")
    monkeypatch.setitem(schema.ALIASES, schema.Physical.OFFICE, f"ranking_office_{suffix}")
    yield QdrantStore(client, {"aiq:embed_fingerprint": "test-fp", "aiq:embed_model": "test-model"})
    for physical in schema.Physical:
        name = schema.ALIASES[physical] + schema.FIRST_VERSION
        if client.collection_exists(name):
            client.delete_collection(name)


def _at(cosine: float) -> list[float]:
    """A unit vector at ``cosine`` to the first axis."""
    return [cosine, math.sqrt(1 - cosine * cosine), 0, 0, 0, 0, 0, 0]


def test_a_three_way_rrf_tie_comes_back_in_cosine_order(store):
    """Each channel's single candidate is a different passage, so all three fuse to
    the same score: dense's (0.99), the exact-term channel's (0.80), BM25's (0.10)."""
    records = [
        ChunkRecord("dense-top", "Dachdeckung mit Ziegeln", _at(0.99), {"file_name": "a.pdf"}),
        ChunkRecord("exact-top", "Punkt 5.1.1 regelt die Dachdeckung", _at(0.80), {"file_name": "b.pdf"}),
        ChunkRecord("lexical-top", "Fluchtweg und nochmals Fluchtweg", _at(0.10), {"file_name": "c.pdf"}),
        ChunkRecord("filler", "Wandaufbau", _at(0.50), {"file_name": "d.pdf"}),
    ]
    store.upsert("proj_a", records)

    for _ in range(5):
        hits = search.hybrid_search(
            store,
            ["proj_a"],
            vector=_at(1.0),
            lexical_text="fluchtweg",
            exact_terms=["5.1.1"],
            limit=3,
            candidates=1,
        )
        assert len({round(hit.fused, 9) for hit in hits}) == 1, "the three are tied"
        assert [hit.chunk_id for hit in hits] == ["dense-top", "exact-top", "lexical-top"]


def test_a_tie_between_projects_puts_the_closer_projects_group_first(store):
    """Grouped search groups the fused order, so a tie decides which project leads."""
    records = {
        "proj_c": ChunkRecord("dense-top", "Dachdeckung mit Ziegeln", _at(0.99), {"file_name": "a.pdf"}),
        "proj_b": ChunkRecord("exact-top", "Punkt 5.1.1 regelt die Dachdeckung", _at(0.80), {"file_name": "b.pdf"}),
        "proj_a": ChunkRecord("lexical-top", "Fluchtweg und nochmals Fluchtweg", _at(0.10), {"file_name": "c.pdf"}),
    }
    for scope, record in records.items():
        store.upsert(scope, [record])

    for _ in range(5):
        groups = search.grouped_search(
            store,
            ["proj_a", "proj_b", "proj_c"],
            vector=_at(1.0),
            lexical_text="fluchtweg",
            exact_terms=["5.1.1"],
            group_by="scope",
            groups=3,
            group_size=1,
            candidates=1,
        )
        assert [scope for scope, _ in groups] == ["proj_c", "proj_b", "proj_a"]
