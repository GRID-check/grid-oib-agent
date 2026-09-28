"""The OIB harness's page cache round-trips what the production extractor returns.

``_extract_text_from_pdf`` puts captioned tables into ``page["tables"]`` as
``PageTable`` dataclasses. ``json.dump`` cannot write those, so the first
``extract_pages`` call raised and left a truncated cache file that every later
run failed to parse. Offline: the extractor is replaced by a stub.

Import fallback as in ``test_oib_retrieval_structure.py``.
"""

import sys
from pathlib import Path

import pytest

try:
    from oib_retrieval_eval import corpus
except ImportError:
    _SRC = Path(__file__).resolve().parents[2] / "frontends" / "benchmarks" / "oib_retrieval" / "src"
    sys.path.insert(0, str(_SRC))
    from oib_retrieval_eval import corpus

pytest.importorskip("llama_index.core", reason="the chunking arms are llama-index Documents")

from knowledge_layer.llamaindex import adapter  # noqa: E402
from knowledge_layer.llamaindex.captioned_tables import PageTable  # noqa: E402


def _pages() -> list[dict]:
    table = PageTable("3", "Anforderungen an Treppenhäuser", [["", "GK 4", "GK 5"], ["Wände", "REI 60", "REI 90"]], 7)
    return [{"page_number": 7, "text": "Fließtext.", "tables": [table], "table_boxes": [(10.0, 20.0, 300.0, 400.0)]}]


@pytest.fixture
def pdf(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "oib-rl_2.pdf"
    path.write_bytes(b"%PDF-1.7 stub")
    monkeypatch.setattr(adapter, "_extract_text_from_pdf", lambda _path: _pages())
    return path


def test_pages_with_tables_are_cached_and_read_back_as_page_tables(pdf: Path, tmp_path: Path) -> None:
    cache = tmp_path / "cache"
    fresh = corpus.extract_pages(pdf, cache_dir=cache)
    cached = corpus.extract_pages(pdf, cache_dir=cache)

    assert cached == fresh
    assert isinstance(cached[0]["tables"][0], PageTable)
    assert [path.suffix for path in cache.iterdir()] == [".json"]


def test_a_failed_write_leaves_no_cache_entry(pdf: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    cache = tmp_path / "cache"

    def boom(*_args, **_kwargs):
        raise TypeError("not serialisable")

    monkeypatch.setattr(corpus.json, "dump", boom)
    with pytest.raises(TypeError):
        corpus.extract_pages(pdf, cache_dir=cache)

    assert list(cache.iterdir()) == []


def test_cache_key_carries_the_page_shape_version(pdf: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    key = corpus._cache_key(pdf)
    monkeypatch.setattr(corpus, "PAGE_SHAPE_VERSION", corpus.PAGE_SHAPE_VERSION + 1)

    assert corpus._cache_key(pdf) != key


def test_page_arm_puts_the_tables_back_into_the_page_text() -> None:
    [document] = corpus.page_documents(_pages(), "oib-rl_2.pdf", 1)

    assert "Tabelle 3: Anforderungen an Treppenhäuser" in document.text
    assert "REI 90" in document.text
