"""NAT function for opening a NAMED passage: the locator beside the search.

`knowledge_search` is the only way this agent could reach a passage, and it is
a semantic search. So a second round that already knows what it wants — "the
Herleitung concluded that OIB-Richtlinie 2 Pkt. 3.5.2 decides this, and I have
not read it" — had to ask the corpus to *find* that passage again, by
similarity, competing with every neighbouring requirement. The model paid one
more search, one more reranker pass and one more requery judge for a lookup it
could already address.

This tool is that lookup. Given a document the inventory knows and a Punkt or a
page, it fetches exactly the chunks carrying that Punkt (``clause_id``, the
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
import base64
import binascii
import hashlib
import json
import logging
import re
from collections.abc import Mapping
from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import field
from typing import Any

from pydantic import AliasChoices
from pydantic import BaseModel
from pydantic import ConfigDict
from pydantic import Field

from aiq_agent.common.action_outcome import ActionOutcome
from aiq_agent.common.turn_status import ActionRow
from nat.plugin_api import Builder
from nat.plugin_api import Context
from nat.plugin_api import FunctionBaseConfig
from nat.plugin_api import FunctionInfo
from nat.plugin_api import FunctionRef
from nat.plugin_api import register_function

logger = logging.getLogger(__name__)

#: How many chunks one locator fetch may return per collection.
#:
#: A Punkt is one chunk in 935 of the corpus's 946 cases and at most a handful
#: in the rest (``llamaindex/clause_chunking``), and a page of a Richtlinie holds
#: a few. The number is a guard against a pathological document rather than a
#: relevance budget: the metadata filter has already decided WHICH chunks exist,
#: so this only bounds how many of them travel.
_MAX_PASSAGE_CHUNKS = 12

#: How many chunks one OUTLINE fetch may return per collection.
#:
#: Larger than the passage bound because the set is the whole top of a
#: document: OIB 2 carries ~214 Punkte, far fewer of them at depth 1 or 2, and a
#: long Punkt may arrive as several chunks that share one ``clause_id``. Still a
#: guard rather than a relevance budget — the metadata filter has already
#: decided WHICH chunks exist.
_MAX_OUTLINE_CHUNKS = 160

#: How many pages before the requested one a chunk may start and still reach it.
#:
#: A section or Punkt chunk is filed under the page its text STARTS on
#: (``page_label``) and records where it ends (``page_end``), so page 2 of a
#: report whose section runs from page 1 to 3 is held by a chunk labelled 1.
#: The store cannot compare the stored strings as numbers, so a page read asks
#: for the labels of this window and keeps the chunks whose range covers the
#: page. A chunk is at most ~640 tokens, so it spans more than a page or two
#: only across near-empty pages; eight is a bound, not an estimate.
_PAGE_SPAN_WINDOW = 8

#: The most pages one ranged read may ask for. A 14-page document is read in one round of
#: a few calls; past this the model splits the range, which costs one round whatever it fans out into.
_MAX_RANGE_PAGES = 30

#: How many characters one ranged read returns (about 6k tokens). Past it the read stops at a
#: chunk boundary and ends with a ``cursor`` the model passes back to continue.
_MAX_READ_CHARS = 24_000

#: The longest repeated head :func:`_without_overlap` will cut, in characters. The chunkers overlap
#: neighbours by about 96 tokens; anything much longer is not an overlap but a coincidence.
_MAX_OVERLAP_CHARS = 1_200

#: The shortest repeat worth cutting: a heading or a table header that a neighbouring chunk
#: happens to repeat is the chunk's own text, not overlap.
_MIN_OVERLAP_WORDS = 8
_MIN_OVERLAP_CHARS = 40

#: How many Gliederung lines the outline may print before it says how many more
#: exist. Headings are not rendered as passages (a heading is not evidence), so
#: 80 lines is roughly one search result in tokens.
_MAX_OUTLINE_LINES = 80

# Agent-facing contract: what it does, its inputs, what it returns and where it stops.
_READ_PASSAGE_DESCRIPTION = (
    "Opens a document by name: `document=` alone returns its OUTLINE, the document's opening passage plus a "
    "Gliederung of its top-level Punkte, and `document=` with `clause=` or `page=` returns exactly that passage. "
    "A lookup, not a search: no ranking, and it cannot find a document from a topic (`knowledge_search` does).\n"
    "Inputs: `document`, the exact name or display title as the inventory or a hit printed it "
    "(e.g. 'OIB-Richtlinie 2, Ausgabe Mai 2023' or 'oib-rl_2_ausgabe_mai_2023.pdf'). `clause`, the number alone "
    "('3.5.2', no 'Pkt.') or a table's caption ('Tabelle 3'), or for a project document what a hit's `Punkt:` "
    "line printed ('§ 4', 'Zeilen 2-41'); with `clause=`, `page=` is ignored. `page`, one page number. "
    "`pages`, a range ('4-6', at most 30 pages) in reading order without the overlap between neighbouring "
    "chunks, up to about 6k tokens; a read that stopped early ends with a `cursor` to pass back with the same "
    "`document=`.\n"
    "Returns: the passages, each with Source, Citation (copy verbatim), Dokumentart, Punkt and page. The "
    "Gliederung is an index, not evidence: only passages carry a Citation. An unknown document name is refused, "
    "with up to three labelled guesses from this turn's readable inventory when anything is close.\n"
    "`conclusion=` is optional: one line on what you are looking for; it has no effect on the call."
)


# The arguments of one ``read_passage`` call, as the model sees them. No docstring: pydantic
# would put it in the tool schema the model reads.
#
# ``punkt`` is the argument's former name: accepted for one release so a replayed turn, a
# cached plan or a model that learned the old name still opens its passage. Only ``clause``
# appears in the tool schema. Remove the alias after one release.
class ReadPassageInput(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    document: str
    clause: str | int | None = Field(default=None, validation_alias=AliasChoices("clause", "punkt"))
    page: int | str | None = None
    pages: str | int | None = None
    cursor: str | None = None
    conclusion: str = ""


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
    #: The current Fassung of this document when a PERSON confirmed it replaced, else None.
    current: str | None = None
    #: The message this document came with, when a person filed it from a mail (``mail_facts``).
    mail_origin: Mapping[str, Any] | None = field(default=None, compare=False)


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
        from aiq_agent.common.norm_registry import oib_family_member

        derived = guess_display_title(names[0])
        member = oib_family_member(names[0])
    except Exception:  # noqa: BLE001 — a missing title helper must not hide the file name
        derived = None
        member = None
    if derived:
        names.append(derived)
        # The title without its edition: the head a conclusion names when the
        # edition is not what it is talking about ("OIB-Richtlinie 2.1").
        head = derived.split(",", 1)[0].strip()
        if head and head != derived:
            names.append(head)
    if member:
        # The three spellings the prompt's own family line and the office use
        # for a part of a Richtlinie. Exact names, each — `_matches` still
        # refuses "OIB 2" for OIB 2.1, because the member number is the name.
        names += [f"OIB {member}", f"OIB-RL {member}", f"OIB-Richtlinie {member}"]
    seen: set[str] = set()
    unique: list[str] = []
    for name in names:
        if name.strip() and name.casefold() not in seen:
            seen.add(name.casefold())
            unique.append(name)
    return unique


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
                    current=_current_revision(candidate, docs),
                    mail_origin=getattr(candidate, "mail_origin", None),
                )
            )
    return targets


def _current_revision(document: Any, documents: Sequence[Any]) -> str | None:
    """The file that now stands for ``document`` once a person confirmed it replaced, else ``None``.

    Follows ``superseded_by`` to the end of the chain (B was replaced by C, C by D: D), inside the
    document's own collection and only through rows that still exist. A loop, which the store
    refuses, stops where it closes.
    """
    by_name = {str(getattr(doc, "file_name", "")): doc for doc in documents}
    seen = {str(getattr(document, "file_name", ""))}
    current: str | None = None
    next_name = getattr(document, "superseded_by", None)
    while next_name and next_name in by_name and next_name not in seen:
        current = next_name
        seen.add(next_name)
        next_name = getattr(by_name[next_name], "superseded_by", None)
    return current


def _older_revision_notice(targets: Sequence[PassageTarget]) -> str:
    """The one line that tells the model the document it opened is an older Fassung, and which one is current.

    Rides the grounding block's notice slot, like „Ältere Fassungen ausgeblendet“ in the search, so
    the block's hash still matches the bytes the model reads. A read of an older Fassung is allowed:
    it is what „Index B“ and „die alte Fassung“ ask for. The line only keeps the answer from presenting it
    as the document's current state. A file in a restricted collection nobody admitted is never named.
    """
    from aiq_agent.knowledge.restricted_use import may_name

    older = {(target.file_name, target.current) for target in targets if target.current and may_name(target.collection)}
    if not older:
        return ""
    return "".join(older_revision_line(name, current) for name, current in sorted(older))


def _mail_origin_notice(targets: Sequence[PassageTarget]) -> str:
    """The line that says which mail a document came with, in the words of its Verlauf (ADR-0134).

    So a passage of an attachment is attributed to the message that brought it
    („laut der E-Mail von Ing. Gruber vom 04.05.2026“), and a sender nobody
    confirmed reads as „Domain nicht bestätigt“, never as the domain's owner.
    Rides the notice slot like :func:`_older_revision_notice`; a file of a
    restricted collection nobody admitted is never named.
    """
    from aiq_agent.knowledge.mail_facts import mail_origin_label
    from aiq_agent.knowledge.restricted_use import may_name

    lines = {
        (target.file_name, label)
        for target in targets
        if may_name(target.collection) and (label := mail_origin_label(target.mail_origin))
    }
    return "".join(f"{name} {label}.\n\n" for name, label in sorted(lines))


def _target_notices(targets: Sequence[PassageTarget]) -> str:
    """Every notice about the documents read: an older Fassung first, then the mail it came with."""
    return _older_revision_notice(targets) + _mail_origin_notice(targets)


def older_revision_line(name: str, current: str) -> str:
    """The notice line for one older Fassung a tool hands the model: which file replaced it, and what to say."""
    return (
        f"Ältere Fassung: {name} ist durch {current} ersetzt (bestätigt), aktuell ist {current}. "
        "Sage in der Antwort, dass du die ältere Fassung liest.\n\n"
    )


def _coerce_page(page: Any) -> int | None:
    """Coerce a model-supplied page number to int; ``''`` means omitted (#656).

    The tool schema types ``page`` as int, but providers send ``''`` for
    "no page" and occasionally numeric strings. Pydantic rejects ``''`` with
    ``int_parsing`` before the function runs; accepting ``int | str | None``
    here and normalising keeps that miss a refusal, not a tool error.
    """
    if page is None:
        return None
    if isinstance(page, int):
        return page
    if isinstance(page, float):
        return int(page)
    if isinstance(page, str):
        stripped = page.strip()
        if not stripped:
            return None
        try:
            return int(float(stripped))
        except ValueError:
            return None
    return None


class RangeRefused(ValueError):
    """A ``pages`` or ``cursor`` the tool cannot read; the message is what the model is told, with the call to make."""


_PAGES_PATTERN = re.compile(r"^(?:s\.?|p\.?|pp\.?|seiten?|pages?)?\s*(\d+)\s*(?:(?:-|bis|to)\s*(\d+))?$")


def _parse_pages(raw: Any, document: str = "<document>") -> tuple[int, int] | None:
    """``"4-6"`` as ``(4, 6)``; ``None`` when ``raw`` is empty. Also ``"4"``, ``"4–6"``, ``"4 bis 6"``, ``5``.

    Raises :class:`RangeRefused` for text that is no range, a reversed range (the refusal names the
    corrected call) and one longer than :data:`_MAX_RANGE_PAGES`.
    """
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return None
    text = str(raw).strip().lower().replace("–", "-").replace("—", "-")
    match = _PAGES_PATTERN.match(text)
    if match is None:
        raise RangeRefused(f'`pages` must be a page or a range such as "4-6", not {raw!r}.')
    first = int(match.group(1))
    last = int(match.group(2) or first)
    if first < 1:
        raise RangeRefused("Pages count from 1.")
    if last < first:
        raise RangeRefused(
            f'The range runs backwards. Call read_passage(document="{document}", pages="{last}-{first}").'
        )
    if last - first + 1 > _MAX_RANGE_PAGES:
        raise RangeRefused(
            f"At most {_MAX_RANGE_PAGES} pages per call. Split the range and request the parts in one round, "
            f'for example pages="{first}-{first + _MAX_RANGE_PAGES - 1}" and pages="{first + _MAX_RANGE_PAGES}-{last}".'
        )
    return first, last


#: The two filter families a ranged read can use, recorded in its cursor so a continuation reads the
#: same set: a range on ``reading_order``, or the ``page_label`` strings of a document written before
#: that field existed.
ORDER_FILTERS = "order"
LABEL_FILTERS = "label"
_FILTER_KINDS = (ORDER_FILTERS, LABEL_FILTERS)


@dataclass(frozen=True)
class ReadCursor:
    """Where a ranged read stopped: the last chunk it returned, and the page the whole read ends on.

    ``position`` is that chunk's whole :func:`~aiq_agent.knowledge.base.document_position`, the key the
    chunks are sorted and cut by, so the continuation compares the same key. ``filters`` is the filter
    family the read used (:data:`ORDER_FILTERS` or :data:`LABEL_FILTERS`). ``collection`` is empty when
    the read spanned more than one collection, and the continuation then reads every one it resolves to.
    """

    file_name: str
    collection: str
    position: tuple[int, int, int, int, int, int, str]
    last_page: int | None
    filters: str = ORDER_FILTERS

    @property
    def page(self) -> int:
        return self.position[0]


def _cursor_check(fields: Sequence[Any]) -> str:
    return hashlib.sha256(json.dumps(list(fields), ensure_ascii=False).encode()).hexdigest()[:10]


def encode_cursor(cursor: ReadCursor) -> str:
    """The cursor as an opaque token: URL-safe base64 of a small JSON list with a checksum.

    It names a POSITION in one document and nothing else. The scope a read runs in is never in it:
    the continuation resolves ``document`` against this turn's own scope again and refuses a token
    for another file, so editing the token can move the read within the document but cannot reach
    another one. The checksum is an unkeyed digest that catches a mangled or hand-written token; it
    guards nothing, because nothing in the token can widen the scope.
    """
    fields = [cursor.file_name, cursor.collection, list(cursor.position), cursor.last_page, cursor.filters]
    body = json.dumps([*fields, _cursor_check(fields)], ensure_ascii=False, separators=(",", ":"))
    return base64.urlsafe_b64encode(body.encode()).decode().rstrip("=")


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def decode_cursor(token: str) -> ReadCursor | None:
    """The cursor a token holds, or ``None`` for anything that is not one this tool issued."""
    text = str(token or "").strip()
    try:
        raw = json.loads(base64.urlsafe_b64decode(text + "=" * (-len(text) % 4)))
        *fields, check = raw
        file_name, collection, position, last_page, filters = fields
    except (ValueError, TypeError, binascii.Error):
        return None
    if not isinstance(check, str) or check != _cursor_check(fields):
        return None
    if not (isinstance(file_name, str) and isinstance(collection, str) and filters in _FILTER_KINDS):
        return None
    if not (isinstance(position, list) and len(position) == 7 and isinstance(position[6], str)):
        return None
    if not all(_is_int(number) for number in position[:6]) or position[0] < 1:
        return None
    if last_page is not None and not _is_int(last_page):
        return None
    return ReadCursor(file_name, collection, tuple(position), last_page, filters)  # type: ignore[arg-type]


def _range_filters(file_name: str, first: int, last: int | None, window: int = _PAGE_SPAN_WINDOW) -> dict[str, Any]:
    """Admit the document's chunks whose START page lies in ``[first - window, last]``.

    ``reading_order`` is the start page as an integer, so this is one range on an indexed integer and
    not a list of labels. A chunk that started up to :data:`_PAGE_SPAN_WINDOW` pages before ``first``
    may run onto it; :func:`_meets_range` keeps the ones that do.
    """
    clauses: list[dict[str, Any]] = [
        {"file_name": {"$eq": file_name}},
        {"reading_order": {"$gte": max(1, first - window)}},
    ]
    if last is not None:
        clauses.append({"reading_order": {"$lte": last}})
    return {"$and": clauses}


def _range_label_filters(file_name: str, first: int, last: int, window: int = _PAGE_SPAN_WINDOW) -> dict[str, Any]:
    """The same set by ``page_label`` strings: for a document written before ``reading_order`` existed."""
    labels = [str(number) for number in range(max(1, first - window), last + 1)]
    return {"$and": [{"file_name": {"$eq": file_name}}, {"page_label": {"$in": labels}}]}


def _filters_for(kind: str, first: int, last: int | None, window: int = _PAGE_SPAN_WINDOW):
    """The filter builder of one family; the label family needs an end page, so without one it is the range."""
    if kind == LABEL_FILTERS and last is not None:
        return lambda file_name: _range_label_filters(file_name, first, last, window)
    return lambda file_name: _range_filters(file_name, first, last, window)


def _page_span(chunk: Any) -> tuple[int, int] | None:
    """``(page_label, page_end)`` of a chunk as integers, ``None`` when its label is no page number."""
    metadata = getattr(chunk, "metadata", None) or {}
    label = str(metadata.get("page_label") or getattr(chunk, "page_number", "") or "")
    if not label.isdigit():
        return None
    end = str(metadata.get("page_end") or "")
    return int(label), max(int(end) if end.isdigit() else int(label), int(label))


def _meets_range(chunk: Any, first: int, last: int | None) -> bool:
    """Whether the chunk's pages ``[page_label, page_end]`` meet ``[first, last]``, as :func:`_covers_page` does."""
    span = _page_span(chunk)
    if span is None:
        return False
    return span[1] >= first and (last is None or span[0] <= last)


def _chunk_ordinal(chunk: Any) -> int | None:
    ordinal = (getattr(chunk, "metadata", None) or {}).get("chunk_ordinal")
    return ordinal if isinstance(ordinal, int) and not isinstance(ordinal, bool) else None


def _chunk_position(chunk: Any) -> tuple[int, int, int, int, int, int, str]:
    """The chunk's :func:`~aiq_agent.knowledge.base.document_position`: what ranged reads sort, cut and continue by."""
    from aiq_agent.knowledge.base import document_position

    return document_position(getattr(chunk, "metadata", None), getattr(chunk, "chunk_id", ""))


def _range_order(chunks: Sequence[Any]) -> list[Any]:
    """The chunks in document order: page, the section structure, then place in the file, then chunk id."""
    return sorted(chunks, key=_chunk_position)


def _words_with_offsets(text: str) -> list[tuple[str, int]]:
    return [(match.group(), match.start()) for match in re.finditer(r"\S+", text)]


def _without_overlap(chunks: Sequence[Any]) -> list[Any]:
    """The chunks with each head cut by the words it repeats from the chunk before it.

    The splitter overlaps neighbours by about 96 tokens, so reading a range chunk by chunk delivers
    that text twice. Each chunk's own text stays its own: only a head that equals the END of the
    previous chunk's text (words compared after whitespace normalisation) is cut, only between two text
    chunks of one document that the chunker cut one after the other, only when the repeat is long enough
    not to be a repeated heading, and never when it would leave nothing. The Citation key and page are
    the chunk's own and do not change.
    """
    result: list[Any] = []
    previous: Any = None
    for chunk in chunks:
        trimmed = chunk
        if previous is not None and _neighbours(previous, chunk):
            cut = _repeated_head(previous.content, chunk.content)
            if cut:
                trimmed = chunk.model_copy(update={"content": chunk.content[cut:].lstrip()})
        result.append(trimmed)
        previous = chunk
    return result


def _is_text(chunk: Any) -> bool:
    kind = getattr(chunk, "content_type", None)
    return getattr(kind, "value", kind) in (None, "text")


def _neighbours(previous: Any, chunk: Any) -> bool:
    """Whether ``chunk`` follows ``previous`` as the next cut of one file's text."""
    if not (_is_text(previous) and _is_text(chunk)) or previous.file_name != chunk.file_name:
        return False
    before, after = previous.metadata or {}, chunk.metadata or {}
    if before.get("collection") != after.get("collection") or before.get("chunking") != after.get("chunking"):
        return False
    before_ordinal, after_ordinal = _chunk_ordinal(previous), _chunk_ordinal(chunk)
    # A chunk without an ordinal has no known predecessor: legacy chunks of a page are ordered by id.
    return before_ordinal is not None and after_ordinal is not None and after_ordinal - before_ordinal == 1


def _repeated_head(previous: str, text: str) -> int:
    """How many characters of ``text`` repeat the end of ``previous``; 0 when they do not, or would be all of it.

    Only a repeat that ends within :data:`_MAX_OVERLAP_CHARS` of ``text`` counts, so only the words
    that start there are candidates, and only a count whose first word is ``text``'s first word is
    compared: linear in practice, where trying every count was quadratic in the chunk's words.
    """
    after = _words_with_offsets(text[: _MAX_OVERLAP_CHARS + 1])
    if len(after) <= _MIN_OVERLAP_WORDS:
        return 0
    tail = previous[-(_MAX_OVERLAP_CHARS * 2) :]
    before = [word for word, _ in _words_with_offsets(tail)]
    if len(tail) < len(previous):
        before = before[1:]  # the slice may have cut its first word in two
    words = [word for word, _ in after]
    longest = min(len(before), len(after) - 1)
    for count in range(longest, _MIN_OVERLAP_WORDS - 1, -1):
        if before[-count] != words[0] or before[-count:] != words[:count]:
            continue
        end = after[count][1]
        return end if _MIN_OVERLAP_CHARS <= end <= _MAX_OVERLAP_CHARS else 0
    return 0


def _is_range_text(value: Any) -> bool:
    """Whether a ``page`` argument is really a range (``"4-6"``, ``"4 bis 6"``), which belongs in ``pages``."""
    return (
        isinstance(value, str) and re.search(r"\d\s*(?:-|\u2013|\u2014|bis|to)\s*\d", value, re.IGNORECASE) is not None
    )


def _within_budget(chunks: Sequence[Any], cap: int) -> tuple[list[Any], bool]:
    """The leading chunks whose text fits ``cap`` characters, and whether any were left out.

    The cut falls between two chunks; the cursor names the last kept chunk's whole position
    (:func:`_chunk_position`, a total order), so the continuation starts at the next one. The first
    chunk is always taken, so a read always returns something.
    """
    kept: list[Any] = []
    size = 0
    for chunk in chunks:
        if kept and size + len(chunk.content) > cap:
            return kept, True
        kept.append(chunk)
        size += len(chunk.content)
    return kept, False


def _in_range(chunks: Sequence[Any], first: int, last: int | None, start: tuple[Any, ...] | None) -> list[Any]:
    """The fetched chunks that meet ``[first, last]`` and, on a continuation, come after ``start``."""
    return [
        chunk
        for chunk in chunks
        if _meets_range(chunk, first, last) and (start is None or _chunk_position(chunk) > tuple(start))
    ]


def _next_cursor(kept: Sequence[Any], last_page: int | None, filters: str) -> str:
    """The token that continues a read after the last of ``kept``."""
    last_chunk = kept[-1]
    position = _chunk_position(last_chunk)
    collections = {str((getattr(chunk, "metadata", None) or {}).get("collection") or "") for chunk in kept}
    collection = collections.pop() if len(collections) == 1 else ""
    cursor = ReadCursor(last_chunk.file_name, collection, (max(position[0], 1), *position[1:]), last_page, filters)
    return encode_cursor(cursor)


def _range_trailer(document: str, kept: Sequence[Any], first: int, last: int | None, cursor: str | None) -> str:
    """What a ranged read says about itself: which pages it delivered, what is missing and how to go on."""
    spans = [span for chunk in kept if (span := _page_span(chunk)) is not None]
    reached = max((end for _start, end in spans), default=first)
    upto = reached if last is None else min(reached, last)
    if cursor is not None:
        asked = "" if last is None else f" of the requested {_page_range_text(first, last)}"
        return (
            f"Read pages {_page_range_text(first, max(first, upto))}{asked}; the rest follows. Continue: "
            f"read_passage(document={json.dumps(document, ensure_ascii=False)}, cursor={json.dumps(cursor)}), "
            "or ask for several ranges in one round."
        )
    wanted = range(first, (last if last is not None else upto) + 1)
    covered = {page for start, end in spans for page in range(start, end + 1)}
    blank = [page for page in wanted if page not in covered]
    line = f"Read pages {_page_range_text(first, wanted[-1])}."
    if blank and len(blank) <= 10:
        line += f" No text on page{'s' if len(blank) > 1 else ''} {', '.join(map(str, blank))}."
    return line


def _cursor_refusal(document: str, span: tuple[int, int] | None) -> str:
    """The refusal for a cursor that is not one this tool issued for this document."""
    pages = _page_range_text(*span) if span else "4-6"
    return (
        f"That cursor does not belong to {document} (or is not one this tool issued). "
        f'Start over: read_passage(document={json.dumps(document, ensure_ascii=False)}, pages="{pages}").'
    )


def _passage_filters(file_name: str, clause: str | None, page: int | None) -> dict[str, Any]:
    """The metadata filter that admits exactly the requested chunks.

    ``page_label`` is stored as a STRING by every writer in the ingest path
    (``text_documents_for_pages``, the Punkt chunker, the table and image
    branches), so the page clause compares strings; comparing an int here
    matches nothing and looks like an empty document. A page asks for the
    labels of :data:`_PAGE_SPAN_WINDOW` pages up to it, because a chunk that
    started earlier may run onto it; :func:`_addresses` keeps the ones that do.
    """
    clauses: list[dict[str, Any]] = [{"file_name": {"$eq": file_name}}]
    if clause:
        spellings = _clause_spellings(clause)
        clauses.append({"clause_id": {"$eq": clause} if len(spellings) == 1 else {"$in": spellings}})
    if page is not None:
        clauses.append({"page_label": {"$in": _page_window(page)}})
    if len(clauses) == 1:
        return clauses[0]
    return {"$and": clauses}


#: The two heading levels an outline lists. The Punkt chunker writes
#: ``clause_depth`` as an int and a backend that round-trips metadata through
#: JSON hands it back as a string, so :func:`_outline_filters` asks for both
#: spellings and :func:`_clause_depth` normalises them.
_OUTLINE_DEPTHS = (1, 2)


def _outline_filters(file_name: str) -> dict[str, Any]:
    """The metadata filter that admits a document's top-level structure.

    Punkt ``0`` (``Vorbemerkungen``, the passage that says what the Richtlinie
    is for) plus everything at depth 1 or 2 — the headings a reader would scan
    a contents page for. ``clause_depth`` is stored as an int by the Punkt
    chunker, and a backend that round-trips metadata through JSON may hand it
    back as a string, so the clause asks for BOTH spellings: :func:`_clause_depth`
    accepts either, and a clause that admitted only the int would leave that
    tolerance backing a set the store could never deliver.

    Two homogeneous ``$in`` clauses rather than one mixed list, because
    LlamaIndex's ``MetadataFilter.value`` is typed ``list[int] | list[str] |
    …``: a list holding both spellings fails validation before it reaches any
    store, which would take the outline down on the default backend.
    """
    return {
        "$and": [
            {"file_name": {"$eq": file_name}},
            {
                "$or": [
                    {"clause_id": {"$eq": "0"}},
                    {"clause_depth": {"$in": list(_OUTLINE_DEPTHS)}},
                    {"clause_depth": {"$in": [str(depth) for depth in _OUTLINE_DEPTHS]}},
                ]
            },
        ]
    }


def _whole_document_filters(file_name: str) -> dict[str, Any]:
    """The fallback outline's filter: the named document, nothing narrower.

    It used to narrow to ``page_label $in ("1", "2", "3")``, on the assumption
    that ``page_label`` holds a page number. It does not always: the Office
    extractors write the WORKSHEET NAME there for ``.xlsx``/``.xlsm``
    (``llamaindex/office_extractors``), so an indexed spreadsheet matched no
    chunk at all and the outline told the model the store held none of it.
    The file-name clause and ``_MAX_OUTLINE_CHUNKS`` bound the set; document
    order then decides which ``_MAX_PASSAGE_CHUNKS`` of it are returned, which
    is the opening of a paginated document and the first sheets of a workbook.
    """
    return {"file_name": {"$eq": file_name}}


def _page_window(page: int) -> list[str]:
    """The ``page_label`` values a chunk covering ``page`` can carry, as strings."""
    return [str(number) for number in range(max(1, page - _PAGE_SPAN_WINDOW), page + 1)]


def _clause_spellings(clause: str) -> list[str]:
    """The requested locator and its one normal spelling (``§3`` -> ``§ 3``), which the chunkers write."""
    from knowledge_layer.llamaindex.section_chunking import normalise_locator

    return sorted({clause, normalise_locator(clause)})


def _covers_page(chunk: Any, page: int) -> bool:
    """Whether the chunk's page range ``[page_label, page_end]`` contains ``page``.

    A chunk without a numeric ``page_end`` covers its label only. A label that is
    not a page number (a worksheet name) never matches a page.
    """
    metadata = getattr(chunk, "metadata", None) or {}
    label = str(metadata.get("page_label") or getattr(chunk, "page_number", "") or "")
    if not label.isdigit():
        return False
    end = str(metadata.get("page_end") or "")
    last = int(end) if end.isdigit() else int(label)
    return int(label) <= page <= max(last, int(label))


def _addresses(chunk: Any, clause: str | None, page: int | None) -> bool:
    """Whether this chunk really IS the passage that was addressed.

    The metadata filter above is the store's job and the store does it — but
    "the store applies the filter" is a contract, and a retriever that honours
    a narrower set of clauses than it was sent (a test fake, a regression in
    the filter translation) would otherwise hand back the NEIGHBOURING
    requirement, which the model then cites under the number it asked for.
    Cheap to re-check here; the whole point of the tool is that the number is
    right.
    """
    metadata = getattr(chunk, "metadata", None) or {}
    if clause and str(metadata.get("clause_id") or "") not in _clause_spellings(clause):
        return False
    return page is None or _covers_page(chunk, page)


def _clause_number(raw: str) -> tuple[int, ...]:
    """``"3.10"`` -> ``(3, 10)``; empty for anything that is not a Punkt number.

    The numeric form is what puts 3.10 after 3.9, which a string sort gets
    backwards — the outline reads as wrongly as a passage list would.
    """
    try:
        return tuple(int(part) for part in raw.split(".")) if raw else ()
    except ValueError:
        return ()


def _clause_of(chunk: Any) -> str:
    """The ``clause_id`` this chunk carries, or ``""``."""
    return str((getattr(chunk, "metadata", None) or {}).get("clause_id") or "")


def _clause_sort_key(chunk: Any) -> tuple:
    """Page, then Punkt numerically, then a table's row-group order, then chunk id: stable across calls.

    Every row group of one captioned table shares its page and ``clause_id``
    („Tabelle 1a" has no number to sort on), and the chunk id is a random
    uuid, so without ``table_part`` its "Teil 1 von 5" … "Teil 5 von 5" came
    back shuffled.
    """
    raw = _clause_of(chunk)
    page = getattr(chunk, "page_number", None) or 0
    return (
        page,
        _clause_number(raw),
        _document_order(chunk),
        raw,
        _table_part(chunk),
        str(getattr(chunk, "chunk_id", "")),
    )


def _document_order(chunk: Any) -> tuple[int, int]:
    """Where a tenant section sits in its document: section ordinal, then first line.

    A Markdown section („Geschoße") or a text block („Zeilen 12-30") has no page and no
    Punkt number to sort on, so without this the opening passages of a Markdown file
    came back in alphabetical order of their headings. ``(0, 0)`` for an OIB chunk,
    which carries neither, so their order is unchanged.
    """
    from aiq_agent.knowledge.base import section_position

    return section_position(getattr(chunk, "metadata", None))[:2]


def _table_part(chunk: Any) -> int:
    """A row group's or section chunk's 1-based position, ``0`` for anything that is not one."""
    from aiq_agent.knowledge.base import section_position

    return section_position(getattr(chunk, "metadata", None))[2]


def _clause_depth(chunk: Any) -> int | None:
    """``clause_depth`` as an int — ``None`` when absent or not a number.

    Accepts the int the chunker writes and the string a backend that
    round-trips metadata through JSON may hand back, because the depth decides
    whether a chunk belongs in the outline at all.
    """
    raw = (getattr(chunk, "metadata", None) or {}).get("clause_depth")
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
    return _clause_of(chunk) == "0" or _clause_depth(chunk) in _OUTLINE_DEPTHS


@dataclass(frozen=True)
class OutlineEntry:
    """One line of the Gliederung: a Punkt the reader can ask to have opened."""

    clause_id: str
    title: str
    page: str
    depth: int
    #: The Punkt's opening sentence, bounded — what a chapter is ABOUT, beside
    #: what it is called. Empty below depth 1 and for a chunk with no body.
    excerpt: str = ""
    #: Document order for a heading with no number to sort on (a tenant section).
    order: tuple[int, int] = (0, 0)


#: How much of a Punkt's opening sentence a Gliederung line carries.
_EXCERPT_CHARS = 120


def _excerpt_of(chunk: Any) -> str:
    """The opening sentence of one Punkt, bounded to :data:`_EXCERPT_CHARS`.

    A heading list answers "what is in this document" with names, and a name
    („Anforderungen") tells an overview question nothing it did not know. The
    first sentence does: the model can say what each chapter regulates from
    the outline alone, instead of opening every chapter to find out — which is
    one round of eight parallel opens per member, or three rounds once the
    fan-out crosses the per-round width cap. A Punkt chunk opens with its own
    heading line; the body follows the blank line, and only the body is quoted.
    """
    text = str(getattr(chunk, "content", "") or "")
    body = text.split("\n\n", 1)[1] if "\n\n" in text else text
    body = " ".join(body.split())
    if not body:
        return ""
    sentence = re.split(r"(?<=[.!?])\s", body, maxsplit=1)[0]
    if len(sentence) > _EXCERPT_CHARS:
        return sentence[:_EXCERPT_CHARS].rstrip() + "…"
    return sentence


def _outline_entries(chunks: Sequence[Any]) -> list[OutlineEntry]:
    """One entry per distinct Punkt at depth 1 or 2, ordered by the NUMBERING.

    Deduped by ``clause_id``: a Punkt long enough for ``SentenceSplitter`` to cut
    arrives as several chunks carrying the same id, and listing it twice would
    read as two Punkte.

    Ordered by :func:`_clause_number` alone, NOT by ``_clause_sort_key`` — an
    outline is an index of the document's own numbering, and 2.2 belongs under 2
    even if its stored ``page_label`` ran ahead of 3's. The passage path keeps
    the page-first key, because there the page is what the reader is being
    walked through.
    """
    entries: dict[str, OutlineEntry] = {}
    for chunk in sorted(chunks, key=_clause_sort_key):
        metadata = getattr(chunk, "metadata", None) or {}
        clause_id = _clause_of(chunk)
        depth = _clause_depth(chunk)
        if depth not in _OUTLINE_DEPTHS or not clause_id or clause_id in entries:
            continue
        entries[clause_id] = OutlineEntry(
            clause_id=clause_id,
            title=str(metadata.get("clause_title") or "").strip(),
            page=str(metadata.get("page_label") or getattr(chunk, "page_number", "") or ""),
            depth=depth,
            excerpt=_excerpt_of(chunk) if depth == 1 else "",
            order=_document_order(chunk),
        )
    return sorted(entries.values(), key=lambda entry: (_clause_number(entry.clause_id), entry.order, entry.clause_id))


def _scope_chunks(chunks: Sequence[Any]) -> list[Any]:
    """The chunks that ARE the passage of an outline: the document's scope.

    Punkt ``0`` (``Vorbemerkungen``) when the document has one, otherwise the
    lowest-numbered depth-1 Punkt, and failing both the first chunk in reading
    order — so an outline always carries at least one citable passage. An
    outline whose only evidence was a heading list would be a source a citation
    cannot resolve to.
    """
    ordered = sorted(chunks, key=_clause_sort_key)
    zero = [chunk for chunk in ordered if _clause_of(chunk) == "0"]
    if zero:
        return zero
    top = [chunk for chunk in ordered if _clause_depth(chunk) == 1]
    if not top:
        return ordered[:1]
    first = min((_clause_number(_clause_of(chunk)), _document_order(chunk), _clause_of(chunk)) for chunk in top)[2]
    return [chunk for chunk in top if _clause_of(chunk) == first]


def _outline_lines(entries: Sequence[OutlineEntry], limit: int = _MAX_OUTLINE_LINES) -> list[str]:
    """The Gliederung itself: one line per Punkt, depth 2 indented under depth 1.

    ``limit`` is the line budget. It is a parameter because a family overview
    prints one Gliederung per member and divides the budget between them
    (:data:`_MAX_FAMILY_OUTLINE_LINES`).
    """
    shown = list(entries)[:limit]
    lines = []
    for entry in shown:
        indent = "  " if entry.depth == 2 else ""
        # An unnumbered section is addressed by its title; saying it twice is noise.
        title = f": {entry.title}" if entry.title and entry.title != entry.clause_id else ""
        page = f" (S. {entry.page})" if entry.page else ""
        excerpt = f" — {entry.excerpt}" if entry.excerpt else ""
        lines.append(f"{indent}- Punkt {entry.clause_id}{title}{page}{excerpt}")
    remaining = len(entries) - len(shown)
    if remaining > 0:
        lines.append(f"(+{remaining} weitere Punkte nicht gelistet)")
    return lines


#: The one line that says what the Gliederung is and what it is not. German,
#: because it is read by the same model that writes the German answer, and it
#: has to be unmistakable that a heading is not a source.
_OUTLINE_INSTRUCTION = (
    "Einen gelisteten Punkt öffnest du mit `read_passage(document=…, clause=…)`; die "
    "Gliederung ist ein Index, keine Evidenz — nur die Passage(n) oben tragen eine Citation."
)

#: The same sentence for a document that has no Punkte to list.
_NO_CLAUSES_LINE = (
    "Dieses Dokument ist nicht nach Punkten gegliedert, es gibt also keine Gliederung — oben "
    "stehen seine ersten Passagen; weitere Seiten öffnest du mit `read_passage(document=…, page=…)`."
)


def _outline_block(entries: Sequence[OutlineEntry]) -> str:
    """The ``## Gliederung`` index appended under the outline's passage."""
    return "\n".join(["## Gliederung", *_outline_lines(entries), "", _OUTLINE_INSTRUCTION, ""])


# ---------------------------------------------------------------------------
# A whole Richtlinien-Familie at once
#
# "Was weißt du über die OIB 2?" is a question about four documents. Search
# ranks passages, so it answered with the two that scored best and the model
# opened the rest one round at a time, when it knew they existed at all.
# `knowledge_search` detects the question (`norm_registry.family_query_number`)
# and asks for this: every member's scope passage and every member's
# Gliederung, in the block it was going to render anyway. One round, then one
# round of Punkt opens.
#
# Membership is DERIVED from what is indexed, never listed (`oib_families`): a
# deployment whose corpus holds no 2.3 must not be told it has one.
# ---------------------------------------------------------------------------

#: How many scope passages ONE member contributes. The scope of a Richtlinie is
#: its Punkt 0, which arrives as one chunk in the corpus and as a handful when
#: ``SentenceSplitter`` cut it; two is the opening of the longest of them.
_MAX_FAMILY_SCOPE_CHUNKS = 2


@dataclass(frozen=True)
class FamilyMember:
    """One part of a Richtlinie, read: its scope passage and its Gliederung."""

    number: str
    title: str
    chunks: tuple[Any, ...]
    entries: tuple[OutlineEntry, ...]
    #: Read by filter alone, with no embedding (``BaseRetriever.fetch``).
    structural: bool = False


@dataclass(frozen=True)
class FamilyOverview:
    """Every part of one Richtlinie the corpus holds, ready to be rendered.

    ``chunks`` are the scope passages in member order, which the search puts
    ahead of its own hits so a citation resolves to each part; ``trailer`` is
    the one block of Gliederungen that follows the fan-out (ADR-0061: a
    decoration travels inside the block or the reader loses the records).
    """

    label: str
    members: tuple[FamilyMember, ...]
    chunks: tuple[Any, ...]
    trailer: str
    #: Every member was read by filter alone, with no embedding.
    structural: bool = False

    @property
    def opened_files(self) -> frozenset[str]:
        """The documents this overview OPENED: every member's file, read as ``read_passage`` reads it."""
        return frozenset(chunk.file_name for chunk in self.chunks if getattr(chunk, "file_name", None))

    @property
    def preamble(self) -> str:
        """What the family IS, above the results: the parts, where they are, and that they are open."""
        numbers = ", ".join(member.number for member in self.members)
        count = f"{len(self.members)} Teil" if len(self.members) == 1 else f"{len(self.members)} Teile"
        span = "Treffer 1" if len(self.chunks) == 1 else f"Treffer 1 bis {len(self.chunks)}"
        return (
            f"{self.label}: {count} im Bestand ({numbers}).\n"
            f"{span} sind der Geltungsbereich dieser Teile, ihre Gliederungen stehen unten; "
            "danach folgen die Treffer zur Suchanfrage.\n"
            "Damit sind diese Teile geöffnet, auf der Ebene von `read_passage(document=…)`; "
            "tiefer führt nur ein einzelner Punkt aus einer Gliederung, wie unten beschrieben."
        )


def _family_trailer(members: Sequence[FamilyMember]) -> str:
    """One ``## Gliederung`` section per member, and the instruction once.

    The instruction says what a Gliederung is and is not, and that holds for
    all of them, so it is stated once at the end rather than after each.

    The single-document line budget is SPLIT across the members: four of them
    at 80 lines each is 4 to 6k tokens of index framing far less evidence.
    With the depth-2 headings already dropped (:func:`_read_member`), a member
    of a four-part family prints its 20 top-level Punkte.
    """
    budget = max(1, _MAX_OUTLINE_LINES // max(1, len(members)))
    lines: list[str] = []
    for member in members:
        lines += [f"## Gliederung {member.title}", *_outline_lines(member.entries, budget), ""]
    return "\n".join([*lines, _OUTLINE_INSTRUCTION, ""])


def _member_title(file_name: str) -> str:
    """What a member is called in its Gliederung heading.

    The derived OIB title, which is what a citation chip prints and what
    :func:`_matches` accepts back as ``document=``, so the heading doubles as
    the argument for opening one of its Punkte.
    """
    from aiq_agent.common.norm_registry import guess_display_title

    try:
        return guess_display_title(file_name) or file_name
    except Exception:  # noqa: BLE001 — a missing title helper must not hide the file
        return file_name


async def _corpus_families(base: Any) -> list[Any]:
    """The Richtlinien-Familien the BASE shelf holds, from whichever source knows.

    Three sources, cheapest first. The turn's own family list is derived from
    the base shelf before the inventory cap can drop a member, so it is the one
    that is always complete. The inventory rows answer a turn that bound no
    list, and the collection's registered documents answer a run with no turn
    around it at all.
    """
    from aiq_agent.common.norm_registry import oib_families
    from aiq_agent.common.source_kinds import Shelf

    try:
        from aiq_agent.knowledge.inventory import get_norm_families
        from aiq_agent.knowledge.inventory import get_turn_documents

        families = list(get_norm_families())
        if families:
            return families
        rows = [
            str(getattr(row, "file_name", "") or "")
            for row in get_turn_documents()
            if str(getattr(row, "shelf", "") or "") == str(Shelf.BASE)
        ]
        if rows:
            return oib_families(rows)
    except Exception:  # noqa: BLE001 — no turn bound is a valid standalone run
        logger.debug("No turn inventory for the family lookup", exc_info=True)
    documents = await _documents_in(base.collection)
    return oib_families(str(getattr(document, "file_name", "") or "") for document in documents)


async def _read_member(target: PassageTarget, number: str) -> FamilyMember | None:
    """One member, read as an outline. ``None`` when the store holds none of it.

    That miss is how a family stays honest about the corpus: a member the
    deployment does not carry contributes no passage, no Gliederung and no
    line in the preamble.
    """
    outline = await outline_for([target], _fetch_query(target.file_name, None, None))
    if not outline.chunks:
        if outline.failures:
            logger.warning("Family member %s could not be read", target.file_name, exc_info=outline.failures[0])
        return None
    return FamilyMember(
        number=number,
        title=_member_title(target.file_name),
        chunks=tuple(_scope_chunks(outline.chunks)[:_MAX_FAMILY_SCOPE_CHUNKS]),
        entries=tuple(entry for entry in outline.entries if entry.depth == 1),
        structural=outline.structural,
    )


class FamilyUnreadable(RuntimeError):
    """The corpus lists the family, and not one of its parts could be read.

    Distinct from ``None``, which is "no such family here": a listed family
    that yields nothing is an overview that was attempted and lost, and the
    search that asked for it has to say so rather than look like an ordinary
    two-document search.
    """


async def family_overview(entries: Sequence[Any], family_key: str) -> FamilyOverview | None:
    """Every part of Richtlinie ``family_key`` the corpus holds, in one object.

    ``entries`` is the turn's collection scope; the corpus is the base shelf,
    so a turn that may not read it gets ``None`` rather than an overview of
    somebody's own copy of a Richtlinie. ``None`` also when the corpus holds no
    such family. A family it does hold, of which no member could be read,
    raises :class:`FamilyUnreadable`.
    """
    from aiq_agent.common.source_kinds import Shelf

    base = next((entry for entry in entries if getattr(entry, "shelf", None) is Shelf.BASE), None)
    if base is None:
        return None
    family = next((item for item in await _corpus_families(base) if item.key == family_key), None)
    if family is None:
        return None
    read = await asyncio.gather(
        *(
            _read_member(PassageTarget(base.collection, file_name, str(base.shelf)), number)
            for number, file_name in zip(family.members, family.files, strict=True)
        ),
        return_exceptions=True,
    )
    for failure in (item for item in read if isinstance(item, BaseException)):
        logger.warning("Family member skipped", exc_info=failure)
    members = tuple(item for item in read if isinstance(item, FamilyMember))
    if not members:
        raise FamilyUnreadable(f"no part of {family.label} could be read")
    chunks = tuple(chunk for member in members for chunk in member.chunks)
    logger.info("Family overview: %s read %d member(s)", family.label, len(members))
    return FamilyOverview(
        label=family.label,
        members=members,
        chunks=chunks,
        trailer=_family_trailer(members),
        structural=all(member.structural for member in members),
    )


def _locus_label(document: str, clause: str | None, page: int | None, pages: tuple[int, int] | None = None) -> str:
    """How this fetch names itself in a message the model reads."""
    parts = [document]
    if clause:
        parts.append(f"Pkt. {clause}")
    if page is not None:
        parts.append(f"S. {page}")
    if pages is not None:
        parts.append(f"S. {_page_range_text(*pages)}")
    return ", ".join(parts)


def _page_range_text(first: int, last: int) -> str:
    return str(first) if first == last else f"{first}\u2013{last}"


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
            "which document holds it. Do not invent a citation. " + _NOT_READABLE_IS_NOT_ABSENT
        )
    else:
        base = (
            f"No document in scope is named {document!r}. This tool never guesses a name: it opens "
            "the document you name or nothing.\n"
            f"{known} document(s) are readable this turn. Take the name from a hit's `Source:` or "
            "`Citation:` line, or from the knowledge-base inventory, and call again — or call "
            "`knowledge_search` with the topic when you do not yet know which document holds it. "
            "Do not invent a citation. " + _NOT_READABLE_IS_NOT_ABSENT
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


#: Every refusal that a name is not readable says this, because the agent read
#: "not readable" as "not there": a file whose read failed is in the project and
#: in none of the lists a read builds (feld72, Jour fixe 2026-10-09).
_NOT_READABLE_IS_NOT_ABSENT = (
    "Not readable here is not the same as not in the project: a file whose read failed is listed under "
    "`documents_unreadable:` in the project context — say it could not be read, never that it is missing."
)


def _no_passage_message(
    document: str, clause: str | None, page: int | None, pages: tuple[int, int] | None = None
) -> str:
    """A resolved document that carries no such Punkt or page."""
    asked = _locus_label(document, clause, page, pages)
    hint = (
        "The Punkt must be the number alone as the hit's `Punkt:` line prints it ('3.5.2'), and "
        "a parent heading is not a chunk of its own — read the child Punkt instead. "
        if clause
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
    from aiq_agent.common.turn_status import FETCH_FAILED_MARKER

    # Marked so the agent's duplicate-fetch guard can tell this apart from a
    # passage that was actually read: without the marker the retry this
    # sentence asks for comes back "you already fetched that".
    return (
        f"{FETCH_FAILED_MARKER} Could not read {query}: the knowledge store did not answer. "
        "Retry once; if it fails again, say so and do not invent a citation."
    )


def _fetch_query(document: str, clause: str | None, page: int | None) -> str:
    """The probe text handed to the store.

    The filter has already decided which chunks exist, so this only orders a set
    the caller is taking whole — it is never a search. It still names the locus
    rather than being empty, because an empty string embeds to nothing useful and
    some stores refuse it. A backend that reads by filter (``BaseRetriever.fetch``)
    never sees it; it is then only the label the result names itself by.
    """
    return _locus_label(document, clause, page)


async def _structural_fetch(
    retriever: Any,
    collection: str,
    filters: dict[str, Any],
    top_k: int,
    start_from: tuple[Any, ...] | None = None,
) -> list[Any] | None:
    """The chunks by filter alone, in reading order, when the backend reads that way; else ``None``.

    No probe, no embedding, no ranking (``BaseRetriever.fetch``). The cut is in
    reading order and never splits a tie, so every sort below keeps what it
    would have kept from the whole set. With ``start_from`` the read continues after that
    :func:`_chunk_position` instead (a ranged read's cursor).
    """
    from aiq_agent.knowledge.base import READING_ORDER

    fetch = getattr(retriever, "fetch", None)
    if fetch is None:
        return None
    if start_from is not None:
        return await fetch(collection_name=collection, filters=filters, limit=top_k, start_from=start_from)
    return await fetch(collection_name=collection, filters=filters, limit=top_k, order_by=READING_ORDER)


async def _fetch(
    target: PassageTarget,
    filters: dict[str, Any],
    query: str,
    top_k: int,
    start_from: tuple[Any, ...] | None = None,
) -> tuple[list[Any], bool]:
    """One filtered fetch against one collection, stamped with where it came from.

    The second value says whether it was a structural fetch. A backend that
    cannot read by filter is asked through ``retrieve`` with the probe text.
    """
    from aiq_agent.knowledge.factory import get_active_retriever

    retriever = get_active_retriever()
    chunks = await _structural_fetch(retriever, target.collection, filters, top_k, start_from)
    structural = chunks is not None
    if chunks is None:
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
    return chunks, structural


@dataclass(frozen=True)
class Fetched:
    """What one gathered fetch returned: the chunks, the failures, and whether every read was structural."""

    chunks: list[Any]
    failures: list[BaseException]
    structural: bool


async def _fetch_all(
    targets: list[PassageTarget],
    filters_for,
    query: str,
    top_k: int,
    start_from: tuple[Any, ...] | None = None,
) -> Fetched:
    """One filtered fetch per target, gathered. Failures are returned, not raised:
    one unreachable collection must not refuse the document that did answer."""
    fetched = await asyncio.gather(
        *(_fetch(target, filters_for(target.file_name), query, top_k, start_from) for target in targets),
        return_exceptions=True,
    )
    answered = [group for group in fetched if not isinstance(group, BaseException)]
    return Fetched(
        chunks=[chunk for chunks, _structural in answered for chunk in chunks],
        failures=[group for group in fetched if isinstance(group, BaseException)],
        structural=bool(answered) and all(structural for _chunks, structural in answered),
    )


@dataclass(frozen=True)
class Outline:
    """One document's top structure as :func:`outline_for` read it."""

    chunks: list[Any]
    entries: list[OutlineEntry]
    failures: list[BaseException]
    #: Read by filter alone, with no embedding (``BaseRetriever.fetch``).
    structural: bool


async def outline_for(targets: list[PassageTarget], query: str) -> Outline:
    """One document's top structure: its outline chunks, its Gliederung, what broke.

    The middle of an outline, shared by the two callers that need it: this
    tool's ``document=`` mode and :func:`family_overview`, which runs it once
    per member of a Richtlinien-Familie. Both then take the scope passage with
    :func:`_scope_chunks` and render the entries, so the family branch cannot
    drift into a second definition of what an outline IS.

    ``query`` is the probe text (:func:`_fetch_query`), which orders a set the
    filter has already chosen. The failures travel out rather than being logged
    here, because only the caller knows what to do with them: one document
    falls back to its opening pages, a family member contributes nothing.
    """
    fetched = await _fetch_all(targets, _outline_filters, query, _MAX_OUTLINE_CHUNKS)
    chunks = [chunk for chunk in fetched.chunks if _is_outline_chunk(chunk)]
    return Outline(chunks, _outline_entries(chunks), fetched.failures, fetched.structural)


def _read_row_fields(arguments: ReadPassageInput) -> dict[str, str | None]:
    """The Herleitung row of a read, from its own arguments: which document, which Punkt or pages (ADR-0132)."""
    clause = str(arguments.clause if arguments.clause is not None else "").strip().strip(".")
    page = str(arguments.page if arguments.page is not None else "").strip()
    pages = str(arguments.pages if arguments.pages is not None else "").strip()
    return {
        "target": (arguments.document or "").strip(),
        "pages": f"Pkt. {clause}" if clause else (pages or page or None),
    }


def _nameable(targets: Sequence[PassageTarget]) -> PassageTarget | None:
    """The first target whose document may be named to the model this turn (:func:`may_name`), or ``None``."""
    from aiq_agent.knowledge.restricted_use import may_name

    return next((target for target in targets if may_name(target.collection)), None)


def _note_target(outcome: ActionOutcome, targets: Sequence[PassageTarget]) -> None:
    """Put the resolved file name on the read's row, only where the model may be told it (ADR-0088).

    The row settles before the round's results are admitted. A file only an
    unadmitted restricted folder holds keeps the name the model asked for.
    """
    target = _nameable(targets)
    outcome.target = target.file_name if target is not None else None


def _count(outcome: ActionOutcome, hits: int, targets: Sequence[PassageTarget]) -> None:
    """The passages a read returned, counted on its row unless the document may not be named yet."""
    outcome.record(hits, collections=[target.collection for target in targets])


@register_function(config_type=ReadPassageConfig)
async def read_passage(config: ReadPassageConfig, _builder: Builder):
    """Open a named passage of a named document, or its outline. Deterministic; no LLM."""
    from .register import _resolve_base_collection
    from .register import _resolve_scoped_collections
    from .register import _restrict_scope_to_turn

    search_config = _builder.get_function_config(config.knowledge_search)

    def _entries() -> list[Any]:
        return _restrict_scope_to_turn(
            _resolve_scoped_collections(search_config, _session_collection(), _resolve_base_collection(search_config))
        )

    async def _unknown(document: str) -> str:
        """The refusal for a name nothing nameable carries, with its guesses.

        Counts and guesses come only from collections whose documents may be
        named to the model (:func:`may_name`): a restricted folder's file is
        neither suggested nor counted until this turn admitted its collection,
        because listing is not use (ADR-0088).
        """
        from aiq_agent.knowledge.restricted_use import may_name

        nameable = [entry for entry in _entries() if may_name(entry.collection)]
        listings = await asyncio.gather(*(_documents_in(entry.collection) for entry in nameable))
        known = sum(len(docs) for docs in listings)
        scoped = [doc for docs in listings for doc in docs]
        # Full candidate list: the message shows the first three and names
        # how many more clear the bar, so truncating never hides the count.
        return _unknown_document_message(document, known, _suggestion_names(document, scoped, limit=1000))

    async def _resolve_or_refuse(document: str) -> tuple[list[PassageTarget], str]:
        """The (collection, file) targets this name resolves to, or the refusal."""
        targets = await _resolve_targets(_entries(), document)
        if targets:
            return targets, ""
        return [], await _unknown(document)

    async def _miss(document: str, targets: list[PassageTarget], message: str, outcome: ActionOutcome) -> str:
        """``message`` for a read that returned no passage, unless it would confirm a hidden document.

        A document only restricted folders hold, none of them admitted this
        turn, is answered as if it did not exist: "no such Punkt" or "registered
        but empty" would tell the model it is there (ADR-0088). Its row says the
        same: an error over the name the model asked for, no file name, no count.
        """
        if _nameable(targets) is not None:
            return message
        outcome.hits = None
        outcome.target = None
        return await _unknown(document)

    async def _read(arguments: ReadPassageInput) -> str:
        """Open a document you can name: one clause (Punkt) or page of it, or its outline.

        With neither `clause` nor `page`, the document's OUTLINE is returned: its
        opening passage plus a `## Gliederung` of its top-level Punkte with
        their pages. That is what to call when you know the document but not yet
        which Punkt holds the answer — never guess a Punkt number.
        Several documents or several Punkte are one call each, issued in the
        same round: a round costs one however many calls it holds.

        Arguments (``ReadPassageInput``):
            document: The document's exact indexed file name or display
                title, as the inventory or a previous hit printed it. Never
                invented, never a fragment.
            clause: Optional. The Punkt number alone, e.g. "3.5.2" — no
                "Pkt.", no title — or a table's caption, "Tabelle 3". A
                top-level Punkt often arrives as a number (`3`) and is read as
                its digits, the way `page` accepts a numeric string. Omit it,
                and `page`, for the outline. ``punkt`` is accepted as the
                former name of this argument.
            page: Optional. The page number, 1-based. Ignored when `clause` is
                given: the clause alone names the passage. ``''`` is treated as
                omitted (#656: providers send empty string for "no page"). Omit
                it, and `clause`, for the outline.
            pages: Optional. A page range such as "4-6" (or one page, "4"; at most
                30 pages): those pages in reading order, up to about 6k tokens,
                without the overlap between neighbouring chunks. Ignored when
                `clause` is given. Request every range you need in one round.
            cursor: Optional. The `cursor` a ranged read ended with, passed back with
                the same `document` to continue where it stopped. Opaque: copy it.
            conclusion: Optional. One line on what you are looking for;
                no effect on the call.

        Returns:
            str: The passages, in the same grounding-block format
            `knowledge_search` returns, with Citation keys to copy verbatim —
            followed by the Gliederung when no clause and no page was named.
        """
        outcome = ActionOutcome()
        row = ActionRow("read", **_read_row_fields(arguments))
        try:
            result = await _read_body(arguments, outcome)
        except BaseException:
            row.finish("error")
            raise
        # A read that returned without fetching (an unknown name, a refused range) found nothing to count: an error row.
        outcome.settle(row, default="error", target=outcome.target)
        return result

    async def _read_body(arguments: ReadPassageInput, outcome: ActionOutcome) -> str:
        from aiq_agent.common.turn_status import READ_PASSAGE_TOOL
        from aiq_agent.common.turn_status import lane_tool_scope

        # `conclusion` is unread here on purpose — see the note in
        # `register.search`. It is a checkpoint channel read off the tool CALL,
        # never an input to what gets opened.
        document = (arguments.document or "").strip()
        clause = str(arguments.clause if arguments.clause is not None else "").strip().strip(".") or None
        pages_argument = arguments.pages
        page = _coerce_page(arguments.page)
        if pages_argument is None and _is_range_text(arguments.page):
            # `page="4-6"` is a range spelled with the old argument's name; a plain number stays a page.
            pages_argument, page = arguments.page, None
        if clause is not None and page is not None:
            # A Punkt (or „Tabelle 3") names one passage in a document, and
            # every chunk of it is filed under its FIRST page. A page beside it
            # can only repeat that page or empty the read: a Tabelle filed
            # under p. 30 and asked for as „page 29" (the printed page number)
            # came back empty, and the agent searched for it for two more rounds
            # (September 2026 census). The number decides; the page is dropped.
            page = None
        if not document:
            return (
                "Provide `document=` the exact name or display title of the document to open "
                "(from the inventory or a previous hit). To find out WHICH document holds a "
                "fact, call `knowledge_search` instead."
            )
        # Every branch below renders through `register._format_results`, which
        # is where lane hits are recorded — and it is the SAME renderer
        # `knowledge_search` uses, so the hit cannot say which tool fetched it
        # unless the tool says so here. The scope wraps the awaits rather than
        # sitting inside them: `_format_results` runs in `asyncio.to_thread`,
        # which copies the context at call time.
        with lane_tool_scope(READ_PASSAGE_TOOL):
            if clause is None and (str(pages_argument or "").strip() or (arguments.cursor or "").strip()):
                return await _open_range(document, pages_argument, arguments.cursor, outcome)
            if clause is None and page is None:
                return await _outline(document, outcome)
            return await _open(document, clause, page, outcome)

    async def _open(document: str, clause: str | None, page: int | None, outcome: ActionOutcome) -> str:
        from .register import _format_results

        targets, refusal = await _resolve_or_refuse(document)
        if refusal:
            return refusal

        _note_target(outcome, targets)
        query = _fetch_query(document, clause, page)
        # A page read fetches the window's chunks and keeps those covering the
        # page, so it may not stop at the passage bound before filtering.
        top_k = _MAX_PASSAGE_CHUNKS if page is None else _MAX_OUTLINE_CHUNKS
        fetched = await _fetch_all(targets, lambda file_name: _passage_filters(file_name, clause, page), query, top_k)
        chunks = [chunk for chunk in fetched.chunks if _addresses(chunk, clause, page)]
        if fetched.failures and not chunks:
            logger.warning("read_passage: every fetch failed for %r", query, exc_info=fetched.failures[0])
            return await _miss(document, targets, _store_silent_message(query), outcome)
        if not chunks:
            outcome.hits = 0
            return await _miss(document, targets, _no_passage_message(document, clause, page), outcome)

        chunks.sort(key=_clause_sort_key)
        merged = _passage_result(chunks[:_MAX_PASSAGE_CHUNKS], query)
        _count(outcome, len(merged.chunks), targets)
        formatted = await asyncio.to_thread(
            _format_results,
            merged,
            query,
            notice=_target_notices(targets),
            reading_of=_locus_label(document, clause, page),
        )
        logger.info("read_passage: %s returned %d chunk(s)", query, len(merged.chunks))
        return formatted

    async def _open_range(document: str, pages_argument: Any, cursor_token: str | None, outcome: ActionOutcome) -> str:
        """Pages ``first``-``last`` of a document in reading order, or the rest of a read that stopped early."""
        from .register import _format_results

        try:
            span = _parse_pages(pages_argument, document)
        except RangeRefused as refusal:
            return str(refusal)
        targets, refusal_text = await _resolve_or_refuse(document)
        if refusal_text:
            return refusal_text

        _note_target(outcome, targets)
        cursor = decode_cursor(cursor_token) if (cursor_token or "").strip() else None
        if (cursor_token or "").strip():
            targets = [
                target
                for target in targets
                if cursor is not None
                and target.file_name == cursor.file_name
                and (not cursor.collection or target.collection == cursor.collection)
            ]
            if not targets:
                return _cursor_refusal(document, span)
        # `pages` beside a cursor only says where the read ends; the cursor says where it starts.
        first = cursor.page if cursor is not None else span[0]
        last = span[1] if span is not None else (cursor.last_page if cursor is not None else None)
        start = cursor.position if cursor is not None else None
        kind = cursor.filters if cursor is not None else ORDER_FILTERS

        query = _fetch_query(document, None, None)
        fetched = await _fetch_all(targets, _filters_for(kind, first, last), query, _MAX_OUTLINE_CHUNKS, start)
        if start is None and not fetched.chunks and not fetched.failures and last is not None:
            # A document written before `reading_order` existed has no value for the range to compare.
            # The cursor records the family, so the continuation reads the same set.
            kind = LABEL_FILTERS
            fetched = await _fetch_all(targets, _filters_for(kind, first, last), query, _MAX_OUTLINE_CHUNKS)
        chunks = _in_range(fetched.chunks, first, last, start)
        if start is None and not chunks and not fetched.failures and len(fetched.chunks) >= _MAX_OUTLINE_CHUNKS:
            # The look-back pages alone filled the fetch: read again from the first page itself.
            fetched = await _fetch_all(targets, _filters_for(kind, first, last, 0), query, _MAX_OUTLINE_CHUNKS)
            chunks = _in_range(fetched.chunks, first, last, start)
        label = _locus_label(document, None, None, (first, last) if last is not None else (first, first))
        if fetched.failures and not chunks:
            logger.warning("read_passage: every fetch failed for %r", label, exc_info=fetched.failures[0])
            return await _miss(document, targets, _store_silent_message(label), outcome)
        if not chunks:
            outcome.hits = 0
        if not chunks and start is not None:
            return f"Nothing is left after that cursor in {document}: the read is complete."
        if not chunks:
            return await _miss(document, targets, _no_passage_message(document, None, None, span), outcome)

        ordered = await asyncio.to_thread(lambda: _without_overlap(_range_order(chunks)))
        kept, more = _within_budget(ordered, _MAX_READ_CHARS)
        capped = len(fetched.chunks) >= _MAX_OUTLINE_CHUNKS
        next_cursor = _next_cursor(kept, last, kind) if more or capped else None
        trailer = _range_trailer(document, kept, first, last, next_cursor)
        merged = _passage_result(kept, label)
        _count(outcome, len(kept), targets)
        formatted = await asyncio.to_thread(
            _format_results,
            merged,
            label,
            notice=_target_notices(targets),
            trailer=trailer,
            reading_of=label,
        )
        logger.info("read_passage: %s returned %d chunk(s), cursor=%s", label, len(kept), bool(next_cursor))
        return formatted

    async def _outline(document: str, outcome: ActionOutcome) -> str:
        """The same lookup at document granularity: scope passage plus Gliederung."""
        from .register import _format_results

        targets, refusal = await _resolve_or_refuse(document)
        if refusal:
            return refusal

        query = _fetch_query(document, None, None)
        _note_target(outcome, targets)
        outline = await outline_for(targets, query)
        entries = outline.entries
        if not outline.chunks:
            return await _opening_passages(document, targets, query, outline.failures, outcome)

        passages = _scope_chunks(outline.chunks)[:_MAX_PASSAGE_CHUNKS]
        _count(outcome, len(passages), targets)
        # The Gliederung travels as the block's trailer rather than being glued
        # on here: the renderer files the records under the hash of the bytes it
        # returns, and a byte added afterwards costs this tool the structured
        # read on its most common call (ADR-0061).
        formatted = await asyncio.to_thread(
            _format_results,
            _passage_result(passages, query),
            query,
            notice=_target_notices(targets),
            trailer=_outline_block(entries),
            reading_of=document,
        )
        logger.info("read_passage: %s outlined %d Punkt(e)", query, len(entries))
        return formatted

    async def _opening_passages(
        document: str, targets: list[PassageTarget], query: str, failures: list[BaseException], outcome: ActionOutcome
    ) -> str:
        """The outline of a document with no Punkt metadata: its opening passages.

        Those chunks ARE the passages — there is no heading structure to index,
        so the block carries no Gliederung and says so in one line. Nothing is
        re-checked here beyond the document itself: the fetch narrows to the
        file and the document-order sort decides which chunks open it, because
        a second clause on ``page_label`` would exclude every store that fills
        it with something other than a page number.
        """
        from .register import _format_results

        whole = await _fetch_all(targets, _whole_document_filters, query, _MAX_OUTLINE_CHUNKS)
        fetched = whole.chunks
        broke = failures + whole.failures
        if not fetched and broke:
            logger.warning("read_passage: every outline fetch failed for %r", query, exc_info=broke[0])
            return await _miss(document, targets, _store_silent_message(query), outcome)
        if not fetched:
            outcome.hits = 0
            return await _miss(document, targets, _empty_document_message(document), outcome)

        merged = _passage_result(sorted(fetched, key=_clause_sort_key)[:_MAX_PASSAGE_CHUNKS], query)
        _count(outcome, len(merged.chunks), targets)
        # The line that replaces the Gliederung rides the same trailer, and for
        # the same reason: the hash is over the whole text.
        formatted = await asyncio.to_thread(
            _format_results,
            merged,
            query,
            notice=_target_notices(targets),
            trailer=_NO_CLAUSES_LINE,
            reading_of=document,
        )
        logger.info("read_passage: %s outlined %d opening chunk(s)", query, len(merged.chunks))
        return formatted

    yield FunctionInfo.from_fn(_read, input_schema=ReadPassageInput, description=_READ_PASSAGE_DESCRIPTION)


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
