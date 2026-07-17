"""Austrian corpus adapter: OIB ``Punkt`` grammar.

OIB Richtlinien number their provisions as dotted ``Punkte`` (``3.1.2``). This
adapter parses that grammar out of the pdfplumber page text and chunks on
Punkt boundaries instead of the flat page chop:

- a chunk is the largest ``Punkt`` subtree that fits the character cap
  (sub-points stay with their parent);
- an oversized subtree splits at child boundaries;
- an oversized single Punkt hard-splits at paragraph boundaries, keeping the
  same ``punkt`` key with increasing ``chunk_index``.

Every chunk gets a deterministic context prefix (Anthropic contextual-retrieval
effect at zero LLM cost) and full registry metadata. Documents that do not
match the grammar fall back to page-based chunks with doc-level metadata only.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from dataclasses import field
from typing import TYPE_CHECKING

from aiq_agent.knowledge.corpus import CorpusChunk
from aiq_agent.knowledge.corpus import base_metadata

if TYPE_CHECKING:
    from aiq_agent.common.norm_registry import Edition
    from aiq_agent.common.norm_registry import NormEntry

logger = logging.getLogger(__name__)

# A Punkt heading is a dotted number at line start followed by a title, e.g.
# "3.1.2 Nutzungen mit besonderem Gefährdungspotenzial". Decimal versions
# inside prose ("Version 2.0 ist maßgeblich") must not match: the number must
# be followed by whitespace + an uppercase letter or a typical title character.
_HEADING_RE = re.compile(r"^(\d+(?:\.\d+)*)\s+([A-ZÄÖÜ(].*?)\s*$", re.MULTILINE)

# Rough token budget: the embedding model caps at 2048 tokens and the
# SentenceSplitter downstream targets 1024; ~3000 chars of German legalese
# stays well under both.
DEFAULT_MAX_CHUNK_CHARS = 3000


@dataclass
class PunktSegment:
    punkt: str
    title: str
    text: str
    page_labels: list[int] = field(default_factory=list)


class AustriaCorpusAdapter:
    """Parse and chunk OIB-family documents on Punkt boundaries."""

    def __init__(self, max_chunk_chars: int = DEFAULT_MAX_CHUNK_CHARS):
        self.max_chunk_chars = max_chunk_chars

    def parse_segments(self, pages: list[dict]) -> list[PunktSegment]:
        segments: list[PunktSegment] = []
        current: PunktSegment | None = None
        for page in pages:
            page_number = int(page.get("page_number", 0))
            for line in str(page.get("text", "")).splitlines():
                match = re.match(r"^(\d+(?:\.\d+)*)\s+([A-ZÄÖÜ(].*?)\s*$", line)
                if match:
                    current = PunktSegment(
                        punkt=match.group(1),
                        title=match.group(2),
                        text=line.strip(),
                        page_labels=[page_number],
                    )
                    segments.append(current)
                elif current is not None:
                    current.text += "\n" + line
                    if page_number not in current.page_labels:
                        current.page_labels.append(page_number)
                # Lines before the first heading (cover page, TOC) are dropped:
                # they carry no normative content.
        return segments

    def build_chunks(self, entry: NormEntry, edition: Edition, pages: list[dict]) -> list[CorpusChunk]:
        metadata = base_metadata(entry, edition)
        segments = self.parse_segments(pages)
        if not segments:
            logger.warning(
                "Punkt grammar not detected in %s (doc %s); falling back to page-based chunks",
                metadata["file_name"],
                entry.id,
            )
            chunks: list[CorpusChunk] = []
            for page in pages:
                page_meta = dict(metadata)
                page_meta["page_label"] = str(page.get("page_number", ""))
                chunks.append(CorpusChunk(text=str(page.get("text", "")), metadata=page_meta))
            return chunks

        chunks = []
        for punkt, chunk_index, text, page_labels in self._pack(segments):
            chunk_meta = dict(metadata)
            chunk_meta["punkt"] = punkt
            chunk_meta["punkt_title"] = self._title_for(segments, punkt)
            chunk_meta["chunk_index"] = chunk_index
            chunk_meta["page_label"] = str(page_labels[0]) if page_labels else ""
            prefix = f"{entry.short} - {entry.title} ({edition.label}), Pkt {punkt}, {metadata['role']}"
            chunks.append(CorpusChunk(text=f"{prefix}\n{text}", metadata=chunk_meta))
        return chunks

    @staticmethod
    def _title_for(segments: list[PunktSegment], punkt: str) -> str:
        for segment in segments:
            if segment.punkt == punkt:
                return segment.title
        return ""

    def _pack(self, segments: list[PunktSegment], carry: tuple[str, ...] = ()) -> list[tuple[str, int, str, list[int]]]:
        """Recursive subtree packing; yields (punkt, chunk_index, text, page_labels).

        A whole subtree that fits becomes one chunk keyed by its root Punkt.
        When it does not fit, the root's own text is emitted as a chunk (or, for
        heading-only roots, carried into the first descendant chunk as context)
        and the children are packed recursively.
        """
        units: list[tuple[str, int, str, list[int]]] = []
        pending = list(carry)
        i = 0
        while i < len(segments):
            root = segments[i]
            j = i + 1
            while j < len(segments) and segments[j].punkt.startswith(root.punkt + "."):
                j += 1
            subtree = segments[i:j]
            page_labels = sorted({p for m in subtree for p in m.page_labels})
            if len(subtree) == 1:
                units.extend(self._emit(root.punkt, self._join(subtree), pending, page_labels))
                pending = []
            elif len(self._join(subtree)) + sum(len(c) + 1 for c in pending) <= self.max_chunk_chars:
                units.append((root.punkt, 0, self._with_carry(pending, self._join(subtree)), page_labels))
                pending = []
            else:
                body = root.text.split("\n", 1)[1] if "\n" in root.text else ""
                if body.strip():
                    units.append((root.punkt, 0, self._with_carry(pending, root.text), page_labels))
                    pending = []
                else:
                    pending.append(root.text)
                units.extend(self._pack(subtree[1:], tuple(pending)))
                pending = []
            i = j
        return units

    @staticmethod
    def _with_carry(carry: list[str], text: str) -> str:
        return "\n".join([*carry, text]) if carry else text

    def _emit(
        self, punkt: str, text: str, carry: list[str], page_labels: list[int]
    ) -> list[tuple[str, int, str, list[int]]]:
        """Emit one Punkt; hard-split at paragraph boundaries when oversized."""
        full = self._with_carry(carry, text)
        if len(full) <= self.max_chunk_chars + sum(len(c) + 1 for c in carry):
            return [(punkt, 0, full, page_labels)]
        parts: list[str] = []
        current = self._with_carry(carry, "") if carry else ""
        for paragraph in re.split(r"\n\s*\n", text):
            candidate = f"{current}\n\n{paragraph}" if current else paragraph
            if current and len(candidate) > self.max_chunk_chars:
                parts.append(current)
                current = paragraph
            else:
                current = candidate
        if current:
            parts.append(current)
        return [(punkt, idx, part, page_labels) for idx, part in enumerate(parts)]

    @staticmethod
    def _join(members: list[PunktSegment]) -> str:
        return "\n".join(m.text for m in members if m.text.strip())
