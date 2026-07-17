"""Structure-aware corpus chunking driven by the norm registry (ADR-0025, Phase 2).

The registry is the contract for the base corpus: every PDF referenced by a
``kind: corpus`` edition is chunked by a per-country corpus adapter that knows
the document grammar (OIB ``Punkt`` numbering for Austria). Unknown files and
unknown grammars fall back to page-based chunks with doc-level metadata only.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from dataclasses import field
from typing import TYPE_CHECKING
from typing import Any

if TYPE_CHECKING:
    from aiq_agent.common.norm_registry import Edition
    from aiq_agent.common.norm_registry import NormEntry
    from aiq_agent.common.norm_registry import NormRegistry

logger = logging.getLogger(__name__)


@dataclass
class CorpusChunk:
    """One pre-split corpus chunk: text plus the metadata to stamp on it."""

    text: str
    metadata: dict[str, Any] = field(default_factory=dict)


def resolve_corpus_source(registry: NormRegistry, file_name: str) -> tuple[NormEntry, Edition] | None:
    """Find the registry entry + edition whose corpus source file is ``file_name``."""
    for entry in registry.entries:
        for edition in entry.editions:
            source = edition.source
            if source is not None and source.kind == "corpus" and source.file == file_name:
                return entry, edition
    return None


def base_metadata(entry: NormEntry, edition: Edition) -> dict[str, Any]:
    """Doc-level metadata every corpus chunk of this edition carries."""
    source = edition.source
    return {
        "doc_id": entry.id,
        "doc_short": entry.short,
        "doc_title": entry.title,
        "edition": edition.id,
        "edition_label": edition.label,
        "edition_status": edition.status,
        "rank": entry.rank,
        "role": edition.role or entry.role,
        "country": entry.jurisdiction.country,
        "file_name": source.file if source is not None else None,
    }


def _get_country_adapter(country: str):
    from aiq_agent.knowledge.corpus.at import AustriaCorpusAdapter

    adapters = {"at": AustriaCorpusAdapter}
    adapter_cls = adapters.get(country)
    return adapter_cls() if adapter_cls is not None else None


def build_corpus_chunks(
    file_name: str,
    pages: list[dict],
    registry: NormRegistry | None,
) -> list[CorpusChunk] | None:
    """Dispatch to the per-country corpus adapter for a registry-known file.

    Returns None when the file is not referenced by any corpus edition (the
    caller then falls back to its default page-based chunking). A registry-known
    file whose grammar the adapter cannot parse still yields page-based chunks,
    but with full doc-level registry metadata (fail-open, logged).
    """
    if registry is None:
        return None
    if file_name.startswith("RIS_") and file_name.lower().endswith(".txt"):
        from aiq_agent.knowledge.corpus.ris import build_ris_corpus_chunks

        return build_ris_corpus_chunks(file_name, pages, registry)
    resolved = resolve_corpus_source(registry, file_name)
    if resolved is None:
        return None
    entry, edition = resolved
    adapter = _get_country_adapter(entry.jurisdiction.country)
    if adapter is None:
        logger.warning(
            "No corpus adapter for country %r (doc %s); falling back to page-based chunks",
            entry.jurisdiction.country,
            entry.id,
        )
        return [_page_chunk(page, entry, edition) for page in pages]
    return adapter.build_chunks(entry, edition, pages)


def _page_chunk(page: dict, entry: NormEntry, edition: Edition) -> CorpusChunk:
    metadata = base_metadata(entry, edition)
    metadata["page_label"] = str(page.get("page_number", ""))
    return CorpusChunk(text=str(page.get("text", "")), metadata=metadata)


def registry_corpus_resolver(norms_dir: str | None = None):
    """Resolver callable for ingestion configs: ``(file_name, pages) -> chunks | None``.

    Loads the norm registry lazily on every call (registry edits do not require a
    restart) and delegates to :func:`build_corpus_chunks`. Wired into the
    LlamaIndex ingestor as ``corpus_resolver`` (ADR-0025 Phase 2).
    """

    def resolve(file_name: str, pages: list[dict]) -> list[CorpusChunk] | None:
        from aiq_agent.common.norm_registry import load_registry

        return build_corpus_chunks(file_name, pages, load_registry(norms_dir))

    return resolve
