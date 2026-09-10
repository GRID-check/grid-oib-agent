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

Three properties are load-bearing:

**It never guesses a document.** The name is resolved against the documents
registered for the collections this turn may read — exact file name, stored
display title, or the derived OIB title — and an unresolved name is refused
with the two ways to recover. A locator that fuzzy-matches is a search with
worse recall and a confident label.

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

# Agent-facing contract. Anthropic: the description IS the prompt — when to
# call, when not to, and what a miss means. Deliberately paired with
# `_KNOWLEDGE_SEARCH_DESCRIPTION`: each names the other as the wrong tool.
_READ_PASSAGE_DESCRIPTION = (
    "Open a passage you can already NAME: one document plus one Punkt or one page. "
    "Deterministic lookup, not a search — no ranking, no second guess at your wording. "
    "Returns the same quotable excerpts with a Citation key that `knowledge_search` returns.\n"
    "WHEN TO CALL — your own conclusion named a document and a Punkt (or a page) you have "
    "not read this turn: a hit's `Punkt:` line pointed at a neighbouring requirement, a "
    "Richtlinie cross-refers ('siehe Pkt. 3.5.2'), or the user named chapter and verse. "
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
    "on screen it is `surface_documents`. Do not call it twice for the same Punkt.\n"
    "RETURNS — the passages under that Punkt or page, in document order, with Source, "
    "Citation (copy verbatim), Dokumentart, Punkt and page. An unknown document name is "
    "REFUSED and names no substitute: resolve the name with `knowledge_search` first rather "
    "than inventing one."
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


def _punkt_sort_key(chunk: Any) -> tuple:
    """Page, then Punkt numerically, then chunk id: stable across calls."""
    metadata = getattr(chunk, "metadata", None) or {}
    raw = str(metadata.get("punkt_id") or "")
    try:
        numbered = tuple(int(part) for part in raw.split(".")) if raw else ()
    except ValueError:
        numbered = ()
    return (getattr(chunk, "page_number", None) or 0, numbered, raw, str(getattr(chunk, "chunk_id", "")))


def _locus_label(document: str, punkt: str | None, page: int | None) -> str:
    """How this fetch names itself in a message the model reads."""
    parts = [document]
    if punkt:
        parts.append(f"Pkt. {punkt}")
    if page is not None:
        parts.append(f"S. {page}")
    return ", ".join(parts)


def _unknown_document_message(document: str, known: int) -> str:
    """Refuse a name nothing in scope carries, and say how to recover it."""
    return (
        f"No document in scope is named {document!r}. This tool never guesses a name: it opens "
        "the document you name or nothing.\n"
        f"{known} document(s) are readable this turn. Take the name from a hit's `Source:` or "
        "`Citation:` line, or from the knowledge-base inventory, and call again — or call "
        "`knowledge_search` with the topic when you do not yet know which document holds it. "
        "Do not invent a citation."
    )


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
    """Open a named passage of a named document. Deterministic; no LLM."""
    from .register import _resolve_base_collection
    from .register import _resolve_scoped_collections
    from .register import _restrict_scope_to_turn

    search_config = _builder.get_function_config(config.knowledge_search)

    async def _fetch(target: PassageTarget, punkt: str | None, page: int | None, query: str) -> list[Any]:
        from aiq_agent.knowledge.factory import get_active_retriever

        retriever = get_active_retriever()
        result = await retriever.retrieve(
            query=query,
            collection_name=target.collection,
            top_k=_MAX_PASSAGE_CHUNKS,
            filters=_passage_filters(target.file_name, punkt, page),
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

    async def _read(document: str, punkt: str | None = None, page: int | None = None, conclusion: str = "") -> str:
        """Open a passage you can name: one document plus one Punkt or one page.

        Args:
            document (str): The document's exact indexed file name or display
                title, as the inventory or a previous hit printed it. Never
                invented, never a fragment.
            punkt (str | None): The Punkt number alone, e.g. "3.5.2" — no
                "Pkt.", no title.
            page (int | None): The page number, 1-based. May be combined with
                `punkt` to read that Punkt on that page.
            conclusion (str): ONE sentence: what you now know and what you
                still need, which is why you are opening this passage. It is
                the Herleitung checkpoint the reader sees above this fetch; it
                does not change what is opened and does not belong in your
                answer.

        Returns:
            str: The passages, in the same grounding-block format
            `knowledge_search` returns, with Citation keys to copy verbatim.
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
            return (
                f"Provide `punkt=` (e.g. '3.5.2') or `page=` to open a passage of {document}. "
                "This tool opens a named passage; to search the document for a topic, call "
                "`knowledge_search` with `file_name=`."
            )
        return await _open(document, punkt, page)

    async def _open(document: str, punkt: str | None, page: int | None) -> str:
        from .register import _format_results

        entries = _restrict_scope_to_turn(
            _resolve_scoped_collections(search_config, _session_collection(), _resolve_base_collection(search_config))
        )
        targets = await _resolve_targets(entries, document)
        if not targets:
            known = sum(len(docs) for docs in await asyncio.gather(*(_documents_in(e.collection) for e in entries)))
            return _unknown_document_message(document, known)

        query = _fetch_query(document, punkt, page)
        fetched = await asyncio.gather(
            *(_fetch(target, punkt, page, query) for target in targets), return_exceptions=True
        )
        chunks = [
            chunk
            for group in fetched
            if not isinstance(group, BaseException)
            for chunk in group
            if _addresses(chunk, punkt, page)
        ]
        failures = [group for group in fetched if isinstance(group, BaseException)]
        if failures and not chunks:
            logger.warning("read_passage: every fetch failed for %r", query, exc_info=failures[0])
            return (
                f"Could not read {query}: the knowledge store did not answer. Retry once; if it "
                "fails again, say so and do not invent a citation."
            )
        if not chunks:
            return _no_passage_message(document, punkt, page)

        chunks.sort(key=_punkt_sort_key)
        merged = _passage_result(chunks[:_MAX_PASSAGE_CHUNKS], query)
        formatted = await asyncio.to_thread(_format_results, merged, query)
        logger.info("read_passage: %s returned %d chunk(s)", query, len(merged.chunks))
        return formatted

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
