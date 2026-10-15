"""The Chroma exporter, against a real Chroma, and the whole move: exporter, importer, Qdrant.

``chromadb`` is not a dependency of this repository, so these tests run in an
environment of their own, never in ``task be:test*`` (``deploy/`` is outside
pytest's ``testpaths``):

    task be:test:migration
    uvx --python 3.12 --with-requirements deploy/migration/chroma_export.py --with pytest \
        pytest deploy/migration/tests -q -p no:cacheprovider

The end-to-end test hands the export to ``scripts/import_vectors.py`` in the
repository's own venv (``.venv/bin/python``, or ``PILOTI_VENV_PYTHON``), which
has no ``chromadb``: the two halves share the file format and nothing else, as
in production. It needs ``AIQ_QDRANT_TEST_URL``; without it it skips locally
and fails on CI.
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import importlib.util
import json
import os
import pathlib
import random
import socket
import struct
import subprocess
import sys
import textwrap
import time
import urllib.request
import uuid

import chromadb
import pytest

HERE = pathlib.Path(__file__).resolve().parent
EXPORTER = HERE.parent / "chroma_export.py"
REPO = HERE.parents[2]
DIM = 8
IDENTITY = {"aiq:embed_fingerprint": "fp-test", "aiq:embed_model": "model-test"}


def _load_exporter():
    spec = importlib.util.spec_from_file_location("chroma_export", EXPORTER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _vector(seed: str) -> list[float]:
    rng = random.Random(seed)
    return [rng.uniform(-1, 1) for _ in range(DIM)]


def _seed(path: pathlib.Path) -> dict[str, dict[str, dict]]:
    """A persist directory with two collections; returns what each chunk holds, by collection and id."""
    client = chromadb.PersistentClient(path=str(path))
    held: dict[str, dict[str, dict]] = {}
    for name, count, metadata in (
        ("proj_alpha", 23, {"hnsw:space": "cosine", **IDENTITY}),
        ("oib_knowledge", 5, {"hnsw:space": "cosine"}),
    ):
        collection = client.get_or_create_collection(name, metadata=metadata)
        ids = [str(uuid.uuid4()) for _ in range(count - 1)] + [f"{name}-not-a-uuid"]
        texts = [f"Fluchtweg § {index} – Größe" for index in range(count)]
        metadatas = [
            {"file_name": "a.pdf" if index % 2 else "b.pdf", "page_label": str(index), "punkt_depth": index % 3}
            for index in range(count)
        ]
        embeddings = [_vector(chunk_id) for chunk_id in ids]
        collection.add(ids=ids, documents=texts, embeddings=embeddings, metadatas=metadatas)
        # What Chroma holds, which is float32 but not always the nearest float32 of what it was given.
        stored = collection.get(ids=ids, include=["embeddings"])
        vectors = dict(zip(stored["ids"], (vector.tolist() for vector in stored["embeddings"]), strict=True))
        held[name] = {
            chunk_id: {"document": text, "metadata": meta, "embedding": vectors[chunk_id]}
            for chunk_id, text, meta in zip(ids, texts, metadatas, strict=True)
        }
    return held


def _export(source: list[str], out: pathlib.Path, *extra: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(EXPORTER), *source, "--out", str(out), *extra],
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )


def _read(out: pathlib.Path, name: str, manifest: dict) -> dict[str, dict]:
    records: dict[str, dict] = {}
    for seq in range(manifest["collections"][name]["batches"]):
        with gzip.open(out / "collections" / name / f"{seq:06d}.jsonl.gz", "rt", encoding="utf-8") as handle:
            for line in handle:
                record = json.loads(line)
                raw = base64.b64decode(record["embedding"])
                record["embedding"] = list(struct.unpack(f"<{len(raw) // 4}f", raw))
                records[record.pop("id")] = record
    return records


def _digest(ids) -> str:
    total = sum(int.from_bytes(hashlib.sha256(chunk_id.encode()).digest(), "big") for chunk_id in ids) % (1 << 256)
    return f"sha256-sum:{total:064x}"


def _tree(path: pathlib.Path) -> dict[str, tuple[int, int]]:
    return {str(item.relative_to(path)): (item.stat().st_size, item.stat().st_mtime_ns) for item in path.rglob("*")}


@pytest.fixture
def chroma_dir(tmp_path):
    held = _seed(tmp_path / "chroma")
    return tmp_path / "chroma", held


def test_export_writes_the_manifest_and_every_record(chroma_dir, tmp_path):
    persist, held = chroma_dir
    before = _tree(persist)
    out = tmp_path / "export"

    result = _export(["--persist-dir", str(persist)], out, "--batch-size", "7")
    assert result.returncode == 0, result.stdout + result.stderr

    manifest = json.loads((out / "manifest.json").read_text())
    assert manifest["format"] == "piloti-vectors/1"
    assert manifest["chroma_version"] == chromadb.__version__
    assert manifest["created_at"]
    alpha = manifest["collections"]["proj_alpha"]
    assert (alpha["count"], alpha["dimension"], alpha["batches"]) == (23, DIM, 4)
    # The embedder identity travels with the collection; a collection without one says nothing.
    assert alpha["metadata"]["aiq:embed_fingerprint"] == "fp-test"
    assert "aiq:embed_fingerprint" not in manifest["collections"]["oib_knowledge"]["metadata"]
    for name, chunks in held.items():
        entry = manifest["collections"][name]
        assert entry["id_digest"] == _digest(chunks)
        assert _read(out, name, manifest) == chunks
    # The persist directory was copied, never opened in place.
    assert _tree(persist) == before
    assert not list(tmp_path.glob(".chroma-export-*"))


def test_a_rerun_replaces_the_export(chroma_dir, tmp_path):
    persist, _held = chroma_dir
    out = tmp_path / "export"
    assert _export(["--persist-dir", str(persist)], out).returncode == 0
    chromadb.PersistentClient(path=str(persist)).delete_collection("oib_knowledge")

    assert _export(["--persist-dir", str(persist)], out).returncode == 0

    manifest = json.loads((out / "manifest.json").read_text())
    assert set(manifest["collections"]) == {"proj_alpha"}
    assert sorted(path.name for path in (out / "collections").iterdir()) == ["proj_alpha"]


def test_a_directory_that_is_not_chroma_exits_two(tmp_path):
    result = _export(["--persist-dir", str(tmp_path)], tmp_path / "export")
    assert result.returncode == 2
    assert not (tmp_path / "export" / "manifest.json").exists()


class _Changing:
    """A collection that gains a chunk while it is read."""

    metadata: dict = {}

    def __init__(self):
        self.counts = iter([2, 3])

    def count(self):
        return next(self.counts)

    def get(self, include, limit, offset):
        ids = ["a", "b"][offset : offset + limit]
        return {"ids": ids, "embeddings": [[0.5] * DIM for _ in ids], "documents": ids, "metadatas": [{}] * len(ids)}


def test_a_collection_that_changes_while_it_is_read_fails(tmp_path):
    exporter = _load_exporter()
    with pytest.raises(exporter.ExportError, match="changed while it was read"):
        exporter.export_collection(_Changing(), tmp_path / "c", 10)


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture
def chroma_server(chroma_dir, tmp_path):
    persist, held = chroma_dir
    port = _free_port()
    chroma_cli = pathlib.Path(sys.executable).with_name("chroma")
    # The server's own output, so a start that fails says why (CI showed only
    # "did not come up" while its output went to /dev/null).
    log_path = tmp_path / "chroma-server.log"
    log = log_path.open("wb")
    process = subprocess.Popen(
        # Bind the address the test polls: `localhost`, the default, is ::1 on
        # the CI runner, where polling 127.0.0.1 never connected.
        [str(chroma_cli), "run", "--path", str(persist), "--host", "127.0.0.1", "--port", str(port)],
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    url = f"http://127.0.0.1:{port}"
    try:
        # A cold CI runner takes longer than a laptop to start the server.
        deadline = time.monotonic() + 60
        while True:
            try:
                urllib.request.urlopen(f"{url}/api/v2/heartbeat", timeout=1)
                break
            except OSError:
                if process.poll() is not None or time.monotonic() > deadline:
                    log.flush()
                    output = log_path.read_text(errors="replace")[-4000:]
                    state = f"exited with {process.returncode}" if process.poll() is not None else "still starting"
                    pytest.fail(f"the Chroma server did not come up ({state}); its output:\n{output}")
                time.sleep(0.25)
        yield url, held
    finally:
        process.terminate()
        process.wait(timeout=30)
        log.close()


def test_http_mode_exports_what_the_server_holds(chroma_server, tmp_path):
    url, held = chroma_server
    out = tmp_path / "export"
    result = _export(["--url", url], out, "--collection", "proj_alpha")
    assert result.returncode == 0, result.stdout + result.stderr
    manifest = json.loads((out / "manifest.json").read_text())
    assert manifest["source"]["mode"] == "http"
    assert set(manifest["collections"]) == {"proj_alpha"}
    assert _read(out, "proj_alpha", manifest) == held["proj_alpha"]


# ---------------------------------------------------------------------- exporter -> importer -> Qdrant

_DRIVER = textwrap.dedent(
    """
    import json, sys, uuid
    from knowledge_layer.qdrant import import_vectors, schema
    from knowledge_layer.qdrant import store as store_module

    suffix = sys.argv[2]
    schema.ALIASES[schema.Physical.CORPUS] = f"e2e_corpus_{suffix}"
    schema.ALIASES[schema.Physical.OFFICE] = f"e2e_office_{suffix}"
    # No metadata store in this test: no person has set a fact.
    import_vectors.facts_by_file = lambda scope: {}
    import importlib.util
    spec = importlib.util.spec_from_file_location("cli", sys.argv[1])
    cli = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cli)
    cli._configured_identity = lambda: {"aiq:embed_fingerprint": "fp-config", "aiq:embed_model": "config"}
    code = cli.main(["--in", sys.argv[3], "--verify"])
    client = store_module.make_client()
    seen = {}
    for scope in ("proj_alpha", "oib_knowledge"):
        store = store_module.QdrantStore(client)
        points = {}
        for record in store.scroll(scope):
            [point] = client.retrieve(store.alias(scope), [record.id], with_vectors=["dense"])
            points[record.payload["chunk_id"]] = {
                "text": record.payload["text"], "file_name": record.payload["file_name"],
                "page_label": record.payload["page_label"], "dense": point.vector["dense"],
                "ordinal": record.payload.get("chunk_ordinal"),
            }
        seen[scope] = {
            "points": points,
            "identity": client.get_collection(store.alias(scope)).config.metadata["aiq:embed_fingerprint"],
        }
    for physical in schema.Physical:
        name = schema.ALIASES[physical] + schema.FIRST_VERSION
        if client.collection_exists(name):
            client.delete_collection(name)
    print(json.dumps({"code": code, "seen": seen}))
    """
)


def _venv_python() -> pathlib.Path:
    return pathlib.Path(os.environ.get("PILOTI_VENV_PYTHON") or REPO / ".venv" / "bin" / "python")


def test_exported_vectors_arrive_in_qdrant_unchanged(chroma_dir, tmp_path):
    url = os.environ.get("AIQ_QDRANT_TEST_URL", "").strip()
    if not url:
        if os.environ.get("CI"):
            pytest.fail("AIQ_QDRANT_TEST_URL is unset on CI: the Qdrant service container is missing")
        pytest.skip("AIQ_QDRANT_TEST_URL not set")
    persist, held = chroma_dir
    out = tmp_path / "export"
    assert _export(["--persist-dir", str(persist)], out, "--batch-size", "4").returncode == 0

    result = subprocess.run(
        [
            str(_venv_python()),
            "-c",
            _DRIVER,
            str(REPO / "scripts" / "import_vectors.py"),
            uuid.uuid4().hex[:8],
            str(out),
        ],
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
        env={**os.environ, "AIQ_QDRANT_URL": url},
    )
    assert result.returncode == 0, result.stdout[-4000:] + result.stderr[-4000:]
    report = json.loads(result.stdout.strip().splitlines()[-1])
    assert report["code"] == 0
    seen = report["seen"]
    # The collection with a fingerprint keeps its own; the one without takes the configured embedder.
    assert seen["proj_alpha"]["identity"] == "fp-test"
    assert seen["oib_knowledge"]["identity"] == "fp-config"
    for name, chunks in held.items():
        points = seen[name]["points"]
        assert set(points) == set(chunks)
        for chunk_id, chunk in chunks.items():
            point = points[chunk_id]
            assert (point["text"], point["file_name"], point["page_label"]) == (
                chunk["document"],
                chunk["metadata"]["file_name"],
                chunk["metadata"]["page_label"],
            )
            # Qdrant stores cosine vectors normalised: the same direction, unit length.
            norm = sum(value * value for value in chunk["embedding"]) ** 0.5
            assert point["dense"] == pytest.approx([value / norm for value in chunk["embedding"]], abs=1e-5)
        # Each file's chunks are numbered in the order Chroma was given them (the chunker's, at
        # ingest), read back through pages of four: the order the readers sort a page by.
        for file_name in ("a.pdf", "b.pdf"):
            inserted = [chunk_id for chunk_id, chunk in chunks.items() if chunk["metadata"]["file_name"] == file_name]
            assert [points[chunk_id]["ordinal"] for chunk_id in inserted] == list(range(len(inserted)))
