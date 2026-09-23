"""The documents a reader names for a run: the Unterlagen on the Rechercheplan.

Three intentions travel here, and they are kept apart because a run does
different things with each:

- **Grundlage** — documents the run must read in full, whatever else it finds.
  The planner gives each its own research query, the writer cites them, and a
  Grundlage document the run never reached is named as unread on the report:
  it marks the report rather than blocking it, because a report that names
  what it missed is still worth more than no report.
- **Nur Grundlage** — a switch, not a list: of the reader's own documents
  (project, Archiv, this chat) the run may use the Grundlage and nothing
  else. By default the run may read every document it can find and the
  Grundlage is only its focus; this narrows it. Norms and laws on the base
  shelf stay available either way, because they are the measure a report
  holds the reader's documents against.
- **Ausgeschlossen** — documents the run may not use. An excluded document
  never enters the run's source registry, so it can neither be cited nor
  quoted; a citation to it is stripped like one to a source that does not
  exist.
- The **Rahmen** — which sources the run may draw on at all — is not a list of
  documents but the composer's own Datengrundlage, and travels as
  ``data_sources`` beside this.

Identity is the knowledge layer's own: ``(file_name, shelf)`` as
``AvailableDocument`` states it (ADR-0047). A name that is not in the turn's
inventory is dropped at the plan card, so a run is never told to read a file
that nobody can find.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel
from pydantic import ConfigDict
from pydantic import Field

#: Enough for a Grundlage of a real submission (ten documents is a large one)
#: and small enough that the plan card stays readable.
MAX_PLAN_DOCUMENTS = 20
MAX_DOCUMENT_NAME_CHARS = 256
MAX_DOCUMENT_TITLE_CHARS = 256
MAX_SHELF_CHARS = 64


class PlanDocument(BaseModel):
    """One document the reader named, as the run and the run block name it."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=MAX_DOCUMENT_NAME_CHARS)
    title: str | None = Field(default=None, max_length=MAX_DOCUMENT_TITLE_CHARS)
    shelf: str | None = Field(default=None, max_length=MAX_SHELF_CHARS)

    @property
    def label(self) -> str:
        return self.title or self.name


class PlanDocuments(BaseModel):
    """What the reader named on the plan: the wire shape between every tier."""

    model_config = ConfigDict(extra="forbid")

    grundlage: list[PlanDocument] = Field(default_factory=list, max_length=MAX_PLAN_DOCUMENTS)
    ausgeschlossen: list[PlanDocument] = Field(default_factory=list, max_length=MAX_PLAN_DOCUMENTS)
    #: Of the reader's own documents, only the Grundlage may be used.
    nur_grundlage: bool = False

    def is_empty(self) -> bool:
        return not self.grundlage and not self.ausgeschlossen

    def excluded_names(self) -> set[str]:
        return {_fold(doc.name) for doc in self.ausgeschlossen}


def _fold(name: str) -> str:
    return name.strip().casefold()


def _clip(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()[:limit]
    return text or None


def sanitize_plan_documents(raw: Any) -> PlanDocuments | None:
    """Reduce an untrusted payload to the contract; ``None`` when nothing survives.

    Fail-soft per row, like the findings sanitiser: a row without a name is
    dropped, the rest stay, a name in both lists is excluded (the stricter
    intention wins), and the caps apply after deduplication.
    """
    if not isinstance(raw, dict):
        return None
    out = PlanDocuments()
    seen: set[str] = set()
    for key in ("ausgeschlossen", "grundlage"):
        rows = raw.get(key)
        if not isinstance(rows, list):
            continue
        target = out.ausgeschlossen if key == "ausgeschlossen" else out.grundlage
        for row in rows:
            doc = _document_from(row)
            if doc is None or _fold(doc.name) in seen or len(target) >= MAX_PLAN_DOCUMENTS:
                continue
            seen.add(_fold(doc.name))
            target.append(doc)
    # A confinement to nothing would refuse every document the reader owns.
    out.nur_grundlage = bool(out.grundlage) and (raw.get("nur_grundlage") is True or raw.get("nurGrundlage") is True)
    return None if out.is_empty() else out


def _document_from(row: Any) -> PlanDocument | None:
    if isinstance(row, str):
        name = _clip(row, MAX_DOCUMENT_NAME_CHARS)
        return PlanDocument(name=name) if name else None
    if not isinstance(row, dict):
        return None
    name = _clip(row.get("name") or row.get("file_name"), MAX_DOCUMENT_NAME_CHARS)
    if not name:
        return None
    return PlanDocument(
        name=name,
        title=_clip(row.get("title") or row.get("display_title"), MAX_DOCUMENT_TITLE_CHARS),
        shelf=_clip(row.get("shelf"), MAX_SHELF_CHARS),
    )


def resolve_documents(names: list[Any], inventory: list[dict[str, Any]] | None) -> list[PlanDocument]:
    """The named documents, as the turn's inventory knows them.

    A name matches a row's ``file_name`` or its ``display_title``, case-folded.
    Without an inventory nothing resolves: a run is only ever told to read a
    document somebody could find, and the plan card, not the model, is the
    place where a typo is corrected.
    """
    rows = inventory or []
    by_key: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        for key in (row.get("file_name"), row.get("display_title")):
            if isinstance(key, str) and key.strip():
                by_key.setdefault(_fold(key), row)
    out: list[PlanDocument] = []
    seen: set[str] = set()
    for name in names:
        if not isinstance(name, str) or not name.strip():
            continue
        row = by_key.get(_fold(name))
        if row is None:
            continue
        file_name = str(row.get("file_name") or "").strip()
        if not file_name or _fold(file_name) in seen or len(out) >= MAX_PLAN_DOCUMENTS:
            continue
        seen.add(_fold(file_name))
        out.append(
            PlanDocument(
                name=file_name[:MAX_DOCUMENT_NAME_CHARS],
                title=_clip(row.get("display_title"), MAX_DOCUMENT_TITLE_CHARS),
                shelf=_clip(row.get("shelf"), MAX_SHELF_CHARS),
            )
        )
    return out


def documents_from_plan(
    grundlage: list[str], ausgeschlossen: list[str], inventory: list[dict[str, Any]] | None
) -> PlanDocuments | None:
    """Both lists resolved against the inventory; an excluded name beats a Grundlage one."""
    excluded = resolve_documents(ausgeschlossen, inventory)
    excluded_keys = {_fold(doc.name) for doc in excluded}
    read = [doc for doc in resolve_documents(grundlage, inventory) if _fold(doc.name) not in excluded_keys]
    docs = PlanDocuments(grundlage=read, ausgeschlossen=excluded)
    return None if docs.is_empty() else docs


def unread_grundlage(documents: PlanDocuments | None, read_names: set[str]) -> list[PlanDocument]:
    """The Grundlage the run did not reach, given the file names it did read."""
    if documents is None:
        return []
    read = {_fold(name) for name in read_names}
    return [doc for doc in documents.grundlage if _fold(doc.name) not in read]
