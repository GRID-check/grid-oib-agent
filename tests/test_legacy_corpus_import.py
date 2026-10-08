"""The one-shot import of a pre-A2 data volume into the corpus store."""

from __future__ import annotations

import hashlib
import json

import pytest

from aiq_agent import corpus_store
from aiq_agent import legacy_corpus_import as importer


@pytest.fixture
def store(monkeypatch):
    """The corpus store as a dict: name -> bytes. ``fail`` names a file whose store raises."""
    stored: dict[str, bytes] = {}
    fail: set[str] = set()

    def get_file(name):
        if name not in stored:
            return None
        data = stored[name]
        return corpus_store.FileRow(name, f"base-corpus/{name}", hashlib.sha256(data).hexdigest(), len(data))

    def put(name, data):
        if name in fail:
            raise corpus_store.CorpusStoreError(f"upload-url request for {name} was refused (HTTP 502)")
        stored[name] = data

    monkeypatch.setattr(corpus_store, "get_file", get_file)
    monkeypatch.setattr(corpus_store, "put", put)
    return stored, fail


def _legacy(tmp_path, *, operator=(), uploads=(), excluded=None):
    tmp_path.mkdir(parents=True, exist_ok=True)
    for directory, names in (("oib", operator), ("oib_uploads", uploads)):
        (tmp_path / directory).mkdir(exist_ok=True)
        for name in names:
            (tmp_path / directory / name).write_bytes(f"{directory}:{name}".encode())
    if excluded is not None:
        (tmp_path / "oib_excluded.json").write_text(json.dumps(excluded), encoding="utf-8")
    return tmp_path


def test_operator_pdfs_and_uploads_are_stored(tmp_path, store):
    stored, _ = store
    root = _legacy(tmp_path, operator=["OIB-RL2.pdf"], uploads=["Bauordnung.pdf"])

    counts = importer.import_legacy_corpus(root)

    assert stored == {"OIB-RL2.pdf": b"oib:OIB-RL2.pdf", "Bauordnung.pdf": b"oib_uploads:Bauordnung.pdf"}
    assert counts == {"stored": 2, "unchanged": 0, "skipped": 0, "failed": 0}


def test_an_excluded_operator_pdf_stays_out_but_an_upload_of_that_name_comes_in(tmp_path, store):
    stored, _ = store
    root = _legacy(
        tmp_path, operator=["Alt.pdf", "OIB-RL2.pdf"], uploads=["OIB-RL2.pdf"], excluded=["Alt.pdf", "OIB-RL2.pdf"]
    )

    importer.import_legacy_corpus(root)

    assert stored == {"OIB-RL2.pdf": b"oib_uploads:OIB-RL2.pdf"}


def test_a_second_run_stores_nothing(tmp_path, store):
    root = _legacy(tmp_path, operator=["OIB-RL2.pdf"], uploads=["Bauordnung.pdf"])
    importer.import_legacy_corpus(root)

    counts = importer.import_legacy_corpus(root)

    assert counts == {"stored": 0, "unchanged": 2, "skipped": 0, "failed": 0}


def test_a_file_stored_with_other_bytes_is_replaced(tmp_path, store):
    stored, _ = store
    stored["OIB-RL2.pdf"] = b"an older revision"
    root = _legacy(tmp_path, operator=["OIB-RL2.pdf"])

    assert importer.import_legacy_corpus(root)["stored"] == 1
    assert stored["OIB-RL2.pdf"] == b"oib:OIB-RL2.pdf"


def test_a_failed_store_is_counted_and_fails_the_run_so_the_job_retries(tmp_path, store, capsys):
    stored, fail = store
    fail.add("Bauordnung.pdf")
    root = _legacy(tmp_path, operator=["OIB-RL2.pdf"], uploads=["Bauordnung.pdf"])

    assert importer.main([str(root)]) == 1
    assert '"failed": 1' in capsys.readouterr().out
    assert list(stored) == ["OIB-RL2.pdf"]


def test_a_volume_without_a_corpus_is_a_successful_no_op(tmp_path, store):
    assert importer.main([str(tmp_path)]) == 0
    assert store[0] == {}


def test_the_operator_pdfs_can_live_beside_the_volume(tmp_path, store):
    # Compose bind-mounted the host's data/oib over /app/data/oib, so the
    # importer is given it as its own directory.
    stored, _ = store
    volume = _legacy(tmp_path / "data", uploads=["Bauordnung.pdf"], excluded=["Alt.pdf"])
    operator = tmp_path / "host-oib"
    operator.mkdir()
    for name in ("OIB-RL2.pdf", "Alt.pdf"):
        (operator / name).write_bytes(name.encode())

    assert importer.main([str(volume), str(operator)]) == 0
    assert sorted(stored) == ["Bauordnung.pdf", "OIB-RL2.pdf"]
