"""[6] The grounding block.

Byte-compatible with ``knowledge_layer.register._format_results`` where it
matters: ``--- Result N ---`` blocks, ``Citation:`` / ``Dokumentart:`` /
``Punkt:`` / ``Relevance Score:`` in the header, the passage body after the
score line, and one ``## Trace-Lanes`` object at the end (built by the
knowledge layer's OWN helper, so the lanes cannot drift). That grammar is what
``citation_verification._parse_knowledge_layer`` reads, and reusing it is the
whole reason RIS is evidence now rather than a URL in prose.
"""

from __future__ import annotations

from knowledge_layer.register import _trace_lanes_json
from ris_adapter.lookup.address import Address
from ris_adapter.lookup.address import land_sentence
from ris_adapter.lookup.passages import DOC_CLASS
from ris_adapter.lookup.passages import Passage


def format_passages(passages: list[Passage], ingested_name: str | None, address: Address) -> str:
    """The knowledge layer's grounding grammar, field for field.

    The preamble carries the two facts that are about the CALL rather than
    about a passage — the jurisdiction it assumed, and the document it left in
    the session collection. It sits before the first ``--- Result N ---``, so
    the citation parser never sees it as a hit's field.
    """
    documents = len({passage.url for passage in passages})
    lines = [f"Found {len(passages)} relevant passage(s) in {documents} document(s):"]
    if address.bundesland:
        lines.append(land_sentence(address))
    if ingested_name:
        lines.append(
            f'[The complete document was added to the knowledge base as "{ingested_name}" — '
            "read_passage reopens any other § of it.]"
        )
    lines.append("")
    for index, passage in enumerate(passages, 1):
        lines.extend(_passage_block(index, passage))
    lines.append("## Trace-Lanes")
    lines.append(_trace_lanes_block(passages))
    lines.append("")
    return "\n".join(lines)


def _passage_block(index: int, passage: Passage) -> list[str]:
    """One ``--- Result N ---`` block. Header first, body after the score line."""
    from aiq_agent.knowledge.document_classification import DOCUMENT_CLASS_LABELS

    lines = [
        f"--- Result {index} ---",
        f"Source: {passage.title}",
        f"Source URL: {passage.url}",
        f"Collection: {passage.collection}",
        "Shelf: base",
        f"Dokumentart: {DOC_CLASS} — {DOCUMENT_CLASS_LABELS.get(DOC_CLASS, DOC_CLASS)}",
    ]
    if passage.punkt_label:
        # The locus as a lawyer reads it, ``§ 63 Abs 1``: the same string the
        # citation key carries and the chip shows. ``_KL_PUNKT_RE`` reads the
        # whole line, so nothing here is squeezed to fit a token rule.
        lines.append(f"Punkt: {passage.punkt_label}")
    if passage.status_note:
        # The Konsolidierte-Fassung disclaimer rides as its own header line and
        # is never inside a body: a passage body is text the answer may quote.
        lines.append(f"Rechtlicher Hinweis: {passage.status_note}")
    lines += [
        f"Citation: {passage.citation}",
        "Content Type: text",
        f"Relevance Score: {passage.score:.2f}",
        "",
        passage.body,
        "",
    ]
    return lines


def _trace_lanes_block(passages: list[Passage]) -> str:
    """The ``## Trace-Lanes`` fan-out, through the knowledge layer's own helper.

    The helper reads ``file_name``/``page_number``/``metadata`` off each hit and
    nothing else, so RIS lanes are computed by the SAME function as corpus
    lanes instead of a second table that would eventually disagree with it. The
    two resolver maps are passed EMPTY on purpose: they resolve a document's
    stored doc_class and display title out of the metadata store, and a RIS
    passage is not in it — an empty map means "nothing stored", which is true.
    """
    from types import SimpleNamespace

    chunks = [
        SimpleNamespace(
            file_name=passage.citation,
            page_number=None,
            metadata={"collection": passage.collection, "shelf": "base", "doc_class": DOC_CLASS},
        )
        for passage in passages
    ]
    return _trace_lanes_json(chunks, {}, {})
