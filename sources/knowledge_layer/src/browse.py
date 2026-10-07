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

#: A single character matches noise. Two and three characters („EG“, „T30“)
#: are real search terms and match as whole words (:data:`WHOLE_WORD_MAX_CHARS`).
MIN_PHRASE_CHARS = 2

#: Alternatives in one exact search. „BA-03 | BA 03 | Brandabschnitt 3“
#: is one question asked three ways; ten is a runaway.
MAX_ALTERNATIVES = 6

_SHELF_LABELS = {
    "project": "Projektwissen",
    "archiv": "Büroablage",
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
    default_shelves: Sequence[str] = USER_SHELVES,
) -> Listing:
    """Filter, order and page the rows. Pure: the tool's whole behaviour is here.

    ``default_shelves`` is what „my files“ means when no ``shelf`` is asked
    for: the user shelves, or the subset of them this turn is restricted to.
    """
    notes: list[str] = []
    shelves = (shelf,) if shelf else tuple(default_shelves)
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


def phrase_pattern(phrases: Sequence[str]) -> str | None:
    """The ONE case-insensitive regex that finds any of ``phrases``, or None when it is too long.

    The store (Chroma's ``$regex``, Rust ``regex``) and the re-check here
    (Python ``re``) run the same string, so it keeps to what both dialects read
    alike: ``(?i)`` at the start, non-capturing groups, classes, ``\\s``,
    ``\\b``, escaped literals; no lookaround, no backreference. Longest phrase
    first, so at one position „Brandschutzplan“ is taken before „Brandschutz“
    and a match is counted once however many alternatives it satisfies.
    """
    ordered = sorted(dict.fromkeys(phrases), key=len, reverse=True)
    pattern = "(?i)" + "|".join(_phrase_pattern(phrase) for phrase in ordered)
    return pattern if len(pattern) <= MAX_PATTERN_CHARS and ordered else None


def _occurrences(body: str, pattern: re.Pattern[str]) -> int:
    """Non-overlapping matches: one place in the text counts once, whichever alternative found it."""
    return sum(1 for _ in pattern.finditer(body))


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


def group_matches(chunks: Iterable[Any], pattern: str) -> list[FileMatches]:
    """Chunks the :func:`phrase_pattern` really matches, grouped per file, most occurrences first.

    The same pattern the store filtered with, compiled here: what the store
    returned and what is counted cannot disagree about what a match is.
    """
    compiled = re.compile(pattern)
    groups: dict[tuple[str, str], FileMatches] = {}
    for chunk in chunks:
        count = _occurrences(getattr(chunk, "content", "") or "", compiled)
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


def _collection_names(collections: Sequence[str]) -> str:
    """Collections as a message names them: a restricted folder's by what it is, never by its id.

    Its id in a result would make the admission treat the whole result as that
    folder's content (ADR-0081), and an outage is not content.
    """
    from aiq_agent.knowledge.restricted_collections import is_restricted_collection

    return ", ".join(
        "Ordner mit eingeschränktem Zugriff" if is_restricted_collection(name) else name for name in collections
    )


def _failed_note(failed: Sequence[str]) -> str:
    return (
        f"UNVOLLSTÄNDIG: {len(failed)} Sammlung(en) konnten nicht durchsucht werden ({_collection_names(failed)}). "
        "Was dort steht, fehlt in dieser Antwort — sag das dem Leser, statt daraus ein Nein zu machen."
    )


#: What the pattern tolerates, said where a count or a „Nein“ is stated.
_TOLERATED = (
    "Groß-/Kleinschreibung, Umlaut-Schreibweise (ä/ae, ö/oe, ü/ue, ß/ss) und Zeilenumbruch, Leerzeichen "
    "oder Bindestrich zwischen den Wörtern berücksichtigt"
)


def match_table(
    groups: Sequence[FileMatches], phrases: Sequence[str], *, truncated: bool, failed: Sequence[str] = ()
) -> str:
    """The per-file answer to „wo steht das überall“: every file, not the top three."""
    wanted = " | ".join(f"„{phrase}“" for phrase in phrases)
    floor = "mindestens " if truncated else ""
    lines = [
        f"## Fundstellen für {wanted}",
        f"{floor}{sum(group.occurrences for group in groups)} Vorkommen in {len(groups)} Datei(en), {_TOLERATED}:",
    ]
    for group in groups:
        shelf = f" ({_SHELF_LABELS[group.shelf]})" if group.shelf in _SHELF_LABELS else ""
        lines.append(f"- {group.file_name}{shelf}: {group.occurrences}×{_pages_label(group.pages)}")
    if truncated:
        lines.append(
            "Die Suche hat an ihrer Obergrenze abgebrochen: die Liste ist unvollständig. Grenze sie mit "
            "`folder=` oder `file_name=` ein."
        )
    if failed:
        lines.append(_failed_note(failed))
    lines.append(
        "Die Tabelle ist ein Verzeichnis; zitierbar sind nur die Passagen oben. Eine weitere Stelle öffnest "
        "du mit `read_passage(document=…, page=…)`."
    )
    return "\n".join(lines)


def no_match_message(phrases: Sequence[str], searched: int, failed: Sequence[str] = ()) -> str:
    """„Nicht gefunden“ over the ``searched`` collections that ANSWERED; never an Nein over one that failed."""
    wanted = " | ".join(f"„{phrase}“" for phrase in phrases)
    short = " | ".join(f"„{phrase}“" for phrase in phrases if len(phrase) <= WHOLE_WORD_MAX_CHARS)
    whole_word = f" {short} nur als ganzes Wort gesucht, nicht innerhalb längerer Wörter." if short else ""
    head = f"Keine Fundstelle für {wanted} in {searched} Sammlung(en) — {_TOLERATED}.{whole_word}"
    if failed:
        return f"{head} {_failed_note(failed)} Für diese Sammlungen ist das KEIN Nein."
    return (
        f"{head} Das ist ein belastbares Nein für den WORTLAUT, nicht für das Thema: eine "
        "andere Formulierung findet `knowledge_search` ohne `match`. Eingescannte Seiten ohne Textebene "
        "und Dateien, die noch verarbeitet werden, sind nicht durchsuchbar."
    )


def search_failed_message(phrases: Sequence[str], failed: Sequence[str]) -> str:
    """Every collection failed: there is no answer, and in particular no Nein."""
    wanted = " | ".join(f"„{phrase}“" for phrase in phrases)
    return (
        f"Die Volltextsuche nach {wanted} konnte nicht laufen: keine der {len(failed)} Sammlung(en) hat "
        f"geantwortet ({_collection_names(failed)}). Das ist KEIN Ergebnis — weder ein Treffer noch ein Nein. Sag dem "
        "Leser, dass die Suche gerade nicht möglich war, oder versuche `knowledge_search` ohne `match`."
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
    """The turn's inventory rows, uncapped; loaded from the scope when this path bound none.

    Never a row of a restricted folder's collection, whichever way the rows were
    found (ADR-0081): listing is not use, so a name, a title or a summary of
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
    where = names[0] if len(names) == 1 else f"{', '.join(names[:-1])} und {names[-1]}"
    return (
        f"Diese Frage ist durch die aktuelle Auswahl des Nutzers auf {where} beschränkt, deshalb wird "
        f"{_SHELF_LABELS.get(shelf, shelf)} hier nicht gelistet. Das sagt nichts darüber, was dort liegt; "
        "die Auswahl ändert nur der Nutzer."
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
    "Browse the reader's OWN files the way they would in the Files pane: which files exist, in which "
    "folder, of which Dokumentart, uploaded when. Deterministic listing, paged, never capped by the "
    "prompt inventory — the inventory in your prompt shows at most a few dozen names, this shows all.\n"
    "WHEN TO CALL — the question is about WHICH files there are, not what they say: „welche Pläne "
    "haben wir“, „was liegt im Ordner Brandschutz“, „was ist diese Woche neu“, „gibt es schon ein "
    "Protokoll zur Baubesprechung“, „wie heißt die Datei mit dem Schnitt genau“. Also first, when you "
    "need an exact file name for `read_passage`, `knowledge_search(file_name=…)` or a file operation "
    "and the inventory does not show it.\n"
    "- no arguments: every file on Projektwissen, Büroablage and Private Sitzung, paged and ordered "
    "by folder, after an overview of the top-level folders with their file counts. `folder=` narrows "
    "that to one folder and everything below it.\n"
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
                ("Brandschutz/Fluchtwege"); includes everything below it. Omit to list every file.
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

        turn = restrict_rows_to_turn(await _turn_rows(search_config))
        if shelf and turn.allowed is not None and shelf not in turn.allowed:
            return shelf_restricted_message(shelf, turn.allowed)
        rows = turn.rows
        listing = select_files(
            rows,
            default_shelves=turn.own_shelves,
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
) -> str:
    """``knowledge_search(match="exact")``: every chunk in scope that contains the phrase.

    ``entries`` is the scope the search already resolved and restricted to the
    turn, so the exact mode reads exactly what the meaning mode reads — and the
    base corpus through the same store filter (:func:`_collection_filter`).
    """
    phrases = split_alternatives(text)
    if not phrases:
        return f"Provide a `query` of at least {MIN_PHRASE_CHARS} characters: the literal word or phrase to find."
    pattern = phrase_pattern(phrases)
    if pattern is None:
        return (
            "`query` is too long for the exact search: it finds a word or a short phrase, not a sentence. "
            "Shorten it to the words that must appear literally."
        )
    narrowed = await _files_by_collection(
        search_config, file_name=file_name, folder=folder, doc_class=doc_class, title_contains=title_contains
    )
    if narrowed is not None:
        # The rows name files on every shelf; the turn may have dropped some of
        # those shelves from ``entries``. Either way nothing in scope is left.
        entries = [entry for entry in entries if entry.collection in narrowed]
        if not entries:
            return (
                "No file in scope matches that narrowing (`file_name`, `folder`, `doc_class`, "
                "`title_contains`). `list_files` shows what exists."
            )
    from .register import _resolve_base_collection

    base = _resolve_base_collection(search_config)
    filters_by_collection = {
        entry.collection: _collection_filter(
            entry.collection,
            base=base,
            search_config=search_config,
            caller_filters=filters,
            files=None if narrowed is None else narrowed[entry.collection],
        )
        for entry in entries
    }
    return await _search(retriever, entries, phrases, pattern, filters_by_collection)


def _collection_filter(
    collection: str,
    *,
    base: str,
    search_config: Any,
    caller_filters: dict[str, Any] | None,
    files: Sequence[str] | None,
) -> dict[str, Any] | None:
    """The store filter for one collection: the file narrowing, and on the base corpus its standing filter.

    The base corpus holds text that is not evidence (cover and Impressum page
    chunks) and editions the deployment excludes; the ranked search keeps both
    out with ``register._base_collection_filters``, and a literal search that
    skipped it returned exactly those as citable passages. User collections are
    never filtered beyond the narrowing, as in the ranked search.
    """
    narrowing = {"file_name": {"$in": sorted(files)}} if files is not None else None
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
) -> str:
    from .read_passage import _passage_result
    from .register import _format_results

    async def _one(entry: Any) -> tuple[list[Any] | None, bool]:
        chunks = await retriever.find_text(
            entry.collection, pattern, filters=filters_by_collection.get(entry.collection), limit=MAX_MATCH_CHUNKS
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
    answered = 0
    failed: list[str] = []
    for entry, result in zip(entries, results, strict=True):
        if isinstance(result, BaseException):
            # An outage is not an empty collection: counted, and said, never
            # folded into „keine Fundstelle“.
            logger.warning("exact search: %s failed: %s", entry.collection, result)
            failed.append(entry.collection)
            continue
        found, capped = result
        if found is None:
            continue
        answered += 1
        chunks.extend(found)
        truncated = truncated or capped
    if not answered:
        if failed:
            return search_failed_message(phrases, failed)
        return "Die Volltextsuche ist in dieser Umgebung nicht verfügbar. Nutze `knowledge_search`."

    groups = group_matches(chunks, pattern)
    if not groups:
        return no_match_message(phrases, answered, failed)
    # The match table names every matching file and counts its matches, which
    # is content of each file it names, passages shown or not: reported for the
    # restricted-use admission (ADR-0081), beside the passages the grounding
    # block reports itself.
    from aiq_agent.knowledge.restricted_use import note_collections_read

    note_collections_read(group.collection for group in groups)
    passages = pick_passages(groups)
    query = " | ".join(phrases)
    formatted = await asyncio.to_thread(
        _format_results,
        _passage_result(passages, query),
        query,
        trailer=match_table(groups, phrases, truncated=truncated, failed=failed),
    )
    logger.info("exact search: %r matched %d file(s)", query, len(groups))
    return formatted
