"""The corpus snapshot's packing: the part of `scripts/corpus_snapshot.py` that runs without a registry.

A snapshot that restores the wrong files, or writes outside the places the
agent reads, would pass every run that uses it while testing a corpus nobody
ingested; so the round trip and the refusal are pinned here.
"""

from __future__ import annotations

import hashlib
import io
import sys
import tarfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import corpus_snapshot  # noqa: E402


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    root = tmp_path / "repo"
    (root / "data" / "oib").mkdir(parents=True)
    monkeypatch.setattr(corpus_snapshot, "ROOT", root)
    monkeypatch.setenv("AIQ_CHROMA_DIR", str(tmp_path / "chroma"))
    return root


def _ingested(root: Path, chroma: Path) -> None:
    (root / "data/oib/oib-rl_2_ausgabe_mai_2023.pdf").write_bytes(b"%PDF-1.4 rl2")
    (root / "data/oib/README.md").write_text("not corpus")
    (root / "data/oib_registry.json").write_text('{"__chunk_format_version__": 4}')
    (root / "summaries.db").write_bytes(b"sqlite")
    (chroma / "abc").mkdir(parents=True)
    (chroma / "chroma.sqlite3").write_bytes(b"vectors")


def test_a_snapshot_restores_exactly_what_the_ingest_wrote(workspace, tmp_path):
    chroma = tmp_path / "chroma"
    _ingested(workspace, chroma)
    archive = tmp_path / "corpus.tar.gz"
    corpus_snapshot.pack(archive)

    for path in (workspace / "data/oib/oib-rl_2_ausgabe_mai_2023.pdf", workspace / "data/oib_registry.json"):
        path.unlink()
    (workspace / "summaries.db").unlink()
    (chroma / "chroma.sqlite3").unlink()

    corpus_snapshot.unpack(archive)

    assert (workspace / "data/oib/oib-rl_2_ausgabe_mai_2023.pdf").read_bytes() == b"%PDF-1.4 rl2"
    assert (workspace / "data/oib_registry.json").read_text() == '{"__chunk_format_version__": 4}'
    assert (workspace / "summaries.db").read_bytes() == b"sqlite"
    assert (chroma / "chroma.sqlite3").read_bytes() == b"vectors"
    names = tarfile.open(archive).getnames()
    assert "data/oib/README.md" not in names


@pytest.mark.parametrize("member", ["../escape.pdf", "data/oib/../../x.pdf", "data/oib/notes.txt", "etc/passwd"])
def test_a_snapshot_with_an_unexpected_member_is_refused(workspace, tmp_path, member):
    archive = tmp_path / "bad.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        info = tarfile.TarInfo(member)
        info.size = 1
        tar.addfile(info, io.BytesIO(b"x"))
    with pytest.raises(SystemExit, match="unexpected members"):
        corpus_snapshot.unpack(archive)


def test_the_tags_follow_the_chunk_format():
    assert corpus_snapshot.tags(4) == ["format-4", "latest"]
    from aiq_agent.oib_sync import CHUNK_FORMAT_VERSION

    assert corpus_snapshot.chunk_format_version() == CHUNK_FORMAT_VERSION


def test_a_snapshot_carries_the_admin_uploads_too(workspace, tmp_path):
    # Staging keeps its corpus under data/oib_uploads, so that is what a
    # snapshot mirrored from staging holds.
    (workspace / "data/oib_uploads").mkdir(parents=True)
    (workspace / "data/oib_uploads/oib-rl_4_ausgabe_mai_2023.pdf").write_bytes(b"%PDF rl4")
    (workspace / "data/oib_registry.json").write_text("{}")
    archive = tmp_path / "corpus.tar.gz"
    corpus_snapshot.pack(archive)
    (workspace / "data/oib_uploads/oib-rl_4_ausgabe_mai_2023.pdf").unlink()

    corpus_snapshot.unpack(archive)

    assert (workspace / "data/oib_uploads/oib-rl_4_ausgabe_mai_2023.pdf").read_bytes() == b"%PDF rl4"


def test_mirroring_an_empty_directory_is_refused(workspace, tmp_path):
    # A copy from staging that failed must not read as "every document was
    # deleted" and empty the index.
    (tmp_path / "empty").mkdir()
    with pytest.raises(SystemExit, match="refusing to mirror an empty corpus"):
        corpus_snapshot.mirror(tmp_path / "empty")


def test_mirroring_adds_changes_and_removes_like_the_admin_ui(workspace, tmp_path, monkeypatch):
    from aiq_agent import oib_sync

    uploads = workspace / "data/oib_uploads"
    uploads.mkdir(parents=True)
    (uploads / "kept.pdf").write_bytes(b"same")
    (uploads / "changed.pdf").write_bytes(b"old")
    (uploads / "gone.pdf").write_bytes(b"deleted in staging")
    source = tmp_path / "staging"
    source.mkdir()
    (source / "kept.pdf").write_bytes(b"same")
    (source / "changed.pdf").write_bytes(b"new")
    (source / "new.pdf").write_bytes(b"uploaded in staging")

    removed, synced = [], []
    _fake_oib_sync(monkeypatch, oib_sync, uploads, removed, synced)

    changes = corpus_snapshot.mirror(source)

    assert changes == {"added_or_changed": ["changed.pdf", "new.pdf"], "removed": ["gone.pdf"]}
    assert removed == ["gone.pdf"]
    assert synced == [True]
    assert (uploads / "changed.pdf").read_bytes() == b"new"
    assert (uploads / "new.pdf").read_bytes() == b"uploaded in staging"


def _fake_oib_sync(monkeypatch, oib_sync, uploads, removed, synced, *, fail=()):
    """oib_sync without an ingestor: sync records every upload's hash except those in ``fail``."""

    def sync():
        synced.append(True)
        registry.update({str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in uploads.glob("*.pdf")})
        for name in fail:
            registry.pop(str(uploads / name), None)
        return (0, 0)

    registry: dict[str, str] = {}
    monkeypatch.setattr(oib_sync, "OIB_UPLOADS_DIR", uploads)
    monkeypatch.setattr(oib_sync, "remove_uploaded_document", lambda name: removed.append(name) or True)
    monkeypatch.setattr(oib_sync, "sync", sync)
    monkeypatch.setattr(oib_sync, "_load_registry", lambda: dict(registry))


def _staging(tmp_path, files: dict[str, bytes]) -> Path:
    source = tmp_path / "staging"
    source.mkdir()
    for name, data in files.items():
        (source / name).write_bytes(data)
    return source


def _manifest(tmp_path, files: dict[str, bytes]) -> Path:
    manifest = tmp_path / "manifest.txt"
    manifest.write_text("".join(f"{hashlib.sha256(d).hexdigest()}  {n}\n" for n, d in files.items()))
    return manifest


def test_a_restore_makes_the_uploads_exactly_the_snapshot_and_leaves_data_oib_alone(workspace, tmp_path):
    # A leftover upload would be ingested by the next sync on top of the
    # restored index; a developer's own data/oib corpus must survive a pull.
    (workspace / "data/oib_uploads").mkdir(parents=True)
    (workspace / "data/oib_uploads/in-snapshot.pdf").write_bytes(b"%PDF a")
    (workspace / "data/oib_registry.json").write_text("{}")
    archive = tmp_path / "corpus.tar.gz"
    corpus_snapshot.pack(archive)
    (workspace / "data/oib_uploads/leftover.pdf").write_bytes(b"%PDF stale")
    (workspace / "data/oib").mkdir(parents=True, exist_ok=True)
    (workspace / "data/oib/mine.pdf").write_bytes(b"%PDF mine")

    corpus_snapshot.unpack(archive)

    assert sorted(p.name for p in (workspace / "data/oib_uploads").glob("*.pdf")) == ["in-snapshot.pdf"]
    assert (workspace / "data/oib/mine.pdf").read_bytes() == b"%PDF mine"


@pytest.mark.parametrize(
    "copied",
    [
        {"a.pdf": b"A"},  # b.pdf never arrived
        {"a.pdf": b"A", "b.pdf": b"B, trunc"},  # b.pdf arrived cut short
        {"a.pdf": b"A", "b.pdf": b"B", "c.pdf": b"C"},  # something not in staging
    ],
)
def test_a_copy_that_is_not_the_manifest_is_refused_before_anything_changes(workspace, tmp_path, monkeypatch, copied):
    from aiq_agent import oib_sync

    uploads = workspace / "data/oib_uploads"
    uploads.mkdir(parents=True)
    (uploads / "b.pdf").write_bytes(b"B")
    removed, synced = [], []
    _fake_oib_sync(monkeypatch, oib_sync, uploads, removed, synced)

    with pytest.raises(SystemExit, match="refusing to mirror a partial copy"):
        corpus_snapshot.mirror(_staging(tmp_path, copied), _manifest(tmp_path, {"a.pdf": b"A", "b.pdf": b"B"}))

    assert (removed, synced) == ([], [])
    assert (uploads / "b.pdf").read_bytes() == b"B"


def test_a_copy_that_matches_the_manifest_is_mirrored(workspace, tmp_path, monkeypatch):
    from aiq_agent import oib_sync

    files = {"a.pdf": b"A", "b.pdf": b"B"}
    uploads = workspace / "data/oib_uploads"
    uploads.mkdir(parents=True)
    _fake_oib_sync(monkeypatch, oib_sync, uploads, [], [])

    changes = corpus_snapshot.mirror(_staging(tmp_path, files), _manifest(tmp_path, files))

    assert changes == {"added_or_changed": ["a.pdf", "b.pdf"], "removed": []}


def test_a_pdf_that_did_not_ingest_stops_the_snapshot_from_being_published(workspace, tmp_path, monkeypatch):
    from aiq_agent import oib_sync

    uploads = workspace / "data/oib_uploads"
    uploads.mkdir(parents=True)
    _fake_oib_sync(monkeypatch, oib_sync, uploads, [], [], fail=("b.pdf",))

    with pytest.raises(SystemExit, match=r"1 PDF\(s\) did not ingest, refusing to publish: \['b.pdf'\]"):
        corpus_snapshot.mirror(_staging(tmp_path, {"a.pdf": b"A", "b.pdf": b"B"}))
