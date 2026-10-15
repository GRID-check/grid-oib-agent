"""``POST /v1/collections/similar`` end to end on a real Qdrant: the route, the retriever's embedder, the store.

What a person sees under „Im Büro behandelt“ is decided here: which
collections may be searched and read (the signed scope), that the source
document never comes back, that a superseded Fassung stays out, that passages
are grouped by document in ranking order, and that a stored passage costs no
embedding. Without ``AIQ_QDRANT_TEST_URL`` it skips locally and fails on CI.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import os
import random
import socket
import uuid

import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient

from aiq_agent.knowledge.factory import clear_active_retriever
from aiq_agent.knowledge.factory import set_active_retriever
from aiq_api.routes.similar_passages import add_similar_passages_routes

DIM = 8
#: The real resolver, taken before the conftest stubs every name to a private IP for the SSRF guard.
_GETADDRINFO = socket.getaddrinfo
SECRET = "s3cr3t"


def _unit(seed: str) -> list[float]:
    rng = random.Random(seed)
    vector = [rng.uniform(-1, 1) for _ in range(DIM)]
    norm = math.sqrt(sum(x * x for x in vector))
    return [x / norm for x in vector]


def _at(anchor: list[float], cosine: float, seed: str) -> list[float]:
    """A unit vector at exactly ``cosine`` to ``anchor``."""
    noise = _unit(seed)
    dot = sum(a * n for a, n in zip(anchor, noise, strict=True))
    orthogonal = [n - dot * a for a, n in zip(anchor, noise, strict=True)]
    norm = math.sqrt(sum(x * x for x in orthogonal))
    side = math.sqrt(1 - cosine * cosine)
    return [cosine * a + side * o / norm for a, o in zip(anchor, orthogonal, strict=True)]


#: The source passage's vector: every other passage is placed by its cosine to it.
SOURCE = _unit("Fluchttreppe Stiege 2")
#: What the embedder returns for a selection: far from SOURCE, so the two paths rank differently.
SELECTION = _at(SOURCE, 0.0, "selection")

SOURCE_TEXT = "Die Fluchttreppe der Stiege 2 wird als offene Außentreppe in Stahlbeton ausgeführt, Laufbreite 1,20 m."


class _Embedder:
    """The production embedder's stand-in: one fixed vector, every call counted."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    def __call__(self, text: str) -> list[float]:
        self.calls.append(text)
        return SELECTION


def _scope_headers(scope: list[str], secret: str | None = SECRET) -> dict[str, str]:
    """The signed ``X-Grid-Request-Context`` envelope the BFF forwards (``buildGridRequestContextWireHeaders``)."""
    payload = json.dumps({"collectionScope": scope})
    headers = {"x-grid-request-context": base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")}
    if secret:
        headers["x-grid-request-context-sig"] = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return headers


@pytest.fixture
def stack(monkeypatch):
    url = os.environ.get("AIQ_QDRANT_TEST_URL", "").strip()
    if not url:
        if os.environ.get("CI"):
            pytest.fail("AIQ_QDRANT_TEST_URL is unset on CI: the Qdrant service container is missing")
        pytest.skip("AIQ_QDRANT_TEST_URL not set")
    from knowledge_layer.llamaindex.adapter import LlamaIndexRetriever
    from knowledge_layer.qdrant import schema
    from knowledge_layer.qdrant import store as store_module

    suffix = uuid.uuid4().hex[:8]
    monkeypatch.setitem(schema.ALIASES, schema.Physical.CORPUS, f"similar_corpus_{suffix}")
    monkeypatch.setitem(schema.ALIASES, schema.Physical.OFFICE, f"similar_office_{suffix}")
    monkeypatch.setenv("AIQ_QDRANT_URL", url)
    monkeypatch.setenv("REQUIRE_AUTH", "true")
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", SECRET)
    monkeypatch.setattr(socket, "getaddrinfo", _GETADDRINFO)
    store_module.reset_store()
    retriever = LlamaIndexRetriever({"embed_model": "test-model", "embed_base_url": "https://test"})
    retriever._initialized = True
    embedder = _Embedder()
    monkeypatch.setattr(retriever, "_embed_query_cached", embedder)
    set_active_retriever(retriever)
    app = FastAPI()
    router = APIRouter()
    add_similar_passages_routes(router)
    app.include_router(router)
    store = store_module.get_store(retriever._identity())
    yield app, store, embedder
    clear_active_retriever()
    for physical in schema.Physical:
        name = schema.ALIASES[physical] + schema.FIRST_VERSION
        if store.client.collection_exists(name):
            store.client.delete_collection(name)
    store_module.reset_store()


def _put(store, scope: str, file_name: str, *passages: tuple[float, int], text: str = "", **metadata) -> list[str]:
    """Passages of one file, each at a cosine to SOURCE and on a page; returns their chunk ids."""
    from knowledge_layer.qdrant.payload import ChunkRecord

    ids = [str(uuid.uuid4()) for _ in passages]
    store.upsert(
        scope,
        [
            ChunkRecord(
                chunk_id,
                text or f"{file_name} Seite {page}",
                SOURCE if cosine == 1.0 else _at(SOURCE, cosine, f"{scope}/{file_name}/{page}"),
                {"file_name": file_name, "page_label": str(page), **metadata},
            )
            for chunk_id, (cosine, page) in zip(ids, passages, strict=True)
        ],
    )
    return ids


def _client(app) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _seed(store) -> dict[str, str]:
    """A project with the source document, another project, a restricted folder and the Büroablage."""
    source_ids = _put(store, "proj_a", "Brandschutzkonzept.pdf", (1.0, 4), (0.97, 5), text=SOURCE_TEXT)
    _put(store, "proj_a", "Baubeschreibung.pdf", (0.95, 2), (0.90, 7), (0.88, 9), (0.86, 11))
    _put(store, "proj_b", "Einreichplan-Erläuterung.pdf", (0.93, 3))
    _put(store, "proj_b_r0123456789ab", "Gutachten-vertraulich.pdf", (0.99, 1))
    _put(store, "archiv_org1", "Musterdetail-Treppe.pdf", (0.91, 1))
    _put(store, "proj_c", "Fremdprojekt.pdf", (0.98, 1))
    return {"source_chunk": source_ids[0]}


SEARCHED = ["proj_a", "proj_b", "archiv_org1"]


def _body(**source) -> dict:
    return {
        "source": {"collection": "proj_a", "file_name": "Brandschutzkonzept.pdf", **source},
        "collections": SEARCHED,
    }


async def test_a_stored_chunk_is_searched_with_its_own_vector_and_its_document_left_out(stack):
    app, store, embedder = stack
    ids = _seed(store)

    async with _client(app) as client:
        res = await client.post(
            "/v1/collections/similar", json=_body(chunk_id=ids["source_chunk"]), headers=_scope_headers(SEARCHED)
        )

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["origin"] == "point"
    assert embedder.calls == []
    documents = [(document["collection"], document["file_name"]) for document in body["documents"]]
    # Ranked by each document's best passage; the source file, the unsearched
    # project and the restricted folder nobody named are absent.
    assert documents == [
        ("proj_a", "Baubeschreibung.pdf"),
        ("proj_b", "Einreichplan-Erläuterung.pdf"),
        ("archiv_org1", "Musterdetail-Treppe.pdf"),
    ]
    first = body["documents"][0]["passages"]
    assert [passage["page_number"] for passage in first] == [2, 7, 9]
    assert first[0]["score"] == pytest.approx(0.95, abs=0.01)
    assert first[0]["score"] >= first[1]["score"] >= first[2]["score"]


async def test_a_cited_passage_is_found_in_its_file_by_its_text_and_costs_no_embedding(stack):
    app, store, embedder = stack
    _seed(store)
    cited = SOURCE_TEXT[:150] + " …"

    async with _client(app) as client:
        res = await client.post(
            "/v1/collections/similar",
            json=_body(text=cited, page=4, kind="cited"),
            headers=_scope_headers(SEARCHED),
        )

    assert res.status_code == 200, res.text
    assert res.json()["origin"] == "point"
    assert embedder.calls == []
    assert res.json()["documents"][0]["file_name"] == "Baubeschreibung.pdf"


async def test_a_selection_is_embedded_once_and_searched_by_that_vector(stack):
    app, store, embedder = stack
    _seed(store)
    _put(store, "proj_b", "Statik.pdf", (0.0, 1))  # orthogonal to SOURCE: SELECTION's nearest

    async with _client(app) as client:
        res = await client.post(
            "/v1/collections/similar",
            json=_body(text="offene Außentreppe in Stahlbeton", page=4, kind="selected"),
            headers=_scope_headers(SEARCHED),
        )

    assert res.status_code == 200, res.text
    assert res.json()["origin"] == "embedded"
    assert embedder.calls == ["offene Außentreppe in Stahlbeton"]
    assert all(document["file_name"] != "Brandschutzkonzept.pdf" for document in res.json()["documents"])


async def test_a_citation_whose_chunk_is_not_found_falls_back_to_the_embedding(stack):
    app, store, embedder = stack
    _seed(store)
    text = "Ein Satz, der in keinem gespeicherten Abschnitt dieses Dokuments steht, wörtlich."

    async with _client(app) as client:
        res = await client.post(
            "/v1/collections/similar", json=_body(text=text, page=4, kind="cited"), headers=_scope_headers(SEARCHED)
        )

    assert res.status_code == 200, res.text
    assert res.json()["origin"] == "embedded"
    assert embedder.calls == [text]


async def test_documents_and_passages_are_capped_in_ranking_order(stack):
    app, store, _ = stack
    ids = _seed(store)

    async with _client(app) as client:
        res = await client.post(
            "/v1/collections/similar",
            json={**_body(chunk_id=ids["source_chunk"]), "documents": 2, "passages_per_document": 2},
            headers=_scope_headers(SEARCHED),
        )

    documents = res.json()["documents"]
    assert [document["file_name"] for document in documents] == ["Baubeschreibung.pdf", "Einreichplan-Erläuterung.pdf"]
    assert [len(document["passages"]) for document in documents] == [2, 1]


async def test_a_superseded_fassung_and_another_copy_of_the_source_document_stay_out(stack):
    app, store, _ = stack
    ids = _seed(store)
    _put(store, "proj_a", "Brandschutzkonzept-alt.pdf", (0.99, 4), superseded=True)
    # The same BFF document under another stored name (a rename the mirror has not caught up with).
    _put(store, "proj_a", "Brandschutzkonzept (1).pdf", (0.99, 4), grid_document_id="doc-source")

    async with _client(app) as client:
        res = await client.post(
            "/v1/collections/similar",
            json=_body(chunk_id=ids["source_chunk"], document_id="doc-source"),
            headers=_scope_headers(SEARCHED),
        )

    names = [document["file_name"] for document in res.json()["documents"]]
    assert "Brandschutzkonzept-alt.pdf" not in names
    assert "Brandschutzkonzept (1).pdf" not in names
    assert names[0] == "Baubeschreibung.pdf"


async def test_a_corpus_passage_is_looked_up_in_the_corpus_and_searched_in_the_office(stack):
    app, store, embedder = stack
    _seed(store)
    corpus_ids = _put(store, "oib_knowledge", "OIB-RL-4.pdf", (1.0, 12))

    async with _client(app) as client:
        res = await client.post(
            "/v1/collections/similar",
            json={
                "source": {"collection": "oib_knowledge", "file_name": "OIB-RL-4.pdf", "chunk_id": corpus_ids[0]},
                "collections": SEARCHED,
            },
            headers=_scope_headers(["oib_knowledge", *SEARCHED]),
        )

    assert res.status_code == 200, res.text
    assert res.json()["origin"] == "point"
    assert embedder.calls == []
    # The source document is in another collection, so every office document may come back, the cited one included.
    assert res.json()["documents"][0]["file_name"] == "Brandschutzkonzept.pdf"


@pytest.mark.parametrize(
    ("scope", "collections", "refused"),
    [
        # A searched collection outside the signed scope: another project nobody signed.
        (SEARCHED, [*SEARCHED, "proj_c"], "proj_c"),
        # The source's collection outside it: its vector may not be read either.
        (["proj_b", "archiv_org1"], ["proj_b", "archiv_org1"], "proj_a"),
    ],
)
async def test_a_collection_outside_the_signed_scope_is_404_and_nothing_is_searched(stack, scope, collections, refused):
    app, store, embedder = stack
    ids = _seed(store)
    # A request that would succeed but for the scope: a real chunk and text to embed.
    body = {**_body(chunk_id=ids["source_chunk"], text=SOURCE_TEXT, kind="selected"), "collections": collections}
    async with _client(app) as client:
        res = await client.post("/v1/collections/similar", json=body, headers=_scope_headers(scope))
    assert res.status_code == 404
    assert refused in res.json()["detail"]
    assert embedder.calls == []


async def test_no_signed_scope_under_auth_is_403(stack):
    app, store, _ = stack
    _seed(store)
    async with _client(app) as client:
        unsigned = await client.post(
            "/v1/collections/similar", json=_body(text="x" * 40), headers=_scope_headers(SEARCHED, secret=None)
        )
        bare = await client.post("/v1/collections/similar", json=_body(text="x" * 40))
    assert unsigned.status_code == 403
    assert bare.status_code == 403


async def test_the_legal_corpus_is_no_collection_to_search_for_office_experience(stack):
    app, store, _ = stack
    _seed(store)
    async with _client(app) as client:
        res = await client.post(
            "/v1/collections/similar",
            json={**_body(text=SOURCE_TEXT, kind="cited"), "collections": ["proj_b", "oib_knowledge"]},
            headers=_scope_headers(["proj_a", "proj_b", "oib_knowledge"]),
        )
    assert res.status_code == 400


async def test_a_chunk_id_that_names_nothing_and_no_text_is_404(stack):
    app, store, _ = stack
    _seed(store)
    async with _client(app) as client:
        res = await client.post(
            "/v1/collections/similar", json=_body(chunk_id=str(uuid.uuid4())), headers=_scope_headers(SEARCHED)
        )
    assert res.status_code == 404


async def test_the_search_is_one_retriever_observation_carrying_no_passage_text(stack):
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    from aiq_agent.observability import direct_trace

    app, store, _ = stack
    ids = _seed(store)
    exporter = InMemorySpanExporter()
    direct_trace.reset_tracer_provider()
    direct_trace.install_tracer_provider(None, exporter=exporter)
    try:
        async with _client(app) as client:
            await client.post(
                "/v1/collections/similar",
                json=_body(chunk_id=ids["source_chunk"], text=SOURCE_TEXT, kind="cited"),
                headers=_scope_headers(SEARCHED),
            )
        direct_trace._provider.force_flush()
        spans = exporter.get_finished_spans()
    finally:
        direct_trace.reset_tracer_provider()

    assert [span.name for span in spans] == ["retrieve.similar_passages"]
    attributes = dict(spans[0].attributes)
    assert attributes["langfuse.observation.type"] == "retriever"
    assert attributes["langfuse.trace.name"] == "similar-passages"
    assert attributes["langfuse.trace.metadata.documents"] == 3
    output = json.loads(attributes["langfuse.observation.output"])
    assert [pick["file"] for pick in output["picked"]][:1] == ["Baubeschreibung.pdf"]
    serialized = json.dumps(attributes, ensure_ascii=False)
    assert "Fluchttreppe" not in serialized and "Seite" not in serialized
