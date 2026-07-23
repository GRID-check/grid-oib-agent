"""``surface_documents`` tool — present REAL project/Büroarchiv files to the user.

The chat has always *cited* documents; it never *surfaced* them for browsing. This
tool closes that gap: the answering agent calls it when the user is looking for
work they did ("finde das Projekt, an dem ich gearbeitet habe", "zeig mir Unterlagen
zu Fluchtwegen") or is developing an idea and would benefit from seeing the relevant
files. The tool runs a DETERMINISTIC vector search over the in-scope project and
Büroarchiv corpora — never the LLM inventing filenames — aggregates one hit per file,
and emits a :class:`~aiq_agent.cards.models.DocumentGridCard` into the
conversation-scoped :class:`~aiq_agent.cards.registry.CardRegistry`. The frontend
resolves each real file name to its live document row and renders clickable
file-explorer preview cards.

``document_grid`` is a SYSTEM card (see ``SYSTEM_CARD_TYPES``): the model cannot
fabricate one via ``emit_card`` — it can only ask this tool to run a real search.
The tool mirrors the ``emit_card`` / ``remember`` registry pattern exactly.
"""

import asyncio
import logging
from typing import Literal

from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

logger = logging.getLogger(__name__)

# Chunks retrieved per in-scope collection before per-file aggregation. Comfortably
# exceeds MAX_SURFACED_FILES so a file's best chunk is never starved by the cap.
_CHUNK_TOP_K = 24
# Files shown in the grid. A tight, scannable set — the grid is a "here are the
# relevant documents" affordance, not an exhaustive search results page.
MAX_SURFACED_FILES = 8
# Minimum best-chunk relevance (0..1) for a file to be worth surfacing. A cheap,
# deterministic quality gate so weak vector hits never fill the grid with
# irrelevant files — the user should only see documents that are actually a good
# match. (A fast LLM re-ranker over the surviving candidates is a possible future
# refinement; kept out for now to keep this tool latency-free.)
MIN_SURFACE_SCORE = 0.35


def _source_for_collection(collection: str) -> Literal["projekt", "buero"] | None:
    """Map a RAG collection name to its coarse corpus label, or ``None``.

    ``proj_<uuid>`` → the user's project documents; ``archiv_<orgId>`` → the org's
    shared Büroarchiv. Anything else (the base OIB corpus, session scratch) is not
    a user-owned document store and is not surfaced by this tool.
    """
    if collection.startswith("proj_"):
        return "projekt"
    if collection.startswith("archiv_"):
        return "buero"
    return None


def _target_collections(scope: list[str] | None) -> list[str]:
    """The in-scope collections this tool searches: project + Büroarchiv only.

    Deliberately excludes the base OIB corpus (law/Richtlinien) — that is surfaced
    as citations, not as "files you worked on". Order-preserving and deduplicated.
    """
    seen: set[str] = set()
    targets: list[str] = []
    for collection in scope or []:
        if _source_for_collection(collection) is not None and collection not in seen:
            seen.add(collection)
            targets.append(collection)
    return targets


def _aggregate_surfaced(hits: list[tuple[object, str]], max_files: int) -> list[dict]:
    """Reduce (chunk, source) pairs to one best entry per file, score-sorted.

    Keeps each file's highest-scoring chunk (its snippet/page/score), sorts files
    by that best score descending, and caps at ``max_files``. Mirrors the document
    search endpoint's ``_aggregate_hits`` so surfaced files match the file browser's
    semantic search exactly.
    """
    best: dict[str, dict] = {}
    for chunk, source in hits:
        file_name = getattr(chunk, "file_name", None)
        if not file_name:
            continue
        score = float(getattr(chunk, "score", 0.0) or 0.0)
        # Quality gate: a weak best-chunk match is not worth surfacing.
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
    ordered = sorted(best.values(), key=lambda d: d["score"], reverse=True)
    return ordered[:max_files]


class SurfaceDocumentsConfig(FunctionBaseConfig, name="surface_documents"):
    """Configuration for the ``surface_documents`` tool."""


_TOOL_DESCRIPTION = (
    "Surface REAL project and Büroarchiv documents to the user as a grid of clickable "
    "preview cards. Call this when the user is looking for their own material — a project "
    "or documents they worked on, files about a topic, or reference material for an idea "
    "they are developing ('finde das Projekt zu…', 'welche Unterlagen habe ich zu…', 'zeig "
    "mir ähnliche Fälle'). This runs a real semantic search over the uploaded documents and "
    "shows the actual matching files; it does NOT answer legal questions (use the knowledge "
    "search for that) and never invents documents. Pass `query`: the topic to search for "
    "(a phrase, not a full sentence). Optionally pass `title`: a short heading for the grid. "
    "The tool returns each found document's summary and tags (metadata only, not the full "
    "text); use them to introduce the grid CONVERSATIONALLY in your written answer — say what "
    "you found, why one or two stand out, and invite the user's thoughts (e.g. 'Ich habe "
    "einige passende Unterlagen gefunden … besonders X dürfte dich interessieren. Was denkst "
    "du?'). The grid already shows the files, so do not just list their names."
)


@register_function(config_type=SurfaceDocumentsConfig)
async def surface_documents(tool_config: SurfaceDocumentsConfig, builder: Builder):
    async def _surface(query: str, title: str | None = None) -> str:
        """Run a real corpus search and emit a document_grid card of the results."""
        query = (query or "").strip()
        if not query:
            return "Provide a non-empty `query` describing the documents to surface."

        from aiq_agent.knowledge.scoping import get_collection_scope_from_context

        try:
            scope = get_collection_scope_from_context()
        except Exception:  # pragma: no cover - defensive; scoping never raises normally
            logger.debug("surface_documents: could not read collection scope", exc_info=True)
            scope = None

        targets = _target_collections(scope)
        if not targets:
            return (
                "No project or Büroarchiv documents are in scope to search, so there is "
                "nothing to surface. Answer from the other available sources instead."
            )

        from aiq_agent.knowledge.factory import get_active_retriever

        retriever = get_active_retriever()

        async def _retrieve(collection: str) -> list[tuple[object, str]]:
            source = _source_for_collection(collection)
            try:
                result = await retriever.retrieve(
                    query=query, collection_name=collection, top_k=_CHUNK_TOP_K, filters=None
                )
            except Exception:
                # Fail-open per collection: one unreachable store never sinks the rest.
                logger.warning("surface_documents: retrieval failed for %s", collection, exc_info=True)
                return []
            chunks = getattr(result, "chunks", None) or []
            return [(chunk, source) for chunk in chunks if source is not None]

        gathered = await asyncio.gather(*(_retrieve(collection) for collection in targets))
        hits: list[tuple[object, str]] = [hit for group in gathered for hit in group]

        documents = _aggregate_surfaced(hits, MAX_SURFACED_FILES)
        if not documents:
            return (
                f"I searched the project and Büroarchiv documents for '{query}' but found no "
                "matching files to surface. Tell the user nothing relevant was found."
            )

        # Enrich each surfaced file with its document-level summary + tags (metadata
        # only — never the full document) so the answering agent can introduce them
        # conversationally ("here is what I found, I think you will like X because …").
        meta = await _fetch_document_metadata(targets)
        for doc in documents:
            info = meta.get(doc["file_name"])
            if info:
                if info.get("summary"):
                    doc["summary"] = info["summary"]
                doc["_tags"] = info.get("tags") or []

        from aiq_agent.cards.models import grid_card_adapter
        from aiq_agent.cards.registry import get_card_registry

        card = {
            "type": "document_grid",
            "title": (title or "").strip() or f"Relevante Dokumente – {query}",
            "query": query,
            # Strip the agent-only `_tags` helper before validating the card.
            "documents": [{k: v for k, v in doc.items() if not k.startswith("_")} for doc in documents],
        }
        try:
            validated = grid_card_adapter.validate_python(card).model_dump(exclude_none=True)
        except Exception as exc:
            logger.exception("surface_documents: failed to build document_grid card")
            return f"Error: could not build the document grid ({exc})."

        registry = get_card_registry()
        if registry is None:
            logger.info("surface_documents: no card registry bound; grid of %d file(s) dropped", len(documents))
            return "Noted, but no card channel is available in this context; continue with your written answer."

        registry.add(validated)
        logger.info("surface_documents: surfaced %d file(s) for query %r", len(documents), query)
        return _briefing_for_agent(query, documents)

    yield FunctionInfo.from_fn(_surface, description=_TOOL_DESCRIPTION)


async def _fetch_document_metadata(collections: list[str]) -> dict[str, dict]:
    """Map file_name → {summary, tags} across the given collections (metadata only).

    Reads the per-document summary/tag store the ingest pipeline populates — never
    the full document text. Fail-open: any lookup error yields no metadata for that
    collection, so the grid still surfaces (just without the enriched briefing).
    """
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
                out[name] = {"summary": getattr(doc, "summary", None), "tags": getattr(doc, "tags", None)}
    return out


_SOURCE_LABEL = {"projekt": "Projekt", "buero": "Büroarchiv"}


def _briefing_for_agent(query: str, documents: list[dict]) -> str:
    """A metadata-only briefing so the agent can introduce the grid conversationally.

    Lists each surfaced file with its corpus, one-line summary, tags, and best
    matched passage — enough for the agent to say what it found and why each is
    relevant, then invite the user's thoughts. Never contains full document text.
    """
    lines: list[str] = [
        f"Surfaced {len(documents)} document(s) to the user as a clickable preview grid for '{query}'.",
        "Introduce them CONVERSATIONALLY in your written answer: say what you found, note briefly why one or "
        "two stand out (use the summaries below), and invite the user's thoughts — e.g. 'Ich habe einige "
        "passende Unterlagen gefunden … besonders X dürfte relevant sein. Was denkst du?'. Do NOT just list "
        "file names or paste the snippets verbatim; the grid already shows them.",
        "",
    ]
    for i, doc in enumerate(documents, 1):
        label = _SOURCE_LABEL.get(doc.get("source") or "", "Dokument")
        lines.append(f'{i}. "{doc["file_name"]}" [{label}]')
        if doc.get("summary"):
            lines.append(f"   Worum es geht: {doc['summary']}")
        tags = doc.get("_tags") or []
        if tags:
            lines.append(f"   Schlagworte: {', '.join(str(t) for t in tags[:6])}")
        if doc.get("snippet"):
            lines.append(f'   Passende Stelle: "{doc["snippet"]}"')
    return "\n".join(lines)
