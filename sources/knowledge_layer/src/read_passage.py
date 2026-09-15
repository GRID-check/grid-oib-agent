"""NAT function for opening a NAMED passage: the locator beside the search.

`knowledge_search` is the only way this agent could reach a passage, and it is
a semantic search. So a second round that already knows what it wants — "the
Herleitung concluded that OIB-Richtlinie 2 Pkt. 3.5.2 decides this, and I have
not read it" — had to ask the corpus to *find* that passage again, by
similarity, competing with every neighbouring requirement. The model paid one
more search, one more reranker pass and one more requery judge for a lookup it
could already address.

This tool is that lookup. Given a document the inventory knows and a Punkt or a
page, it fetches exactly the chunks carrying that Punkt (``punkt_id``, the
identifier the Punkt chunker verified against the corpus's own contents pages)
or that page, and returns them in the SAME grounding block ``knowledge_search``
returns — same ``Citation:`` keys, same ``Punkt:`` line, same ``## Trace-Lanes``
fan-out under the same round stamp. Everything downstream (citation
verification, the Herleitung spine, the source registry) therefore treats a
located passage exactly as it treats a searched one, which is the point: this
adds a way to REACH evidence, not a second kind of evidence.

Three properties are load-bearing, and they hold for the same lookup one
granularity up: ``document=`` with neither Punkt nor page is the OUTLINE, which
answers "what is in this document at all?" with the document's opening passage
plus a ``## Gliederung`` of its top-level Punkte. That question has no Punkt and
no page to name, and refusing it sent the model to a search that returns cover
pages and then to a Punkt number it had guessed.

**It never guesses a document.** The name is resolved against the documents
registered for the collections this turn may read — exact file name, stored
display title, or the derived OIB title — and an unresolved name is refused
with the two ways to recover plus up to three verbatim guesses from this
turn's inventory when anything is close. A locator that fuzzy-matches is a
search with worse recall and a confident label.

**It is deterministic.** No reranker, no requery judge, no LLM. The metadata
filter admits only the chunks of the named document that carry the named Punkt
or page, so the SET is whatever is stored; the order is by page and then Punkt
and then chunk id, which is stable across calls rather than across editions.
(The corpus stores no ordinal within a Punkt: the 11 Punkte of 946 long enough
for ``SentenceSplitter`` to cut carry only the parent's metadata on each piece.
Chunk id is the tie-break because it is stable, not because it is the reading
order.)

**It costs one call.** ``knowledge_search`` fans out across every collection in
scope, drafts, reranks and may re-query; this issues one filtered fetch per
collection the named document actually lives in — normally exactly one. It is
still charged to the research budget, because it reads evidence and the budget
is what bounds evidence-gathering; it is simply the cheapest thing that budget
can buy.

Scope and exclusions are NOT restated here: the tool reads them off the
``knowledge_search`` instance it is configured against
(:class:`~knowledge_layer.register.KnowledgeRetrievalConfig`), so the two can
never drift into reading different corpora.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from pydantic import Field

from nat.builder.builder import Builder
from nat.builder.context import Context
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.component_ref import FunctionRef
from nat.data_models.function import FunctionBaseConfig

logger = logging.getLogger(__name__)

#: How many chunks one locator fetch may return per collection.
#:
#: A Punkt is one chunk in 935 of the corpus's 946 cases and at most a handful
#: in the rest (``llamaindex/punkt_chunking``), and a page of a Richtlinie holds
#: a few. The number is a guard against a pathological document rather than a
#: relevance budget: the metadata filter has already decided WHICH chunks exist,
#: so this only bounds how many of them travel.
_MAX_PASSAGE_CHUNKS = 12

#: How many chunks one OUTLINE fetch may return per collection.
#:
#: Larger than the passage bound because the set is the whole top of a
#: document: OIB 2 carries ~214 Punkte, far fewer of them at depth 1 or 2, and a
#: long Punkt may arrive as several chunks that share one ``punkt_id``. Still a
#: guard rather than a relevance budget — the metadata filter has already
#: decided WHICH chunks exist.
_MAX_OUTLINE_CHUNKS = 160

#: How many Gliederung lines the outline may print before it says how many more
#: exist. Headings are not rendered as passages (a heading is not evidence), so
#: 80 lines is roughly one search result in tokens.
_MAX_OUTLINE_LINES = 80

#: The pages that stand in for an outline in a document with no Punkte at all
#: (project uploads, Begriffsbestimmungen): its opening, as passages. Strings,
#: because ``page_label`` is stored as one — see :func:`_passage_filters`.
_OUTLINE_PAGES = ("1", "2", "3")

# Agent-facing contract. Anthropic: the description IS the prompt — when to
# call, when not to, and what a miss means. Deliberately paired with
# `_KNOWLEDGE_SEARCH_DESCRIPTION`: each names the other as the wrong tool.
_READ_PASSAGE_DESCRIPTION = (
    "Open a document you can already NAME: `document=` alone returns its OUTLINE — the "
    "document's opening passage plus a Gliederung of its top-level Punkte — and `document=` "
    "with `punkt=` or `page=` returns exactly that passage. "
    "Deterministic lookup, not a search — no ranking, no second guess at your wording. "
    "Returns the same quotable excerpts with a Citation key that `knowledge_search` returns.\n"
    "WHEN TO CALL — you know WHICH document and want to know what it covers ('worum geht es "
    "in der OIB 2?', 'was regelt das Brandschutzkonzept?'): pass `document=` alone and read "
    "the Gliederung, rather than guessing a Punkt number that may not exist. Or your own "
    "conclusion named a document and a Punkt (or a page) you have not read this turn: a hit's "
    "`Punkt:` line pointed at a neighbouring requirement, a Richtlinie cross-refers ('siehe "
    "Pkt. 3.5.2'), or the user named chapter and verse. "
    "Pass `document=` the exact name or display title as the inventory or a previous hit "
    "printed it (e.g. 'OIB-Richtlinie 2, Ausgabe Mai 2023' or 'oib-rl_2_ausgabe_mai_2023.pdf'), "
    "and `punkt=` the number alone ('3.5.2', no 'Pkt.') or `page=` the page number. "
    "Both together read that Punkt on that page.\n"
    "ALWAYS pass `conclusion=` — one sentence saying what you now know and what you still "
    "need, which is why you are opening THIS passage. It is the Herleitung checkpoint the "
    "reader sees above the fetch; it changes nothing about what is opened and never appears "
    "in `answer`.\n"
    "WHEN NOT TO CALL — you do not know WHICH document holds the answer, or you have only a "
    "topic: that is `knowledge_search`, and this tool cannot search for you. To put a file "
    "on screen it is `surface_documents`. Do not call it twice for the same Punkt, and do not "
    "ask a second time for an outline you already have.\n"
    "RETURNS — with `punkt=` or `page=`, the passages under that Punkt or page, in document "
    "order. With neither, the document's opening passage plus a `## Gliederung` listing its "
    "Punkte with their pages: that list is an index, not evidence — only the passages carry a "
    "Citation, and a listed Punkt is read by calling again with `punkt=`. Every passage "
    "carries Source, Citation (copy verbatim), Dokumentart, Punkt and page. An unknown "
    "document name is REFUSED with up to three verbatim guesses from this turn's readable "
    "inventory when anything is close (labelled as guesses — pass one back exactly, or "
    "resolve the name with `knowledge_search` first) rather than inventing one."
)


class ReadPassageConfig(FunctionBaseConfig, name="read_passage"):
    """Configuration for the ``read_passage`` locator.

    One field, on purpose. Which collections a turn may read, which base corpus
    it points at and which files are excluded are the SEARCH's contract; this
    tool reads the same index through the same scope and so reads them off the
    ``knowledge_search`` instance rather than restating them, which is the only
    way the two cannot end up pointed at different corpora.
    """

    knowledge_search: FunctionRef = Field(
        default=FunctionRef("knowledge_search"),
        description=(
            "The `knowledge_retrieval` function instance whose collection scope, base "
            "corpus and file exclusions this locator shares."
        ),
    )


@dataclass(frozen=True)
class PassageTarget:
    """One resolved (collection, document) the locator will fetch from."""

    collection: str
    file_name: str
    shelf: str | None


def _document_names(document: Any) -> list[str]:
    """Every name an :class:`AvailableDocument` can honestly be called by.

    The indexed file name, the stored display title (admin-editable, the source
    of truth for what a reader sees) and the derived OIB title, which is what a
    citation chip printed and therefore what a conclusion is likely to name.
    """
    names = [str(getattr(document, "file_name", "") or "")]
    stored = getattr(document, "display_title", None)
    if stored:
        names.append(str(stored))
    try:
        from aiq_agent.common.norm_registry import guess_display_title

        derived = guess_display_title(names[0])
    except Exception:  # noqa: BLE001 — a missing title helper must not hide the file name
        derived = None
    if derived:
        names.append(derived)
    return [name for name in names if name.strip()]


def _matches(document: Any, wanted: str) -> bool:
    """Whether ``wanted`` IS one of this document's names.

    Exact, up to case and surrounding whitespace, and nothing else. A locator
    that accepts a substring is a search with one candidate and no ranking:
    "OIB-Richtlinie 2" would silently open "OIB-Richtlinie 2.3".
    """
    return any(name.strip().casefold() == wanted for name in _document_names(document))


async def _documents_in(collection: str) -> list[Any]:
    """The documents registered for one collection; empty on any store error."""
    from aiq_agent.knowledge.factory import get_available_documents_async

    try:
        return await get_available_documents_async(collection)
    except Exception:  # noqa: BLE001 — one unreachable collection must not refuse the rest
        logger.warning("read_passage: document listing failed for %s", collection, exc_info=True)
        return []


async def _resolve_targets(entries: list[Any], document: str) -> list[PassageTarget]:
    """Every (collection, file) in scope whose document IS ``document``.

    Usually one. More than one is the ambiguous-filename case a search already
    handles: the same name on two shelves is two documents, and both are read so
    the formatter can qualify their citation keys rather than this tool picking
    a shelf the caller did not name.
    """
    wanted = document.strip().casefold()
    if not wanted:
        return []
    listings = await asyncio.gather(*(_documents_in(entry.collection) for entry in entries))
    targets: list[PassageTarget] = []
    for entry, docs in zip(entries, listings, strict=True):
        shelf = getattr(entry, "shelf", None)
        for candidate in docs:
            if not _matches(candidate, wanted):
                continue
            targets.append(
                PassageTarget(
                    collection=entry.collection,
                    file_name=str(getattr(candidate, "file_name", "")),
                    shelf=str(shelf) if shelf is not None else None,
                )
            )
    return targets


def _passage_filters(file_name: str, punkt: str | None, page: int | None) -> dict[str, Any]:
    """The metadata filter that admits exactly the requested chunks.

    ``page_label`` is stored as a STRING by every writer in the ingest path
    (``text_documents_for_pages``, the Punkt chunker, the table and image
    branches), so the page clause compares strings; comparing an int here
    matches nothing and looks like an empty document.
    """
    clauses: list[dict[str, Any]] = [{"file_name": {"$eq": file_name}}]
    if punkt:
        clauses.append({"punkt_id": {"$eq": punkt}})
    if page is not None:
        clauses.append({"page_label": {"$eq": str(page)}})
    if len(clauses) == 1:
        return clauses[0]
    return {"$and": clauses}


def _outline_filters(file_name: str) -> dict[str, Any]:
    """The metadata filter that admits a document's top-level structure.

    Punkt ``0`` (``Vorbemerkungen``, the passage that says what the Richtlinie
    is for) plus everything at depth 1 or 2 — the headings a reader would scan
    a contents page for. ``punkt_depth`` is stored as an int by the Punkt
    chunker, so the clause compares ints; the Python re-check below accepts
    either spelling, because a backend that round-trips metadata through JSON
    may hand the depth back as a string.
    """
    return {
        "$and": [
            {"file_name": {"$eq": file_name}},
            {"$or": [{"punkt_id": {"$eq": "0"}}, {"punkt_depth": {"$in": [1, 2]}}]},
        ]
    }


def _first_pages_filters(file_name: str) -> dict[str, Any]:
    """The fallback outline: the opening pages of a document with no Punkte."""
    return {"$and": [{"file_name": {"$eq": file_name}}, {"page_label": {"$in": list(_OUTLINE_PAGES)}}]}


def _addresses(chunk: Any, punkt: str | None, page: int | None) -> bool:
    """Whether this chunk really IS the passage that was addressed.

    The metadata filter above is the store's job and the store does it — but
    "the store applies the filter" is a contract, and one backend
    (``foundational_rag``) reaches its index through an HTTP service that may
    honour a narrower set of clauses than the LlamaIndex path translates. A
    locator whose guarantee rests on a remote service's filter support is a
    locator that silently returns the NEIGHBOURING requirement, which the model
    then cites under the number it asked for. Cheap to re-check here; the whole
    point of the tool is that the number is right.
    """
    metadata = getattr(chunk, "metadata", None) or {}
    if punkt and str(metadata.get("punkt_id") or "") != punkt:
        return False
    if page is not None and str(metadata.get("page_label") or getattr(chunk, "page_number", "")) != str(page):
        return False
    return True


def _punkt_number(raw: str) -> tuple[int, ...]:
    """``"3.10"`` -> ``(3, 10)``; empty for anything that is not a Punkt number.

    The numeric form is what puts 3.10 after 3.9, which a string sort gets
    backwards — the outline reads as wrongly as a passage list would.
    """
    try:
        return tuple(int(part) for part in raw.split(".")) if raw else ()
    except ValueError:
        return ()


def _punkt_of(chunk: Any) -> str:
    """The ``punkt_id`` this chunk carries, or ``""``."""
    return str((getattr(chunk, "metadata", None) or {}).get("punkt_id") or "")


def _punkt_sort_key(chunk: Any) -> tuple:
    """Page, then Punkt numerically, then chunk id: stable across calls."""
    raw = _punkt_of(chunk)
    return (getattr(chunk, "page_number", None) or 0, _punkt_number(raw), raw, str(getattr(chunk, "chunk_id", "")))


def _punkt_depth(chunk: Any) -> int | None:
    """``punkt_depth`` as an int — ``None`` when absent or not a number.

    Accepts the int the chunker writes and the string a backend that
    round-trips metadata through JSON may hand back, because the depth decides
    whether a chunk belongs in the outline at all.
    """
    raw = (getattr(chunk, "metadata", None) or {}).get("punkt_depth")
    if isinstance(raw, bool) or raw is None:
        return None
    try:
        return int(str(raw).strip())
    except ValueError:
        return None


def _is_outline_chunk(chunk: Any) -> bool:
    """Whether this chunk really IS part of the outline that was asked for.

    The same re-check :func:`_addresses` does, for the same reason: the store
    applies the filter, but one backend reaches its index through an HTTP
    service that may honour a narrower set of clauses, and an outline that
    silently listed every depth-3 sub-Punkt would be a contents page nobody
    can read.
    """
    return _punkt_of(chunk) == "0" or _punkt_depth(chunk) in (1, 2)


def _on_first_pages(chunk: Any) -> bool:
    """Whether this chunk is on one of the opening pages the fallback fetched."""
    metadata = getattr(chunk, "metadata", None) or {}
    label = str(metadata.get("page_label") or getattr(chunk, "page_number", "") or "")
    return label in _OUTLINE_PAGES


@dataclass(frozen=True)
class OutlineEntry:
    """One line of the Gliederung: a Punkt the reader can ask to have opened."""

    punkt_id: str
    title: str
    page: str
    depth: int


def _outline_entries(chunks: Sequence[Any]) -> list[OutlineEntry]:
    """One entry per distinct Punkt at depth 1 or 2, ordered by the NUMBERING.

    Deduped by ``punkt_id``: a Punkt long enough for ``SentenceSplitter`` to cut
    arrives as several chunks carrying the same id, and listing it twice would
    read as two Punkte.

    Ordered by :func:`_punkt_number` alone, NOT by ``_punkt_sort_key`` — an
    outline is an index of the document's own numbering, and 2.2 belongs under 2
    even if its stored ``page_label`` ran ahead of 3's. The passage path keeps
    the page-first key, because there the page is what the reader is being
    walked through.
    """
    entries: dict[str, OutlineEntry] = {}
    for chunk in sorted(chunks, key=_punkt_sort_key):
        metadata = getattr(chunk, "metadata", None) or {}
        punkt_id = _punkt_of(chunk)
        depth = _punkt_depth(chunk)
        if depth not in (1, 2) or not punkt_id or punkt_id in entries:
            continue
        entries[punkt_id] = OutlineEntry(
            punkt_id=punkt_id,
            title=str(metadata.get("punkt_title") or "").strip(),
            page=str(metadata.get("page_label") or getattr(chunk, "page_number", "") or ""),
            depth=depth,
        )
    return sorted(entries.values(), key=lambda entry: (_punkt_number(entry.punkt_id), entry.punkt_id))


def _scope_chunks(chunks: Sequence[Any]) -> list[Any]:
    """The chunks that ARE the passage of an outline: the document's scope.

    Punkt ``0`` (``Vorbemerkungen``) when the document has one, otherwise the
    lowest-numbered depth-1 Punkt, and failing both the first chunk in reading
    order — so an outline always carries at least one citable passage. An
    outline whose only evidence was a heading list would be a source a citation
    cannot resolve to.
    """
    ordered = sorted(chunks, key=_punkt_sort_key)
    zero = [chunk for chunk in ordered if _punkt_of(chunk) == "0"]
    if zero:
        return zero
    top = [chunk for chunk in ordered if _punkt_depth(chunk) == 1]
    if not top:
        return ordered[:1]
    first = min((_punkt_number(_punkt_of(chunk)), _punkt_of(chunk)) for chunk in top)[1]
    return [chunk for chunk in top if _punkt_of(chunk) == first]


def _outline_lines(entries: Sequence[OutlineEntry]) -> list[str]:
    """The Gliederung itself: one line per Punkt, depth 2 indented under depth 1."""
    shown = list(entries)[:_MAX_OUTLINE_LINES]
    lines = []
    for entry in shown:
        indent = "  " if entry.depth == 2 else ""
        title = f": {entry.title}" if entry.title else ""
        page = f" (S. {entry.page})" if entry.page else ""
        lines.append(f"{indent}- Punkt {entry.punkt_id}{title}{page}")
    remaining = len(entries) - len(shown)
    if remaining > 0:
        lines.append(f"(+{remaining} weitere Punkte nicht gelistet)")
    return lines


#: The one line that says what the Gliederung is and what it is not. German,
#: because it is read by the same model that writes the German answer, and it
#: has to be unmistakable that a heading is not a source.
_OUTLINE_INSTRUCTION = (
    "Einen gelisteten Punkt öffnest du mit `read_passage(document=…, punkt=…)`; die "
    "Gliederung ist ein Index, keine Evidenz — nur die Passage(n) oben tragen eine Citation."
)

#: The same sentence for a document that has no Punkte to list.
_NO_PUNKTE_LINE = (
    "Dieses Dokument ist nicht nach Punkten gegliedert, es gibt also keine Gliederung — oben "
    "stehen seine ersten Seiten; weitere Seiten öffnest du mit `read_passage(document=…, page=…)`."
)


def _gliederung_block(entries: Sequence[OutlineEntry]) -> str:
    """The ``## Gliederung`` index appended under the outline's passage."""
    return "\n".join(["## Gliederung", *_outline_lines(entries), "", _OUTLINE_INSTRUCTION, ""])


def _locus_label(document: str, punkt: str | None, page: int | None) -> str:
    """How this fetch names itself in a message the model reads."""
    parts = [document]
    if punkt:
        parts.append(f"Pkt. {punkt}")
    if page is not None:
        parts.append(f"S. {page}")
    return ", ".join(parts)


#: How many verbatim guesses an unknown-document refusal may name.
_MAX_DID_YOU_MEAN = 3

#: Minimum similarity (difflib ratio over case-folded names) for a guess to be
#: named. Below this the closest inventory title is noise rather than help,
#: and the refusal stands on the two recovery ways alone. 0.6 is the stdlib
#: ``get_close_matches`` default: 0.4 let cross-document titles with a shared
#: suffix ("Plan.pdf" vs "Brandschutzkonzept.pdf" at 0.40) spend a guess the
#: caller cannot use.
_DID_YOU_MEAN_CUTOFF = 0.6


def _suggestion_names(wanted: str, documents: list[Any], *, limit: int = _MAX_DID_YOU_MEAN) -> list[str]:
    """Up to ``limit`` legal inventory names closest to ``wanted``, most similar first.

    One suggestion per document — the closest of its legal names
    (:func:`_document_names`), so a mistyped display title still finds its file
    without one document spending two of the three guesses. Each suggestion is
    returned in its ORIGINAL spelling, which passes :func:`_matches` verbatim:
    a guess the caller cannot pass back exactly is a second way to be refused.
    Scope-restricted by construction: only the documents the caller passes in
    (this turn's readable inventory) are ranked, so a same-named file on an
    unreadable shelf is never suggested.
    """
    import difflib

    folded = (wanted or "").strip().casefold()
    if not folded:
        return []
    scored: list[tuple[float, str]] = []
    for document in documents or ():
        best_name = ""
        best_ratio = 0.0
        for name in _document_names(document):
            candidate = name.strip()
            if not candidate:
                continue
            ratio = difflib.SequenceMatcher(None, folded, candidate.casefold()).ratio()
            if ratio > best_ratio:
                best_name, best_ratio = candidate, ratio
        if best_name and best_ratio >= _DID_YOU_MEAN_CUTOFF:
            scored.append((best_ratio, best_name))
    scored.sort(key=lambda item: (-item[0], item[1]))
    return [name for _ratio, name in scored[:limit]]


def _unknown_document_message(document: str, known: int, suggestions: Sequence[str] | None = None) -> str:
    """Refuse a name nothing in scope carries, and say how to recover it.

    Never a dead end: with no readable documents the refusal points at the
    inventory (which is empty) and the topic search; with readable documents
    it names how to take a name from a hit or the inventory. When more
    candidates clear the bar than fit, the refusal shows the first three and
    names how many more exist, so the model refines the name instead of
    retyping the same near-miss.
    """
    names = [name for name in (suggestions or []) if str(name).strip()]
    shown = names[:_MAX_DID_YOU_MEAN]
    remaining = len(names) - len(shown)
    if known <= 0:
        base = (
            f"No document in scope is named {document!r}. No documents are readable this turn — "
            "the inventory is empty. Check the knowledge-base inventory (`surface_documents`) for "
            "what is filed, or call `knowledge_search` with the topic when you do not yet know "
            "which document holds it. Do not invent a citation."
        )
    else:
        base = (
            f"No document in scope is named {document!r}. This tool never guesses a name: it opens "
            "the document you name or nothing.\n"
            f"{known} document(s) are readable this turn. Take the name from a hit's `Source:` or "
            "`Citation:` line, or from the knowledge-base inventory, and call again — or call "
            "`knowledge_search` with the topic when you do not yet know which document holds it. "
            "Do not invent a citation."
        )
    if not shown:
        return base
    guesses = "\n".join(f"- {name}" for name in shown)
    message = (
        base + "\nDid you mean (guesses — pass one back verbatim as `document=` if it is the file "
        "you want, do not modify it):\n" + guesses
    )
    if remaining > 0:
        message += f"\n(+{remaining} more candidate(s) not shown — refine the name to narrow it down.)"
    return message


def _no_passage_message(document: str, punkt: str | None, page: int | None) -> str:
    """A resolved document that carries no such Punkt or page."""
    asked = _locus_label(document, punkt, page)
    hint = (
        "The Punkt must be the number alone as the hit's `Punkt:` line prints it ('3.5.2'), and "
        "a parent heading is not a chunk of its own — read the child Punkt instead. "
        if punkt
        else ""
    )
    return (
        f"{document} carries no passage at {asked}. "
        + hint
        + "Search the topic with `knowledge_search` rather than citing a Punkt you could not open."
    )


def _empty_document_message(document: str) -> str:
    """A resolved document the store returned nothing at all for."""
    return (
        f"{document} is registered but no passage of it could be read — the store holds no "
        "chunk of this document. Search the topic with `knowledge_search` rather than citing a "
        "document you could not open."
    )


def _store_silent_message(query: str) -> str:
    """Every fetch for this locus raised. Not an empty document; an unanswered store."""
    return (
        f"Could not read {query}: the knowledge store did not answer. Retry once; if it "
        "fails again, say so and do not invent a citation."
    )


def _fetch_query(document: str, punkt: str | None, page: int | None) -> str:
    """The probe text handed to the store.

    The filter has already decided which chunks exist, so this only orders a set
    the caller is taking whole — it is never a search. It still names the locus
    rather than being empty, because an empty string embeds to nothing useful and
    some stores refuse it.
    """
    return _locus_label(document, punkt, page)


@register_function(config_type=ReadPassageConfig)
async def read_passage(config: ReadPassageConfig, _builder: Builder):
    """Open a named passage of a named document, or its outline. Deterministic; no LLM."""
    from .register import _resolve_base_collection
    from .register import _resolve_scoped_collections
    from .register import _restrict_scope_to_turn

    search_config = _builder.get_function_config(config.knowledge_search)

    async def _fetch(target: PassageTarget, filters: dict[str, Any], query: str, top_k: int) -> list[Any]:
        from aiq_agent.knowledge.factory import get_active_retriever

        retriever = get_active_retriever()
        result = await retriever.retrieve(
            query=query,
            collection_name=target.collection,
            top_k=top_k,
            filters=filters,
        )
        chunks = list(getattr(result, "chunks", None) or [])
        # Same stamping the search's per-collection fan-out does: this is the
        # last point at which the stratum is known for free, and nothing
        # downstream may recover a shelf from a collection id (ADR-0047).
        for chunk in chunks:
            chunk.metadata.setdefault("collection", target.collection)
            if target.shelf:
                chunk.metadata.setdefault("shelf", target.shelf)
        return chunks

    async def _fetch_all(
        targets: list[PassageTarget], filters_for, query: str, top_k: int
    ) -> tuple[list[Any], list[BaseException]]:
        """One filtered fetch per target, gathered. Failures are returned, not raised:
        one unreachable collection must not refuse the document that did answer."""
        fetched = await asyncio.gather(
            *(_fetch(target, filters_for(target.file_name), query, top_k) for target in targets),
            return_exceptions=True,
        )
        chunks = [chunk for group in fetched if not isinstance(group, BaseException) for chunk in group]
        return chunks, [group for group in fetched if isinstance(group, BaseException)]

    async def _resolve_or_refuse(document: str) -> tuple[list[PassageTarget], str]:
        """The (collection, file) targets this name resolves to, or the refusal."""
        entries = _restrict_scope_to_turn(
            _resolve_scoped_collections(search_config, _session_collection(), _resolve_base_collection(search_config))
        )
        targets = await _resolve_targets(entries, document)
        if targets:
            return targets, ""
        listings = await asyncio.gather(*(_documents_in(entry.collection) for entry in entries))
        known = sum(len(docs) for docs in listings)
        scoped = [doc for docs in listings for doc in docs]
        # Full candidate list: the message shows the first three and names
        # how many more clear the bar, so truncating never hides the count.
        return [], _unknown_document_message(document, known, _suggestion_names(document, scoped, limit=1000))

    async def _read(document: str, punkt: str | None = None, page: int | None = None, conclusion: str = "") -> str:
        """Open a document you can name: one Punkt or page of it, or its outline.

        With neither `punkt` nor `page`, the document's OUTLINE is returned: its
        opening passage plus a `## Gliederung` of its top-level Punkte with
        their pages. That is what to call when you know the document but not yet
        which Punkt holds the answer — never guess a Punkt number.

        Args:
            document (str): The document's exact indexed file name or display
                title, as the inventory or a previous hit printed it. Never
                invented, never a fragment.
            punkt (str | None): Optional. The Punkt number alone, e.g. "3.5.2" —
                no "Pkt.", no title. Omit it, and `page`, for the outline.
            page (int | None): Optional. The page number, 1-based. May be
                combined with `punkt` to read that Punkt on that page. Omit it,
                and `punkt`, for the outline.
            conclusion (str): ONE sentence: what you now know and what you
                still need, which is why you are opening this passage. It is
                the Herleitung checkpoint the reader sees above this fetch; it
                does not change what is opened and does not belong in your
                answer.

        Returns:
            str: The passages, in the same grounding-block format
            `knowledge_search` returns, with Citation keys to copy verbatim —
            followed by the Gliederung when no Punkt and no page was named.
        """
        # `conclusion` is unread here on purpose — see the note in
        # `register.search`. It is a checkpoint channel read off the tool CALL,
        # never an input to what gets opened.
        document = (document or "").strip()
        punkt = (punkt or "").strip().strip(".") or None
        if not document:
            return (
                "Provide `document=` the exact name or display title of the document to open "
                "(from the inventory or a previous hit). To find out WHICH document holds a "
                "fact, call `knowledge_search` instead."
            )
        if punkt is None and page is None:
            return await _outline(document)
        return await _open(document, punkt, page)

    async def _open(document: str, punkt: str | None, page: int | None) -> str:
        from .register import _format_results

        targets, refusal = await _resolve_or_refuse(document)
        if refusal:
            return refusal

        query = _fetch_query(document, punkt, page)
        fetched, failures = await _fetch_all(
            targets, lambda file_name: _passage_filters(file_name, punkt, page), query, _MAX_PASSAGE_CHUNKS
        )
        chunks = [chunk for chunk in fetched if _addresses(chunk, punkt, page)]
        if failures and not chunks:
            logger.warning("read_passage: every fetch failed for %r", query, exc_info=failures[0])
            return _store_silent_message(query)
        if not chunks:
            return _no_passage_message(document, punkt, page)

        chunks.sort(key=_punkt_sort_key)
        merged = _passage_result(chunks[:_MAX_PASSAGE_CHUNKS], query)
        formatted = await asyncio.to_thread(_format_results, merged, query)
        logger.info("read_passage: %s returned %d chunk(s)", query, len(merged.chunks))
        return formatted

    async def _outline(document: str) -> str:
        """The same lookup at document granularity: scope passage plus Gliederung."""
        from .register import _format_results

        targets, refusal = await _resolve_or_refuse(document)
        if refusal:
            return refusal

        query = _fetch_query(document, None, None)
        fetched, failures = await _fetch_all(targets, _outline_filters, query, _MAX_OUTLINE_CHUNKS)
        chunks = [chunk for chunk in fetched if _is_outline_chunk(chunk)]
        if not chunks:
            return await _first_pages(document, targets, query, failures)

        entries = _outline_entries(chunks)
        passages = _scope_chunks(chunks)[:_MAX_PASSAGE_CHUNKS]
        formatted = await asyncio.to_thread(_format_results, _passage_result(passages, query), query)
        logger.info("read_passage: %s outlined %d Punkt(e)", query, len(entries))
        return formatted + "\n" + _gliederung_block(entries)

    async def _first_pages(
        document: str, targets: list[PassageTarget], query: str, failures: list[BaseException]
    ) -> str:
        """The outline of a document with no Punkt metadata: its opening pages.

        Those chunks ARE the passages — there is no heading structure to index,
        so the block carries no Gliederung and says so in one line.
        """
        from .register import _format_results

        fetched, page_failures = await _fetch_all(targets, _first_pages_filters, query, _MAX_OUTLINE_CHUNKS)
        chunks = [chunk for chunk in fetched if _on_first_pages(chunk)]
        broke = failures + page_failures
        if not chunks and broke:
            logger.warning("read_passage: every outline fetch failed for %r", query, exc_info=broke[0])
            return _store_silent_message(query)
        if not chunks:
            return _empty_document_message(document)

        chunks.sort(key=_punkt_sort_key)
        merged = _passage_result(chunks[:_MAX_PASSAGE_CHUNKS], query)
        formatted = await asyncio.to_thread(_format_results, merged, query)
        logger.info("read_passage: %s outlined %d page chunk(s)", query, len(merged.chunks))
        return formatted + "\n" + _NO_PUNKTE_LINE

    yield FunctionInfo.from_fn(_read, description=_READ_PASSAGE_DESCRIPTION)


def _session_collection() -> str | None:
    """This conversation's own collection, when a NAT context states one."""
    try:
        ctx = Context.get()
        return ctx.conversation_id if ctx else None
    except Exception:  # noqa: BLE001 — no context is a valid standalone run
        return None


def _passage_result(chunks: list[Any], query: str):
    """The located chunks as the ``RetrievalResult`` the formatter expects."""
    from aiq_agent.knowledge.schema import RetrievalResult

    return RetrievalResult(chunks=chunks, query=query, backend="read_passage", success=True)
