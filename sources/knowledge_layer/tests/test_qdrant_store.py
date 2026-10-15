"""The Qdrant store against a real Qdrant server (ADR-0113, ADR-0114).

What is under test is the server's behaviour as this package drives it: German
BM25, server-side fusion, strict mode, phrase matching, grouping. A mock would
only test the mock, so these run against ``AIQ_QDRANT_TEST_URL``: the CI
backend job starts ``qdrant/qdrant:v1.19.2`` as a service container. Locally,
without the variable, the module skips; on CI it fails instead, so the suite
cannot quietly stop running.
"""

from __future__ import annotations

import math
import os
import random
import uuid

import pytest
from knowledge_layer.qdrant import schema
from knowledge_layer.qdrant.payload import ChunkRecord
from knowledge_layer.qdrant.payload import build_payload
from knowledge_layer.qdrant.payload import point_id
from knowledge_layer.qdrant.scope import scope_filter
from knowledge_layer.qdrant.scope import translate
from knowledge_layer.qdrant.search import grouped_search
from knowledge_layer.qdrant.search import hybrid_search
from knowledge_layer.qdrant.search import phrase
from knowledge_layer.qdrant.store import QdrantStore

DIM = 8
IDENTITY = {"aiq:embed_fingerprint": "test-fp", "aiq:embed_model": "test-model"}


def _server_url() -> str:
    url = os.environ.get("AIQ_QDRANT_TEST_URL", "").strip()
    if url:
        return url
    if os.environ.get("CI"):
        pytest.fail("AIQ_QDRANT_TEST_URL is unset on CI: the Qdrant service container is missing")
    pytest.skip("AIQ_QDRANT_TEST_URL not set; start a Qdrant 1.19 server to run these")


@pytest.fixture
def store(monkeypatch):
    """A store on fresh, uniquely named collections, deleted afterwards."""
    from qdrant_client import QdrantClient

    client = QdrantClient(url=_server_url(), cloud_inference=True, timeout=30, check_compatibility=False)
    suffix = uuid.uuid4().hex[:8]
    monkeypatch.setitem(schema.ALIASES, schema.Physical.CORPUS, f"test_corpus_{suffix}")
    monkeypatch.setitem(schema.ALIASES, schema.Physical.OFFICE, f"test_office_{suffix}")
    yield QdrantStore(client, IDENTITY)
    for physical in schema.Physical:
        name = schema.ALIASES[physical] + schema.FIRST_VERSION
        if client.collection_exists(name):
            client.delete_collection(name)


def _vector(seed: str) -> list[float]:
    rng = random.Random(seed)
    return [rng.uniform(-1, 1) for _ in range(DIM)]


def _record(text: str, file_name: str, **metadata) -> ChunkRecord:
    return ChunkRecord(
        chunk_id=str(uuid.uuid4()),
        text=text,
        embedding=_vector(text),
        metadata={"file_name": file_name, "page_label": "1", **metadata},
    )


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    return dot / (math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b)))


# ---------------------------------------------------------------- pure units


def test_filter_translation_keeps_missing_keys_on_negations():
    flt = translate({"chunking": {"$ne": "page"}})
    assert flt.must_not and not flt.must


def test_filter_translation_coerces_types_to_the_index():
    flt = translate({"punkt_depth": {"$in": ["1", 2]}, "page_label": 3})
    conditions = [part.must[0] for part in flt.must]
    assert conditions[0].match.any == [1, 2]
    assert conditions[1].match.value == "3"


def test_filter_on_unindexed_field_raises():
    with pytest.raises(ValueError, match="not an indexed payload field"):
        translate({"drawing_data": "x"})


def test_unknown_operator_raises():
    with pytest.raises(ValueError):
        translate({"file_name": {"$regex": "x"}})


def test_scope_filter_requires_a_scope():
    with pytest.raises(ValueError):
        scope_filter([])
    with pytest.raises(ValueError):
        scope_filter(["proj_a", ""])


def test_payload_drops_llama_internals_and_keeps_the_text():
    record = ChunkRecord("abc", "Text", [0.1], {"_node_content": "{}", "doc_id": "x", "file_name": "a.pdf"})
    payload = build_payload("proj_a", record, {"office_id": "org_1", "tags": "brandschutz"})
    assert "_node_content" not in payload and "doc_id" not in payload
    assert payload["text"] == "Text" and payload["scope"] == "proj_a" and payload["chunk_id"] == "abc"
    assert payload["tags"] == ["brandschutz"]


def test_point_id_keeps_uuids_and_maps_others_stably():
    chunk_id = str(uuid.uuid4())
    assert point_id(chunk_id) == chunk_id
    assert point_id("not-a-uuid") == point_id("not-a-uuid") != "not-a-uuid"


# ---------------------------------------------------------------- server


def test_german_bm25_finds_inflected_forms(store):
    store.upsert("proj_a", [_record("Die Fluchtwege sind rauchfrei auszuführen.", "bk.pdf")])
    store.upsert("proj_a", [_record("Die Statik berücksichtigt den Holzbau.", "statik.pdf")])
    hits = hybrid_search(store, ["proj_a"], vector=_vector("unrelated"), lexical_text="Fluchtweg", limit=1)
    assert hits[0].payload["file_name"] == "bk.pdf"


def test_search_never_crosses_scopes(store):
    store.upsert("proj_a", [_record("Fluchtweg in Projekt A", "a.pdf")])
    store.upsert("proj_b", [_record("Fluchtweg in Projekt B", "b.pdf")])
    hits = hybrid_search(store, ["proj_a"], vector=_vector("Fluchtweg"), lexical_text="Fluchtweg", limit=10)
    assert {hit.payload["scope"] for hit in hits} == {"proj_a"}


def test_corpus_and_office_scopes_land_in_different_collections(store):
    store.upsert("oib_knowledge", [_record("OIB-Richtlinie 2", "rl2.pdf")])
    store.upsert("archiv_org1", [_record("Büroablage", "ablage.pdf")])
    corpus = store.client.count(schema.ALIASES[schema.Physical.CORPUS]).count
    office = store.client.count(schema.ALIASES[schema.Physical.OFFICE]).count
    assert (corpus, office) == (1, 1)


def test_exact_term_channel_lifts_the_chunk_with_the_phrase(store):
    store.upsert(
        "proj_a",
        [
            _record("Gemäß § 3 Abs. 2 sind Fluchtwege zu kennzeichnen.", "bescheid.pdf"),
            _record("Fluchtwege und Rettungswege im Allgemeinen.", "allgemein.pdf"),
        ],
    )
    assert store.count("proj_a", None, phrase("§ 3 Abs. 2")) == 1
    hits = hybrid_search(store, ["proj_a"], vector=_vector("x"), lexical_text="", exact_terms=["§ 3 Abs. 2"], limit=2)
    assert hits[0].payload["file_name"] == "bescheid.pdf"


@pytest.mark.parametrize(
    "asked, matching, neighbour",
    [
        ("REI 90", "Tragende Bauteile in REI 90.", "Tragende Bauteile in REI 60."),
        ("§ 3", "Gemäß § 3 der Statuten.", "Gemäß § 30 der Statuten."),
        ("5.1.1", "Punkt 5.1.1 regelt die Gehweglänge.", "Punkt 5.1.2 regelt die Gehweglänge."),
        ("Gebäudeklasse 5", "Für Gebäudeklasse 5 gilt.", "Für Gebäudeklasse 4 gilt."),
    ],
)
def test_phrase_matching_keeps_the_numbers_in_a_term(store, asked, matching, neighbour):
    """The exact-term channel's numbers are its signal (qdrant-gates-2026-10.md).

    The multilingual tokenizer dropped digit tokens: „REI 90“ matched REI 60 as
    well, and „§ 3“ or „5.1.1“, nothing left but punctuation, matched nothing.
    """
    store.upsert("proj_a", [_record(matching, "match.pdf"), _record(neighbour, "neighbour.pdf")])
    found, _ = store.client.scroll(
        schema.ALIASES[schema.Physical.OFFICE], scroll_filter=scope_filter(["proj_a"], None, phrase(asked))
    )
    assert [record.payload["file_name"] for record in found] == ["match.pdf"]


def test_hit_cosine_is_the_true_dense_similarity(store):
    record = _record("Brandabschnitt", "a.pdf")
    store.upsert("proj_a", [record])
    query = _vector("query")
    [hit] = hybrid_search(store, ["proj_a"], vector=query, lexical_text="", limit=1)
    assert hit.cosine == pytest.approx(_cosine(query, record.embedding), abs=1e-3)


def test_ne_keeps_points_without_the_field(store):
    store.upsert(
        "oib_knowledge",
        [
            _record("alt", "a.pdf"),
            _record("seite", "a.pdf", chunking="page"),
            _record("punkt", "a.pdf", chunking="punkt"),
        ],
    )
    assert store.count("oib_knowledge", {"chunking": {"$ne": "page"}}) == 2


def test_int_and_string_spellings_meet(store):
    store.upsert("oib_knowledge", [_record("Punkt", "rl.pdf", punkt_depth=1, page_label=4)])
    assert store.count("oib_knowledge", {"punkt_depth": {"$in": ["1"]}}) == 1
    assert store.count("oib_knowledge", {"page_label": {"$in": [4]}}) == 1


def test_deletes_address_scope_file_and_chunk(store):
    a1, a2 = _record("eins", "a.pdf"), _record("zwei", "a.pdf")
    store.upsert("proj_a", [a1, a2, _record("drei", "b.pdf")])
    store.upsert("proj_b", [_record("eins", "a.pdf")])
    store.delete_chunks("proj_a", [a1.chunk_id])
    assert store.count("proj_a") == 2
    store.delete_file("proj_a", "a.pdf")
    assert store.count("proj_a") == 1 and store.count("proj_b") == 1
    store.delete_scope("proj_a")
    assert store.count("proj_a") == 0 and store.count("proj_b") == 1


def test_set_file_payloads_mirror_a_persons_fact(store):
    store.upsert("proj_a", [_record("eins", "a.pdf"), _record("zwei", "b.pdf")])
    store.set_file_payloads("proj_a", {"a.pdf": {"superseded": True, "tags": ["bescheid"]}})
    assert store.count("proj_a", {"superseded": True}) == 1
    assert store.count("proj_a", {"tags": "bescheid"}) == 1


def test_grouped_search_ranks_projects_in_one_call(store):
    store.upsert("proj_a", [_record("Fluchttreppe Holzbau", "a1.pdf"), _record("Fluchttreppe Stahl", "a2.pdf")])
    store.upsert("proj_b", [_record("Fluchttreppe Sicherheitstreppenhaus", "b1.pdf")])
    store.upsert("proj_c", [_record("Fassade", "c1.pdf")])
    groups = grouped_search(
        store,
        ["proj_a", "proj_b", "proj_c"],
        vector=_vector("Fluchttreppe"),
        lexical_text="Fluchttreppe",
        group_by="scope",
        groups=3,
        group_size=2,
    )
    by_scope = dict(groups)
    assert set(by_scope) >= {"proj_a", "proj_b"}
    assert len(by_scope["proj_a"]) == 2


def test_file_names_facet_one_scope_only(store):
    store.upsert("proj_a", [_record("x", "a.pdf"), _record("y", "a.pdf"), _record("z", "b.pdf")])
    store.upsert("proj_b", [_record("w", "c.pdf")])
    assert sorted(store.file_names("proj_a")) == ["a.pdf", "b.pdf"]


def test_strict_mode_refuses_an_unindexed_filter_at_the_server(store):
    from qdrant_client import models

    store.upsert("proj_a", [_record("x", "a.pdf", description="Grundriss")])
    with pytest.raises(Exception, match="(?i)index"):
        store.client.count(
            store.alias("proj_a"),
            count_filter=models.Filter(
                must=[models.FieldCondition(key="description", match=models.MatchValue(value="Grundriss"))]
            ),
        )


def test_a_foreign_embedder_is_refused(store):
    store.upsert("proj_a", [_record("x", "a.pdf")])
    other = QdrantStore(store.client, {"aiq:embed_fingerprint": "other", "aiq:embed_model": "other-model"})
    with pytest.raises(RuntimeError, match="embedding mismatch"):
        other.check_identity("proj_a")
    with pytest.raises(RuntimeError, match="embedding mismatch"):
        other.upsert("proj_a", [_record("y", "a.pdf")])


def test_isolation_property_random_scope_sets(store):
    """No hit ever comes from a scope outside the requested set (ADR-0114 Confirmation)."""
    scopes = [f"proj_{name}" for name in "abcdef"] + ["archiv_org1", "s_conv1"]
    words = ["Fluchtweg", "Brandschutz", "Stiege", "Holzbau", "Auflage", "Bescheid"]
    rng = random.Random(7)
    for scope in scopes:
        store.upsert(
            scope, [_record(f"{rng.choice(words)} {rng.choice(words)} {scope}", f"{scope}.pdf") for _ in range(5)]
        )
    returned = 0
    for case in range(200):
        requested = rng.sample(scopes, rng.randint(1, len(scopes)))
        hits = hybrid_search(
            store, requested, vector=_vector(str(case)), lexical_text=rng.choice(words), limit=20, candidates=40
        )
        assert {hit.payload["scope"] for hit in hits} <= set(requested), case
        # Every requested scope holds 5 chunks and the dense channel admits
        # them all: an empty answer would make the property vacuous.
        assert len(hits) == min(20, 5 * len(requested)), case
        returned += len(hits)
    assert returned > 0


def test_no_scope_is_an_empty_answer_not_an_index_error(monkeypatch):
    """A caller with nothing to search gets nothing back, before any store call."""
    from knowledge_layer.qdrant import retrieval

    monkeypatch.setattr(retrieval, "get_store", lambda *a, **k: pytest.fail("store touched for no scope"))
    assert retrieval.search_grouped([], vector=[0.1], lexical_text="x", groups=3, group_size=2, identity={}) == []
    assert grouped_search(object(), [], vector=[0.1], lexical_text="x", group_by="scope", groups=3, group_size=2) == []
    assert hybrid_search(object(), [], vector=[0.1], lexical_text="x", limit=3) == []


# ---------------------------------------------------------------- the text index tokenizes digits


NUMBERED = [
    "Gemäß § 3 Abs. 2 sind Fluchtwege vorzusehen.",
    "Nach §3 gilt dies sinngemäß.",
    "Punkt 5.1.1 der OIB-Richtlinie 2 regelt Treppen.",
    "Die Brüstungshöhe beträgt 43 cm über der Größe der Straße.",
    "Abs. 3 und Seite 3 nennen keinen Paragraphen.",
    "OIB-Richtlinie 3 ist eine andere.",
    "Punkt 5.1.10 und § 13 Abs. 2 sind andere Stellen, 143 eine andere Zahl.",
]


def test_phrases_on_numbers_match_exactly_the_chunks_that_contain_them(store):
    """``multilingual`` dropped digits: "5.1.1" and "43" matched nothing and "Abs. 2" matched every "Abs."."""
    from knowledge_layer.qdrant.search import exact_term

    store.upsert("proj_a", [_record(text, f"{index}.pdf") for index, text in enumerate(NUMBERED)])

    def files(condition) -> set[str]:
        return {record.payload["file_name"] for record in store.scroll("proj_a", None, condition)}

    assert files(phrase("5.1.1")) == {"2.pdf"}
    assert files(phrase("43")) == {"3.pdf"}
    assert files(phrase("Abs. 2")) == {"0.pdf", "6.pdf"}
    assert files(phrase("OIB-Richtlinie 2")) == {"2.pdf"}
    # A § reference is matched on the chunk's own list of the ones it cites:
    # as a phrase it would be the bare token "3", which "Abs. 3" carries too.
    assert files(exact_term("§ 3")) == {"0.pdf", "1.pdf"}
    assert files(exact_term("§ 13")) == {"6.pdf"}
    assert files(exact_term("OIB-Richtlinie 2")) == {"2.pdf"}
    # Lowercasing and ASCII folding still hold: one token however it is spelled.
    for spelling in ("Größe", "GRÖSSE", "grosse", "Straße", "strasse", "brustungshohe"):
        assert files(phrase(spelling)) == {"3.pdf"}, spelling


def test_a_text_index_built_with_another_tokenizer_is_reported_loudly(store, caplog):
    from qdrant_client import models

    name = schema.ALIASES[schema.Physical.OFFICE] + schema.FIRST_VERSION
    store.client.create_collection(name, vectors_config={})
    store.client.create_payload_index(
        name,
        schema.TEXT_FIELD,
        field_schema=models.TextIndexParams(
            type=models.TextIndexType.TEXT,
            tokenizer=models.TokenizerType.MULTILINGUAL,
            lowercase=True,
            ascii_folding=True,
            phrase_matching=True,
        ),
        wait=True,
    )
    with caplog.at_level("ERROR", logger="knowledge_layer.qdrant.schema"):
        schema.ensure_payload_indexes(store.client, name)
    [record] = [r for r in caplog.records if "full-text index" in r.getMessage()]
    assert "multilingual" in record.getMessage() and "switch the alias" in record.getMessage()
    # The index is left as it is: a rebuild is a new collection, never a silent drop.
    assert store.client.get_collection(name).payload_schema[schema.TEXT_FIELD].params.tokenizer == "multilingual"

    caplog.clear()
    store.upsert("oib_knowledge", [_record("x", "a.pdf")])  # a fresh collection behind the other alias
    with caplog.at_level("ERROR", logger="knowledge_layer.qdrant.schema"):
        schema.ensure_payload_indexes(store.client, store.alias("oib_knowledge"))
    assert not caplog.records


# ---------------------------------------------------------------- creating the collection


def test_a_collection_left_without_its_alias_is_finished_not_wedged(store):
    """A writer died between create_collection and the alias; every later writer used to fail on the conflict."""
    from qdrant_client import models

    alias = schema.ALIASES[schema.Physical.OFFICE]
    store.client.create_collection(
        alias + schema.FIRST_VERSION,
        vectors_config={schema.DENSE: models.VectorParams(size=DIM, distance=models.Distance.COSINE)},
        sparse_vectors_config={schema.LEXICAL: models.SparseVectorParams(modifier=models.Modifier.IDF)},
        metadata=dict(IDENTITY),
    )

    assert store.upsert("proj_a", [_record("Fluchtweg", "a.pdf")]) == 1

    assert any(entry.alias_name == alias for entry in store.client.get_aliases().aliases)
    assert schema.INDEXED_FIELDS <= set(store.client.get_collection(alias).payload_schema)
    assert store.count("proj_a") == 1


def test_concurrent_creators_both_succeed(store, monkeypatch):
    """The loser of the create race finishes the collection instead of raising while the alias is not there yet."""
    import threading
    import time

    real = schema.ensure_payload_indexes
    created = threading.Event()

    def slow_first(client, collection):
        if not created.is_set():
            created.set()
            time.sleep(1.5)  # the winner is between its create and its alias
        return real(client, collection)

    monkeypatch.setattr(schema, "ensure_payload_indexes", slow_first)
    errors: list[BaseException] = []

    def create(wait: bool) -> None:
        if wait:
            created.wait(10)
        try:
            schema.ensure_collection(store.client, schema.Physical.OFFICE, DIM, IDENTITY)
        except BaseException as error:  # noqa: BLE001 - collected for the assertion
            errors.append(error)

    threads = [threading.Thread(target=create, args=(wait,)) for wait in (False, True)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(30)
    assert errors == []
    alias = schema.ALIASES[schema.Physical.OFFICE]
    aliased = [entry.collection_name for entry in store.client.get_aliases().aliases if entry.alias_name == alias]
    assert aliased == [alias + schema.FIRST_VERSION]


def test_writes_are_acknowledged_by_one_replica(store, monkeypatch):
    """At RF 2 a write consistency of 2 failed every write to a shard whose second peer was down."""
    monkeypatch.setenv("AIQ_QDRANT_REPLICATION_FACTOR", "2")
    store.upsert("proj_a", [_record("x", "a.pdf")])
    assert store.client.get_collection(store.alias("proj_a")).config.params.replication_factor == 2
    assert store.client.get_collection(store.alias("proj_a")).config.params.write_consistency_factor == 1


# ---------------------------------------------------------------- transient failures are retried, refusals are not


def _flaky(store, monkeypatch, errors: list[BaseException]):
    from knowledge_layer.qdrant import store as store_module

    pauses: list[float] = []
    monkeypatch.setattr(store_module, "_sleep", pauses.append)
    real = store.client.upsert
    calls = {"n": 0}

    def upsert(*args, **kwargs):
        calls["n"] += 1
        if errors:
            raise errors.pop(0)
        return real(*args, **kwargs)

    monkeypatch.setattr(store.client, "upsert", upsert)
    return calls, pauses


def test_a_transient_write_failure_is_retried_with_backoff(store, monkeypatch):
    import httpx
    from qdrant_client.http.exceptions import ResponseHandlingException
    from qdrant_client.http.exceptions import UnexpectedResponse

    store.upsert("proj_a", [_record("warm", "a.pdf")])  # the collection exists
    unavailable = UnexpectedResponse(503, "Service Unavailable", b"", httpx.Headers())
    calls, pauses = _flaky(store, monkeypatch, [ResponseHandlingException(httpx.ConnectError("refused")), unavailable])

    assert store.upsert("proj_a", [_record("x", "b.pdf")]) == 1

    assert calls["n"] == 3 and pauses == [0.2, 0.8]
    assert store.count("proj_a", {"file_name": "b.pdf"}) == 1


def test_a_refusal_is_never_retried_and_an_outage_gives_up(store, monkeypatch):
    import httpx
    from qdrant_client.http.exceptions import ResponseHandlingException
    from qdrant_client.http.exceptions import UnexpectedResponse

    store.upsert("proj_a", [_record("warm", "a.pdf")])
    real = store.client.upsert
    calls, pauses = _flaky(store, monkeypatch, [UnexpectedResponse(400, "Bad Request", b"{}", httpx.Headers())])
    with pytest.raises(UnexpectedResponse):
        store.upsert("proj_a", [_record("x", "b.pdf")])
    assert calls["n"] == 1 and pauses == []

    monkeypatch.setattr(store.client, "upsert", real)
    down = [ResponseHandlingException(httpx.ReadTimeout("slow")) for _ in range(9)]
    calls, pauses = _flaky(store, monkeypatch, down)
    with pytest.raises(ResponseHandlingException):
        store.upsert("proj_a", [_record("y", "c.pdf")])
    assert calls["n"] == 4 and pauses == [0.2, 0.8, 2.0]


# ---------------------------------------------------------------- filters a model may name


def test_the_metadata_keys_the_chunkers_write_are_filterable(store):
    """``knowledge_search`` passes a model's raw ``filters``; under Chroma every one of these applied."""
    store.upsert(
        "oib_knowledge",
        [
            _record(
                "Punkt",
                "rl2.pdf",
                punkt_path="5 Treppen > 5.1 Allgemein",
                punkt_parent_id="5",
                page_end="7",
                section_part=2,
                table_part=1,
                table_index=3,
            ),
            _record("Bild", "plan.pdf", image_index=0, drawing_type="Grundriss", drawing_data='{"big": 1}'),
        ],
    )
    for filters in (
        {"punkt_path": "5 Treppen > 5.1 Allgemein"},
        {"punkt_parent_id": "5"},
        {"page_end": 7},
        {"section_part": "2"},
        {"table_part": 1},
        {"table_index": {"$in": [3, 4]}},
        {"image_index": 0},
        {"drawing_type": {"$eq": "Grundriss"}},
    ):
        assert store.count("oib_knowledge", filters) == 1, filters
    with pytest.raises(ValueError, match="'drawing_data'.*not an indexed payload field"):
        store.count("oib_knowledge", {"drawing_data": "x"})


def test_a_string_boolean_is_read_for_what_it_says():
    from knowledge_layer.qdrant.payload import coerce_field

    assert coerce_field("superseded", "false") is False
    assert coerce_field("superseded", "False") is False
    assert coerce_field("superseded", "0") is False
    assert coerce_field("superseded", "true") is True
    assert coerce_field("superseded", 1) is True
    assert coerce_field("superseded", "vielleicht") is None


def test_a_list_value_is_any_of_on_every_field_type(store):
    """``project_facts.*`` are keyword fields holding lists; a list equality was one string and matched nothing."""
    from knowledge_layer.qdrant.payload import project_payload

    store.upsert(
        "proj_a",
        [_record("x", "a.pdf", section_order=2)],
        project_payload({"nutzungen": ["wohnen", "buero"], "gebaeudeklasse": [4]}, "active"),
    )
    assert store.count("proj_a", {"project_facts.nutzungen": ["buero", "handel"]}) == 1
    assert store.count("proj_a", {"project_facts.nutzungen": ["handel"]}) == 0
    assert store.count("proj_a", {"project_facts.gebaeudeklasse": [3, "4"]}) == 1
    assert store.count("proj_a", {"section_order": ["2"]}) == 1
    assert store.count("proj_a", {"file_name": ["a.pdf"]}) == 1
