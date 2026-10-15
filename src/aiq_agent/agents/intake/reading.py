"""How the Erfassungs-Agent reads, and how every read reaches the read log.

Two ways in. ``read_document`` reads a project document's pages in full, which
is what the intake mostly needs: a value sits in a title block, a table or a
Baubeschreibung paragraph, and a ranked search returns fragments of exactly the
pages one wants whole. ``knowledge_search`` and ``read_passage`` stay the way to
FIND where a value is; they are the shared NAT tools, bound unchanged, and
:class:`IntakeToolMiddleware` logs what they returned.

``read_document`` reads the indexed text page by page from the collection's
chunks, the reader the closed-project reading uses
(``knowledge/collection_pages.read_pages``, a structural fetch from the vector
store in reading order), so nothing is parsed again. It reads
only documents of the run's own project shelves: the scope the BFF signed into
the run's envelope, which for an intake is the project's main collection
(ADR-0111, decision 6), never the corpus and never a restricted folder.
"""

from __future__ import annotations

import asyncio
import difflib
import logging
import re
from collections.abc import Awaitable
from collections.abc import Callable
from collections.abc import Iterable
from dataclasses import dataclass
from dataclasses import field
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware import hook_config
from langchain_core.messages import ToolMessage
from langchain_core.tools import StructuredTool
from pydantic import BaseModel
from pydantic import Field

from aiq_agent.common.grounding_block import strip_trace_lanes
from aiq_agent.common.message_utils import content_to_text
from aiq_agent.common.source_kinds import SHELF_QUALIFIERS
from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.restricted_collections import is_restricted_collection

from .read_log import IntakeReadLog
from .read_log import current_read_log

logger = logging.getLogger(__name__)

READ_DOCUMENT_TOOL = "read_document"
#: The shared tools whose results are logged, and the one of them that counts as opening a file.
SEARCH_TOOL = "knowledge_search"
PASSAGE_TOOL = "read_passage"

#: Characters one ``read_document`` call returns (about 3 000 tokens): a few dense pages.
MAX_READ_CHARS = 12_000
#: Pages one call may name.
MAX_PAGES_PER_CALL = 30
#: Page numbers a truncated read offers as the next call.
NEXT_PAGES_OFFERED = 10

#: A citation as the tools print it: ``Plan.pdf, p.3`` (a grounding key), or ``Plan.pdf, S. 3`` / ``Seite 3``.
_KEY_PAGE = re.compile(r"^(?P<name>.*?),\s*(?:p\.|S\.|Seite)\s*(?P<page>\d+)$", re.IGNORECASE)


@dataclass
class DocumentPage:
    """One page of a document as indexed: its label as printed, its number when it is one, and its text."""

    label: str | None
    number: int | None
    parts: list[str] = field(default_factory=list)

    @property
    def text(self) -> str:
        return "\n\n".join(self.parts)


def _page_number(label: str | None) -> int | None:
    if label is None:
        return None
    try:
        number = int(label)
    except ValueError:
        return None
    return number if number >= 1 else None


def group_pages(chunks: Iterable[tuple[Any, str]]) -> list[DocumentPage]:
    """``(page_label, chunk text)`` in reading order, as pages. A chunk without a label follows the page before it."""
    pages: list[DocumentPage] = []
    for raw_label, raw_text in chunks:
        body = (raw_text or "").strip()
        if not body:
            continue
        label = str(raw_label).strip() if raw_label not in (None, "") else None
        if pages and (label is None or label == pages[-1].label):
            pages[-1].parts.append(body)
            continue
        pages.append(DocumentPage(label=label, number=_page_number(label), parts=[body]))
    return pages


# ── Where a document is ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class ProjectDocument:
    collection: str
    document: Any  # AvailableDocument

    @property
    def file_name(self) -> str:
        return str(getattr(self.document, "file_name", "") or "")


def project_collections() -> list[str]:
    """The run's project shelves from its signed scope: the corpus, the Archiv, a session and a restricted folder never.

    The BFF signs only the project's main collection into the run, so a restricted folder's
    collection should never be here. It is refused anyway: what the intake reads becomes a profile
    every member reads (ADR-0087, ADR-0111), and a scope that drifted must not widen that.
    """
    from aiq_agent.knowledge.scoping import get_scoped_collections_from_context

    entries = get_scoped_collections_from_context() or []
    return [
        entry.collection
        for entry in entries
        if entry.shelf in (None, Shelf.PROJECT) and not is_restricted_collection(entry.collection)
    ]


async def project_documents() -> list[ProjectDocument]:
    """Every document registered for the run's project shelves; empty on a store error."""
    from aiq_agent.knowledge.factory import get_available_documents_async

    found: list[ProjectDocument] = []
    for collection in project_collections():
        try:
            documents = await get_available_documents_async(collection)
        except Exception:  # noqa: BLE001 — an unreachable listing reads as no documents, said to the model
            logger.warning("Intake: document listing failed for %s", collection, exc_info=True)
            continue
        found.extend(ProjectDocument(collection=collection, document=document) for document in documents)
    return found


def fetch_document_pages(collection: str, file_name: str) -> list[tuple[Any, str]] | None:
    """``(page_label, chunk text)`` of one file from its collection's chunks. Blocking; raises on a store outage."""
    from aiq_agent.knowledge.collection_pages import read_pages

    return read_pages(collection, file_name)


def _names_of(document: ProjectDocument) -> list[str]:
    names = [document.file_name, str(getattr(document.document, "display_title", "") or "")]
    return [name.strip().casefold() for name in names if name.strip()]


def resolve_document(name: str, documents: list[ProjectDocument]) -> ProjectDocument | None:
    """The document named exactly (file name or display title, case aside); never a fragment."""
    wanted = (name or "").strip().casefold()
    return next((document for document in documents if wanted in _names_of(document)), None) if wanted else None


def _unknown_document(name: str, documents: list[ProjectDocument]) -> str:
    names = [document.file_name for document in documents]
    close = difflib.get_close_matches(name, names, n=3, cutoff=0.5)
    hint = f" Close names: {', '.join(f'„{candidate}“' for candidate in close)}." if close else ""
    return (
        f"No document named „{name}“ in this project ({len(names)} documents in scope).{hint} "
        "Call list_files for the exact names, or knowledge_search to find which document holds a value."
    )


# ── read_document ────────────────────────────────────────────────────────────


def _header(document: ProjectDocument, pages: list[DocumentPage]) -> list[str]:
    lines = [f"## {document.file_name} — {len(pages)} Seite(n)"]
    doc_class = getattr(document.document, "doc_class", None)
    if doc_class:
        lines.append(f"Dokumentart: {doc_class}")
    newer = getattr(document.document, "superseded_by", None)
    if newer:
        lines.append(
            f"Ältere Fassung: the current Fassung of this document is „{newer}“. "
            "Prefer values from the current Fassung; record from this one only what the current one does not state."
        )
    return lines


def _selected(pages: list[DocumentPage], wanted: list[int]) -> tuple[list[DocumentPage], list[int]]:
    if not wanted:
        return pages, []
    numbers = set(wanted)
    selected = [page for page in pages if page.number in numbers]
    present = {page.number for page in selected}
    return selected, [number for number in wanted if number not in present]


def render_pages(
    document: ProjectDocument, pages: list[DocumentPage], wanted: list[int], log: IntakeReadLog | None
) -> str:
    """The pages asked for, under ``[Seite N]`` markers, within :data:`MAX_READ_CHARS`; logs what it shows."""
    selected, missing = _selected(pages, wanted)
    lines = _header(document, pages)
    if missing:
        lines.append(f"No such page(s): {', '.join(map(str, missing))}.")
    used = 0
    shown = 0
    cut_page: DocumentPage | None = None
    for page in selected:
        room = MAX_READ_CHARS - used
        if shown and room < 400:
            break
        text = page.text if len(page.text) <= room else page.text[:room]
        if log is not None:
            log.log(document.file_name, page.number, text)
        lines.append(f"\n[Seite {page.label}]\n{text}" if page.label else f"\n{text}")
        used += len(text)
        shown += 1
        if len(text) < len(page.text):
            cut_page = page
            break
    rest = [page for page in selected[shown:] if page is not cut_page]
    if cut_page is not None:
        lines.append(
            f"\n[Cut: page {cut_page.label or '?'} was cut after {MAX_READ_CHARS} characters. The rest of it cannot be "
            'shown by read_document; find a phrase from it with knowledge_search(match="exact").]'
        )
    if rest:
        offered = [page.number for page in rest if page.number is not None][:NEXT_PAGES_OFFERED]
        follow = f" Continue with read_document(file_name=„{document.file_name}“, pages={offered})." if offered else ""
        bound = f"bounded at {MAX_READ_CHARS} characters"
        lines.append(f"\n[Not shown: {len(rest)} more page(s) of this read, {bound}.{follow}]")
    if not shown and not missing:
        lines.append("This document has no readable text (a drawing without a text layer, or not indexed yet).")
    return "\n".join(lines)


class ReadDocumentInput(BaseModel):
    file_name: str = Field(
        description=(
            "The document's exact file name as list_files, intake_needs or a search hit wrote it. Never invented."
        )
    )
    pages: list[int] | None = Field(
        default=None,
        description=(
            f"1-based page numbers to read, at most {MAX_PAGES_PER_CALL}. Omit to read from the first page on, as far "
            "as the bound reaches; the answer names the pages it did not show."
        ),
    )


READ_DOCUMENT_DESCRIPTION = (
    "Read a project document's text in full, page by page, under [Seite N] markers, as indexed. "
    f"At most {MAX_READ_CHARS} characters per call; the answer says when it stopped and which pages to read next. "
    "Use it to READ the page a value is on before you record it: a quote you record must stand in text a tool "
    "showed you in this run. To FIND which document or page holds a value, use knowledge_search first and then read "
    "that page here. Only the project's own documents can be read; the Richtlinien corpus is not a source of "
    "project values. An older Fassung says which document replaced it."
)


def make_read_document_tool() -> StructuredTool:
    async def read_document(file_name: str, pages: list[int] | None = None) -> str:
        try:
            documents = await project_documents()
            document = resolve_document(file_name, documents)
            if document is None:
                return _unknown_document(file_name, documents)
            chunks = await asyncio.to_thread(fetch_document_pages, document.collection, document.file_name)
            wanted = sorted({page for page in (pages or []) if isinstance(page, int) and page >= 1})
            log = current_read_log()
            text = render_pages(document, group_pages(chunks or []), wanted[:MAX_PAGES_PER_CALL], log)
            if log is not None and log.has_text(document.file_name):
                log.mark_opened(document.file_name)
            return text
        except Exception as exc:  # noqa: BLE001 — a tool answers in text, never raises
            logger.warning("read_document failed for %r", file_name, exc_info=True)
            return f"read_document could not read „{file_name}“ ({type(exc).__name__}). Try knowledge_search instead."

    return StructuredTool.from_function(
        coroutine=read_document,
        name=READ_DOCUMENT_TOOL,
        description=READ_DOCUMENT_DESCRIPTION,
        args_schema=ReadDocumentInput,
    )


# ── Logging what the shared tools returned ───────────────────────────────────


def _strip_qualifier(name: str) -> str:
    """``Plan.pdf (Projektwissen)`` → ``Plan.pdf``: the shelf qualifier a citation key carries when ambiguous."""
    for qualifier in SHELF_QUALIFIERS.values():
        suffix = f" ({qualifier})"
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return name


def citation_parts(citation: str) -> tuple[str, int | None]:
    """``(file name, page)`` of a citation as a reading tool printed it.

    ``Plan.pdf, p.3`` (a grounding key) or ``Plan.pdf (Projektwissen), S. 3``.
    A citation without a page is the file name alone. ``record_values`` takes
    the citation as the model copied it, so the model does not re-assemble it.
    """
    match = _KEY_PAGE.match((citation or "").strip())
    if match is None:
        return _strip_qualifier((citation or "").strip()), None
    return _strip_qualifier(match.group("name").strip()), int(match.group("page"))


def passages_in(tool_name: str, text: str) -> list[tuple[str, int | None, str, str | None]]:
    """``(file name, page, passage text, shelf)`` of every passage a grounding-block result showed the model.

    The records the knowledge layer filed for this exact text when it rendered
    it, when they are there (ADR-0061), else the text parsed back
    (``extract_sources_from_tool_result``), which recovers the file and page from
    the citation key.
    """
    from aiq_agent.common.citation_verification import extract_sources_from_tool_result
    from aiq_agent.common.grounding_block import get_grounding_block

    block = get_grounding_block(text)
    if block is not None:
        return [
            (hit.file_name, hit.page, hit.body, str(hit.shelf) if hit.shelf is not None else None) for hit in block.hits
        ]
    passages = []
    for entry in extract_sources_from_tool_result(tool_name, text):
        if not entry.citation_key or not entry.chunk_text:
            continue
        file_name, page = citation_parts(entry.citation_key)
        passages.append((file_name, page, entry.chunk_text, entry.shelf))
    return passages


def log_tool_result(tool_name: str, content: Any) -> int:
    """Log the passages a search or locator result showed; how many. Never raises."""
    log = current_read_log()
    if log is None:
        return 0
    try:
        passages = passages_in(tool_name, content_to_text(content))
    except Exception:  # noqa: BLE001 — an unlogged result costs a quote check, never the run
        logger.debug("Intake: could not log the result of %s", tool_name, exc_info=True)
        return 0
    opened = PASSAGE_TOOL in tool_name
    for file_name, page, body, shelf in passages:
        log.log(file_name, page, body)
        if opened and shelf != Shelf.BASE.value:
            log.mark_opened(file_name)
    return len(passages)


def _budget_text(max_steps: int) -> str:
    return (
        f"Step budget spent ({max_steps} tool calls): this call did not run. "
        "Call finish_intake now, with a summary of what you found and what stays open."
    )


class IntakeToolMiddleware(AgentMiddleware):
    """Around every tool call of the run: the step budget, a failure as text, and the read log.

    A tool that raises ends a LangGraph run; here it becomes a message the model
    can act on, as every tool in this repo answers. After ``max_steps`` calls
    only ``finish_intake`` still runs. Once ``finished`` says the intake was
    finished, the run ends before the next model call: ``finish_intake`` is not
    ``return_direct``, because a first call it holds must reach the model.
    """

    def __init__(self, *, max_steps: int, finish_tool: str, finished: Callable[[], bool] = lambda: False) -> None:
        super().__init__()
        self.max_steps = max_steps
        self.finish_tool = finish_tool
        self.finished = finished
        self.steps = 0

    @property
    def budget_spent(self) -> bool:
        return self.steps >= self.max_steps

    @hook_config(can_jump_to=["end"])
    async def abefore_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        return {"jump_to": "end"} if self.finished() else None

    async def awrap_tool_call(
        self, request: Any, handler: Callable[[Any], Awaitable[ToolMessage | Any]]
    ) -> ToolMessage | Any:
        call = request.tool_call
        name = str(call.get("name") or "")
        if name != self.finish_tool:
            if self.budget_spent:
                return ToolMessage(content=_budget_text(self.max_steps), tool_call_id=call["id"], name=name)
            self.steps += 1
        try:
            result = await handler(request)
        except Exception as exc:  # noqa: BLE001 — a failed tool is a message, not the end of the run
            logger.warning("Intake tool %s failed", name, exc_info=True)
            return ToolMessage(
                content=f"{name} failed ({type(exc).__name__}). Try another way, or finish.",
                tool_call_id=call["id"],
                name=name,
                status="error",
            )
        if (SEARCH_TOOL in name or PASSAGE_TOOL in name) and isinstance(result, ToolMessage):
            # Logged from the bytes the knowledge layer filed its records under, THEN
            # the fan-out JSON goes: it is ~1 000 tokens a search that the model
            # re-reads on every later call and has no use for (Piloti strips it too).
            log_tool_result(name, result.content)
            if isinstance(result.content, str):
                stripped = strip_trace_lanes(result.content)
                if stripped != result.content:
                    result = result.model_copy(update={"content": stripped})
        return result
