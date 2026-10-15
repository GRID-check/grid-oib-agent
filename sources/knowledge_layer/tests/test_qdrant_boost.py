"""Project facts on points, fact and tag pre-filters, and likeness in the one grouped query (design §7, items 3-4).

Against a real Qdrant server, like ``test_qdrant_store.py``: what is under test
is how the server ranks, filters and shards, which a mock cannot tell. Without
``AIQ_QDRANT_TEST_URL`` the server tests skip locally and fail on CI.
"""

from __future__ import annotations

import math
import os
import random
import uuid

import pytest
from knowledge_layer.qdrant import schema
from knowledge_layer.qdrant.boost import LIKENESS
from knowledge_layer.qdrant.boost import Boost
from knowledge_layer.qdrant.boost import FactWeights
from knowledge_layer.qdrant.boost import boost_terms
from knowledge_layer.qdrant.boost import boosted
from knowledge_layer.qdrant.boost import likeness_formula
from knowledge_layer.qdrant.boost import parse_boost
from knowledge_layer.qdrant.payload import ChunkRecord
from knowledge_layer.qdrant.payload import chunk_metadata
from knowledge_layer.qdrant.payload import project_payload
from knowledge_layer.qdrant.search import RRF_K
from knowledge_layer.qdrant.search import grouped_search
from knowledge_layer.qdrant.store import QdrantStore
from qdrant_client import models

DIM = 8
IDENTITY = {"aiq:embed_fingerprint": "test-fp", "aiq:embed_model": "test-model"}

#: The BFF's SIMILARITY_WEIGHTS (frontends/ui/src/lib/cross-project/similarity.ts), as the request carries them.
WEIGHTS = {
    "bundesland": 4,
    "gebaeudeklasse": 3,
    "gebaeudeklasse_adjacent": 1,
    "bauweise": 2,
    "nutzung": 1,
    "nutzung_max": 2,
    "vorhabensart": 1,
}

CURRENT = {
    "bundesland": "niederoesterreich",
    "gebaeudeklasse": [4],
    "bauweise": ["holzbau"],
    "nutzungen": ["wohnen", "buero"],
    "vorhabensart": ["neubau"],
}


def _server_url() -> str:
    url = os.environ.get("AIQ_QDRANT_TEST_URL", "").strip()
    if url:
        return url
    if os.environ.get("CI"):
        pytest.fail("AIQ_QDRANT_TEST_URL is unset on CI: the Qdrant service container is missing")
    pytest.skip("AIQ_QDRANT_TEST_URL not set; start a Qdrant 1.19 server to run these")


class Stores:
    """Fresh, uniquely named collections per store, all deleted afterwards."""

    def __init__(self, monkeypatch):
        from qdrant_client import QdrantClient

        self.client = QdrantClient(url=_server_url(), cloud_inference=True, timeout=60, check_compatibility=False)
        self.monkeypatch = monkeypatch
        self.created: list[str] = []

    def make(self, shards: int = 1) -> QdrantStore:
        suffix = uuid.uuid4().hex[:8]
        self.monkeypatch.setenv("AIQ_QDRANT_SHARD_NUMBER", str(shards))
        for physical in schema.Physical:
            alias = f"test_{physical.value}_{suffix}"
            self.monkeypatch.setitem(schema.ALIASES, physical, alias)
            self.created.append(alias + schema.FIRST_VERSION)
        return QdrantStore(self.client, IDENTITY)

    def close(self) -> None:
        for name in self.created:
            if self.client.collection_exists(name):
                self.client.delete_collection(name)


@pytest.fixture
def stores(monkeypatch):
    holder = Stores(monkeypatch)
    yield holder
    holder.close()


@pytest.fixture
def store(stores):
    return stores.make()


def _unit(seed: str) -> list[float]:
    rng = random.Random(seed)
    vector = [rng.uniform(-1, 1) for _ in range(DIM)]
    norm = math.sqrt(sum(x * x for x in vector))
    return [x / norm for x in vector]


def _near(base: list[float], distance: float, seed: str) -> list[float]:
    """A vector whose cosine to ``base`` falls as ``distance`` grows."""
    noise = _unit(seed)
    return [b + distance * n for b, n in zip(base, noise, strict=True)]


def _record(file_name: str, embedding: list[float], tags: list[str] | None = None, text: str = "") -> ChunkRecord:
    metadata = {"file_name": file_name, "page_label": "1"}
    if tags is not None:
        metadata["tags"] = tags
    return ChunkRecord(chunk_id=str(uuid.uuid4()), text=text, embedding=embedding, metadata=metadata)


def _project(store: QdrantStore, scope: str, facts: dict | None, *records: ChunkRecord, status: str = "closed") -> None:
    enrichment = project_payload(facts, status) if facts is not None else None
    store.upsert(scope, list(records), enrichment)


def _order(groups) -> list[str]:
    return [scope for scope, _ in groups]


# ---------------------------------------------------------------- pure units


def test_terms_mirror_similarity_term_by_term():
    boost = parse_boost({"facts": CURRENT, "weights": WEIGHTS})
    weights = [weight for weight, _ in boost_terms(boost)]
    # Land, same GK, neighbouring GK, Bauweise, >=1 use, >=2 uses, Vorhabensart.
    assert weights == [4, 3, 1, 2, 1, 1, 1]
    assert boost.weights.most == 12


def test_use_steps_cap_at_nutzung_max():
    boost = parse_boost({"facts": {"nutzungen": ["a", "b", "c", "d"]}, "weights": {"nutzung": 1, "nutzung_max": 2.5}})
    assert [weight for weight, _ in boost_terms(boost)] == [1, 1, 0.5]


def test_no_facts_or_no_weights_leaves_the_channel_as_it_is():
    dense = models.Prefetch(query=[0.0] * DIM, using=schema.DENSE, limit=10)
    for boost in (None, {"facts": {}, "weights": WEIGHTS}, {"facts": CURRENT, "weights": {}}):
        formula = likeness_formula(parse_boost(boost))
        assert formula is None
        assert boosted(dense, formula) is dense


def test_a_full_match_scales_by_one_plus_likeness():
    boost = Boost(facts=project_payload(CURRENT, "active")["project_facts"], weights=FactWeights.from_mapping(WEIGHTS))
    formula = likeness_formula(boost)
    [score, factor] = formula.formula.mult
    assert score == "$score"
    one, *terms = factor.sum
    scales = [term.mult[0] for term in terms]
    assert one == 1.0
    # Every term but the neighbouring class (an alternative to the same class) holds for a project sharing everything.
    assert sum(scales) - scales[2] == pytest.approx(LIKENESS)


def test_negative_weight_is_refused():
    with pytest.raises(ValueError):
        parse_boost({"facts": CURRENT, "weights": {"bundesland": -1}})


def test_project_payload_is_typed_and_whole():
    payload = project_payload(
        {"bundesland": ["wien"], "gebaeudeklasse": ["4", 2, None], "bauweise": "holzbau", "farbe": ["rot"]}, "paused"
    )
    assert payload == {
        "project_facts": {
            "bundesland": "wien",
            "gebaeudeklasse": [2, 4],
            "bauweise": ["holzbau"],
            "nutzungen": [],
            "vorhabensart": [],
        },
        "project_status": "paused",
    }
    with pytest.raises(ValueError):
        project_payload({}, "archived")


def test_hit_metadata_leaves_the_project_mirror_out():
    assert chunk_metadata({"file_name": "a.pdf", **project_payload(CURRENT, "closed")}) == {"file_name": "a.pdf"}


# ---------------------------------------------------------------- server: the facts mirror


def test_set_scope_payload_mirrors_facts_onto_every_point_of_one_scope(store):
    _project(store, "proj_a", None, _record("a1.pdf", _unit("a1")), _record("a2.pdf", _unit("a2")))
    _project(store, "proj_a_r0123456789ab", None, _record("geheim.pdf", _unit("r1")))
    _project(store, "proj_b", None, _record("b1.pdf", _unit("b1")))

    assert store.set_scope_payload("proj_a", project_payload(CURRENT, "active"))
    assert store.count("proj_a", {"project_facts.bauweise": "holzbau"}) == 2
    assert store.count("proj_a", {"project_facts.gebaeudeklasse": {"$in": ["4"]}}) == 2
    assert store.count("proj_a", {"project_status": "active"}) == 2
    # The restricted folder's scope and another project are separate calls.
    assert store.count("proj_a_r0123456789ab", {"project_status": "active"}) == 0
    assert store.count("proj_b", {"project_status": "active"}) == 0

    # A removed fact disappears: the object is replaced whole, not merged.
    store.set_scope_payload("proj_a", project_payload({"bundesland": "wien"}, "closed"))
    assert store.count("proj_a", {"project_facts.bauweise": "holzbau"}) == 0
    assert store.count("proj_a", {"project_facts.bundesland": "wien", "project_status": "closed"}) == 2


def test_set_scope_payload_retries_a_transient_failure(store, monkeypatch):
    """The facts route's one write: a peer restarting mid-rollout must not turn a profile save into a 502."""
    import httpx
    from knowledge_layer.qdrant import store as store_module
    from qdrant_client.http.exceptions import UnexpectedResponse

    _project(store, "proj_a", None, _record("a1.pdf", _unit("a1")))
    pauses: list[float] = []
    monkeypatch.setattr(store_module, "_sleep", pauses.append)
    real = store.client.set_payload
    errors = [UnexpectedResponse(503, "Service Unavailable", b"", httpx.Headers())]

    def set_payload(*args, **kwargs):
        if errors:
            raise errors.pop(0)
        return real(*args, **kwargs)

    monkeypatch.setattr(store.client, "set_payload", set_payload)

    assert store.set_scope_payload("proj_a", project_payload(CURRENT, "active"))
    assert pauses == [0.2]
    assert store.count("proj_a", {"project_status": "active"}) == 1


def test_set_scope_payload_before_the_collection_exists_is_false(store):
    assert store.set_scope_payload("proj_new", project_payload(CURRENT, "active")) is False


def test_missing_indexes_are_added_to_an_existing_collection(store):
    _project(store, "proj_a", CURRENT, _record("a.pdf", _unit("a")))
    alias = store.alias("proj_a")
    # A collection created before the project facts were indexed.
    store.client.delete_payload_index(alias, "project_facts.bauweise", wait=True)
    with pytest.raises(Exception, match="(?i)index"):
        store.client.count(
            alias,
            count_filter=models.Filter(
                must=[models.FieldCondition(key="project_facts.bauweise", match=models.MatchValue(value="holzbau"))]
            ),
        )
    assert schema.ensure_payload_indexes(store.client, alias) == ["project_facts.bauweise"]
    assert schema.ensure_payload_indexes(store.client, alias) == []
    assert store.count("proj_a", {"project_facts.bauweise": "holzbau"}) == 1


# ---------------------------------------------------------------- server: filters


def test_fact_and_tag_filters_narrow_inside_the_one_query(store):
    query = _unit("q")
    _project(
        store,
        "proj_holz",
        {"bauweise": ["holzbau"]},
        _record("dach.pdf", _near(query, 0.1, "h1"), tags=["detail", "brandschutz"]),
        _record("bescheid.pdf", _near(query, 0.1, "h2"), tags=["bescheid"]),
    )
    _project(
        store,
        "proj_beton",
        {"bauweise": ["stahlbeton"]},
        _record("dach.pdf", _near(query, 0.05, "b1"), tags=["detail"]),
    )

    def search(filters):
        return grouped_search(
            store,
            ["proj_holz", "proj_beton"],
            vector=query,
            lexical_text="",
            group_by="scope",
            groups=5,
            group_size=5,
            filters=filters,
        )

    assert set(_order(search(None))) == {"proj_holz", "proj_beton"}
    assert _order(search({"project_facts.bauweise": {"$in": ["holzbau"]}})) == ["proj_holz"]
    # Document type AND discipline, each any-of: the tags filter the BFF sends.
    narrowed = search({"$and": [{"tags": {"$in": ["detail"]}}, {"tags": {"$in": ["brandschutz"]}}]})
    assert [(scope, [hit.payload["file_name"] for hit in hits]) for scope, hits in narrowed] == [
        ("proj_holz", ["dach.pdf"])
    ]


# ---------------------------------------------------------------- server: likeness


def _at(query: list[float], cosine: float, seed: str) -> list[float]:
    """A unit vector at exactly ``cosine`` to the unit vector ``query``."""
    noise = _unit(seed)
    dot = sum(q * n for q, n in zip(query, noise, strict=True))
    orthogonal = [n - dot * q for q, n in zip(query, noise, strict=True)]
    norm = math.sqrt(sum(x * x for x in orthogonal))
    side = math.sqrt(1 - cosine * cosine)
    return [cosine * q + side * o / norm for q, o in zip(query, orthogonal, strict=True)]


def _grouped(store, query, boost, scopes):
    return grouped_search(
        store,
        list(scopes),
        vector=query,
        lexical_text="",
        group_by="scope",
        groups=len(scopes),
        group_size=1,
        boost=parse_boost(boost),
    )


def _served_scores(store: QdrantStore, query: list[float], scopes) -> dict[str, float]:
    """Each scope's best dense score AS THE SERVER RANKS IT.

    The collection is TurboQuant-quantized and the search does not rescore,
    so a served score is the true cosine give or take a few hundredths at
    this dimension. An expected order is computed from what the server
    serves, so quantization cannot make a test about likeness flaky.
    """
    result = store.client.query_points(
        store.alias(scopes[0]),
        query=query,
        using=schema.DENSE,
        query_filter=models.Filter(must=[models.FieldCondition(key="scope", match=models.MatchAny(any=list(scopes)))]),
        limit=100,
        with_payload=True,
    )
    best: dict[str, float] = {}
    for point in result.points:
        best.setdefault(point.payload["scope"], point.score)
    return best


#: What each test project shares with CURRENT, as a share of the 12 the weights can reach.
SHARE = {"proj_a": 0, "proj_b": 4 / 12, "proj_c": 9 / 12}


def _three_projects(store: QdrantStore, query: list[float]) -> None:
    # Close in relevance; they differ in what they share with CURRENT (SHARE).
    _project(store, "proj_a", {"bundesland": "tirol"}, _record("a.pdf", _at(query, 0.800, "a")))
    _project(store, "proj_b", {"bundesland": "niederoesterreich"}, _record("b.pdf", _at(query, 0.790, "b")))
    _project(
        store,
        "proj_c",
        {"bundesland": "niederoesterreich", "gebaeudeklasse": [4], "bauweise": ["holzbau"]},
        _record("c.pdf", _at(query, 0.785, "c")),
    )


def test_likeness_reorders_by_score_times_shared_facts(store):
    query = _unit("q")
    _three_projects(store, query)
    scopes = ["proj_a", "proj_b", "proj_c"]
    served = _served_scores(store, query, scopes)
    plain = sorted(scopes, key=lambda scope: -served[scope])
    expected = sorted(scopes, key=lambda scope: -served[scope] * (1 + LIKENESS * SHARE[scope]))
    assert plain != expected, "the fixture must be close enough for likeness to matter"
    assert _order(_grouped(store, query, None, scopes)) == plain
    assert _order(_grouped(store, query, {"facts": CURRENT, "weights": WEIGHTS}, scopes)) == expected


def test_likeness_is_a_nudge_not_a_filter(store):
    query = _unit("q")
    _project(store, "proj_a", {"bundesland": "tirol"}, _record("a.pdf", _at(query, 0.95, "a")))
    _project(store, "proj_c", CURRENT, _record("c.pdf", _at(query, 0.50, "c")))
    scopes = ["proj_a", "proj_c"]
    # Sharing every fact is worth 5 % of a score: a far better passage keeps its place, and nothing is dropped.
    assert _order(_grouped(store, query, {"facts": CURRENT, "weights": WEIGHTS}, scopes)) == scopes


def test_a_full_match_gains_exactly_likeness(store):
    query = _unit("q")
    _project(store, "proj_c", CURRENT, _record("c.pdf", _at(query, 0.6, "c")))
    _project(store, "proj_a", {"bundesland": "tirol"}, _record("a.pdf", _at(query, 0.6, "a")))
    served = _served_scores(store, query, ["proj_c", "proj_a"])
    formula = likeness_formula(parse_boost({"facts": CURRENT, "weights": WEIGHTS}))
    dense = models.Prefetch(query=query, using=schema.DENSE, limit=10)
    result = store.client.query_points(
        store.alias("proj_c"), prefetch=[dense], query=formula, limit=2, with_payload=True
    )
    scores = {point.payload["scope"]: point.score for point in result.points}
    assert scores["proj_c"] == pytest.approx(served["proj_c"] * (1 + LIKENESS), rel=1e-4)
    assert scores["proj_a"] == pytest.approx(served["proj_a"], rel=1e-4)


# ---------------------------------------------------------------- server: grouping


def _many_projects(store: QdrantStore, count: int = 12, per: int = 8) -> list[str]:
    scopes = []
    for index in range(count):
        scope = f"proj_{index:02d}"
        records = [
            ChunkRecord(
                str(uuid.uuid5(uuid.NAMESPACE_URL, f"{scope}/{n}")), "", _unit(f"{scope}/{n}"), {"file_name": "x"}
            )
            for n in range(per)
        ]
        store.upsert(scope, records)
        scopes.append(scope)
    return scopes


def test_qdrants_group_query_restarts_the_fusion_per_round(store):
    """Why ``grouped_search`` groups a flat fused ranking itself.

    If an upgrade makes this fail, Qdrant's group query fuses once and could
    serve the grouping again.
    """
    scopes = _many_projects(store)
    dense = models.Prefetch(query=_unit("question"), using=schema.DENSE, limit=60)
    result = store.client.query_points_groups(
        store.alias(scopes[0]),
        group_by="scope",
        prefetch=[dense],
        query=models.RrfQuery(rrf=models.Rrf(k=RRF_K)),
        limit=8,
        group_size=1,
    )
    best = [group.hits[0].score for group in result.groups]
    # More than one group's best passage holds the first rank of "its" fusion.
    assert sum(score == pytest.approx(1 / RRF_K) for score in best) > 1


def test_grouped_search_keeps_the_flat_fused_order(store):
    scopes = _many_projects(store)
    query = _unit("question")
    groups = grouped_search(
        store, scopes, vector=query, lexical_text="", group_by="scope", groups=8, group_size=2, candidates=60
    )
    fused = [hit.fused for _, hits in groups for hit in hits[:1]]
    assert fused == sorted(fused, reverse=True)
    assert len(set(fused)) == len(fused)
    assert all(len(hits) <= 2 for _, hits in groups) and len(groups) == 8


# ---------------------------------------------------------------- server: shards

PROJECTS = 20
FACT_CHOICES = {
    "bundesland": ["niederoesterreich", "wien", "tirol"],
    "gebaeudeklasse": [[3], [4], [5]],
    "bauweise": [["holzbau"], ["stahlbeton"]],
    "nutzungen": [["wohnen"], ["buero"], ["wohnen", "buero"]],
    "vorhabensart": [["neubau"], ["zubau"]],
}


def _office(store: QdrantStore) -> list[str]:
    """Twenty projects of 30 chunks each, with deterministic ids, vectors and facts."""
    rng = random.Random(11)
    scopes = []
    for index in range(PROJECTS):
        scope = f"proj_{index:02d}"
        facts = {key: rng.choice(choices) for key, choices in FACT_CHOICES.items()}
        records = [
            ChunkRecord(
                chunk_id=str(uuid.uuid5(uuid.NAMESPACE_URL, f"{scope}/{n}")),
                text="",
                embedding=_unit(f"{scope}/{n}"),
                metadata={"file_name": f"{scope}_{n}.pdf"},
            )
            for n in range(30)
        ]
        _project(store, scope, facts, *records)
        scopes.append(scope)
    return scopes


def _boosted_order(store: QdrantStore, scopes: list[str], query: list[float]) -> list[str]:
    groups = grouped_search(
        store,
        scopes,
        vector=query,
        lexical_text="",
        group_by="scope",
        groups=10,
        group_size=2,
        boost=parse_boost({"facts": CURRENT, "weights": WEIGHTS}),
        candidates=120,
    )
    return [hit.chunk_id for _, hits in groups for hit in hits]


def test_the_boosted_ranking_is_the_same_on_six_shards_as_on_one(stores):
    """Why the likeness rescores each channel before the fusion, not the fusion after it (``boost.py``)."""
    query = _unit("question")
    one = stores.make(shards=1)
    scopes = _office(one)
    expected = _boosted_order(one, scopes, query)
    six = stores.make(shards=6)
    _office(six)
    assert _boosted_order(six, scopes, query) == expected


def test_a_formula_over_a_nested_fusion_ranks_per_shard(stores):
    """The shape ``boost.py`` avoids: on six shards it is not the global fusion.

    If a Qdrant upgrade makes this fail, nested fusion became global and the
    simpler ``$score + weights`` formula over it is an option again.
    """
    query = _unit("question")
    six = stores.make(shards=6)
    scopes = _office(six)
    channels = [models.Prefetch(query=query, using=schema.DENSE, limit=120)]
    words = models.Document(text="Holzbau Fluchtweg", model=schema.BM25_MODEL, options=dict(schema.BM25_OPTIONS))
    channels.append(models.Prefetch(query=words, using=schema.LEXICAL, limit=120))
    flt = models.Filter(must=[models.FieldCondition(key="scope", match=models.MatchAny(any=scopes))])
    for channel in channels:
        channel.filter = flt
    rrf = models.RrfQuery(rrf=models.Rrf(k=RRF_K))
    alias = six.alias(scopes[0])
    top = six.client.query_points(alias, prefetch=channels, query=rrf, limit=30)
    nested = six.client.query_points(
        alias,
        prefetch=[models.Prefetch(prefetch=channels, query=rrf, limit=120)],
        query=models.FormulaQuery(formula=models.SumExpression(sum=["$score"])),
        limit=30,
    )
    assert [point.id for point in nested.points] != [point.id for point in top.points]
