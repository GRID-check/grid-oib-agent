"""``surface_documents`` — put REAL project/Büroarchiv files in front of the user.

Discovery, not evidence. ``knowledge_search`` reads and cites passages; this
tool opens a file in the UI. Citations already peek the cited file — the
agent must not call this after citing.

- ``filename=``: the user asked to *see* a named file (no legal question).
- ``mode=one`` + ``query=``: they asked to see the best matching file and
  you do not have the name.
- ``mode=many`` + ``query=``: they are browsing; a short choice, not a catalogue.

The model cannot invent filenames. The tool looks up or searches the in-scope
project + Büroarchiv corpora and emits a ``document_grid`` system card.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Literal

from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

logger = logging.getLogger(__name__)

_CHUNK_TOP_K = 40
# A short choice, never a catalogue. Platform → Retrieval can lower this.
MAX_SURFACED_FILES = 3

# ---------------------------------------------------------------------------
# The three constants below were calibrated against `Chunk.score` when it was
# the vector store's raw `exp(-distance)`. `Chunk.score` is now a TRUE COSINE
# similarity (`cosine_similarity_from_store_score`), so the literal numbers no
# longer mean what they meant, and each has been converted rather than re-tuned:
# the intended behaviour is preserved, nobody's judgement is overridden here.
#
#   cos = 1 + ln(s)   for the old s = exp(cos - 1)
#
# Two of the three convert exactly. `CLEAR_WINNER_GAP` does not — a difference
# on a log scale is not a difference on a linear one — and is flagged below.
#
# All three are BACKEND-CONDITIONAL. Only the `llamaindex` backend reports a
# cosine; `foundational_rag` reports clamped reranker logits, which are not in
# cosine space and for which none of these numbers is calibrated.
# ---------------------------------------------------------------------------

# Weak hits are how a citation-health screenshot pulls in every IFC in the
# project. Floor is high on purpose.
# Was 0.58 on the exp(-distance) scale; 1 + ln(0.58) = 0.455 is the same gate.
MIN_SURFACE_SCORE = 0.455

# In browse, drop files that are not almost as good as the winner.
# Was a RATIO of 0.88 against the winner's score. A constant ratio on the old
# scale is a constant OFFSET on the cosine scale -- ln(0.88) = -0.128 -- so this
# is now expressed as the offset it always was, which is also the form that
# behaves the same at every absolute similarity instead of drifting with it.
MANY_RELATIVE_DROP = 0.128

# If the winner is this far ahead of #2, there is no real choice.
# APPROXIMATE CONVERSION, and the one number here that is not exact: 0.12 on the
# old scale is 0.14 in cosine at s=0.9 and 0.22 at s=0.6, because the transform
# is logarithmic. 0.15 is the value at the top of that range, where surfaced
# candidates actually sit. Re-derive with the retrieval-eval harness.
CLEAR_WINNER_GAP = 0.15

_IMAGE_EXT = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".tif", ".tiff")
_MODEL_EXT = (".ifc", ".ifczip")
# Only kinds that must not leak into a different medium. A query like
# "Lageplan" is a topic, not a file-kind filter — that would drop plan.pdf.
_QUERY_KIND_HINTS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("image", ("screenshot", "bildschirm", "png", "jpg", "jpeg", "foto", "photo", "zitation", "citation", "zitier")),
    ("model", ("ifc", "bim", "modell")),
)

SurfaceMode = Literal["one", "many"]


def _source_for_collection(collection: str) -> Literal["projekt", "buero"] | None:
    """LEGACY: guess a card label from a collection-id prefix.

    Live retrieval must not call this when a signed shelf map is present
    (ADR-0047). Kept for names-only / pre-shelf callers.
    """
    if collection.startswith("proj_"):
        return "projekt"
    if collection.startswith("archiv_"):
        return "buero"
    return None


def _source_for_target(
    collection: str,
    source_by_collection: dict[str, str],
) -> Literal["projekt", "buero"] | None:
    """Label a retrieve target. A signed map is exclusive — no prefix guess."""
    if source_by_collection:
        raw = source_by_collection.get(collection)
        return raw if raw in ("projekt", "buero") else None
    return _source_for_collection(collection)


def _target_collections(
    scope: list[str] | None,
    *,
    shelf: str | None = None,
    scoped: list | None = None,
) -> list[str]:
    """Project + Büroarchiv only. Never the OIB corpus (that is citations).

    ``shelf`` narrows further: ``archiv`` keeps only the Büroarchiv,
    ``project`` only this project's files. A listing question that names a
    shelf must not surface the other one.

    When ``scoped`` entries carry a stated shelf (ADR-0047), that shelf wins
    and the collection-id prefix is not inspected.
    """
    from aiq_agent.common.source_kinds import Shelf
    from aiq_agent.common.source_kinds import parse_shelf

    wanted = parse_shelf(shelf)
    seen: set[str] = set()
    targets: list[str] = []
    if scoped:
        for entry in scoped:
            entry_shelf = getattr(entry, "shelf", None)
            collection = getattr(entry, "collection", None)
            if not collection or collection in seen:
                continue
            if entry_shelf is Shelf.BASE:
                continue
            if wanted is not None and entry_shelf != wanted:
                continue
            if wanted is None and entry_shelf not in (Shelf.PROJECT, Shelf.ARCHIV):
                continue
            seen.add(collection)
            targets.append(collection)
        return targets
    for collection in scope or []:
        source = _source_for_collection(collection)
        if source is None:
            continue
        if wanted is Shelf.ARCHIV and source != "buero":
            continue
        if wanted is Shelf.PROJECT and source != "projekt":
            continue
        if collection not in seen:
            seen.add(collection)
            targets.append(collection)
    return targets


def _match_known_filename(requested: str, known: list[str]) -> str | None:
    """Resolve a user/agent-supplied name onto an indexed file name."""
    needle = (requested or "").strip()
    if not needle or not known:
        return None
    if needle in known:
        return needle
    lowered = {name.lower(): name for name in known}
    if needle.lower() in lowered:
        return lowered[needle.lower()]
    # Longest contained name first so "Plan EG.pdf" wins over "Plan.pdf".
    for name in sorted(known, key=len, reverse=True):
        if name.lower() in needle.lower() or needle.lower() in name.lower():
            return name
    return None


def _filename_mentioned_in_query(query: str, known: list[str]) -> str | None:
    """If the query already names a file, that file is the subject."""
    text = (query or "").strip().lower()
    if not text or not known:
        return None
    for name in sorted(known, key=len, reverse=True):
        if name.lower() in text:
            return name
    return None


def _file_kind(file_name: str) -> str:
    """Coarse kind so a screenshot query does not also surface IFC models."""
    lower = (file_name or "").lower()
    if lower.endswith(_MODEL_EXT):
        return "model"
    if lower.endswith(_IMAGE_EXT):
        return "image"
    if any(token in lower for token in ("grundriss", "schnitt", "ansicht", "lageplan")):
        return "drawing"
    return "document"


def _query_kind(query: str) -> str | None:
    text = (query or "").strip().lower()
    if not text:
        return None
    for kind, tokens in _QUERY_KIND_HINTS:
        if any(token in text for token in tokens):
            return kind
    return None


def _aggregate_hits(hits: list[tuple[object, str]]) -> list[dict]:
    """One best chunk per file, score-sorted, quality-gated."""
    best: dict[str, dict] = {}
    for chunk, source in hits:
        file_name = getattr(chunk, "file_name", None)
        if not file_name:
            continue
        score = float(getattr(chunk, "score", 0.0) or 0.0)
        if score < MIN_SURFACE_SCORE:
            continue
        existing = best.get(file_name)
        if existing is not None and existing["score"] >= score:
            continue
        snippet = (getattr(chunk, "content", "") or "").strip()
        if len(snippet) > 300:
            snippet = snippet[:300].rstrip() + "…"
        best[file_name] = {
            "file_name": file_name,
            "snippet": snippet or None,
            "page": getattr(chunk, "page_number", None),
            "score": round(score, 4),
            "source": source,
        }
    return sorted(best.values(), key=lambda row: row["score"], reverse=True)


def _pick_one(ordered: list[dict]) -> list[dict]:
    return ordered[:1]


def _pick_many(ordered: list[dict], max_files: int) -> list[dict]:
    """Keep the winner, plus only same-kind files that are almost as good."""
    if not ordered:
        return []
    winner = ordered[0]
    if len(ordered) == 1:
        return [winner]
    best = float(winner["score"] or 0.0)
    second = float(ordered[1]["score"] or 0.0)
    if best - second >= CLEAR_WINNER_GAP:
        return [winner]
    winner_kind = _file_kind(str(winner["file_name"]))
    cap = max(1, min(max_files, MAX_SURFACED_FILES))
    floor = max(MIN_SURFACE_SCORE, best - MANY_RELATIVE_DROP)
    kept = [winner]
    for row in ordered[1:]:
        if len(kept) >= cap:
            break
        if _file_kind(str(row["file_name"])) != winner_kind:
            continue
        if float(row["score"] or 0.0) < floor:
            continue
        kept.append(row)
    return kept


def _aggregate_surfaced(
    hits: list[tuple[object, str]],
    max_files: int,
    mode: SurfaceMode = "one",
    query: str = "",
) -> list[dict]:
    ordered = _aggregate_hits(hits)
    hint = _query_kind(query)
    if hint:
        hinted = [row for row in ordered if _file_kind(str(row["file_name"])) == hint]
        if hinted:
            ordered = hinted
    if mode == "many":
        return _pick_many(ordered, max_files)
    return _pick_one(ordered)


class SurfaceDocumentsConfig(FunctionBaseConfig, name="surface_documents"):
    """Configuration for the ``surface_documents`` tool."""


_TOOL_DESCRIPTION = (
    "Show the user a REAL project or Büroarchiv FILE in the UI (preview card). "
    "This is not a citation tool — it does not return quotable passages.\n"
    "WHEN TO CALL — the user asked to SEE or BROWSE their own files, with no "
    "legal question to answer. Examples: 'zeig mir den Brandschutzplan', "
    "'öffne Schnitt.pdf', 'welche Unterlagen habe ich zu Fluchtwegen'.\n"
    "- `filename=` the exact indexed name (inventory or the user) when they "
    "named a file. Opens that one file.\n"
    "- `mode=one` (default) + `query=` when they asked to see the best matching "
    "file and you do not have the name. Opens one file. Not a follow-up to a "
    "citation.\n"
    "- `mode=many` + `query=` only when they are choosing among two or three "
    "NEARLY EQUALLY relevant files of the same kind. Never a catalogue, never "
    "the inventory.\n"
    "- `shelf=archiv` / `shelf=project` when they asked to see files on ONE "
    "shelf (Büroarchiv vs this project). Do not mix the two.\n"
    "Asking for files of a KIND ('hab ich sonst noch Grundrisse', 'welche Fotos "
    "vom Bestand') is a browse: `mode=many` on that shelf, so they can open them.\n"
    "WHEN NOT TO CALL — to say what is on a shelf ('welche Dateien hast du im "
    "Büroarchiv'), answer from the knowledge-base inventory instead; where it "
    "gives a count rather than names, say the count and offer to search. To read, "
    "quote, or cite a passage, use `knowledge_search`. "
    "The UI already peeks the cited file; do not also call this tool after citing. "
    "Do not use this for OIB / RIS / web questions.\n"
    "Never invent filenames. After a successful call, talk about the file in "
    "prose; do not dump a filename list."
)


@register_function(config_type=SurfaceDocumentsConfig)
async def surface_documents(tool_config: SurfaceDocumentsConfig, builder: Builder):
    async def _surface(
        query: str = "",
        filename: str | None = None,
        title: str | None = None,
        mode: str | None = None,
        shelf: str | None = None,
    ) -> str:
        """Show project or Büroarchiv files in the UI. Not a citation tool.

        Args:
            query: Topic to search when the user did not name a file (e.g. "Fluchtwege EG").
            filename: Exact indexed file name to open (e.g. "Brandschutzplan_EG.pdf").
            title: Optional card heading. Leave empty to use the file name or query.
            mode: `one` (default) opens a single file; `many` offers a short browse choice.
            shelf: `archiv` (Büroarchiv) or `project` (this project). Omit to search both.
        """
        query = (query or "").strip()
        filename = (filename or "").strip() or None
        shelf = (shelf or "").strip() or None
        if mode is not None and mode not in ("one", "many"):
            return "Error: `mode` must be `one` (open the best file) or `many` (short browse choice)."
        if shelf is not None and shelf not in ("archiv", "project"):
            return "Error: `shelf` must be `archiv` (Büroarchiv) or `project` (this project)."
        if not query and not filename:
            return "Provide `filename=` (open this named file) or `query=` (search). Use `mode=many` only to browse."

        from aiq_agent.knowledge.inventory import shelf_hint_from_query
        from aiq_agent.knowledge.scoping import get_collection_scope_from_context
        from aiq_agent.knowledge.scoping import get_scoped_collections_from_context

        try:
            scoped_entries = get_scoped_collections_from_context()
        except Exception:
            logger.debug("surface_documents: could not read scoped collections", exc_info=True)
            scoped_entries = None
        try:
            scope = get_collection_scope_from_context()
        except Exception:
            logger.debug("surface_documents: could not read collection scope", exc_info=True)
            scope = None

        hinted = shelf_hint_from_query(query)
        hinted_value = hinted.value if hinted is not None else None
        resolved_shelf = shelf or (hinted_value if hinted_value in ("archiv", "project") else None)
        targets = _target_collections(scope, shelf=resolved_shelf, scoped=scoped_entries)
        if not targets:
            if resolved_shelf == "archiv":
                return (
                    "No Büroarchiv documents are in scope to search. The OIB corpus is "
                    "Basiswissen, not the Büroarchiv — answer from the inventory's "
                    "Büroarchiv group (empty means empty)."
                )
            return (
                "No project or Büroarchiv documents are in scope to search, so there is "
                "nothing to surface. Answer from the other available sources instead."
            )

        meta = await _fetch_document_metadata(targets)
        known_names = list(meta.keys())

        named = filename
        if named:
            named = _match_known_filename(named, known_names)
        if filename and not named and not query:
            return (
                f"No indexed file matches filename={filename!r}. "
                "Check the spelling against the knowledge-base inventory, "
                "or pass a short topic `query` with `mode=many` to browse."
            )
        if not named and query:
            named = _filename_mentioned_in_query(query, known_names)

        effective: SurfaceMode = "many" if mode == "many" and not named else "one"

        from aiq_agent.common.retrieval_settings import get_retrieval_setting

        chunk_top_k = get_retrieval_setting("surface.chunk_top_k", _CHUNK_TOP_K)
        max_files = get_retrieval_setting("surface.max_files", MAX_SURFACED_FILES)

        documents: list[dict]
        if named:
            documents = await _surface_named(named, targets, meta, query or named, chunk_top_k)
        else:
            documents = await _surface_search(query, targets, effective, chunk_top_k, max_files)

        if not documents:
            subject = filename or query
            return (
                f"No project or Büroarchiv file matched {subject!r}. "
                "Try a narrower `query` (a filename fragment, a plan type, a project name) "
                "or check the knowledge-base inventory for the exact `filename` spelling."
            )

        for doc in documents:
            info = meta.get(doc["file_name"])
            if info:
                if info.get("summary"):
                    doc["summary"] = info["summary"]
                doc["_tags"] = info.get("tags") or []
                # Underscore-prefixed: the briefing reads it, the card payload
                # strips it (the `document_grid` schema has no folder field).
                doc["_folder_path"] = info.get("folder_path") or None

        from aiq_agent.cards.models import grid_card_adapter
        from aiq_agent.cards.registry import get_card_registry

        heading = (title or "").strip()
        if not heading:
            heading = documents[0]["file_name"] if effective == "one" else f"Passende Unterlagen – {query}"

        card = {
            "type": "document_grid",
            "title": heading,
            "query": query or filename,
            "documents": [{k: v for k, v in doc.items() if not k.startswith("_")} for doc in documents],
        }
        try:
            validated = grid_card_adapter.validate_python(card).model_dump(exclude_none=True)
        except Exception as exc:
            logger.exception("surface_documents: failed to build document_grid card")
            return f"Error: could not build the document card ({exc})."

        registry = get_card_registry()
        if registry is None:
            logger.info("surface_documents: no card registry; %d file(s) dropped", len(documents))
            return "Noted, but no card channel is available in this context; continue with your written answer."

        registry.add(validated)
        logger.info(
            "surface_documents: mode=%s surfaced %d file(s) query=%r filename=%r",
            effective,
            len(documents),
            query,
            filename,
        )
        return _briefing_for_agent(query or filename or "", documents, effective)

    yield FunctionInfo.from_fn(_surface, description=_TOOL_DESCRIPTION)


async def _surface_named(
    file_name: str,
    targets: list[str],
    meta: dict[str, dict],
    retrieve_query: str,
    chunk_top_k: int,
) -> list[dict]:
    """Open one known file. Search only to fetch a matching passage."""
    info = meta.get(file_name) or {}
    source = "projekt"
    hits = await _retrieve_all(targets, retrieve_query, chunk_top_k)
    for chunk, src in hits:
        if getattr(chunk, "file_name", None) == file_name:
            source = src
            break
    snippet = None
    page = None
    score = 1.0
    for chunk, src in hits:
        if getattr(chunk, "file_name", None) != file_name:
            continue
        snippet = (getattr(chunk, "content", "") or "").strip() or None
        if snippet and len(snippet) > 300:
            snippet = snippet[:300].rstrip() + "…"
        page = getattr(chunk, "page_number", None)
        score = round(float(getattr(chunk, "score", 0.0) or 0.0), 4)
        source = src
        break
    return [
        {
            "file_name": file_name,
            "snippet": snippet,
            "page": page,
            "score": score if score else 1.0,
            "source": source,
            "summary": info.get("summary"),
            "_folder_path": info.get("folder_path") or None,
        }
    ]


async def _surface_search(
    query: str,
    targets: list[str],
    mode: SurfaceMode,
    chunk_top_k: int,
    max_files: int,
) -> list[dict]:
    hits = await _retrieve_all(targets, query, chunk_top_k)
    return _aggregate_surfaced(hits, max_files, mode, query)


async def _retrieve_all(
    targets: list[str],
    query: str,
    chunk_top_k: int,
) -> list[tuple[object, str]]:
    from aiq_agent.knowledge.factory import get_active_retriever

    retriever = get_active_retriever()

    source_by_collection: dict[str, str] = {}
    try:
        from aiq_agent.common.source_kinds import Shelf
        from aiq_agent.knowledge.scoping import get_scoped_collections_from_context

        for entry in get_scoped_collections_from_context() or []:
            if entry.shelf is Shelf.ARCHIV:
                source_by_collection[entry.collection] = "buero"
            elif entry.shelf is Shelf.PROJECT:
                source_by_collection[entry.collection] = "projekt"
    except Exception:
        logger.debug("surface_documents: no scoped shelves for retrieve", exc_info=True)

    async def _retrieve(collection: str) -> list[tuple[object, str]]:
        source = _source_for_target(collection, source_by_collection)
        if source is None:
            return []
        try:
            result = await retriever.retrieve(query=query, collection_name=collection, top_k=chunk_top_k, filters=None)
        except Exception:
            logger.warning("surface_documents: retrieval failed for %s", collection, exc_info=True)
            return []
        chunks = getattr(result, "chunks", None) or []
        return [(chunk, source) for chunk in chunks]

    gathered = await asyncio.gather(*(_retrieve(collection) for collection in targets))
    return [hit for group in gathered for hit in group]


async def _fetch_document_metadata(collections: list[str]) -> dict[str, dict]:
    """Map file_name → {summary, tags, folder_path} across the given collections."""
    from aiq_agent.knowledge.factory import get_available_documents_async

    async def _for(collection: str) -> list:
        try:
            return await get_available_documents_async(collection)
        except Exception:
            logger.debug("surface_documents: metadata lookup failed for %s", collection, exc_info=True)
            return []

    out: dict[str, dict] = {}
    for docs in await asyncio.gather(*(_for(c) for c in collections)):
        for doc in docs:
            name = getattr(doc, "file_name", None)
            if name and name not in out:
                out[name] = {
                    "summary": getattr(doc, "summary", None),
                    "tags": getattr(doc, "tags", None),
                    # Where the user filed it (ADR-0049). The briefing says it so
                    # the agent can answer "die drei Dokumente in Brandschutz"
                    # instead of only naming files.
                    "folder_path": getattr(doc, "folder_path", None),
                }
    return out


_SOURCE_LABEL = {"projekt": "Projekt", "buero": "Büroarchiv"}
_BRIEF_SNIPPET_MAX = 120
_BRIEF_SUMMARY_MAX = 160


def _clip(text: str | None, limit: int) -> str | None:
    value = (text or "").strip()
    if not value:
        return None
    if len(value) <= limit:
        return value
    return value[:limit].rstrip() + "…"


def _file_label(doc: dict) -> str:
    return _SOURCE_LABEL.get(doc.get("source") or "", "Dokument")


def _folder_of(doc: dict) -> str:
    """Materialised folder path this file is filed under, or ``""`` (ADR-0049)."""
    return str(doc.get("_folder_path") or "").strip()


def _briefing_for_agent(query: str, documents: list[dict], mode: SurfaceMode) -> str:
    """Concise agent briefing. One file: 4–6 lines. Many: one line per file."""
    if mode == "one" or len(documents) == 1:
        return _brief_one(documents[0])
    return _brief_many(query, documents)


def _brief_one(doc: dict) -> str:
    name = doc["file_name"]
    label = _file_label(doc)
    folder = _folder_of(doc)
    where = f"{label}, Ordner {folder}" if folder else label
    lines = [f'Opened "{name}" ({where}) beside the chat.']
    summary = _clip(doc.get("summary"), _BRIEF_SUMMARY_MAX)
    if summary:
        lines.append(f"Worum es geht: {summary}")
    snippet = _clip(doc.get("snippet"), _BRIEF_SNIPPET_MAX)
    if snippet:
        page = doc.get("page")
        where = f"S. {page}: " if page else ""
        lines.append(f'{where}"{snippet}"')
    lines.append("The UI shows the file. Talk about it; do not re-open it or dump filenames.")
    return "\n".join(lines)


def _brief_many(query: str, documents: list[dict]) -> str:
    lines = [
        f"Offered {len(documents)} close matches for {query!r}. "
        "Short choice — the user picks. Do not enumerate the filenames."
    ]
    for doc in documents:
        label = _file_label(doc)
        folder = _folder_of(doc)
        where = f"{label}, Ordner {folder}" if folder else label
        summary = _clip(doc.get("summary"), _BRIEF_SUMMARY_MAX)
        row = f'- "{doc["file_name"]}" ({where})'
        if summary:
            row = f"{row} — {summary}"
        lines.append(row)
    return "\n".join(lines)
