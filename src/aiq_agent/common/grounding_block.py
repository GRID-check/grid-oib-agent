"""A grounding hit is a record; the text a tool returns is its rendering.

Every evidence tool answers in one grammar: a preamble, a run of
``--- Result N ---`` blocks, and a ``## Trace-Lanes`` object. Two packages used
to write that grammar by hand (``knowledge_layer.register._format_results`` and
``ris_adapter.lookup.render``) and a third read it back with eleven regexes on
every live turn. Three copies of one layout, in three repositories' worth of
review.

This module holds the layout once. A producer builds :class:`GroundingHit`
records and calls :func:`render_grounding_block`; the renderer emits the text
the model reads AND files the records under the hash of those exact bytes, so
the reader that later gets the text back can look the records up instead of
parsing them. The text is still the only thing that reaches the model, and it
is byte-for-byte what it was. See ADR-0061.

The lookup is per turn and per context: :func:`begin_grounding_capture` opens
it where the turn's other captures open (``turn_status.begin_lane_capture``),
and a miss is normal, not an error. A stored turn replayed from Postgres, a
cached registry and the job runner's callback all hold the text without the
records, so ``citation_verification`` keeps its text parsers for them.
"""

from __future__ import annotations

import hashlib
import logging
from collections import OrderedDict
from collections.abc import Iterator
from contextvars import ContextVar
from contextvars import Token

from pydantic import BaseModel
from pydantic import ConfigDict

from aiq_agent.common.provenance import AGENT_AUTHOR
from aiq_agent.common.provenance import AgentProvenance
from aiq_agent.common.provenance import provenance_label
from aiq_agent.common.source_kinds import Shelf

logger = logging.getLogger(__name__)

#: Appended to a body its producer had to cut. Protocol, not evidence: the
#: renderer adds it and every reader takes it back off, so a quote is never
#: matched against it.
TRUNCATION_MARKER = "... [truncated]"


class GroundingHit(BaseModel):
    """One citable passage, as data, before anything renders it.

    Carries what a ``SourceEntry`` needs plus what the block's header lines
    need, and nothing else. Two fields are worth reading twice:

    ``shelf`` has NO default. ADR-0047 says a shelf is stated by the producer
    or is unknown, never re-derived from a collection id, and the ``Shelf:``
    line is omitted for an unknown one, so the reader sees the absence.

    ``doc_class`` is the RAW key (``gesetz``), never the ``key — label`` line
    the renderer builds from it. The label is German rendering; the key is what
    ``lane_for_hit`` reads first.
    """

    model_config = ConfigDict(frozen=True)

    #: The key the model copies into its answer, and the document identity the
    #: registry dedups on. Carries the page and, when one filename arrived from
    #: two shelves in one result set, the shelf qualifier.
    citation_key: str
    #: The raw filename. Document identity for the fan-out and for preview
    #: resolution; never prettified.
    file_name: str
    #: 1-based page, or ``None`` when the document has no pagination. A
    #: producer sets it only for a real page, so the renderer needs no second
    #: ``> 0`` guard.
    page: int | None
    shelf: Shelf | None
    collection: str | None
    doc_class: str | None
    #: The user-facing name on the ``Source:`` line. Falls back to the filename
    #: for a document with no stored or derived title.
    display_title: str
    #: Where the user filed the document (ADR-0049), or ``None`` at the root.
    folder_path: str | None
    #: The locus in the document's own numbering, readable: ``3.5.2`` for the
    #: corpus, ``§ 63 Abs 1`` for a law. Never squeezed to one token.
    punkt: str | None
    #: Required, because the ``Relevance Score:`` line is also the grammar's
    #: header/body delimiter: a hit with no score would render a body that
    #: reads as more header.
    score: float
    #: One of the five :class:`~aiq_agent.knowledge.schema.ContentType` values.
    content_type: str
    #: The provenance of an agent-authored, human-approved document, or
    #: ``None`` for everything a human wrote (``common/provenance.py``).
    provenance: AgentProvenance | None
    #: Index of a raster stored beside the document, for ``view_knowledge_image``.
    #: ``None`` when the hit carries no stored image.
    stored_image_index: int | None
    #: A legal disclaimer about the document's status (RIS consolidated
    #: versions). Its own header line, never inside the body: a body is text
    #: the answer may quote.
    status_note: str | None
    #: Where the passage can be read online. RIS states one; the corpus does not.
    source_url: str | None
    #: The passage itself, already cut to the producer's budget.
    body: str
    #: Whether :attr:`body` was cut, which appends the truncation marker. The
    #: marker is protocol and not evidence, so the reader drops it again.
    body_truncated: bool = False

    @property
    def authored_by(self) -> str | None:
        """``"agent"`` for a Piloti document, ``None`` for everything else.

        Derived rather than stored so it cannot disagree with
        :attr:`provenance`. Fails CLOSED the way the text path does: unknown
        and human are the same value here, and only a parsed provenance buys a
        document its Piloti lane and its verdict ban.
        """
        return AGENT_AUTHOR if self.provenance is not None else None


class GroundingBlock(BaseModel):
    """A whole tool result: what the hits are, and what frames them."""

    model_config = ConfigDict(frozen=True)

    #: The lines before the first hit: the count, and anything about the CALL
    #: rather than about a passage (RIS states its assumed jurisdiction here).
    preamble: str
    #: What is rendered ahead of everything and outside the grammar: the
    #: requery notice when the search widened, and a partial-retrieval warning
    #: when a layer dropped out. Empty when neither applies. It is part of the
    #: block so the hash the reader looks up is the hash of the whole text.
    degraded_banner: str
    hits: tuple[GroundingHit, ...]
    #: The ``## Trace-Lanes`` JSON, built by the producer from these same hits.
    lanes: str
    #: What is rendered after the lanes and outside the grammar: ``read_passage``
    #: puts its ``## Gliederung`` index here, and the one line that replaces the
    #: index for a document with no Punkte. Empty when neither applies. It is
    #: part of the block for the same reason the banner is: the reader looks the
    #: records up by the hash of the WHOLE text, so a producer that appended
    #: these bytes itself fell back to the text parser.
    trailer: str = ""


# ---------------------------------------------------------------------------
# The renderer
# ---------------------------------------------------------------------------


def render_grounding_block(block: GroundingBlock) -> str:
    """The block as the text a model reads, filed under the hash of that text.

    The one place the grammar's line order and spacing live. Recording is done
    HERE rather than by the callers, so a producer cannot emit a block and
    forget to make it readable back.
    """
    lines: list[str] = block.preamble.split("\n") if block.preamble else []
    lines.append("")
    for index, hit in enumerate(block.hits, 1):
        lines.extend(_hit_lines(index, hit))
    lines.append("## Trace-Lanes")
    lines.append(block.lanes)
    lines.append("")
    if block.trailer:
        lines.append(block.trailer)
    rendered = block.degraded_banner + "\n".join(lines)
    record_grounding_block(block, rendered)
    return rendered


def _hit_lines(index: int, hit: GroundingHit) -> list[str]:
    """One ``--- Result N ---`` block: header, blank line, body, blank line."""
    body = (hit.body + TRUNCATION_MARKER) if hit.body_truncated else hit.body
    return [f"--- Result {index} ---", *_header_lines(hit), "", body, ""]


def _header_lines(hit: GroundingHit) -> Iterator[str]:
    """The header, in order. An optional field with no value emits no line.

    The absence is the message: a reader must see that a hit stated no shelf,
    no Dokumentart and no folder, rather than read a default the pipeline
    picked. ``Relevance Score:`` is last because it delimits the body.

    Every string value goes through :func:`_line`, because a header field is
    one line by definition and several of these values come from a document's
    own text (a title read out of a PDF, a folder a user named). The numbers
    and the :class:`~aiq_agent.common.source_kinds.Shelf` enum cannot carry a
    newline, so they go in as they are.
    """
    yield f"Source: {_line(hit.display_title)}"
    if hit.source_url:
        yield f"Source URL: {_line(hit.source_url)}"
    if hit.collection:
        yield f"Collection: {_line(hit.collection)}"
    if hit.shelf is not None:
        yield f"Shelf: {hit.shelf}"
    if hit.folder_path:
        yield f"Ordner: {_line(hit.folder_path)}"
    if hit.doc_class:
        yield f"Dokumentart: {_line(hit.doc_class)} — {_line(_doc_class_label(hit.doc_class))}"
    if hit.provenance is not None:
        yield f"Herkunft: {_line(provenance_label(hit.provenance))}"
    if hit.page is not None:
        yield f"Page: {hit.page}"
    if hit.punkt:
        yield f"Punkt: {_line(hit.punkt)}"
    if hit.status_note:
        yield f"Rechtlicher Hinweis: {_line(hit.status_note)}"
    yield f"Citation: {_line(hit.citation_key)}"
    yield f"Content Type: {_line(hit.content_type)}"
    if hit.stored_image_index is not None:
        yield f"Image: stored (view_knowledge_image image_index={hit.stored_image_index})"
    yield f"Relevance Score: {hit.score:.2f}"


def _line(value: str) -> str:
    """``value`` as ONE header line: every line break becomes a single space.

    A header field states what the HIT says. A value that carries a newline
    would render as further header lines, and the text reader would then read a
    ``Shelf:`` or a ``Dokumentart:`` off a title the producer took out of a
    document. The structured reader copies fields and never sees this, so the
    collapse is what keeps the two readers on one answer. A value with no line
    break is returned unchanged, which is why the byte-identity fixtures still
    hold.
    """
    return value.replace("\r\n", " ").replace("\n", " ").replace("\r", " ")


def _doc_class_label(doc_class: str) -> str:
    """The German label for a doc_class key, or the key when it has none.

    Imported here rather than at module scope: ``aiq_agent.knowledge`` pulls in
    the retriever factory, and this module is on the import path of the tool
    tier that must load without it.
    """
    from aiq_agent.knowledge.document_classification import DOCUMENT_CLASS_LABELS

    return DOCUMENT_CLASS_LABELS.get(doc_class, doc_class)


# ---------------------------------------------------------------------------
# Per-turn capture (ContextVar), keyed by the rendered bytes
# ---------------------------------------------------------------------------
#
# Modelled on ``turn_status`` lane capture: one mutable container set once per
# turn, mutated by whichever task renders a block. LangGraph builds every node
# task with ``copy_context()``, so a container swapped in mid-turn would not
# reach the tools node. The container is set at the top of the run and only
# ever mutated.
#
# NAT's tool wrapper is the reason the records travel this way rather than on
# ``ToolMessage.artifact``: it rebuilds the message from the string a tool
# returned and drops the artifact, so a structured payload put there never
# reaches the middleware. See docs/contributing/gotchas.md.

#: How many blocks one turn may hold. A turn runs a bounded number of retrieval
#: rounds; the cap is what keeps a runaway loop from holding every result set
#: it ever rendered. The oldest entry goes first, which is the one least likely
#: to still be looked up.
_MAX_CAPTURED_BLOCKS = 64

_captured_blocks: ContextVar[OrderedDict[str, GroundingBlock] | None] = ContextVar(
    "grid_captured_grounding_blocks", default=None
)


def begin_grounding_capture() -> Token:
    """Start filing this turn's rendered blocks. Pair with :func:`end_grounding_capture`."""
    return _captured_blocks.set(OrderedDict())


def end_grounding_capture(token: Token) -> None:
    """Stop filing blocks, and drop the ones this turn filed."""
    _captured_blocks.reset(token)


def _fingerprint(rendered_text: str) -> str:
    """The key a block is filed and found under: a hash of its exact bytes."""
    return hashlib.sha256(rendered_text.encode("utf-8")).hexdigest()


def record_grounding_block(block: GroundingBlock, rendered_text: str) -> None:
    """File ``block`` under its rendering. No-op when nothing is capturing.

    Best-effort by contract, like the lane capture it is modelled on: a tool
    result must not fail because its records could not be filed. The reader
    falls back to parsing the text, which is what it did before this existed.
    """
    try:
        captured = _captured_blocks.get()
        if captured is None:
            return
        captured[_fingerprint(rendered_text)] = block
        while len(captured) > _MAX_CAPTURED_BLOCKS:
            captured.popitem(last=False)
    except Exception:  # noqa: BLE001 (filing must never take a turn down)
        logger.debug("Grounding block not recorded", exc_info=True)


def get_grounding_block(rendered_text: str) -> GroundingBlock | None:
    """The records behind this exact text, or ``None``.

    ``None`` is the ordinary answer outside a live turn, for a replayed message,
    a cached registry or the job runner, and for text a producer decorated after
    rendering. The caller parses the text in that case.
    """
    captured = _captured_blocks.get()
    if not captured:
        return None
    return captured.get(_fingerprint(rendered_text))
