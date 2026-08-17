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
    "what files",
    "which files",
    "what's in",
    "whats in",
    "what do you have",
    "what have you",
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
    """Dedupe by ``(collection, file_name)``, keep user shelves, then spend the cap on base.

    ``max_documents`` ``None``/``0``/negative disables the cap. When user-shelf
    files alone overflow the cap, each non-empty user shelf keeps at least one
    file (a whole shelf must not vanish so the agent can still say what is on it).
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

    if not max_documents or max_documents < 0:
        return user_docs + base_docs

    if len(user_docs) <= max_documents:
        leftover = max_documents - len(user_docs)
        return user_docs + base_docs[:leftover]

    nonempty = [shelf for shelf in user_shelves if groups.get(shelf)]
    if not nonempty:
        return base_docs[:max_documents]

    share = max(1, max_documents // len(nonempty))
    kept: list[Any] = []
    remainder_pool: list[Any] = []
    for shelf in nonempty:
        group = groups[shelf]
        kept.extend(group[:share])
        remainder_pool.extend(group[share:])
    leftover = max_documents - len(kept)
    if leftover > 0:
        kept.extend(remainder_pool[:leftover])
    return kept[:max_documents]


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
    if not any(cue in text for text in haystacks for cue in _LISTING_CUES):
        return None
    for shelf, tokens in _SHELF_HINTS:
        for token in tokens:
            token_l = token.lower()
            token_folded = token_l.replace("ä", "ae").replace("ö", "oe").replace("ü", "ue")
            if any(token_l in text or token_folded in text for text in haystacks):
                return shelf
    return None


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
    if focused is not None:
        other = [SHELF_QUALIFIERS[s] for s in _INVENTORY_ORDER if s != focused]
        lines.append(
            f"This question asked only about **{SHELF_QUALIFIERS[focused]}**. "
            f"Other shelves ({', '.join(other)}) exist on this request but are not listed."
        )
        lines.append("")

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
                summary = _summary_of(doc) or "No summary available"
                lines.append(f"- **{_file_name_of(doc)}**{tag_bit}: {summary}")
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
