"""The importer of ``piloti-vectors/1`` exports into Qdrant: the format checks, then a real Qdrant and the CLI.

The import must carry every chunk's id, text, metadata and vector without
re-embedding, be safe to repeat and to resume, leave what ingestion wrote,
merge the person-set facts, refuse vectors from another embedder, and repair
drift both ways (``--prune``). Fixtures are written here by hand, to the
format's spec in ``deploy/migration/README.md``, not by the importer's own
helpers; ``deploy/migration/tests`` runs the real exporter into the same importer.
"""

from __future__ import annotations

import base64
import datetime
import gzip
import hashlib
import importlib.util
import json
import os
import pathlib
import random
import struct
import uuid

import pytest
from knowledge_layer.qdrant import import_vectors
from knowledge_layer.qdrant import schema
from knowledge_layer.qdrant import store as store_module
from knowledge_layer.qdrant.import_vectors import Export
from knowledge_layer.qdrant.import_vectors import InvalidExport
from knowledge_layer.qdrant.payload import ChunkRecord

SCRIPT = pathlib.Path(__file__).resolve().parents[3] / "scripts" / "import_vectors.py"
DIM = 8
IDENTITY = {"aiq:embed_fingerprint": "fp-test", "aiq:embed_model": "model-test"}
OTHER = {"aiq:embed_fingerprint": "fp-other", "aiq:embed_model": "model-other"}


def _load_script():
    spec = importlib.util.spec_from_file_location("import_vectors_cli", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _vector(seed: str) -> list[float]:
    rng = random.Random(seed)
    return [rng.uniform(-1, 1) for _ in range(DIM)]


def _f32(values: list[float]) -> list[float]:
    """``values`` as float32 holds them: what the export carries."""
    return list(struct.unpack(f"<{len(values)}f", struct.pack(f"<{len(values)}f", *values)))


class ExportWriter:
    """Writes an export to the spec: little-endian float32 in base64, gzipped JSON lines, the digest of the ids."""

    def __init__(self, root: pathlib.Path, batch: int = 4):
        self.root = root
        self.batch = batch
        self.collections: dict[str, dict] = {}

    def add(self, name: str, records: list[dict], metadata: dict | None = None) -> None:
        directory = self.root / "collections" / name
        directory.mkdir(parents=True, exist_ok=True)
        files = 0
        for start in range(0, len(records), self.batch):
            lines = []
            for record in records[start : start + self.batch]:
                raw = struct.pack(f"<{len(record['embedding'])}f", *record["embedding"])
                line = {**record, "embedding": base64.b64encode(raw).decode("ascii")}
                lines.append(json.dumps(line) + "\n")
            with gzip.open(directory / f"{files:06d}.jsonl.gz", "wt", encoding="utf-8") as handle:
                handle.write("".join(lines))
            files += 1
        digest = sum(int.from_bytes(hashlib.sha256(r["id"].encode()).digest(), "big") for r in records) % (1 << 256)
        self.collections[name] = {
            "count": len(records),
            "dimension": DIM,
            "batches": files,
            "metadata": {"hnsw:space": "cosine", **(IDENTITY if metadata is None else metadata)},
            "id_digest": f"sha256-sum:{digest:064x}",
        }

    def finish(self, created_at: str = "2026-10-13T08:00:00+00:00") -> pathlib.Path:
        manifest = {
            "format": "piloti-vectors/1",
            "chroma_version": "1.5.9",
            "created_at": created_at,
            "collections": self.collections,
        }
        (self.root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        return self.root


def _records(count: int, files: tuple[str, ...] = ("b.pdf", "a.pdf")) -> list[dict]:
    texts = [f"Fluchtweg Abschnitt {index}" for index in range(count)]
    return [
        {
            "id": str(uuid.uuid4()),
            "embedding": _vector(text),
            "document": text,
            "metadata": {"file_name": files[index % len(files)], "page_label": str(index)},
        }
        for index, text in enumerate(texts)
    ]


def _export(
    tmp_path: pathlib.Path, collections: dict[str, list[dict]], created_at: str | None = None, **metadata
) -> pathlib.Path:
    writer = ExportWriter(tmp_path / f"export-{uuid.uuid4().hex[:6]}")
    for name, records in collections.items():
        writer.add(name, records, metadata.get(name))
    return writer.finish(created_at) if created_at else writer.finish()


def _now() -> str:
    """A manifest's ``created_at`` for an export taken now: after everything the test wrote before."""
    return datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds")


# ---------------------------------------------------------------------- the format, no Qdrant


def test_records_decode_to_the_exported_vectors_text_and_metadata(tmp_path):
    records = _records(9)
    export = Export.open(_export(tmp_path, {"proj_alpha": records}))
    read = [record for batch in export.batches("proj_alpha") for record in batch]
    assert [record.chunk_id for record in read] == [record["id"] for record in records]
    assert read[3].text == "Fluchtweg Abschnitt 3"
    assert read[3].metadata == {"file_name": "a.pdf", "page_label": "3"}
    assert read[3].embedding == _f32(records[3]["embedding"])
    assert export.collections["proj_alpha"].identity(None) == IDENTITY


def test_an_export_without_a_manifest_is_refused(tmp_path):
    root = _export(tmp_path, {"proj_alpha": _records(3)})
    (root / "manifest.json").unlink()
    with pytest.raises(InvalidExport, match="did not finish"):
        Export.open(root)


def test_another_format_is_refused(tmp_path):
    root = _export(tmp_path, {"proj_alpha": _records(3)})
    manifest = json.loads((root / "manifest.json").read_text())
    (root / "manifest.json").write_text(json.dumps({**manifest, "format": "piloti-vectors/2"}))
    with pytest.raises(InvalidExport, match="piloti-vectors/2"):
        Export.open(root)


def test_a_missing_batch_file_is_refused_at_open(tmp_path):
    root = _export(tmp_path, {"proj_alpha": _records(9)})
    (root / "collections" / "proj_alpha" / "000001.jsonl.gz").unlink()
    with pytest.raises(InvalidExport, match="000001"):
        Export.open(root)


def test_a_name_that_would_leave_the_export_is_refused(tmp_path):
    root = _export(tmp_path, {"proj_alpha": _records(3)})
    manifest = json.loads((root / "manifest.json").read_text())
    manifest["collections"]["../../etc"] = manifest["collections"]["proj_alpha"]
    (root / "manifest.json").write_text(json.dumps(manifest))
    with pytest.raises(InvalidExport, match="not a collection name"):
        Export.open(root)


def test_a_batch_whose_ids_do_not_match_the_digest_fails_after_reading(tmp_path):
    """A batch rewritten with one record dropped and another in its place: the count agrees, the digest does not."""
    records = _records(4)
    root = _export(tmp_path, {"proj_alpha": records})
    swapped = ExportWriter(tmp_path / "swapped", batch=4)
    swapped.add("proj_alpha", [*records[:3], _records(1)[0]])
    (root / "collections" / "proj_alpha" / "000000.jsonl.gz").write_bytes(
        (tmp_path / "swapped" / "collections" / "proj_alpha" / "000000.jsonl.gz").read_bytes()
    )
    export = Export.open(root)
    with pytest.raises(InvalidExport, match="id_digest"):
        export.id_set("proj_alpha")


def test_an_embedding_of_the_wrong_size_is_refused(tmp_path):
    root = _export(tmp_path, {"proj_alpha": _records(2)})
    manifest = json.loads((root / "manifest.json").read_text())
    manifest["collections"]["proj_alpha"]["dimension"] = DIM + 1
    (root / "manifest.json").write_text(json.dumps(manifest))
    with pytest.raises(InvalidExport, match="float32"):
        Export.open(root).id_set("proj_alpha")


def test_an_invalid_export_exits_two_before_qdrant_is_asked(tmp_path, monkeypatch):
    monkeypatch.setenv("AIQ_QDRANT_URL", "http://127.0.0.1:9")
    assert _load_script().main(["--in", str(tmp_path / "nothing-here")]) == 2


def test_a_collection_the_export_lacks_exits_two(tmp_path, monkeypatch):
    monkeypatch.setenv("AIQ_QDRANT_URL", "http://127.0.0.1:9")
    root = _export(tmp_path, {"proj_alpha": _records(2)})
    assert _load_script().main(["--in", str(root), "--collection", "proj_beta"]) == 2


def test_the_digest_does_not_depend_on_order():
    ids = [str(uuid.uuid4()) for _ in range(5)]
    assert import_vectors.id_digest(ids) == import_vectors.id_digest(reversed(ids))
    assert import_vectors.id_digest(ids) != import_vectors.id_digest(ids[:4])


# ---------------------------------------------------------------------- against a real Qdrant


@pytest.fixture
def qdrant(monkeypatch):
    url = os.environ.get("AIQ_QDRANT_TEST_URL", "").strip()
    if not url:
        if os.environ.get("CI"):
            pytest.fail("AIQ_QDRANT_TEST_URL is unset on CI: the Qdrant service container is missing")
        pytest.skip("AIQ_QDRANT_TEST_URL not set")
    suffix = uuid.uuid4().hex[:8]
    monkeypatch.setitem(schema.ALIASES, schema.Physical.CORPUS, f"import_corpus_{suffix}")
    monkeypatch.setitem(schema.ALIASES, schema.Physical.OFFICE, f"import_office_{suffix}")
    monkeypatch.setenv("AIQ_QDRANT_URL", url)
    monkeypatch.setattr(import_vectors, "facts_by_file", lambda scope: {"a.pdf": {"tags": ["bescheid"]}})
    client = store_module.make_client()
    yield
    for physical in schema.Physical:
        name = schema.ALIASES[physical] + schema.FIRST_VERSION
        if client.collection_exists(name):
            client.delete_collection(name)


def _store(identity: dict | None = None) -> store_module.QdrantStore:
    return store_module.QdrantStore(store_module.make_client(), identity or IDENTITY)


def test_import_copies_every_chunk_with_its_vector_and_verifies(qdrant, tmp_path):
    root = _export(tmp_path, {"proj_alpha": _records(37), "oib_knowledge": _records(5)})

    assert _load_script().main(["--in", str(root), "--verify"]) == 0

    store = _store()
    assert store.count("proj_alpha") == 37 and store.count("oib_knowledge") == 5
    # The person-set facts rode along; the vectors are the export's own.
    assert store.count("proj_alpha", {"tags": "bescheid"}) == 18
    record = next(store.scroll("proj_alpha", {"page_label": "3"}))
    points = store.client.retrieve(store.alias("proj_alpha"), [record.id], with_vectors=["dense"])
    # Qdrant stores cosine vectors normalised: the same direction, unit length.
    original = _f32(_vector("Fluchtweg Abschnitt 3"))
    norm = sum(value * value for value in original) ** 0.5
    assert points[0].vector["dense"] == pytest.approx([value / norm for value in original], abs=1e-5)
    assert record.payload["text"] == "Fluchtweg Abschnitt 3"
    # The collection Qdrant created records the export's embedder.
    assert store.client.get_collection(store.alias("proj_alpha")).config.metadata["aiq:embed_fingerprint"] == "fp-test"


def test_import_is_idempotent_and_prune_repairs_deletes(qdrant, tmp_path):
    records = _records(12)
    script = _load_script()
    assert script.main(["--in", str(_export(tmp_path, {"proj_alpha": records}))]) == 0
    assert script.main(["--in", str(_export(tmp_path, {"proj_alpha": records}))]) == 0

    # Four chunks deleted in Chroma before a second export was taken, after the first import.
    smaller = _export(tmp_path, {"proj_alpha": records[4:]}, created_at=_now())
    assert script.main(["--in", str(smaller), "--verify"]) == 1  # 8 vs 12: a gap
    assert script.main(["--in", str(smaller), "--prune", "--verify"]) == 0
    assert _store().count("proj_alpha") == 8


def test_dry_run_writes_nothing(qdrant, tmp_path):
    root = _export(tmp_path, {"proj_alpha": _records(6)})
    assert _load_script().main(["--in", str(root), "--dry-run"]) == 0
    assert not _store().exists("proj_alpha")


def test_unreachable_qdrant_exits_two(qdrant, tmp_path, monkeypatch):
    root = _export(tmp_path, {"proj_alpha": _records(2)})
    monkeypatch.setenv("AIQ_QDRANT_URL", "http://127.0.0.1:9")
    assert _load_script().main(["--in", str(root)]) == 2


def test_a_run_that_stopped_halfway_is_finished_by_running_it_again(qdrant, tmp_path, monkeypatch):
    records = _records(20)
    root = _export(tmp_path, {"proj_alpha": records})
    real_upsert = store_module.QdrantStore.upsert
    calls = {"n": 0}

    def dies_after_three(self, *args, **kwargs):
        calls["n"] += 1
        if calls["n"] > 3:
            raise ConnectionError("the pod was evicted")
        return real_upsert(self, *args, **kwargs)

    monkeypatch.setattr(store_module.QdrantStore, "upsert", dies_after_three)
    assert _load_script().main(["--in", str(root), "--verify"]) == 1
    assert 0 < _store().count("proj_alpha") < 20

    monkeypatch.setattr(store_module.QdrantStore, "upsert", real_upsert)
    assert _load_script().main(["--in", str(root), "--verify"]) == 0
    assert _store().count("proj_alpha") == 20


def test_import_leaves_the_ids_ingestion_wrote_and_merges_the_rest(qdrant, tmp_path, monkeypatch):
    records = _records(4)
    store = _store()
    # Ingestion wrote a.pdf with what only its job knows.
    ingested = [
        ChunkRecord(record["id"], record["document"], record["embedding"], record["metadata"])
        for record in records
        if record["metadata"]["file_name"] == "a.pdf"
    ]
    store.upsert("proj_alpha", ingested, {"office_id": "org_1", "project_id": "p1", "grid_document_id": "doc-a"})
    assert store.count("proj_alpha", {"project_id": "p1"}) == 2
    # A field the payload gained after these points were written, and a fact a person set since.
    store.client.delete_payload(
        store.alias("proj_alpha"), keys=["paragraph_refs"], points=[records[1]["id"]], wait=True
    )
    monkeypatch.setattr(import_vectors, "facts_by_file", lambda scope: {"a.pdf": {"tags": ["plan"]}})

    assert _load_script().main(["--in", str(_export(tmp_path, {"proj_alpha": records})), "--verify"]) == 0

    assert store.count("proj_alpha") == 4
    assert store.count("proj_alpha", {"project_id": "p1"}) == 2
    assert store.count("proj_alpha", {"grid_document_id": "doc-a"}) == 2
    assert store.count("proj_alpha", {"office_id": "org_1"}) == 2
    assert store.count("proj_alpha", {"tags": "plan"}) == 2
    [point] = store.client.retrieve(store.alias("proj_alpha"), [records[1]["id"]], with_payload=True)
    assert point.payload["paragraph_refs"] == [] and point.payload["project_id"] == "p1"


def _ordinals(store: store_module.QdrantStore, scope: str) -> dict[str, int | None]:
    return {
        point.payload["chunk_id"]: point.payload.get(schema.CHUNK_ORDINAL_FIELD) for point in store.scroll(scope, None)
    }


def test_each_chunk_gets_its_place_in_its_file_from_the_export_order(qdrant, tmp_path):
    """The export is Chroma's insertion order, which is the chunker's: the only order a page's chunks have.

    Ten chunks of two files, interleaved, all on page 1, over three batch files.
    """
    records = _records(10)
    for record in records:
        record["metadata"]["page_label"] = "1"

    assert _load_script().main(["--in", str(_export(tmp_path, {"proj_alpha": records}))]) == 0

    expected = {}
    for file_name in ("b.pdf", "a.pdf"):
        in_file = [record["id"] for record in records if record["metadata"]["file_name"] == file_name]
        expected.update({chunk_id: ordinal for ordinal, chunk_id in enumerate(in_file)})
    assert _ordinals(_store(), "proj_alpha") == expected


def test_a_rerun_numbers_the_points_an_earlier_import_left_without_an_ordinal(qdrant, tmp_path):
    records = _records(4)
    store = _store()
    store.upsert("proj_alpha", [ChunkRecord(r["id"], r["document"], r["embedding"], r["metadata"]) for r in records])
    assert set(_ordinals(store, "proj_alpha").values()) == {None}

    assert _load_script().main(["--in", str(_export(tmp_path, {"proj_alpha": records}))]) == 0

    assert sorted(_ordinals(store, "proj_alpha").values()) == [0, 0, 1, 1]


def test_a_buero_scope_gets_its_office_from_its_name(qdrant, tmp_path):
    assert _load_script().main(["--in", str(_export(tmp_path, {"archiv_org_7": _records(3)}))]) == 0
    assert _store().count("archiv_org_7", {"office_id": "org_7"}) == 3


def test_imported_points_say_when_they_arrived_and_ingested_ones_keep_theirs(qdrant, tmp_path):
    """A collection's ``updated_at`` (what the uploads reaper reads) is its newest ``indexed_at``."""
    records = _records(4)
    store = _store()
    first = records[0]
    store.upsert(
        "proj_alpha",
        [ChunkRecord(first["id"], first["document"], first["embedding"], first["metadata"])],
        {schema.INDEXED_AT_FIELD: 5},
    )

    assert _load_script().main(["--in", str(_export(tmp_path, {"proj_alpha": records}))]) == 0

    assert store.count("proj_alpha", {schema.INDEXED_AT_FIELD: 5}) == 1
    assert store.newest("proj_alpha", schema.INDEXED_AT_FIELD) > 5
    assert store.newest("proj_alpha", schema.INDEXED_AT_FIELD, oldest=True) == 5


def test_vectors_from_another_embedder_are_refused_before_anything_is_written(qdrant, tmp_path):
    # The office collection already holds vectors of another embedder.
    _store(OTHER).upsert("proj_old", [ChunkRecord(str(uuid.uuid4()), "Alt", _vector("Alt"), {"file_name": "x"})])
    root = _export(tmp_path, {"oib_knowledge": _records(3), "proj_alpha": _records(3)})

    assert _load_script().main(["--in", str(root)]) == 2

    store = _store()
    assert store.count("proj_alpha") == 0
    # Refused for every collection up front: not even the corpus, whose collection was free, was written.
    assert not store.exists("oib_knowledge")


def test_an_export_mixing_embedders_in_one_collection_is_refused(qdrant, tmp_path):
    root = _export(tmp_path, {"proj_alpha": _records(2), "proj_beta": _records(2)}, proj_beta=OTHER)
    assert _load_script().main(["--in", str(root)]) == 2
    assert not _store().exists("proj_alpha")


def test_a_collection_without_a_fingerprint_takes_the_configured_embedder(qdrant, tmp_path, monkeypatch):
    script = _load_script()
    monkeypatch.setattr(script, "_configured_identity", lambda: dict(IDENTITY))
    root = _export(tmp_path, {"proj_alpha": _records(3)}, proj_alpha={})
    assert script.main(["--in", str(root), "--verify"]) == 0
    monkeypatch.setattr(script, "_configured_identity", lambda: dict(OTHER))
    # --force: refused for the embedder, not for the import that already verified.
    assert script.main(["--in", str(root), "--force"]) == 2


def test_a_scope_only_qdrant_holds_is_a_gap_and_prune_removes_it(qdrant, tmp_path):
    """A reaped conversation, or a collection deleted while the mirror failed, leaves a scope the export never names."""
    root = _export(tmp_path, {"proj_alpha": _records(3)})
    script = _load_script()
    assert script.main(["--in", str(root)]) == 0
    store = _store()
    store.upsert("s_conversation", [ChunkRecord(str(uuid.uuid4()), "Anhang", _vector("Anhang"), {"file_name": "x"})])
    store.upsert("oib_retired", [ChunkRecord(str(uuid.uuid4()), "Alt", _vector("Alt"), {"file_name": "y"})])

    assert script.main(["--in", str(root), "--verify"]) == 1
    assert store.count("s_conversation") == 1
    # Naming the collections leaves every other scope alone.
    assert script.main(["--in", str(root), "--collection", "proj_alpha", "--prune", "--verify"]) == 0
    assert store.count("s_conversation") == 1

    assert script.main(["--in", str(root), "--prune", "--verify"]) == 0
    assert store.count("s_conversation") == 0 and store.count("oib_retired") == 0
    assert store.count("proj_alpha") == 3


def test_verify_compares_ids_not_only_counts(qdrant, tmp_path):
    records = _records(10)
    root = _export(tmp_path, {"proj_alpha": records})
    script = _load_script()
    assert script.main(["--in", str(root), "--verify"]) == 0
    store = _store()
    # One point lost, one stray in its place: the counts agree, the sets do not.
    store.delete_chunks("proj_alpha", [records[0]["id"]])
    store.upsert("proj_alpha", [ChunkRecord(str(uuid.uuid4()), "Fremd", _vector("Fremd"), {"file_name": "c.pdf"})])
    assert store.count("proj_alpha") == 10

    # Only verifying, nothing copied: the equal counts alone would pass.
    assert script.main(["--in", str(root), "--verify-only"]) == 1
    ids = Export.open(root).id_set("proj_alpha")
    full = import_vectors.verify_scope(ids, "proj_alpha", store)
    assert (full.missing, full.extra, full.sampled) == (1, 1, False)
    sampled = import_vectors.verify_scope(ids, "proj_alpha", store, full_limit=5, sample=64)
    assert (sampled.missing, sampled.extra, sampled.sampled) == (1, 1, True)

    # The import puts the lost point back; the stray is still a gap until pruned.
    # --force: the first run verified, and repairing drift is a deliberate second import.
    assert script.main(["--in", str(root), "--verify", "--force"]) == 1
    assert script.main(["--in", str(root), "--prune", "--verify", "--force"]) == 0


def test_a_second_import_after_one_verified_is_refused_unless_forced(qdrant, tmp_path):
    """A Job re-created by a refresh, or a flag switched off and on: an old export brings deleted chunks back."""
    records = _records(6)
    root = _export(tmp_path, {"proj_alpha": records, "oib_knowledge": _records(2)})
    script = _load_script()
    assert script.main(["--in", str(root), "--verify"]) == 0
    store = _store()
    marker = import_vectors.recorded_import(store)
    assert marker and "2026-10-13T08:00:00+00:00" in marker
    for physical in schema.Physical:
        metadata = store.client.get_collection(schema.ALIASES[physical]).config.metadata
        assert metadata[import_vectors.IMPORT_MARKER_KEY] == marker
        assert metadata["aiq:embed_fingerprint"] == "fp-test"  # merged, not replaced

    # A document deleted since: a second import must not bring it back.
    store.delete_chunks("proj_alpha", [records[0]["id"]])
    assert script.main(["--in", str(root), "--verify"]) == 2
    assert script.main(["--in", str(root), "--collection", "proj_alpha"]) == 2
    assert script.main(["--in", str(root), "--prune", "--verify"]) == 2
    assert store.count("proj_alpha") == 5
    # Reading is never refused.
    assert script.main(["--in", str(root), "--dry-run"]) == 0
    assert script.main(["--in", str(root), "--verify-only"]) == 1
    # Deliberately, it still can.
    assert script.main(["--in", str(root), "--verify", "--force"]) == 0
    assert store.count("proj_alpha") == 6


def test_only_a_full_verified_import_is_recorded(qdrant, tmp_path):
    root = _export(tmp_path, {"proj_alpha": _records(3), "proj_beta": _records(3)})
    script = _load_script()
    assert script.main(["--in", str(root)]) == 0  # not verified
    assert script.main(["--in", str(root), "--collection", "proj_alpha", "--verify"]) == 0  # not every collection
    assert import_vectors.recorded_import(_store()) is None
    assert script.main(["--in", str(root), "--verify"]) == 0
    assert import_vectors.recorded_import(_store()) is not None


def test_a_file_ingested_again_after_the_export_keeps_what_ingestion_wrote(qdrant, tmp_path):
    """A re-upload before its scope was imported: the export's older Fassung must not go live beside it."""
    records = _records(6)  # a.pdf and b.pdf, three chunks each
    store = _store()
    # Ingestion wrote a new Fassung of a.pdf after the export was taken: new chunk ids, indexed now.
    fresh = [
        ChunkRecord(str(uuid.uuid4()), f"Neu {index}", _vector(f"Neu {index}"), {"file_name": "a.pdf"})
        for index in range(2)
    ]
    store.upsert("proj_alpha", fresh, {schema.INDEXED_AT_FIELD: int(datetime.datetime.now(datetime.UTC).timestamp())})
    root = _export(tmp_path, {"proj_alpha": records})  # taken on 2026-10-13, before that upload

    assert _load_script().main(["--in", str(root), "--verify"]) == 0

    old_a = [r["id"] for r in records if r["metadata"]["file_name"] == "a.pdf"]
    assert store.missing_chunk_ids("proj_alpha", old_a) == old_a  # none of the old Fassung went in
    assert store.count("proj_alpha", {"file_name": "a.pdf"}) == 2
    assert store.count("proj_alpha", {"file_name": "b.pdf"}) == 3
    # Pruning against the export leaves the new Fassung alone.
    assert _load_script().main(["--in", str(root), "--prune", "--verify", "--force"]) == 0
    assert store.count("proj_alpha", {"file_name": "a.pdf"}) == 2


def test_chunks_from_before_the_export_are_still_imported_beside_older_points(qdrant, tmp_path):
    """Only what is newer than the export counts as ingestion: a stale point from before it is not."""
    records = _records(4)
    store = _store()
    stale = ChunkRecord(str(uuid.uuid4()), "Alt", _vector("Alt"), {"file_name": "a.pdf"})
    store.upsert("proj_alpha", [stale], {schema.INDEXED_AT_FIELD: 5})
    root = _export(tmp_path, {"proj_alpha": records})

    assert _load_script().main(["--in", str(root), "--prune", "--verify"]) == 0
    assert store.count("proj_alpha", {"file_name": "a.pdf"}) == 2
    assert store.missing_chunk_ids("proj_alpha", [stale.chunk_id]) == [stale.chunk_id]


def test_facts_are_read_again_at_the_end_so_an_edit_made_meanwhile_wins(qdrant, tmp_path, monkeypatch):
    """A person re-tags a file while its collection is copied: the snapshot from the start must not overwrite it."""
    answers = iter([{"a.pdf": {"tags": ["alt"]}}, {"a.pdf": {"tags": ["neu"]}}])
    monkeypatch.setattr(import_vectors, "facts_by_file", lambda scope: next(answers))
    assert _load_script().main(["--in", str(_export(tmp_path, {"proj_alpha": _records(4)})), "--verify"]) == 0
    store = _store()
    assert store.count("proj_alpha", {"tags": "neu"}) == 2
    assert store.count("proj_alpha", {"tags": "alt"}) == 0
