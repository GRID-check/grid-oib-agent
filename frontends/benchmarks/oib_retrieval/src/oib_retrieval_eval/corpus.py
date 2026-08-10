"""The real ``data/oib`` corpus, extracted once and cut two ways for the A/B.

This module owns everything that touches a PDF, so the metric and qrels modules can stay
pure. It calls the PRODUCTION extractor and the PRODUCTION chunkers rather than
reimplementing either:

* ``knowledge_layer.llamaindex.adapter._extract_text_from_pdf`` — the same pdfplumber walk
  and watermark strip ingestion runs, so the harness sees the text the index sees;
* the OLD arm: one llama-index ``Document`` per extracted page, then
  ``SentenceSplitter(chunk_size=1024, chunk_overlap=128)``, which is what
  ``adapter.py`` did before Punkt chunking (and still does for any file the Punkt chunker
  declines);
* the NEW arm: ``knowledge_layer.llamaindex.punkt_chunking.punkt_documents``, then the
  SAME splitter, because production applies it downstream to whatever documents ingestion
  produced — leaving it off the new arm would credit it for over-long Punkte that
  production does in fact split.

Neither arm needs an API key: extraction and splitting are local.

CACHING
-------
pdfplumber takes ~7 s per Richtlinie and the corpus is 39 files, so extracted pages are
cached as JSON under ``.cache/pages/`` next to this package (gitignored). The cache key is
the PDF's path, size and mtime — a re-extraction is one deleted directory away, and a
changed PDF invalidates itself rather than silently scoring the old text.
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from dataclasses import field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

#: Production's splitter settings (``knowledge_layer.llamaindex.adapter`` defaults).
CHUNK_SIZE = 1024
CHUNK_OVERLAP = 128

#: The two chunking strategies under test. ``page`` is what shipped; ``punkt`` is the
#: replacement. Names are used as arm labels throughout the report.
ARM_PAGE = "page"
ARM_PUNKT = "punkt"
ARMS = (ARM_PAGE, ARM_PUNKT)


@dataclass(frozen=True)
class Chunk:
    """One retrievable chunk, carrying the citation contract the metrics score on.

    ``chunk_id`` exists so the real ``reciprocal_rank_fusion`` from
    ``knowledge_layer.llamaindex.hybrid`` can fuse these objects unchanged — that helper
    identifies a chunk by ``getattr(chunk, "chunk_id")`` and nothing else, so the harness
    fuses through the production code path instead of a lookalike.
    """

    chunk_id: str
    text: str
    file_name: str
    page: int
    arm: str
    metadata: dict[str, Any] = field(default_factory=dict, compare=False)

    @property
    def unit(self) -> tuple[str, int]:
        """The judged ``(file_name, page)`` unit this chunk would cite."""
        return (self.file_name, self.page)


def repo_root() -> Path:
    """Repo root, derived from this file's location.

    This file is ``<root>/frontends/benchmarks/oib_retrieval/src/oib_retrieval_eval/corpus.py``,
    so the root is five directories up.
    """
    return Path(__file__).resolve().parents[5]


def package_root() -> Path:
    """The ``oib_retrieval`` benchmark package directory."""
    return Path(__file__).resolve().parents[2]


def default_corpus_dir() -> Path:
    return repo_root() / "data" / "oib"


def default_cache_dir() -> Path:
    return package_root() / ".cache" / "pages"


def _cache_key(pdf_path: Path) -> str:
    stat = pdf_path.stat()
    digest = hashlib.sha256(f"{pdf_path.name}:{stat.st_size}:{int(stat.st_mtime)}".encode()).hexdigest()[:16]
    return f"{pdf_path.stem}.{digest}.json"


def extract_pages(pdf_path: Path, cache_dir: Path | None = None) -> list[dict[str, Any]]:
    """``[{"page_number": int, "text": str}, …]`` for one PDF, cached on disk.

    Delegates to the production extractor; see the module docstring for why that matters.
    """
    cache_dir = default_cache_dir() if cache_dir is None else cache_dir
    cache_path = cache_dir / _cache_key(pdf_path)
    if cache_path.exists():
        with open(cache_path, encoding="utf-8") as handle:
            return json.load(handle)

    from knowledge_layer.llamaindex.adapter import _extract_text_from_pdf

    pages = _extract_text_from_pdf(str(pdf_path))
    cache_dir.mkdir(parents=True, exist_ok=True)
    with open(cache_path, "w", encoding="utf-8") as handle:
        json.dump(pages, handle, ensure_ascii=False)
    return pages


def _splitter():
    """Production's ``SentenceSplitter``, imported lazily so pure modules stay importable."""
    from llama_index.core.node_parser import SentenceSplitter

    return SentenceSplitter(chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP)


def page_documents(pages: list[dict[str, Any]], file_name: str, file_size: int) -> list[Any]:
    """The OLD arm's documents: one per extracted page, exactly as ``adapter.py`` built them."""
    from llama_index.core import Document

    return [
        Document(
            text=page["text"],
            metadata={
                "file_name": file_name,
                "file_size": file_size,
                "page_label": str(page["page_number"]),
                "content_type": "text",
            },
        )
        for page in pages
    ]


def punkt_or_page_documents(pages: list[dict[str, Any]], file_name: str, file_size: int) -> list[Any]:
    """The NEW arm's documents: Punkt-cut where possible, per-page where not.

    ``punkt_documents`` returns ``None`` for the three files with no usable numbering
    (``Begriffsbestimmungen``, both ``Zitierte Normen``), and production then keeps the
    per-page behaviour. The harness reproduces that fallback rather than dropping those
    files, so the two arms index the same corpus and a recall difference cannot come from
    one arm simply having more of it.
    """
    from knowledge_layer.llamaindex.punkt_chunking import punkt_documents

    documents = punkt_documents(pages, file_name, file_size)
    if documents is None:
        return page_documents(pages, file_name, file_size)
    return documents


def _chunks_from_documents(documents: list[Any], file_name: str, arm: str) -> list[Chunk]:
    nodes = _splitter().get_nodes_from_documents(documents)
    chunks: list[Chunk] = []
    for position, node in enumerate(nodes):
        metadata = dict(node.metadata or {})
        page_label = metadata.get("page_label")
        try:
            page = int(str(page_label))
        except (TypeError, ValueError):
            # A node with no usable page cannot be cited, so it cannot be scored either.
            # Skipping it is the honest choice: counting it would let an arm pad its
            # ranking with results the product could never show.
            logger.debug("Skipping chunk with unusable page_label %r in %s", page_label, file_name)
            continue
        chunks.append(
            Chunk(
                chunk_id=f"{arm}:{file_name}:{position}",
                text=node.get_content(),
                file_name=file_name,
                page=page,
                arm=arm,
                metadata=metadata,
            )
        )
    return chunks


def build_arm(arm: str, corpus_dir: Path | None = None, cache_dir: Path | None = None) -> list[Chunk]:
    """Chunk the whole corpus under one strategy.

    Both arms index EVERY PDF in ``data/oib``, including the ``aenderungen_*`` change
    logs. Leaving them out would make the forbidden-hit rate structurally zero and
    measure nothing; they are in the corpus in production, so they are in the corpus here.
    """
    if arm not in ARMS:
        raise ValueError(f"unknown arm {arm!r}; expected one of {ARMS}")
    corpus_dir = default_corpus_dir() if corpus_dir is None else corpus_dir
    builder = page_documents if arm == ARM_PAGE else punkt_or_page_documents

    chunks: list[Chunk] = []
    for pdf_path in sorted(corpus_dir.glob("*.pdf")):
        pages = extract_pages(pdf_path, cache_dir=cache_dir)
        if not pages:
            logger.warning("No extractable text in %s", pdf_path.name)
            continue
        documents = builder(pages, pdf_path.name, pdf_path.stat().st_size)
        chunks.extend(_chunks_from_documents(documents, pdf_path.name, arm))
    return chunks


@dataclass(frozen=True)
class ProductionRetrievalSettings:
    """The query-time settings production's OIB workflow actually runs with.

    Read from ``configs/config_oib_openrouter.yml`` rather than copied, because a copy
    would stop matching the moment somebody tunes one and not the other — and a harness
    measuring settings nobody runs is worse than no harness.
    """

    top_k: int
    max_chunks_per_document: int
    exclude_file_names: frozenset[str]


def _knowledge_retrieval_node(payload: Any) -> dict[str, Any] | None:
    """The first ``knowledge_retrieval`` function block in the config, or ``None``."""
    if isinstance(payload, dict):
        if payload.get("_type") == "knowledge_retrieval":
            return payload
        for value in payload.values():
            found = _knowledge_retrieval_node(value)
            if found is not None:
                return found
    elif isinstance(payload, list):
        for value in payload:
            found = _knowledge_retrieval_node(value)
            if found is not None:
                return found
    return None


def production_retrieval_settings(config_path: Path | None = None) -> ProductionRetrievalSettings:
    """``top_k``, the diversity cap and the exclusion list, from the production OIB config.

    Falls back to the ``KnowledgeRetrievalConfig`` field defaults if the config or the
    block is absent, and the report then says which numbers it measured.
    """
    import yaml

    config_path = repo_root() / "configs" / "config_oib_openrouter.yml" if config_path is None else config_path
    if not config_path.exists():
        logger.warning("Production OIB config not found at %s; using field defaults", config_path)
        return ProductionRetrievalSettings(top_k=5, max_chunks_per_document=2, exclude_file_names=frozenset())
    with open(config_path, encoding="utf-8") as handle:
        payload = yaml.safe_load(handle)
    node = _knowledge_retrieval_node(payload) or {}
    return ProductionRetrievalSettings(
        top_k=int(node.get("top_k", 5)),
        max_chunks_per_document=int(node.get("max_chunks_per_document", 2)),
        exclude_file_names=frozenset(node.get("exclude_file_names") or ()),
    )


def production_excluded_file_names(config_path: Path | None = None) -> frozenset[str]:
    """The ``exclude_file_names`` list production's OIB config applies to the base collection.

    Read from ``configs/config_oib_openrouter.yml`` rather than copied, because a copy would
    stop matching the moment somebody adds a file to one and not the other — and the whole
    point of measuring this list is that it is the ONLY thing keeping the change-log PDFs out
    of answers. They are ingested; the filter is applied at query time.

    Returns an empty set if the config or the key is missing, and the caller then measures
    the unfiltered index — which is the honest degradation, since an absent filter is
    exactly the failure this guards against.
    """
    import yaml

    config_path = repo_root() / "configs" / "config_oib_openrouter.yml" if config_path is None else config_path
    if not config_path.exists():
        logger.warning("Production OIB config not found at %s; measuring the unfiltered index", config_path)
        return frozenset()
    with open(config_path, encoding="utf-8") as handle:
        payload = yaml.safe_load(handle)

    def walk(node: Any):
        if isinstance(node, dict):
            if "exclude_file_names" in node:
                yield from node["exclude_file_names"] or ()
            for value in node.values():
                yield from walk(value)
        elif isinstance(node, list):
            for value in node:
                yield from walk(value)

    return frozenset(walk(payload))


def dedupe_to_units(chunks: list[Chunk], limit: int | None = None) -> list[tuple[str, int]]:
    """Collapse a ranked chunk list into a ranked list of DISTINCT ``(file, page)`` units.

    First occurrence wins. Required before scoring — see the :mod:`metrics` docstring for
    why scoring chunks instead would make the two arms incomparable.
    """
    units: list[tuple[str, int]] = []
    seen: set[tuple[str, int]] = set()
    for chunk in chunks:
        unit = chunk.unit
        if unit in seen:
            continue
        seen.add(unit)
        units.append(unit)
        if limit is not None and len(units) >= limit:
            break
    return units
