"""Only ``knowledge_layer/qdrant/`` talks to Qdrant, and nothing talks to Chroma (ADR-0113, ADR-0114).

The scope filter is the boundary between offices' documents. It holds by
construction only while every read goes through ``knowledge_layer.qdrant``,
whose filters cannot be built without a scope; a second client elsewhere
would be a read path that never asked for one. Tests may import the client to
drive and inspect the server.

Chroma is gone: Qdrant is the one vector store. The only code that may still
read a Chroma store is the one-off migration that exports it
(:data:`CHROMA_ALLOWED`), which carries its own dependencies; a ``chromadb``
import anywhere else would be a second store creeping back in.
"""

from __future__ import annotations

import pathlib
import re

REPO = pathlib.Path(__file__).resolve().parents[3]
ALLOWED = REPO / "sources" / "knowledge_layer" / "src" / "qdrant"
SEARCHED = ("src", "sources", "frontends/aiq_api/src", "scripts")
IMPORT = re.compile(r"^\s*(from\s+qdrant_client\b|import\s+qdrant_client\b)", re.MULTILINE)

#: The migration tool that exports an old Chroma store (``docs/deployment/qdrant-runbook.md``).
CHROMA_ALLOWED = ("deploy/migration",)
#: Trees that are not this repo's code.
NOT_OURS = frozenset({".venv", "node_modules", ".git", ".claude", ".agents"})
#: An import, or a test's ``pytest.importorskip("chromadb")``: the second one
#: skipped quietly once ``chromadb`` left the environment, and took its
#: assertions with it (``test_browse.py``'s exact-mode store tests did).
CHROMA_IMPORT = re.compile(
    r"^\s*(from\s+(chromadb|llama_index\.vector_stores\.chroma)\b"
    r"|import\s+(chromadb|llama_index\.vector_stores\.chroma)\b)"
    r"|importorskip\(\s*[\"'](chromadb|llama_index\.vector_stores\.chroma)\b",
    re.MULTILINE,
)
#: Chroma's client reached without importing it: looked up by name on the
#: retriever (``getattr(retriever, "_get_chroma_client", None)``) or called by
#: its collection API. A develop merge brought the first one in after Chroma
#: was gone; the Fassung compare then read nothing and said the file was not
#: in the index, with every test green against a faked client.
CHROMA_CLIENT_USE = re.compile(
    r"_get_chroma_client|\bchroma_client\b|\.get_collection\(\s*name=|include=\[\s*[\"']documents[\"']"
)


def _offenders() -> list[str]:
    offenders: list[str] = []
    for root in SEARCHED:
        for path in (REPO / root).rglob("*.py"):
            if ALLOWED in path.parents or "tests" in path.relative_to(REPO).parts:
                continue
            if IMPORT.search(path.read_text(encoding="utf-8", errors="ignore")):
                offenders.append(str(path.relative_to(REPO)))
    return offenders


def _chroma_users(pattern: re.Pattern[str]) -> list[str]:
    offenders: list[str] = []
    for path in REPO.rglob("*.py"):
        relative = path.relative_to(REPO)
        if NOT_OURS & set(relative.parts) or str(relative).startswith(CHROMA_ALLOWED):
            continue
        if path == pathlib.Path(__file__).resolve():  # this file plants the strings it looks for
            continue
        if pattern.search(path.read_text(encoding="utf-8", errors="ignore")):
            offenders.append(str(relative))
    return offenders


def _chroma_importers() -> list[str]:
    return _chroma_users(CHROMA_IMPORT)


def test_only_the_qdrant_package_imports_qdrant_client():
    assert _offenders() == []


def test_the_boundary_check_would_see_an_offender():
    """The check is not vacuous: a planted import outside the package is found."""
    planted = REPO / "scripts" / "_planted_qdrant_import_check.py"
    planted.write_text("from qdrant_client import QdrantClient\n", encoding="utf-8")
    try:
        assert "scripts/_planted_qdrant_import_check.py" in _offenders()
    finally:
        planted.unlink()


def test_nothing_but_the_migration_imports_chromadb():
    assert _chroma_importers() == []


def test_the_chroma_check_sees_an_offender_in_code_and_tests_alike():
    planted = [
        REPO / "src" / "_planted_chroma_check.py",
        REPO / "tests" / "_planted_chroma_check.py",
        REPO / "tests" / "_planted_chroma_skip_check.py",
    ]
    planted[0].write_text("import chromadb\n", encoding="utf-8")
    planted[1].write_text("from llama_index.vector_stores.chroma import ChromaVectorStore\n", encoding="utf-8")
    planted[2].write_text('    chromadb = pytest.importorskip("chromadb")\n', encoding="utf-8")
    try:
        found = _chroma_importers()
        assert {str(path.relative_to(REPO)) for path in planted} <= set(found)
    finally:
        for path in planted:
            path.unlink()


def test_nothing_reaches_for_a_chroma_client_by_name():
    """No code, test fakes included, asks for Chroma's client or calls its collection API."""
    assert _chroma_users(CHROMA_CLIENT_USE) == []


def test_the_client_check_would_see_a_lookup_by_name():
    planted = REPO / "scripts" / "_planted_chroma_client_check.py"
    planted.write_text('client_of = getattr(retriever, "_get_chroma_client", None)\n', encoding="utf-8")
    try:
        assert "scripts/_planted_chroma_client_check.py" in _chroma_users(CHROMA_CLIENT_USE)
    finally:
        planted.unlink()
