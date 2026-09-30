"""Looking at the files the way a person does: the listing and the exact search.

A person in the Files pane does two things before they read anything: they
LOOK at what is there (open a folder, sort by date, filter by name) and they
FIND where something is written (Ctrl+F across the project). The agent could do
neither. What it saw of the project was the prompt inventory, capped at fifty
rows, and what it could find was ``knowledge_search`` — a ranked top-k
similarity search that answers "what passage best matches this" and never
"which files say this". So on a project with three hundred files the agent
answered „welche Pläne liegen in Brandschutz/?“ from whichever fifty names the
cap kept, and „wo kommt BA-03 überall vor?“ from the three passages that ranked.

- ``list_files`` is ``ls`` / the Files pane: every file on the reader's own
  shelves, filtered by folder, name, Dokumentart and date, paged, with the
  subfolders and their counts. An INDEX, never evidence: a row proves a file
  exists, as the inventory does.
- ``knowledge_search(match="exact")`` is ``grep`` (:func:`exact_search`, here
  because it shares the rows and the folding): every chunk whose text contains a phrase, over
  every file in scope, counted per file — then the first passages of the
  best-covered files, rendered through the knowledge layer's own grounding
  block, so they are citable exactly like a search hit.

The exact search is a MODE of the search rather than a tool of its own: it is
the same verb over the same scope with the same narrowing arguments, and a
second tool would have been one more name for the model to choose between
(docs/architecture/agent-tool-surface.md).

Both are deterministic: no reranker, no judge, no LLM. Both read only what the
turn may read: the rows the turn's inventory resolved against the signed scope
(``knowledge.inventory.get_turn_documents``, uncapped), or — on a path that
bound none — the same scope ``knowledge_search`` resolves.
"""

from __future__ import annotations

import asyncio
import logging
import re
import unicodedata
from collections.abc import Iterable
from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import field
from typing import Any

from pydantic import Field

from nat.plugin_api import Builder
from nat.plugin_api import Context
from nat.plugin_api import FunctionBaseConfig
from nat.plugin_api import FunctionInfo
from nat.plugin_api import FunctionRef
from nat.plugin_api import register_function

logger = logging.getLogger(__name__)

#: Rows one ``list_files`` page returns by default, and the most it may ask for.
#: A row is ~40 tokens with its summary, so the default page costs about what
#: one search result costs.
DEFAULT_PAGE_SIZE = 40
MAX_PAGE_SIZE = 100

#: How many subfolders the folder overview names before it counts the rest.
MAX_FOLDER_LINES = 30

#: The summary is a hint for choosing what to open, not something to answer from.
MAX_SUMMARY_CHARS = 160

#: The shelves a person calls "my files". Basiswissen is the platform corpus:
#: listable on request (``shelf="base"``), never part of a default listing.
USER_SHELVES = ("project", "archiv", "session")
KNOWN_SHELVES = (*USER_SHELVES, "base")

#: How many chunks one exact search reads per collection. A bound
#: against a phrase that is on every page, not a relevance budget: past it the
#: count is stated as a floor.
MAX_MATCH_CHUNKS = 500

#: How many matching passages travel as citable evidence. The per-file table
#: covers every match; these are the text to quote from.
MAX_MATCH_PASSAGES = 8

#: A phrase shorter than this matches noise („EG“ is in half the words).
MIN_PHRASE_CHARS = 2

#: Alternatives in one exact search. „BA-03 | BA 03 | Brandabschnitt 3“
#: is one question asked three ways; ten is a runaway.
MAX_ALTERNATIVES = 6

_SHELF_LABELS = {
    "project": "Projektwissen",
    "archiv": "Büroarchiv",
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
    return FileRow(
        file_name=file_name,
        shelf=str(shelf) if shelf else None,
        collection=str(_attr(row, "collection") or ""),
        folder=str(_attr(row, "folder_path") or "").strip().strip("/"),
        display_title=(str(_attr(row, "display_title") or "").strip() or None),
        doc_class=(str(_attr(row, "doc_class") or "").strip() or None),
        tags=tuple(str(tag) for tag in (_attr(row, "tags") or ()) if tag),
        summary=" ".join(str(_attr(row, "summary") or "").split()),
        added_at=(str(_attr(row, "added_at") or "").strip()[:10] or None),
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


def select_files(
    rows: Sequence[FileRow],
    *,
    shelf: str | None = None,
    folder: str | None = None,
    name_contains: str | None = None,
    doc_class: str | None = None,
    added_since: str | None = None,
    sort: str = "folder",
    offset: int = 0,
    limit: int = DEFAULT_PAGE_SIZE,
) -> Listing:
    """Filter, order and page the rows. Pure: the tool's whole behaviour is here."""
    notes: list[str] = []
    shelves = (shelf,) if shelf else USER_SHELVES
    selected = [row for row in rows if row.shelf in shelves or (not shelf and row.shelf is None)]

    resolved_folder: str | None = None
    if folder:
        resolved_folder = _folder_matches(selected, folder)
        if resolved_folder is None:
            notes.append(f"Kein Ordner „{folder}“ auf diesen Regalen. Ohne `folder` aufrufen, um die Ordner zu sehen.")
            return Listing([], 0, offset, limit, folder, shelves=shelves, notes=notes)
        selected = [row for row in selected if _in_folder(row, resolved_folder)]

    if doc_class:
        selected = [row for row in selected if row.doc_class == doc_class]
    if added_since:
        selected = [row for row in selected if row.added_at and row.added_at >= added_since]
    if name_contains:
        words = _words(name_contains)
        selected = [row for row in selected if all(word in row.searchable for word in words)]

    filtered = bool(doc_class or added_since or name_contains)
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
    return Listing(page, total, offset, limit, resolved_folder, subfolders, here, shelves, notes)


def _row_line(row: FileRow, *, show_shelf: bool) -> str:
    bits: list[str] = []
    if row.display_title and fold(row.display_title) != fold(row.file_name):
        bits.append(f"„{row.display_title}“")
    bits.append(f"Ordner: {row.folder}" if row.folder else "Ordner: (oberste Ebene)")
    if row.doc_class:
        bits.append(f"Dokumentart: {row.doc_class}")
    if row.tags:
        bits.append(f"Tags: {', '.join(row.tags)}")
    if row.added_at:
        bits.append(f"hochgeladen {row.added_at}")
    if show_shelf and row.shelf:
        bits.append(_SHELF_LABELS.get(row.shelf, row.shelf))
    summary = row.summary
    if len(summary) > MAX_SUMMARY_CHARS:
        summary = summary[: MAX_SUMMARY_CHARS - 1].rstrip() + "…"
    tail = f" — {summary}" if summary else ""
    return f"- {row.file_name} · {' · '.join(bits)}{tail}"


def render_listing(listing: Listing, *, in_flight: Sequence[str] = ()) -> str:
    """The listing as the model reads it: counts first, then folders, then files."""
    where = " und ".join(_SHELF_LABELS.get(shelf, shelf) for shelf in listing.shelves)
    scope = f"{where}, Ordner „{listing.folder}“ mit Unterordnern" if listing.folder else where
    lines: list[str] = [*listing.notes]
    if listing.notes and not listing.total:
        return "\n".join(lines)
    if not listing.total:
        lines.append(f"Keine Datei auf {scope} passt zu diesen Filtern.")
    else:
        first = listing.offset + 1
        last = listing.offset + len(listing.rows)
        shown = f"{first}–{last}" if listing.rows else "keine (offset liegt hinter dem Ende)"
        lines.append(f"{listing.total} Datei(en) auf {scope}; hier {shown}.")

    if listing.subfolders:
        lines.append("")
        lines.append("Unterordner (Dateien im ganzen Teilbaum):")
        for path, count in listing.subfolders[:MAX_FOLDER_LINES]:
            lines.append(f"- {path}/ ({count})")
        rest = len(listing.subfolders) - MAX_FOLDER_LINES
        if rest > 0:
            lines.append(f"- … und {rest} weitere Ordner")
        if listing.here:
            lines.append(f"Direkt in diesem Ordner: {listing.here} Datei(en).")

    if listing.rows:
        lines.append("")
        lines.append("Dateien:")
        show_shelf = len(listing.shelves) > 1
        lines.extend(_row_line(row, show_shelf=show_shelf) for row in listing.rows)
        remaining = listing.total - (listing.offset + len(listing.rows))
        if remaining > 0:
            lines.append(
                f"… {remaining} weitere. Nächste Seite: gleicher Aufruf mit "
                f"`offset={listing.offset + len(listing.rows)}`."
            )

    if in_flight:
        lines.append("")
        lines.append(
            "Noch in Verarbeitung (hochgeladen, aber noch nicht lesbar — weder hier gelistet noch durchsuchbar): "
            + ", ".join(in_flight[:10])
            + (f" und {len(in_flight) - 10} weitere" if len(in_flight) > 10 else "")
        )

    lines.append("")
    lines.append(
        "Das ist ein Verzeichnis, keine Quelle: eine Zeile beweist, dass die Datei existiert, nicht was "
        "darin steht. Schreibe Dateinamen genau so, wie sie hier stehen — der Leser sieht jeden als Link, "
        "der die Datei öffnet. Lesen: `read_passage(document=…)`; darin suchen: "
        '`knowledge_search(file_name=…)`, wörtlich mit `match="exact"`; eine Seite ansehen: `view_knowledge_image`.'
    )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# The exact search (knowledge_search match="exact")
# ---------------------------------------------------------------------------


def split_alternatives(text: str) -> list[str]:
    """``"BA-03 | BA 03"`` → ``["BA-03", "BA 03"]``; empty and too-short parts dropped."""
    parts = [" ".join(part.split()) for part in (text or "").split("|")]
    return [part for part in dict.fromkeys(parts) if len(part) >= MIN_PHRASE_CHARS][:MAX_ALTERNATIVES]


def spellings(phrase: str) -> list[str]:
    """The byte strings a case-sensitive ``$contains`` must try to find ``phrase``.

    The store matches bytes; a person's Ctrl+F does not. As typed, lowercase,
    capitalised, uppercase, and each again with umlauts transliterated — so
    „Müller“ also finds „MUELLER“ and „brandschutz“ finds „Brandschutz“.
    The caller re-checks every candidate case-insensitively.
    """
    phrase = unicodedata.normalize("NFC", phrase)
    base = [phrase, phrase.lower(), phrase[:1].upper() + phrase[1:], phrase.upper()]
    folded = [variant.translate(str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"})) for variant in base]
    upper_folded = [variant.replace("Ä", "AE").replace("Ö", "OE").replace("Ü", "UE") for variant in folded]
    return list(dict.fromkeys([*base, *folded, *upper_folded]))


def _occurrences(body: str, phrases: Sequence[str]) -> int:
    haystack = fold(body)
    return sum(haystack.count(fold(phrase)) for phrase in phrases)


@dataclass
class FileMatches:
    """Every matching chunk of one file."""

    file_name: str
    shelf: str | None
    collection: str
    chunks: list[Any] = field(default_factory=list)
    occurrences: int = 0

    @property
    def pages(self) -> list[int]:
        return sorted({chunk.page_number for chunk in self.chunks if getattr(chunk, "page_number", None)})


def group_matches(chunks: Iterable[Any], phrases: Sequence[str]) -> list[FileMatches]:
    """Chunks that really contain a phrase (case-insensitively), grouped per file, most occurrences first."""
    groups: dict[tuple[str, str], FileMatches] = {}
    for chunk in chunks:
        count = _occurrences(getattr(chunk, "content", "") or "", phrases)
        if not count:
            continue
        metadata = getattr(chunk, "metadata", None) or {}
        collection = str(metadata.get("collection") or "")
        key = (collection, chunk.file_name)
        group = groups.get(key)
        if group is None:
            group = groups[key] = FileMatches(chunk.file_name, metadata.get("shelf"), collection)
        group.chunks.append(chunk)
        group.occurrences += count
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
    return f", S. {shown}{more}"


def match_table(groups: Sequence[FileMatches], phrases: Sequence[str], *, truncated: bool) -> str:
    """The per-file answer to „wo steht das überall“: every file, not the top three."""
    wanted = " | ".join(f"„{phrase}“" for phrase in phrases)
    floor = "mindestens " if truncated else ""
    lines = [
        f"## Fundstellen für {wanted}",
        f"{floor}{sum(group.occurrences for group in groups)} Vorkommen in {len(groups)} Datei(en), "
        "Groß-/Kleinschreibung und Umlaut-Schreibweise ignoriert:",
    ]
    for group in groups:
        shelf = f" ({_SHELF_LABELS[group.shelf]})" if group.shelf in _SHELF_LABELS else ""
        lines.append(f"- {group.file_name}{shelf}: {group.occurrences}×{_pages_label(group.pages)}")
    if truncated:
        lines.append(
            "Die Suche hat an ihrer Obergrenze abgebrochen: die Liste ist unvollständig. Grenze sie mit "
            "`folder=` oder `file_name=` ein."
        )
    lines.append(
        "Die Tabelle ist ein Verzeichnis; zitierbar sind nur die Passagen oben. Eine weitere Stelle öffnest "
        "du mit `read_passage(document=…, page=…)`."
    )
    return "\n".join(lines)


def no_match_message(phrases: Sequence[str], searched: int) -> str:
    wanted = " | ".join(f"„{phrase}“" for phrase in phrases)
    return (
        f"Keine Fundstelle für {wanted} in {searched} Sammlung(en) — auch nicht in anderer Groß-/Kleinschreibung "
        "oder Umlaut-Schreibweise. Das ist ein belastbares Nein für den WORTLAUT, nicht für das Thema: eine "
        "andere Formulierung findet `knowledge_search` ohne `match`. Eingescannte Seiten ohne Textebene "
        "und Dateien, die noch verarbeitet werden, sind nicht durchsuchbar."
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
    return str(getattr(shelf, "value", shelf)) if shelf else None


async def _turn_rows(search_config: Any) -> list[FileRow]:
    """The turn's inventory rows, uncapped; loaded from the scope when this path bound none."""
    from aiq_agent.knowledge.inventory import get_turn_documents

    bound = get_turn_documents()
    if bound:
        return file_rows(bound)
    from aiq_agent.knowledge import get_available_documents_async

    entries = _scope_entries(search_config)
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
    "Browse the reader's OWN files the way they would in the Files pane: which files exist, in which "
    "folder, of which Dokumentart, uploaded when. Deterministic listing, paged, never capped by the "
    "prompt inventory — the inventory in your prompt shows at most a few dozen names, this shows all.\n"
    "WHEN TO CALL — the question is about WHICH files there are, not what they say: „welche Pläne "
    "haben wir“, „was liegt im Ordner Brandschutz“, „was ist diese Woche neu“, „gibt es schon ein "
    "Protokoll zur Baubesprechung“, „wie heißt die Datei mit dem Schnitt genau“. Also first, when you "
    "need an exact file name for `read_passage`, `knowledge_search(file_name=…)` or a file operation "
    "and the inventory does not show it.\n"
    "- no arguments: the top level of Projektwissen, Büroarchiv and Private Sitzung, with every "
    "subfolder and its file count. `folder=` opens one folder (with everything below it).\n"
    "- `name_contains=` words that must all appear in the file name or title („brandschutz eg“); "
    "case and umlaut spelling do not matter.\n"
    "- `doc_class=` one Dokumentart key; `added_since=` YYYY-MM-DD; `sort=newest` for recent uploads.\n"
    "- `shelf=` project | archiv | session | base (base = the platform OIB corpus, listed only when asked).\n"
    "- `offset=` the next page, as the result says.\n"
    "WHEN NOT TO CALL — to learn what a file SAYS: that is `read_passage` / `knowledge_search`. To "
    'find which files MENTION a term: `knowledge_search(match="exact")`.\n'
    "RETURNS — a count, the subfolders, then one line per file: exact file name, title, folder, "
    "Dokumentart, upload date, a one-line summary. An index, not a source: never cite it and never "
    "answer what a file contains from its summary. Write file names exactly as returned — each "
    "becomes a link the reader can open."
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
    shelf = (shelf or "").strip().lower() or None
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
    ) -> str:
        """List the reader's files, like opening a folder in the Files pane.

        Args:
            folder (str | None): Folder path as a previous listing or the inventory printed it
                ("Brandschutz/Fluchtwege"); includes everything below it. Omit for the top level.
            name_contains (str | None): Words that must all appear in the file name or title.
            doc_class (str | None): One Dokumentart key (e.g. "plan", "gutachten").
            added_since (str | None): Only files uploaded on or after this date, YYYY-MM-DD.
            shelf (str | None): project | archiv | session | base. Omit for the reader's own files.
            sort (str | None): folder (default) | name | newest.
            offset (int | None): Start of the page; the result names the next one.
            limit (int | None): Page size, default 40, at most 100.

        Returns:
            str: A count, the subfolders with counts, and one line per file with its exact name.
        """
        shelf, refusal = _check_shelf(shelf)
        if refusal:
            return refusal
        sort = (sort or "folder").strip().lower()
        if sort not in ("folder", "name", "newest"):
            return "`sort` must be folder, name or newest."
        added_since = (added_since or "").strip() or None
        if added_since and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", added_since):
            return "`added_since` must be a date written YYYY-MM-DD."
        doc_class = (doc_class or "").strip() or None
        if doc_class is not None:
            from aiq_agent.knowledge.document_classification import DOCUMENT_CLASSES
            from aiq_agent.knowledge.document_classification import is_valid_doc_class

            if not is_valid_doc_class(doc_class):
                return f"Invalid doc_class {doc_class!r}. Valid values: {', '.join(DOCUMENT_CLASSES)}."

        rows = await _turn_rows(search_config)
        listing = select_files(
            rows,
            shelf=shelf,
            folder=(folder or "").strip().strip("/") or None,
            name_contains=(name_contains or "").strip() or None,
            doc_class=doc_class,
            added_since=added_since,
            sort=sort,
            offset=_coerce_int(offset, 0, low=0, high=100_000),
            limit=_coerce_int(limit, DEFAULT_PAGE_SIZE, low=1, high=MAX_PAGE_SIZE),
        )
        collections = sorted({row.collection for row in rows if row.shelf in listing.shelves and row.collection})
        in_flight = await asyncio.to_thread(_in_flight, collections) if collections else []
        logger.info("list_files: %d of %d row(s) selected", listing.total, len(rows))
        return render_listing(listing, in_flight=in_flight)

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

    A folder, a Dokumentart and a title are not on the chunks (ADR-0049: a
    folder rename would rewrite every vector; ``doc_class`` is human-set and
    store-authoritative), so every narrowing becomes the list of files it names.
    """
    if not (file_name or folder or doc_class or title_contains):
        return None
    rows = await _turn_rows(search_config)
    if folder:
        resolved = _folder_matches(rows, folder)
        rows = [row for row in rows if resolved is not None and _in_folder(row, resolved)]
    if file_name:
        wanted = fold(file_name)
        rows = [row for row in rows if wanted in (fold(row.file_name), fold(row.display_title or ""))]
    if doc_class:
        rows = [row for row in rows if row.doc_class == doc_class]
    if title_contains:
        needle = fold(title_contains)
        rows = [row for row in rows if needle in fold(f"{row.file_name} {row.display_title or ''}")]
    names: dict[str, list[str]] = {}
    for row in rows:
        names.setdefault(row.collection, []).append(row.file_name)
    return names


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
) -> str:
    """``knowledge_search(match="exact")``: every chunk in scope that contains the phrase.

    ``entries`` is the scope the search already resolved and restricted to the
    turn, so the exact mode reads exactly what the meaning mode reads.
    """
    phrases = split_alternatives(text)
    if not phrases:
        return f"Provide a `query` of at least {MIN_PHRASE_CHARS} characters: the literal word or phrase to find."
    narrowed = await _files_by_collection(
        search_config, file_name=file_name, folder=folder, doc_class=doc_class, title_contains=title_contains
    )
    filters_by_collection: dict[str, dict[str, Any] | None] = {entry.collection: None for entry in entries}
    if narrowed is not None:
        if not narrowed:
            return (
                "No file in scope matches that narrowing (`file_name`, `folder`, `doc_class`, "
                "`title_contains`). `list_files` shows what exists."
            )
        entries = [entry for entry in entries if entry.collection in narrowed]
        filters_by_collection = {
            collection: {"file_name": {"$in": sorted(files)}} for collection, files in narrowed.items()
        }
    return await _search(retriever, entries, phrases, filters_by_collection)


async def _search(
    retriever: Any,
    entries: Sequence[Any], phrases: Sequence[str], filters_by_collection: dict[str, dict[str, Any] | None]
) -> str:
    from .read_passage import _passage_result
    from .register import _format_results

    tried = list(dict.fromkeys(spelling for phrase in phrases for spelling in spellings(phrase)))

    async def _one(entry: Any) -> tuple[list[Any] | None, bool]:
        chunks = await retriever.find_text(
            entry.collection, tried, filters=filters_by_collection.get(entry.collection), limit=MAX_MATCH_CHUNKS
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
    supported = False
    for entry, result in zip(entries, results, strict=True):
        if isinstance(result, BaseException):
            logger.warning("exact search: %s failed: %s", entry.collection, result)
            continue
        found, capped = result
        if found is None:
            continue
        supported = True
        chunks.extend(found)
        truncated = truncated or capped
    if not supported:
        return "Die Volltextsuche ist in dieser Umgebung nicht verfügbar. Nutze `knowledge_search`."

    groups = group_matches(chunks, phrases)
    if not groups:
        return no_match_message(phrases, len(entries))
    passages = pick_passages(groups)
    query = " | ".join(phrases)
    formatted = await asyncio.to_thread(
        _format_results,
        _passage_result(passages, query),
        query,
        trailer=match_table(groups, phrases, truncated=truncated),
    )
    logger.info("exact search: %r matched %d file(s)", query, len(groups))
    return formatted
