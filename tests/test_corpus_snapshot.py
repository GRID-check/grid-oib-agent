"""The corpus snapshot's packing: the part of `scripts/corpus_snapshot.py` that runs without a registry.

A snapshot that restores the wrong files, or writes outside the places the
agent reads, would pass every run that uses it while testing a corpus nobody
ingested; so the round trip and the refusal are pinned here.
"""

from __future__ import annotations

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
