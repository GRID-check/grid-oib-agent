"""Shelf-aware knowledge-base inventory for agent prompts.

The signed collection scope is an authorization ceiling. The inventory is how
the agent *sees* that ceiling. ADR-0047 already travels the shelf as data on
the wire; this module is the missing half: each listed file carries its shelf,
the prompt is grouped by shelf, and a listing question about the Büroarchiv
cannot be answered with OIB or project files.

Identity is ``(collection, filename)``. A 50-row cap that sorted the mixed
list evicted user-shelf files whenever the OIB corpus filled the window —
so the agent answered "what's in the archive" from Basiswissen. User shelves
are allocated first.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from collections.abc import Sequence
from contextvars import ContextVar
from typing import Any

from aiq_agent.common.source_kinds import SHELF_QUALIFIERS
from aiq_agent.common.source_kinds import Shelf
from aiq_agent.common.source_kinds import parse_shelf

_listing_shelf: ContextVar[Shelf | None] = ContextVar("grid_listing_shelf", default=None)

# How many files the cap dropped, per shelf, for the turn being rendered.
#
# A contextvar for the same reason ``_listing_shelf`` is one: the cap is applied
# at AGGREGATION time (``chat_researcher.register``) and the block is rendered
# much later, by ``render_prompt_template``, with no call path between them that
# could carry an extra argument.
_inventory_drops: ContextVar[dict[Shelf | None, int]] = ContextVar("grid_inventory_drops", default={})

# User-facing shelves first; base last so the OIB corpus cannot evict them.
_USER_SHELF_ORDER: tuple[Shelf, ...] = (Shelf.ARCHIV, Shelf.PROJECT, Shelf.SESSION)
_INVENTORY_ORDER: tuple[Shelf, ...] = (*_USER_SHELF_ORDER, Shelf.BASE)

_SHELF_BLURBS: dict[Shelf, str] = {
    Shelf.BASE: (
        "always on this request — platform OIB / law corpus. Every turn has this, project or not. Never the Büroarchiv."
    ),
    Shelf.ARCHIV: ("on every project in this organization — office archive. NOT base/OIB, NOT this project's files."),
    Shelf.PROJECT: ("on every session of this project — this project's files only. NOT the Büroarchiv, NOT base/OIB."),
    Shelf.SESSION: ("only this chat — attachments uploaded here. Not visible in other sessions."),
}

# Listing questions only. Content questions ("was sagt OIB-RL 2") must not match.
_LISTING_CUES = (
    "welche datei",
    "welche unterlagen",
    "welche dokumente",
    "welche oib",
    "was hast du",
    "was liegt",
    "was ist im",
    "hast du was",
    "zeig mir die datei",
    "zeig die datei",
    "zeig mir die unterlagen",
    "liste das",
    "liste die",
    "liste ",
    "und im",
    "what files",
    "which files",
    "what's in",
    "whats in",
    "what do you have",
    "what have you",
)

# Short follow-ups that name a shelf and nothing else ("und im archiv?").
_SHELF_ONLY_FOLLOWUPS = frozenset(
    {
        "im archiv",
        "ins archiv",
        "das archiv",
        "bueroarchiv",
        "buroarchiv",
        "bro archiv",
        "und im archiv",
        "und das archiv",
        "im bueroarchiv",
        "im buroarchiv",
        "im bro archiv",
    }
)

_SHELF_HINTS: tuple[tuple[Shelf, tuple[str, ...]], ...] = (
    (
        Shelf.ARCHIV,
        (
            "büroarchiv",
            "bueroarchiv",
            "büro archiv",
            "buero archiv",
            "bro archiv",
            "büro-archiv",
            "office archive",
            "im archiv",
            "ins archiv",
            "im archive",
        ),
    ),
    (
        Shelf.PROJECT,
        (
            "projektarchiv",
            "projektunterlagen",
            "im projekt",
            "dieses projekt",
            "this project",
            "projektwissen",
        ),
    ),
    (
        Shelf.BASE,
        (
            "basiswissen",
            "oib-richtlinien",
            "oib richtlinien",
            "welche oib",
            "base corpus",
        ),
    ),
    (
        Shelf.SESSION,
        (
            "dieser sitzung",
            "dieser unterhaltung",
            "this chat",
            "this session",
            "private sitzung",
        ),
    ),
)


def _shelf_of(doc: Any) -> Shelf | None:
    return parse_shelf(getattr(doc, "shelf", None) if not isinstance(doc, dict) else doc.get("shelf"))


def _file_name_of(doc: Any) -> str:
    if isinstance(doc, dict):
        return str(doc.get("file_name") or "")
    return str(getattr(doc, "file_name", "") or "")


def _collection_of(doc: Any) -> str:
    if isinstance(doc, dict):
        return str(doc.get("collection") or "")
    return str(getattr(doc, "collection", "") or "")


def _summary_of(doc: Any) -> str:
    if isinstance(doc, dict):
        return str(doc.get("summary") or "").strip()
    return str(getattr(doc, "summary", "") or "").strip()


def _folder_of(doc: Any) -> str:
    """Materialised folder path a file is filed under, or ``""`` for the root.

    ADR-0049: the backend carries the PATH (``Brandschutz/Fluchtwege``), not a
    folder id, precisely so it can be printed here without a join and so a
    prefix match is the subtree.
    """
    raw = doc.get("folder_path") if isinstance(doc, dict) else getattr(doc, "folder_path", None)
    return str(raw or "").strip()


def _tags_of(doc: Any) -> list[str]:
    raw = doc.get("tags") if isinstance(doc, dict) else getattr(doc, "tags", None)
    if not raw:
        return []
    return [str(tag) for tag in raw if tag]


def document_identity(doc: Any) -> tuple[str, str]:
    """Primary key of an inventory row: ``(collection, file_name)``."""
    return (_collection_of(doc), _file_name_of(doc))


def stamp_document(doc: Any, *, collection: str, shelf: Shelf | None) -> Any:
    """Return a copy of *doc* carrying ``collection`` and ``shelf``.

    Does not mutate the input when the object supports ``model_copy``
    (``AvailableDocument``). Duck-typed stand-ins used in tests get attributes
    set in place only when they have no copy protocol.
    """
    shelf_value = shelf.value if isinstance(shelf, Shelf) else None
    if hasattr(doc, "model_copy"):
        return doc.model_copy(update={"collection": collection, "shelf": shelf_value})
    try:
        doc.collection = collection
        doc.shelf = shelf_value
    except Exception:
        pass
    return doc


def _dedupe(docs: Iterable[Any]) -> list[Any]:
    seen: set[tuple[str, str]] = set()
    out: list[Any] = []
    for doc in docs:
        key = document_identity(doc)
        if key in seen:
            continue
        seen.add(key)
        out.append(doc)
    return out


def _sort_key(doc: Any) -> str:
    return _file_name_of(doc).lower()


def _is_user_priority(shelf: Shelf | None) -> bool:
    return shelf is None or shelf in _USER_SHELF_ORDER


def allocate_inventory(docs: Sequence[Any], max_documents: int | None) -> list[Any]:
    """The kept files. See :func:`allocate_inventory_detailed` for what was dropped."""
    return allocate_inventory_detailed(docs, max_documents)[0]


def allocate_inventory_detailed(
    docs: Sequence[Any], max_documents: int | None
) -> tuple[list[Any], dict[Shelf | None, int]]:
    """Dedupe by ``(collection, file_name)``, keep user shelves, then spend the cap on base.

    Returns the kept files AND how many were dropped per shelf.

    ``max_documents`` ``None``/``0``/negative disables the cap. When user-shelf
    files alone overflow the cap, each non-empty user shelf keeps at least one
    file (a whole shelf must not vanish so the agent can still say what is on it).

    The per-shelf drop count is not bookkeeping. The block tells the model to
    "answer ONLY from that shelf's group. If the group is empty, say so" — so a
    shelf that silently lost its alphabetical tail produces a confidently
    complete-looking, wrong answer, on exactly the turn class that cannot fall
    back to retrieval (a listing question is routed to ``meta``, which strips
    every search tool). A GLOBAL count would not fix that: the model needs to
    know WHICH answer is incomplete.
    """
    unique = _dedupe(docs)
    groups: dict[Shelf | None, list[Any]] = defaultdict(list)
    for doc in unique:
        groups[_shelf_of(doc)].append(doc)
    for group in groups.values():
        group.sort(key=_sort_key)

    user_shelves: list[Shelf | None] = [None, *_USER_SHELF_ORDER]
    user_docs = [doc for shelf in user_shelves for doc in groups.get(shelf, [])]
    base_docs = list(groups.get(Shelf.BASE, []))

    def drops(kept: Sequence[Any]) -> dict[Shelf | None, int]:
        """Per-shelf shortfall between what exists and what survived the cap."""
        kept_per_shelf: dict[Shelf | None, int] = defaultdict(int)
        for doc in kept:
            kept_per_shelf[_shelf_of(doc)] += 1
        return {shelf: len(group) - kept_per_shelf[shelf] for shelf, group in groups.items()}

    if not max_documents or max_documents < 0:
        return user_docs + base_docs, {}

    if len(user_docs) <= max_documents:
        leftover = max_documents - len(user_docs)
        kept = user_docs + base_docs[:leftover]
        return kept, drops(kept)

    nonempty = [shelf for shelf in user_shelves if groups.get(shelf)]
    if not nonempty:
        kept = base_docs[:max_documents]
        return kept, drops(kept)

    share = max(1, max_documents // len(nonempty))
    kept = []
    remainder_pool: list[Any] = []
    for shelf in nonempty:
        group = groups[shelf]
        kept.extend(group[:share])
        remainder_pool.extend(group[share:])
    leftover = max_documents - len(kept)
    if leftover > 0:
        kept.extend(remainder_pool[:leftover])
    kept = kept[:max_documents]
    return kept, drops(kept)


def _query_variants(query: str) -> tuple[str, str]:
    raw = (query or "").strip().lower()
    folded = raw.replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss")
    return raw, folded


def shelf_hint_from_query(query: str) -> Shelf | None:
    """Shelf a *listing* question is about, or ``None`` for a content question.

    "welche Dateien hast du im Büroarchiv" → ``archiv``.
    "was sagt OIB-RL 2 zum Brandschutz" → ``None``.
    When both project and archiv are mentioned ("nicht im projekt … im archiv")
    the archive token wins — that is the clarification the user just made.
    """
    raw, folded = _query_variants(query)
    haystacks = (raw, folded)
    cleaned = "".join(ch if ch.isalnum() or ch.isspace() else " " for ch in folded)
    cleaned = " ".join(cleaned.split())
    is_listing = any(cue in text for text in haystacks for cue in _LISTING_CUES) or (cleaned in _SHELF_ONLY_FOLLOWUPS)
    if not is_listing:
        return None
    for shelf, tokens in _SHELF_HINTS:
        for token in tokens:
            token_l = token.lower()
            token_folded = token_l.replace("ä", "ae").replace("ö", "oe").replace("ü", "ue")
            if any(token_l in text or token_folded in text for text in haystacks):
                return shelf
    return None


def set_inventory_drops(drops: dict[Shelf | None, int] | None) -> None:
    """Remember how many files the cap dropped per shelf, or clear it."""
    _inventory_drops.set({shelf: n for shelf, n in (drops or {}).items() if n > 0})


def get_inventory_drops() -> dict[Shelf | None, int]:
    return _inventory_drops.get()


def set_listing_shelf(shelf: Shelf | str | None) -> None:
    """Remember the shelf this turn is listing, or clear it."""
    _listing_shelf.set(parse_shelf(shelf))


def get_listing_shelf() -> Shelf | None:
    return _listing_shelf.get()


def listing_intent_override(query: str) -> str | None:
    """``"meta"`` when *query* is a shelf-listing question; otherwise ``None``.

    The intent classifier's tie-break prefers research. A listing question is
    Bürowissen, so that tie-break turns "welche Dateien hast du im Büroarchiv"
    into a search. This override is the cause-level gate: if the query names a
    shelf as a catalogue question, the turn is meta regardless of what the
    classifier model said.
    """
    return "meta" if shelf_hint_from_query(query) is not None else None


def _parse_scope_shelves(values: Sequence[Any] | None) -> list[Shelf]:
    if not values:
        return []
    seen: set[Shelf] = set()
    out: list[Shelf] = []
    for value in values:
        shelf = parse_shelf(value)
        if shelf is None or shelf in seen:
            continue
        seen.add(shelf)
        out.append(shelf)
    return out


def _heading(shelf: Shelf) -> str:
    return SHELF_QUALIFIERS[shelf]


def _implied_shelves(groups: dict[Shelf, list[Any]]) -> list[Shelf]:
    """Shelves that must exist given the ones we already have files for.

    Every request has Basiswissen. Every project has a Büroarchiv. A turn
    that already listed project or session files is therefore a project
    turn, even if the signed envelope did not arrive and the archive is
    empty — omitting the empty group is how the model fills it with OIB.
    """
    present = {shelf for shelf, rows in groups.items() if rows}
    if not present:
        return []
    implied: set[Shelf] = set(present)
    implied.add(Shelf.BASE)
    if present & {Shelf.ARCHIV, Shelf.PROJECT, Shelf.SESSION}:
        implied.add(Shelf.ARCHIV)
        implied.add(Shelf.BASE)
    if present & {Shelf.PROJECT, Shelf.SESSION}:
        implied.add(Shelf.PROJECT)
    return [shelf for shelf in _INVENTORY_ORDER if shelf in implied]


def render_inventory_block(
    docs: Sequence[Any],
    *,
    in_scope_shelves: Sequence[Any] | None = None,
    focus_shelf: Shelf | str | None = None,
) -> str:
    """Markdown inventory grouped by shelf, including empty in-scope shelves.

    An omitted empty Büroarchiv section is how the model fills the gap with
    OIB. In-scope empty shelves therefore render as ``(empty)``.

    ``focus_shelf`` is a listing question about ONE shelf: only that group is
    printed, so OIB filenames cannot be recited as Büroarchiv.
    """
    groups: dict[Shelf, list[Any]] = {shelf: [] for shelf in _INVENTORY_ORDER}
    unknown: list[Any] = []
    for doc in docs:
        if not _file_name_of(doc):
            continue
        shelf = _shelf_of(doc)
        if shelf is None:
            unknown.append(doc)
        else:
            groups.setdefault(shelf, []).append(doc)

    scoped = _parse_scope_shelves(in_scope_shelves)
    if not scoped:
        scoped = _implied_shelves(groups)
    focused = parse_shelf(focus_shelf)

    show: list[Shelf] = []
    for shelf in _INVENTORY_ORDER:
        if focused is not None:
            if shelf == focused:
                show.append(shelf)
            continue
        if shelf in scoped or groups[shelf]:
            show.append(shelf)
    if not show and not unknown:
        return ""
    if focused is not None:
        unknown = []

    lines = [
        "## Knowledge-base inventory (index — NOT sources)",
        "These files exist and are searchable. This is an index of what is available, "
        "not evidence you may cite: the one-line summaries are not quotable, and a "
        "filename here is not a citable source until a retrieval result has returned "
        "a passage from it.",
        "",
        "Files sit on four nested shelves. A wider shelf is NOT the narrower one:",
        "- **Basiswissen** (base) — always on this request. Platform OIB / law. Every turn has this.",
        "- **Büroarchiv** (archiv) — on every project in this organization. "
        "Office archive. NOT base/OIB, NOT this project.",
        "- **Projektwissen** (project) — on every session of this project. This project's files. NOT the Büroarchiv.",
        "- **Private Sitzung** (session) — only this chat. Attachments uploaded here.",
        "",
        'When the user asks which files you have on a shelf (e.g. "welche Dateien '
        'hast du im Büroarchiv", "was liegt im Projekt", "welche OIB-Richtlinien '
        "hast du\"), answer ONLY from that shelf's group. If the group is empty, say "
        "so. Never fill a gap with another shelf. Büroarchiv is never the OIB corpus.",
        "",
    ]
    if any(_folder_of(doc) for doc in docs):
        lines.append(
            "Files the user filed into a folder show it as `(Ordner: Pfad/Unterpfad)`. "
            "A folder is a path, so `Brandschutz` also means everything under "
            "`Brandschutz/…`. You may name folders when you talk about the files, and "
            "you may pass `folder=` to `knowledge_search` to read only what is filed "
            "there. Files with no `(Ordner: …)` sit at the top level."
        )
        lines.append("")

    if focused is not None:
        other = [SHELF_QUALIFIERS[s] for s in _INVENTORY_ORDER if s != focused]
        lines.append(
            f"This question asked only about **{SHELF_QUALIFIERS[focused]}**. "
            f"Other shelves ({', '.join(other)}) exist on this request but are not listed."
        )
        lines.append("")

    dropped = get_inventory_drops()
    for shelf in show:
        rows = groups.get(shelf, [])
        lines.append(f"### {_heading(shelf)}")
        lines.append(_SHELF_BLURBS[shelf])
        if not rows:
            lines.append("(empty — no files on this shelf)")
        else:
            for doc in rows:
                tags = _tags_of(doc)
                tag_bit = f" [{', '.join(tags)}]" if tags else ""
                folder = _folder_of(doc)
                folder_bit = f" (Ordner: {folder})" if folder else ""
                summary = _summary_of(doc) or "No summary available"
                lines.append(f"- **{_file_name_of(doc)}**{folder_bit}{tag_bit}: {summary}")
        # Never a silent cap. Without this line the model reads a truncated
        # shelf as the whole shelf, and the listing instruction above ("answer
        # ONLY from that shelf's group") turns that into a confident wrong
        # answer with no way to hedge.
        missing = dropped.get(shelf, 0)
        if missing > 0:
            lines.append(
                f"- (und {missing} weitere Datei(en) auf diesem Regal, hier nicht aufgeführt — "
                f"diese Liste ist unvollständig; sage das, statt sie als vollständig zu behandeln)"
            )
        lines.append("")

    if unknown:
        lines.append("### Unattributed")
        lines.append("Shelf was not stated for these files — do not assign them to Büroarchiv or Basiswissen.")
        for doc in unknown:
            summary = _summary_of(doc) or "No summary available"
            lines.append(f"- **{_file_name_of(doc)}**: {summary}")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def in_scope_shelves_from_context() -> list[Shelf]:
    """Shelves the current turn is authorized to read, or empty when unknown."""
    try:
        from aiq_agent.knowledge.scoping import get_scoped_collections_from_context

        entries = get_scoped_collections_from_context()
    except Exception:
        return []
    if not entries:
        return []
    return [entry.shelf for entry in entries if entry.shelf]
