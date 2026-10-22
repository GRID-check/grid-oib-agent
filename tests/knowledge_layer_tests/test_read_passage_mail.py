"""`read_passage` says which mail a document came with, and reads a Verlauf's message as mail (ADR-0134).

An attachment a person filed from a mail is read like any file; the result opens with one line naming
the message that brought it, in the words of its Verlauf: the signing domain for a verified sender,
„Domain nicht bestätigt“ for every other one. A passage of the Verlauf itself carries its format on a
``Format:`` line and is placed in the mail lane, Projektwissen in colour, never building law.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.schema import AvailableDocument
from aiq_agent.knowledge.schema import Chunk
from aiq_agent.knowledge.schema import ContentType
from aiq_agent.knowledge.scoping import ScopedCollection
from sources.knowledge_layer.src.read_passage import ReadPassageConfig
from sources.knowledge_layer.src.read_passage import read_passage
from sources.knowledge_layer.src.register import KnowledgeRetrievalConfig

PROJECT = "proj_1"
FORGED = {
    "sent_at": "2026-05-14T14:40:00Z",
    "from_name": "Mag. Anna Huber",
    "from_domain": "ma37-wien.at",
    "sender_trust": "external_unverified",
}
SIGNED = {
    "sent_at": "2026-05-04T06:30:00Z",
    "from_name": "Ing. Paul Gruber",
    "from_domain": "verkehrsplanung-gruber.at",
    "signer_domain": "verkehrsplanung-gruber.at",
    "sender_trust": "external_verified",
}
DOCS = [
    AvailableDocument(file_name="Berechnung.pdf", collection=PROJECT, shelf="project", mail_origin=SIGNED),
    AvailableDocument(file_name="Bescheid_Kopie.pdf", collection=PROJECT, shelf="project", mail_origin=FORGED),
    AvailableDocument(file_name="Plan.pdf", collection=PROJECT, shelf="project"),
    AvailableDocument(
        file_name="Verlauf.md",
        collection=PROJECT,
        shelf="project",
        mail_thread={"latest_sent_at": "2026-05-14T14:40:00Z", "message_count": 2},
    ),
]
HEADING = "12.05.2026 09:12 · Mag. Anna Huber (ma37.wien.gv.at)"


def _chunk(name: str) -> Chunk:
    metadata = {"page_label": "1", "collection": PROJECT, "clause_id": "1"}
    content = "Vier Pflichtstellplätze."
    page = 1
    if name == "Verlauf.md":
        metadata = {"collection": PROJECT, "clause_id": HEADING, "source_format": "mail"}
        content = f"Stellplätze › {HEADING}\n\nBitte reichen Sie den Nachweis bis 29.05.2026 nach."
        page = None
    return Chunk(
        chunk_id=f"{name}-1",
        content=content,
        score=0.7,
        file_name=name,
        page_number=page,
        display_citation=name,
        content_type=ContentType.TEXT,
        metadata=metadata,
    )


class _Store:
    async def retrieve(self, query, collection_name, top_k, filters):
        name = str(filters.get("file_name") if isinstance(filters, dict) else "") or ""
        wanted = next((doc.file_name for doc in DOCS if doc.file_name in repr(filters)), name)
        return SimpleNamespace(chunks=[_chunk(wanted)], success=True, error_message=None)


@pytest.fixture
def store(monkeypatch):
    monkeypatch.setattr("aiq_agent.knowledge.factory.get_active_retriever", lambda: _Store())

    async def _documents(collection: str):
        return list(DOCS) if collection == PROJECT else []

    monkeypatch.setattr("aiq_agent.knowledge.factory.get_available_documents_async", _documents)
    monkeypatch.setattr(
        "aiq_agent.knowledge.scoping.get_scoped_collections_from_context",
        lambda: [ScopedCollection(PROJECT, Shelf.PROJECT)],
    )
    for name in ("get_document_doc_classes", "get_document_display_titles", "get_document_folder_paths"):
        monkeypatch.setattr(f"aiq_agent.knowledge.factory.{name}", lambda _c, _f: {})


async def _read(**kwargs) -> str:
    builder = MagicMock()
    builder.get_function_config = MagicMock(
        return_value=KnowledgeRetrievalConfig(collection_name=PROJECT, include_base_collection=False)
    )
    async with read_passage(ReadPassageConfig(), builder) as info:
        return await info.single_fn(info.input_schema(**kwargs))


class TestAnAttachmentSaysWhichMailBroughtIt:
    async def test_a_signed_sender_is_named_by_the_signing_domain(self, store):
        out = await _read(document="Berechnung.pdf", clause="1")

        first = out.splitlines()[0]
        assert first == (
            "Berechnung.pdf kam mit der E-Mail vom 04.05.2026 08:30 von Ing. Paul Gruber (verkehrsplanung-gruber.at)."
        )
        assert out.index(first) < out.index("Citation:")

    async def test_an_unconfirmed_sender_is_never_the_domains_owner(self, store):
        out = await _read(document="Bescheid_Kopie.pdf", clause="1")

        assert "von Mag. Anna Huber (ma37-wien.at, Domain nicht bestätigt)." in out.splitlines()[0]

    async def test_a_file_that_came_with_no_mail_reads_as_before(self, store):
        out = await _read(document="Plan.pdf", clause="1")

        assert "kam mit der E-Mail" not in out


class TestAVerlaufPassageIsMail:
    async def test_it_states_its_format_and_lands_in_the_mail_lane(self, store):
        from aiq_agent.common.citation_verification import extract_sources_from_tool_result
        from aiq_agent.common.citation_verification import source_entry_to_wire
        from aiq_agent.common.grounding_block import begin_grounding_capture
        from aiq_agent.common.grounding_block import end_grounding_capture

        token = begin_grounding_capture()
        try:
            out = await _read(document="Verlauf.md", clause=HEADING)
            entries = extract_sources_from_tool_result("read_passage", out)
        finally:
            end_grounding_capture(token)

        assert "Format: mail — E-Mail" in out
        assert f"Punkt: {HEADING}" in out
        assert "kam mit der E-Mail" not in out, "a Verlauf IS the mails; it came with none"
        (entry,) = entries
        wire = source_entry_to_wire(entry)
        assert (wire["lane"], wire["lane_label"], wire["kind"]) == ("project_mail", "E-Mail", "project")
