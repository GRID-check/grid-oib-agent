"""Corpus adapter for RIS-fetched consolidated statutes (norm-registry Phase 3).

``ris_fetch_document`` ingests fetched statutes as ``RIS_<name>.txt`` files whose
first line carries the source URL. This adapter parses the ``§`` grammar,
chunks on paragraph boundaries, and stamps registry metadata when the document
number matches a ``kind: ris`` edition (blind fetches get a ``ris:<docnr>``
identity without rank/role).
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING
from typing import Any

from aiq_agent.knowledge.corpus import CorpusChunk

if TYPE_CHECKING:
    from aiq_agent.common.norm_registry import NormRegistry

logger = logging.getLogger(__name__)

_SOURCE_URL_RE = re.compile(r"^Source:\s*(\S+)", re.MULTILINE)
_DOC_NUMBER_RE = re.compile(r"/Dokumente/[^/]+/([A-Za-z0-9_.\-]+)/")
_HEADING_RE = re.compile(r"^§\s*(\d+[a-z]?)\b\.?\s*(.*?)\s*$")
_PARAGRAPH_BREAK_RE = re.compile(r"\n\s*\n")

MAX_CHUNK_CHARS = 3000


@dataclass
class Segment:
    punkt: str
    punkt_title: str
    body: str


def parse_paragraph_segments(text: str) -> list[Segment]:
    """Split plain statute text into ``§``-keyed segments (flat grammar)."""
    segments: list[Segment] = []
    current: Segment | None = None
    for line in text.split("\n"):
        match = _HEADING_RE.match(line.strip())
        if match:
            current = Segment(punkt=match.group(1), punkt_title=match.group(2), body="")
            segments.append(current)
        elif current is not None:
            current.body += line + "\n"
    return segments


def _document_number_from_url(url: str) -> str | None:
    match = _DOC_NUMBER_RE.search(url)
    return match.group(1) if match else None


def _source_url(text: str) -> str | None:
    match = _SOURCE_URL_RE.search(text)
    return match.group(1) if match else None


def _registry_ris_source(registry: NormRegistry, document_number: str) -> tuple[Any, Any] | None:
    for entry in registry.entries:
        for edition in entry.editions:
            source = edition.source
            if source is not None and source.kind == "ris" and source.document_number == document_number:
                return entry, edition
    return None


def _base_metadata(file_name: str, source_url: str | None, document_number: str | None, resolved) -> dict[str, Any]:
    metadata: dict[str, Any] = {"file_name": file_name}
    if source_url:
        metadata["source_url"] = source_url
    if document_number:
        metadata["document_number"] = document_number
    if resolved is not None:
        entry, edition = resolved
        metadata.update(
            {
                "doc_id": entry.id,
                "doc_short": entry.short,
                "doc_title": entry.title,
                "edition": edition.id,
                "edition_label": edition.label,
                "edition_status": edition.status,
                "rank": entry.rank,
                "role": edition.role or entry.role,
                "country": entry.jurisdiction.country,
            }
        )
    elif document_number:
        metadata["doc_id"] = f"ris:{document_number}"
        metadata["doc_title"] = document_number
    return metadata


def _prefix(metadata: dict[str, Any], paragraph: str) -> str:
    short, full = metadata.get("doc_short"), metadata.get("doc_title")
    title = f"{short} - {full}" if short and full else (short or full or metadata["file_name"])
    label = metadata.get("edition_label")
    role = metadata.get("role")
    head = f"{title} ({label})" if label else title
    return f"{head}, § {paragraph}, {role}\n" if role else f"{head}, § {paragraph}\n"


def _hard_split(text: str, max_chars: int) -> list[str]:
    parts: list[str] = []
    remaining = text
    while len(remaining) > max_chars:
        cut = remaining.rfind("\n\n", 0, max_chars)
        if cut < max_chars // 2:
            cut = max_chars
        parts.append(remaining[:cut].rstrip())
        remaining = remaining[cut:].lstrip("\n")
    if remaining.strip():
        parts.append(remaining)
    return parts


def build_ris_corpus_chunks(
    file_name: str,
    pages: list[dict],
    registry: NormRegistry | None,
) -> list[CorpusChunk] | None:
    """Chunk a fetched RIS text file on ``§`` boundaries with registry metadata."""
    text = "\n".join(str(page.get("text", "")) for page in pages)
    source_url = _source_url(text)
    document_number = _document_number_from_url(source_url) if source_url else None
    resolved = _registry_ris_source(registry, document_number) if (registry and document_number) else None
    metadata = _base_metadata(file_name, source_url, document_number, resolved)
    if "doc_id" not in metadata:
        return None

    body = _SOURCE_URL_RE.sub("", text, count=1).lstrip("\n")
    segments = parse_paragraph_segments(body)
    if not segments:
        logger.warning("corpus/ris: no § headings in %s; falling back to a single doc-level chunk", file_name)
        return [CorpusChunk(text=body, metadata={**metadata, "page_label": "1", "chunk_index": 0})]

    chunks: list[CorpusChunk] = []
    prefix_for = lambda segment: _prefix(metadata, segment.punkt)  # noqa: E731
    group: list[Segment] = []

    def flush() -> None:
        if not group:
            return
        paragraph = group[0].punkt
        text_out = prefix_for(group[0])
        for segment in group:
            heading = f"§ {segment.punkt} {segment.punkt_title}".rstrip()
            text_out += f"{heading}\n{segment.body.strip()}\n\n"
        chunks.append(
            CorpusChunk(
                text=text_out.rstrip(),
                metadata={**metadata, "paragraph": paragraph, "chunk_index": len(chunks)},
            )
        )
        group.clear()

    for segment in segments:
        candidate = sum(len(s.body) + len(s.punkt) + len(s.punkt_title) + 8 for s in [*group, segment])
        single = len(segment.body) + len(prefix_for(segment))
        if single > MAX_CHUNK_CHARS:
            flush()
            heading = f"§ {segment.punkt} {segment.punkt_title}".rstrip()
            for piece in _hard_split(f"{heading}\n{segment.body.strip()}", MAX_CHUNK_CHARS - len(prefix_for(segment))):
                chunks.append(
                    CorpusChunk(
                        text=prefix_for(segment) + piece,
                        metadata={**metadata, "paragraph": segment.punkt, "chunk_index": len(chunks)},
                    )
                )
        elif group and candidate > MAX_CHUNK_CHARS:
            flush()
            group.append(segment)
        else:
            group.append(segment)
    flush()
    return chunks
