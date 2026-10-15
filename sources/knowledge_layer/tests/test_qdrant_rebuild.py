"""Rebuilding a collection as a new ``_vN`` and switching its alias, against a real Qdrant (ADR-0113).

The copy must carry every point with both vectors and its payload into a
collection of another shard count, the searches must keep working through the
alias after the switch, and switching back must be the whole rollback. Runs
against ``AIQ_QDRANT_TEST_URL`` like ``test_qdrant_store.py``; skips locally
without it and fails on CI without it.
"""

from __future__ import annotations

import importlib.util
import os
import pathlib
import random
import uuid

import pytest
from knowledge_layer.qdrant import rebuild
from knowledge_layer.qdrant import schema
from knowledge_layer.qdrant.payload import ChunkRecord
from knowledge_layer.qdrant.search import hybrid_search
from knowledge_layer.qdrant.store import QdrantStore

SCRIPT = pathlib.Path(__file__).resolve().parents[3] / "scripts" / "qdrant_rebuild.py"
DIM = 8
IDENTITY = {"aiq:embed_fingerprint": "fp-rebuild", "aiq:embed_model": "model-rebuild"}


def _server_url() -> str:
    url = os.environ.get("AIQ_QDRANT_TEST_URL", "").strip()
    if url:
        return url
    if os.environ.get("CI"):
        pytest.fail("AIQ_QDRANT_TEST_URL is unset on CI: the Qdrant service container is missing")
    pytest.skip("AIQ_QDRANT_TEST_URL not set; start a Qdrant 1.19 server to run these")


@pytest.fixture
def store(monkeypatch):
    from qdrant_client import QdrantClient

    client = QdrantClient(url=_server_url(), cloud_inference=True, timeout=30, check_compatibility=False)
    suffix = uuid.uuid4().hex[:8]
    alias = f"rebuild_office_{suffix}"
    monkeypatch.setitem(schema.ALIASES, schema.Physical.OFFICE, alias)
    monkeypatch.setitem(schema.ALIASES, schema.Physical.CORPUS, f"rebuild_corpus_{suffix}")
    monkeypatch.setenv("AIQ_QDRANT_URL", _server_url())
    yield QdrantStore(client, IDENTITY)
    for name in (alias + schema.FIRST_VERSION, alias + "_v2"):
        if client.collection_exists(name):
            client.delete_collection(name)


def _records(count: int) -> list[ChunkRecord]:
    rng = random.Random(11)
    return [
        ChunkRecord(
            chunk_id=str(uuid.uuid4()),
            text=f"Fluchtweg Treppenhaus Abschnitt {index}",
            embedding=[rng.uniform(-1, 1) for _ in range(DIM)],
            metadata={"file_name": f"f{index % 3}.pdf", "page_label": str(index)},
        )
        for index in range(count)
    ]


def _load_script():
    spec = importlib.util.spec_from_file_location("qdrant_rebuild", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_copy_carries_every_point_into_another_shard_count(store):
    records = _records(40)
    store.upsert("proj_rebuild", records)
    alias = schema.ALIASES[schema.Physical.OFFICE]
    target = alias + "_v2"

    report = rebuild.copy_collection(store.client, schema.Physical.OFFICE, target, shards=3, page_size=7)

    assert report.complete and report.copied == 40 and report.target_count == 40
    assert store.client.get_collection(target).config.params.shard_number == 3
    # Same indexes and strict mode as the live collection, so the same filters pass.
    assert set(store.client.get_collection(target).payload_schema) == set(schema.INDEXED_FIELDS)
    copied = store.client.retrieve(target, [records[5].chunk_id], with_vectors=True, with_payload=True)[0]
    assert copied.payload["text"] == records[5].text
    assert set(copied.vector) == {schema.DENSE, schema.LEXICAL}
    # The alias has not moved yet.
    assert rebuild.current_collection(store.client, schema.Physical.OFFICE) == alias + schema.FIRST_VERSION


def test_switch_serves_the_new_collection_and_switching_back_is_the_rollback(store):
    records = _records(12)
    # One word only the target holds: every other text is the same three words,
    # a BM25 tie whose order follows the shard layout, so a shared term let a
    # dense runner-up win the fusion on the 2-shard copy.
    records[0].text = "Sprinkleranlage Treppenhaus Abschnitt 0"
    store.upsert("proj_rebuild", records)
    alias = schema.ALIASES[schema.Physical.OFFICE]
    rebuild.copy_collection(store.client, schema.Physical.OFFICE, alias + "_v2", shards=2)

    previous = rebuild.switch_alias(store.client, schema.Physical.OFFICE, alias + "_v2")
    hits = hybrid_search(store, ["proj_rebuild"], vector=records[0].embedding, lexical_text="Sprinkleranlage", limit=3)

    assert previous == alias + schema.FIRST_VERSION
    assert rebuild.current_collection(store.client, schema.Physical.OFFICE) == alias + "_v2"
    assert hits and hits[0].chunk_id == records[0].chunk_id
    rebuild.switch_alias(store.client, schema.Physical.OFFICE, previous)
    assert rebuild.current_collection(store.client, schema.Physical.OFFICE) == previous


def test_copy_keeps_the_live_shape_by_default_and_refuses_existing_targets(store, monkeypatch):
    monkeypatch.setenv("AIQ_QDRANT_SHARD_NUMBER", "3")
    store.upsert("proj_rebuild", _records(3))
    alias = schema.ALIASES[schema.Physical.OFFICE]
    with pytest.raises(ValueError):
        rebuild.copy_collection(store.client, schema.Physical.OFFICE, alias + schema.FIRST_VERSION)
    # The process running a rebuild need not carry the backend's settings: the
    # environment says 1 shard here, the live collection has 3, the copy gets 3.
    monkeypatch.delenv("AIQ_QDRANT_SHARD_NUMBER")
    rebuild.copy_collection(store.client, schema.Physical.OFFICE, alias + "_v2")
    assert store.client.get_collection(alias + "_v2").config.params.shard_number == 3
    with pytest.raises(RuntimeError, match="already exists"):
        rebuild.copy_collection(store.client, schema.Physical.OFFICE, alias + "_v2")


def test_copy_retries_a_transient_failure_instead_of_leaving_a_half_copy(store, monkeypatch):
    """A refused target is dropped by a person, so one 503 mid-copy must not end the rebuild."""
    import httpx
    from knowledge_layer.qdrant import store as store_module
    from qdrant_client.http.exceptions import UnexpectedResponse

    store.upsert("proj_rebuild", _records(20))
    alias = schema.ALIASES[schema.Physical.OFFICE]
    pauses: list[float] = []
    monkeypatch.setattr(store_module, "_sleep", pauses.append)
    real = store.client.upsert
    calls = {"n": 0}

    def upsert(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 2:
            raise UnexpectedResponse(503, "Service Unavailable", b"", httpx.Headers())
        return real(*args, **kwargs)

    monkeypatch.setattr(store.client, "upsert", upsert)

    report = rebuild.copy_collection(store.client, schema.Physical.OFFICE, alias + "_v2", page_size=7)

    assert report.complete and report.copied == 20
    assert pauses == [0.2]


def test_cli_copies_then_switches_and_exits_two_when_unreachable(store, monkeypatch):
    store.upsert("proj_rebuild", _records(5))
    alias = schema.ALIASES[schema.Physical.OFFICE]
    script = _load_script()

    assert script.main(["office", "--copy-to", alias + "_v2", "--shards", "2"]) == 0
    assert script.main(["office", "--copy-to", alias + "_v2"]) == 1
    assert script.main(["office", "--switch-to", alias + "_v2"]) == 0
    assert rebuild.current_collection(store.client, schema.Physical.OFFICE) == alias + "_v2"

    monkeypatch.setenv("AIQ_QDRANT_URL", "http://127.0.0.1:9")
    assert script.main(["office", "--switch-to", alias + schema.FIRST_VERSION]) == 2
