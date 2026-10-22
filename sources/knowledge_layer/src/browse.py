"""Looking at the files the way a person does: the listing and the exact search.

A person in the Files pane does two things before they read anything: they
LOOK at what is there (open a folder, sort by date, filter by name) and they
FIND where something is written (Ctrl+F across the project). The agent could do
neither. What it saw of the project was the prompt inventory, capped at fifty
rows, and what it could find was ``knowledge_search`` — a ranked top-k
similarity search that answers "what passage best matches this" and never
"which files say this". So on a project with three hundred files the agent
answered „welche Unterlagen liegen in Brandschutz/?“ from whichever fifty names the
cap kept, and „wo kommt BA-03 überall vor?“ from the three passages that ranked.

- ``list_files`` is ``ls`` / the Files pane: every file on the reader's own
  shelves, filtered by folder, name, Dokumentart and date, paged, with the
  subfolders and their counts. An INDEX, never evidence: a row proves a file
  exists, as the inventory does.
- ``knowledge_search(match="exact")`` is ``grep`` (:func:`exact_search`, here
  because it shares the rows): every chunk whose text contains a phrase, over
  every file in scope, counted per file — then the first passages of the
  best-covered files, rendered through the knowledge layer's own grounding
  block, so they are citable exactly like a search hit. One regex
  (:func:`phrase_pattern`) does the finding in the store and the counting
  here, and it reads the phrase the way a person does: case, ä/ae and ß/ss
  spellings, and a line break or hyphen between two words do not matter; a
  term of two or three characters is a whole word.

The exact search is a MODE of the search rather than a tool of its own: it is
the same verb over the same scope with the same narrowing arguments, and a
second tool would have been one more name for the model to choose between
(docs/architecture/agent-tool-surface.md).

Both are deterministic: no reranker, no judge, no LLM. Both read only what the
turn may read: the rows the turn's inventory resolved against the signed scope
(``knowledge.inventory.get_turn_documents``, uncapped), or — on a path that
bound none — the same scope ``knowledge_search`` resolves. Both then subtract
the shelves this turn did not ask for (``focus_file.get_turn_shelves``), the
way ``register._restrict_scope_to_turn`` does for the ranked search, so a turn
about one upload lists and greps that upload, not the Büroablage. The exact
search reads the base corpus through the same store filter the ranked search
uses (``register._base_collection_filters``): an excluded edition or a cover
page is not evidence in either mode.
"""

from __future__ import annotations

import asyncio
import bisect
import logging
import re
import time
import unicodedata
from collections.abc import Iterable
from collections.abc import Mapping
from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import field
from dataclasses import replace
from typing import Any
from typing import Literal

import regex
from pydantic import Field

from aiq_agent.common.action_outcome import ActionOutcome
from aiq_agent.common.source_kinds import canonical_shelf_value
from aiq_agent.common.turn_status import ActionRow
from aiq_agent.knowledge.mail_facts import mail_origin_label
from aiq_agent.knowledge.mail_facts import mail_thread_date
from aiq_agent.knowledge.mail_facts import mail_thread_label
from aiq_agent.knowledge.mail_facts import normalise_mail_origin
from aiq_agent.knowledge.mail_facts import normalise_mail_thread
from aiq_agent.knowledge.page_count import page_number
from aiq_agent.knowledge.title_block import display_date
from aiq_agent.knowledge.title_block import document_key
from aiq_agent.knowledge.title_block import newest_first
from aiq_agent.knowledge.title_block import title_block_label
from nat.plugin_api import Builder
from nat.plugin_api import Context
from nat.plugin_api import FunctionBaseConfig
from nat.plugin_api import FunctionInfo
from nat.plugin_api import FunctionRef
from nat.plugin_api import register_function

from .revision_series import find_revision_series
from .revision_series import parse_revision_name
from .revision_series import revision_label
from .revision_series import series_key_of

logger = logging.getLogger(__name__)

#: Rows one ``list_files`` page returns by default, and the most it may ask for.
#: A row is ~40 tokens with its summary, so the default page costs about what
#: one search result costs.
DEFAULT_PAGE_SIZE = 40
MAX_PAGE_SIZE = 100

#: How many subfolders the folder overview names before it counts the rest.
MAX_FOLDER_LINES = 30
#: Document types named in the listing's profile line before it stops (the vocabulary has 12).
MAX_TYPE_COUNTS = 8
#: Topics (Themen) named in the listing's profile line before it stops.
MAX_TOPIC_COUNTS = 8

#: The summary is a hint for choosing what to open, not something to answer from.
MAX_SUMMARY_CHARS = 160

#: The shelves a person calls "my files". Basiswissen is the platform corpus:
#: listable on request (``shelf="base"``), never part of a default listing.
USER_SHELVES = ("project", "office_shelf", "session")
KNOWN_SHELVES = (*USER_SHELVES, "base")

#: How many chunks one exact search reads per collection. A bound
#: against a phrase that is on every page, not a relevance budget: past it the
#: count is stated as a floor.
MAX_MATCH_CHUNKS = 500

#: How many matching passages travel as citable evidence. The per-file table
#: covers every match; these are the text to quote from.
MAX_MATCH_PASSAGES = 8

#: A single character matches noise. Two and three characters („EG“, „T30“)
#: are real search terms and match as whole words (:data:`WHOLE_WORD_MAX_CHARS`).
MIN_PHRASE_CHARS = 2

#: A person's regex is a pattern, not a document: longer than this is refused.
MAX_USER_PATTERN_CHARS = 300

#: Lines of context around a hit (``context=``), and the lines the whole index may print.
MAX_CONTEXT_LINES = 3
MAX_SNIPPET_LINES = 40

#: Alternatives in one exact search. „BA-03 | BA 03 | Brandabschnitt 3“
#: is one question asked three ways; ten is a runaway.
MAX_ALTERNATIVES = 6

#: Distinct matched strings a regex search lists before it counts the rest, and the characters of one.
MAX_DISTINCT_MATCHES = 20
MAX_DISTINCT_CHARS = 60
#: Files and pages named beside one distinct match, and distinct strings one file is tracked for.
MAX_DISTINCT_FILES = 3
MAX_DISTINCT_PAGES = 5
MAX_TRACKED_STRINGS = 200

#: ``shelf=`` of a literal search as the person-facing word, and the stored shelf it means.
SEARCH_SHELVES = {
    "project": "project",
    "office": "office_shelf",
    "office_shelf": "office_shelf",
    "session": "session",
    "base": "base",
}

_SHELF_LABELS = {
    "project": "Projektwissen",
    "office_shelf": "Büroablage",
    "session": "Private Sitzung",
    "base": "Basiswissen",
}

_FOLD = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"})


def fold(text: str) -> str:
    """Lowercase, NFC, umlauts transliterated: how two spellings of a name compare."""
    return unicodedata.normalize("NFC", text or "").lower().translate(_FOLD)


def _words(text: str) -> list[str]:
    return [word for word in re.split(r"[^0-9a-z]+", fold(text)) if word]


# ---------------------------------------------------------------------------
# Rows
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FileRow:
    """One file as the browser shows it. Built from an inventory row."""

    file_name: str
    shelf: str | None
    collection: str
    folder: str = ""
    display_title: str | None = None
    doc_class: str | None = None
    tags: tuple[str, ...] = ()
    summary: str = ""
    added_at: str | None = None
    #: Open topics (Themen) Piloti recognised, or a person set.
    topics: tuple[str, ...] = ()
    #: What the camera wrote: the ISO time it was taken, and make and model. Never a position.
    captured_at: str | None = None
    camera: str | None = None
    #: The newer file a PERSON confirmed replaces this one, and the files this one replaces.
    superseded_by: str | None = None
    supersedes: tuple[str, ...] = ()
    #: What changed against the Fassung it replaced, and the file name that was compared against.
    change_summary: str | None = None
    change_basis: str | None = None
    #: What the title block (Plankopf) of the document's first drawing page says: ``document_number``,
    #: ``revision`` (Index), ``revision_date`` (ISO), ``scale``, ``title``; present keys only.
    revision_facts: Mapping[str, Any] | None = field(default=None, compare=False)
    #: Pages the document has, when the store knows (None: not recorded, never "zero").
    page_count: int | None = None
    #: On a filed E-Mail-Verlauf: its newest message and count (``aiq_agent.knowledge.mail_facts``).
    mail_thread: Mapping[str, Any] | None = field(default=None, compare=False)
    #: On a file filed from a mail: the message it came with, sender trust included.
    mail_origin: Mapping[str, Any] | None = field(default=None, compare=False)

    @property
    def document_date(self) -> str | None:
        """The document's OWN date (ISO day): the title block's Stand, else the day a photo was taken,
        else a mail thread's newest message.

        The same rule as the ``document_date`` payload field (``qdrant/payload.py``), read from the
        facts the row already carries. None for a document that prints none; never the upload date,
        and never the day an attachment was mailed (that is its origin, not its date).
        """
        thread_date = mail_thread_date(self.mail_thread)
        stamp = str((self.revision_facts or {}).get("revision_date") or self.captured_at or thread_date or "")
        return stamp.strip()[:10] or None

    @property
    def searchable(self) -> str:
        return " ".join(_words(f"{self.file_name} {self.display_title or ''}"))


def _attr(row: Any, name: str) -> Any:
    return row.get(name) if isinstance(row, dict) else getattr(row, name, None)


def file_row(row: Any) -> FileRow | None:
    """An inventory row (``AvailableDocument`` or its dict) as a :class:`FileRow`."""
    file_name = str(_attr(row, "file_name") or "").strip()
    if not file_name:
        return None
    shelf = _attr(row, "shelf")
    shelf = getattr(shelf, "value", shelf)
    # Only the two facts a listing may show are read from the capture; the position stays unread.
    capture = _attr(row, "capture")
    capture = capture if isinstance(capture, dict) else {}
    revision_facts = _attr(row, "revision_facts")
    return FileRow(
        file_name=file_name,
        shelf=canonical_shelf_value(str(shelf)) if shelf else None,
        collection=str(_attr(row, "collection") or ""),
        folder=str(_attr(row, "folder_path") or "").strip().strip("/"),
        display_title=(str(_attr(row, "display_title") or "").strip() or None),
        doc_class=(str(_attr(row, "doc_class") or "").strip() or None),
        tags=tuple(str(tag) for tag in (_attr(row, "tags") or ()) if tag),
        summary=" ".join(str(_attr(row, "summary") or "").split()),
        added_at=(str(_attr(row, "added_at") or "").strip()[:10] or None),
        topics=tuple(str(topic) for topic in (_attr(row, "topics") or ()) if topic),
        captured_at=(str(capture.get("captured_at") or "").strip() or None),
        camera=(str(capture.get("camera") or "").strip() or None),
        superseded_by=(str(_attr(row, "superseded_by") or "").strip() or None),
        supersedes=tuple(str(name) for name in (_attr(row, "supersedes") or ()) if name),
        change_summary=(str(_attr(row, "change_summary") or "").strip() or None),
        change_basis=(str(_attr(row, "change_basis") or "").strip() or None),
        revision_facts=revision_facts if isinstance(revision_facts, dict) and revision_facts else None,
        page_count=page_number(_attr(row, "page_count")),
        mail_thread=normalise_mail_thread(_attr(row, "mail_thread")),
        mail_origin=normalise_mail_origin(_attr(row, "mail_origin")),
    )


def file_rows(rows: Iterable[Any]) -> list[FileRow]:
    """Deduplicated by ``(collection, file_name)``, the inventory's identity."""
    seen: set[tuple[str, str]] = set()
    out: list[FileRow] = []
    for raw in rows:
        row = file_row(raw)
        if row is None or (row.collection, row.file_name) in seen:
            continue
        seen.add((row.collection, row.file_name))
        out.append(row)
    return out


def _in_folder(row: FileRow, folder: str) -> bool:
    return row.folder == folder or row.folder.startswith(f"{folder}/")


def _folder_matches(rows: Sequence[FileRow], folder: str) -> str | None:
    """The stored spelling of ``folder``, case- and umlaut-insensitively, or None."""
    wanted = fold(folder)
    for row in rows:
        parts = row.folder.split("/") if row.folder else []
        for depth in range(1, len(parts) + 1):
            candidate = "/".join(parts[:depth])
            if fold(candidate) == wanted:
                return candidate
    return None


# ---------------------------------------------------------------------------
# list_files
# ---------------------------------------------------------------------------


@dataclass
class Listing:
    """What one ``list_files`` call selected, before it is rendered."""

    rows: list[FileRow]
    total: int
    offset: int
    limit: int
    folder: str | None
    subfolders: list[tuple[str, int]] = field(default_factory=list)
    here: int = 0
    shelves: tuple[str, ...] = ()
    notes: list[str] = field(default_factory=list)
    #: Document types Piloti assigned across the WHOLE selection (not just the
    #: page), most frequent first, and how many files carry none.
    types: list[tuple[str, int]] = field(default_factory=list)
    untyped: int = 0
    #: Topics (Themen) across the whole selection, most frequent first.
    topics: list[tuple[str, int]] = field(default_factory=list)
    #: What the file names say about Fassungen, keyed by ``(collection, file_name)``:
    #: the mark a row carries, and how many documents in the selection have several.
    revision_marks: dict[tuple[str, str], str] = field(default_factory=dict)
    revision_series: int = 0
    #: How many files a person confirmed as replaced, among the selection.
    confirmed_replacements: int = 0
    #: How many documents in the selection share a document number in their title blocks across several states.
    title_block_series: int = 0


def _type_profile(rows: Sequence[FileRow]) -> tuple[list[tuple[str, int]], int]:
    """What the selected files are, by the document type Piloti gave each: the folder's README line.

    The agent otherwise meets a folder of 300 files as 300 lines, of which a page
    of 50 is shown. One line of counts tells it what the folder holds before it
    reads any of them (and what the folder brief in Dateien shows a person).
    „Sonstiges“ is counted last whatever its size: it says nothing about the folder.
    """
    from aiq_agent.knowledge.document_classification import DOCUMENT_TYPE_TAGS

    known = set(DOCUMENT_TYPE_TAGS)
    counts: dict[str, int] = {}
    untyped = 0
    for row in rows:
        types = [tag for tag in dict.fromkeys(row.tags) if tag in known]
        if not types:
            untyped += 1
        for tag in types:
            counts[tag] = counts.get(tag, 0) + 1
    order = {tag: index for index, tag in enumerate(DOCUMENT_TYPE_TAGS)}
    ranked = sorted(counts.items(), key=lambda item: (item[0] == "Sonstiges", -item[1], order[item[0]]))
    return ranked, untyped


def _topic_profile(rows: Sequence[FileRow]) -> list[tuple[str, int]]:
    """The topics the selected files carry, counted per file, most frequent first.

    A topic counts once per file whatever its case, and the spelling shown is the
    first one seen. Ties sort alphabetically, so the line is the same on every page.
    """
    counts: dict[str, int] = {}
    spelling: dict[str, str] = {}
    for row in rows:
        seen: set[str] = set()
        for topic in row.topics:
            key = fold(topic)
            if key in seen:
                continue
            seen.add(key)
            spelling.setdefault(key, topic)
            counts[key] = counts.get(key, 0) + 1
    ranked = sorted(counts, key=lambda key: (-counts[key], key))
    return [(spelling[key], counts[key]) for key in ranked]


def _subfolders(rows: Sequence[FileRow], folder: str | None) -> tuple[list[tuple[str, int]], int]:
    """The folders one level below ``folder`` with their file counts (whole subtree), and the files AT it."""
    counts: dict[str, int] = {}
    here = 0
    base = folder or ""
    for row in rows:
        rest = row.folder[len(base) :].lstrip("/") if base else row.folder
        if not rest:
            here += 1
            continue
        child = rest.split("/", 1)[0]
        path = f"{base}/{child}" if base else child
        counts[path] = counts.get(path, 0) + 1
    return sorted(counts.items(), key=lambda item: fold(item[0])), here


_RowKey = tuple[str, str]


def revision_marks(rows: Sequence[FileRow]) -> tuple[dict[_RowKey, str], dict[_RowKey, _RowKey]]:
    """Which rows the names say are the current or an older Fassung of one document.

    The same grammar the folder brief reads (``revision_series.py``, its TS twin
    held to one fixture), grouped per collection: a Fassung lives on one shelf.
    Grouped over every row handed in, because an older Fassung is often moved
    into an ``alt/`` folder that the listing's folder filter would cut away.
    Returns the marks, and for each marked row the key of its series' current row.
    """
    by_collection: dict[str, list[FileRow]] = {}
    for row in rows:
        by_collection.setdefault(row.collection, []).append(row)
    marks: dict[tuple[str, str], str] = {}
    series_of: dict[_RowKey, _RowKey] = {}
    for members in by_collection.values():
        for series in find_revision_series(
            members, filename=lambda row: row.file_name, created_at=lambda row: row.added_at
        ):
            head = series.current.item
            label = revision_label(series.current.revision)
            head_key = (head.collection, head.file_name)
            series_of[head_key] = head_key
            marks[(head.collection, head.file_name)] = (
                f"current Fassung ({label}; {len(series.older)} older, by file name)"
            )
            for member in series.older:
                older = member.item
                series_of[(older.collection, older.file_name)] = head_key
                marks[(older.collection, older.file_name)] = (
                    f"older Fassung ({revision_label(member.revision)}), current by file name: {head.file_name}"
                )
    return marks, series_of


def _state_label(facts: Mapping[str, Any] | None) -> str:
    """``Index C, Stand 14.08.2026``: the state a title block names, without the number."""
    facts = facts or {}
    parts = [f"Index {facts['revision']}"] if facts.get("revision") else []
    if facts.get("revision_date"):
        parts.append(f"Stand {display_date(str(facts['revision_date']))}")
    return ", ".join(parts) or "no Index"


def title_block_marks(rows: Sequence[FileRow]) -> tuple[dict[_RowKey, str], dict[_RowKey, _RowKey]]:
    """Which rows the title blocks say are the current or an older Fassung of one document.

    Two files of one collection whose title blocks carry the same ``document_number`` are
    Fassungen of one document, whatever their names share, and the higher Index (else the later
    date) printed on the sheet is the current one. Needs two different states: the same number
    and the same Index twice is a copy. Returns the marks, and for each marked row the key of
    its series' current row.
    """
    groups: dict[tuple[str, str], list[FileRow]] = {}
    for row in rows:
        key = document_key((row.revision_facts or {}).get("document_number"))
        if key is not None:
            groups.setdefault((row.collection, key), []).append(row)
    marks: dict[_RowKey, str] = {}
    series_of: dict[_RowKey, _RowKey] = {}
    for members in groups.values():
        states = {
            ((m.revision_facts or {}).get("revision"), (m.revision_facts or {}).get("revision_date")) for m in members
        }
        if len(members) < 2 or len(states) < 2:
            continue
        ordered = newest_first(members, lambda row: row.revision_facts, lambda row: row.added_at or "")
        head, older = ordered[0], ordered[1:]
        head_key = (head.collection, head.file_name)
        series_of[head_key] = head_key
        marks[head_key] = f"current Fassung by Plankopf ({_state_label(head.revision_facts)}; {len(older)} older)"
        for row in older:
            series_of[(row.collection, row.file_name)] = head_key
            marks[(row.collection, row.file_name)] = (
                f"older Fassung by Plankopf ({_state_label(row.revision_facts)}), current by Plankopf: {head.file_name}"
            )
    return marks, series_of


def confirmed_revision_marks(rows: Sequence[FileRow]) -> dict[_RowKey, str]:
    """The rows a PERSON linked as one replacing another, with the mark each carries.

    The older file says by which it was replaced, the newer which it replaced.
    These are confirmations, not readings of a name, so they beat the name
    marks. A link counts only when both files are among ``rows``: the store
    clears a link whose newer file is gone, and this guards a row it missed.
    """
    present = {(row.collection, row.file_name) for row in rows}
    marks: dict[_RowKey, list[str]] = {}
    for row in rows:
        key = (row.collection, row.file_name)
        if row.superseded_by and (row.collection, row.superseded_by) in present:
            marks.setdefault(key, []).append(f"replaced by {row.superseded_by} (confirmed)")
        replaced = [name for name in row.supersedes if (row.collection, name) in present]
        if replaced:
            marks.setdefault(key, []).append(f"replaces {', '.join(replaced)} (confirmed)")
    return {key: "; ".join(parts) for key, parts in marks.items()}


def on_shelves(rows: Sequence[FileRow], *, shelf: str | None, default_shelves: Sequence[str]) -> list[FileRow]:
    """The rows on the asked shelf, or on the default shelves (plus rows with no shelf) when none is asked."""
    shelves = (shelf,) if shelf else tuple(default_shelves)
    return [row for row in rows if row.shelf in shelves or (not shelf and row.shelf is None)]


def select_files(
    rows: Sequence[FileRow],
    *,
    shelf: str | None = None,
    folder: str | None = None,
    name_contains: str | None = None,
    doc_class: str | None = None,
    added_since: str | None = None,
    topic: str | None = None,
    sort: str = "folder",
    offset: int = 0,
    limit: int = DEFAULT_PAGE_SIZE,
    default_shelves: Sequence[str] = USER_SHELVES,
) -> Listing:
    """Filter, order and page the rows. Pure: the tool's whole behaviour is here.

    ``default_shelves`` is what „my files“ means when no ``shelf`` is asked
    for: the user shelves, or the subset of them this turn is restricted to.
    """
    notes: list[str] = []
    shelves = (shelf,) if shelf else tuple(default_shelves)
    selected = on_shelves(rows, shelf=shelf, default_shelves=default_shelves)
    marks, series_of = revision_marks(selected)
    block_marks, block_series_of = title_block_marks(selected)
    confirmed = confirmed_revision_marks(selected)

    resolved_folder: str | None = None
    if folder:
        resolved_folder = _folder_matches(selected, folder)
        if resolved_folder is None:
            notes.append(f'No folder "{folder}" on these shelves. Call without `folder` to see the folders.')
            return Listing([], 0, offset, limit, folder, shelves=shelves, notes=notes)
        selected = [row for row in selected if _in_folder(row, resolved_folder)]

    if doc_class:
        selected = [row for row in selected if row.doc_class == doc_class]
    if added_since:
        selected = [row for row in selected if row.added_at and row.added_at >= added_since]
    if name_contains:
        words = _words(name_contains)
        selected = [row for row in selected if all(word in row.searchable for word in words)]
    if topic:
        needle = fold(topic)
        selected = [row for row in selected if any(needle in fold(name) for name in row.topics)]

    filtered = bool(doc_class or added_since or name_contains or topic)
    subfolders, here = ([], 0) if filtered else _subfolders(selected, resolved_folder)

    if sort == "newest":
        selected.sort(key=lambda row: (row.added_at or "", fold(row.file_name)), reverse=True)
        # Undated rows last, whatever the reverse did to the empty string.
        selected.sort(key=lambda row: row.added_at is None)
    elif sort == "name":
        selected.sort(key=lambda row: fold(row.file_name))
    else:
        selected.sort(key=lambda row: (fold(row.folder), fold(row.file_name)))

    total = len(selected)
    page = selected[offset : offset + limit]
    types, untyped = _type_profile(selected)
    keys = {(row.collection, row.file_name) for row in selected}
    return Listing(
        page,
        total,
        offset,
        limit,
        resolved_folder,
        subfolders,
        here,
        shelves,
        notes,
        types,
        untyped,
        topics=_topic_profile(selected),
        revision_marks={key: mark for key, mark in {**marks, **block_marks, **confirmed}.items() if key in keys},
        revision_series=len(
            {series_of[key] for key in keys if key in series_of and key not in confirmed and key not in block_marks}
        ),
        title_block_series=len(
            {block_series_of[key] for key in keys if key in block_series_of and key not in confirmed}
        ),
        confirmed_replacements=sum(
            1 for row in selected if row.superseded_by and (row.collection, row.file_name) in confirmed
        ),
    )


#: What a row says of a file's change: a glance, so the model reads the files themselves for more.
MAX_CHANGE_CHARS = 160
#: The same line when the question IS the change (``revisions_of``): what „was hat sich geändert“ is answered from.
MAX_CHAIN_CHANGE_CHARS = 700


def _change_text(row: FileRow, limit: int) -> str:
    """The stored change line as one sentence of at most ``limit`` characters; empty when none is stored."""
    if not row.change_summary:
        return ""
    lines = [line.lstrip("-•* ").strip() for line in row.change_summary.splitlines()]
    text = "; ".join(line for line in lines if line)
    if len(text) > limit:
        text = text[: limit - 1].rstrip() + "…"
    return text


def _compared_with_own_upload(row: FileRow) -> bool:
    return row.change_basis is not None and fold(row.change_basis) == fold(row.file_name)


def _change_bit(row: FileRow) -> str:
    """``changed: …`` for what changed against the Fassung this file replaced, bounded; empty when none is stored.

    A change line against the file's own previous upload (``change_basis`` is its
    own name) says so, because the previous upload is not another file.
    """
    text = _change_text(row, MAX_CHANGE_CHARS)
    if not text:
        return ""
    return f"changed (previous Fassung): {text}" if _compared_with_own_upload(row) else f"changed: {text}"


def _row_line(row: FileRow, *, show_shelf: bool, mark: str | None = None) -> str:
    bits: list[str] = []
    if row.display_title and fold(row.display_title) != fold(row.file_name):
        bits.append(f'"{row.display_title}"')
    bits.append(f"Folder: {row.folder}" if row.folder else "Folder: (top level)")
    if row.doc_class:
        bits.append(f"Dokumentart: {row.doc_class}")
    if row.page_count:
        bits.append(f"{row.page_count} page{'' if row.page_count == 1 else 's'}")
    if row.tags:
        bits.append(f"Tags: {', '.join(row.tags)}")
    if row.topics:
        bits.append(f"Topics: {', '.join(row.topics)}")
    if row.captured_at:
        camera = f" (camera: {row.camera})" if row.camera else ""
        bits.append(f"taken {row.captured_at[:10]}{camera}")
    elif row.camera:
        bits.append(f"camera: {row.camera}")
    title_block = title_block_label(row.revision_facts)
    if title_block:
        bits.append(f"Plankopf: {title_block}")
    # A filed mail, in the words of the Verlauf's own headings: the sender's domain only when a
    # signature confirmed it, „Domain nicht bestätigt“ otherwise (ADR-0134, RT-S2).
    for mail_line in (mail_thread_label(row.mail_thread), mail_origin_label(row.mail_origin)):
        if mail_line:
            bits.append(mail_line)
    if mark:
        bits.append(mark)
    change = _change_bit(row)
    if change:
        bits.append(change)
    if row.added_at:
        bits.append(f"uploaded {row.added_at}")
    if show_shelf and row.shelf:
        bits.append(_SHELF_LABELS.get(row.shelf, row.shelf))
    summary = row.summary
    if len(summary) > MAX_SUMMARY_CHARS:
        summary = summary[: MAX_SUMMARY_CHARS - 1].rstrip() + "…"
    tail = f" — {summary}" if summary else ""
    return f"- {row.file_name} · {' · '.join(bits)}{tail}"


def _scope_of(listing: Listing) -> str:
    """Where a listing looked: the shelves, and the folder when one was asked for."""
    where = " and ".join(_SHELF_LABELS.get(shelf, shelf) for shelf in listing.shelves)
    return f'{where}, folder "{listing.folder}" with subfolders' if listing.folder else where


def _in_flight_line(in_flight: Sequence[str]) -> str:
    return (
        "Still processing (uploaded but not yet readable, so neither listed here nor searchable): "
        + ", ".join(in_flight[:10])
        + (f" and {len(in_flight) - 10} more" if len(in_flight) > 10 else "")
    )


def render_listing(listing: Listing, *, in_flight: Sequence[str] = ()) -> str:
    """The listing as the model reads it: counts first, then folders, then files."""
    scope = _scope_of(listing)
    lines: list[str] = [*listing.notes]
    if listing.notes and not listing.total:
        return "\n".join(lines)
    if not listing.total:
        lines.append(f"No file on {scope} matches these filters.")
    else:
        first = listing.offset + 1
        last = listing.offset + len(listing.rows)
        shown = f"{first}–{last}" if listing.rows else "none (offset is past the end)"
        lines.append(f"{listing.total} file(s) on {scope}; showing {shown}.")
        if listing.types:
            profile = " · ".join(f"{tag} {count}" for tag, count in listing.types[:MAX_TYPE_COUNTS])
            untyped = f"; without Dokumentart: {listing.untyped}" if listing.untyped else ""
            lines.append(f"Dokumentart (assigned by Piloti): {profile}{untyped}.")
        elif listing.untyped:
            # Said rather than left out: no line would read the same as "no profile".
            lines.append("Dokumentart: Piloti has assigned none of these files a Dokumentart.")
        if listing.topics:
            profile = " · ".join(f"{topic} {count}" for topic, count in listing.topics[:MAX_TOPIC_COUNTS])
            lines.append(f"Topics (recognised by Piloti): {profile}.")
        if listing.confirmed_replacements:
            lines.append(
                f"Fassungen (confirmed): a person replaced {listing.confirmed_replacements} file(s) with a "
                "newer one; the rows say which. Rely on the newer one and name the older one only when asked or "
                "when comparing. The older one stays readable with file_name=."
            )
        if listing.title_block_series:
            lines.append(
                f"Fassungen (Plankopf): {listing.title_block_series} document(s) carry the same document number in "
                "their Plankopf in several states (Index, date); the rows are marked. Rely on the current Fassung "
                "and name an older one only when asked or when comparing. It is a reading of the Plankopf, not a "
                'confirmation: say "by Plankopf".'
            )
        if listing.revision_series:
            lines.append(
                f"Fassungen: {listing.revision_series} document(s) exist in several Fassungen by file name (Index, "
                "date); the rows are marked. Rely on the current Fassung and name an older one only when asked or "
                "when comparing. It is a reading of the names, not a confirmation: "
                'say "by file name".'
            )

    if listing.subfolders:
        lines.append("")
        lines.append("Subfolders (files in the whole subtree):")
        for path, count in listing.subfolders[:MAX_FOLDER_LINES]:
            lines.append(f"- {path}/ ({count})")
        rest = len(listing.subfolders) - MAX_FOLDER_LINES
        if rest > 0:
            lines.append(f"- … and {rest} more folders")
        if listing.here:
            lines.append(f"Directly in this folder: {listing.here} file(s).")

    if listing.rows:
        lines.append("")
        lines.append("Files:")
        show_shelf = len(listing.shelves) > 1
        lines.extend(
            _row_line(row, show_shelf=show_shelf, mark=listing.revision_marks.get((row.collection, row.file_name)))
            for row in listing.rows
        )
        remaining = listing.total - (listing.offset + len(listing.rows))
        if remaining > 0:
            lines.append(
                f"… {remaining} more. Next page: the same call with `offset={listing.offset + len(listing.rows)}`."
            )

    if in_flight:
        lines.append("")
        lines.append(_in_flight_line(in_flight))

    lines.append("")
    lines.append(
        "An index, not a source: a row proves the file exists, not what it says. It shows only what Piloti could "
        "read; a file whose reading failed is not here but under `documents_unreadable:` in the project context, "
        "and a file missing here is no proof it does not exist. Write file names exactly as they appear here: the "
        "reader sees each as a link that opens the file. Read: `read_passage(document=…)`; search inside: "
        '`knowledge_search(file_name=…)`, literally with `match="exact"`; see a page: `look`.'
    )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# list_files(view="tree"): a card per folder
# ---------------------------------------------------------------------------

#: Levels of folders below the asked one that get a card, by default and at most.
DEFAULT_TREE_DEPTH = 2
MAX_TREE_DEPTH = 4
#: Cards one tree call renders before it counts the rest, and current Fassungen one card names.
MAX_TREE_CARDS = 30
MAX_CURRENT_LINES = 3
#: Subfolders a card names, and older files one "replaces" clause names.
MAX_CARD_SUBFOLDERS = 8
MAX_REPLACED_NAMES = 3
#: A folder holding at most this many documents directly names them on its card.
MAX_CARD_FILES = 8


@dataclass(frozen=True)
class FolderCard:
    """What one folder holds, counted from the rows alone: tier 0, nothing stored, nothing stale."""

    path: str
    #: Levels below the folder the call asked about (the asked folder is 0).
    depth: int
    #: Documents directly in the folder, and in the whole subtree (the direct ones included).
    direct: int
    total: int
    #: Child folders with their subtree counts.
    subfolders: tuple[tuple[str, int], ...]
    #: Document types over the subtree, most frequent first, and how many documents carry none.
    types: tuple[tuple[str, int], ...]
    untyped: int
    #: Pages summed over the documents that have a count, and how many have none.
    pages: int
    pages_unknown: int
    first_added: str | None
    last_added: str | None
    #: ``"name (date)"`` of the most recently added document, or empty.
    newest: str
    #: One line per series whose current Fassung is in the subtree, and how many older Fassungen it holds.
    current: tuple[str, ...]
    superseded: int
    #: ``"name (date)"`` of the document with the latest date of its own (Plankopf Stand, photo), or empty.
    newest_document: str = ""
    #: The names of the documents filed directly here when there are at most :data:`MAX_CARD_FILES`.
    files: tuple[str, ...] = ()


@dataclass(frozen=True)
class _Series:
    """A document in several Fassungen: the current one, what says so, and the names it replaces."""

    head: FileRow
    basis: str
    older: tuple[str, ...]


def _confirmed_head(row: FileRow, by_key: dict[_RowKey, FileRow]) -> FileRow | None:
    """The end of the confirmed chain ``row`` starts: A → B → C gives C. ``None`` for a chain that loops."""
    seen: set[_RowKey] = set()
    current = row
    while current.superseded_by and (current.collection, current.superseded_by) in by_key:
        seen.add((current.collection, current.file_name))
        current = by_key[(current.collection, current.superseded_by)]
        if (current.collection, current.file_name) in seen:
            return None
    return current


def _revision_series(rows: Sequence[FileRow]) -> list[_Series]:
    """Every series of Fassungen among ``rows``, by the same precedence ``select_files`` marks them.

    A person's confirmation beats the title block, which beats the file name. A confirmed chain
    A → B → C is ONE series headed by C: B is not current because something replaces it. A
    title-block or name series whose head a person confirmed as replaced joins the series of the
    chain's end, so no file a person marked as replaced is ever called current.
    """
    by_key = {(row.collection, row.file_name): row for row in rows}
    confirmed = confirmed_revision_marks(rows)
    heads: dict[_RowKey, _RowKey] = {}
    for row in rows:
        if row.superseded_by and (row.collection, row.superseded_by) in by_key:
            head = _confirmed_head(row, by_key)
            if head is not None:
                heads[(row.collection, row.file_name)] = (head.collection, head.file_name)
    replaced: dict[_RowKey, list[str]] = {}
    for key, head_key in heads.items():
        replaced.setdefault(head_key, []).append(key[1])
    _, block_series_of = title_block_marks(rows)
    _, name_series_of = revision_marks(rows)
    grouped: list[tuple[str, dict[_RowKey, list[str]]]] = []
    for basis, series_of, skip in (
        ("by Plankopf", block_series_of, set(confirmed)),
        ("by file name", name_series_of, set(confirmed) | set(block_series_of)),
    ):
        groups: dict[_RowKey, list[str]] = {}
        for key, head_key in series_of.items():
            if key == head_key or key in skip:
                continue
            if head_key in heads:
                replaced.setdefault(heads[head_key], []).append(key[1])
            else:
                groups.setdefault(head_key, []).append(key[1])
        grouped.append((basis, groups))
    series = [_Series(by_key[head], "confirmed", tuple(sorted(names, key=fold))) for head, names in replaced.items()]
    for basis, groups in grouped:
        series += [_Series(by_key[head], basis, tuple(sorted(names, key=fold))) for head, names in groups.items()]
    return series


def _series_label(head: FileRow, basis: str) -> str:
    """``Index B, Stand 03.02.2026; by Plankopf``: the state the current file carries, and what says it is current."""
    facts = head.revision_facts or {}
    state = _state_label(facts) if facts.get("revision") or facts.get("revision_date") else ""
    if not state:
        name_revision = parse_revision_name(head.file_name)
        state = revision_label(name_revision) if name_revision is not None else ""
    return "; ".join(part for part in (state, basis) if part)


def _current_lines(series: Sequence[_Series], keys: set[_RowKey]) -> tuple[list[str], int]:
    """The ``Current Fassung`` lines for the series whose current file is among ``keys``, and the older files held."""
    lines: list[str] = []
    older_held = 0
    for entry in sorted(series, key=lambda item: fold(item.head.file_name)):
        collection = entry.head.collection
        older_held += sum(1 for name in entry.older if (collection, name) in keys)
        if (collection, entry.head.file_name) not in keys:
            continue
        shown = ", ".join(entry.older[:MAX_REPLACED_NAMES])
        more = len(entry.older) - MAX_REPLACED_NAMES
        replaces = f"{shown} and {more} more" if more > 0 else shown
        lines.append(f"{entry.head.file_name} ({_series_label(entry.head, entry.basis)}) replaces {replaces}")
    return lines, older_held


def _folder_card(path: str, depth: int, rows: Sequence[FileRow], series: Sequence[_Series]) -> FolderCard:
    subfolders, direct = _subfolders(rows, path or None)
    types, untyped = _type_profile(rows)
    dated = [row for row in rows if row.added_at]
    newest = max(dated, key=lambda row: (row.added_at or "", fold(row.file_name)), default=None)
    current, older_held = _current_lines(series, {(row.collection, row.file_name) for row in rows})
    own_dated = [row for row in rows if row.document_date]
    newest_own = max(own_dated, key=lambda row: (row.document_date or "", fold(row.file_name)), default=None)
    direct_rows = sorted((row for row in rows if row.folder == path), key=lambda row: fold(row.file_name))
    return FolderCard(
        path=path,
        depth=depth,
        direct=direct,
        total=len(rows),
        subfolders=tuple(subfolders),
        types=tuple(types),
        untyped=untyped,
        pages=sum(row.page_count or 0 for row in rows),
        pages_unknown=sum(1 for row in rows if row.page_count is None),
        first_added=min((row.added_at or "" for row in dated), default=None),
        last_added=max((row.added_at or "" for row in dated), default=None),
        newest=f"{newest.file_name} ({newest.added_at})" if newest else "",
        newest_document=f"{newest_own.file_name} ({newest_own.document_date})" if newest_own else "",
        files=tuple(row.file_name for row in direct_rows) if 0 < len(direct_rows) <= MAX_CARD_FILES else (),
        current=tuple(current),
        superseded=older_held,
    )


def _card_ancestors(folder: str, root: str, depth: int) -> list[str]:
    """``root`` and every folder from it down to ``folder``, no deeper than ``depth`` below ``root``."""
    base = len(root.split("/")) if root else 0
    parts = folder.split("/") if folder else []
    return ["/".join(parts[:count]) for count in range(base, min(len(parts), base + depth) + 1)]


def _card_order(card: FolderCard) -> list[str]:
    """Parents before children, siblings by name."""
    return [fold(part) for part in card.path.split("/")] if card.path else []


def folder_cards(
    rows: Sequence[FileRow],
    *,
    root: str | None,
    depth: int = DEFAULT_TREE_DEPTH,
    series_rows: Sequence[FileRow] | None = None,
) -> list[FolderCard]:
    """One card for ``root`` and for every folder up to ``depth`` levels below it, parents first.

    Pure, and one pass over the rows: each row is folded into every card above
    it. ``rows`` are the selection (already inside ``root``); the Fassungen are
    read over ``series_rows`` when given, because an older Fassung is often
    filed in a folder the selection cut away.
    """
    root = root or ""
    depth = max(0, min(depth, MAX_TREE_DEPTH))
    members: dict[str, list[FileRow]] = {}
    for row in rows:
        for path in _card_ancestors(row.folder, root, depth):
            members.setdefault(path, []).append(row)
    series = _revision_series(series_rows if series_rows is not None else rows)
    base = len(root.split("/")) if root else 0
    cards = [
        _folder_card(path, (len(path.split("/")) if path else 0) - base, group, series)
        for path, group in members.items()
    ]
    return sorted(cards, key=_card_order)


def _count(number: int, noun: str) -> str:
    return f"{number} {noun}{'' if number == 1 else 's'}"


def abstract_lines(found: Mapping[tuple[str, str], Any]) -> dict[str, list[str]]:
    """The written (tier-1) abstracts by folder path, one ``About:`` line per collection that has one.

    ``found`` maps ``(collection, folder_path)`` to what
    ``aiq_agent.knowledge.folder_cards.listing_abstracts`` read: ``abstract``,
    ``status``, ``generated_at``. A card that is not fresh says so and since when.
    """
    lines: dict[str, list[str]] = {}
    for (_collection, path), card in sorted(found.items()):
        line = f"About: {card.abstract}"
        if card.status != "fresh":
            written = f", written {str(card.generated_at)[:10]}" if card.generated_at else ""
            line += f" ({card.status}{written})"
        lines.setdefault(path, []).append(line)
    return lines


def _card_lines(card: FolderCard, about: Sequence[str] = ()) -> list[str]:
    """One card as the model reads it: counts, the written abstract, document types, dates, Fassungen, subfolders."""
    older = f"; {card.superseded} older Fassung{'' if card.superseded == 1 else 'en'}" if card.superseded else ""
    here = f"{card.direct} here, {card.total - card.direct} below{older}" if card.subfolders else f"all here{older}"
    head = f"{card.path}/" if card.path else "Top level"
    head += f"  {_count(card.total, 'document')} ({here})"
    if card.subfolders:
        head += f", {_count(len(card.subfolders), 'subfolder')}"
    if card.pages:
        head += f", {_count(card.pages, 'page')}"
        head += f" ({card.pages_unknown} without count)" if card.pages_unknown else ""
    lines = [head, *(f"  {line}" for line in about)]
    types = [f"{tag} {count}" for tag, count in card.types[:MAX_TYPE_COUNTS]]
    if card.untyped:
        types.append(f"untyped {card.untyped}")
    lines.append(f"  Dokumentart: {' · '.join(types)}")
    if card.first_added:
        span = card.first_added if card.first_added == card.last_added else f"{card.first_added} to {card.last_added}"
        # Two different dates: the upload day says when it reached the office, the document's own date
        # (Plankopf Stand, photo) says how old the content is. "Newest" names which one it means.
        if card.newest_document:
            lines.append(f"  Added: {span}. Newest by document date (Plankopf Stand or photo): {card.newest_document}")
        else:
            lines.append(f"  Added: {span}. Newest upload (no document date known): {card.newest}")
    if card.files:
        lines.append(f"  Files here: {' · '.join(card.files)}")
    elif card.direct > MAX_CARD_FILES:
        call = f'`list_files(folder="{card.path}")`' if card.path else "`list_files()`"
        lines.append(
            f"  Files here: {card.direct}, too many to name (a card names them up to {MAX_CARD_FILES}); "
            f"{call} lists them."
        )
    lines.extend(f"  Current Fassung: {line}" for line in card.current[:MAX_CURRENT_LINES])
    if len(card.current) > MAX_CURRENT_LINES:
        lines.append(f"  … and {len(card.current) - MAX_CURRENT_LINES} more documents with several Fassungen")
    if card.subfolders:
        names = [f"{path.rsplit('/', 1)[-1]}/ ({count})" for path, count in card.subfolders[:MAX_CARD_SUBFOLDERS]]
        rest = len(card.subfolders) - MAX_CARD_SUBFOLDERS
        lines.append(f"  Subfolders: {' · '.join(names)}{f' · and {rest} more' if rest > 0 else ''}")
    indent = "  " * card.depth
    return [indent + line for line in lines]


def render_tree(
    cards: Sequence[FolderCard],
    *,
    total_rows: int,
    notes: Sequence[str] = (),
    scope: str = "",
    in_flight: Sequence[str] = (),
    abstracts: Mapping[str, Sequence[str]] | None = None,
) -> str:
    """The folder tree as the model reads it: a card per folder, bounded, ending with how to go on.

    ``abstracts`` are the written cards' ``About:`` lines by folder path (:func:`abstract_lines`).
    """
    abstracts = abstracts or {}
    lines: list[str] = [*notes]
    if not cards:
        if not notes:
            lines.append(f"No file{f' on {scope}' if scope else ''} matches these filters.")
        return "\n".join(lines)
    lines.append(f"{_count(total_rows, 'document')}{f' on {scope}' if scope else ''}, as folder cards:")
    shown = sorted(
        sorted(cards, key=lambda card: (card.depth, -card.total, _card_order(card)))[:MAX_TREE_CARDS], key=_card_order
    )
    for card in shown:
        lines.extend(_card_lines(card, abstracts.get(card.path, ())))
    hidden = len(cards) - len(shown)
    if hidden:
        lines.append(
            f"… {_count(hidden, 'folder')} not shown (the {MAX_TREE_CARDS} largest of the shallowest levels are). "
            'Open one with `list_files(folder="…", view="tree")`.'
        )
    if in_flight:
        lines.append(_in_flight_line(in_flight))
    lines.append(
        'The files of a folder: `list_files(folder="…")`. An index, not a source: never cite it; '
        "open a document with read_passage."
    )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# The Fassungen of one document (list_files revisions_of=)
# ---------------------------------------------------------------------------

#: Fassungen one answer lists before it counts the rest.
MAX_CHAIN_LINES = 30
#: Different documents one name may match before the answer asks for the exact name.
MAX_CHAIN_CANDIDATES = 8

_EXTENSION = re.compile(r"\.([a-z0-9]{1,5})\Z", re.IGNORECASE | re.ASCII)


def _series_ident(file_name: str) -> tuple[str, str]:
    """What Fassungen of one document share on the name: the key without index and date, and the format.

    A PDF and a DWG of one Fassung are not versions of each other, and a first
    state with neither index nor date (``Grundriss EG.pdf``) shares the key of
    its indexed successor (``Grundriss EG Index B.pdf``).
    """
    extension = _EXTENSION.search(file_name.strip())
    return series_key_of(file_name), extension.group(1).lower() if extension else ""


def _chain_members(rows: Sequence[FileRow], start: FileRow) -> list[FileRow]:
    """Every file of ``start``'s collection that is a Fassung of the same document, in no order.

    Three things connect files: a link a PERSON confirmed (``superseded_by``,
    followed in both directions through any number of steps), the same
    ``document_number`` in the title blocks (Plankopf), and the file name's own
    series (:func:`_series_ident`). All are followed transitively, so a confirmed
    link joins a differently named older document to a name series.
    """
    same = [row for row in rows if row.collection == start.collection]
    by_name = {row.file_name: row for row in same}
    neighbours: dict[str, set[str]] = {name: set() for name in by_name}
    for row in same:
        if row.superseded_by and row.superseded_by in by_name and row.superseded_by != row.file_name:
            neighbours[row.file_name].add(row.superseded_by)
            neighbours[row.superseded_by].add(row.file_name)
    groups: dict[tuple[str, ...], list[str]] = {}
    for row in same:
        groups.setdefault(("name", *_series_ident(row.file_name)), []).append(row.file_name)
        number = document_key((row.revision_facts or {}).get("document_number"))
        if number is not None:
            groups.setdefault(("plankopf", number), []).append(row.file_name)
    for names in groups.values():
        for name in names:
            neighbours[name].update(other for other in names if other != name)
    seen = {start.file_name}
    queue = [start.file_name]
    while queue:
        for other in neighbours[queue.pop()]:
            if other not in seen:
                seen.add(other)
                queue.append(other)
    return [by_name[name] for name in sorted(seen, key=fold)]


def _with_supersedes(members: Sequence[FileRow]) -> list[FileRow]:
    """The members with ``supersedes`` read off ``superseded_by``, the one fact a link is stored as."""
    return [
        replace(row, supersedes=tuple(sorted(old.file_name for old in members if old.superseded_by == row.file_name)))
        for row in members
    ]


def _by_title_block(members: Sequence[FileRow]) -> bool:
    """Whether every member's title block states an Index or a date, so the sheets themselves can be compared."""
    return len(members) > 1 and all(
        (row.revision_facts or {}).get("revision") or (row.revision_facts or {}).get("revision_date") for row in members
    )


def _sheet_order(members: Sequence[FileRow]) -> list[str]:
    """The members' file names, newest state first by what their title blocks print."""
    ordered = newest_first(members, lambda row: row.revision_facts, lambda row: row.added_at or "")
    return [row.file_name for row in ordered]


def _name_order(members: Sequence[FileRow]) -> list[str]:
    """The members whose NAME carries an Index or a date, newest first (the folder brief's grammar)."""
    names: list[str] = []
    for series in find_revision_series(
        [row for row in members if parse_revision_name(row.file_name)],
        filename=lambda row: row.file_name,
        created_at=lambda row: row.added_at,
    ):
        names += [series.current.item.file_name, *(entry.item.file_name for entry in series.older)]
    return names


def _chain_order(members: Sequence[FileRow]) -> list[FileRow]:
    """Newest first: a confirmed replacement always precedes what it replaced, the names order the rest.

    When every member's title block states an Index or a date, that is the order
    (what the office printed on the sheet beats the file name, ``title_block.newest_first``).
    Otherwise it is the name order, the folder brief's (``find_revision_series``); a file
    whose name carries neither index nor date is the first state of the
    document, so it follows the others, by upload date.
    """
    names_order = _sheet_order(members) if _by_title_block(members) else _name_order(members)
    rest = sorted((row for row in members if row.file_name not in names_order), key=lambda row: fold(row.file_name))
    rest.sort(key=lambda row: row.added_at or "", reverse=True)
    position = {name: index for index, name in enumerate([*names_order, *(row.file_name for row in rest)])}

    pending = sorted(members, key=lambda row: position[row.file_name])
    ordered: list[FileRow] = []
    while pending:
        # Ready: the file that replaced it is already out (or is not among these). A loop, which the store
        # refuses, would leave none ready and then emits in name order.
        waiting = {row.file_name for row in pending}
        ready = [row for row in pending if row.superseded_by not in waiting]
        row = (ready or pending)[0]
        pending.remove(row)
        ordered.append(row)
    return ordered


def _chain_line(position: int, row: FileRow, *, current: bool, mark: str | None, basis: str) -> str:
    """One Fassung: the Index and date its name carries, its Plankopf, who vouches for its place, upload, change.

    ``basis`` is what ordered the chain when no person confirmed the row: "by Plankopf" or "by file name".
    """
    revision = parse_revision_name(row.file_name)
    label = revision_label(revision) if revision is not None else ""
    bits = [label or "no Index and no date in the name"]
    title_block = title_block_label(row.revision_facts)
    if title_block:
        bits.append(f"Plankopf: {title_block}")
    if current:
        bits.append("current Fassung" + ("" if mark else f" ({basis})"))
    elif not mark:
        bits.append(f"older Fassung ({basis})")
    if mark:
        bits.append(mark)
    if row.added_at:
        bits.append(f"uploaded {row.added_at}")
    text = _change_text(row, MAX_CHAIN_CHANGE_CHARS)
    if text and _compared_with_own_upload(row):
        bits.append(f"changed against its previous upload (same file name): {text}")
    elif text and row.change_basis:
        bits.append(f"changed against {row.change_basis}: {text}")
    elif text:
        bits.append(f"changed: {text}")
    else:
        bits.append("no change note stored")
    return f"{position}. {row.file_name} · {' · '.join(bits)}"


def _chain_candidates(rows: Sequence[FileRow], wanted: str) -> list[FileRow]:
    """The files ``wanted`` names: an exact file name or title first, else every file whose name has all its words."""
    folded = fold(wanted.strip())
    exact = [row for row in rows if folded in (fold(row.file_name), fold(row.display_title or ""))]
    if exact:
        return exact
    words = set(_words(wanted))
    return [row for row in rows if words and words <= set(row.searchable.split())]


def _resolve_chain(
    rows: Sequence[FileRow],
    wanted: str,
    *,
    shelf: str | None,
    default_shelves: Sequence[str],
) -> tuple[list[FileRow], str]:
    """The ordered chain of Fassungen ``wanted`` names, newest first, or the sentence that says why there is none.

    One lookup for the listing (:func:`render_revisions`) and the compare
    (:func:`resolve_compare`), so the two cannot disagree about which document
    a name means.
    """
    shelves = (shelf,) if shelf else tuple(default_shelves)
    scoped = [row for row in rows if row.shelf in shelves or (not shelf and row.shelf is None)]
    where = " and ".join(_SHELF_LABELS.get(name, name) for name in shelves)
    matches = _chain_candidates(scoped, wanted)
    if not matches:
        return [], (
            f'No file on {where} is named or contains "{wanted.strip()}". Find the exact name with '
            "`list_files(name_contains=…)`."
        )
    chains: dict[frozenset[tuple[str, str]], list[FileRow]] = {}
    for row in matches:
        members = _chain_members(scoped, row)
        chains.setdefault(frozenset((member.collection, member.file_name) for member in members), members)
    if len(chains) > 1:
        names = [row.file_name for row in matches[:MAX_CHAIN_CANDIDATES]]
        rest = len(matches) - len(names)
        return [], (
            f'"{wanted.strip()}" matches {len(chains)} different documents: {", ".join(names)}'
            f"{f' and {rest} more' if rest > 0 else ''}. Call `list_files(revisions_of=…)` with the exact "
            "file name of one of them."
        )
    return _chain_order(_with_supersedes(next(iter(chains.values())))), ""


def render_revisions(
    rows: Sequence[FileRow],
    wanted: str,
    *,
    shelf: str | None = None,
    default_shelves: Sequence[str] = USER_SHELVES,
) -> str:
    """The whole chain of Fassungen of the document ``wanted`` names, newest first, as the model reads it.

    Pure, over the rows the turn may list and nothing else: the same shelves
    ``select_files`` lists, so a Fassung on a shelf this turn did not ask for,
    or a file nobody may name, is not in the chain. The chain spans folders (an
    older Fassung is often filed under ``alt/``) and ignores every other filter.
    """
    members, refusal = _resolve_chain(rows, wanted, shelf=shelf, default_shelves=default_shelves)
    if refusal:
        return refusal
    confirmed = confirmed_revision_marks(members)
    where = " and ".join(dict.fromkeys(_SHELF_LABELS.get(row.shelf or "", row.shelf or "") for row in members))
    basis = "by Plankopf" if _by_title_block(members) else "by file name"
    asked = wanted.strip()
    lines = [
        f'Fassungen of "{asked}" on {where}: {len(members)} files, newest first.'
        if len(members) > 1
        else f'"{asked}" on {where}: only this one Fassung.'
    ]
    for number, row in enumerate(members[:MAX_CHAIN_LINES], start=1):
        lines.append(
            _chain_line(
                number, row, current=number == 1, mark=confirmed.get((row.collection, row.file_name)), basis=basis
            )
        )
    if len(members) > MAX_CHAIN_LINES:
        lines.append(f"… and {len(members) - MAX_CHAIN_LINES} more, older Fassungen.")
    if len(members) == 1:
        lines.append(
            "No other file name on this shelf belongs to it by name (Index, date), and no person has confirmed a "
            "replacement. If the same file was uploaded again, the row says so as a change against the previous "
            "upload."
        )
        return "\n".join(lines)
    lines.append(
        "The change note sits on the NEWER Fassung and compares it with the base named beside it; between two "
        "Fassungen that are not neighbours, read the rows in between together. It is a summary by Piloti, not "
        "proof: what changed page by page is shown by `list_files(revisions_of=…, compare_to=…)`, and you check a "
        "measurement with `read_passage(document=…)`. An older Fassung stays readable on request; otherwise rely "
        "on the current one. Write file names exactly as they appear here."
    )
    return "\n".join(lines)


#: What ``compare_to`` may say to mean "the Fassung right before this one".
_PREVIOUS_WORDS = frozenset({"", "vorige", "vorherige", "letzte", "previous", "prev"})


def resolve_compare(
    rows: Sequence[FileRow],
    wanted: str,
    compare_to: str | None,
    *,
    shelf: str | None = None,
    default_shelves: Sequence[str] = USER_SHELVES,
) -> tuple[FileRow | None, FileRow | None, str]:
    """``(older, newer, "")`` for ``list_files(revisions_of=…, compare_to=…)``, or ``(None, None, refusal)``.

    ``wanted`` names the document and, when it names one Fassung exactly, that
    Fassung; otherwise the current one. ``compare_to`` names the other Fassung
    in the same chain, or says "previous" (the default) for the one right before.
    Pure, over the rows the turn may list, like :func:`render_revisions`.
    """
    members, refusal = _resolve_chain(rows, wanted, shelf=shelf, default_shelves=default_shelves)
    if refusal:
        return None, None, refusal
    if len(members) < 2:
        return (
            None,
            None,
            (
                f'Of "{wanted.strip()}" there is only this one file on this shelf, so there is nothing to compare. '
                "Earlier uploads under the SAME file name are not in the index yet; what changed there is in the "
                "change note of `list_files(revisions_of=…)`."
            ),
        )
    exact = [row for row in members if fold(wanted.strip()) in (fold(row.file_name), fold(row.display_title or ""))]
    anchor = exact[0] if len(exact) == 1 else members[0]
    position = members.index(anchor)
    target = (compare_to or "").strip()
    if fold(target) in _PREVIOUS_WORDS:
        other = members[position + 1] if position + 1 < len(members) else members[position - 1]
    else:
        candidates = _chain_candidates(members, target)
        names = ", ".join(row.file_name for row in members[:MAX_CHAIN_CANDIDATES])
        if not candidates:
            return None, None, f'"{target}" is not a Fassung of this document. Its Fassungen: {names}.'
        if len(candidates) > 1:
            return None, None, f'"{target}" matches several Fassungen; name one exactly: {names}.'
        other = candidates[0]
    if other is anchor:
        return None, None, "That is the same file twice. Name a different Fassung in `compare_to`."
    newer, older = (anchor, other) if position < members.index(other) else (other, anchor)
    return older, newer, ""


def _change_line_between(older: FileRow, newer: FileRow) -> str | None:
    """The stored change summary, only when it was written against exactly this older file."""
    if newer.change_summary and newer.change_basis == older.file_name:
        return newer.change_summary
    return None


def _stored_chunks(collection: str, file_name: str) -> list[Any] | None:
    """Both Fassungen are read from what the index holds: blocking, so the tool runs it on a thread.

    None when the index holds no chunk of the file; raises when the store cannot be read.
    """
    from aiq_agent.knowledge.collection_pages import read_chunks
    from aiq_agent.knowledge.revision_diff import chunk_from_store

    stored = read_chunks(collection, file_name)
    if stored is None:
        return None
    return [chunk for text, meta in stored if (chunk := chunk_from_store(text, meta)) is not None]


async def compare_revisions(older: FileRow, newer: FileRow) -> str:
    """The compare of two Fassungen the turn may list, from their stored chunks and title blocks (ADR-0104)."""
    from aiq_agent.common.turn_status import FETCH_FAILED_MARKER
    from aiq_agent.knowledge.restricted_use import note_collections_read
    from aiq_agent.knowledge.revision_diff import diff_revisions
    from aiq_agent.knowledge.revision_diff import render_diff

    try:
        older_chunks, newer_chunks = await asyncio.gather(
            asyncio.to_thread(_stored_chunks, older.collection, older.file_name),
            asyncio.to_thread(_stored_chunks, newer.collection, newer.file_name),
        )
    except Exception:  # noqa: BLE001 - an outage is said as one, never as "not in the index"
        logger.warning("compare_revisions: the index did not answer", exc_info=True)
        # Marked like read_passage's failed fetch, so a retry is not refused as a repeat.
        return (
            f'{FETCH_FAILED_MARKER} The index is not reachable right now; "{older.file_name}" and '
            f'"{newer.file_name}" were not compared. Try once more; if it fails again, say so and claim no '
            "difference."
        )
    missing = [row.file_name for row, chunks in ((older, older_chunks), (newer, newer_chunks)) if chunks is None]
    if missing:
        names = " and ".join(f'"{name}"' for name in missing)
        return (
            f"The read content of {names} is not in the index, "
            "so nothing can be compared. If the file is still being read, try again later."
        )
    # The report quotes both files' content: reported for the restricted-use
    # admission (ADR-0088), as every read of a document's text is.
    note_collections_read({older.collection, newer.collection})
    diff = diff_revisions(
        older_chunks or [],
        newer_chunks or [],
        older_facts=older.revision_facts,
        newer_facts=newer.revision_facts,
    )
    return render_diff(diff, older.file_name, newer.file_name, change_summary=_change_line_between(older, newer))


# ---------------------------------------------------------------------------
# The exact search (knowledge_search match="exact")
# ---------------------------------------------------------------------------


def split_alternatives(text: str) -> list[str]:
    """``"BA-03 | BA 03"`` → ``["BA-03", "BA 03"]``; empty, too-short and letterless parts dropped.

    A part without a letter or digit („--“) would match every separator run.
    """
    parts = [" ".join(part.split()) for part in unicodedata.normalize("NFC", text or "").split("|")]
    kept = [part for part in dict.fromkeys(parts) if len(part) >= MIN_PHRASE_CHARS and re.search(r"\w", part)]
    return kept[:MAX_ALTERNATIVES]


#: What stands between two words in extracted text: whitespace (a line break,
#: a double space, NBSP — ``\s`` is Unicode-aware in Python's ``re`` and in
#: Rust's ``regex`` alike), a hyphen, a non-breaking hyphen, an en dash, a soft
#: hyphen. A run of any of them in the phrase matches a run of any of them in
#: the text, so „OIB Richtlinie“ finds „OIB-Richtlinie“ and „Brandabschnitt 3“
#: finds „Brandabschnitt⏎3“. The ``-`` stands last so neither dialect reads a range.
_SEPARATOR_CHARS = "\u00ad\u2010\u2011\u2013-"
_SEPARATOR = f"[\\s{_SEPARATOR_CHARS}]+"

#: One German letter and its ASCII transliteration are one letter to a reader.
#: Either spelling in the phrase matches both in the text (and a decomposed
#: umlaut, ``a`` + U+0308, which some PDF text layers carry). Case is the
#: pattern's ``(?i)``, so „AE“ and „Ä“ are covered by the same group.
_EQUIVALENT = {
    "ä": "(?:ä|a\u0308|ae)",
    "ö": "(?:ö|o\u0308|oe)",
    "ü": "(?:ü|u\u0308|ue)",
    "ß": "(?:ß|ss)",
}
_EQUIVALENT.update({"ae": _EQUIVALENT["ä"], "oe": _EQUIVALENT["ö"], "ue": _EQUIVALENT["ü"], "ss": _EQUIVALENT["ß"]})

#: A phrase is read left to right as separator runs, transliteration digraphs
#: and single characters; ``ae`` wins over ``a`` + ``e``.
_TOKEN = re.compile(f"[\\s{_SEPARATOR_CHARS}]+|ae|oe|ue|ss|.", re.DOTALL)

#: A phrase this short matches as a whole word only: „EG“ is inside „Weg“,
#: „Steg“ and „Regel“, and a count of those is not an answer to „wo steht EG“.
#: Four characters („BA03“, „T30-2“) are specific enough to match inside a word.
#: The boundary goes only on an edge that is a word character, so „§ 5“ still
#: matches after a space. ``\b`` is Unicode-aware in both dialects.
WHOLE_WORD_MAX_CHARS = 3

#: A bound on the pattern the store compiles. A phrase expands about fourfold
#: (every umlaut and separator becomes a group), so this admits six
#: alternatives of well over a hundred characters: a sentence, not a phrase.
MAX_PATTERN_CHARS = 4000


def _phrase_pattern(phrase: str) -> str:
    """One phrase as a regex body: separators, umlaut spellings, whole word when short."""
    text = unicodedata.normalize("NFC", phrase).lower()
    body = "".join(
        _SEPARATOR if token[0].isspace() or token[0] in _SEPARATOR_CHARS else _EQUIVALENT.get(token, re.escape(token))
        for token in _TOKEN.findall(text)
    )
    if len(text) > WHOLE_WORD_MAX_CHARS:
        return body
    start = "\\b" if re.match(r"\w", text[0]) else ""
    end = "\\b" if re.match(r"\w", text[-1]) else ""
    return f"{start}{body}{end}"


#: German inflectional endings :func:`inflection_stem` strips, longest first.
_INFLECTION_ENDINGS = ("ern", "nen", "en", "er", "es", "em", "e", "n", "s")
#: Words shorter than this keep their form: a code, an abbreviation, a short word is matched as written.
_INFLECTED_MIN_CHARS = 5
#: What a stripped word must keep.
_STEM_MIN_CHARS = 4


def inflection_stem(phrase: str) -> str:
    """``phrase`` with each long word's inflectional ending removed: the stem the count and the context lines look for.

    A Python approximation of the stemmed index's Snowball German, for counting
    and showing the matches that index found („Fluchtwegbreiten“ → „Fluchtwegbreit“,
    which the substring pattern then finds in „Fluchtwegbreite“ and „Fluchtwegbreiten“).
    Which chunks match is decided by the index, never by this.
    """
    words = []
    for word in phrase.split():
        stem = word
        if len(word) >= _INFLECTED_MIN_CHARS and word.isalpha():
            for ending in _INFLECTION_ENDINGS:
                if word.lower().endswith(ending) and len(word) - len(ending) >= _STEM_MIN_CHARS:
                    stem = word[: -len(ending)]
                    break
        words.append(stem)
    return " ".join(words)


def stemmed_pattern(phrases: Sequence[str]) -> str | None:
    """The counting pattern of a stemmed search: each phrase and its stem (the phrases alone when too long)."""
    stems = [inflection_stem(phrase) for phrase in phrases]
    return phrase_pattern([*phrases, *stems]) or phrase_pattern(phrases)


def phrase_pattern(phrases: Sequence[str]) -> str | None:
    """The ONE case-insensitive regex that finds any of ``phrases``, or None when it is too long.

    It is written to mean the same in Rust's ``regex`` and Python's ``re``
    (``qdrant.retrieval.find_text`` narrows by its literal words on the server
    and applies it in Python), so it keeps to what both dialects read alike:
    ``(?i)`` at the start, non-capturing groups, classes, ``\\s``, ``\\b``,
    escaped literals; no lookaround, no backreference. Longest phrase
    first, so at one position „Brandschutzplan“ is taken before „Brandschutz“
    and a match is counted once however many alternatives it satisfies.
    """
    ordered = sorted(dict.fromkeys(phrases), key=len, reverse=True)
    pattern = "(?i)" + "|".join(_phrase_pattern(phrase) for phrase in ordered)
    return pattern if len(pattern) <= MAX_PATTERN_CHARS and ordered else None


def _occurrences(body: str, pattern: Any, timeout: float | None = None) -> int:
    """Non-empty, non-overlapping matches: one place in the text counts once, whichever alternative found it."""
    if timeout is None:
        return sum(1 for match in pattern.finditer(body) if match.end() > match.start())
    return sum(1 for match in pattern.finditer(body, timeout=timeout) if match.end() > match.start())


def _matched_strings(body: str, pattern: Any, timeout: float | None = None) -> list[str]:
    """The text of every non-empty match, whitespace collapsed (a match across a line break reads as one line)."""
    found = pattern.finditer(body) if timeout is None else pattern.finditer(body, timeout=timeout)
    return [" ".join(match.group().split()) for match in found if match.end() > match.start()]


@dataclass
class FileMatches:
    """Every matching chunk of one file."""

    file_name: str
    shelf: str | None
    collection: str
    chunks: list[Any] = field(default_factory=list)
    occurrences: int = 0
    #: A regex search only: per distinct matched string (case-folded), ``[spelling, count, pages]``.
    strings: dict[str, list[Any]] = field(default_factory=dict)
    #: True once the file had more distinct strings than :data:`MAX_TRACKED_STRINGS`.
    strings_cut: bool = False

    def note_strings(self, found: Sequence[str], page: int | None) -> None:
        for text in found:
            entry = self.strings.get(fold(text))
            if entry is None:
                if len(self.strings) >= MAX_TRACKED_STRINGS:
                    self.strings_cut = True
                    continue
                entry = self.strings[fold(text)] = [text, 0, set()]
            entry[1] += 1
            if page:
                entry[2].add(page)

    @property
    def pages(self) -> list[int]:
        return sorted({chunk.page_number for chunk in self.chunks if getattr(chunk, "page_number", None)})


def group_matches(
    chunks: Iterable[Any],
    pattern: Any,
    *,
    timeout: float | None = None,
    store_decides: bool = False,
    deadline: float | None = None,
    collect_strings: bool = False,
) -> list[FileMatches]:
    """Chunks the :func:`phrase_pattern` really matches, grouped per file, most occurrences first.

    The same pattern the store filtered with, compiled here: what the store
    returned and what is counted cannot disagree about what a match is. A
    person's regex arrives compiled, with the timeout it ran under.

    ``store_decides`` (a stemmed search) keeps every chunk the store returned:
    the stemmed index matched it, so it counts at least once even where the
    counting pattern's approximation of the stem finds no place in it.

    ``deadline`` (a ``time.monotonic()`` instant, with ``timeout``) bounds the
    whole count: each chunk's timeout shrinks to what is left, and
    ``TimeoutError`` is raised once nothing is.

    ``collect_strings`` (a regex search) also records each distinct matched string per file, for
    :func:`distinct_matches`.
    """
    compiled = pattern if hasattr(pattern, "finditer") else re.compile(pattern)
    groups: dict[tuple[str, str], FileMatches] = {}
    for chunk in chunks:
        if deadline is not None and timeout is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("the count ran out of time")
            timeout = min(timeout, remaining)
        body = getattr(chunk, "content", "") or ""
        found: list[str] = _matched_strings(body, compiled, timeout) if collect_strings else []
        count = len(found) if collect_strings else _occurrences(body, compiled, timeout)
        if store_decides:
            count = max(count, 1)
        if not count:
            continue
        metadata = getattr(chunk, "metadata", None) or {}
        collection = str(metadata.get("collection") or "")
        key = (collection, chunk.file_name)
        group = groups.get(key)
        if group is None:
            group = groups[key] = FileMatches(
                chunk.file_name,
                canonical_shelf_value(str(metadata["shelf"])) if metadata.get("shelf") else None,
                collection,
            )
        group.chunks.append(chunk)
        group.occurrences += count
        if found:
            group.note_strings(found, getattr(chunk, "page_number", None))
    # The reader's own files first: „wo steht EI 90" is about the project, and
    # the OIB corpus says EI 90 on a hundred pages.
    ordered = sorted(
        groups.values(), key=lambda group: (group.shelf == "base", -group.occurrences, fold(group.file_name))
    )
    for group in ordered:
        group.chunks.sort(key=lambda chunk: (getattr(chunk, "page_number", None) or 0, chunk.chunk_id))
    return ordered


def pick_passages(groups: Sequence[FileMatches], limit: int = MAX_MATCH_PASSAGES) -> list[Any]:
    """Round-robin over the files, best-covered first: the first match of each, then the second."""
    picked: list[Any] = []
    depth = 0
    while len(picked) < limit and any(depth < len(group.chunks) for group in groups):
        for group in groups:
            if depth < len(group.chunks) and len(picked) < limit:
                picked.append(group.chunks[depth])
        depth += 1
    return picked


def _pages_label(pages: Sequence[int], limit: int = 12) -> str:
    if not pages:
        return ""
    shown = ", ".join(str(page) for page in pages[:limit])
    more = f" … (+{len(pages) - limit})" if len(pages) > limit else ""
    return f", p. {shown}{more}"


def _shorten(text: str, limit: int) -> str:
    return text if len(text) <= limit else f"{text[: limit - 1]}…"


def distinct_matches(groups: Sequence[FileMatches]) -> tuple[list[tuple[str, int, list[str], list[int]]], bool]:
    """Each distinct matched string over all files: ``(spelling, count, files, pages)``, most frequent first.

    ``files`` is in the order of the match table, ``pages`` ascending. The flag says a file had more
    distinct strings than it tracks, so the aggregate may miss some.
    """
    merged: dict[str, list[Any]] = {}
    cut = False
    for group in groups:
        cut = cut or group.strings_cut
        for key, (text, count, pages) in group.strings.items():
            entry = merged.setdefault(key, [text, 0, [], set()])
            entry[1] += count
            entry[2].append(group.file_name)
            entry[3].update(pages)
    ranked = sorted(merged.values(), key=lambda entry: (-entry[1], fold(entry[0])))
    return [(text, count, files, sorted(pages)) for text, count, files, pages in ranked], cut


def _distinct_lines(groups: Sequence[FileMatches]) -> list[str]:
    """The "Distinct matches" aggregate of a regex search: each different string with its count and places."""
    ranked, cut = distinct_matches(groups)
    if not ranked:
        return []
    floor = "at least " if cut else ""
    lines = [f"Distinct matches: {floor}{len(ranked)} (each different matched string, with its count):"]
    for text, count, files, pages in ranked[:MAX_DISTINCT_MATCHES]:
        names = ", ".join(files[:MAX_DISTINCT_FILES]) + (
            f" … (+{len(files) - MAX_DISTINCT_FILES} files)" if len(files) > MAX_DISTINCT_FILES else ""
        )
        where = _pages_label(pages, MAX_DISTINCT_PAGES)
        lines.append(f"- `{_shorten(text, MAX_DISTINCT_CHARS)}`: {count}× in {names}{where}")
    if len(ranked) > MAX_DISTINCT_MATCHES:
        lines.append(f"… and {len(ranked) - MAX_DISTINCT_MATCHES} more distinct strings, the rarest.")
    return lines


@dataclass(frozen=True)
class ShelfScope:
    """One shelf a literal search read: how many documents it held in scope, or None when that is not counted."""

    shelf: str | None
    documents: int | None


def shelf_scopes(entries: Sequence[Any], documents: Mapping[str, int]) -> list[ShelfScope]:
    """The shelves of the searched ``entries`` in a stable order, each with the documents searched on it.

    ``documents`` counts the inventory's documents per collection that the search could read. A shelf
    whose collections have no inventory (the Basiswissen corpus is not enumerated) has no count.
    """
    order = [*KNOWN_SHELVES, None]
    by_shelf: dict[str | None, list[str]] = {}
    for entry in entries:
        by_shelf.setdefault(_entry_shelf(entry), []).append(entry.collection)
    scopes = []
    for shelf in sorted(by_shelf, key=lambda known: order.index(known) if known in order else len(order)):
        counted = [documents[name] for name in by_shelf[shelf] if name in documents]
        scopes.append(ShelfScope(shelf, sum(counted) if counted else None))
    return scopes


def _scope_statement(scopes: Sequence[ShelfScope]) -> str:
    """How many documents were searched, and on which shelves: the denominator of every "no" and every count."""
    if not scopes:
        return ""
    parts = []
    for scope in scopes:
        label = _SHELF_LABELS.get(scope.shelf or "", "unknown shelf")
        parts.append(
            f"{label} {scope.documents} documents" if scope.documents is not None else f"{label} (whole corpus)"
        )
    counted = [scope.documents for scope in scopes if scope.documents is not None]
    total = f"{sum(counted)} documents" + (" plus a corpus" if len(counted) < len(scopes) else "")
    return f"Searched: {total} ({', '.join(parts)})."


def _shelf_lines(groups: Sequence[FileMatches], scopes: Sequence[ShelfScope]) -> list[str]:
    """One line per searched shelf: its matches and files with matches against the files it holds, 0 included."""
    lines = []
    for scope in scopes:
        mine = [group for group in groups if group.shelf == scope.shelf]
        label = _SHELF_LABELS.get(scope.shelf or "", "unknown shelf")
        found = _count(sum(group.occurrences for group in mine), "match").replace("matchs", "matches")
        if scope.documents is None:
            lines.append(f"{label}: {found} in {_count(len(mine), 'file')} (documents not counted)")
        elif mine:
            lines.append(f"{label}: {found} in {len(mine)} of {_count(scope.documents, 'file')}")
        else:
            lines.append(f"{label}: {found} in {_count(scope.documents, 'file')}")
    return lines


def _collection_names(collections: Sequence[str]) -> str:
    """Collections as a message names them: a restricted folder's by what it is, never by its id.

    Its id in a result would make the admission treat the whole result as that
    folder's content (ADR-0088), and an outage is not content.
    """
    from aiq_agent.knowledge.restricted_collections import is_restricted_collection

    return ", ".join(
        "folder with restricted access" if is_restricted_collection(name) else name for name in collections
    )


def _failed_note(failed: Sequence[str]) -> str:
    return (
        f"INCOMPLETE: {len(failed)} collection(s) could not be searched ({_collection_names(failed)}). "
        "What is in them is missing from this answer; tell the reader so instead of turning it into a no."
    )


#: What the pattern tolerates, said where a count or a „Nein“ is stated.
_TOLERATED = (
    "ignoring case, umlaut spelling (ä/ae, ö/oe, ü/ue, ß/ss), and a line break, space or hyphen between the words"
)

#: Said above the table of a stemmed search: what "a match" meant.
_STEMMED_NOTE = (
    "Inflected forms included (German stemming): a passage matches when it holds the words in any inflected "
    "form („Fluchtwegbreiten“ for „Fluchtwegbreite“) or literally as before; a compound matches only literally."
)

#: What a person's regex tolerates: nothing but what they wrote, apart from case.
_TOLERATED_REGEX = (
    "as a regex in Python syntax, ignoring case; umlaut spellings and line breaks are not matched for you"
)


def _wanted(phrases: Sequence[str], regex_mode: bool) -> str:
    if regex_mode:
        return f"regex `{phrases[0]}`"
    return " | ".join(f'"{phrase}"' for phrase in phrases)


def _candidate_lines(candidates: Mapping[str, int] | None, counted: Mapping[str, int], limit: int = 10) -> list[str]:
    """The files a capped search could not finish counting, by how many passages hold the pattern's words."""
    if not candidates:
        return []
    ranked = sorted(candidates.items(), key=lambda item: (-item[1], fold(item[0])))
    shown = ", ".join(f"{name} {count}" for name, count in ranked[:limit])
    more = f" … (+{len(ranked) - limit} files)" if len(ranked) > limit else ""
    return [
        "Passages that hold the pattern's words, per file (an upper bound of its matching passages; "
        f"the counted matches above are the lower bound): {shown}{more}."
    ]


def match_table(
    groups: Sequence[FileMatches],
    phrases: Sequence[str],
    *,
    truncated: bool,
    failed: Sequence[str] = (),
    regex_mode: bool = False,
    candidates: Mapping[str, int] | None = None,
    scopes: Sequence[ShelfScope] = (),
) -> str:
    """The per-file answer to "where does this appear": every file, not the top three.

    ``scopes`` adds the scope statement and one line per shelf, so „0 matches in 12 files“ on the
    project is visible beside 40 hits in the Basiswissen corpus.
    """
    wanted = _wanted(phrases, regex_mode)
    floor = "at least " if truncated else ""
    tolerated = _TOLERATED_REGEX if regex_mode else _TOLERATED
    lines = [
        f"## Matches for {wanted}",
        f"{floor}{sum(group.occurrences for group in groups)} occurrence(s) in {len(groups)} file(s), {tolerated}:",
    ]
    if scopes:
        lines.append(_scope_statement(scopes))
        lines.extend(_shelf_lines(groups, scopes))
    for group in groups:
        shelf = f" ({_SHELF_LABELS[group.shelf]})" if group.shelf in _SHELF_LABELS else ""
        lines.append(f"- {group.file_name}{shelf}: {group.occurrences}×{_pages_label(group.pages)}")
    if regex_mode:
        lines.extend(_distinct_lines(groups))
    if truncated:
        lines.append(
            f"The search stopped after {MAX_MATCH_CHUNKS} matching passages in a collection: the counts above are "
            "lower bounds and the list may miss files. Narrow it with `folder=` or `file_name=`."
        )
        lines.extend(_candidate_lines(candidates, {group.file_name: group.occurrences for group in groups}))
    if failed:
        lines.append(_failed_note(failed))
    lines.append(
        "The table is an index; only the passages above are citable. Open another match with "
        "`read_passage(document=…, page=…)`."
    )
    return "\n".join(lines)


def _line_spans(body: str, pattern: Any, timeout: float | None) -> list[tuple[int, int]]:
    """``(first line, last line)`` of every non-empty match in ``body``, counting from 0."""
    starts = [0]
    starts.extend(match.end() for match in re.finditer("\n", body))
    matches = pattern.finditer(body) if timeout is None else pattern.finditer(body, timeout=timeout)

    def line_of(offset: int) -> int:
        return max(0, bisect.bisect_right(starts, offset) - 1)

    return [(line_of(m.start()), line_of(max(m.start(), m.end() - 1))) for m in matches if m.end() > m.start()]


def _context_ranges(spans: Sequence[tuple[int, int]], context: int, last: int) -> list[tuple[int, int]]:
    """The line ranges around ``spans``, ``context`` lines each side, overlapping ones joined."""
    ranges: list[tuple[int, int]] = []
    for first, end in sorted(spans):
        low, high = max(0, first - context), min(last, end + context)
        if ranges and low <= ranges[-1][1] + 1:
            ranges[-1] = (ranges[-1][0], max(ranges[-1][1], high))
        else:
            ranges.append((low, high))
    return ranges


def _chunk_snippets(chunk: Any, where: str, pattern: Any, context: int, room: int, timeout: float | None):
    """One chunk's ``(lines, cut)``: its hit ranges, at most ``room`` lines, ``cut`` when it had to stop."""
    body = (getattr(chunk, "content", "") or "").replace("\r\n", "\n")
    lines = body.split("\n")
    spans = _line_spans(body, pattern, timeout)
    hit_lines = {number for first, end in spans for number in range(first, end + 1)}
    out: list[str] = []
    for low, high in _context_ranges(spans, context, len(lines) - 1):
        left = room - len(out) - 1  # one line is the header
        if left < 1:
            return out, True
        shown = min(high, low + left - 1)
        out.append(f"{where}:")
        out.extend(f"{'>' if number in hit_lines else ' '} {lines[number].strip()}" for number in range(low, shown + 1))
        if shown < high:
            return out, True
    return out, False


def match_snippets(groups: Sequence[FileMatches], pattern: Any, context: int, *, timeout: float | None = None) -> str:
    """The lines around every match, ``context`` each side: grep ``-C`` over the files, as an index.

    Per hit ``file, p.N:`` and its lines (``>`` marks a line the pattern matched), at most
    :data:`MAX_SNIPPET_LINES` lines in all; it says when it stopped. Pure.
    """
    out: list[str] = []
    cut = False
    chunks = [(group.file_name, chunk) for group in groups for chunk in group.chunks]
    for file_name, chunk in chunks:
        page = getattr(chunk, "page_number", None)
        where = f"{file_name}, p.{page}" if page else file_name
        found, cut = _chunk_snippets(chunk, where, pattern, context, MAX_SNIPPET_LINES - len(out), timeout)
        out.extend(found)
        if cut:
            break
    if not out:
        return ""
    if cut:
        out.append(f"… the lines stop at {MAX_SNIPPET_LINES}; narrow with `folder=` or `file_name=` for the rest.")
    out.append("This is an index: cite the passages above, not these lines.")
    return "\n".join(["## Lines around the matches", *out])


def no_match_message(
    phrases: Sequence[str],
    searched: int,
    failed: Sequence[str] = (),
    *,
    regex_mode: bool = False,
    scopes: Sequence[ShelfScope] = (),
) -> str:
    """``No match`` over the ``searched`` collections that ANSWERED; never a "no" over one that failed."""
    wanted = _wanted(phrases, regex_mode)
    short = "" if regex_mode else " | ".join(f'"{phrase}"' for phrase in phrases if len(phrase) <= WHOLE_WORD_MAX_CHARS)
    whole_word = f" {short} was searched as a whole word only, not inside longer words." if short else ""
    tolerated = _TOLERATED_REGEX if regex_mode else _TOLERATED
    head = f"No match for {wanted} in {searched} collection(s), {tolerated}.{whole_word}"
    if scopes:
        head = "\n".join([head, _scope_statement(scopes), *_shelf_lines([], scopes)])
    if failed:
        return f"{head} {_failed_note(failed)} For those collections this is NOT a no."
    return (
        f"{head} That is a solid no for the WORDING, not for the topic: `knowledge_search` without `match` "
        "finds another phrasing. Scanned pages without a text layer and files still being processed are not "
        "searchable."
    )


def search_failed_message(phrases: Sequence[str], failed: Sequence[str], *, regex_mode: bool = False) -> str:
    """Every collection failed: there is no answer, and in particular no Nein."""
    wanted = _wanted(phrases, regex_mode)
    return (
        f"The full-text search for {wanted} could not run: none of the {len(failed)} collection(s) answered "
        f"({_collection_names(failed)}). This is NOT a result, neither a hit nor a no. Tell the reader the search "
        "was not possible just now, or try `knowledge_search` without `match`."
    )


# ---------------------------------------------------------------------------
# Scope
# ---------------------------------------------------------------------------


def _session_collection() -> str | None:
    try:
        ctx = Context.get()
        return ctx.conversation_id if ctx else None
    except Exception:  # noqa: BLE001 — no context is a valid standalone run
        return None


def _scope_entries(search_config: Any) -> list[Any]:
    from .register import _resolve_base_collection
    from .register import _resolve_scoped_collections

    return list(
        _resolve_scoped_collections(search_config, _session_collection(), _resolve_base_collection(search_config))
    )


def _entry_shelf(entry: Any) -> str | None:
    shelf = getattr(entry, "shelf", None)
    return canonical_shelf_value(str(getattr(shelf, "value", shelf))) if shelf else None


async def _turn_rows(search_config: Any) -> list[FileRow]:
    """The turn's inventory rows, uncapped; loaded from the scope when this path bound none.

    Never a row of a restricted folder's collection, whichever way the rows were
    found (ADR-0088): listing is not use, so a name, a title or a summary of
    such a file never reaches the model without an admission. The filter sits on
    the rows themselves rather than on one of the two sources, because the
    fallback below is the path a failed inventory load takes.
    """
    from aiq_agent.knowledge.restricted_collections import is_restricted_collection

    return [row for row in await _readable_rows(search_config) if not is_restricted_collection(row.collection)]


async def _readable_rows(search_config: Any) -> list[FileRow]:
    from aiq_agent.knowledge.inventory import get_turn_documents
    from aiq_agent.knowledge.restricted_use import without_restricted

    bound = get_turn_documents()
    if bound:
        return file_rows(bound)
    from aiq_agent.knowledge import get_available_documents_async

    entries = without_restricted(_scope_entries(search_config))
    listings = await asyncio.gather(
        *(get_available_documents_async(entry.collection) for entry in entries), return_exceptions=True
    )
    rows: list[dict[str, Any]] = []
    for entry, docs in zip(entries, listings, strict=True):
        if isinstance(docs, BaseException):
            logger.warning("list_files: no rows for %s: %s", entry.collection, docs)
            continue
        for doc in docs:
            data = doc.model_dump() if hasattr(doc, "model_dump") else dict(doc)
            rows.append({**data, "collection": entry.collection, "shelf": _entry_shelf(entry)})
    return file_rows(rows)


@dataclass(frozen=True)
class TurnRows:
    """The rows this turn may list, and what its restriction left."""

    rows: list[FileRow]
    #: What „my files“ means this turn: the user shelves that remain.
    own_shelves: tuple[str, ...]
    #: The shelves the turn allows when a restriction applied, else None.
    allowed: frozenset[str] | None = None


def restrict_rows_to_turn(rows: Sequence[FileRow]) -> TurnRows:
    """Drop the shelves this turn did not ask for; the user shelves that remain.

    The row-level twin of ``register._restrict_scope_to_turn``, with its rules:
    turn intent only ever subtracts, a row without a shelf is kept, and a
    restriction that would leave nothing keeps everything.
    """
    try:
        from aiq_agent.common.focus_file import get_turn_shelves

        allowed = get_turn_shelves()
    except Exception:  # noqa: BLE001 — no turn intent is a valid standalone run
        allowed = None
    if not allowed:
        return TurnRows(list(rows), USER_SHELVES)
    kept = [row for row in rows if row.shelf is None or row.shelf in allowed]
    if not kept:
        return TurnRows(list(rows), USER_SHELVES)
    # A law-only turn („nur Gesetz“) allows base alone: then base IS what it lists.
    own = tuple(shelf for shelf in USER_SHELVES if shelf in allowed)
    own = own or tuple(shelf for shelf in KNOWN_SHELVES if shelf in allowed) or USER_SHELVES
    return TurnRows(kept, own, frozenset(allowed))


def shelf_restricted_message(shelf: str, allowed: Iterable[str]) -> str:
    """An explicit ``shelf=`` the turn's restriction removed: say so, never „keine Datei“.

    „Keine Datei auf Projektwissen“ would be a false statement about the
    project; the shelf is only out of THIS question's reach.
    """
    allowed = set(allowed)
    names = [_SHELF_LABELS[known] for known in KNOWN_SHELVES if known in allowed]
    where = names[0] if len(names) == 1 else f"{', '.join(names[:-1])} and {names[-1]}"
    return (
        f"The user's current selection limits this question to {where}, so {_SHELF_LABELS.get(shelf, shelf)} "
        "is not listed here. That says nothing about what lies there; only the user changes the selection."
    )


def _in_flight(collections: Sequence[str]) -> list[str]:
    from aiq_agent.knowledge import ingest_status_store

    try:
        pending = ingest_status_store.in_flight_files(list(collections))
    except Exception:  # noqa: BLE001 — a status read never costs the listing
        return []
    return list(dict.fromkeys(name for names in pending.values() for name in names))


# ---------------------------------------------------------------------------
# Descriptions
# ---------------------------------------------------------------------------

_LIST_FILES_DESCRIPTION = (
    "Lists the reader's OWN files the way the Files pane shows them: which files exist, in which folder, of "
    "which Dokumentart, uploaded when. A deterministic listing, paged, not capped by the prompt inventory. "
    "It says which files exist, not what they say: use `read_passage` or `knowledge_search` for that, and "
    '`knowledge_search(match="exact")` to find which files mention a term.\n'
    "Inputs, all optional: with none, every file on Projektwissen, Büroablage and Private Sitzung, ordered by "
    "folder, after an overview of the top-level folders with file counts. `folder=` one folder and everything "
    "below it. `name_contains=` words that must all appear in the file name or title (case and umlaut spelling "
    "do not matter). `doc_class=` a Dokumentart key. `added_since=` YYYY-MM-DD. `sort=newest`. `topic=` a Thema "
    "Piloti recognised (Attika, Holzrahmenbau). `shelf=` project | office_shelf | session | base (base, the "
    "platform OIB corpus, is listed only when asked). `offset=` the next page, as the result says.\n"
    '`view="tree"` (`depth=` 1-4, default 2) returns a card per folder instead of file lines: counts, '
    "Dokumentart mix, pages, dates, the current Fassung; filters apply, no paging.\n"
    "`revisions_of=` a file name returns that document's whole chain of Fassungen, newest first, each with "
    "Index/Datum, upload date and what changed against the one before; every other filter is ignored. With "
    '`compare_to=` another Fassung of the chain (its file name, or "previous"), it returns what changed, page by '
    "page, in the printed text and in the reading of the drawings, with the Plankopf's Index and Stand "
    "(„was hat sich zwischen Index B und C geändert“).\n"
    "Returns: a count, the subfolders, then one line per file: exact file name, title, folder, Dokumentart, page "
    "count, topics, the date a photo was taken, a Fassung mark (read from the name, or a replacement a person "
    "confirmed, with what changed), upload date, a one-line summary. An index, not a source: it is never cited, "
    "and a summary does not say what a file contains. File names are written exactly as returned; each becomes "
    "a link the reader can open."
)

# ---------------------------------------------------------------------------
# NAT registration
# ---------------------------------------------------------------------------


class ListFilesConfig(FunctionBaseConfig, name="list_files"):
    """``list_files`` reads the turn's inventory; the search instance names its scope when none is bound."""

    knowledge_search: FunctionRef = Field(
        default=FunctionRef("knowledge_search"),
        description="The `knowledge_retrieval` instance whose collection scope this browser shares.",
    )


def _coerce_int(value: Any, default: int, *, low: int, high: int) -> int:
    try:
        number = int(str(value).strip()) if value not in (None, "") else default
    except (TypeError, ValueError):
        number = default
    return max(low, min(high, number))


def _check_shelf(shelf: str | None) -> tuple[str | None, str]:
    shelf = canonical_shelf_value(shelf or "") or None
    if shelf is not None and shelf not in KNOWN_SHELVES:
        return None, f"`shelf` must be one of {', '.join(KNOWN_SHELVES)}, or omitted for the reader's own files."
    return shelf, ""


@register_function(config_type=ListFilesConfig)
async def list_files(config: ListFilesConfig, _builder: Builder):
    """Browse the reader's files: folders, names, Dokumentart, dates. Deterministic; no LLM."""
    search_config = _builder.get_function_config(config.knowledge_search)

    async def _list(
        folder: str | None = None,
        name_contains: str | None = None,
        doc_class: str | None = None,
        added_since: str | None = None,
        shelf: str | None = None,
        sort: str | None = None,
        offset: int | str | None = None,
        limit: int | str | None = None,
        topic: str | None = None,
        revisions_of: str | None = None,
        compare_to: str | None = None,
        view: Literal["files", "tree"] | None = None,
        depth: int | str | None = None,
    ) -> str:
        """List the reader's files, like opening a folder in the Files pane.

        Args:
            folder (str | None): Folder path as a previous listing or the inventory printed it
                ("Brandschutz/Fluchtwege"); includes everything below it. Omit to list every file.
            name_contains (str | None): Words that must all appear in the file name or title.
            doc_class (str | None): One Dokumentart key (e.g. "oib_guideline", "law").
            added_since (str | None): Only files uploaded on or after this date, YYYY-MM-DD.
            shelf (str | None): project | office_shelf | session | base. Omit for the reader's own files.
            sort (str | None): folder (default) | name | newest.
            offset (int | None): Start of the page; the result names the next one.
            limit (int | None): Page size, default 40, at most 100.
            topic (str | None): A Thema Piloti recognised (e.g. "Attika", "Holzrahmenbau"); matches part of a topic.
            revisions_of (str | None): A file name; returns that document's chain of Fassungen instead of a listing.
            compare_to (str | None): With `revisions_of`: compare that Fassung with this one (a file name of the
                same chain, or "previous" for the one before) and return what changed, page by page.
            view (str | None): files (default) lists files; tree returns a card per folder instead.
            depth (int | None): With view=tree: folder levels below `folder` that get a card, 1 to 4, default 2.

        Returns:
            str: A count, the subfolders with counts, and one line per file with its exact name; as a tree,
                a card per folder.
        """
        outcome = ActionOutcome()
        row = ActionRow(
            "list",
            target=(revisions_of or "").strip() or (folder or "").strip().strip("/"),
            query=name_contains,
            shelf=shelf,
        )
        try:
            result = await _list_body(
                outcome,
                folder,
                name_contains,
                doc_class,
                added_since,
                shelf,
                sort,
                offset,
                limit,
                topic,
                revisions_of,
                compare_to,
                view,
                depth,
            )
        except BaseException:
            row.finish("error")
            raise
        # A refusal lists nothing and says so; a revisions chain is an answer with no file count.
        outcome.settle(row, default="ok" if outcome.completed else "error", target=outcome.target)
        return result

    async def _list_body(
        outcome: ActionOutcome,
        folder: str | None,
        name_contains: str | None,
        doc_class: str | None,
        added_since: str | None,
        shelf: str | None,
        sort: str | None,
        offset: int | str | None,
        limit: int | str | None,
        topic: str | None,
        revisions_of: str | None,
        compare_to: str | None,
        view: Literal["files", "tree"] | None,
        depth: int | str | None,
    ) -> str:
        shelf, refusal = _check_shelf(shelf)
        if refusal:
            return refusal
        if (revisions_of or "").strip():
            # A chain is not a listing: no other filter applies, so none is validated either.
            turn = restrict_rows_to_turn(await _turn_rows(search_config))
            if shelf and turn.allowed is not None and shelf not in turn.allowed:
                return shelf_restricted_message(shelf, turn.allowed)
            if compare_to is not None:
                older, newer, refusal = resolve_compare(
                    turn.rows, revisions_of or "", compare_to, shelf=shelf, default_shelves=turn.own_shelves
                )
                if refusal or older is None or newer is None:
                    return refusal
                return await compare_revisions(older, newer)
            outcome.completed = True
            return render_revisions(turn.rows, revisions_of or "", shelf=shelf, default_shelves=turn.own_shelves)
        sort = (sort or "folder").strip().lower()
        if sort not in ("folder", "name", "newest"):
            return "`sort` must be folder, name or newest."
        added_since = (added_since or "").strip() or None
        if added_since and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", added_since):
            return "`added_since` must be a date written YYYY-MM-DD."
        doc_class = (doc_class or "").strip() or None
        if doc_class is not None:
            from aiq_agent.knowledge.document_classification import DOCUMENT_CLASSES
            from aiq_agent.knowledge.document_classification import canonical_doc_class

            current_doc_class = canonical_doc_class(doc_class)
            if current_doc_class is None:
                return f"Invalid doc_class {doc_class!r}. Valid values: {', '.join(DOCUMENT_CLASSES)}."
            doc_class = current_doc_class

        view = (view or "files").strip().lower()
        if view not in ("files", "tree"):
            return "`view` must be files or tree."
        turn = restrict_rows_to_turn(await _turn_rows(search_config))
        if shelf and turn.allowed is not None and shelf not in turn.allowed:
            return shelf_restricted_message(shelf, turn.allowed)
        rows = turn.rows
        tree = view == "tree"
        listing = select_files(
            rows,
            default_shelves=turn.own_shelves,
            shelf=shelf,
            folder=(folder or "").strip().strip("/") or None,
            name_contains=(name_contains or "").strip() or None,
            doc_class=doc_class,
            added_since=added_since,
            topic=(topic or "").strip() or None,
            sort=sort,
            # A tree is not paged: its rows all go into the cards.
            offset=0 if tree else _coerce_int(offset, 0, low=0, high=100_000),
            limit=len(rows) + 1 if tree else _coerce_int(limit, DEFAULT_PAGE_SIZE, low=1, high=MAX_PAGE_SIZE),
        )
        collections = sorted({row.collection for row in rows if row.shelf in listing.shelves and row.collection})
        in_flight = await asyncio.to_thread(_in_flight, collections) if collections else []
        logger.info("list_files: %d of %d row(s) selected, view=%s", listing.total, len(rows), view)
        outcome.completed = True
        outcome.target = listing.folder
        outcome.files = len(listing.rows)
        if not tree:
            outcome.folders = len(listing.subfolders)
            return render_listing(listing, in_flight=in_flight)
        cards = folder_cards(
            listing.rows,
            root=listing.folder,
            depth=_coerce_int(depth, DEFAULT_TREE_DEPTH, low=1, high=MAX_TREE_DEPTH),
            series_rows=on_shelves(rows, shelf=shelf, default_shelves=turn.own_shelves),
        )
        from aiq_agent.knowledge.folder_cards import listing_abstracts

        outcome.folders = len(cards)
        return render_tree(
            cards,
            total_rows=listing.total,
            notes=listing.notes,
            scope=_scope_of(listing),
            in_flight=in_flight,
            abstracts=abstract_lines(await listing_abstracts(collections)),
        )

    yield FunctionInfo.from_fn(_list, description=_LIST_FILES_DESCRIPTION)


async def _files_by_collection(
    search_config: Any,
    *,
    file_name: str | None,
    folder: str | None,
    doc_class: str | None,
    title_contains: str | None,
) -> dict[str, list[str]] | None:
    """The files a narrowed exact search may read, per collection; ``None`` when nothing narrows it.

    A Dokumentart and a title are not searchable on the chunks as a person
    types them (``doc_class`` is human-set and store-authoritative; a title is
    a substring), so they become the list of files they name. A folder is on
    every point since ADR-0116 (``folder_ancestors``): the exact search pushes
    it into the query (:func:`_folder_scope`), and only the ranked search still
    asks this function for the collections a folder reaches.
    """
    if not (file_name or folder or doc_class or title_contains):
        return None
    from .register import _file_name_matches

    rows = await _turn_rows(search_config)
    if folder:
        resolved = _folder_matches(rows, folder)
        rows = [row for row in rows if resolved is not None and _in_folder(row, resolved)]
    if file_name:
        # The meaning mode's own test (either name contains the other, so
        # „Notiz“ is „Notiz.docx“), plus the title the reader sees in the pane.
        wanted = fold(file_name)
        rows = [
            row
            for row in rows
            if _file_name_matches(row.file_name, file_name) or wanted == fold(row.display_title or "")
        ]
    if doc_class:
        rows = [row for row in rows if row.doc_class == doc_class]
    if title_contains:
        needle = fold(title_contains)
        rows = [row for row in rows if needle in fold(f"{row.file_name} {row.display_title or ''}")]
    names: dict[str, list[str]] = {}
    for row in rows:
        names.setdefault(row.collection, []).append(row.file_name)
    return names


def user_pattern(text: str) -> tuple[Any | None, str]:
    """A person's regex, compiled; ``(None, refusal)`` when it cannot run, with the line that teaches the fix.

    Python syntax, case-insensitive. Refused: longer than :data:`MAX_USER_PATTERN_CHARS`, not a valid
    pattern, and a pattern that matches the empty string (it would match every passage). Catastrophic
    backtracking is stopped at match time, by the timeout the store scan runs under.
    """
    from .qdrant.retrieval import compile_user_regex

    pattern = text.strip()
    if len(pattern) < MIN_PHRASE_CHARS:
        return None, f"Provide a `query` of at least {MIN_PHRASE_CHARS} characters: the regex to find."
    if len(pattern) > MAX_USER_PATTERN_CHARS:
        return None, (
            f"`query` is too long for a regex ({len(pattern)} characters, at most {MAX_USER_PATTERN_CHARS}). "
            "Shorten it to the part that identifies the passage."
        )
    try:
        compiled = compile_user_regex(pattern)
    except (regex.error, RecursionError, OverflowError) as error:
        return None, (
            f"`query` is not a valid regex (Python syntax): {error}. Escape a literal ( ) [ ] {{ }} . * + ? | \\ "
            'with a backslash, or use `match="exact"` for a literal word.'
        )
    if compiled.search(""):
        return None, (
            "`query` matches the empty string, so it would match every passage. Add the text that must be there."
        )
    return compiled, ""


#: What a regex with no literal word and no narrowing is told: it would read every passage of every file.
_NEEDS_A_ANCHOR = (
    "A regex needs something to narrow the search with: one literal whole word or number it must contain, or a "
    "`folder=`, `file_name=` or `doc_class=` to read in. This pattern has no such word: a word followed by `?`, "
    "`*`, `\\w` or a class does not count, and neither does a character class or a digit run alone. Rewrite it "
    "so one word is written out in full (`MA ?37/\\d{6}` becomes `MA 37/\\d{6}`; `T\\d+` becomes `\\bT30-\\d+`), "
    'keep that word and give `folder=`, or use `match="exact"` for a literal.'
)

#: What a regex that outran its time limit is told.
_TOO_COSTLY = (
    "`query` is too costly: the regex backtracks on a passage of the files (nested repetition such as `(a+)+`, or "
    "overlapping alternatives under a `*`), and the search was stopped. This is NOT a result, neither a hit nor "
    'a no. Rewrite it without nested repetition, or use `match="exact"` for a literal word.'
)

#: What a regex whose whole scan outran its deadline is told: too costly, and not a result.
_TOO_COSTLY_SCAN = (
    "`query` is too costly: reading this regex over every passage that holds its words takes longer than one "
    "search may, and the search was stopped. This is NOT a result, neither a hit nor a no. Narrow it with "
    '`folder=`, `file_name=` or `doc_class=`, add a rarer literal word, or use `match="exact"` for a literal word.'
)


def _context_lines(value: Any) -> tuple[int | None, str]:
    """``context=`` as a count of lines (0 to :data:`MAX_CONTEXT_LINES`), None for none, or a refusal."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None, ""
    try:
        lines = int(str(value).strip())
    except ValueError:
        lines = -1
    if not 0 <= lines <= MAX_CONTEXT_LINES:
        return None, f"`context` is a number of lines from 0 to {MAX_CONTEXT_LINES}, got {value!r}."
    return lines, ""


async def _folder_scope(search_config: Any, folder: str) -> tuple[set[str], str | None]:
    """The collections that hold files in ``folder`` or below, and the folder as the points spell it.

    The key is the folder in its stored spelling (so „Plaene“ finds „Pläne“) as
    :func:`prefilter.folder_key` writes it onto every point; ``(set(), None)`` when no file is filed there.
    """
    from .qdrant import prefilter

    rows = await _turn_rows(search_config)
    resolved = _folder_matches(rows, folder)
    if resolved is None:
        return set(), None
    return {row.collection for row in rows if _in_folder(row, resolved)}, prefilter.folder_key(resolved)


async def exact_search(
    entries: Sequence[Any],
    text: str,
    *,
    search_config: Any,
    retriever: Any,
    file_name: str | None = None,
    folder: str | None = None,
    doc_class: str | None = None,
    title_contains: str | None = None,
    filters: dict[str, Any] | None = None,
    regex_mode: bool = False,
    context: int | str | None = None,
    stemmed: bool = False,
    shelf: str | None = None,
    outcome: ActionOutcome | None = None,
) -> str:
    """``knowledge_search(match="exact"|"regex")``: every chunk in scope that contains the phrase or matches the regex.

    ``stemmed`` (exact only) also finds the inflected forms of each phrase through
    the German-stemmed index (``qdrant.retrieval.stem_condition``).

    ``entries`` is the scope the search already resolved and restricted to the
    turn, so the exact mode reads exactly what the meaning mode reads — and the
    base corpus through the same store filter (:func:`_collection_filter`).
    A folder narrows inside the query (``folder_ancestors``), the other narrowings by file list.

    ``shelf`` ("project" | "office" | "base" | "session") keeps one shelf of that scope. Omitted, the
    search reads every shelf the turn allows, the Basiswissen corpus included: a literal question about
    the law (a Frist, „EI 90“) must not get a false „no“ because the corpus was left out. The answer
    says per shelf how many documents were read and how many matched, so „not in our documents“ is
    read off the project and office lines and not off the corpus's hits.
    """
    entries, refusal = entries_on_shelf(entries, shelf)
    if refusal:
        return refusal
    context_lines, refusal = _context_lines(context)
    if refusal:
        return refusal
    if regex_mode:
        pattern = text.strip()
        phrases = [pattern]
        compiled, refusal = user_pattern(text)
        if compiled is None:
            return refusal
    else:
        phrases = split_alternatives(text)
        if not phrases:
            return f"Provide a `query` of at least {MIN_PHRASE_CHARS} characters: the literal word or phrase to find."
        pattern = stemmed_pattern(phrases) if stemmed else phrase_pattern(phrases)
        if pattern is None:
            return (
                "`query` is too long for the exact search: it finds a word or a short phrase, not a sentence. "
                "Shorten it to the words that must appear literally."
            )
        compiled = re.compile(pattern)
    narrowed = await _files_by_collection(
        search_config, file_name=file_name, folder=None, doc_class=doc_class, title_contains=title_contains
    )
    folder_key: str | None = None
    if folder:
        in_folder, folder_key = await _folder_scope(search_config, folder)
        entries = [entry for entry in entries if entry.collection in in_folder]
    if narrowed is not None:
        # The rows name files on every shelf; the turn may have dropped some of
        # those shelves from ``entries``. Either way nothing in scope is left.
        entries = [entry for entry in entries if entry.collection in narrowed]
    if (narrowed is not None or folder) and not entries:
        return (
            "No file in scope matches that narrowing (`file_name`, `folder`, `doc_class`, "
            "`title_contains`). `list_files` shows what exists."
        )
    if regex_mode and not (narrowed is not None or folder_key) and not _has_literal_word(pattern):
        return _NEEDS_A_ANCHOR
    from .register import _resolve_base_collection

    base = _resolve_base_collection(search_config)
    scopes = shelf_scopes(entries, await _searched_documents(search_config, narrowed, folder))
    outcome = outcome if outcome is not None else ActionOutcome()
    counted = [scope.documents for scope in scopes if scope.documents is not None]
    outcome.searched = sum(counted) if counted else None
    filters_by_collection = {
        entry.collection: _collection_filter(
            entry.collection,
            base=base,
            search_config=search_config,
            caller_filters=filters,
            files=None if narrowed is None else narrowed[entry.collection],
            folder_key=folder_key,
        )
        for entry in entries
    }
    return await _search(
        retriever,
        entries,
        phrases,
        pattern,
        filters_by_collection,
        compiled=compiled,
        regex_mode=regex_mode,
        context=context_lines,
        stemmed=stemmed and not regex_mode,
        scopes=scopes,
        outcome=outcome,
    )


def entries_on_shelf(entries: Sequence[Any], shelf: str | None) -> tuple[list[Any], str]:
    """The ``entries`` on the asked shelf, or all when none is asked; a refusal when the word is unknown or empty.

    The empty case is said as a scope fact: the shelf is out of THIS turn's reach, which is not a "no".
    """
    entries = list(entries)
    asked = (shelf or "").strip().lower()
    if not asked:
        return entries, ""
    wanted = SEARCH_SHELVES.get(canonical_shelf_value(asked))
    if wanted is None:
        return [], f"`shelf` must be one of project, office, base (or omitted for every shelf), got {shelf!r}."
    kept = [entry for entry in entries if _entry_shelf(entry) == wanted]
    if not kept:
        return [], (
            f"The shelf {asked!r} is not part of this question's scope, so it was not searched. That says nothing "
            "about what lies there; only the user changes the selection."
        )
    return kept, ""


async def _searched_documents(search_config: Any, narrowed: Mapping[str, Sequence[str]] | None, folder: str | None):
    """Per collection, the documents of the inventory that the search could read under its narrowing."""
    rows = await _turn_rows(search_config)
    resolved = _folder_matches(rows, folder) if folder else None
    counts: dict[str, int] = {}
    for row in rows:
        if resolved is not None and not _in_folder(row, resolved):
            continue
        if narrowed is not None and row.file_name not in narrowed.get(row.collection, ()):
            continue
        counts[row.collection] = counts.get(row.collection, 0) + 1
    return counts


def _has_literal_word(pattern: str) -> bool:
    """True when a person's regex names a word the full-text index can narrow the scan with."""
    from .qdrant.retrieval import user_literal_tokens

    return bool(user_literal_tokens(pattern))


def _collection_filter(
    collection: str,
    *,
    base: str,
    search_config: Any,
    caller_filters: dict[str, Any] | None,
    files: Sequence[str] | None,
    folder_key: str | None = None,
) -> dict[str, Any] | None:
    """The store filter for one collection: the narrowing, and on the base corpus its standing filter.

    The base corpus holds text that is not evidence (cover and Impressum page
    chunks) and editions the deployment excludes; the ranked search keeps both
    out with ``register._base_collection_filters``, and a literal search that
    skipped it returned exactly those as citable passages. User collections are
    never filtered beyond the narrowing, as in the ranked search. The narrowing
    is a file list and/or the folder condition; ``scope_filter`` ANDs it onto the tenancy condition.
    """
    from .qdrant.prefilter import FOLDER_FIELD

    clauses = [
        clause
        for clause in (
            {"file_name": {"$in": sorted(files)}} if files is not None else None,
            {FOLDER_FIELD: folder_key} if folder_key else None,
        )
        if clause
    ]
    narrowing = None if not clauses else clauses[0] if len(clauses) == 1 else {"$and": clauses}
    if collection != base:
        return narrowing
    from .register import _base_collection_filters

    extra = [clause for clause in (caller_filters, narrowing) if clause]
    combined = extra[0] if len(extra) == 1 else ({"$and": extra} if extra else None)
    return _base_collection_filters(search_config, combined)


async def _search(
    retriever: Any,
    entries: Sequence[Any],
    phrases: Sequence[str],
    pattern: str,
    filters_by_collection: dict[str, dict[str, Any] | None],
    *,
    compiled: Any = None,
    regex_mode: bool = False,
    context: int | None = None,
    stemmed: bool = False,
    scopes: Sequence[ShelfScope] = (),
    outcome: ActionOutcome | None = None,
) -> str:
    from .qdrant.retrieval import USER_REGEX_SCAN_SECONDS
    from .qdrant.retrieval import USER_REGEX_TIMEOUT
    from .qdrant.retrieval import PatternTooCostly
    from .read_passage import _passage_result
    from .register import _format_results

    # A person's regex is the only caller that asks for the timed, narrowed-by-its-words read; a store
    # that knows only the literal lookup is never handed the keyword.
    read_options: dict[str, Any] = {"user_regex": True} if regex_mode else {}
    if stemmed:
        read_options["stem_phrases"] = list(phrases)

    async def _one(entry: Any) -> tuple[list[Any] | None, bool]:
        chunks = await retriever.find_text(
            entry.collection,
            pattern,
            filters=filters_by_collection.get(entry.collection),
            limit=MAX_MATCH_CHUNKS,
            **read_options,
        )
        if chunks is None:
            return None, False
        for chunk in chunks:
            chunk.metadata.setdefault("collection", entry.collection)
            if (shelf := _entry_shelf(entry)) is not None:
                chunk.metadata.setdefault("shelf", shelf)
        return chunks, len(chunks) >= MAX_MATCH_CHUNKS

    results = await asyncio.gather(*(_one(entry) for entry in entries), return_exceptions=True)
    chunks: list[Any] = []
    truncated = False
    capped: list[Any] = []
    answered = 0
    failed: list[str] = []
    for entry, result in zip(entries, results, strict=True):
        if isinstance(result, PatternTooCostly):
            return _TOO_COSTLY_SCAN if result.scan else _TOO_COSTLY
        if isinstance(result, BaseException):
            # An outage is not an empty collection: counted, and said, never
            # folded into „keine Fundstelle“.
            logger.warning("exact search: %s failed: %s", entry.collection, result)
            failed.append(entry.collection)
            continue
        found, hit_cap = result
        if found is None:
            continue
        answered += 1
        chunks.extend(found)
        truncated = truncated or hit_cap
        if hit_cap:
            capped.append(entry)
    if not answered:
        if failed:
            return search_failed_message(phrases, failed, regex_mode=regex_mode)
        return "Full-text search is not available in this environment. Use `knowledge_search`."

    timeout = USER_REGEX_TIMEOUT if regex_mode else None
    # Counting reads every matched chunk again; it gets a deadline of its own, as the scan did.
    deadline = time.monotonic() + USER_REGEX_SCAN_SECONDS if regex_mode else None
    try:
        groups = group_matches(
            chunks,
            compiled if regex_mode else pattern,
            timeout=timeout,
            store_decides=stemmed,
            deadline=deadline,
            collect_strings=regex_mode,
        )
    except TimeoutError:
        return _TOO_COSTLY_SCAN if deadline is not None and time.monotonic() >= deadline else _TOO_COSTLY
    if outcome is not None:
        # Hits are the literal matches (the table's count); documents are the files holding them, counted
        # only where the model may be told about them yet (ADR-0088). No match while a collection failed is
        # not a no, the message says so, and neither does the row: an error, never „keine Fundstelle“.
        outcome.record(
            sum(group.occurrences for group in groups),
            documents=len(groups),
            collections=[group.collection for group in groups],
        )
        outcome.failed = bool(failed) and not groups
    if not groups:
        return no_match_message(phrases, answered, failed, regex_mode=regex_mode, scopes=scopes)
    # The match table names every matching file and counts its matches, which
    # is content of each file it names, passages shown or not: reported for the
    # restricted-use admission (ADR-0088), beside the passages the grounding
    # block reports itself.
    from aiq_agent.knowledge.restricted_use import note_collections_read

    note_collections_read(group.collection for group in groups)
    passages = pick_passages(groups)
    query = " | ".join(phrases)
    candidates = await _candidate_counts(retriever, capped, pattern, filters_by_collection, regex_mode=regex_mode)
    trailer = match_table(
        groups, phrases, truncated=truncated, failed=failed, regex_mode=regex_mode, candidates=candidates, scopes=scopes
    )
    if stemmed:
        trailer = f"{_STEMMED_NOTE}\n{trailer}"
    if context is not None:
        try:
            snippets = match_snippets(groups, compiled if regex_mode else re.compile(pattern), context, timeout=timeout)
        except TimeoutError:
            return _TOO_COSTLY
        trailer = f"{trailer}\n\n{snippets}" if snippets else trailer
    formatted = await asyncio.to_thread(_format_results, _passage_result(passages, query), query, trailer=trailer)
    logger.info("exact search: %r matched %d file(s)", query, len(groups))
    return formatted


async def _candidate_counts(
    retriever: Any,
    capped: Sequence[Any],
    pattern: str,
    filters_by_collection: Mapping[str, dict[str, Any] | None],
    *,
    regex_mode: bool,
) -> dict[str, int] | None:
    """Per file, the passages that hold the pattern's words, over the collections whose scan hit its limit.

    One Qdrant facet each, under the filter the scan used. A retriever without the facet, or a
    pattern with no word to count by, gives None: the table then says "at least" and nothing more.
    """
    counter = getattr(retriever, "candidate_counts", None)
    if counter is None or not capped:
        return None
    totals: dict[str, int] = {}
    for entry in capped:
        try:
            counts = await counter(
                entry.collection, pattern, filters_by_collection.get(entry.collection), user_regex=regex_mode
            )
        except Exception:  # noqa: BLE001 — the counts are an addition to an answer the scan already gave
            logger.warning("exact search: candidate counts for %s failed", entry.collection, exc_info=True)
            continue
        for name, count in (counts or {}).items():
            totals[name] = totals.get(name, 0) + count
    return totals or None
