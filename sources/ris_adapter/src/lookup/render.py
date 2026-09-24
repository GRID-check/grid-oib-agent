"""[6] The grounding block.

RIS states its passages as :class:`~aiq_agent.common.grounding_block.GroundingHit`
records and hands them to the one renderer every evidence tool shares
(ADR-0061). There is no RIS layout: the ``--- Result N ---`` blocks, the header
lines and the ``## Trace-Lanes`` object are the knowledge layer's, which is the
whole reason RIS is evidence now rather than a URL in prose. The same reader
that reads a corpus hit reads this.
"""

from __future__ import annotations

from knowledge_layer.register import _trace_lanes_json
from ris_adapter.lookup.address import Address
from ris_adapter.lookup.address import land_sentence
from ris_adapter.lookup.passages import DOC_CLASS
from ris_adapter.lookup.passages import Passage

from aiq_agent.common.grounding_block import TRUNCATION_MARKER
from aiq_agent.common.grounding_block import GroundingBlock
from aiq_agent.common.grounding_block import GroundingHit
from aiq_agent.common.grounding_block import render_grounding_block
from aiq_agent.common.source_kinds import Shelf


def format_passages(passages: list[Passage], ingested_name: str | None, address: Address) -> str:
    """Every selected passage as one grounding block.

    The preamble carries the two facts that are about the CALL rather than
    about a passage: the jurisdiction it assumed, and the document it left in
    the session collection. It sits before the first ``--- Result N ---``, so
    the citation reader never sees it as a hit's field.
    """
    hits = tuple(_hit(passage) for passage in passages)
    return render_grounding_block(
        GroundingBlock(
            preamble="\n".join(_preamble_lines(passages, ingested_name, address)),
            degraded_banner="",
            hits=hits,
            lanes=_trace_lanes_block(passages),
        )
    )


def _preamble_lines(passages: list[Passage], ingested_name: str | None, address: Address) -> list[str]:
    """The count, the jurisdiction the call assumed, and what it ingested."""
    documents = len({passage.url for passage in passages})
    lines = [f"Found {len(passages)} relevant passage(s) in {documents} document(s):"]
    if address.bundesland:
        lines.append(land_sentence(address))
    if ingested_name:
        lines.append(
            f'[The complete document was added to the knowledge base as "{ingested_name}" — '
            "read_passage reopens any other § of it.]"
        )
    return lines


def _hit(passage: Passage) -> GroundingHit:
    """One passage as a record.

    ``file_name`` is the citation rather than a filename because RIS holds no
    file: the key the answer copies IS this passage's identity. The shelf is
    stated (``base``) rather than left unknown, because RIS is the base corpus
    of law. The doc_class is known here too, which is what puts the hit in the
    Rechtsquelle lane instead of Projektwissen.

    No URL is stated. The one RIS has is the WHOLE law, the same for every §,
    and printed as ``Source URL:`` beside the citation it was what the answer
    copied: "Bauordnung für Wien - <link>" names no § the lookup returned, the
    verifier removed it, and a repair pass paid for it on every Bauordnung
    question of the answer suite. The citation key is the passage's identity.
    """
    body, truncated = _cut_body(passage.body)
    return GroundingHit(
        citation_key=passage.citation,
        file_name=passage.citation,
        page=None,
        shelf=Shelf.BASE,
        collection=passage.collection,
        doc_class=DOC_CLASS,
        display_title=passage.title,
        folder_path=None,
        # The locus as a lawyer reads it, ``§ 63 Abs 1``: the same string the
        # citation key carries and the chip shows.
        punkt=passage.punkt_label or None,
        score=passage.score,
        content_type="text",
        provenance=None,
        stored_image_index=None,
        # The Konsolidierte-Fassung disclaimer rides as its own header line and
        # is never inside a body: a passage body is text the answer may quote.
        status_note=passage.status_note or None,
        body=body,
        body_truncated=truncated,
    )


def _cut_body(body: str) -> tuple[str, bool]:
    """The passage text, and whether ``cut_on_absatz`` had to cut it.

    The marker is protocol and the renderer appends it, so it is taken back off
    here rather than travelling inside the record. A body is evidence:
    ``verify_quoted_spans`` matches the answer's quotes against it.
    """
    if not body.endswith(TRUNCATION_MARKER):
        return body, False
    return body[: -len(TRUNCATION_MARKER)], True


def _trace_lanes_block(passages: list[Passage]) -> str:
    """The ``## Trace-Lanes`` fan-out, through the knowledge layer's own helper.

    The helper builds its own records off these hit-likes, so RIS lanes are
    computed by the SAME function as corpus lanes instead of a second table
    that would eventually disagree with it. The two resolver maps are passed
    EMPTY on purpose: they resolve a document's stored doc_class and display
    title out of the metadata store, and a RIS passage is not in it. An empty
    map means "nothing stored", which is true.

    The fan-out is fed the CITATION as the name and no title, while the block's
    ``Source:`` line carries the Kurztitel. That is not a drift: the fan-out
    names a document by its identity and adds a title only when the identity is
    not readable, and for a RIS passage the citation key already reads as the
    law and its §. A Kurztitel put there as a title would replace ``§ 63 Abs 1``
    in the Herleitung with the law's name alone.
    """
    from types import SimpleNamespace

    chunks = [
        SimpleNamespace(
            file_name=passage.citation,
            page_number=None,
            content=passage.body,
            content_type=SimpleNamespace(value="text"),
            score=passage.score,
            metadata={"collection": passage.collection, "shelf": "base", "doc_class": DOC_CLASS},
        )
        for passage in passages
    ]
    return _trace_lanes_json(chunks, {}, {})
