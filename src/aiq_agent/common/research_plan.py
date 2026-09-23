"""The research plan as the BFF stores it, mirrored for the two Python readers.

A deep research is about a plan: sections, genre, depth, the Unterlagen and
the Rahmen. The plan is a workspace primitive of the BFF (ADR-0065): the
clarifier proposes it through the internal tasks route, the reader edits it on
the run block, and the worker reads it at the instant the run may start. The
shape is defined ONCE, in ``frontends/ui/src/lib/plans/plan-types.ts``, and
exported as JSON Schema to ``tests/fixtures/research-plan.schema.json``;
``tests/aiq_agent/common/test_research_plan.py`` validates these models
against that file, so this module cannot drift from the zod source.

Two models cross the wire from here:

- :class:`ResearchPlanDraft` — what the clarifier proposes (``op: "plan"``),
  built from its :class:`PlanResponse` and the turn's inventory. Documents are
  named by file name; the BFF resolves them against the inventory, once.
- :class:`ResearchPlan` — what the worker is handed when the run may start,
  with the documents resolved. :meth:`ResearchPlan.context` renders it into
  the same prompt text the chat path always rendered, so nothing downstream
  of the agent state changes.
"""

from __future__ import annotations

from typing import Any
from typing import Literal

from pydantic import BaseModel
from pydantic import ConfigDict
from pydantic import Field

from aiq_agent.common.plan_documents import MAX_PLAN_DOCUMENTS
from aiq_agent.common.plan_documents import PlanDocument
from aiq_agent.common.plan_documents import PlanDocuments

PLAN_GENRES: tuple[str, ...] = ("pruefbericht", "aktenvermerk", "vergleich", "checkliste", "bericht")
PLAN_DEPTHS: tuple[str, ...] = ("kurzpruefung", "gutachten")
PLAN_STATUSES: tuple[str, ...] = ("proposed", "held", "approved", "started", "superseded")
PLAN_AUTHORS: tuple[str, ...] = ("agent", "user")

PlanGenre = Literal["pruefbericht", "aktenvermerk", "vergleich", "checkliste", "bericht"]
PlanDepth = Literal["kurzpruefung", "gutachten"]
PlanStatus = Literal["proposed", "held", "approved", "started", "superseded"]
PlanAuthor = Literal["agent", "user"]
PlanStartPolicy = Literal["auto", "ask"]

MAX_PLAN_SECTIONS = 12
MAX_PLAN_SECTION_CHARS = 200
MAX_PLAN_TITLE_CHARS = 200
MAX_PLAN_QUESTION_CHARS = 500
MAX_PLAN_INVENTORY_ROWS = 200
MAX_PLAN_DATA_SOURCES = 32
MAX_PLAN_GRACE_SECONDS = 600
_MAX_ID_CHARS = 64


class PlanStart(BaseModel):
    """How a proposed plan starts: on its own after a grace, or only when a person says so."""

    model_config = ConfigDict(extra="forbid")

    policy: PlanStartPolicy = "auto"
    graceSeconds: int | None = Field(default=None, ge=0, le=MAX_PLAN_GRACE_SECONDS)


def _document_lines(docs: list[PlanDocument]) -> str:
    lines = []
    for doc in docs:
        where = f" [{doc.shelf}]" if doc.shelf else ""
        title = f"{doc.title} — " if doc.title and doc.title != doc.name else ""
        lines.append(f"- {title}{doc.name}{where}")
    return "\n".join(lines)


def render_plan_context(
    *, title: str, genre: str, depth: str, sections: list[str], documents: PlanDocuments | None = None
) -> str:
    """The plan as deep research reads it, one renderer for every path.

    The orchestrator, the planner and the writer all receive it
    (``factory.py`` ``prompt_values``): the sections become the required
    components in this order, the genre the answer type, the depth the length,
    and the Unterlagen what must be read and what may not be used. The chat
    path renders it at hand-off; the worker renders it from the plan it was
    handed at start (ADR-0065).
    """
    sections_text = "\n".join(f"- {s}" for s in sections)
    text = (
        f"**Approved Research Plan**\n\nTitle: {title}\nGenre: {genre}\nDepth: {depth}\n\n"
        f"Sections (required components, in this order):\n{sections_text}"
    )
    if documents and documents.grundlage:
        text += (
            "\n\nGrundlage (documents to read in full, each through its own research query; "
            f"a report that could not reach one names it as unread):\n{_document_lines(documents.grundlage)}"
        )
    if documents and documents.ausgeschlossen:
        text += (
            "\n\nAusgeschlossen (documents that may not be used: never searched, never cited):\n"
            f"{_document_lines(documents.ausgeschlossen)}"
        )
    return text


class ResearchPlanDraft(BaseModel):
    """A plan as it is proposed. Documents by name; the BFF resolves them."""

    model_config = ConfigDict(extra="forbid")

    question: str = Field(min_length=1, max_length=MAX_PLAN_QUESTION_CHARS)
    title: str | None = Field(default=None, min_length=1, max_length=MAX_PLAN_TITLE_CHARS)
    sections: list[str] = Field(min_length=1, max_length=MAX_PLAN_SECTIONS)
    genre: PlanGenre = "bericht"
    depth: PlanDepth = "gutachten"
    grundlage: list[str] = Field(default_factory=list, max_length=MAX_PLAN_DOCUMENTS)
    ausgeschlossen: list[str] = Field(default_factory=list, max_length=MAX_PLAN_DOCUMENTS)
    dataSources: list[str] | None = Field(default=None, max_length=MAX_PLAN_DATA_SOURCES)
    unterlagen: list[PlanDocument] = Field(default_factory=list, max_length=MAX_PLAN_INVENTORY_ROWS)

    def to_wire(self) -> dict[str, Any]:
        """The JSON the draft schema accepts: an optional key absent rather than null."""
        return self.model_dump(exclude_none=True)


class ResearchPlan(BaseModel):
    """The plan as every client reads it, documents resolved."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=_MAX_ID_CHARS)
    projectId: str = Field(min_length=1, max_length=_MAX_ID_CHARS)
    conversationId: str | None = Field(default=None, max_length=_MAX_ID_CHARS)
    runId: str | None = Field(default=None, max_length=_MAX_ID_CHARS)
    author: PlanAuthor
    status: PlanStatus
    question: str = Field(min_length=1, max_length=MAX_PLAN_QUESTION_CHARS)
    title: str = Field(min_length=1, max_length=MAX_PLAN_TITLE_CHARS)
    sections: list[str] = Field(min_length=1, max_length=MAX_PLAN_SECTIONS)
    genre: PlanGenre
    depth: PlanDepth
    grundlage: list[PlanDocument] = Field(default_factory=list, max_length=MAX_PLAN_DOCUMENTS)
    ausgeschlossen: list[PlanDocument] = Field(default_factory=list, max_length=MAX_PLAN_DOCUMENTS)
    dataSources: list[str] | None = Field(default=None, max_length=MAX_PLAN_DATA_SOURCES)
    unterlagen: list[PlanDocument] = Field(default_factory=list, max_length=MAX_PLAN_INVENTORY_ROWS)
    startsAt: str | None = None
    heldAt: str | None = None
    approvedAt: str | None = None
    startedAt: str | None = None
    createdAt: str
    updatedAt: str

    def documents(self) -> PlanDocuments | None:
        """The Unterlagen as the agent state carries them, or None when none were named."""
        docs = PlanDocuments(grundlage=list(self.grundlage), ausgeschlossen=list(self.ausgeschlossen))
        return None if docs.is_empty() else docs

    def context(self) -> str:
        """The plan as the deep researcher's prompts read it."""
        return render_plan_context(
            title=self.title,
            genre=self.genre,
            depth=self.depth,
            sections=list(self.sections),
            documents=self.documents(),
        )

    def to_wire(self) -> dict[str, Any]:
        """The JSON the plan schema accepts: every nullable key present, a document's optionals absent."""
        wire = self.model_dump()
        for key in ("grundlage", "ausgeschlossen", "unterlagen"):
            wire[key] = [{k: v for k, v in doc.items() if v is not None} for doc in wire[key]]
        return wire
